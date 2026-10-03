#!/usr/bin/env python3
"""read-only preflight for the bos updater. prints json; never unloads, kills or restarts."""
import json, os, plistlib, re, subprocess, urllib.request

PAT = re.compile(r"bos|openmausbot", re.I)
MAIN = "/Contents/MacOS/BOS Bot"
HEALTH = "http://127.0.0.1:8799/api/health"

def sh(*a):
    try:
        return subprocess.run(a, capture_output=True, text=True, timeout=10).stdout
    except Exception:
        return ""

def plist(path):
    try:
        with open(path, "rb") as f:
            return plistlib.load(f)
    except Exception:
        return {}

def launchd():
    jobs = []
    for line in sh("launchctl", "list").splitlines()[1:]:
        p = line.split("\t")
        if len(p) != 3 or not PAT.search(p[2]):
            continue
        label = p[2]
        info = sh("launchctl", "print", f"gui/{os.getuid()}/{label}")
        g = lambda rx: (m.group(1).strip() if (m := re.search(rx, info)) else None)
        path = g(r"\n\tpath = (.+)")
        pl = plist(path) if path else {}
        ka = pl.get("KeepAlive", False)
        keepalive = bool(ka) if not isinstance(ka, dict) else (ka.get("SuccessfulExit") is not False or len(ka) > 1)
        pid = None if p[0] == "-" else int(p[0])
        last = g(r"last exit code = (-?\d+)")
        j = {"label": label, "state": "running" if pid else "idle", "pid": pid,
             "keepalive": keepalive, "keepalive_raw": ka if ka else None,
             "run_at_load": bool(pl.get("RunAtLoad", False)),
             "last_exit": int(last) if last else (None if p[1] == "-" else int(p[1])),
             "runs": int(g(r"runs = (\d+)") or 0), "program": g(r"\n\tprogram = (.+)"), "plist": path}
        # blocks the updater only if it's live or would come back by itself
        # the app's own launchservices job (application.*) is the app itself, not an orphan
        app_self = label.startswith("application.")
        j["blocking"] = bool((pid or keepalive) and not app_self)
        j["reason"] = ("app itself" if app_self else "running" if pid else
                       "keepalive" if keepalive else "idle one-shot (report only)")
        jobs.append(j)
    return jobs

def ports():
    out = {}
    for port in (8799, 8812):
        rows = sh("lsof", "-nP", f"-iTCP:{port}", "-sTCP:LISTEN").splitlines()[1:]
        out[str(port)] = [{"cmd": r.split()[0], "pid": int(r.split()[1])} for r in rows]
    return out

def health():
    try:
        with urllib.request.urlopen(HEALTH, timeout=5) as r:
            body = r.read(2000).decode(errors="replace")
            try:
                data = json.loads(body)
            except Exception:
                data = None
            return {"url": HEALTH, "status": r.status, "body": data or body}
    except Exception as e:
        return {"url": HEALTH, "status": None, "error": str(e)}

def procs():
    rows = []
    for line in sh("ps", "-axww", "-o", "pid=,ppid=,args=").splitlines():
        m = re.match(r"\s*(\d+)\s+(\d+)\s+(.*)", line)
        if not m or "BOS Bot.app" not in m.group(3):
            continue
        pid, ppid, args = int(m.group(1)), int(m.group(2)), m.group(3)
        if "--type=utility" in args and "node.mojom.NodeService" in args:
            kind = "utility_node"
        elif re.search(r"BOS Bot\.app/Contents/MacOS/BOS Bot$", args):
            kind = "main"
        elif re.search(r"BOS Bot\.app/Contents/MacOS/BOS Bot ", args):
            kind = "companion"  # main binary run with a script (guardian etc), not a second app
        else:
            continue
        rows.append({"pid": pid, "ppid": ppid, "kind": kind, "args": args[:200]})
    return rows

jobs, ps, h = launchd(), procs(), health()
mains = [p for p in ps if p["kind"] == "main"]
hpid = h.get("body", {}).get("pid") if isinstance(h.get("body"), dict) else None
server = next((p for p in ps if p["pid"] == hpid), None)
res = {"health": h, "processes": ps, "ports": ports(), "launchd": jobs}
res["checks"] = {
    "health_ok": h.get("status") == 200 and isinstance(h.get("body"), dict) and h["body"].get("app") == "openmausbot",
    "health_pid_is_server": bool(server and server["kind"] == "utility_node" and mains and server["ppid"] == mains[0]["pid"]),
    "single_main_app": len(mains) == 1,
    "blocking_jobs": [j["label"] for j in jobs if j["blocking"]],
    "idle_jobs": [j["label"] for j in jobs if not j["blocking"]],
}
c = res["checks"]
res["ok"] = c["health_ok"] and c["health_pid_is_server"] and c["single_main_app"] and not c["blocking_jobs"]
print(json.dumps(res, indent=2))
