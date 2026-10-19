import { describe, expect, it } from "vitest";
import { applyVideoEdits, emptyTimeline, timelineDuration, videoForBot, type VideoMedia, type VideoRecord } from "./video.ts";

const who = { kind: "bot" as const, id: "b", name: "bos" };
const clip: VideoMedia = { id: "m-abcdef12", name: "a.mp4", kind: "video", file: "a.mp4", duration: 10, width: 1080, height: 1920, hasAudio: true, bytes: 1, addedAt: 0, addedBy: who };

describe("video timeline edits", () => {
  it("appends, splits, ripples and refuses overlaps", () => {
    const base = emptyTimeline("portrait");
    const v = base.tracks[0]!.id;
    let { timeline, created } = applyVideoEdits(base, [clip], [{ op: "add_clip", track_id: v, media_id: clip.id, in: 2 }]);
    expect(timelineDuration(timeline)).toBe(8);
    ({ timeline } = applyVideoEdits(timeline, [clip], [{ op: "split", clip_id: created[0]!, at: 3 }]));
    const [left, right] = timeline.tracks[0]!.clips;
    expect(left!.duration).toBe(3);
    expect(right!.in).toBe(5);
    ({ timeline } = applyVideoEdits(timeline, [clip], [{ op: "delete_clip", clip_id: left!.id, ripple: true }]));
    expect(timeline.tracks[0]!.clips[0]!.start).toBe(0);
    expect(() => applyVideoEdits(timeline, [clip], [{ op: "add_clip", track_id: v, media_id: clip.id, start: 1, duration: 1 }])).toThrow(/overlap/);
    expect(() => applyVideoEdits(timeline, [clip], [{ op: "update_clip", clip_id: timeline.tracks[0]!.clips[0]!.id, duration: 9 }])).toThrow(/past the end/);
  });
  it("stores clip times without float drift", () => {
    const base = emptyTimeline("portrait");
    let { timeline, created } = applyVideoEdits(base, [clip], [{ op: "add_clip", track_id: base.tracks[0]!.id, media_id: clip.id, start: 6, duration: 5 }]);
    ({ timeline } = applyVideoEdits(timeline, [clip], [{ op: "split", clip_id: created[0]!, at: 8.2 }]));
    expect(timeline.tracks[0]!.clips.map(c => [c.duration, c.in])).toEqual([[2.2, 0], [2.8, 2.2]]);
  });
  it("writes a readable bot view", () => {
    const base = emptyTimeline();
    const { timeline } = applyVideoEdits(base, [clip], [{ op: "add_clip", track_id: base.tracks[1]!.id, text: "hello", start: 1 }]);
    const rec = { id: "v-abcdefgh", title: "t", revision: 1, createdAt: 0, updatedAt: 0, createdBy: who, updatedBy: who, media: [clip], timeline, renders: [], versions: [] } as VideoRecord;
    expect(videoForBot(rec)).toContain('"hello"');
  });
});
