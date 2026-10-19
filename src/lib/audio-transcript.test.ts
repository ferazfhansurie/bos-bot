import { describe, expect, it } from "vitest";
import { matchingTranscript, parseAudioTranscript } from "./audio-transcript";

describe("actual audio transcript timings", () => {
  it("reads supplied VTT and SRT segment timestamps without estimating words", () => {
    expect(parseAudioTranscript("WEBVTT\n\n00:00.250 --> 00:02.100\nhello there\n\n00:03.000 --> 00:04.000\nnext thought", true).segments).toEqual([
      { start: 0.25, end: 2.1, text: "hello there" }, { start: 3, end: 4, text: "next thought" },
    ]);
    expect(parseAudioTranscript("1\r\n00:01:02,100 --> 00:01:03,300\r\nsecond minute", true).segments[0]).toEqual({ start: 62.1, end: 63.3, text: "second minute" });
  });
  it("keeps plain/invalid transcript text readable with no fake seek targets", () => {
    expect(parseAudioTranscript("hello world", false)).toEqual({ text: "hello world", segments: [] });
    const bad = "00:60.000 --> 00:61.000\ninvalid time";
    expect(parseAudioTranscript(bad, true)).toEqual({ text: bad, segments: [] });
    expect(parseAudioTranscript("00:02.000 --> 00:01.000\nbackward", true).segments).toEqual([]);
    expect(parseAudioTranscript("<script>alert(1)</script>", false).text).toContain("<script>");
  });
  it("pairs an exact transcript name and refuses ambiguous candidates", () => {
    const audio = { name: "Memo.wav" };
    expect(matchingTranscript(audio, [{ name: "memo.txt" }, { name: "memo.vtt" }])?.name).toBe("memo.vtt");
    expect(matchingTranscript(audio, [{ name: "other.vtt" }])).toBeUndefined();
    expect(matchingTranscript(audio, [{ name: "memo.vtt" }, { name: "Memo.vtt" }])).toBeUndefined();
  });
});
