import { describe, expect, it, vi } from "vitest";
import { sendProductFeedback, confirmUsefulResult, shareReferral } from "./product-feedback";

describe("explicit product feedback", () => {
  it("sends nothing before consent or with an empty written note", async () => {
    const request = vi.fn();
    await expect(sendProductFeedback({ text: "private note", consent: false }, request)).rejects.toThrow("Choose to share");
    await expect(sendProductFeedback({ text: "  ", consent: true }, request)).rejects.toThrow("Write a note");
    expect(request).not.toHaveBeenCalled();
  });
  it("sends only the opted-in rating, without transcript or message identity", async () => {
    const request = vi.fn().mockResolvedValue({ ok: true });
    await sendProductFeedback({ text: "", rating: "down", consent: true }, request);
    expect(request).toHaveBeenCalledExactlyOnceWith("/api/product/feedback", { method: "POST", body: JSON.stringify({ text: "", rating: "down" }) });
  });
  it("trims a volunteered note and keeps delivery errors available to the UI", async () => {
    const request = vi.fn().mockRejectedValue(new Error("offline"));
    await expect(sendProductFeedback({ text: "  improve export  ", consent: true }, request)).rejects.toThrow("offline");
    expect(JSON.parse(request.mock.calls[0][1].body)).toEqual({ text: "improve export" });
  });
  it("requires a separate useful-result confirmation", async () => {
    const request = vi.fn().mockResolvedValue({ ok: true });
    await expect(confirmUsefulResult(false, request)).rejects.toThrow("Confirm");
    expect(request).not.toHaveBeenCalled();
    await confirmUsefulResult(true, request);
    expect(request).toHaveBeenCalledExactlyOnceWith("/api/product/job-done", { method: "POST", body: JSON.stringify({ confirmed: true }) });
  });
});

describe("invite sharing", () => {
  it("uses native sharing when available and never copies after cancellation", async () => {
    const writeText = vi.fn();
    const share = vi.fn().mockRejectedValue(new Error("cancelled"));
    await expect(shareReferral("https://bosbot.my/get?ref=fixture", { share, clipboard: { writeText } })).rejects.toThrow("cancelled");
    expect(writeText).not.toHaveBeenCalled();
  });
  it("copies the canonical referral URL when sharing is unavailable", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    expect(await shareReferral("https://bosbot.my/get?ref=fixture", { clipboard: { writeText } })).toBe("copied");
    expect(writeText).toHaveBeenCalledWith("https://bosbot.my/get?ref=fixture");
  });
});
