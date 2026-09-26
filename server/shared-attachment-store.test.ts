import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { SharedAttachmentStore } from "./shared-attachment-store.ts";

it("allows known media, corrects the extension and rejects executable or spoofed data", () => {
  const dir = mkdtempSync(join(tmpdir(), "bos-shared-attachment-"));
  try {
    const store = new SharedAttachmentStore(dir);
    const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from("test")]);
    const saved = store.save("room-1", "home:person:owner", "photo.exe", "image/png", png.toString("base64"));
    expect(saved.name).toBe("photo.png");
    expect(store.owns("room-1", "home:person:owner", saved)).toBe(true);
    expect(() => store.save("room-1", "home:person:owner", "script.sh", "application/octet-stream", Buffer.from("hi").toString("base64"))).toThrow("invalid shared attachment");
    expect(() => store.save("room-1", "home:person:owner", "fake.png", "image/png", Buffer.from("MZ executable").toString("base64"))).toThrow("do not match");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
