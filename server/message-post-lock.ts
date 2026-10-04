// Receipt mutations for one conversation are serial. Provider execution is
// still asynchronous and different conversations keep independent lanes.
const pending = new Map<string, Promise<void>>();
export async function withMessagePostLock<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = pending.get(key) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>(resolve => { release = resolve; });
  pending.set(key, next);
  await previous;
  try { return await work(); }
  finally { release(); if (pending.get(key) === next) pending.delete(key); }
}
