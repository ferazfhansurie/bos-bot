import { roomMemberStreamKey } from "@/lib/runtime-stream";
// A room: several bots + you in one shared thread. The sidebar and call view
// carry the personality; avatars inside the room stay still so a busy group
// does not become a wall of competing motion. Plain messages go to the room's
// default responder; @mentions override that routing.
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { activeLocale, t } from "@/lib/i18n";
import { ArrowDown, Check, ChevronDown, ChevronRight, Folder, FolderOpen, Loader2, Settings2, ImagePlus, MessageSquareReply, Pin, PinOff, Search, Wrench, X } from "lucide-react";
import {
  api,
  useStore,
  useStreamFrames,
  useStreamText,
  formatTime,
  openNotificationTarget,
  type Bot,
  type Group,
  type GroupDefaultResponder,
  type Message,
} from "@/state/store";
import { BotAvatar, PersonFace } from "./Avatar";
import { RoomRoster } from "./RoomRoster";
import { ThreadChip } from "./ThreadChip";
import { ToolActivity } from "./ToolActivity";
import { ThreadRefText } from "./ThreadRefs";
import { TurnPresence } from "./TurnPresence";
import { ActivityMascot } from "./ActivityMascot";
import { turnGesture } from "../../shared/mascot-choreography";
import { showToolCallsEnabled } from "@/lib/feature-flags";
import { useToolCallsToggle } from "@/hooks/use-tool-calls-toggle";
import { CompactionChip, DigestChip } from "./DigestChip";
import { roomActivityVisible } from "@/lib/room-activity";
import { MAUS_COLORS, normalizeState } from "@/lib/mascot";
import { effectiveDefaultResponder, groupResponseHint } from "@/lib/group-routing";
import { ChatMarkdown } from "./ChatMarkdown";
import { Composer } from "./Composer";
import { ChatFindBar } from "./ChatFindBar";
import { GroupTaskPicker } from "./TaskPicker";
import { ExportTranscriptMenu } from "./ExportTranscriptMenu";
import { TerminalButton } from "./TerminalPanel";
import { ReplyQuote } from "./ReplyQuote";
import { ConnectorCard } from "./ConnectorCard";
import { SecretRequestCard } from "./SecretRequestCard";
import { hasRoutineExecutionTask, RoutineRunCard } from "./RoutineRunCard";
import { GoalRunCard } from "./GoalRunCard";
import { AttachmentGallery, MessageAttachmentGallery } from "./AttachmentGallery";
import { OptionCard } from "./OptionCard";
import { GroupCallButton, GroupCallOverlay } from "./GroupCallView";

import { ApprovalCard } from "./ApprovalCard";
import { QuestionCard } from "./QuestionCard";
import { ManageMembersPanel } from "./ManageMembersPanel";
import { groupActivityRuns } from "@/lib/activity-runs";
import { ActivityRun } from "./ActivityRun";
import { useDesktopCapabilities, useCaptionChrome } from "./DesktopCapabilities";
import { cn } from "@/lib/cn";
import { useFocusMessage } from "@/lib/focus-message";
import { shortPath } from "@/lib/short-path";
import { BOTTOM_FOLLOW_THRESHOLD, shouldResumeBottomFollow, useBottomFollowResize } from "@/lib/bottom-follow";
import { useComposerDockPad } from "@/lib/composer-dock";
import { awaitedMemberId, showWorkingDots } from "@/lib/turn-tail";
import { liveActivityLabel } from "@/lib/live-activity";
import { roomPresenceMembers, useRoomMemberTurns } from "@/lib/room-member-turns";
import { splitTranscriptAttachments } from "@/lib/composer-attachments";
import {
  TRANSCRIPT_WINDOW_SIZE,
  expandWindowStart,
  focusWindowRange,
  resolveTranscriptWindow,
  tailWindowStart,
} from "@/lib/transcript-window";
import { useReplyDraft } from "@/lib/drafts";
import { imageAttachmentFromFile } from "@/lib/composer-attachments";
import { botAvatarUrlFromStoredPath, botAvatarUrlSchema } from "../../shared/bot-avatar";
import { roomMemberReplyMode, roomMemberStatus, sameBubbleRun, shouldCollapseRoomReply, type RoomViewFields } from "@/lib/room-view";
import { isArriving, trackArrivals, type ArrivalState } from "@/lib/message-arrivals";
import { roomSender, roomSenderName, useMultiplayerMe } from "@/lib/room-sender";

export function RoomAvatar({ name, avatarUrl }: { name: string; avatarUrl?: string | null }) {
  const safe = botAvatarUrlSchema.safeParse(avatarUrl);
  return safe.success ? <img src={safe.data} alt={name} className="size-8 shrink-0 rounded-xl object-cover" />
    : <span aria-label={name} className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-raised text-sm font-semibold text-ink-secondary">{name.slice(0, 2).toUpperCase()}</span>;
}

export function RoomReplyText({ message, members, everyone, threadId, forceOpen = false }: { message: Message; members: Bot[]; everyone: boolean; threadId?: string; forceOpen?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const collapsible = shouldCollapseRoomReply(message);
  const open = expanded || forceOpen;
  return <>
    <div className={cn(collapsible && !open && "line-clamp-6")}>
      <ChatMarkdown text={message.text ?? ""} mentionPeers={members} everyone={everyone} message={threadId ? { threadId, messageId: message.id } : undefined} />
    </div>
    {collapsible && <button type="button" aria-expanded={open} onClick={() => setExpanded(!open)} disabled={forceOpen} className="mt-2 text-xs font-medium text-accent hover:underline">{open ? "Show less" : "Show more"}</button>}
  </>;
}

function RoomSettings({ group, members, setupPending, onToggleFolder, onClose }: { group: Group & RoomViewFields; members: Bot[]; setupPending: boolean; onToggleFolder: () => void; onClose: () => void }) {
  const { dispatch } = useStore();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const photoInput = useRef<HTMLInputElement>(null);
  const save = async (patch: Partial<RoomViewFields>) => {
    const result: { group: Group } = await api(`/api/groups/${group.id}`, { method: "PATCH", body: JSON.stringify(patch) });
    dispatch({ type: "groupPatched", group: result.group });
  };
  const change = async (patch: Partial<RoomViewFields>) => {
    setSaving(true); setError("");
    try { await save(patch); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setSaving(false); }
  };
  const upload = async (file?: File) => {
    if (!file) return;
    setSaving(true); setError("");
    try {
      const attachment = await imageAttachmentFromFile(file);
      const avatarUrl = attachment ? botAvatarUrlFromStoredPath(attachment.path) : null;
      if (!avatarUrl) throw new Error("Choose a PNG, JPEG, GIF, or WebP image.");
      await save({ avatarUrl });
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setSaving(false); if (photoInput.current) photoInput.current.value = ""; }
  };
  return <section aria-label="Room settings" onKeyDown={event => { if (event.key === "Escape") onClose(); }} className="mx-5 mb-3 rounded-xl border border-hairline/40 bg-panel p-4">
    <div className="mb-3 flex items-center justify-between"><h2 className="text-sm font-semibold text-ink">Room settings</h2><button type="button" aria-label="Close room settings" onClick={onClose} className="rounded-md p-1 text-ink-secondary hover:bg-raised"><X size={16} /></button></div>
    <div className="mb-4 flex items-center gap-3">
      <RoomAvatar name={group.name} avatarUrl={group.avatarUrl} />
      <input ref={photoInput} type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden onChange={event => void upload(event.target.files?.[0])} />
      <button type="button" disabled={saving} onClick={() => photoInput.current?.click()} className="ui-button"><ImagePlus size={14} /> Change room photo</button>
      {group.avatarUrl && <button type="button" disabled={saving} onClick={() => void change({ avatarUrl: null })} className="ui-button">Remove photo</button>}
    </div>
    {!setupPending && (
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <DefaultResponderSelect group={group} members={members} />
        <RoomWorkingFolderChip group={group} onToggle={onToggleFolder} />
      </div>
    )}
    <label className="mb-4 flex items-center justify-between gap-3 text-sm text-ink">Notifications
      <select aria-label="Room notifications" disabled={saving} value={group.notifications ?? "all"} onChange={event => void change({ notifications: event.target.value as RoomViewFields["notifications"] })} className="rounded-lg border border-hairline/40 bg-raised px-3 py-2">
        <option value="all">All messages</option><option value="mentions">Mentions only</option><option value="muted">Muted</option>
      </select>
    </label>
    <p className="mb-2 text-xs text-ink-secondary">Choose which members respond to plain messages. Tagged members can always respond.</p>
    <div className="space-y-2">{members.map(member => {
      const status = roomMemberStatus(group, member);
      return <div key={member.id} className="flex items-center justify-between gap-3">
        <span className="flex min-w-0 items-center gap-2"><BotAvatar bot={member} size={24} animated={false} /><span className="truncate text-sm text-ink">{member.name}</span><span className="text-xs text-ink-secondary">{status}</span></span>
        <select aria-label={`${member.name} reply mode`} disabled={saving} value={roomMemberReplyMode({ ...group, defaultResponder: effectiveDefaultResponder(group, members) }, member.id)} onChange={event => void change({ memberReplyModes: { ...group.memberReplyModes, [member.id]: event.target.value as "always" | "mentions" } })} className="rounded-lg border border-hairline/40 bg-raised px-3 py-2 text-sm"><option value="always">Always</option><option value="mentions">When tagged</option></select>
      </div>;
    })}</div>
    {saving && <p role="status" className="mt-3 text-xs text-ink-secondary">Saving…</p>}
    {error && <p role="alert" className="mt-3 text-xs text-danger">{error}</p>}
  </section>;
}


function dayLabel(at: number): string {
  const d = new Date(at);
  const now = new Date();
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (diffDays === 0) return t("chat.day.today");
  if (diffDays === 1) return t("chat.day.yesterday");
  return d.toLocaleDateString(activeLocale(), { weekday: "short", month: "short", day: "numeric" });
}

/** One finished tool step in a room. Same pill the 1:1 chat uses, minus the
 * status glyph — a room reads as a conversation, not a build log. A chip
 * that links somewhere ("Posted in #Standup", a bot⇄bot exchange) opens it,
 * as it would in a 1:1 — a receipt the person cannot follow is only half a
 * receipt. When the linked channel IS this room (an ask made from here is
 * mirrored back into it) there is nowhere to go, so it stays a plain,
 * visible pill. */
export function RoomToolChip({ message, roomId }: { message: Message; roomId?: string }) {
  const { state, dispatch } = useStore();
  const tool = message.tool;
  if (!tool) return null;
  if (message.threadRef) return <ThreadChip message={message} />;
  const comm = message.comm;
  if (comm && comm.groupId !== roomId) {
    const withBot = state.bots.find((b) => b.id === comm.withBotId);
    return (
      <div className="flex justify-start">
        <button
          type="button"
          onClick={() => {
            dispatch({ type: "select", id: comm.groupId });
            const destination = state.groups.find(g => g.id === comm.groupId);
            if (comm.threadId && destination?.tasks?.some(task => task.threadId === comm.threadId)) {
              dispatch({ type: "switchGroupTask", groupId: comm.groupId, threadId: comm.threadId });
            }
          }}
          title={t("room.openBot", { name: comm.withName })}
          className="press step-tag flex items-center gap-1.5 rounded-full px-2 py-1 text-[12px] text-ink-secondary/70 hover:bg-raised hover:text-ink"
        >
          <BotAvatar bot={withBot ?? { name: comm.withName, color: comm.withColor }} state="happy" size={16} />
          <span className="max-w-[480px] truncate">{tool.name}</span>
          <ChevronRight size={13} />
        </button>
      </div>
    );
  }
  if (!comm) return <ToolActivity tool={tool} />;
  return (
    <div className="step-tag flex justify-start pl-1">
      <div
        className={cn(
          "flex items-center gap-1.5 text-[12px]",
          tool.ok === false ? "text-danger" : "text-ink-secondary/70",
        )}
      >
        {comm && <BotAvatar bot={state.bots.find(b => b.id === comm.withBotId) ?? { name: comm.withName, color: comm.withColor }} state="happy" size={16} />}
        <span className={cn("max-w-[480px] truncate", !comm && "font-mono")}>{tool.name}</span>
      </div>
    </div>
  );
}

/** Sender name above the first bubble of a run, in the bot's own color.
 * Text bubbles carry the avatar beside them, so their label lines up with
 * the bubble edge; cards and tool runs keep the small avatar inline. */
function ClusterLabel({ bot, name, color, bubble = false }: { bot?: Bot; name: string; color: string; bubble?: boolean }) {
  const tint = (MAUS_COLORS as Record<string, string>)[bot?.color ?? color];
  if (bubble) {
    return (
      <div className="-mb-2 mt-1 truncate pl-[42px] text-[12px] font-medium" style={{ color: tint }}>
        {name}
      </div>
    );
  }
  return (
    <div className="mt-1 flex items-center gap-1.5 pl-0.5">
      <BotAvatar
        bot={bot ?? { name, color: color as Bot["color"] }}
        state={normalizeState(bot?.mascotExpression) ?? "happy"}
        size={16}
        motion="none"
        motionKey={0}
        animated={false}
      />
      <span className="text-[11px] font-medium" style={{ color: tint }}>{name}</span>
    </div>
  );
}

/** Pin toggle for one room message — one pin per room, patchGroup path. */
function PinToggle({ group, message }: { group: Group; message: Message }) {
  const { dispatch } = useStore();
  if (window.ogb?.remoteClient?.active) return null;
  const pinned = group.pinnedMessageId === message.id;
  return (
    <button
      onClick={() =>
        dispatch({
          type: "patchGroup",
          groupId: group.id,
          patch: { pinnedMessageId: pinned ? "" : message.id },
        })
      }
      aria-label={pinned ? t("chat.unpinMessage") : t("chat.pinMessage")}
      className="rounded-md p-1.5 text-ink-secondary opacity-0 transition-opacity hover:bg-raised hover:text-ink focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
      title={pinned ? t("chat.unpinHint") : t("room.pinHint")}
    >
      {pinned ? <PinOff size={14} /> : <Pin size={14} />}
    </button>
  );
}

const Transcript = memo(function Transcript({
  group,
  members,
  messages,
  transcript,
  emergingId,
  streamedAt,
  onReply,
}: {
  group: Group;
  members: Bot[];
  /** Invalidate the memoized transcript when only the language changes. */
  locale: string;
  /** The windowed suffix of group.messages — the boundary lives in GroupView. */
  messages: Message[];
  /** Full room transcript, used to resolve quoted messages outside the mounted window. */
  transcript: Message[];
  emergingId?: string | null;
  /** When each member last streamed; its saved reply is already on screen. */
  streamedAt: ReadonlyMap<string, number>;
  onReply: (message: Message) => void;
}) {
  const { state, dispatch } = useStore();
  // Messages that land while the room is open spring in; history stays still.
  const arrivals = useRef<ArrivalState | null>(null);
  const now = Date.now();
  arrivals.current = trackArrivals(arrivals.current, group.threadId, transcript, now);
  const showToolCalls = showToolCallsEnabled(state.config);
  const memberOf = (id?: string) => members.find((b) => b.id === id);
  const meId = useMultiplayerMe()?.actorId;
  // Several bots working at once turn a room into a wall of chips; fold the
  // finished ones the same way a 1:1 chat does.
  // Hidden runs are dropped here, not at render, so the bubbles either side
  // of one still read as neighbours.
  const items = useMemo(() => groupActivityRuns(messages.filter(message =>
    message.kind !== "activity" || roomActivityVisible(message, showToolCalls)))
    .filter((item) => showToolCalls || item.kind !== "run"), [messages, showToolCalls]);
  const newestMessageId = messages.at(-1)?.id;
  const newestUserMessageId = [...messages].reverse().find((message) => message.role === "user")?.id;
  const focus = state.focusMessage;
  const focusedId = focus && !focus.consumed && focus.threadId === group.threadId ? focus.messageId : null;
  return (
    <>
      {items.map((item, i) => {
        const previous = items[i - 1];
        const prev = previous && (previous.kind === "run" ? previous.messages.at(-1) : previous.message);
        const first = item.kind === "run" ? item.messages[0] : item.message;
        const newDay = !prev || new Date(prev.at).toDateString() !== new Date(first.at).toDateString();
        if (item.kind === "run") {
          const cluster = !prev || prev.role !== first.role || prev.from?.botId !== first.from?.botId || newDay;
          return (
            <div key={item.id} className="contents">
              {newDay && (
                <div className="py-3 text-center text-[13px] text-ink-secondary">
                  {dayLabel(first.at)} {formatTime(first.at)}
                </div>
              )}
              {first.from && cluster && (
                <ClusterLabel bot={memberOf(first.from.botId)} name={first.from.name} color={first.from.color} />
              )}
              <ActivityRun messages={item.messages} forceOpen={item.messages.some((step) => step.id === focusedId)}>
                {item.messages.map((step) => (
                  <div key={step.id} className="contents" data-mid={step.id}>
                    <RoomToolChip message={step} />
                  </div>
                ))}
              </ActivityRun>
            </div>
          );
        }
        const m = item.message;
        const user = m.role === "user";
        // another person's line reads like a member's: left side, their face and name
        const person = user ? roomSender(m, group, meId) : null;
        const other = Boolean(person && !person.mine);
        const right = user && !other;
        const following = items[i + 1];
        const runStarts = !sameBubbleRun(prev, m);
        const runEnds = !sameBubbleRun(m, following && following.kind !== "run" ? following.message : undefined);
        const attachments = user && m.text ? splitTranscriptAttachments(m.text) : null;
        const newCluster = !prev || prev.role !== m.role || prev.from?.botId !== m.from?.botId || prev.sender?.id !== m.sender?.id || Boolean(prev.comm) || newDay;
        const routineOwner = m.kind === "routine.run" ? memberOf(m.from?.botId) : undefined;
        const routineExecutionThreadId = m.routineRun?.executionThreadId;
        const routineTarget = routineOwner && hasRoutineExecutionTask(routineOwner.tasks, routineExecutionThreadId)
          ? { botId: routineOwner.id, threadId: routineExecutionThreadId }
          : undefined;
        const row =
          // a member can hit a permission ask mid-turn; without this the
          // card never rendered here and the bot waited out its timeout.
          // `tool` distinguishes a permission from a QUESTION — a question
          // only accepts an "answer", so routing it to the approval box
          // would offer an Allow the broker rejects. A structured ask is
          // one of those questions, and answers in its own card.
          m.kind === "secret" && m.secret && m.from?.botId ? (
            <SecretRequestCard botId={m.from.botId} threadId={group.threadId} message={m} />
          ) : m.kind === "connector" && m.connector && m.from?.botId ? (
            <ConnectorCard botId={m.from.botId} threadId={group.threadId} message={m} />
          ) : m.kind === "options" && m.card?.requestId && m.card.questionRequest ? (
            <div className="flex justify-start">
              <QuestionCard threadId={group.threadId} bot={memberOf(m.from?.botId)} message={m} />
            </div>
          ) : m.kind === "options" && m.card?.requestId && m.card.tool ? (
            <div className="flex justify-start">
              <ApprovalCard bot={memberOf(m.from?.botId)} message={m} />
            </div>
          ) : m.kind === "options" && m.card && m.from?.botId ? (
            // a QUESTION from a member. Without this branch the card fell
            // through to null: invisible on screen, and the asking bot sat
            // there until its 15-minute timeout answered for you
            <div className="flex justify-start">
              <OptionCard botId={m.from.botId} threadId={group.threadId} groupId={group.id} message={m} />
            </div>
          ) : m.kind === "goal.run" ? (
            <div className="flex justify-start">
              <GoalRunCard message={m} />
            </div>
          ) : m.kind === "routine.run" ? (
            <div className="flex justify-start">
              <RoutineRunCard
                message={m}
                onOpen={routineTarget
                  ? () => openNotificationTarget(dispatch, routineTarget, state)
                  : undefined}
              />
            </div>
          ) : m.kind === "activity" && m.tool ? (
            roomActivityVisible(m, showToolCalls) ? (
              <RoomToolChip message={m} roomId={group.id} />
            ) : null
          ) : m.kind === "compaction" ? (
            <CompactionChip message={m} />
          ) : m.kind === "digest" ? (
            showToolCalls ? <DigestChip message={m} /> : null
          ) : m.kind === "text" && (m.text || m.attachments?.length) ? (
            <div className={cn(
              "group flex w-full flex-col",
              right ? "items-end" : "items-start",
              !runStarts && "-mt-2",
              isArriving(arrivals.current, m.id) && m.id !== emergingId
                && !(m.from?.botId && now - (streamedAt.get(m.from.botId) ?? 0) < 2000)
                && (right ? "msg-spring origin-right" : "msg-spring origin-left"),
            )}>
              <div className={cn("flex w-full items-end gap-1.5", right ? "justify-end" : "justify-start")}>
                {other && (
                  <span className="w-6 shrink-0 self-end">
                    {runEnds && person && <PersonFace person={person.person ?? { name: person.name }} size={24} />}
                  </span>
                )}
                {!user && (
                  <span className="w-6 shrink-0 self-end">
                    {runEnds && m.from && (
                      <BotAvatar
                        bot={memberOf(m.from.botId) ?? { name: m.from.name, color: m.from.color as Bot["color"] }}
                        state={normalizeState(memberOf(m.from.botId)?.mascotExpression) ?? "happy"}
                        size={24}
                        motion="none"
                        motionKey={0}
                        animated={false}
                      />
                    )}
                  </span>
                )}
                {right && (
                  <>
                    <button
                      type="button"
                      onClick={() => onReply(m)}
                      aria-label={t("chat.replyToMessage")}
                      title={t("chat.reply")}
                      className="rounded-md p-1.5 text-ink-secondary opacity-0 transition-opacity hover:bg-raised hover:text-ink focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
                    >
                      <MessageSquareReply size={14} />
                    </button>
                    <PinToggle group={group} message={m} />
                  </>
                )}
                <div
                  className={cn(
                    "w-fit max-w-[min(42rem,78%)] rounded-2xl p-3 text-[15px] leading-relaxed",
                    !user && m.id === emergingId && "turn-answer",
                    right ? "chat-text whitespace-pre-wrap bg-bubble-user text-ink" : user ? "chat-text whitespace-pre-wrap bg-card text-ink" : "bg-card text-ink",
                  )}
                  title={new Date(m.at).toLocaleString()}
                >
                  {m.replyToId && (() => {
                    const target = transcript.find((candidate) => candidate.id === m.replyToId);
                    return target ? (
                      <div className="mb-2">
                        <ReplyQuote
                          message={target}
                          fallbackName={t("room.fallbackBot")}
                          authorName={roomSenderName(target, group, meId) ?? undefined}
                          compact
                          onJump={() =>
                            dispatch({ type: "focusMessage", threadId: group.threadId, messageId: target.id })
                          }
                        />
                      </div>
                    ) : null;
                  })()}
                  {user ? (
                    <>
                      {attachments && <AttachmentGallery images={attachments.images} files={attachments.files} message={{ threadId: group.threadId, messageId: m.id }} eager={m.id === newestMessageId || m.id === newestUserMessageId} className={!attachments.display ? "mb-0" : undefined} />}
                      <ThreadRefText text={attachments?.display ?? m.text ?? ""} peers={members} everyone={!group.dm} />
                      {m.via === "api" && (
                        <div className="mt-1 text-[11px] text-ink-secondary">Sent through the API, not typed here</div>
                      )}
                    </>
                  ) : (
                    <>
                      <MessageAttachmentGallery text={m.text ?? ""} attachments={m.attachments} message={{ threadId: group.threadId, messageId: m.id }} className={m.text ? undefined : "mb-0"} eager={m.id === newestMessageId || m.id === newestUserMessageId} />
                      {m.text ? <RoomReplyText message={m} members={members} everyone={!group.dm} threadId={group.threadId} forceOpen={m.id === focusedId} /> : null}
                    </>
                  )}
                </div>
                {!right && (
                  <>
                    <button
                      type="button"
                      onClick={() => onReply(m)}
                      aria-label={t("chat.replyToMessage")}
                      title={t("chat.reply")}
                      className="rounded-md p-1.5 text-ink-secondary opacity-0 transition-opacity hover:bg-raised hover:text-ink focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
                    >
                      <MessageSquareReply size={14} />
                    </button>
                    <PinToggle group={group} message={m} />
                  </>
                )}
                <span className="self-end pb-1 text-[11px] tabular-nums text-ink-secondary/70 opacity-0 transition-opacity group-hover:opacity-100">
                  {formatTime(m.at)}
                </span>
              </div>
            </div>
          ) : null;
        if (!row) return null;
        return (
          <div key={m.id} className="contents" data-mid={m.id}>
            {newDay && (
              <div className="py-3 text-center text-[13px] text-ink-secondary">
                {dayLabel(m.at)} {formatTime(m.at)}
              </div>
            )}
            {!user && m.from && newCluster && !(m.kind === "activity" && m.comm) && (
              <ClusterLabel bot={memberOf(m.from.botId)} name={m.from.name} color={m.from.color} bubble={m.kind === "text"} />
            )}
            {other && person?.name && newCluster && m.kind === "text" && (
              <ClusterLabel name={person.name} color={person.person?.color ?? ""} bubble />
            )}
            {row}
          </div>
        );
      })}
    </>
  );
});

function DefaultResponderSelect({ group, members }: { group: Group; members: Bot[] }) {
  const { dispatch } = useStore();
  const responder = effectiveDefaultResponder(group, members);
  const value = responder.kind === "member" ? `member:${responder.botId}` : responder.kind;
  const lead = responder.kind === "member" ? members.find((member) => member.id === responder.botId) : undefined;
  const title =
    responder.kind === "everyone"
      ? t("room.responder.everyone")
      : responder.kind === "mentions"
        ? t("room.responder.mentions")
        : t("room.responder.lead", { name: lead?.name ?? t("room.responder.leadFallback") });

  const change = (nextValue: string) => {
    let next: GroupDefaultResponder;
    if (nextValue === "everyone") next = { kind: "everyone" };
    else if (nextValue === "mentions") next = { kind: "mentions" };
    else next = { kind: "member", botId: nextValue.slice("member:".length) };
    dispatch({ type: "patchGroup", groupId: group.id, patch: { defaultResponder: next } });
  };

  return (
    <div className="relative shrink-0" title={title}>
      <select
        aria-label={t("room.responder.aria")}
        value={value}
        onChange={(event) => change(event.target.value)}
        className="h-8 max-w-[190px] appearance-none truncate rounded-full border border-hairline/40 bg-raised/60 py-1 pl-3 pr-7 text-[12.5px] font-medium text-ink outline-none hover:bg-raised focus:border-accent"
      >
        <optgroup label={t("room.responder.groupLead")}>
          {members.map((member) => (
            <option key={member.id} value={`member:${member.id}`}>
              {t("room.responder.leadOption", { name: member.name })}
            </option>
          ))}
        </optgroup>
        <optgroup label={t("room.responder.groupBehavior")}>
          <option value="everyone">{t("room.responder.everyoneOption")}</option>
          <option value="mentions">{t("room.responder.mentionsOption")}</option>
        </optgroup>
      </select>
      <ChevronDown
        size={13}
        aria-hidden="true"
        className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-secondary"
      />
    </div>
  );
}

/** The room's shared desk: where every member's shell and file tools run,
 * overriding each bot's own folder for room turns. The room pins its own
 * copy on its first turn (the server does the pinning — engines key their
 * sessions to the folder a thread starts in, so a folder must not move
 * under a room that already worked somewhere). The PATCH is made directly
 * rather than through patchGroup: the server validates the path and a
 * rejected folder must not stick in local state. */
function RoomWorkingFolder({ group }: { group: Group }) {
  const { capabilities } = useDesktopCapabilities();
  const home = capabilities.host.homeDir;
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const canPick = Boolean(window.ogb?.pickFolder);
  const pinned = group.pinnedCwd; // undefined = not yet, null = each bot's own, string = folder
  const locked = pinned !== undefined;
  const shownCwd = locked ? (pinned ?? undefined) : group.cwd;

  const save = async (cwd: string | null) => {
    setSaving(true);
    setError(null);
    try {
      await api(`/api/groups/${group.id}`, { method: "PATCH", body: JSON.stringify({ cwd }) });
      setDraft(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };
  const pick = async () => {
    const chosen = await window.ogb?.pickFolder?.(group.cwd);
    if (chosen) void save(chosen);
  };

  return (
    <div className="rounded-xl bg-card p-4">
      <div className="text-[15px] font-medium text-ink">{t("room.folder.title")}</div>
      <div className="mt-0.5 text-[13px] text-ink-secondary">{t("room.folder.detail")}</div>
      {locked ? (
        <div className="mt-3">
          <div className="truncate rounded-lg border border-hairline/40 bg-inset px-3 py-2 font-mono text-[12.5px] text-ink" title={shownCwd}>
            {shownCwd ? shortPath(shownCwd, home) : <span className="text-ink-secondary">{t("room.folder.own")}</span>}
          </div>
          <div className="mt-2 text-[12px] text-ink-secondary">
            {t("room.folder.locked")}
          </div>
        </div>
      ) : canPick ? (
        <div className="mt-3 flex items-center gap-2">
          <div className="min-w-0 flex-1 truncate rounded-lg border border-hairline/40 bg-inset px-3 py-2 font-mono text-[12.5px] text-ink" title={group.cwd}>
            {group.cwd ? shortPath(group.cwd, home) : <span className="text-ink-secondary">{t("room.folder.own")}</span>}
          </div>
          <button onClick={() => void pick()} disabled={saving} className="flex shrink-0 items-center gap-1.5 rounded-lg bg-raised px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50">
            <FolderOpen size={14} /> {t("room.folder.choose")}
          </button>
          {group.cwd && (
            <button onClick={() => void save(null)} disabled={saving} className="shrink-0 rounded-lg px-2 py-2 text-[13px] text-ink-secondary hover:text-ink disabled:opacity-50">
              {t("keys.clear")}
            </button>
          )}
        </div>
      ) : (
        <form
          className="mt-3 flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            // an emptied field clears the folder — the server wants null
            void save((draft ?? group.cwd ?? "").trim() || null);
          }}
        >
          <input
            className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2.5 font-mono text-[12.5px] text-ink placeholder:text-ink-secondary focus:outline-none focus:border-hairline"
            placeholder={t("room.folder.placeholder")}
            value={draft ?? group.cwd ?? ""}
            onChange={(e) => setDraft(e.target.value)}
          />
          <button type="submit" disabled={saving || draft === null} className="shrink-0 rounded-lg bg-raised px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50">
            {t("common.save")}
          </button>
        </form>
      )}
      {error && <div className="mt-2 text-[12px] text-danger">{error}</div>}
    </div>
  );
}

/** The folder this room's turns run in — the pinned folder once a turn ran,
 * else the room folder a first turn would pin. Always present so the desk
 * is settable before any folder exists; quiet (icon only) until then. */
/** Show/hide tool calls, right in the room. Off, a bot's steps live only in
 * its thinking line; on, each one stays behind as a chip. */
export function ToolCallsToggle() {
  const { enabled, saving, error, toggle } = useToolCallsToggle();
  const label = enabled ? t("chat.toolCalls.hide") : t("chat.toolCalls.show");
  return (
    <button
      type="button"
      onClick={() => void toggle()}
      disabled={saving}
      aria-label={label}
      aria-pressed={enabled}
      title={error || label}
      className={cn(
        "rounded-md p-1.5 hover:bg-raised disabled:cursor-wait",
        error ? "text-danger" : enabled ? "text-accent" : "text-ink-secondary hover:text-ink",
      )}
    >
      <Wrench size={18} />
    </button>
  );
}

function RoomWorkingFolderChip({ group, onToggle }: { group: Group; onToggle: () => void }) {
  const folder = group.pinnedCwd === undefined ? group.cwd : (group.pinnedCwd ?? undefined);
  if (!folder) {
    return (
      <button
        onClick={onToggle}
        className="rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink"
        title={t("room.folder.chipTitle")}
      >
        <Folder size={14} />
      </button>
    );
  }
  const name = folder.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || folder;
  return (
    <button
      onClick={onToggle}
      className="flex max-w-[180px] items-center gap-1.5 rounded-full border border-hairline/40 bg-raised/60 px-2.5 py-1 text-[12.5px] text-ink-secondary hover:bg-raised hover:text-ink"
      title={t("chat.workingFolder", { folder })}
    >
      <Folder size={12} />
      <span className="truncate font-mono">{name}</span>
    </button>
  );
}


type RoomSetupFields = {
  setupPending?: boolean;
  setupRequired?: boolean;
  setupState?: "required" | "completed" | "skipped";
  setupCompletedAt?: number | string | null;
  setupSkippedAt?: number | string | null;
};

type RoomResponderMode = "lead" | "everyone" | "mentions";

function setupResponderMode(responder: GroupDefaultResponder): RoomResponderMode {
  return responder.kind === "member" ? "lead" : responder.kind;
}

function roomNeedsSetup(group: Group): boolean {
  if (group.dm || group.messages.length > 0) return false;
  // SAFETY: setup fields are additive server metadata; the existing Group shape remains valid when absent.
  const marker = group as Group & RoomSetupFields;
  const hasSetupMarker =
    Object.prototype.hasOwnProperty.call(marker, "setupCompletedAt") ||
    Object.prototype.hasOwnProperty.call(marker, "setupSkippedAt");
  // Legacy empty rooms omit both keys and remain immediately usable.
  if (!hasSetupMarker) return false;
  if (
    marker.setupPending === false ||
    marker.setupRequired === false ||
    marker.setupState === "completed" ||
    marker.setupState === "skipped" ||
    marker.setupCompletedAt != null ||
    marker.setupSkippedAt != null
  ) {
    return false;
  }
  return true;
}

function RoomSetup({ group, members }: { group: Group; members: Bot[] }) {
  const { dispatch } = useStore();
  const [folder, setFolder] = useState(group.cwd ?? "");
  const [behavior, setBehavior] = useState<RoomResponderMode>(setupResponderMode(group.defaultResponder));
  const [leadId, setLeadId] = useState(
    group.defaultResponder.kind === "member" ? group.defaultResponder.botId : members[0]?.id ?? "",
  );
  const [instructions, setInstructions] = useState(group.bulletin);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [leadPickerOpen, setLeadPickerOpen] = useState(false);
  const leadPickerRef = useRef<HTMLDivElement>(null);
  const selectedLead = members.find((member) => member.id === leadId) ?? members[0];

  useEffect(() => {
    if (!leadPickerOpen) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!leadPickerRef.current?.contains(event.target as Node)) setLeadPickerOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setLeadPickerOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [leadPickerOpen]);

  const responder = (): GroupDefaultResponder => {
    if (behavior === "everyone") return { kind: "everyone" };
    if (behavior === "mentions") return { kind: "mentions" };
    return members.some((member) => member.id === leadId)
      ? { kind: "member", botId: leadId }
      : group.defaultResponder;
  };

  const finish = async (action: "complete" | "skip") => {
    setLeadPickerOpen(false);
    setSaving(true);
    setError(null);
    try {
      const payload =
        action === "skip"
          ? { action }
          : {
              action,
              cwd: folder.trim() || null,
              defaultResponder: responder(),
              bulletin: instructions,
            };
      const result = await api(`/api/groups/${group.id}/setup`, {
        method: "PATCH",
        body: JSON.stringify(payload),
      });
      const now = Date.now();
      const nextGroup = {
        ...(result.group ?? group),
        id: group.id,
        setupPending: false,
        ...(action === "skip" ? { setupSkippedAt: now } : { setupCompletedAt: now }),
      };
      dispatch({ type: "groupPatched", group: nextGroup });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const pickFolder = async () => {
    const chosen = await window.ogb?.pickFolder?.(folder || group.cwd);
    if (chosen) setFolder(chosen);
  };

  return (
    <section
      data-testid="room-setup"
      aria-labelledby="room-setup-title"
      className="relative z-20 w-full overflow-visible rounded-3xl border border-hairline/50 bg-card shadow-xl shadow-black/10"
    >
      <div className="rounded-t-3xl border-b border-hairline/40 bg-panel/70 px-5 py-5 sm:px-7">
        <div className="flex items-start gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-accent text-sm font-bold text-white">1</span>
          <div>
            <h1 id="room-setup-title" className="text-xl font-semibold tracking-tight text-ink">{t("room.setup.title", { name: group.name })}</h1>
            <p className="mt-1 max-w-[560px] text-[13.5px] leading-relaxed text-ink-secondary">
              {t("room.setup.detail")}
            </p>
          </div>
        </div>
      </div>
      <form
        className="space-y-5 px-5 py-5 sm:px-7 sm:py-6"
        onSubmit={(event) => {
          event.preventDefault();
          void finish("complete");
        }}
      >
        <label className="block">
          <span className="text-[13px] font-semibold text-ink">{t("room.folder.title")}</span>
          <span className="mt-1 block text-[12px] text-ink-secondary">{t("room.setup.folderDetail")}</span>
          <div className="mt-2 flex gap-2">
            <input
              value={folder}
              onChange={(event) => setFolder(event.target.value)}
              placeholder={t("room.folder.own")}
              className="min-w-0 flex-1 rounded-xl border border-hairline/50 bg-inset px-3 py-2.5 font-mono text-[12.5px] text-ink placeholder:text-ink-secondary focus:border-accent focus:outline-none"
            />
            {window.ogb?.pickFolder && (
              <button
                type="button"
                onClick={() => void pickFolder()}
                disabled={saving}
                className="flex shrink-0 items-center gap-1.5 rounded-xl border border-hairline/50 bg-raised px-3 py-2 text-[13px] font-medium text-ink hover:bg-raised-hover disabled:opacity-50"
              >
                <FolderOpen size={14} /> Choose
              </button>
            )}
          </div>
        </label>

        <fieldset className="block">
          <legend className="text-[13px] font-semibold text-ink">{t("room.responder.aria")}</legend>
          <p className="mt-1 text-[12px] text-ink-secondary">{t("room.setup.responderDetail")}</p>
          <div role="radiogroup" aria-label={t("room.responder.aria")} className="mt-2 grid gap-2 sm:grid-cols-3">
            <div ref={leadPickerRef} className="relative min-w-0">
              <button
                type="button"
                role="radio"
                aria-checked={behavior === "lead"}
                aria-haspopup="listbox"
                aria-expanded={behavior === "lead" && leadPickerOpen}
                onClick={() => {
                  setBehavior("lead");
                  setLeadPickerOpen((open) => !open);
                }}
                disabled={saving}
                className={cn(
                  "flex min-h-[72px] w-full flex-col items-start justify-between rounded-2xl border px-3 py-3 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-50",
                  behavior === "lead"
                    ? "border-accent bg-accent/10 text-ink ring-1 ring-accent/30"
                    : "border-hairline/50 bg-inset text-ink-secondary hover:border-hairline hover:bg-raised",
                )}
              >
                <span className="flex w-full items-center justify-between gap-2">
                  <span className="flex items-center gap-2 text-[13px] font-semibold">
                    <span
                      className={cn(
                        "flex size-4 shrink-0 items-center justify-center rounded-full border",
                        behavior === "lead" ? "border-accent bg-accent" : "border-ink-secondary/60",
                      )}
                    >
                      {behavior === "lead" && <span className="size-1.5 rounded-full bg-white" />}
                    </span>
                    {t("room.behavior.lead")}
                  </span>
                  <ChevronDown
                    size={14}
                    aria-hidden="true"
                    className={cn("shrink-0 text-ink-secondary transition-transform", leadPickerOpen && "rotate-180")}
                  />
                </span>
                <span className="ml-6 mt-2 truncate text-[11.5px] text-ink-secondary">
                  {selectedLead?.name ?? t("room.behavior.chooseTeammate")}
                </span>
              </button>
              {behavior === "lead" && leadPickerOpen && (
                <div
                  role="listbox"
                  aria-label={t("room.behavior.chooseLead")}
                  className="absolute left-0 top-full z-30 mt-2 w-72 max-w-[calc(100vw-3rem)] overflow-hidden rounded-2xl border border-hairline/60 bg-panel shadow-2xl shadow-black/20"
                >
                  <div className="border-b border-hairline/40 px-3 py-2.5">
                    <div className="text-[12.5px] font-semibold text-ink">{t("room.behavior.chooseLead")}</div>
                    <div className="mt-0.5 text-[11.5px] text-ink-secondary">{t("room.behavior.chooseLeadDetail")}</div>
                  </div>
                  <div className="max-h-48 overflow-y-auto p-1.5">
                    {members.map((member) => {
                      const selected = member.id === leadId;
                      return (
                        <button
                          key={member.id}
                          type="button"
                          role="option"
                          aria-selected={selected}
                          onClick={() => {
                            setLeadId(member.id);
                            setLeadPickerOpen(false);
                          }}
                          className={cn(
                            "flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left transition",
                            selected ? "bg-accent/10" : "hover:bg-raised",
                          )}
                        >
                          <BotAvatar
                            bot={member}
                            state={normalizeState(member.mascotExpression) ?? "happy"}
                            size={24}
                            animated={false}
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[13px] font-medium text-ink">{member.name}</span>
                            <span className="block truncate text-[11px] text-ink-secondary">{member.title}</span>
                          </span>
                          {selected && <Check size={15} className="shrink-0 text-accent" />}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            <button
              type="button"
              role="radio"
              aria-checked={behavior === "everyone"}
              onClick={() => {
                setBehavior("everyone");
                setLeadPickerOpen(false);
              }}
              disabled={saving}
              className={cn(
                "flex min-h-[72px] w-full flex-col items-start justify-between rounded-2xl border px-3 py-3 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-50",
                behavior === "everyone"
                  ? "border-accent bg-accent/10 text-ink ring-1 ring-accent/30"
                  : "border-hairline/50 bg-inset text-ink-secondary hover:border-hairline hover:bg-raised",
              )}
            >
              <span className="flex items-center gap-2 text-[13px] font-semibold">
                <span
                  className={cn(
                    "flex size-4 shrink-0 items-center justify-center rounded-full border",
                    behavior === "everyone" ? "border-accent bg-accent" : "border-ink-secondary/60",
                  )}
                >
                  {behavior === "everyone" && <span className="size-1.5 rounded-full bg-white" />}
                </span>
                {t("room.responder.everyoneOption")}
              </span>
              <span className="ml-6 mt-2 text-[11.5px] text-ink-secondary">{t("room.setup.allMembers")}</span>
            </button>

            <button
              type="button"
              role="radio"
              aria-checked={behavior === "mentions"}
              onClick={() => {
                setBehavior("mentions");
                setLeadPickerOpen(false);
              }}
              disabled={saving}
              className={cn(
                "flex min-h-[72px] w-full flex-col items-start justify-between rounded-2xl border px-3 py-3 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-50",
                behavior === "mentions"
                  ? "border-accent bg-accent/10 text-ink ring-1 ring-accent/30"
                  : "border-hairline/50 bg-inset text-ink-secondary hover:border-hairline hover:bg-raised",
              )}
            >
              <span className="flex items-center gap-2 text-[13px] font-semibold">
                <span
                  className={cn(
                    "flex size-4 shrink-0 items-center justify-center rounded-full border",
                    behavior === "mentions" ? "border-accent bg-accent" : "border-ink-secondary/60",
                  )}
                >
                  {behavior === "mentions" && <span className="size-1.5 rounded-full bg-white" />}
                </span>
                {t("room.responder.mentionsOption")}
              </span>
              <span className="ml-6 mt-2 text-[11.5px] text-ink-secondary">{t("room.setup.onlyMentioned")}</span>
            </button>
          </div>
        </fieldset>

        <label className="block">
          <span className="text-[13px] font-semibold text-ink">{t("room.setup.instructions")}</span>
          <span className="mt-1 block text-[12px] text-ink-secondary">{t("room.setup.instructionsDetail")}</span>
          <textarea
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
            rows={5}
            placeholder={t("room.setup.instructionsPlaceholder")}
            className="mt-2 w-full resize-y rounded-xl border border-hairline/50 bg-inset px-3 py-2.5 text-[13px] leading-relaxed text-ink placeholder:text-ink-secondary focus:border-accent focus:outline-none"
          />
        </label>

        {error && <div role="alert" className="rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-[12.5px] text-danger">{error}</div>}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
          <button
            type="button"
            onClick={() => void finish("skip")}
            disabled={saving}
            className="rounded-xl px-3 py-2 text-left text-[13px] text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-50"
          >
            {t("room.setup.skip")}
          </button>
          <button
            type="submit"
            disabled={saving}
            className="flex items-center justify-center gap-2 rounded-xl bg-accent px-4 py-2.5 text-[13px] font-semibold text-white hover:brightness-110 disabled:opacity-50"
          >
            {saving && <Loader2 size={14} className="animate-spin" />}
            {t("room.setup.save")}
          </button>
        </div>
      </form>
    </section>
  );
}
// One member's in-flight reply. It subscribes to its own stream key, so a
// token repaints this bubble alone, not the transcript, header or composer.
// It wears the finished bubble's exact shape, so when the saved reply takes
// its place the room does not jump. `streamedAt` notes when each member last
// streamed, so that saved reply skips its own entrance.
const RoomStreamBubble = memo(function RoomStreamBubble({ threadId, member, members, everyone, streamedAt }: {
  threadId: string; member: Bot; members: Bot[]; everyone: boolean; streamedAt: Map<string, number>;
}) {
  const text = useStreamText(roomMemberStreamKey(threadId, member.id));
  if (text) streamedAt.set(member.id, Date.now());
  if (!text) return null;
  return <div className="flex min-w-0 flex-col items-start" aria-label={`${member.name} is replying`}>
    <ClusterLabel bot={member} name={member.name} color={member.color} bubble />
    <div className="mt-3 flex w-full items-end gap-1.5">
      <BotAvatar bot={member} state={normalizeState(member.mascotExpression) ?? "happy"} size={24} motion="none" motionKey={0} animated={false} />
      <div className="bubble-in w-fit max-w-[min(42rem,78%)] rounded-2xl bg-card p-3 text-[15px] leading-relaxed text-ink">
        <ChatMarkdown text={text} streaming mentionPeers={members} everyone={everyone} />
      </div>
    </div>
  </div>;
});

// The room title: avatar stack + name in one soft centered pill.
const ROOM_NAME_PILL = "flex min-w-0 max-w-full items-center gap-2 rounded-full bg-panel/80 py-1 pl-1 pr-3.5 text-[14px] font-semibold text-ink ring-1 ring-hairline/40";

export function GroupView({ group }: { group: Group }) {
  const { state, dispatch } = useStore();
  const remoteClient = window.ogb?.remoteClient?.active === true;
  const meId = useMultiplayerMe()?.actorId;
  // Same Windows caption handling as ChatView: drag on the header, shift the
  // right-hand controls below the renderer-drawn caption buttons.
  const { dragStyle: headerDragStyle, noDragStyle: headerNoDragStyle, controlsShiftStyle } = useCaptionChrome();
  const scrollRef = useRef<HTMLDivElement>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const composerDockRef = useRef<HTMLDivElement>(null);
  const composerDock = useComposerDockPad(composerDockRef);
  const [follow, setFollow] = useState(true);
  const followRef = useRef(true);
  const previousScrollTop = useRef(0);
  const touchY = useRef(0);
  const [bulletinOpen, setBulletinOpen] = useState(false);
  const [bulletinDraft, setBulletinDraft] = useState(group.bulletin);
  const [folderOpen, setFolderOpen] = useState(false);
  const [membersOpen, setMembersOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const { replyTo, selectReply, clearReply, consumeReply, restoreReply } = useReplyDraft(
    group.threadId,
    `group:${group.id}:${group.threadId}`,
    group.messages,
  );
  const membersTriggerRef = useRef<HTMLButtonElement>(null);
  const closeMembers = useCallback(() => setMembersOpen(false), []);
  useEffect(() => setFindOpen(false), [group.threadId]);
  useEffect(() => {
    const onFind = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        setFindOpen(true);
      }
    };
    window.addEventListener("keydown", onFind);
    return () => window.removeEventListener("keydown", onFind);
  }, []);

  const members = useMemo(
    () => group.memberIds.map((id) => state.bots.find((b) => b.id === id)).filter((b): b is Bot => Boolean(b)),
    [group.memberIds, state.bots],
  );
  const setupPending = !remoteClient && roomNeedsSetup(group);

  // One mascot per member working in THIS thread; each finished reply pops in
  // above while the members still working keep their own rows.
  const lastGroupMessage = group.messages.at(-1);
  const memberTurns = useRoomMemberTurns();
  const working = useMemo(() => roomPresenceMembers({
    threadId: group.threadId,
    activeBotIds: group.activeBotIds,
    activeMemberTurns: group.activeMemberTurns,
    turns: memberTurns,
    messages: group.messages,
  }).flatMap((entry) => {
    const bot = members.find((member) => member.id === entry.botId);
    // a member whose own reply already landed is done talking; a reply from
    // before this turn started is its previous one and says nothing
    const done = !showWorkingDots(true, lastGroupMessage, bot?.id) && (entry.since === null || lastGroupMessage!.at >= entry.since);
    return bot && !done ? [{ ...entry, bot }] : [];
  }), [group.threadId, group.activeBotIds, group.activeMemberTurns, memberTurns, group.messages, members, lastGroupMessage]);
  // A member busy elsewhere takes its turn when free; until then the room
  // works with no speaker, and the presence row names who it is waiting on.
  const awaited = working.length ? undefined : members.find(
    (b) => b.id === awaitedMemberId(group.working, group.busyBotId, lastGroupMessage),
  );
  const waiting = working.length > 0 || awaited !== undefined;
  const wasWaiting = useRef(false);
  const [popping, setPopping] = useState<{ id: string; botId?: string; streamed?: boolean } | null>(null);
  const streamedAt = useRef(new Map<string, number>()).current;
  const poppingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (poppingTimer.current) clearTimeout(poppingTimer.current);
  }, []);
  useLayoutEffect(() => {
    if (poppingTimer.current) clearTimeout(poppingTimer.current);
    poppingTimer.current = null;
    wasWaiting.current = false;
    setPopping(null);
  }, [group.id, group.threadId]);
  useEffect(() => {
    if (waiting) wasWaiting.current = true;
  }, [waiting]);
  useLayoutEffect(() => {
    if (lastGroupMessage?.role !== "bot" || lastGroupMessage.kind !== "text" || !wasWaiting.current) return;
    wasWaiting.current = false;
    const botId = lastGroupMessage.from?.botId;
    setPopping({
      id: lastGroupMessage.id,
      botId,
      // a reply the room already watched stream in is already on screen
      streamed: botId !== undefined && Date.now() - (streamedAt.get(botId) ?? 0) < 2000,
    });
    const messageId = lastGroupMessage.id;
    if (poppingTimer.current) clearTimeout(poppingTimer.current);
    poppingTimer.current = setTimeout(() => {
      poppingTimer.current = null;
      setPopping((current) => current?.id === messageId ? null : current);
    }, 520);
  }, [
    lastGroupMessage?.id,
    lastGroupMessage?.role,
    lastGroupMessage?.kind,
    lastGroupMessage?.from?.botId,
  ]);
  const presenceRows = useMemo(() => {
    const rows = working.map(({ bot, since, tool }) => ({
      bot, since, label: `${bot.name} · ${liveActivityLabel(tool ?? undefined)}`,
      gesture: turnGesture({ toolInFlight: tool !== null, toolName: tool?.tool?.name }),
    }));
    if (awaited) rows.push({ bot: awaited, since: null, label: liveActivityLabel(lastGroupMessage), gesture: turnGesture({ waiting: true }) });
    return rows;
  }, [working, awaited, lastGroupMessage]);
  // the member whose reply just landed hands its row to that reply
  const poppingMember = popping && !presenceRows.some((row) => row.bot.id === popping.botId)
    ? members.find((member) => member.id === popping.botId) ?? members[0]
    : undefined;

  // Windowed transcript, mirroring ChatView: only a tail of the room mounts;
  // the anchored boundary re-tails on a render-phase reset when the room (or
  // its thread) changes. Working dots below stay on the FULL list's tail.
  const transcriptKey = `${group.id}:${group.threadId}`;
  const [transcriptWindow, setTranscriptWindow] = useState<{
    key: string;
    start: number;
    end: number | null;
  }>(() => ({
    key: transcriptKey,
    start: tailWindowStart(group.messages.length),
    end: null,
  }));
  if (transcriptWindow.key !== transcriptKey) {
    setTranscriptWindow({ key: transcriptKey, start: tailWindowStart(group.messages.length), end: null });
  }
  const {
    visible: windowedMessages,
    hiddenCount,
    laterCount,
    startIndex,
    endIndex,
  } = useMemo(
    () => resolveTranscriptWindow(group.messages, transcriptWindow.start, TRANSCRIPT_WINDOW_SIZE, transcriptWindow.end),
    [group.messages, transcriptWindow.start, transcriptWindow.end],
  );

  const setBottomFollow = useCallback((next: boolean) => {
    followRef.current = next;
    setFollow(next);
  }, []);
  useBottomFollowResize(scrollRef, transcriptRef, followRef, setupPending ? null : transcriptKey);

  useEffect(() => setBottomFollow(true), [group.id, setBottomFollow]);

  const appliedFocus = useRef<number | null>(null);
  useEffect(() => {
    const focus = state.focusMessage;
    if (!focus || focus.consumed || focus.threadId !== group.threadId || appliedFocus.current === focus.nonce) return;
    const targetIndex = group.messages.findIndex((message) => message.id === focus.messageId);
    if (targetIndex < 0) return;
    appliedFocus.current = focus.nonce;
    const range = focusWindowRange(group.messages.length, targetIndex);
    setBottomFollow(false);
    setTranscriptWindow({ key: transcriptKey, start: range.start, end: range.end });
  }, [group.messages, group.threadId, setBottomFollow, state.focusMessage, transcriptKey]);
  useFocusMessage(group.threadId, group.messages.length > 0);

  useEffect(() => setBulletinDraft(group.bulletin), [group.id, group.bulletin]);
  // an open folder editor belongs to the room it was opened in
  useEffect(() => setFolderOpen(false), [group.id]);
  useEffect(() => setMembersOpen(false), [group.id]);
  useEffect(() => setSettingsOpen(false), [group.id]);
  // deps track the FULL messages.length, so expanding the window (which only
  // changes windowedMessages) can never re-trigger this bottom scrollTo.
  // `follow` is intentionally omitted — see ChatView.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !followRef.current) return;
    el.scrollTo({ top: el.scrollHeight });
    previousScrollTop.current = el.scrollTop;
  }, [group.id, group.messages.length, group.busyBotId, group.working, composerDock.pad]);
  // Stream tokens repaint only their bubble (RoomStreamBubble); the room
  // view itself never re-renders for them and just keeps following here.
  useStreamFrames(group.threadId, () => {
    const el = scrollRef.current;
    if (!el || !followRef.current) return;
    // with 3-4 bots streaming most frames don't grow the transcript past the
    // fold; skip the scroll write (and the scroll event it fires) when the
    // view is already pinned to the bottom
    if (el.scrollHeight - el.clientHeight - el.scrollTop < 1) return;
    el.scrollTo({ top: el.scrollHeight });
    previousScrollTop.current = el.scrollTop;
  });

  // Expanding prepends rows: capture the height first, then after the commit
  // shift scrollTop by the growth so the message under the cursor stays put
  // (browser scroll anchoring is disabled on this container).
  // The captured height belongs to the thread it was taken in: a switch
  // between the capture and the commit would otherwise shift the new
  // thread's viewport by the old one's growth.
  const preExpandHeight = useRef<{ key: string; height: number } | null>(null);
  const showEarlier = () => {
    preExpandHeight.current = scrollRef.current ? { key: transcriptKey, height: scrollRef.current.scrollHeight } : null;
    // expanding means reading scrollback — never let a mid-expand stream
    // event pin the viewport back to the bottom
    setBottomFollow(false);
    const start = expandWindowStart(startIndex);
    setTranscriptWindow((w) => ({ ...w, start }));
  };
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const captured = preExpandHeight.current;
    if (!captured || !el) return;
    preExpandHeight.current = null;
    if (captured.key !== transcriptKey) return;
    el.scrollTop += el.scrollHeight - captured.height;
    // keep the resume-follow heuristic from reading the restore as a
    // downward user scroll
    previousScrollTop.current = el.scrollTop;
    // transcriptKey is a dependency so a switch runs this and drops a capture
    // that belongs to the thread being left.
  }, [transcriptWindow.start, transcriptKey]);

  const showLater = () => {
    setBottomFollow(false);
    const nextEnd = Math.min(group.messages.length, endIndex + TRANSCRIPT_WINDOW_SIZE);
    setTranscriptWindow((w) => ({ ...w, end: nextEnd >= group.messages.length ? null : nextEnd }));
  };

  // Scrollback across the network: the snapshot holds a bounded page, and
  // everything before it is still on the server. Asking for it prepends rows
  // exactly like expanding the local window, so the same height capture keeps
  // the viewport still — here it is applied when the transcript grows at the
  // front rather than when the boundary moves.
  const olderPending = Boolean(state.loadingOlder[group.threadId]);
  const loadOlder = () => {
    preExpandHeight.current = scrollRef.current ? { key: transcriptKey, height: scrollRef.current.scrollHeight } : null;
    setBottomFollow(false);
    dispatch({ type: "loadOlderMessages", threadId: group.threadId });
  };
  const oldestId = group.messages[0]?.id;
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const captured = preExpandHeight.current;
    if (!captured || !el) return;
    preExpandHeight.current = null;
    if (captured.key !== transcriptKey) return;
    el.scrollTop += el.scrollHeight - captured.height;
    previousScrollTop.current = el.scrollTop;
  }, [oldestId, transcriptKey]);

  const atEnd = () => {
    const el = scrollRef.current;
    return !el || el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_FOLLOW_THRESHOLD;
  };

  const saveBulletin = () => {
    setBulletinOpen(false);
    if (bulletinDraft !== group.bulletin) {
      dispatch({ type: "patchGroup", groupId: group.id, patch: { bulletin: bulletinDraft } });
    }
  };

  const roomFields = group as Group & RoomViewFields;
  const memberMauses = <RoomRoster room={roomFields} members={members} max={5} showWorking={false} />;

  return (
    <main className="relative flex h-full min-w-0 flex-1 flex-col bg-app">
      <GroupCallOverlay group={group} members={members} />
      {membersOpen && !remoteClient && !group.dm && (
        <ManageMembersPanel group={group} onClose={closeMembers} triggerRef={membersTriggerRef} />
      )}
      {/* Header: the room is one centered pill (avatars + name); only the
          everyday controls stay on the right, the rest live in room settings. */}
      <div
        style={headerDragStyle}
        className={cn(
          "grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 px-5 py-3",
          // Room for the drawer button, which overlays this corner below md.
          "pl-11 md:pl-5",
        )}
      >
        <div className="flex min-w-0 items-center" style={headerNoDragStyle}>
          {!setupPending && !group.dm && <GroupTaskPicker group={group} />}
        </div>
        <div className="flex min-w-0 justify-center" style={headerNoDragStyle}>
          {group.dm || remoteClient ? (
            <span className={ROOM_NAME_PILL}>
              {memberMauses}
              <span className="truncate">{group.name}</span>
            </span>
          ) : (
            // Click the pill to manage members.
            <button
              ref={membersTriggerRef}
              type="button"
              onClick={() => setMembersOpen(true)}
              title={t("room.members.manage")}
              aria-label={`${group.name}, ${
                members.length === 1
                  ? t("room.members.ariaOne")
                  : t("room.members.ariaMany", { count: members.length })
              }`}
              className={cn(ROOM_NAME_PILL, "transition-colors duration-150 hover:bg-raised")}
            >
              {memberMauses}
              <span className="truncate">{group.name}</span>
            </button>
          )}
        </div>
        <div
          className="flex items-center justify-end gap-1"
          // The caption buttons sit over the header's right end; drop this
          // control row 16px (visual only) below the 26px overlay.
          style={controlsShiftStyle}
        >
          <button
            type="button"
            onClick={() => setFindOpen((open) => !open)}
            aria-label={t("chat.find")}
            aria-pressed={findOpen}
            className={cn(
              "rounded-full p-1.5 hover:bg-raised",
              findOpen ? "text-accent" : "text-ink-secondary hover:text-ink",
            )}
            title={t("chat.findShortcut")}
          >
            <Search size={18} />
          </button>
          {!group.dm && <TerminalButton target={{ botId: group.id, threadId: group.threadId, name: group.name }} className="rounded-full" />}
          {!remoteClient && <ToolCallsToggle />}
          <GroupCallButton group={group} members={members} />
          <ExportTranscriptMenu
            title={group.name}
            messages={group.messages}
            isGroup
          />
          {!remoteClient && !group.dm && <button type="button" aria-label="Room settings" aria-expanded={settingsOpen} onClick={() => setSettingsOpen(open => !open)} className={cn("rounded-full p-1.5 hover:bg-raised", settingsOpen ? "text-accent" : "text-ink-secondary hover:text-ink")}><Settings2 size={18} /></button>}
        </div>
      </div>

      {settingsOpen && !remoteClient && !group.dm && <RoomSettings key={group.id} group={roomFields} members={members} setupPending={setupPending} onToggleFolder={() => setFolderOpen((open) => !open)} onClose={() => setSettingsOpen(false)} />}

      {findOpen && <ChatFindBar threadId={group.threadId} onClose={() => setFindOpen(false)} />}

      {/* Bulletin: one pinned line; click to edit */}
      {!setupPending && <div className="w-full px-5">
        {bulletinOpen ? (
          <div className="mb-1 rounded-lg border border-hairline/40 bg-panel p-2">
            <textarea
              autoFocus
              value={bulletinDraft}
              onChange={(e) => setBulletinDraft(e.target.value)}
              onBlur={saveBulletin}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) saveBulletin();
                if (e.key === "Escape") {
                  setBulletinDraft(group.bulletin);
                  setBulletinOpen(false);
                }
              }}
              placeholder={t("room.bulletin.placeholder")}
              rows={4}
              className="w-full resize-none bg-transparent text-[13px] leading-relaxed text-ink placeholder:text-ink-secondary focus:outline-none"
            />
          </div>
        ) : (
          <button
            disabled={remoteClient}
            onClick={() => { if (!remoteClient) setBulletinOpen(true); }}
            className={cn("mb-1 flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left", !remoteClient && "hover:bg-raised/40")}
            title={t("room.bulletin.title")}
          >
            <Pin size={12} className="shrink-0 text-ink-secondary" />
            <span className={cn("truncate text-[12.5px]", group.bulletin ? "text-ink-secondary" : "text-ink-secondary/60")}>
              {group.bulletin.split("\n")[0] || (remoteClient ? t("room.bulletin.none") : t("room.bulletin.add"))}
            </span>
          </button>
        )}
      </div>}

      {/* Working folder card — the chip in the header toggles it */}
      {!setupPending && folderOpen && !group.dm && (
        <div className="w-full px-5">
          <div className="mb-1">
            <RoomWorkingFolder group={group} />
          </div>
        </div>
      )}

      {/* Pinned message banner — resolves against the room's full transcript */}
      {(() => {
        const pinned = group.messages.find((m) => m.id === group.pinnedMessageId && m.kind === "text");
        const text = pinned ? (pinned.text ?? "").replace(/\s+/g, " ").trim() : "";
        if (!pinned || !text) return null;
        const sender = pinned.role === "user" ? (roomSenderName(pinned, group, meId) ?? t("chat.you")) : (pinned.from?.name ?? t("room.aBot"));
        return (
          <div className="w-full px-5">
            <div className="mb-2 flex items-center gap-2 rounded-lg border border-accent/25 bg-accent/[0.07] px-3 py-1.5">
              <Pin size={12} className="shrink-0 text-accent" />
              <button
                onClick={() => dispatch({ type: "focusMessage", threadId: group.threadId, messageId: pinned.id })}
                className="flex min-w-0 flex-1 items-baseline gap-2 text-left"
                title={t("chat.pinnedJump")}
              >
                <span className="shrink-0 text-[11.5px] font-medium text-accent">{sender}</span>
                <span className="truncate text-[12.5px] text-ink-secondary">{text}</span>
              </button>
              <button
                onClick={() => dispatch({ type: "patchGroup", groupId: group.id, patch: { pinnedMessageId: "" } })}
                aria-label={t("chat.unpinMessage")}
                title={t("chat.unpin")}
                className={cn("shrink-0 rounded p-0.5 text-ink-secondary hover:bg-raised hover:text-ink", remoteClient && "hidden")}
              >
                <X size={13} />
              </button>
            </div>
          </div>
        );
      })()}

      <div className="relative min-h-0 flex-1">
      <div
        ref={scrollRef}
        className="h-full overflow-x-hidden overflow-y-auto px-5 [overflow-anchor:none]"
        onWheel={(e) => {
          if (e.deltaY < 0) setBottomFollow(false);
          else if (atEnd()) setBottomFollow(true);
        }}
        onTouchStart={(e) => (touchY.current = e.touches[0]?.clientY ?? 0)}
        onTouchMove={(e) => {
          const y = e.touches[0]?.clientY ?? 0;
          if (y > touchY.current + 4) setBottomFollow(false);
          else if (atEnd()) setBottomFollow(true);
        }}
        onScroll={() => {
          const el = scrollRef.current;
          if (!el) return;
          const scrollTop = el.scrollTop;
          const resume = shouldResumeBottomFollow({
            following: followRef.current,
            previousScrollTop: previousScrollTop.current,
            scrollTop,
            distanceFromBottom: el.scrollHeight - scrollTop - el.clientHeight,
          });
          previousScrollTop.current = scrollTop;
          if (resume) setBottomFollow(true);
        }}
      >
        {setupPending ? (
          <div className="flex min-h-full w-full items-center py-8">
            <RoomSetup group={group} members={members} />
          </div>
        ) : (
        <div
          ref={transcriptRef}
          className="flex w-full flex-col gap-3"
          style={{ paddingBottom: composerDock.pad }}
          role="log"
          aria-live="polite"
          aria-label={t("room.aria", { name: group.name })}
        >
          {group.messages.length === 0 && (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 py-24 text-center">
              <div className="flex -space-x-2">
                {members.slice(0, 3).map((b) => (
                  <BotAvatar
                    key={b.id}
                    bot={b}
                    state="happy"
                    size={44}
                    motion="none"
                    motionKey={0}
                    animated={false}
                  />
                ))}
              </div>
              <div className="text-[17px] font-semibold text-ink">{group.name}</div>
              <div className="max-w-[380px] text-[14px] text-ink-secondary">
                {groupResponseHint(group, members)}
              </div>
            </div>
          )}
          {hiddenCount > 0 ? (
            <div className="flex justify-center pt-2">
              <button
                onClick={showEarlier}
                className="rounded-full border border-hairline/40 bg-panel px-3 py-1 text-[12.5px] text-ink-secondary hover:bg-raised hover:text-ink"
              >
                {t("chat.showEarlier", { count: hiddenCount })}
              </button>
            </div>
          ) : group.hasMore ? (
            <div className="flex justify-center pt-2">
              <button
                onClick={loadOlder}
                disabled={olderPending}
                className="rounded-full border border-hairline/40 bg-panel px-3 py-1 text-[12.5px] text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-60"
              >
                {olderPending ? t("chat.loadingEarlier") : t("chat.loadEarlier")}
              </button>
            </div>
          ) : null}
          <Transcript
            group={group}
            members={members}
            locale={activeLocale()}
            messages={windowedMessages}
            transcript={group.messages}
            emergingId={popping?.streamed ? undefined : popping?.id}
            streamedAt={streamedAt}
            onReply={selectReply}
          />
          {laterCount > 0 && (
            <div className="flex justify-center">
              <button
                onClick={showLater}
                className="rounded-full border border-hairline/40 bg-panel px-3 py-1 text-[12.5px] text-ink-secondary hover:bg-raised hover:text-ink"
              >
                {t("chat.showLater", { count: laterCount })}
              </button>
            </div>
          )}
          {members.map(member => <RoomStreamBubble key={`stream-${member.id}`} threadId={group.threadId} member={member} members={members} everyone={!group.dm} streamedAt={streamedAt} />)}
          {presenceRows.map((row) => (
            <TurnPresence
              key={row.bot.id}
              // the member's real profile image when it has one, as in ChatView
              avatar={<ActivityMascot bot={row.bot} gesture={row.gesture} />}
              visible
              label={row.label}
              since={row.since}
            />
          ))}
          {poppingMember && (
            <TurnPresence
              key={poppingMember.id}
              avatar={<ActivityMascot bot={poppingMember} gesture="thinking" />}
              visible
              answering
            />
          )}
        </div>
        )}
      </div>

      {!follow && (
        <button
          onClick={() => {
            setBottomFollow(true);
            setTranscriptWindow({ key: transcriptKey, start: tailWindowStart(group.messages.length), end: null });
            requestAnimationFrame(() => {
              scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
            });
          }}
          aria-label={t("chat.jumpToLatestAria")}
          className="animate-pop-in absolute left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-hairline/40 bg-raised px-3 py-1.5 text-[12.5px] text-ink shadow-lg hover:bg-raised-hover"
          style={{ bottom: composerDock.height }}
        >
          <ArrowDown size={13} /> {t("chat.jumpToLatest")}
        </button>
      )}

      <div ref={composerDockRef} className="absolute inset-x-0 bottom-0 z-[2]">
      <Composer
        key={group.threadId}
        group={group}
        members={members}
        locked={setupPending}
        replyTo={replyTo}
        replyToAuthor={replyTo ? roomSenderName(replyTo, group, meId) ?? undefined : undefined}
        onClearReply={clearReply}
        onConsumeReply={consumeReply}
        onRestoreReply={restoreReply}
      />
      </div>
      </div>
    </main>
  );
}
