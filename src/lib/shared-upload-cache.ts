/** Keep successful upload receipts for a send. Retry a partially uploaded
 * send from its first missing file; a lost message acknowledgement reuses every
 * attachment id. File objects use identity so equal filenames remain distinct. */
export class SharedUploadCache<FileValue extends object, Receipt> {
  private readonly uploads = new WeakMap<FileValue, Receipt>();
  async collect(files: readonly FileValue[], upload: (file: FileValue) => Promise<Receipt>): Promise<Receipt[]> {
    const result: Receipt[] = [];
    for (const file of files) {
      let receipt = this.uploads.get(file);
      if (receipt === undefined) {
        receipt = await upload(file);
        this.uploads.set(file, receipt);
      }
      result.push(receipt);
    }
    return result;
  }
}

// File keys are weak, so abandoned drafts can release their payloads. Each
// actor/room scope has separate receipts; no cross-room reuse is possible.
const roomUploads = new Map<string, SharedUploadCache<File, unknown>>();
export function sharedRoomUploads<Receipt>(scope: string): SharedUploadCache<File, Receipt> {
  let cache = roomUploads.get(scope);
  if (!cache) { cache = new SharedUploadCache(); roomUploads.set(scope, cache); }
  return cache as SharedUploadCache<File, Receipt>;
}
