import { createHash, randomUUID } from "node:crypto";

// Main owns registration: renderer strings never select arbitrary Electron
// sessions. Profiles isolate cookies/storage by bot + thread workspace.
export function workspaceBrowserPartition(workspaceId) {
  if (typeof workspaceId !== "string" || !workspaceId || workspaceId.length > 4096) {
    throw new Error("Invalid browser workspace");
  }
  return `persist:bos-workspace-browser-${createHash("sha256").update(workspaceId).digest("hex")}`;
}

export function createWorkspaceBrowserRegistry({ notify = () => {}, limit = 100, now = Date.now, onDownload = () => {} } = {}) {
  const partitions = new Set();
  const guests = new Map();
  const downloads = new Map();
  return {
    register(workspaceId) {
      const partition = workspaceBrowserPartition(workspaceId);
      partitions.add(partition);
      return partition;
    },
    has(partition) { return partitions.has(partition); },
    attach(guest, partition) {
      guests.set(guest.id, partition);
      guest.once("destroyed", () => guests.delete(guest.id));
    },
    source(guest) {
      const partition = guests.get(guest.id);
      return partition ? { guestId: guest.id, partition } : null;
    },
    list(partition) {
      if (!partitions.has(partition)) throw new Error("Unknown browser workspace");
      return (downloads.get(partition) ?? []).map((entry) => ({ ...entry }));
    },
    trackDownload(partition, event, item, guest) {
      // Session events can include unknown/destroyed sources: fail closed.
      if (!guest || guests.get(guest.id) !== partition) { event.preventDefault(); return; }
      const row = {
        id: randomUUID(), partition, guestId: guest.id,
        fileName: String(item.getFilename()).slice(0, 1024),
        url: String(item.getURL()).slice(0, 8192),
        receivedBytes: item.getReceivedBytes(), totalBytes: item.getTotalBytes(),
        state: "progressing", startedAt: now(),
      };
      const entries = downloads.get(partition) ?? [];
      entries.unshift(row);
      entries.splice(limit);
      downloads.set(partition, entries);
      const emit = () => { onDownload(partition, { ...row }, item.getSavePath?.()); notify({ ...row }); };
      emit();
      item.on("updated", (_event, state) => {
        row.state = state;
        row.receivedBytes = item.getReceivedBytes();
        row.totalBytes = item.getTotalBytes();
        emit();
      });
      item.once("done", (_event, state) => {
        row.state = state; row.completedAt = now();
        row.receivedBytes = item.getReceivedBytes();
        emit();
      });
    },
  };
}
