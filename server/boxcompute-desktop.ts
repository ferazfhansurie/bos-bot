// The cloud desktop inside a bot's BoxCompute VM: Xvfb :1 (1280x800) +
// openbox + Google Chrome as the non-root user `bos`, x11vnc + noVNC on
// port 6080 so the person can watch and take over through a preview link.
//
// The whole script rides along as `bash -c` on every desktop call, so one
// execute both heals the desktop (install on first use, restart after a
// cold wake) and performs the action. Nothing to version or keep in sync
// on the VM, and parallel first calls serialize on a flock.
//
// Hard-won (2026-10-18 on a live VM):
// - a small VM (1 GiB) OOM-kills Chrome and BoxCompute's own agent → large only
// - Ubuntu 26.04 blocks Chrome's sandbox for non-root without the userns sysctl
// - without --disable-gpu Chrome paints a blank screen; scrot, not ImageMagick
//   `import`, captures it
// - /workspace is sandbox:sandbox 0750: without the sandbox group `bos` cannot
//   reach its profile, Chrome silently falls back to ~/.config, and Chrome
//   136+ then ignores --remote-debugging-port (no CDP)
import { BoxComputeError } from "./boxcompute-error.ts";

export const DESKTOP_WIDTH = 1280;
export const DESKTOP_HEIGHT = 800;
export const DESKTOP_VNC_PORT = 6080;
export const DESKTOP_CDP_PORT = 9222;
/** Covers a first-use install (~90s on large) with room to spare. */
export const DESKTOP_TIMEOUT_SECONDS = 600;
const MAX_TYPE_CHARS = 4000;

export const DESKTOP_SCRIPT = String.raw`set -uo pipefail
D=/workspace/.bos-desktop
UNITS="bos-xvfb bos-wm bos-vnc bos-novnc bos-chrome"
installed() {
  command -v google-chrome && command -v x11vnc && command -v websockify && command -v xdotool && command -v scrot && command -v flock && [ -e /usr/share/novnc/vnc.html ]
} >/dev/null 2>&1
running() { local u; for u in $UNITS; do systemctl is-active -q "$u" || return 1; done; }
install_packages() {
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq || return 1
  apt-get install -y -qq --no-install-recommends xvfb openbox x11vnc novnc websockify scrot xdotool imagemagick util-linux fonts-noto-color-emoji fonts-liberation fonts-noto-cjk || return 1
  curl -fsSLo /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb || return 1
  apt-get install -y -qq /tmp/chrome.deb || return 1
  rm -f /tmp/chrome.deb
}
prepare() {
  echo kernel.apparmor_restrict_unprivileged_userns=0 > /etc/sysctl.d/60-bos-chrome.conf
  sysctl -q -w kernel.apparmor_restrict_unprivileged_userns=0 || true
  id bos >/dev/null 2>&1 || useradd -m -s /bin/bash bos
  if getent group sandbox >/dev/null; then usermod -aG sandbox bos; fi
  install -d -o bos -g bos "$D" "$D/chrome"
}
start_units() {
  systemctl is-active -q bos-xvfb || { systemd-run -q --unit=bos-xvfb -p Restart=always Xvfb :1 -screen 0 1280x800x24 -nolisten tcp; sleep 1; }
  systemctl is-active -q bos-wm || systemd-run -q --unit=bos-wm -p Restart=always --uid=bos -E DISPLAY=:1 -E HOME=/home/bos openbox
  systemctl is-active -q bos-vnc || systemd-run -q --unit=bos-vnc -p Restart=always x11vnc -display :1 -forever -shared -nopw -localhost -rfbport 5900 -quiet
  systemctl is-active -q bos-novnc || systemd-run -q --unit=bos-novnc -p Restart=always websockify --web /usr/share/novnc 6080 localhost:5900
  systemctl reset-failed bos-chrome 2>/dev/null || true
  systemctl is-active -q bos-chrome || { rm -f "$D"/chrome/Singleton*; systemd-run -q --unit=bos-chrome -p Restart=always -p MemoryMax=75% --uid=bos -E DISPLAY=:1 -E HOME=/home/bos \
    google-chrome --disable-gpu --disable-dev-shm-usage --renderer-process-limit=3 --password-store=basic --user-data-dir="$D/chrome" \
    --no-first-run --no-default-browser-check --start-maximized --remote-debugging-port=9222 about:blank; }
  local i; for i in 1 2 3 4 5 6 7 8 9 10; do running && return 0; sleep 1; done
  return 1
}
ensure() {
  installed && running && return 0
  exec 9>/tmp/bos-desktop.lock
  flock -w 840 9 || { echo "another desktop setup is still running; try again in a minute" >&2; exit 89; }
  if ! installed; then
    install_packages >/tmp/bos-desktop-install.log 2>&1 || { echo "desktop install failed:" >&2; tail -c 1500 /tmp/bos-desktop-install.log >&2; exit 87; }
  fi
  prepare
  start_units || { echo "the desktop did not start:" >&2; for u in $UNITS; do echo "$u $(systemctl is-active "$u")" >&2; done; exit 88; }
  sleep 2
}
X() { DISPLAY=:1 timeout 30 xdotool "$@"; }
action="$1"; shift
ensure
case "$action" in
  ensure) echo ready ;;
  screenshot)
    f=/tmp/bos-shot.png; m=image/png
    DISPLAY=:1 timeout 30 scrot -o -p "$f" || exit 90
    if [ "$(stat -c%s "$f")" -gt 700000 ]; then
      { magick "$f" -quality 75 /tmp/bos-shot.jpg 2>/dev/null || convert "$f" -quality 75 /tmp/bos-shot.jpg 2>/dev/null; } && { f=/tmp/bos-shot.jpg; m=image/jpeg; }
    fi
    echo "$m"; base64 -w0 "$f" ;;
  click) X mousemove "$1" "$2" && X click --repeat "$4" --delay 120 "$3" ;;
  move) X mousemove "$1" "$2" ;;
  type) X type --delay 25 -- "$1" ;;
  key) X key --delay 80 -- "$@" ;;
  scroll) X mousemove "$1" "$2" && X click --repeat "$4" --delay 40 "$3" ;;
  open) runuser -u bos -- env DISPLAY=:1 HOME=/home/bos timeout 20 google-chrome --user-data-dir="$D/chrome" "$1" >/dev/null 2>&1; sleep 2; echo opened ;;
  *) echo "unknown desktop action $action" >&2; exit 2 ;;
esac`;

export const DESKTOP_TOOL_NAMES = [
  "sandbox_desktop_screenshot",
  "sandbox_desktop_click",
  "sandbox_desktop_type",
  "sandbox_desktop_key",
  "sandbox_desktop_scroll",
  "sandbox_desktop_open_url",
  "sandbox_desktop_live_link",
] as const;
export type DesktopToolName = (typeof DESKTOP_TOOL_NAMES)[number];

export function isDesktopTool(name: string): name is DesktopToolName {
  return (DESKTOP_TOOL_NAMES as readonly string[]).includes(name);
}

function coordinate(value: unknown, field: string, max: number): string {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n < 0 || n >= max) {
    throw new BoxComputeError(`${field} must be a pixel 0-${max - 1} on the ${DESKTOP_WIDTH}x${DESKTOP_HEIGHT} screenshot`, 400);
  }
  return String(n);
}

function count(value: unknown, fallback: number, max: number): string {
  const n = Math.floor(Number(value));
  return String(Number.isFinite(n) && n >= 1 ? Math.min(n, max) : fallback);
}

const BUTTONS: Record<string, string> = { left: "1", middle: "2", right: "3" };
const SCROLL: Record<string, string> = { up: "4", down: "5", left: "6", right: "7" };

/** The script's action and its positional arguments for one tool call.
 * Everything is argv, never interpolated shell text. */
export function desktopAction(name: DesktopToolName, args: Record<string, unknown>): string[] {
  const str = (field: string) => (typeof args[field] === "string" ? (args[field] as string) : "");
  switch (name) {
    case "sandbox_desktop_screenshot":
      return ["screenshot"];
    case "sandbox_desktop_live_link":
      return ["ensure"];
    case "sandbox_desktop_click": {
      const button = BUTTONS[str("button") || "left"];
      if (!button) throw new BoxComputeError("button must be left, right or middle", 400);
      return ["click", coordinate(args.x, "x", DESKTOP_WIDTH), coordinate(args.y, "y", DESKTOP_HEIGHT), button, args.double === true ? "2" : "1"];
    }
    case "sandbox_desktop_type": {
      const text = str("text");
      if (!text) throw new BoxComputeError("text is required", 400);
      if (text.length > MAX_TYPE_CHARS) throw new BoxComputeError(`text is over ${MAX_TYPE_CHARS} characters; type it in parts`, 400);
      return ["type", text];
    }
    case "sandbox_desktop_key": {
      const keys = str("keys").trim().split(/\s+/).filter(Boolean);
      if (!keys.length) throw new BoxComputeError('keys is required, e.g. "ctrl+l" or "Return"', 400);
      if (keys.length > 20 || keys.some((key) => !/^[A-Za-z0-9_+-]{1,40}$/.test(key))) {
        throw new BoxComputeError('keys are xdotool names separated by spaces, e.g. "ctrl+l", "Return", "Tab Tab"', 400);
      }
      return ["key", ...keys];
    }
    case "sandbox_desktop_scroll": {
      const direction = SCROLL[str("direction") || "down"];
      if (!direction) throw new BoxComputeError("direction must be up, down, left or right", 400);
      const x = args.x === undefined ? String(DESKTOP_WIDTH / 2) : coordinate(args.x, "x", DESKTOP_WIDTH);
      const y = args.y === undefined ? String(DESKTOP_HEIGHT / 2) : coordinate(args.y, "y", DESKTOP_HEIGHT);
      return ["scroll", x, y, direction, count(args.amount, 5, 30)];
    }
    case "sandbox_desktop_open_url": {
      const url = str("url").trim();
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new BoxComputeError("url must be a full http(s) address", 400);
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new BoxComputeError("url must be a full http(s) address", 400);
      return ["open", parsed.href];
    }
  }
}

/** Execute argv for one desktop call: the script plus its action. */
export function desktopArgv(action: string[]): string[] {
  return ["bash", "-c", DESKTOP_SCRIPT, "bos-desktop", ...action];
}

export function liveLinkUrl(previewUrl: string): string {
  return `${previewUrl.replace(/\/+$/, "")}/vnc.html?autoconnect=1&resize=scale`;
}
