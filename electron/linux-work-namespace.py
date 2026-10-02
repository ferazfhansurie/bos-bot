#!/usr/bin/python3
"""Disposable Linux work shell. No Windows filesystem or inherited binfmt handlers.

The connector invokes this trusted file, never a user-selected executable. All
mounts are private to new user/mount/PID namespaces. The command has no mount,
chroot or namespace capabilities, and sees only a fresh /proc and Linux paths.
This is NOT a network sandbox; the authorized Linux terminal retains networking.
"""
import ctypes
import os
from pathlib import Path
import subprocess
import sys
import tempfile

HOME = '/home/firaz'
PROTECTED = ('.local/share/bos-work-computer', '.local/share/bos-server', '.bos-bot')
SAFE_ENV = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': HOME, 'USER': 'firaz', 'LOGNAME': 'firaz', 'LANG': 'C.UTF-8'}


def run(*args):
    subprocess.run(args, check=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL)


def inside(root, command):
    # Fail before mounting if a protected root is a symlink or the home moved.
    if os.path.realpath(HOME) != HOME or not os.path.isdir(HOME):
        raise RuntimeError('The granted Linux home is unavailable')
    for relative in PROTECTED:
        current = Path(HOME)
        for part in Path(relative).parts:
            current /= part
            if current.is_symlink():
                raise RuntimeError('Protected connector paths must not be symlinks')
    run('/usr/bin/mount', '--make-rprivate', '/')
    run('/usr/bin/mount', '-t', 'tmpfs', '-o', 'nosuid,nodev', 'none', root)
    base = Path(root)
    def linux_tree(source, target):
        target.mkdir()
        # WSL's locked submounts require rbind. Mask every inherited child
        # mount, including Windows driver/library mounts, rather than exposing
        # them or making an inherited filesystem writable.
        run('/usr/bin/mount', '--rbind', source, str(target))
        nested = []
        for line in Path('/proc/self/mountinfo').read_text().splitlines():
            mountpoint = line.split()[4].replace(r'\040', ' ')
            if mountpoint.startswith(str(target) + '/'):
                nested.append(mountpoint)
        for mountpoint in sorted(set(nested), key=len, reverse=True):
            run('/usr/bin/mount', '-t', 'tmpfs', '-o', 'ro,nosuid,nodev,noexec', 'none', mountpoint)
        run('/usr/bin/mount', '-o', 'remount,bind,ro,nosuid,nodev', str(target))

    for directory in ('usr', 'etc'):
        linux_tree('/' + directory, base / directory)
    # Ubuntu merged-/usr links; support non-merged Linux without mounting /.
    for directory in ('bin', 'sbin', 'lib', 'lib64'):
        source = Path('/') / directory
        if not source.exists():
            continue
        if source.is_symlink():
            (base / directory).symlink_to(os.readlink(source))
        else:
            linux_tree(str(source), base / directory)
    (base / 'home').mkdir()
    (base / HOME.lstrip('/')).mkdir()
    if any(line.split()[4].startswith(HOME + '/') for line in Path('/proc/self/mountinfo').read_text().splitlines()):
        raise RuntimeError('Nested home mounts require a new owner grant; no host fallback')
    run('/usr/bin/mount', '--bind', HOME, str(base / HOME.lstrip('/')))
    # Mask credentials before command admission. Never create directories in
    # the granted home just to support a mask; missing paths have no secrets.
    for relative in PROTECTED:
        destination = base / HOME.lstrip('/') / relative
        if destination.exists():
            if not destination.is_dir():
                raise RuntimeError('Protected path must be a directory')
            run('/usr/bin/mount', '-t', 'tmpfs', '-o', 'ro,nosuid,nodev,noexec', 'none', str(destination))
    for directory in ('tmp', 'proc', 'dev', 'mnt', 'run'):
        (base / directory).mkdir()
    (base / 'tmp').chmod(0o1777)
    run('/usr/bin/mount', '-t', 'proc', '-o', 'ro,nosuid,nodev,noexec', 'proc', str(base / 'proc'))
    # Linux 6.7+ has per-user-namespace binfmt_misc. Without a private mount,
    # handlers fall back to ancestors, and WSL's F flag retains /init even
    # across chroot. An empty PRIVATE instance is mandatory, never optional.
    host_binfmt = os.stat('/proc/sys/fs/binfmt_misc').st_dev
    binfmt = base / 'proc/sys/fs/binfmt_misc'
    run('/usr/bin/mount', '-t', 'binfmt_misc', '-o', 'nosuid,nodev,noexec', 'binfmt_misc', str(binfmt))
    if os.stat(binfmt).st_dev == host_binfmt or set(os.listdir(binfmt)) != {'register', 'status'}:
        raise RuntimeError('Cannot isolate binary handlers; no host fallback')
    (binfmt / 'status').write_text('0')
    run('/usr/bin/mount', '-o', 'remount,ro,nosuid,nodev,noexec', str(binfmt))
    for device in ('null', 'zero', 'random', 'urandom'):
        target = base / 'dev' / device
        target.touch()
        run('/usr/bin/mount', '--bind', '/dev/' + device, str(target))
    (base / 'dev/fd').symlink_to('/proc/self/fd')
    for name, number in (('stdin', 0), ('stdout', 1), ('stderr', 2)):
        (base / 'dev' / name).symlink_to('/proc/self/fd/' + str(number))
    # No /init, /sys, inherited host /proc, Windows mounts or open directory
    # descriptors. Drop every capability and block setuid privilege gains.
    os.chroot(root)
    os.chdir(HOME)
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(38, 1, 0, 0, 0) != 0:  # PR_SET_NO_NEW_PRIVS
        raise OSError(ctypes.get_errno(), 'no_new_privs failed')
    os.execve('/usr/bin/setpriv', ['setpriv', '--bounding-set=-all', '--inh-caps=-all', '--ambient-caps=-all', '/bin/bash', '--noprofile', '--norc', '-c', command], SAFE_ENV)


def main():
    if len(sys.argv) == 4 and sys.argv[1] == '--inside':
        inside(sys.argv[2], sys.argv[3])
        return
    if len(sys.argv) != 2 or not sys.argv[1].strip() or len(sys.argv[1]) > 8000:
        raise RuntimeError('Expected one command of at most 8000 characters')
    if sys.platform != 'linux':
        raise RuntimeError('The Linux work namespace is unavailable; no host fallback')
    with tempfile.TemporaryDirectory(prefix='bos-work-') as root:
        result = subprocess.run(['/usr/bin/unshare', '--user', '--map-root-user', '--mount', '--pid', '--fork', '--kill-child', '--propagation', 'private', '/usr/bin/python3', os.path.realpath(__file__), '--inside', root, sys.argv[1]], env=SAFE_ENV, close_fds=True)
        sys.exit(result.returncode)


if __name__ == '__main__':
    main()
