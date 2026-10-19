import { describe, expect, it } from "vitest";
import { applyVideoEdits, emptyTimeline, validateTimeline, type VideoClip, type VideoMedia, type VideoTimeline } from "../../../shared/video";
import {
  changedClipIds, displayOrder, filmstripSlots, fitsTrack, fitZoom, fmtTimecode, freeStart, mergeTimelines, neighbours, overlaps,
  peaksForClip, rulerLabel, rulerSteps, shuttle, sliderToZoom, snap, snapPoints, trimClip, zoomToSlider,
} from "./timeline-math";

const media: VideoMedia[] = [
  { id: "m-aaaaaa", name: "a.mp4", kind: "video", file: "a.mp4", duration: 10, bytes: 1, addedAt: 0, addedBy: { kind: "human", id: "o", name: "o" } },
  { id: "m-bbbbbb", name: "b.png", kind: "image", file: "b.png", duration: 0, bytes: 1, addedAt: 0, addedBy: { kind: "human", id: "o", name: "o" } },
];
const clip = (id: string, start: number, duration: number, extra: Partial<VideoClip> = {}): VideoClip => ({ id, start, duration, mediaId: "m-aaaaaa", in: 0, ...extra });

describe("timecode", () => {
  it("formats minutes, seconds and frames", () => {
    expect(fmtTimecode(0, 30)).toBe("00:00.00");
    expect(fmtTimecode(61.5, 30)).toBe("01:01.15");
    expect(fmtTimecode(1 / 30 * 29, 30)).toBe("00:00.29");
    expect(fmtTimecode(-2, 25)).toBe("-00:02.00");
  });
});

describe("track order", () => {
  it("puts overlays on top, the base video near the bottom and audio last", () => {
    const t = emptyTimeline("landscape"); // video, text, audio
    const order = displayOrder(t.tracks).map(x => x.kind);
    expect(order).toEqual(["text", "video", "audio"]);
  });
  it("knows which clips fit which tracks", () => {
    expect(fitsTrack("video", "image")).toBe(true);
    expect(fitsTrack("video", "audio")).toBe(false);
    expect(fitsTrack("audio", "video")).toBe(true);
    expect(fitsTrack("text", "video")).toBe(false);
  });
});

describe("free spots and snapping", () => {
  const clips = [clip("c-one1", 0, 2), clip("c-two2", 5, 2)];
  it("detects overlaps, ignoring excluded clips and touching edges", () => {
    expect(overlaps(clips, 1, 1)).toBe(true);
    expect(overlaps(clips, 2, 3)).toBe(false);
    expect(overlaps(clips, 1, 1, new Set(["c-one1"]))).toBe(false);
  });
  it("moves a drop to the nearest gap that fits", () => {
    expect(freeStart(clips, 2.5, 1)).toBe(2.5);
    expect(freeStart(clips, 1.5, 2)).toBe(2);
    expect(freeStart(clips, 5.5, 2)).toBe(7);
    expect(freeStart(clips, 2, 4)).toBe(7);
    expect(freeStart(clips, 2, 4, new Set(), 1)).toBeNull();
  });
  it("snaps whichever edge is closest", () => {
    const points = snapPoints({ ...emptyTimeline(), tracks: [{ id: "t-aaaa", kind: "video", clips }] }, new Set(["c-two2"]), 3.3);
    expect(points).toContain(2);
    expect(points).toContain(3.3);
    expect(snap(1.95, points, 0.1)).toEqual({ t: 2, at: 2 });
    // a 1s clip whose end lands near the playhead
    expect(snap(2.25, points, 0.1, [0, 1])).toEqual({ t: 2.3, at: 3.3 });
    expect(snap(2.5, points, 0.1).at).toBeNull();
  });
});

describe("trimming", () => {
  const track = { id: "t-aaaa", kind: "video" as const, clips: [clip("c-one1", 0, 2), clip("c-two2", 4, 3, { in: 2 }), clip("c-thr3", 8, 1)] };
  const c = track.clips[1]!;
  it("moves the in-point with the left edge", () => {
    expect(trimClip(c, media[0], "left", 5, neighbours(track, c.id), 0.04)).toEqual({ start: 5, duration: 2, in: 3 });
  });
  it("stops the left edge where the source starts and at the neighbour", () => {
    expect(trimClip(c, media[0], "left", 1, neighbours(track, c.id), 0.04)).toEqual({ start: 2, duration: 5, in: 0 });
    const late = { ...c, in: 5 };
    expect(trimClip(late, media[0], "left", 0, neighbours(track, c.id), 0.04).start).toBe(2);
  });
  it("stops the right edge at the source end, the neighbour and the minimum", () => {
    expect(trimClip(c, media[0], "right", 20, { prevEnd: 2, nextStart: Infinity }, 0.04).duration).toBe(8); // 10s file from in 2
    expect(trimClip(c, media[0], "right", 20, neighbours(track, c.id), 0.04).duration).toBe(4);
    expect(trimClip(c, media[0], "right", 0, neighbours(track, c.id), 0.04).duration).toBeCloseTo(0.04);
  });
  it("respects speed: a 2x clip covers twice the source", () => {
    const fast = { ...c, speed: 2 };
    expect(trimClip(fast, media[0], "right", 20, { prevEnd: 0, nextStart: Infinity }, 0.04).duration).toBe(4);
    expect(trimClip(fast, media[0], "left", 4.5, { prevEnd: 0, nextStart: Infinity }, 0.04)).toEqual({ start: 4.5, duration: 2.5, in: 3 });
  });
  it("lets images and text stretch freely", () => {
    const still = { ...c, mediaId: "m-bbbbbb" };
    expect(trimClip(still, media[1], "right", 30, { prevEnd: 0, nextStart: Infinity }, 0.04).duration).toBe(26);
  });
  it("produces timelines that validate", () => {
    const tl: VideoTimeline = { ...emptyTimeline(), tracks: [track] };
    const next = trimClip(c, media[0], "left", 3, neighbours(track, c.id), 0.04);
    const { timeline } = applyVideoEdits(tl, media, [{ op: "update_clip", clip_id: c.id, ...next }]);
    expect(timeline.tracks[0]!.clips[1]).toMatchObject({ start: 3, duration: 4, in: 1 });
  });
});

describe("ruler and zoom", () => {
  it("keeps labels apart at every zoom", () => {
    for (const pps of [2, 10, 40, 100, 300, 600]) {
      const { major, minor } = rulerSteps(pps, 30);
      expect(major * pps).toBeGreaterThanOrEqual(72);
      expect(minor).toBeLessThanOrEqual(major);
    }
    expect(rulerSteps(600, 30).major).toBeLessThan(1);
  });
  it("labels frames inside a second", () => {
    expect(rulerLabel(65, 5, 30)).toBe("01:05");
    expect(rulerLabel(1 + 10 / 30, 1 / 3, 30)).toBe("10f");
  });
  it("fits the timeline and maps the slider both ways", () => {
    expect(fitZoom(100, 1024)).toBeCloseTo((1000 / 100) * 0.96);
    expect(sliderToZoom(zoomToSlider(50))).toBeCloseTo(50);
  });
});

describe("filmstrip and waveform", () => {
  it("picks the sprite tile for each slot's source time", () => {
    const slots = filmstripSlots(clip("c-one1", 0, 4, { in: 2 }), { every: 1, count: 10 }, 50, 50);
    expect(slots.map(s => s.index)).toEqual([2, 3, 4, 5]);
    const fast = filmstripSlots(clip("c-one1", 0, 4, { speed: 2 }), { every: 1, count: 10 }, 50, 50);
    expect(fast.map(s => s.index)).toEqual([1, 3, 5, 7]);
    expect(filmstripSlots(clip("c-one1", 0, 40), { every: 1, count: 10 }, 50, 50).at(-1)!.index).toBe(9);
  });
  it("only builds visible slots", () => {
    const slots = filmstripSlots(clip("c-one1", 0, 100), { every: 1, count: 100 }, 50, 50, { from: 1000, to: 1200 });
    expect(slots[0]!.x).toBe(1000);
    expect(slots.length).toBe(4);
  });
  it("resamples peaks to the clip span", () => {
    const peaks = [0, 0.5, 1, 0.25, 0, 0, 0, 0];
    expect(peaksForClip(peaks, 2, clip("c-one1", 0, 1, { in: 0.5 }), 2)).toEqual([0.5, 1]);
  });
});

describe("shuttle", () => {
  it("speeds up, reverses and stops", () => {
    expect(shuttle(0, "l")).toBe(1);
    expect(shuttle(1, "l")).toBe(2);
    expect(shuttle(4, "l")).toBe(4);
    expect(shuttle(2, "j")).toBe(-1);
    expect(shuttle(-1, "j")).toBe(-2);
    expect(shuttle(-4, "j")).toBe(-4);
    expect(shuttle(-2, "l")).toBe(1);
    expect(shuttle(3, "k")).toBe(0);
  });
});

describe("merging concurrent edits", () => {
  const base: VideoTimeline = { ...emptyTimeline("landscape"), tracks: [
    { id: "t-vvvv", kind: "video", clips: [clip("c-one1", 0, 2), clip("c-two2", 2, 2)] },
    { id: "t-xxxx", kind: "text", clips: [{ id: "c-txt1", start: 0, duration: 1, text: "hi" }] },
  ] };
  const edit = (t: VideoTimeline, fn: (t: VideoTimeline) => void) => { const c = JSON.parse(JSON.stringify(t)) as VideoTimeline; fn(c); return c; };
  it("keeps my move and their new clip", () => {
    const mine = edit(base, t => { t.tracks[0]!.clips[1]!.start = 5; });
    const theirs = edit(base, t => { t.tracks[1]!.clips.push({ id: "c-txt2", start: 3, duration: 1, text: "bos" }); });
    const merged = validateTimeline(mergeTimelines(base, mine, theirs), media);
    expect(merged.tracks[0]!.clips.find(c => c.id === "c-two2")!.start).toBe(5);
    expect(merged.tracks[1]!.clips.map(c => c.id)).toEqual(["c-txt1", "c-txt2"]);
  });
  it("lets theirs win when we both changed one clip", () => {
    const mine = edit(base, t => { t.tracks[1]!.clips[0]!.text = "mine"; });
    const theirs = edit(base, t => { t.tracks[1]!.clips[0]!.text = "theirs"; });
    expect(mergeTimelines(base, mine, theirs).tracks[1]!.clips[0]!.text).toBe("theirs");
  });
  it("applies my deletes and additions, and my format change", () => {
    const mine = edit(base, t => { t.tracks[0]!.clips.splice(0, 1); t.tracks[1]!.clips.push({ id: "c-new1", start: 4, duration: 1, text: "x" }); t.fps = 25; });
    const theirs = edit(base, t => { t.background = "#112233"; });
    const merged = mergeTimelines(base, mine, theirs);
    expect(merged.tracks[0]!.clips.map(c => c.id)).toEqual(["c-two2"]);
    expect(merged.tracks[1]!.clips.map(c => c.id)).toEqual(["c-txt1", "c-new1"]);
    expect(merged.fps).toBe(25);
    expect(merged.background).toBe("#112233");
  });
  it("moves a clip across tracks and keeps a track I added", () => {
    const mine = edit(base, t => { t.tracks.push({ id: "t-nnnn", kind: "video", clips: [] }); const c = t.tracks[0]!.clips.pop()!; t.tracks[2]!.clips.push(c); });
    const merged = mergeTimelines(base, mine, base);
    expect(merged.tracks.map(t => t.id)).toEqual(["t-vvvv", "t-xxxx", "t-nnnn"]);
    expect(merged.tracks[2]!.clips.map(c => c.id)).toEqual(["c-two2"]);
  });
  it("names what changed", () => {
    const after = edit(base, t => { t.tracks[0]!.clips[0]!.duration = 1; t.tracks[1]!.clips.push({ id: "c-txt9", start: 5, duration: 1, text: "y" }); });
    expect(changedClipIds(base, after).sort()).toEqual(["c-one1", "c-txt9"]);
  });
});
