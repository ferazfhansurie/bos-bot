import { afterEach, describe, expect, it, vi } from "vitest";
import { saveProfileField, saveProfilePhoto, prepareProfilePhoto } from "./profile-photo";

describe("profile persistence", () => {
  it("saves only the edited field, leaving the current photo and other fields to the server merge", async () => {
    const request = vi.fn().mockResolvedValue({ profile: { name: "Ada", email: "current@example.com", avatarUrl: "/api/attachments/photo.jpg" } });
    await saveProfileField("name", " Ada ", request);
    expect(request.mock.calls[0]).toEqual(["/api/config", { method: "PUT", body: JSON.stringify({ profile: { name: "Ada" } }) }]);
    await saveProfileField("email", " ADA@EXAMPLE.COM ", request);
    expect(JSON.parse(request.mock.calls[1]![1].body).profile).toEqual({ email: "ada@example.com" });
  });
  it("removes only the profile photo using the existing scoped route, naming the photo it replaces", async () => {
    const request = vi.fn(async (path: string) => path === "/api/config" ? { profile: { avatarUrl: "/api/attachments/mine.jpg" } } : { avatarUrl: "" });
    expect(await saveProfilePhoto(null, request)).toBe("");
    expect(request.mock.calls[1]).toEqual(["/api/multiplayer/profile-photo", { method: "PUT", body: '{"photo":null,"expected":"/api/attachments/mine.jpg"}' }]);
  });
  it("names an empty photo when the owner has none yet", async () => {
    const request = vi.fn(async (path: string, _init?: RequestInit) => path === "/api/config" ? { profile: { name: "Ada" } } : { avatarUrl: "/api/attachments/new.jpg" });
    expect(await saveProfilePhoto("/9j/AA==", request)).toBe("/api/attachments/new.jpg");
    expect(JSON.parse(request.mock.calls[1]![1]!.body as string)).toEqual({ photo: "/9j/AA==", expected: "" });
  });
  it("propagates save failure instead of replacing the current avatar", async () => {
    const request = vi.fn().mockRejectedValue(new Error("offline"));
    await expect(saveProfilePhoto("jpeg", request)).rejects.toThrow("offline");
  });
  it("rejects invalid saved avatar paths", async () => {
    await expect(saveProfilePhoto("jpeg", vi.fn().mockResolvedValue({ profile: {}, avatarUrl: "https://tracking.invalid/a.jpg" }))).rejects.toThrow("saved profile photo");
  });
});
describe("profile image preparation", () => {
  afterEach(() => vi.unstubAllGlobals());
  function imageEnvironment(fail = false) {
    const revoke = vi.fn();
    const draw = vi.fn();
    const canvas = { width: 0, height: 0, getContext: () => ({ fillStyle: "", fillRect: vi.fn(), drawImage: draw }), toDataURL: vi.fn(() => "data:image/jpeg;base64,/9j/AA==") };
    vi.stubGlobal("URL", { createObjectURL: () => "blob:photo", revokeObjectURL: revoke });
    vi.stubGlobal("Image", class {
      naturalWidth = 2048;
      naturalHeight = 1024;
      onload?: () => void;
      onerror?: () => void;
      set src(_value: string) { queueMicrotask(() => fail ? this.onerror?.() : this.onload?.()); }
    });
    vi.stubGlobal("document", { createElement: () => canvas });
    return { revoke, draw, canvas };
  }
  it("bounds JPEG dimensions and releases the temporary preview URL", async () => {
    const { revoke, draw, canvas } = imageEnvironment();
    const photo = await prepareProfilePhoto(new File(["raster"], "x.png", { type: "image/png" }));
    expect(photo).toBe("/9j/AA==");
    expect([canvas.width, canvas.height]).toEqual([512, 256]);
    expect(draw).toHaveBeenCalledOnce();
    expect(canvas.toDataURL).toHaveBeenCalledWith("image/jpeg", 0.85);
    expect(revoke).toHaveBeenCalledWith("blob:photo");
  });
  it("decode failure leaves no temporary URL and never saves", async () => {
    const { revoke, draw } = imageEnvironment(true);
    await expect(prepareProfilePhoto(new File(["bad"], "x.png", { type: "image/png" }))).rejects.toThrow("decoded");
    expect(draw).not.toHaveBeenCalled();
    expect(revoke).toHaveBeenCalledWith("blob:photo");
  });
  it("rejects unsupported files before decoding or uploading", async () => {
    await expect(prepareProfilePhoto(new File(["svg"], "x.svg", { type: "image/svg+xml" }))).rejects.toThrow("PNG");
  });
  it("rejects oversized images before decoding", async () => {
    await expect(prepareProfilePhoto(new File([new Uint8Array(10 * 1024 * 1024 + 1)], "x.png", { type: "image/png" }))).rejects.toThrow("10 MB");
  });
});
