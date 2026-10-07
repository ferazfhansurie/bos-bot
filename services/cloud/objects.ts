import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { AttachmentKeySchema } from '../../shared/cloud-protocol/index.ts';
/** Local-only quarantine store. Object keys are generated IDs; never user filenames. */
export class LocalObjects {
    root: string;
    scan: (bytes: Buffer, type: string) => Promise<'clean' | 'rejected'>;
    constructor(root: string, scan?: (bytes: Buffer, type: string) => Promise<'clean' | 'rejected'>) {
        this.root = resolve(root);
        // A missing/unavailable scanner cannot confer ready status.
        this.scan = scan ?? (async () => { throw new Error('attachment scanner unavailable'); });
    }
    path(key: string) { return resolve(this.root, AttachmentKeySchema.parse(key)); }
    async put(key: string, bytes: Buffer) { await mkdir(this.root, { recursive: true, mode: 0o700 }); await writeFile(this.path(key), bytes, { mode: 0o600, flag: 'wx' }); }
    async get(key: string) { return readFile(this.path(key)); }
    async remove(key: string) { await rm(this.path(key), { force: true }); }
}
