import { describe, expect, it } from "vitest";
import { formatElapsed, isAppleWebKit, micProblem, micSettingsPlace, pickRecordingMime, recordingFileType, voiceRecordingSupported } from "./voice-recorder";

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1";
const MAC_SAFARI = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15";
const CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const IOS_CHROME = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0 Mobile/15E148 Safari/604.1";

describe("browser voice recording", () => {
  it("prefers AAC in mp4 on Apple WebKit, including Chrome on iPhone", () => {
    const supports = (mime: string) => ["audio/mp4", "audio/webm;codecs=opus", "audio/webm"].includes(mime);
    expect(pickRecordingMime(supports, IPHONE)).toBe("audio/mp4");
    expect(pickRecordingMime(supports, IOS_CHROME)).toBe("audio/mp4");
    expect(pickRecordingMime(supports, MAC_SAFARI)).toBe("audio/mp4");
    expect(pickRecordingMime(supports, CHROME)).toBe("audio/webm;codecs=opus");
    expect(pickRecordingMime(() => false, CHROME)).toBe("");
    expect(pickRecordingMime(() => { throw new Error("old"); }, CHROME)).toBe("");
  });

  it("uploads as a mime and extension the server accepts", () => {
    expect(recordingFileType("audio/mp4;codecs=mp4a.40.2")).toEqual({ mime: "audio/mp4", extension: "m4a" });
    expect(recordingFileType("audio/webm;codecs=opus")).toEqual({ mime: "audio/webm", extension: "webm" });
    expect(recordingFileType("audio/ogg;codecs=opus")).toEqual({ mime: "audio/ogg", extension: "ogg" });
    expect(recordingFileType("")).toEqual({ mime: "audio/webm", extension: "webm" });
  });

  it("tells chrome from safari", () => {
    expect(isAppleWebKit(CHROME)).toBe(false);
    expect(micSettingsPlace(IPHONE)).toBe("ios");
    expect(micSettingsPlace(MAC_SAFARI)).toBe("safari");
    expect(micSettingsPlace(CHROME)).toBe("chrome");
  });

  it("names why the microphone would not open", () => {
    expect(micProblem({ name: "NotAllowedError" })).toBe("denied");
    expect(micProblem({ name: "NotFoundError" })).toBe("missing");
    expect(micProblem({ name: "NotReadableError" })).toBe("busy");
    expect(micProblem(new Error("x"))).toBe("other");
    expect(micProblem({ name: "NotAllowedError" }, false)).toBe("insecure");
  });

  it("needs MediaRecorder and getUserMedia", () => {
    expect(voiceRecordingSupported({ MediaRecorder: function MediaRecorder() {}, navigator: { mediaDevices: { getUserMedia: () => {} } } as never })).toBe(true);
    expect(voiceRecordingSupported({ navigator: { mediaDevices: { getUserMedia: () => {} } } as never })).toBe(false);
    expect(voiceRecordingSupported({ MediaRecorder: function MediaRecorder() {}, navigator: {} as never })).toBe(false);
  });

  it("formats elapsed time", () => {
    expect(formatElapsed(0)).toBe("0:00");
    expect(formatElapsed(65_400)).toBe("1:05");
  });
});
