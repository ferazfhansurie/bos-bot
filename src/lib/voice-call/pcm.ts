// PCM16 <-> Float32 and base64, exactly as Grok Bot's capture path does it:
// clamp to [-1, 1], negatives scale by 32768 and positives by 32767, little
// endian on the wire, and decoding divides by 32768.

export function floatToPcm16(samples: Float32Array): Uint8Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    out[i] = s < 0 ? s * 32768 : s * 32767;
  }
  // Int16Array is platform-endian; every platform Electron ships on is LE.
  return new Uint8Array(out.buffer);
}

const CHUNK = 0x8000;

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** base64 PCM16 LE -> Float32 in [-1, 1). An odd trailing byte is dropped. */
export function pcm16Base64ToFloat32(base64: string): Float32Array {
  const bytes = base64ToBytes(base64);
  const count = bytes.length >> 1;
  const view = new DataView(bytes.buffer, bytes.byteOffset, count * 2);
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) out[i] = view.getInt16(i * 2, true) / 32768;
  return out;
}

export function floatToPcm16Base64(samples: Float32Array): string {
  return bytesToBase64(floatToPcm16(samples));
}
