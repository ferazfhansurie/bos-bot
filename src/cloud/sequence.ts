// Room event sequences are decimal strings; never compare them as numbers.
export type Sequence = string;

const DECIMAL = /^(0|[1-9][0-9]*)$/;

export function isSequence(value: unknown): value is Sequence {
  return typeof value === "string" && DECIMAL.test(value);
}

/** Compare two decimal-string sequences without losing precision. */
export function compareSequence(a: Sequence, b: Sequence): number {
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function maxSequence(a: Sequence | null, b: Sequence | null): Sequence | null {
  if (a === null) return b;
  if (b === null) return a;
  return compareSequence(a, b) >= 0 ? a : b;
}
