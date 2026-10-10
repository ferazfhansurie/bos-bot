#!/usr/bin/env python3
"""no-downgrade guard for installs onto the live BOS desktop app (stdlib only).

Every path that swaps a bundle into /Applications (the 1.3 in-app updater in
server/updater.ts, the hand-run install jobs) runs `check` before it stops
the app, and `record` once the swapped bundle is healthy. The rule it
enforces: the machine only ever runs the build that prod points at, and prod
only ever moves forward from what is running.

  no-downgrade.py stamp  --app APP --commit SHA
      Write Contents/Resources/build-commit.json: the source commit plus the
      sha256 of the server and ui trees it describes. A stamp whose digests no
      longer match the trees is treated as missing, so swapping trees into an
      old bundle does not inherit its stamp. scripts/after-pack.mjs stamps
      packaged builds from bosSourceCommit; a tree-swap installer stamps its
      candidate itself.

  no-downgrade.py check  --candidate APP --live APP [--rollback] [--ledger PATH]
                         [--repo PATH] [--release-branch NAME] [--prod-branch NAME]
      Allow (exit 0) only when, in order:
        1. the candidate is stamped and its commit exists in the repo;
        2. the running build's commit is known (its own stamp, or the ledger
           entry whose digests match the live bundle);
        3. the running commit is an ancestor of the candidate
           (git merge-base --is-ancestor): never older, never a sibling;
        4. the candidate is reachable from the release branch;
        5. the candidate is exactly the prod branch head (what dev/firaz
           accepted), or an ancestor of it that differs only in paths the
           desktop app never ships (the ios app). --prod-branch "" turns 5
           off; it is on by default.
      Refuse (exit 2) with a reason naming both commits otherwise.
      --rollback is the only escape hatch: it skips the git checks, but the
      candidate must be byte-identical (server + ui digests) to the ledger's
      previously-live entry, so only a backup of what was live can come back.

  no-downgrade.py preview --live APP [--commit SHA] [--ledger PATH] [--repo PATH]
                          [--release-branch NAME] [--prod-branch NAME]
      The "is there an update" answer, before anything is built: judge a
      commit (default: the prod branch head) by rules 2-5 above against the
      running build. ok=true means a build of that commit would pass `check`
      once stamped; up_to_date=true means it IS the running commit. Exit 2 on
      a refusal with the same reasons `check` gives. Read-only.

  no-downgrade.py record --live APP [--commit SHA] [--repo PATH] [--release-branch NAME]
                         [--prod-branch NAME] [--ledger PATH]
      Record the live bundle as the running build in the ledger (the previous
      entry moves to history). The first record on a machine seeds the ledger
      and needs --repo and --release-branch; an unstamped live bundle (every
      build before this guard shipped) needs --commit, a stamped one may omit
      it. Never touches the app.

Exit codes: 0 allowed/recorded, 2 refused, 1 bad invocation or io error. The
verdict is one json object on stdout; a one-line summary goes to stderr.
Never stops, launches, signs or swaps anything.
"""
import argparse, hashlib, json, os, re, stat, subprocess, sys, time
from pathlib import Path

STAMP = Path("Contents/Resources/build-commit.json")
DEFAULT_LEDGER = Path.home() / ".bos-bot" / "updates" / "live-build.json"
DEFAULT_PROD = "prod"
SHA = re.compile(r"^[0-9a-f]{40}$")


class Refuse(Exception):
    """A verdict, not an error: exit 2 with the reason."""


def tree_digest(app: Path, name: str) -> str:
    """Same bytes and order as server/updater.ts treeDigest: files sorted by
    their relative posix path as a string, each hashed as path then contents."""
    root = app / "Contents" / "Resources" / name
    if not root.is_dir():
        raise Refuse(f"{name} tree missing in {app}")
    files = [(f.relative_to(root).as_posix(), f) for f in root.rglob("*") if f.is_file()]
    h = hashlib.sha256()
    for rel, f in sorted(files, key=lambda item: item[0]):
        h.update(rel.encode())
        h.update(f.read_bytes())
    return h.hexdigest()


def digests(app: Path) -> dict:
    return {"server_sha256": tree_digest(app, "server"), "ui_sha256": tree_digest(app, "ui")}


def native_resource_digest(resources: Path) -> str:
    h = hashlib.sha256()
    swapped = {"server", "ui", "updater", "build-commit.json", "native-contract.json"}
    def walk(directory):
        for f in sorted(directory.iterdir()):
            if directory == resources and f.name in swapped:
                continue
            details = f.lstat()
            kind = "link" if f.is_symlink() else "dir" if f.is_dir() else "file"
            h.update(json.dumps([str(f.relative_to(resources)), stat.S_IMODE(details.st_mode), kind], ensure_ascii=False, separators=(",", ":")).encode())
            if kind == "link": h.update(os.readlink(f).encode())
            elif kind == "dir": walk(f)
            elif f.is_file(): h.update(f.read_bytes())
            else: raise Refuse("native resource type unsupported")
    walk(resources)
    return h.hexdigest()


def native_source_digest(repo: Path, commit: str) -> str:
    if not SHA.match(str(commit)): raise Refuse("native shell commit invalid")
    h = hashlib.sha256()
    for entry in git(repo, "ls-tree", "-r", "--full-tree", commit).stdout.splitlines():
        name = entry.split("\t", 1)[1]
        if name.startswith("electron/resources/updater/"): continue
        if re.match(r"^(electron/|companion/|skills/|scripts/|build/|third_party/|electron-builder[^/]*\.yml$|pnpm-lock\.yaml$)", name): h.update((entry + "\n").encode())
    pkg = json.loads(git(repo, "show", f"{commit}:package.json").stdout)
    pkg.pop("version", None); pkg.pop("bosSourceCommit", None)
    h.update(json.dumps(pkg, ensure_ascii=False, separators=(",", ":")).encode())
    return h.hexdigest()


def check_native_contract(app: Path, repo: Path, commit: str):
    resources = app / "Contents/Resources"
    path = resources / "native-contract.json"
    if not path.exists(): return  # pre-contract full packages retain legacy guard support
    try: saved = json.loads(path.read_text())
    except Exception as e: raise Refuse(f"native package identity unreadable: {e}")
    if saved.get("schema") != 1: raise Refuse("native package identity unsupported")
    if saved.get("resourcesSha256") != native_resource_digest(resources): raise Refuse("native resources changed after packaging; full desktop package required")
    if saved.get("sourceSha256") != native_source_digest(repo, saved.get("shellCommit", "")): raise Refuse("native shell source identity mismatch")
    if saved.get("sourceSha256") != native_source_digest(repo, commit): raise Refuse("target requires another native shell; full desktop package required")


def read_stamp(app: Path):
    """(commit, how): the stamped commit, or None when there is no stamp or it describes other trees."""
    path = app / STAMP
    if not path.is_file():
        return None, "unstamped"
    try:
        stamp = json.loads(path.read_text())
    except Exception as e:  # noqa: BLE001
        return None, f"stamp unreadable ({e})"
    commit = stamp.get("commit")
    if not isinstance(commit, str) or not SHA.match(commit):
        return None, "stamp has no full 40-hex commit"
    native_stamp = stamp.get("native_contract_sha256")
    if native_stamp:
        native_path = app / "Contents/Resources/native-contract.json"
        if not native_path.is_file() or hashlib.sha256(native_path.read_bytes()).hexdigest() != native_stamp:
            return None, "native package identity changed after stamping"
    actual = digests(app)
    if stamp.get("server_sha256") != actual["server_sha256"] or stamp.get("ui_sha256") != actual["ui_sha256"]:
        return None, f"stamped {commit[:8]} but its server/ui trees were changed after stamping"
    return commit, "stamped"


def git(repo: Path, *args, check=True):
    r = subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True, timeout=60)
    if check and r.returncode:
        raise Refuse(f"git {' '.join(args)} failed in {repo}: {r.stderr.strip()[:200]}")
    return r


def commit_exists(repo: Path, sha: str) -> bool:
    return git(repo, "cat-file", "-e", f"{sha}^{{commit}}", check=False).returncode == 0


def is_ancestor(repo: Path, older: str, newer: str) -> bool:
    r = git(repo, "merge-base", "--is-ancestor", older, newer, check=False)
    if r.returncode not in (0, 1):
        raise Refuse(f"git merge-base failed: {r.stderr.strip()[:200]}")
    return r.returncode == 0


# Prod moves with iphone-only commits far faster than a desktop package can be
# built, so a package of a prod ancestor is still "the prod build" when every
# commit after it only touched these paths.
DESKTOP_IRRELEVANT = ("ios/",)


def desktop_equivalent(repo: Path, commit: str, head: str) -> bool:
    if not is_ancestor(repo, commit, head):
        return False
    changed = [p for p in git(repo, "diff", "--name-only", commit, head).stdout.splitlines() if p]
    return all(p.startswith(DESKTOP_IRRELEVANT) for p in changed)


def branch_head(repo: Path, branch: str):
    r = git(repo, "rev-parse", "--verify", "--quiet", f"refs/heads/{branch}^{{commit}}", check=False)
    return r.stdout.strip() if r.returncode == 0 and SHA.match(r.stdout.strip()) else None


def load_ledger(path: Path) -> dict:
    if not path.is_file():
        return {}
    try:
        return json.loads(path.read_text())
    except Exception as e:  # noqa: BLE001
        raise Refuse(f"ledger {path} unreadable ({e})")


def write_json(path: Path, body: dict):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    with tmp.open("w") as f:
        json.dump(body, f, indent=2, sort_keys=True)
        f.write("\n"); f.flush(); os.fsync(f.fileno())
    os.replace(tmp, path)


def now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S%z")


def require_app(path: str) -> Path:
    app = Path(path).expanduser().resolve()
    if not (app / "Contents").is_dir():
        raise Refuse(f"not an app bundle: {app}")
    return app


def resolve_repo(a, ledger: dict, ledger_path: Path, seeding: bool) -> Path:
    raw = a.repo or ledger.get("repo")
    if not raw:
        raise Refuse("first record on this machine: pass --repo (the canonical bos-bot checkout)" if seeding
                     else f"no git repo to check ancestry against (ledger {ledger_path} has none; pass --repo or record first)")
    repo = Path(raw).expanduser().resolve()
    if not ((repo / ".git").exists() or (repo / "HEAD").exists()):
        raise Refuse(f"{repo} is not a git repo")
    return repo


def resolve_branch(a, ledger: dict, ledger_path: Path, seeding: bool) -> str:
    branch = a.release_branch or ledger.get("release_branch")
    if not branch:
        raise Refuse("first record on this machine: pass --release-branch (for example release/bos-1.0)" if seeding
                     else f"no release branch configured (ledger {ledger_path} has none; pass --release-branch or record first)")
    return branch


def resolve_prod(a, ledger: dict) -> str:
    # argparse default None = not given: ledger value, else "prod". "" = explicitly off.
    return a.prod_branch if a.prod_branch is not None else ledger.get("prod_branch", DEFAULT_PROD)


# ── commands ──────────────────────────────────────────────────────────────

def cmd_stamp(a) -> dict:
    app = require_app(a.app)
    if not SHA.match(a.commit or ""):
        raise Refuse("--commit must be the full 40-hex source commit")
    body = {"commit": a.commit, **digests(app), "stamped_at": now()}
    native = app / "Contents/Resources/native-contract.json"
    if native.is_file(): body["native_contract_sha256"] = hashlib.sha256(native.read_bytes()).hexdigest()
    write_json(app / STAMP, body)
    return {"ok": True, "reason": f"stamped {app} as {a.commit[:8]}", "stamp": body}


def running_build(live: Path, ledger: dict) -> dict:
    """The commit of the bundle that is live now: its own valid stamp, else the
    ledger's live entry when that entry's digests describe this bundle."""
    commit, how = read_stamp(live)
    actual = digests(live)
    if commit:
        return {"commit": commit, "source": "stamp", **actual}
    entry = ledger.get("live") or {}
    if entry.get("server_sha256") == actual["server_sha256"] and entry.get("ui_sha256") == actual["ui_sha256"] and SHA.match(str(entry.get("commit", ""))):
        return {"commit": entry["commit"], "source": "ledger", **actual}
    raise Refuse(
        f"running build unknown: live bundle {live} is {how} and the ledger's live entry "
        f"({(entry.get('commit') or 'none')[:8]}) does not describe its server/ui trees. "
        "record the running build first (no-downgrade.py record --live APP --commit SHA)."
    )


def cmd_check(a) -> dict:
    candidate = require_app(a.candidate)
    live = require_app(a.live)
    ledger_path = Path(a.ledger).expanduser()
    ledger = load_ledger(ledger_path)
    repo = resolve_repo(a, ledger, ledger_path, seeding=False)
    branch = resolve_branch(a, ledger, ledger_path, seeding=False)
    prod = resolve_prod(a, ledger)
    if branch_head(repo, branch) is None:
        raise Refuse(f"release branch {branch} not found in {repo}")

    running = running_build(live, ledger)
    cand_digests = digests(candidate)
    out = {"ok": False, "mode": "rollback" if a.rollback else "install", "repo": str(repo), "release_branch": branch,
           "prod_branch": prod or None, "running": running,
           "candidate": {**cand_digests, "commit": None, "source": None}, "ledger": str(ledger_path)}

    if a.rollback:
        previous = (ledger.get("history") or [None])[-1] or {}
        if previous.get("server_sha256") != cand_digests["server_sha256"] or previous.get("ui_sha256") != cand_digests["ui_sha256"]:
            raise Refuse(
                f"rollback refused: {candidate} is not the previously-live build "
                f"(ledger history has {(previous.get('commit') or 'nothing')[:8]} with other server/ui digests; running is {running['commit'][:8]})"
            )
        out["candidate"].update(commit=previous.get("commit"), source="ledger-history")
        out.update(ok=True, reason=f"rollback allowed: candidate is the previously-live build {str(previous.get('commit'))[:8]} (running {running['commit'][:8]})")
        return out

    commit, how = read_stamp(candidate)
    if not commit:
        raise Refuse(f"candidate refused: {candidate} is {how}; only a build stamped with its source commit can be installed (running {running['commit'][:8]})")
    out["candidate"].update(commit=commit, source="stamp")
    if not commit_exists(repo, commit):
        raise Refuse(f"candidate refused: stamped commit {commit[:8]} is not in {repo} (fetch it first). running is {running['commit'][:8]}")
    check_native_contract(candidate, repo, commit)
    out.update(judge(repo, branch, prod, running["commit"], commit))
    return out


def judge(repo: Path, branch: str, prod: str, running: str, commit: str) -> dict:
    """Rules 3-5 for a commit against the running one: ancestor, on release,
    prod head. Shared by `check` (a stamped bundle) and `preview` (a commit
    that may not be built yet) so both say no for the same reasons."""
    if not is_ancestor(repo, running, commit):
        raise Refuse(
            f"downgrade refused: running {running[:8]} is not an ancestor of candidate {commit[:8]} "
            f"(older build, or a sibling branch). only a descendant of the running build may be installed."
        )
    if not is_ancestor(repo, commit, f"refs/heads/{branch}"):
        raise Refuse(f"candidate refused: {commit[:8]} is not reachable from {branch} (running {running[:8]}). only release builds go live.")
    if prod:
        head = branch_head(repo, prod)
        if head is None:
            raise Refuse(f"candidate refused: prod branch {prod} not found in {repo}; nothing is accepted for install")
        if head != commit and not desktop_equivalent(repo, commit, head):
            raise Refuse(f"candidate refused: {commit[:8]} is not what {prod} points at ({head[:8]}); only the accepted prod build goes live (running {running[:8]})")
    same = commit == running
    return {"ok": True, "up_to_date": same,
            "reason": (f"allowed: candidate {commit[:8]} is the running commit rebuilt" if same
                       else f"allowed: candidate {commit[:8]} descends from running {running[:8]}, is on {branch}"
                            + (f" and is the {prod} head" if prod else ""))}


def cmd_preview(a) -> dict:
    live = require_app(a.live)
    ledger_path = Path(a.ledger).expanduser()
    ledger = load_ledger(ledger_path)
    repo = resolve_repo(a, ledger, ledger_path, seeding=False)
    branch = resolve_branch(a, ledger, ledger_path, seeding=False)
    prod = resolve_prod(a, ledger)
    if branch_head(repo, branch) is None:
        raise Refuse(f"release branch {branch} not found in {repo}")
    running = running_build(live, ledger)
    commit = a.commit
    if not commit:
        if not prod:
            raise Refuse("preview needs --commit when the prod check is off (--prod-branch \"\")")
        commit = branch_head(repo, prod)
        if commit is None:
            raise Refuse(f"prod branch {prod} not found in {repo}; nothing is accepted for install")
    if not SHA.match(commit):
        r = git(repo, "rev-parse", "--verify", "--quiet", f"{commit}^{{commit}}", check=False)
        if r.returncode or not SHA.match(r.stdout.strip()):
            raise Refuse(f"candidate refused: {commit} is not a commit in {repo}")
        commit = r.stdout.strip()
    if not commit_exists(repo, commit):
        raise Refuse(f"candidate refused: {commit[:8]} is not in {repo} (fetch it first). running is {running['commit'][:8]}")
    out = {"mode": "preview", "repo": str(repo), "release_branch": branch, "prod_branch": prod or None,
           "running": running, "candidate": {"commit": commit, "source": "commit"}, "ledger": str(ledger_path)}
    out.update(judge(repo, branch, prod, running["commit"], commit))
    if out["up_to_date"]:
        out["reason"] = f"up to date: running {running['commit'][:8]} is the {prod or branch} head"
    return out


def cmd_record(a) -> dict:
    live = require_app(a.live)
    ledger_path = Path(a.ledger).expanduser()
    ledger = load_ledger(ledger_path)
    repo = resolve_repo(a, ledger, ledger_path, seeding=True)
    branch = resolve_branch(a, ledger, ledger_path, seeding=True)
    prod = resolve_prod(a, ledger)
    stamped, how = read_stamp(live)
    commit = a.commit or stamped
    if not commit:
        raise Refuse(f"{live} is {how}; pass --commit for a build from before the guard")
    if not SHA.match(commit):
        raise Refuse("--commit must be the full 40-hex source commit")
    if stamped and a.commit and stamped != a.commit:
        raise Refuse(f"--commit {a.commit[:8]} contradicts the bundle's own stamp {stamped[:8]}")
    if not commit_exists(repo, commit):
        raise Refuse(f"commit {commit[:8]} is not in {repo}")
    entry = {"commit": commit, **digests(live), "recorded_at": now(), "app": str(live), "source": "stamp" if stamped else "operator"}
    history = list(ledger.get("history") or [])
    current = ledger.get("live")
    if current and (current.get("server_sha256") != entry["server_sha256"] or current.get("ui_sha256") != entry["ui_sha256"]):
        history.append(current)
    body = {"repo": str(repo), "release_branch": branch, "prod_branch": prod, "live": entry, "history": history[-20:]}
    write_json(ledger_path, body)
    return {"ok": True, "reason": f"recorded {commit[:8]} as the running build in {ledger_path}", "live": entry, "previous": current}


def main(argv=None) -> int:
    p = argparse.ArgumentParser(prog="no-downgrade.py", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("stamp"); s.add_argument("--app", required=True); s.add_argument("--commit", required=True)
    c = sub.add_parser("check"); c.add_argument("--candidate", required=True); c.add_argument("--live", required=True)
    c.add_argument("--rollback", action="store_true"); c.add_argument("--ledger", default=str(DEFAULT_LEDGER))
    c.add_argument("--repo"); c.add_argument("--release-branch"); c.add_argument("--prod-branch", default=None)
    r = sub.add_parser("record"); r.add_argument("--live", required=True); r.add_argument("--commit")
    r.add_argument("--ledger", default=str(DEFAULT_LEDGER)); r.add_argument("--repo"); r.add_argument("--release-branch"); r.add_argument("--prod-branch", default=None)
    v = sub.add_parser("preview"); v.add_argument("--live", required=True); v.add_argument("--commit")
    v.add_argument("--ledger", default=str(DEFAULT_LEDGER)); v.add_argument("--repo"); v.add_argument("--release-branch"); v.add_argument("--prod-branch", default=None)
    a = p.parse_args(argv)
    try:
        out = {"stamp": cmd_stamp, "check": cmd_check, "record": cmd_record, "preview": cmd_preview}[a.cmd](a)
        code = 0
    except Refuse as e:
        out, code = {"ok": False, "reason": str(e)}, 2
    except Exception as e:  # noqa: BLE001
        out, code = {"ok": False, "reason": f"error: {e}"}, 1
    print(json.dumps(out, indent=2, sort_keys=True))
    print(("ok: " if out["ok"] else "REFUSED: ") + out["reason"], file=sys.stderr)
    return code


if __name__ == "__main__":
    sys.exit(main())
