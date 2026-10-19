# Imported voice memos

Launch the disposable full-app fixture:

```sh
node --experimental-strip-types scripts/control-omb.ts ui launch --entry voice-memos
```

The entry uploads two generated five-second WAVs, a WebVTT transcript and a plain-text transcript through the real private upload route, then sends their attachment markers into Pepper's fixture thread. No microphone, personal files, real provider or external transcription service is used.

With the printed explicit `--ui` handle:

1. Initially there are two voice-memo cards and no audio elements or fetched audio. Load the first memo. The authorized WAV should decode to five seconds; playback begins only with the native play control.
2. Change playback speed to 1.5× and read back the audio element's `playbackRate`. Open its transcript and select **second thought**. `currentTime` must become 2 seconds, from the supplied WebVTT cue. Actual playback must advance with no media error.
3. Open the second memo's transcript. The untimed text appears, with no seek buttons. No timestamps are estimated.
4. Close the audio preview. Its element disappears and the blob URL is revoked. Reloading the fixture will seed a new fixture-only turn, so use a fresh fixture for reproducible runs.
5. At a narrow viewport, both cards, audio controls, transcript disclosure and speed selection remain inside the transcript width.

Audio and transcript loads are explicit, abortable and bound to the exact message's authorized file route. Preview requires an accepted server MIME and enforces a streaming 25 MB audio / 256 KB transcript cap even without Content-Length. Denied files never fall back to direct host URLs. Pairing requires a unique, same-basename `.vtt`, `.srt` or `.txt` attachment in the same gallery (timed formats take precedence). WebVTT/SRT seek by real cue/segment timestamps only; plain or malformed transcripts remain readable without seek controls. Dictation remains plain-text dictation; this feature does not record audio or fabricate word alignment.

```sh
pnpm exec vitest run src/lib/audio-transcript.test.ts src/components/AudioAttachment.test.ts src/components/AttachmentGallery.test.ts server/message-file.test.ts server/attachments.test.ts src/lib/composer-attachments.test.ts
pnpm typecheck
```
