// The detached half of the updater: a stdlib-only Python program that
// launchd runs OUTSIDE the app. It must not depend on the binary it swaps,
// so it is not Node. The server writes this text next to plan.json in the
// update directory, records its sha256 in the plan, and the script refuses
// to run if its own bytes no longer match. Everything it needs is in
// plan.json; it never reads app data and never replays a turn.
//
// Result states written to result.json: done | rolled_back | failed.
// A result is written exactly once; a second run exits without touching
// anything (an uncertain prior installation is never repeated).
export const UPDATER_APPLY_SCRIPT = String.raw`
import fcntl, hashlib, json, os, signal, subprocess, sys, time, urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
PLAN = json.loads((HERE / "plan.json").read_text())
LIVE = Path(PLAN["live"])
STAGED = Path(PLAN["staged"]) if PLAN.get("staged") else None
BACKUP = Path(PLAN["backup"]) if PLAN.get("backup") else None
RESULT = Path(PLAN["resultPath"])
PORTS = [int(p) for p in PLAN["ports"]]
LOG = (HERE / "apply.log").open("a")

def log(msg):
    LOG.write(time.strftime("%H:%M:%S ") + msg + "\n"); LOG.flush()

def command(*args, timeout=20):
    return subprocess.run(args, capture_output=True, text=True, timeout=timeout)

def run(*args, timeout=20):
    r = command(*args, timeout=timeout)
    if r.returncode:
        raise RuntimeError(f"{args[0]} failed ({r.returncode}): {r.stderr.strip()[:300]}")
    return r.stdout.strip()

def require(ok, msg):
    if not ok:
        raise RuntimeError(msg)

def tree_digest(app, name):
    h = hashlib.sha256(); root = Path(app) / "Contents/Resources" / name
    require(root.is_dir(), f"{name} tree missing in {app}")
    for f in sorted(root.rglob("*")):
        if f.is_file():
            h.update(str(f.relative_to(root)).encode()); h.update(f.read_bytes())
    return h.hexdigest()

def digests(app):
    return {"server": tree_digest(app, "server"), "ui": tree_digest(app, "ui")}

def record(state, **kw):
    body = {"state": state, "updateId": PLAN["updateId"], "mode": PLAN["mode"], "at": time.strftime("%Y-%m-%dT%H:%M:%S%z"), **kw}
    tmp = RESULT.with_name(RESULT.name + ".tmp")
    with tmp.open("w") as f:
        json.dump(body, f, indent=2); f.flush(); os.fsync(f.fileno())
    os.replace(tmp, RESULT)
    log(f"result {state}: {kw.get('detail', '')}")

def progress(state, detail=""):
    # Intermediate states are for the relaunched app's status view; the
    # final state is only ever written through record().
    tmp = HERE / "progress.json.tmp"
    with tmp.open("w") as f:
        json.dump({"state": state, "detail": detail, "at": time.time()}, f); f.flush(); os.fsync(f.fileno())
    os.replace(tmp, HERE / "progress.json")
    log(f"progress {state} {detail}")

def snapshot():
    rows = {}
    for line in run("/bin/ps", "-ww", "-axo", "pid=,ppid=,lstart=,args=").splitlines():
        fields = line.split(None, 7)
        if len(fields) < 8:
            continue
        pid, parent = int(fields[0]), int(fields[1])
        args = fields[7]
        rows[pid] = {"parent": parent, "start": " ".join(fields[2:7]), "args": args}
    return rows

def belongs(args, app):
    prefix = str(app) + "/"
    return args == str(app) or args.startswith(prefix) or (" " + prefix) in args or (" " + str(app) + " ") in args

def app_pids(app, rows=None):
    rows = snapshot() if rows is None else rows
    return sorted(pid for pid, row in rows.items() if belongs(row["args"], app) and pid != os.getpid())

def identity(pid):
    rows = snapshot()
    row = rows.get(pid)
    return None if row is None else row["start"] + " " + row["args"]

def listeners(port):
    r = command("/usr/sbin/lsof", "-nP", f"-tiTCP:{port}", "-sTCP:LISTEN")
    if r.returncode == 1 and not r.stdout.strip() and not r.stderr.strip():
        return []
    require(r.returncode == 0 and not r.stderr.strip(), f"cannot inspect port {port}")
    return [int(x) for x in r.stdout.split()]

def descendant(pid, roots, rows):
    seen = set()
    while pid > 1 and pid not in seen:
        if pid in roots:
            return True
        seen.add(pid)
        if pid not in rows:
            return False
        pid = rows[pid]["parent"]
    return False

def stop_app(app, graceful_seconds, force):
    pids = app_pids(app)
    if PLAN.get("appPid") and PLAN.get("appIdentity"):
        actual = identity(PLAN["appPid"])
        require(actual is None or actual == PLAN["appIdentity"], "app process identity changed; refusing to signal it")
    for pid in pids:
        try: os.kill(pid, signal.SIGTERM)
        except ProcessLookupError: pass
    deadline = time.time() + graceful_seconds
    while time.time() < deadline:
        if not app_pids(app):
            return
        time.sleep(0.5)
    remaining = app_pids(app)
    if remaining and force:
        log(f"force killing {remaining}")
        for pid in remaining:
            try: os.kill(pid, signal.SIGKILL)
            except ProcessLookupError: pass
        deadline = time.time() + 10
        while time.time() < deadline and app_pids(app):
            time.sleep(0.5)
    require(not app_pids(app), "app did not quit in time")

def drain(app, seconds=30):
    deadline = time.time() + seconds
    while time.time() < deadline:
        if not app_pids(app) and not any(listeners(p) for p in PORTS):
            return
        time.sleep(0.5)
    raise RuntimeError("app processes or ports " + ",".join(map(str, PORTS)) + " still occupied")

def launch(app):
    argv = [a.replace("{app}", str(app)) for a in PLAN["launch"]]
    log("launch " + " ".join(argv))
    subprocess.Popen(argv, start_new_session=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

def healthy(app, expect, seconds):
    deadline = time.time() + seconds
    last = ""
    while time.time() < deadline:
        try:
            rows = snapshot(); roots = set(app_pids(app, rows))
            require(roots, "no app process")
            with urllib.request.urlopen(PLAN["health"], timeout=2) as r:
                data = json.load(r)
            require(r.status == 200 and data.get("app") == "openmausbot", "health answered oddly")
            pid = data.get("pid")
            owners = listeners(PORTS[0])
            require(owners and all(descendant(p, roots, rows) for p in owners), "port %d not owned by the app" % PORTS[0])
            if pid is not None:
                require(isinstance(pid, int) and pid in owners, "health pid does not own the port")
            for port in PORTS[1:]:
                owners = listeners(port)
                require(owners and all(descendant(p, roots, rows) for p in owners), f"port {port} not owned by the app")
            if expect:
                require(digests(app) == expect, "installed tree hashes differ from the plan")
            return True
        except Exception as e:
            last = str(e)
        time.sleep(1)
    log(f"health failed: {last}")
    return False

def swap_in():
    require(STAGED and STAGED.exists(), "staged app missing")
    require(not BACKUP.exists(), f"backup destination exists: {BACKUP}")
    require(digests(STAGED) == PLAN["expect"], "staged tree changed since the plan was written")
    if PLAN.get("codesign"):
        run("/usr/bin/codesign", "--verify", "--deep", "--strict", str(STAGED), timeout=120)
    os.rename(LIVE, BACKUP)
    try:
        os.rename(STAGED, LIVE)
    except Exception:
        os.rename(BACKUP, LIVE); raise

def rollback(cause):
    progress("rolling_back", str(cause))
    try:
        stop_app(LIVE, 20, True)
        drain(LIVE, 20)
        failed = LIVE.with_name(LIVE.stem + f".failed-{PLAN['updateId'][:8]}.app-disabled")
        if LIVE.exists():
            os.rename(LIVE, failed)
        os.rename(BACKUP, LIVE)
        require(digests(LIVE) == PLAN["old"], "restored tree hashes differ from the original")
        launch(LIVE)
        require(healthy(LIVE, PLAN["old"], PLAN["healthSeconds"]), "restored app did not become healthy")
        record("rolled_back", detail=str(cause), rollback=str(failed), version=PLAN.get("oldVersion"), sha=PLAN.get("oldSha"))
    except Exception as e:
        record("failed", detail=f"{cause}; rollback failed: {e}", manualRecoveryRequired=True, live=str(LIVE), backup=str(BACKUP))

def main():
    require(hashlib.sha256(Path(__file__).read_bytes()).hexdigest() == PLAN["scriptSha256"], "updater script does not match the plan")
    if PLAN.get("requireLaunchd", True):
        require(os.getppid() == 1, "updater must run detached under launchd")
    with (HERE / "apply.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return 3
        if RESULT.exists():
            return 4
        try:
            progress("stopping")
            stop_app(LIVE, PLAN["gracefulSeconds"], PLAN["force"])
            drain(LIVE)
        except Exception as e:
            record("failed", detail=f"could not stop the app: {e}", appStillRunning=True)
            return 1
        if PLAN["mode"] == "update":
            try:
                progress("applying")
                swap_in()
            except Exception as e:
                record("failed", detail=f"swap refused: {e}", appStillRunning=False)
                launch(LIVE)
                return 1
            try:
                progress("relaunching"); launch(LIVE)
                progress("verifying")
                require(healthy(LIVE, PLAN["expect"], PLAN["healthSeconds"]), "updated app did not become healthy")
            except Exception as e:
                rollback(e)
                return 1
            installed = {"version": PLAN["version"], "sha": PLAN["sha"], "updateId": PLAN["updateId"], "at": time.time(), **PLAN["expect"]}
            tmp = Path(PLAN["installedPath"] + ".tmp")
            tmp.parent.mkdir(parents=True, exist_ok=True)
            tmp.write_text(json.dumps(installed, indent=2)); os.replace(tmp, PLAN["installedPath"])
            record("done", detail=f"updated to {PLAN['version']} ({PLAN['sha'][:8]})", version=PLAN["version"], sha=PLAN["sha"], rollback=str(BACKUP))
        else:
            try:
                progress("relaunching"); launch(LIVE)
                progress("verifying")
                require(healthy(LIVE, PLAN["old"], PLAN["healthSeconds"]), "relaunched app did not become healthy")
                record("done", detail="restarted", version=PLAN.get("oldVersion"), sha=PLAN.get("oldSha"))
            except Exception as e:
                record("failed", detail=str(e))
                return 1
    return 0

if __name__ == "__main__":
    code = 2
    try:
        code = main()
    except Exception as e:
        log("fatal " + repr(e))
        if not RESULT.exists():
            record("failed", detail=str(e))
        code = 1
    finally:
        if PLAN.get("selfBootout") and PLAN.get("label") and PLAN.get("uid") is not None:
            subprocess.Popen(["/bin/launchctl", "bootout", f"gui/{PLAN['uid']}/{PLAN['label']}"], start_new_session=True,
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    sys.exit(code)
`.trimStart();
