import { expect, it, vi } from "vitest";
import { SharedUploadCache } from "./shared-upload-cache";
it("retains successful receipts through a later upload failure and a lost send acknowledgement", async () => {
  const first = { name: "photo.png" }, second = { name: "photo.png" };
  const cache = new SharedUploadCache<typeof first, string>();
  const upload = vi.fn().mockResolvedValueOnce("attachment-one").mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce("attachment-two");
  await expect(cache.collect([first, second], upload)).rejects.toThrow("offline");
  expect(await cache.collect([first, second], upload)).toEqual(["attachment-one", "attachment-two"]);
  expect(upload.mock.calls.map(call => call[0])).toEqual([first, second, second]);
  expect(await cache.collect([first, second], upload)).toEqual(["attachment-one", "attachment-two"]);
  expect(upload).toHaveBeenCalledTimes(3);
});
it("does not reuse one room send's receipt in another send", async () => {
  const file = { name: "same.txt" };
  const a = new SharedUploadCache<typeof file, string>();
  const b = new SharedUploadCache<typeof file, string>();
  expect(await a.collect([file], async () => "room-a-file")).toEqual(["room-a-file"]);
  expect(await b.collect([file], async () => "room-b-file")).toEqual(["room-b-file"]);
});
