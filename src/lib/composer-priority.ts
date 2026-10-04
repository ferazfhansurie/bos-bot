/** How a send made while a turn is running should land: "queue" waits
 * behind the current turn (today's behavior), "block" interrupts it and
 * runs now. Idle sends always start right away, so priority only matters
 * while the conversation is busy. */
export type SendPriority = "block" | "queue";

/** The queue/block toggle only appears where queueing can actually happen:
 * a live, unlocked, own (not shared) conversation with no approval waiting. */
export function composerPriorityVisible({
  busy,
  locked,
  shared,
  approvalPending,
}: {
  busy: boolean;
  locked: boolean;
  shared: boolean;
  approvalPending: boolean;
}): boolean {
  return busy && !locked && !shared && !approvalPending;
}

/** The priority a send actually carries: a "block" chosen while busy only
 * counts while the toggle is still on screen. If the turn ended before the
 * send, there is nothing to interrupt and the send is an ordinary one. */
export function effectiveSendPriority(chosen: SendPriority, visible: boolean): SendPriority {
  return visible && chosen === "block" ? "block" : "queue";
}

/** Adds `priority` to a message POST body only when it is "block". Queue is
 * the server default, so omitting it keeps older servers byte-identical. */
export function withSendPriority<T extends object>(
  body: T,
  priority: SendPriority | undefined,
): T & { priority?: "block" } {
  return priority === "block" ? { ...body, priority } : body;
}
