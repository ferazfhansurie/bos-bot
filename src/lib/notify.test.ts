import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildNotificationOptions,
  mascotSvg,
  notificationIcon,
  notificationPhoto,
  requestNotificationPermission,
  showNotification,
  type NotifyFrame,
} from "./notify";

const baseFrame: NotifyFrame = {
  kind: "done",
  botId: "bot-1",
  botName: "Maus",
  threadId: "thread-1",
  title: "Maus finished",
  body: "All done",
};
// showNotification drops a banner it already showed (same kind, thread and
// body) for 30 minutes, so each test gets its own body.
let frame: NotifyFrame = baseFrame;
let seq = 0;
beforeEach(() => { frame = { ...baseFrame, body: `All done ${++seq}` }; });

function installNotification(permission: NotificationPermission, focused = false) {
  const notices: Array<{ title: string; options?: NotificationOptions; onclick: (() => void) | null }> = [];
  const requestPermission = vi.fn(async () => "granted" as NotificationPermission);
  class FakeNotification {
    static permission = permission;
    static requestPermission = requestPermission;
    onclick: (() => void) | null = null;
    constructor(public title: string, public options?: NotificationOptions) {
      notices.push(this);
    }
  }
  vi.stubGlobal("Notification", FakeNotification);
  vi.stubGlobal("document", { hasFocus: () => focused });
  vi.stubGlobal("window", { focus: vi.fn() });
  return { notices, requestPermission };
}

afterEach(() => vi.unstubAllGlobals());

describe("desktop notifications", () => {
  it("does not request permission from a background notification frame", () => {
    const { notices, requestPermission } = installNotification("default");
    showNotification(frame, vi.fn());
    expect(requestPermission).not.toHaveBeenCalled();
    expect(notices).toHaveLength(0);
  });

  it("requests permission through the explicit settings action", async () => {
    const { requestPermission } = installNotification("default");
    await requestNotificationPermission();
    expect(requestPermission).toHaveBeenCalledOnce();
  });

  it("shows a notification after permission is granted", () => {
    const { notices } = installNotification("granted");
    showNotification(frame, vi.fn());
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ title: frame.title, options: { body: frame.body, tag: `openmausbot:${frame.botId}` } });
  });

  it("stays quiet only when the exact target thread is already visible", () => {
    const { notices } = installNotification("granted", true);

    showNotification(frame, vi.fn(), undefined, frame.threadId);

    expect(notices).toHaveLength(0);
  });

  it("still alerts a focused app when another task is visible", () => {
    const { notices } = installNotification("granted", true);

    // done banners default to "only when unfocused"; a question still alerts
    showNotification({ ...frame, kind: "question" }, vi.fn(), undefined, "another-thread");

    expect(notices).toHaveLength(1);
  });

  it("opens the exact detached task carried by the notification", () => {
    const { notices } = installNotification("granted");
    const onOpen = vi.fn();

    showNotification({ ...frame, threadId: "detached-routine-thread" }, onOpen);
    notices[0]!.onclick?.();

    expect(window.focus).toHaveBeenCalledOnce();
    expect(onOpen).toHaveBeenCalledOnce();
    expect(onOpen).toHaveBeenCalledWith({
      botId: frame.botId,
      threadId: "detached-routine-thread",
    });
  });

  it("groups under the bot, not the thread", () => {
    const { notices } = installNotification("granted");

    showNotification(frame, vi.fn());
    showNotification(
      { ...frame, threadId: "thread-2", body: "Second task done" },
      vi.fn(),
    );

    // one bot across two threads shares a tag, so the platform replaces
    // rather than stacks; another bot gets its own key
    expect(notices[0]?.options?.tag).toBe(`openmausbot:${frame.botId}`);
    expect(notices[1]?.options?.tag).toBe(`openmausbot:${frame.botId}`);
    showNotification({ ...frame, botId: "bot-2", threadId: "thread-3" }, vi.fn());
    expect(notices[2]?.options?.tag).toBe(`openmausbot:bot-2`);
  });

  it("carries the bot's avatar when its profile has one", () => {
    const { notices } = installNotification("granted");
    const avatarUrl = "/api/attachments/123e4567-e89b-12d3-a456-426614174000.png";

    showNotification(frame, vi.fn(), avatarUrl);
    expect(notices[0]?.options?.icon).toBe(avatarUrl);

    showNotification({ ...frame, body: "Another result" }, vi.fn(), null);
    expect(notices[1]?.options?.icon).toBeUndefined();
  });
});

describe("buildNotificationOptions", () => {
  it("keys coalescing on botId and omits a missing avatar", () => {
    expect(buildNotificationOptions({ id: "bot-9" })).toEqual({
      tag: "openmausbot:bot-9",
      icon: undefined,
    });
  });
});

describe("the sending bot's face", () => {
  const photo = "/api/attachments/123e4567-e89b-12d3-a456-426614174000.png";

  it("uses the photo only when the profile shows it", () => {
    expect(notificationPhoto({ avatarUrl: photo, avatarCrop: "circle" })).toBe(photo);
    // a stored photo behind the mascot crop is not what the app shows
    expect(notificationPhoto({ avatarUrl: photo, avatarCrop: "mascot" })).toBeNull();
    expect(notificationPhoto({ avatarUrl: photo })).toBeNull();
    expect(notificationPhoto({ avatarUrl: "https://tracker.example/x.png", avatarCrop: "circle" })).toBeNull();
  });

  it("draws the bot's own mascot body and colour", () => {
    const svg = mascotSvg("green", "blob");
    expect(svg).toContain("M 51 12 C 75 8");
    expect(svg).not.toContain("#808080");
    expect(mascotSvg("green", "nope" as never)).toContain("M 50 10 C 72 10");
  });

  it("wears the resting glyph face, in any colour", () => {
    const svg = mascotSvg("#7c3aed");
    expect(svg).toContain('fill="#7C3AED"');
    expect(svg).toContain('stroke="#FFFFFF"');
    expect(mascotSvg("green", "circle", "classic")).toContain("M 51 43 L 54 52");
  });

  it("picks the sender in a room, and falls back to the frame for unknown bots", async () => {
    const sender = { id: "scout", color: "green" as const, avatarUrl: photo, avatarCrop: "rounded" as const };
    await expect(notificationIcon(sender)).resolves.toBe(photo);
    await expect(notificationIcon(undefined, photo)).resolves.toBe(photo);
    await expect(notificationIcon(undefined)).resolves.toBeUndefined();
  });
});
// branding compatibility (electron/branding-compat.json): pairing: old QR codes remain readable; server emission stays old until both native apps have shipped support; ipc: IPC and updater restart arguments preserve mixed-version desktop recovery
