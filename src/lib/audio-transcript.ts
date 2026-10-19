export interface TranscriptSegment { start: number; end: number; text: string }
export interface AudioTranscript { text: string; segments: TranscriptSegment[] }
export const TRANSCRIPT_MAX_BYTES = 256_000;

function seconds(value: string): number | undefined {
  const match = /^(?:(\d{1,3}):)?(\d{2}):(\d{2})[.,](\d{3})$/.exec(value);
  if (!match || Number(match[2]) > 59 || Number(match[3]) > 59) return undefined;
  return Number(match[1] ?? 0) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1000;
}

/** Timestamps must come from the supplied VTT/SRT. Plain text has no seeking. */
export function parseAudioTranscript(source: string, timed: boolean): AudioTranscript {
  const input = source.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  if (!timed) return { text: input.trim(), segments: [] };
  const segments: TranscriptSegment[] = [];
  for (const block of input.split(/\n\s*\n/)) {
    const lines = block.split("\n");
    const timing = lines.findIndex(line => line.includes(" --> "));
    if (timing < 0) continue;
    const match = /^(\S+)\s+-->\s+(\S+)(?:\s.*)?$/.exec(lines[timing].trim());
    if (!match) continue;
    const start = seconds(match[1]), end = seconds(match[2]);
    const text = lines.slice(timing + 1).join("\n").replace(/<[^>]*>/g, "").trim();
    if (start === undefined || end === undefined || end <= start || !text || segments.length >= 2000) continue;
    segments.push({ start, end, text });
  }
  return segments.length ? { text: segments.map(c => c.text).join("\n"), segments } : { text: input.trim(), segments: [] };
}

export const isAudioFilename = (path: string) => /\.(?:mp3|m4a|aac|wav|flac|ogg|opus)$/i.test(path);
export function matchingTranscript<T extends { name: string }>(audio: T, files: T[]): T | undefined {
  const stem = audio.name.replace(/\.[^.]+$/, "").toLowerCase();
  for (const extension of ["vtt", "srt", "txt"]) {
    const matches = files.filter(file => file.name.toLowerCase() === `${stem}.${extension}`);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) return undefined;
  }
  return undefined;
}
