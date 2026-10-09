// Notifications — what is worth interrupting someone for.
//
// `BotRecord.notifications` has been a switch in the settings panel that
// nothing read. This is the thing that reads it. The rule it encodes is
// small and deliberate: a bot that is *blocked on you* is worth a buzz, and
// a bot that *finished* is worth one if you asked for it; everything else a
// bot does while it works is not.
//
// A turn that dies before it starts is the first case, not the last: the
// bot is not working, and the fix is usually a setting only a person can
// change, so a retry cannot clear it. A routine failure already buzzed;
// this makes an interactive turn behave the same way.
// A routine parked behind a busy target earns one notice after half an
// hour: from outside the schedule looks broken, and only a person can
// decide whether the busy work or the routine matters more.
//
// Delivery is a separate concern. The harness emits a frame; whoever is
// listening decides what to do with it — desktop and paired-phone local
// notifications today, and closed-app APNs delivery once a relay exists.

import type { PushTarget } from "./apns-push.ts";
import type { Notification, NotifyKind } from "../shared/notification.ts";

// The notification wire shape lives in shared/notification.ts now (part of
// the wire model); re-exported here so existing importers keep working.
export type { Notification, NotifyKind } from "../shared/notification.ts";

/** One line, short enough for a lock screen, with the newlines and code
 * fences of a model's answer flattened out of it. */
export function summarize(text: string, max = 140): string {
  const line = text.replace(/```[\s\S]*?```/g, " ").replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

export interface NotifyBot {
  id: string;
  name: string;
  threadId: string;
  notifications?: boolean;
}

/** The room a bot is holding while it works, as this module needs it. */
export interface NotifyRoom {
  id: string;
  name: string;
  threadId: string;
  busyBotId?: string | null;
}

/** Where a "blocked on you" notification has to open. A bot speaking in a
 * room is not reachable in its own 1:1 thread — the turn, its screen and the
 * card all live in the room — so the room wins while it owns that bot. A
 * room it merely belongs to, or one another member is speaking in, is not
 * where this bot is: those fall back to its own thread. */
export function blockedTarget(
  bot: NotifyBot,
  room?: NotifyRoom | null,
): { threadId: string; group?: { id: string; name: string } } {
  if (!room || room.busyBotId !== bot.id) return { threadId: bot.threadId };
  return { threadId: room.threadId, group: { id: room.id, name: room.name } };
}

/** Build the frame for one event, or null when it should stay quiet.
 *
 * Kept pure and separate from the event fold so the policy — which is the
 * part people will argue about — can be read and tested on its own. */
export function buildNotification(
  kind: NotifyKind,
  bot: NotifyBot,
  threadId: string,
  detail: string,
  extra?: { avatarUrl?: string; group?: { id: string; name: string }; requestId?: string; messageId?: string },
): Notification | null {
  // The toggle means what it says: off is off, including for approvals.
  // A bot whose notifications you turned off can still block waiting for
  // you — that is the choice you made, and the chat still shows the card.
  if (bot.notifications === false) return null;

  const body = summarize(detail);
  // A bot working in a room is not "Scout" to whoever reads the banner — it
  // is Scout, in that room. Name the room or the notification reads as if it
  // came from the 1:1 thread it will not open.
  const who = extra?.group ? `${bot.name} in ${extra.group.name}` : bot.name;
  const title =
    kind === "approval"
      ? `${who} needs approval`
      : kind === "question"
        ? `${who} has a question`
        : kind === "takeover"
          ? `${who} needs your hands`
          : kind === "routine-failed"
            ? `${who}'s routine failed`
            : kind === "routine-deferred"
              ? `${who}'s routine is waiting`
            : kind === "turn-failed"
              ? `${who} couldn't start`
              : kind === "incident"
                ? `${who} hit a problem`
                : `${who} finished`;

  // A "finished" with nothing to say is not worth a notification — the
  // badge in the sidebar already carries that much.
  if (kind === "done" && !body) return null;

  const notification: Notification = { kind, botId: bot.id, botName: bot.name, threadId, title, body };
  if (extra?.avatarUrl) notification.avatarUrl = extra.avatarUrl;
  if (extra?.group) notification.groupId = extra.group.id;
  if (extra?.requestId) notification.requestId = extra.requestId;
  if (extra?.messageId) notification.messageId = extra.messageId;
  return notification;
}

/** The push a caller gets when work they asked for on a live voice call
 * settles. Unlike every kind above, the bot's notifications switch does not
 * gate it: the caller asked out loud and may have hung up since, so this is
 * the only way they hear the answer. A failed turn still reports — "done"
 * means the work stopped, and the body says how. */
export function buildVoiceWorkDone(
  bot: Pick<NotifyBot, "id" | "name">,
  threadId: string,
  reply: string,
  call: { callId: string; messageId: string },
  extra?: { avatarUrl?: string; failure?: string },
): Notification {
  const failure = extra?.failure === undefined ? "" : summarize(extra.failure);
  const body = summarize(reply) || (extra?.failure !== undefined ? `It stopped before finishing${failure ? `: ${failure}` : "."}` : "Finished.");
  const notification: Notification = {
    kind: "voice_work_done",
    botId: bot.id,
    botName: bot.name,
    threadId,
    title: `${bot.name} is done`,
    body,
    callId: call.callId,
    messageId: call.messageId,
  };
  if (extra?.avatarUrl) notification.avatarUrl = extra.avatarUrl;
  return notification;
}

/** What the owner's closed-app push carries for a notification frame: the
 * same identities the live frame has, flattened into the APNs payload. A
 * voice_work_done push also names its type and call, the data the phone
 * acts on: `{ type, botId, threadId, callId, messageId }`. */
export function ownerPushTarget(notification: Notification): PushTarget {
  // The digest is from no bot: no sender, so no communication-style push.
  if (notification.kind === "digest") return { kind: "digest" };
  return {
    kind: notification.kind, botId: notification.botId, threadId: notification.threadId,
    senderId: `bot:${notification.botId}`, senderName: notification.title,
    ...(notification.requestId ? { requestId: notification.requestId } : {}),
    ...(notification.messageId ? { messageId: notification.messageId } : {}),
    ...(notification.kind === "voice_work_done" ? { type: "voice_work_done", ...(notification.callId ? { callId: notification.callId } : {}) } : {}),
  };
}
