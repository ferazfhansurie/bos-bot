# File-backed mobile videos

Bot and local group composers accept up to 32 items, 90 MiB per file and 200 MiB total. Images retain their 10 MiB item and 50 MiB memory budget. Buffered shared-room/share-extension files retain 25 MiB; these are a separate protocol. Recognized videos under the larger limit keep their original bytes. Larger videos still export to fit; resumable uploads above this limit remain future work.

Picker/provider videos and documents are copied in 1 MiB chunks into an owned temporary file. Durable drafts copy payloads before atomically publishing the manifest and retain stable attachment/send UUIDs through restoration. Restored file-backed drafts keep an owned snapshot, so an edited manifest cannot delete the captured payload during an upload retry. Temporary import copies are removed when their last reference dies; partial copies are removed on failure. Startup clears abandoned import/download files after a crash; durable draft payloads stay separate.

The client uploads files through URLSession's file API. Download previews stream to disk, cancel when reported or received bytes exceed 90 MiB, preserve authorization errors, and reject previews from a switched home. Text previews read only the first 2 MiB. Server upload and message download ceilings agree; authorization, MIME allowlists, attachment UUID conflict detection and global disk quota remain in force. The raw request ceiling stays below Cloudflare's common 100 MB body limit. This is not an unlimited upload claim.

Checks on 2026-10-11:

- 57 focused Swift attachment/draft/shared-delivery/retry tests pass, including a 30 MiB file-backed draft surviving source deletion and restart with the same send ID, oversized copy cleanup, bounded download rejection and revoked-device errors.
- 58 server attachment, message-file and proxy-upload tests pass. Server typecheck passes.
- An isolated fake-engine server accepted a playable 64 MiB synthetic MP4 (201), accepted its message (202), and independently downloaded it through the originating message (200). Upload, stored file and download SHA-256 matched; ffmpeg decoded the file without errors.
- The real CompanionClient uploaded that same 64 MiB file with the existing UUID and downloaded it using its bounded disk path. The returned in-memory Data was empty and chunked SHA-256 matched.
- A separate review pass checked draft ownership during edits/retries, cleanup after failures and crashes, authorization failures, file bounds and home switching. It found and corrected buffered/file-backed limit mismatch, abandoned temporary files and uncancelled exports.

Phone build and installation are separate from these fixtures. Real upload acceptance over the owner's hosted route still requires the physical phone test. Shared-room large uploads, files above 90 MiB, byte-level upload progress and awake-state lag remain separate work.
