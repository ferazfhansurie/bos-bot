import { describe, expect, it } from "vitest";
import { emptyTimeline, type VideoClip, type VideoTimeline } from "../../../shared/video";
import type { PlayableMedia } from "./video-api";
import { expectedSourceTime, fadeGain, needsResync, stepTime, textClipsAt, wantedClips } from "./video-playback";

const m: PlayableMedia = { id: "m-aaaaaa", name: "a.mp4", kind: "video", file: "a.mp4", duration: 10, bytes: 1, addedAt: 0, addedBy: { kind: "human", id: "o", name: "o" } };
const clip = (id: string, start: number, duration: number, extra: Partial<VideoClip> = {}): VideoClip => ({ id, start, duration, mediaId: m.id, in: 0, ...extra });
const timeline: VideoTimeline = { ...emptyTimeline("landscape"), tracks: [
  { id: "t-vvvv", kind: "video", clips: [clip("c-a", 0, 2), clip("c-b", 2, 2), clip("c-c", 10, 2)] },
  { id: "t-tttt", kind: "text", clips: [{ id: "c-t", start: 1, duration: 2, text: "hi" }] },
  { id: "t-hide", kind: "text", hidden: true, clips: [{ id: "c-h", start: 1, duration: 2, text: "no" }] },
  { id: "t-aaaa", kind: "audio", clips: [clip("c-m", 3, 5)] },
] };

describe("playback scheduling", () => {
  it("loads what is on screen plus the next clip on each track", () => {
    expect([...wantedClips(timeline, 0.5, 2.5)].sort()).toEqual(["c-a", "c-b", "c-m"]);
    expect([...wantedClips(timeline, 5, 2.5)].sort()).toEqual(["c-m"]);
    expect([...wantedClips(timeline, 8, 2.5)].sort()).toEqual(["c-c"]);
  });
  it("looks behind when rewinding", () => {
    expect([...wantedClips(timeline, 9, 2, -1)].sort()).toEqual(["c-m"]);
    expect([...wantedClips(timeline, 2.5, 2, -1)].sort()).toEqual(["c-a", "c-b"]);
  });
  it("maps the clock to source time with speed and clamps to the file", () => {
    expect(expectedSourceTime(clip("c-x", 2, 2, { in: 3 }), m, 3)).toBe(4);
    expect(expectedSourceTime(clip("c-x", 2, 2, { in: 3, speed: 2 }), m, 3)).toBe(5);
    expect(expectedSourceTime(clip("c-x", 2, 2, { in: 9.5, speed: 2 }), m, 3.9)).toBeCloseTo(9.98);
    expect(expectedSourceTime(clip("c-x", 2, 2, { in: 3 }), m, 0)).toBe(3);
  });
  it("fades in and out", () => {
    const c = clip("c-x", 0, 4, { fadeIn: 1, fadeOut: 2 });
    expect(fadeGain(c, 0)).toBe(0);
    expect(fadeGain(c, 0.5)).toBe(0.5);
    expect(fadeGain(c, 1.5)).toBe(1);
    expect(fadeGain(c, 3)).toBe(0.5);
    expect(fadeGain(clip("c-y", 0, 4), 0)).toBe(1);
  });
  it("tolerates small drift, more at higher rates", () => {
    expect(needsResync(1.05, 1)).toBe(false);
    expect(needsResync(1.2, 1)).toBe(true);
    expect(needsResync(1.2, 1, 4)).toBe(false);
  });
  it("steps by whole frames inside the timeline", () => {
    expect(stepTime(1, 1, 30, 10)).toBeCloseTo(1 + 1 / 30);
    expect(stepTime(1.01, -1, 30, 10)).toBeCloseTo(29 / 30);
    expect(stepTime(0, -1, 30, 10)).toBe(0);
    expect(stepTime(9.99, 30, 30, 10)).toBe(10);
  });
  it("shows text from visible tracks only", () => {
    expect(textClipsAt(timeline, 1.5).map(x => x.clip.id)).toEqual(["c-t"]);
    expect(textClipsAt(timeline, 3)).toEqual([]);
  });
});
