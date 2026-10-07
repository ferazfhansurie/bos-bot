import { describe, expect, it } from "vitest";

import { base64ToBytes, bytesToBase64, floatToPcm16, floatToPcm16Base64, pcm16Base64ToFloat32 } from "./pcm";

const int16 = (bytes: Uint8Array) => Array.from(new Int16Array(bytes.buffer, bytes.byteOffset, bytes.length / 2));

describe("pcm16", () => {
  it("scales negatives by 32768 and positives by 32767", () => {
    expect(int16(floatToPcm16(new Float32Array([0, 1, -1, 0.5, -0.5])))).toEqual([0, 32767, -32768, 16383, -16384]);
  });

  it("clamps out-of-range samples", () => {
    expect(int16(floatToPcm16(new Float32Array([2, -3])))).toEqual([32767, -32768]);
  });

  it("writes little-endian bytes", () => {
    expect(Array.from(floatToPcm16(new Float32Array([1])))).toEqual([0xff, 0x7f]);
  });

  it("round-trips through base64 within one LSB", () => {
    const input = new Float32Array([0, 0.25, -0.25, 0.999, -1]);
    const output = pcm16Base64ToFloat32(floatToPcm16Base64(input));
    expect(output).toHaveLength(input.length);
    output.forEach((v, i) => expect(Math.abs(v - input[i])).toBeLessThan(1 / 16384));
    expect(output[4]).toBe(-1);
  });

  it("decodes by dividing by 32768 and drops an odd trailing byte", () => {
    const b64 = bytesToBase64(new Uint8Array([0x00, 0x40, 0x00, 0xc0, 0x7f]));
    expect(Array.from(pcm16Base64ToFloat32(b64))).toEqual([0.5, -0.5]);
  });

  it("base64 survives a frame larger than one encode chunk", () => {
    const bytes = new Uint8Array(70_000).map((_, i) => i % 251);
    expect(Array.from(base64ToBytes(bytesToBase64(bytes)))).toEqual(Array.from(bytes));
  });

  it("encodes a 2048-sample frame to 4096 bytes", () => {
    expect(base64ToBytes(floatToPcm16Base64(new Float32Array(2048))).length).toBe(4096);
  });
});
