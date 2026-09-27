/** Draft text is never transmitted. Presence expires even after a crash. */
export class SharedTyping {
  private entries = new Map<string, { room: string; actor: string; until: number }>();
  update(room: string, actor: string, active: boolean, now = Date.now()) {
    this.prune(now);
    const key = `${room}/${actor}`;
    if (!active) this.entries.delete(key);
    else if (this.entries.has(key) || this.entries.size < 1024) this.entries.set(key, { room, actor, until: now + 6000 });
  }
  list(room: string, viewer: string, members: string[], now = Date.now()): string[] {
    this.prune(now);
    return [...this.entries.values()].filter(item => item.room === room && item.actor !== viewer && members.includes(item.actor)).map(item => item.actor);
  }
  private prune(now: number) { for (const [key, item] of this.entries) if (item.until <= now) this.entries.delete(key); }
}
