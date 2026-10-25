/** The notification wire shape — what the harness decides is worth
 * interrupting someone for, emitted as the `notify` live frame. Single home
 * in shared/ so the server emitter and the client banner stack agree;
 * server/notify.ts re-exports under the historical name. */
export type NotifyKind =
  | "approval"
  | "question"
  | "done"
  | "routine-failed"
  | "routine-deferred"
  | "turn-failed"
  /** A run failed, stalled or could not start and no Chief of Staff was
   * there to take it: the person is the one who has to look. */
  | "incident"
  | "takeover"
  /** A turn started from a live voice call settled. Sent whatever the
   * bot's notifications switch says: the caller may have hung up. */
  | "voice_work_done"
  /** The daily summary (digest.hour). Not from one bot: botId, botName and
   * threadId are empty; clients open needs-me. */
  | "digest";

export interface Notification {
  kind: NotifyKind;
  botId: string;
  botName: string;
  threadId: string;
  title: string;
  body: string;
  /** The bot's stored profile image, when it has one; clients show it as
   * the OS notification's icon so every banner carries its bot's face. */
  avatarUrl?: string;
  /** The room this came out of, when the bot was speaking in one. Routing
   * already works off `threadId` alone; this is what lets a client say which
   * room, and stack a room's banners together instead of under the bot. */
  groupId?: string;
  /** Immutable request/card identities for exact notification navigation.
   * Omitted for non-request notices and legacy producers. */
  requestId?: string;
  messageId?: string;
  /** voice_work_done: the call the finished work was asked for on, so a
   * phone still on that call can stay quiet (the call already says it). */
  callId?: string;
}

/** One identity per thing to look at, so a re-sent frame never re-banners,
 * an answered card can take its banner down, and a browser push and the open
 * page's own banner for the same event replace each other instead of stacking. */
export function attentionId(frame: { kind?: string; threadId?: string; requestId?: string; messageId?: string; body: string }): string {
  if (frame.requestId) return `req:${frame.requestId}`;
  if (frame.messageId) return `msg:${frame.messageId}`;
  return `${frame.kind ?? "message"}:${frame.threadId ?? ""}:${frame.body.slice(0, 120)}`;
}
