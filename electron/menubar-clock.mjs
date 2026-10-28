// The menu bar clock: while a bot works, the mac's menu bar shows a small
// ring in its colour (the plan's steps, when it has one) and "cash 3/5 ·
// 4:12" ticking with the job. Fed by the notch snapshot (src/notch/feed.ts
// menuBarClock), so it follows the notch setting and shows nothing when the
// team is quiet. A click opens that bot's thread.
import { Tray, nativeImage } from "electron";

/** 0:07, 4:12, 1:03:09 */
export function clockElapsed(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** The validated clock from a snapshot, or null. */
export function parseClock(raw) {
  if (!raw || typeof raw !== "object") return null;
  const { botId, threadId, name, color, needsYou, start, plan, more } = raw;
  if (typeof botId !== "string" || typeof threadId !== "string" || typeof name !== "string" || !name.trim()) return null;
  const okPlan = plan && Number.isInteger(plan.index) && Number.isInteger(plan.count) && plan.count >= 2 && plan.count <= 40 && plan.index >= 1;
  return {
    botId, threadId,
    name: name.trim().slice(0, 24),
    color: typeof color === "string" && /^#[0-9a-f]{6}$/i.test(color) ? color : "#ffffff",
    needsYou: needsYou === true,
    start: Number.isFinite(start) && start > 0 ? start : 0,
    plan: okPlan ? { index: Math.min(plan.index, plan.count), count: plan.count } : null,
    more: Number.isInteger(more) && more > 0 ? Math.min(more, 99) : 0,
  };
}

/** "cash 3/5 · 4:12", "cash needs you · 0:48 +1" */
export function clockTitle(clock, now) {
  if (!clock) return "";
  const state = clock.needsYou ? " needs you" : clock.plan ? ` ${clock.plan.index}/${clock.plan.count}` : "";
  const time = clock.start ? ` · ${clockElapsed(now - clock.start)}` : "";
  return ` ${clock.name.toLowerCase()}${state}${time}${clock.more ? ` +${clock.more}` : ""}`;
}

/** The ring as a 2x BGRA bitmap: plan segments done solid, the step in
 * progress half lit, the rest faint; a whole ring without a plan, amber
 * when the bot needs you. Same rule as the phone's PlanSegments. */
export function ringBitmap(clock, size = 36) {
  const buf = Buffer.alloc(size * size * 4);
  const hex = clock.needsYou ? "#ffc24a" : clock.color;
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const c = size / 2, radius = size * 0.36, half = size * 0.065;
  const count = clock.plan?.count ?? 0, gap = count > 8 ? 0.012 : 0.028;
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) {
    const dx = x + 0.5 - c, dy = y + 0.5 - c;
    const cover = Math.min(1, Math.max(0, half + 0.5 - Math.abs(Math.hypot(dx, dy) - radius)));
    if (!cover) continue;
    let alpha = 1;
    let tint = [r, g, b];
    if (count) {
      const turn = ((Math.atan2(dx, -dy) / (2 * Math.PI)) + 1) % 1; // 0 at twelve, clockwise
      const seg = Math.floor(turn * count), into = turn * count - seg;
      if (into < gap * count / 2 || into > 1 - gap * count / 2) continue;
      if (seg + 1 === clock.plan.index) alpha = 0.5;
      else if (seg + 1 > clock.plan.index) { tint = [255, 255, 255]; alpha = 0.25; }
    }
    const a = Math.round(255 * cover * alpha), o = (y * size + x) * 4;
    // premultiplied BGRA
    buf[o] = Math.round(tint[2] * a / 255); buf[o + 1] = Math.round(tint[1] * a / 255); buf[o + 2] = Math.round(tint[0] * a / 255); buf[o + 3] = a;
  }
  return buf;
}

export function createMenuBarClock({ onOpen }) {
  if (process.platform !== "darwin") return { update() {}, dispose() {} };
  let tray = null;
  let clock = null;
  let ticker = null;
  let ringKey = "";

  const draw = () => {
    if (!tray || !clock) return;
    tray.setTitle(clockTitle(clock, Date.now()), { fontType: "monospacedDigit" });
    const key = `${clock.color}|${clock.needsYou}|${clock.plan?.index}/${clock.plan?.count}`;
    if (key !== ringKey) {
      ringKey = key;
      const image = nativeImage.createFromBitmap(ringBitmap(clock), { width: 36, height: 36, scaleFactor: 2 });
      tray.setImage(image);
    }
    tray.setToolTip(clock.needsYou ? `${clock.name} needs you` : `${clock.name} is working`);
  };

  const stop = () => {
    clearInterval(ticker);
    ticker = null;
    tray?.destroy();
    tray = null;
    ringKey = "";
  };

  return {
    update(raw) {
      clock = parseClock(raw);
      if (!clock) return stop();
      if (!tray) {
        tray = new Tray(nativeImage.createEmpty());
        tray.on("click", () => clock && onOpen(clock.botId, clock.threadId));
      }
      draw();
      ticker ??= setInterval(draw, 1000);
    },
    dispose: stop,
  };
}
