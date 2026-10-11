// Opt-in, connection-local task deltas. A fresh stream always starts with a
// full task list, including replay, so reconnect never depends on old state.
export function createTaskDeltas() {
  const cache = new Map<string, Map<string, string>>();
  return (value: unknown): unknown => {
    if (!value || typeof value !== 'object') return value;
    const frame = value as Record<string, any>;
    if (frame.kind === 'bot.deleted') cache.delete(frame.botId);
    if (frame.kind !== 'bot' || !frame.bot || typeof frame.bot.id !== 'string') return value;
    const bot = frame.bot;
    if (!Array.isArray(bot.tasks)) { cache.delete(bot.id); return value; }
    const next = new Map<string, string>();
    for (const task of bot.tasks) {
      if (!task || typeof task.threadId !== 'string' || next.has(task.threadId)) {
        cache.delete(bot.id); return value;
      }
      next.set(task.threadId, JSON.stringify(task));
    }
    const previous = cache.get(bot.id);
    // Bound retained snapshots; eviction simply makes the next frame full.
    cache.delete(bot.id);
    cache.set(bot.id, next);
    while (cache.size > 16 || [...cache.values()].reduce((total, tasks) => total + [...tasks.values()].reduce((n, text) => n + text.length * 2, 0), 0) > 8 * 1024 * 1024) {
      cache.delete(cache.keys().next().value!);
    }
    if (!previous) return value;
    const changed = bot.tasks.filter((task: { threadId: string }) => previous.get(task.threadId) !== next.get(task.threadId));
    return { ...frame, bot: { ...bot, tasks: changed, taskOrder: [...next.keys()] } };
  };
}
