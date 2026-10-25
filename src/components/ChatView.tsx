import { ModCommands, ModSurfaces } from "@/mods/ModSurfaces";
import { OutputEditor } from "./OutputEditor";
import { withoutMemorySourceMarkers } from "../../shared/memory-source";
import { RequestPhoneLink } from "./RequestPhoneLink";
import { AnswerMemorySources } from "./AnswerMemorySources";
import {ThreadDoneButton} from './ThreadDoneButton';
import { Component, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import {
  AlertTriangle,
  ArrowDown,
  ChevronLeft,
  ChevronRight,
  Bug,
  Monitor,
  Pencil,
  Pin,
  PinOff,
  RefreshCw,
  Search,
  Trash2,
  Webhook,
  X,
} from "lucide-react";
import { WorkingDots } from "@/components/WorkingIndicator";
import { MessageActions, messageActionClass } from "@/components/MessageActions";
import { useSpeech } from "@/lib/tts/useSpeech";
import { useCaptionChrome } from "@/components/DesktopCapabilities";
import {
  api,
  currentTaskBot,
  useStore,
  useStreamText,
  formatTime,
  messageVersions,
  openNotificationTarget,
  visibleMessages,
  type Bot,
  type InstanceInfo,
  type Message,
} from "@/state/store";
import { EngineSetup } from "./EngineSetup";
import { isProviderSafetyBlock, PROVIDER_SAFETY_GUIDANCE, PROVIDER_SAFETY_HELP_URL } from "../../shared/provider-safety";
import { BotAvatar, GroupMark, PersonPhoto, type GroupMarkMember } from "./Avatar";
import { TurnPresence } from "./TurnPresence";
import { ActivityMascot } from "./ActivityMascot";
import { turnGesture } from "../../shared/mascot-choreography";
import { showToolCallsEnabled, skillAuthoringEnabled } from "@/lib/feature-flags";
import { glyphFaceForBot, normalizeState, stateForBot } from "@/lib/mascot";
import { peerLine, type PeerLine } from "@/lib/peer-message";
import { showWorkingDots } from "@/lib/turn-tail";
import { liveActivityLabel } from "@/lib/live-activity";
import { ChatMarkdown } from "./ChatMarkdown";
import { RawMarkdownView, RawToggleAction } from "./RawMarkdownToggle";
import { ThreadChip } from "./ThreadChip";
import { VerifyCard } from "./VerifyCard";
import { ApprovalRuleOffer } from "./ApprovalRuleOffer";
import { askText, runSteps, runSummary, showRun, skillPrompt, skillStaged } from "@/lib/verify-steps";
import { ToolActivity } from "./ToolActivity";
import { ThreadRefText } from "./ThreadRefs";
import { OptionCard, shouldHideOnboardingCard } from "./OptionCard";
import { ApprovalCard } from "./ApprovalCard";
import { QuestionCard } from "./QuestionCard";
import { Composer } from "./Composer";
import { ConversationHeader } from "./ConversationChrome";
import { ConversationActions } from "./workbench/ConversationActions";
import { SharedAttachmentTile } from "./SharedAttachmentTile";
import type { SharedComposer } from "./shared-conversation";
import { ConfirmDialog } from "./ConfirmDialog";

interface SharedChatOptions extends SharedComposer {
  selfId?: string;
  annotateMessage?: (id: string, patch: { reaction?: string; active?: boolean; pinned?: boolean }) => Promise<void>;
  onLatestVisible?: (messageId: string | null) => void;
  faces?: GroupMarkMember[]; actions?: ReactNode; banner?: ReactNode; onOpenDetails?: () => void; onOpenSearch?: () => void;
  loadOlder?: () => Promise<void>; olderLoading?: boolean; historyLoading?: boolean;
  editMessage?: (id: string, text: string) => Promise<void>;
  deleteMessage?: (id: string) => Promise<void>;
  messageMeta?: Record<string, { editedAt?: number; deletedAt?: number; reactions?: Record<string, string[]>; pinnedBy?: string | null }>;
  changeRevision?: number;
  onRequestDelete?: (id: string) => void;
  editingPending?: boolean; editingError?: string;
}

/** Preserve the visible message across remote edits without changing the
 * ordinary new-message follow and older-page scroll behavior. */
class SharedTranscriptAnchor extends Component<{
  revision: number; scroll: RefObject<HTMLDivElement | null>; following: RefObject<boolean>; children: ReactNode;
}> {
  private rows() {
    return [...(this.props.scroll.current?.querySelectorAll<HTMLElement>("[data-mid]") ?? [])].flatMap(row => {
      const element = row.getBoundingClientRect().height > 0 ? row
        : [...row.querySelectorAll<HTMLElement>("*")].find(child => child.getBoundingClientRect().height > 0);
      return element ? [{ id: row.dataset.mid, element }] : [];
    });
  }
  getSnapshotBeforeUpdate(previous: Readonly<typeof this.props>) {
    const viewport = this.props.scroll.current;
    if (!viewport || this.props.following.current || previous.revision === this.props.revision) return null;
    const bounds = viewport.getBoundingClientRect();
    const anchor = this.rows().find(row => row.element.getBoundingClientRect().bottom > bounds.top);
    return anchor ? { id: anchor.id, top: anchor.element.getBoundingClientRect().top } : null;
  }
  componentDidUpdate(_previous: Readonly<typeof this.props>, _state: unknown, anchor: { id?: string; top: number } | null) {
    const viewport = this.props.scroll.current;
    if (!viewport || !anchor) return;
    const row = this.rows().find(candidate => candidate.id === anchor.id);
    if (row) viewport.scrollTop += row.element.getBoundingClientRect().top - anchor.top;
  }
  render() { return this.props.children; }
}
import { ChatFindBar } from "./ChatFindBar";
import { ReplyQuote } from "./ReplyQuote";
import { ConnectorCard } from "./ConnectorCard";
import { OnboardingChatCard } from "./OnboardingChatCard";
import { SecretRequestCard } from "./SecretRequestCard";
import { hasRoutineExecutionTask, RoutineRunCard } from "./RoutineRunCard";
import { AttachmentGallery, collectMessageFiles } from "./AttachmentGallery";
import { ScreenFrame } from "./ScreenFrame";
import { CompactionChip, DigestChip } from "./DigestChip";
import { RenameTitle } from "./RenameTitle";
import { BotActivityPicker } from "./TaskPicker";
import { ExportTranscriptMenu } from "./ExportTranscriptMenu";
import { TerminalButton } from "./TerminalPanel";
import { botControlAvailable, remoteBotHint, remoteBotNotice } from "@/lib/remote-bot";

import { SpeakButton } from "./SpeakButton";
import { BAD, FeedbackButtons, GOOD, ShareButton, SpeakerHeader, TurnActionRow, TurnCopyButton, turnActionClass } from "./TurnActions";
import { BotCallButton, BotCallOverlay } from "./voice-call/BotCall";
import { callIsOn, useCallSnapshot } from "./voice-call/VoiceCall";
import { useRealtimeCall } from "@/lib/voice-call/session";
import { effectivePlace, toolPlace, type EffectivePlace } from "@/lib/place";
import { cn } from "@/lib/cn";
import { activeLocale, t } from "@/lib/i18n";
import { useFocusMessage } from "@/lib/focus-message";
import { groupTranscript, type TranscriptItem } from "@/lib/activity-runs";
import { includeIndex, resolveVirtualRange, rowHeightCache, sameVirtualRange, spanHeight, tailRange, viewportRange, type IndexRange, type VirtualRange } from "@/lib/virtual-range";
import { ActivityRun } from "./ActivityRun";
import { TurnNarrationRun } from "./TurnNarrationRun";
import { webhookMessageView } from "@/lib/webhook-message";
import { splitTranscriptAttachments } from "@/lib/composer-attachments";
import { BOTTOM_FOLLOW_THRESHOLD, shouldResumeBottomFollow, useBottomFollowResize } from "@/lib/bottom-follow";
import { useComposerDockPad } from "@/lib/composer-dock";
import {
  TRANSCRIPT_WINDOW_SIZE,
  expandWindowStart,
  focusWindowRange,
  resolveTranscriptWindow,
} from "@/lib/transcript-window";
import { appendComposerDraft, useReplyDraft } from "@/lib/drafts";
import { isArriving, trackArrivals, type ArrivalState } from "@/lib/message-arrivals";

/** Long user messages collapse behind a fade so pasted walls of text don't
 * bury the conversation; bots get full markdown. */
const USER_COLLAPSE_CHARS = 600;
const USER_COLLAPSE_LINES = 8;
const noop = () => {};
/** Scrolled within this distance of the top, the next older page loads. */
const OLDER_PAGE_TRIGGER_PX = 600;
/** Older pages fetched unasked to fill a thin first page, per thread. */
const MAX_FILL_PAGES = 4;

/** "Today" / "Yesterday" / "Mon, Aug 11" — real dates, not a hardcoded label. */
function dayLabel(at: number): string {
  const d = new Date(at);
  const now = new Date();
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (diffDays === 0) return t("chat.day.today");
  if (diffDays === 1) return t("chat.day.yesterday");
  return d.toLocaleDateString(activeLocale(), { weekday: "short", month: "short", day: "numeric" });
}

function DaySeparator({ at }: { at: number }) {
  return (
    <div className="py-3 text-center text-[13px] text-ink-secondary">
      {dayLabel(at)} {formatTime(at)}
    </div>
  );
}

/** A failed turn: a real error block with a retry, not a truncated pill.
 *
 * A `setup` error — CLI missing, or installed but not signed in — shows what
 * to do instead of a Retry, because retrying hits the same wall every time.
 * Once the engine reports itself fixed the card flips back to Retry, which
 * (with the on-focus re-probe) happens by itself when the user returns from
 * the terminal. */
export function ErrorRow({
  message,
  onRetry,
  setupInstance,
}: {
  message: string;
  onRetry?: () => void;
  setupInstance?: InstanceInfo;
}) {
  return (
    <div className="flex justify-start">
      <div className="w-fit max-w-[min(42rem,78%)] rounded-xl border border-danger/30 bg-danger/10 px-3.5 py-2.5 text-[13.5px] text-danger">
        <div className="flex items-start gap-2">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" />
          <span className="min-w-0 break-words">{message}</span>
        </div>
        {isProviderSafetyBlock(message) ? (
          <p className="mt-2 text-[12.5px] leading-relaxed text-ink-secondary">
            {PROVIDER_SAFETY_GUIDANCE}{" "}
            <a href={PROVIDER_SAFETY_HELP_URL} target="_blank" rel="noreferrer" className="underline">About provider safety checks</a>
          </p>
        ) : setupInstance &&
        !(setupInstance.snapshot.state === "available" && setupInstance.snapshot.authenticated !== false) ? (
          <EngineSetup instance={setupInstance} className="mt-2 text-ink-secondary" />
        ) : (
          onRetry && (
            <button
              onClick={onRetry}
              className="mt-1.5 flex items-center gap-1.5 rounded-full border border-danger/30 px-2.5 py-1 text-[12.5px] hover:bg-danger/15"
            >
              <RefreshCw size={12} /> {t("chat.retry")}
            </button>
          )
        )}
      </div>
    </div>
  );
}

/** One bad markdown node must not white-screen the app — the transcript
 * degrades to a plain-text bubble instead. */
class MessageBoundary extends Component<{ children: ReactNode; fallbackText: string }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed) {
      return (
        <div className="chat-text conversation-bubble w-fit max-w-[min(42rem,78%)] bg-card px-4 py-2.5 whitespace-pre-wrap text-ink">
          {this.props.fallbackText}
        </div>
      );
    }
    return this.props.children;
  }
}

/** Inline editor a user bubble turns into: Enter sends (forking the
 * conversation), Esc cancels. Shift+Enter for a newline, like everywhere. */
function BubbleEditor({
  initial,
  onCancel,
  onSubmit,
  pending = false,
  error,
  saveLabel,
}: {
  initial: string;
  onCancel: () => void;
  onSubmit: (text: string) => void;
  pending?: boolean; error?: string; saveLabel?: string;
}) {
  const [draft, setDraft] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  const submit = () => {
    if (draft.trim() && !pending) onSubmit(draft.trim());
  };
  return (
    <div className="w-full max-w-[min(42rem,78%)] rounded-2xl border border-hairline/40 bg-bubble-user px-4 py-3">
      <textarea
        ref={ref}
        value={draft}
        disabled={pending}
        aria-label="Edit message"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          // isComposing: an IME confirm-Enter must not submit the edit
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
          if (e.key === "Escape") onCancel();
        }}
        rows={Math.min(10, Math.max(2, draft.split("\n").length))}
        className="w-full resize-none bg-transparent text-[15px] leading-relaxed text-ink focus:outline-none"
      />
      {error && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}
      <div className="mt-2 flex items-center justify-end gap-2">
        <button
          onClick={onCancel}
          disabled={pending}
          className="rounded-full px-3 py-1 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink"
        >
          {t("common.cancel")}
        </button>
        <button
          onClick={submit}
          disabled={!draft.trim() || pending}
          className="rounded-full bg-accent px-3 py-1 text-[13px] font-medium text-white disabled:opacity-40"
        >
          {pending ? "Saving…" : saveLabel ?? t("chat.send")}
        </button>
      </div>
    </div>
  );
}

function Bubble({
  bot,
  message,
  emerging = false,
  arriving = false,
  eagerAttachments = false,
  editing,
  isLastBotText,
  onStartEdit,
  onCancelEdit,
  onSubmitEdit,
  onRegenerate,
  replyTarget,
  onReply,
  shared,
}: {
  bot: Bot;
  message: Message;
  emerging?: boolean;
  /** Landed while the chat was open: springs in from its own side. */
  arriving?: boolean;
  eagerAttachments?: boolean;
  editing: boolean;
  isLastBotText: boolean;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSubmitEdit: (text: string) => void;
  onRegenerate?: () => void;
  replyTarget?: Message;
  onReply: () => void;
  shared?: SharedChatOptions;
}) {
  const { state, dispatch } = useStore();
  const remoteClient = window.ogb?.remoteClient?.active === true;
  // A user-role line another bot delivered (ask_bot, delegate_bot,
  // start_thread) is that bot speaking, not the person: it takes the
  // bot side of the chat under the peer's name, with the model-facing
  // provenance note stripped from what the reader sees.
  const peer = shared ? null : peerLine(message);
  const user = message.role === "user" && !peer;
  // people in a shared room are taggable from the composer, so their tags chip too
  const mentionPeers = useMemo(() => shared ? [...(shared.mentionPeople ?? []), ...shared.mentionBots] : state.bots.filter((peer) => peer.id !== bot.id), [shared, state.bots, bot.id]);
  const [expanded, setExpanded] = useState(false);
  const [viewRaw, setViewRaw] = useState(false);
  const [editOutput, setEditOutput] = useState(false);
  const speech = useSpeech();
  const speaking = speech.messageId === message.id && speech.status !== "idle";
  const text = peer ? peer.body : (message.text ?? "");
  const generatedPaths = useMemo(() => message.attachments?.map((attachment) => attachment.path) ?? [], [message.attachments]);
  const linkedFiles = useMemo(() => user ? [] : collectMessageFiles(text, generatedPaths), [user, text, generatedPaths]);
  const webhookView = user ? webhookMessageView(text) : null;
  const attachments = user && !webhookView ? splitTranscriptAttachments(text) : null;
  const visibleText = webhookView?.task ?? attachments?.display ?? text;
  const hasAttachments = Boolean(attachments && (attachments.images.length || attachments.files.length));
  const sharedMeta = shared?.messageMeta?.[message.id];
  const collapsible =
    user && !webhookView && !expanded && (visibleText.length > USER_COLLAPSE_CHARS || visibleText.split("\n").length > USER_COLLAPSE_LINES);

  if (sharedMeta?.deletedAt) return <div className={cn("flex w-full flex-col", user ? "items-end" : "items-start")}>
    <div className={cn("text-sm italic chat-text-tertiary", user && "chat-user-bubble")}>Message removed</div>
  </div>;

  if (user && editing && !webhookView && !hasAttachments) {
    return (
      <div className="flex w-full justify-end">
        <BubbleEditor initial={text} onCancel={onCancelEdit} onSubmit={onSubmitEdit} pending={shared?.editingPending} error={shared?.editingError} saveLabel={shared ? "Save changes" : undefined} />
      </div>
    );
  }

  // Reactions: a room keeps them in its own message meta; a 1:1 thread
  // stores them on the message itself (the server echoes it back patched).
  const sharedReactions = sharedMeta?.reactions ?? {};
  const ownReactions = Object.entries(
    (message.reactions ?? []).reduce<Record<string, string[]>>((all, r) => ({ ...all, [r.emoji]: [...(all[r.emoji] ?? []), r.by] }), {}),
  );
  const allReactions = shared ? Object.entries(sharedReactions) : ownReactions;
  const selfActor = shared ? (shared.selfId ?? "") : "user";
  // in a 1:1 the thumbs in the action row are the only view of 👍/👎 —
  // a chip beside them would say the same thing twice
  const reactionList = shared || user ? allReactions : allReactions.filter(([emoji]) => emoji !== GOOD && emoji !== BAD);
  const feedback = {
    good: Boolean(allReactions.find(([emoji]) => emoji === GOOD)?.[1].includes(selfActor)),
    bad: Boolean(allReactions.find(([emoji]) => emoji === BAD)?.[1].includes(selfActor)),
  };
  const react = shared
    ? shared.annotateMessage
      ? (emoji: string) => void shared.annotateMessage?.(message.id, { reaction: emoji, active: !sharedReactions[emoji]?.includes(selfActor) })
      : undefined
    : remoteClient || bot.remote
      ? undefined
      : (emoji: string) => {
          void api<{ message: Message }>(`/api/threads/${bot.threadId}/messages/${message.id}/reactions`, { method: "POST", body: JSON.stringify({ emoji }) })
            .then(({ message: patched }) => dispatch({ type: "messagePatched", threadId: bot.threadId, message: patched }))
            .catch((cause) => dispatch({ type: "error", message: cause instanceof Error ? cause.message : String(cause) }));
        };

  // "‹ 2/3 ›" under an edited message — every fork it belongs to
  const versions = user && !shared ? messageVersions(bot, message) : [message];
  const versionIndex = versions.findIndex((v) => v.id === message.id);
  const switchTo = (v: Message | undefined) => {
    if (v && !bot.busy) dispatch({ type: "switchBranch", botId: bot.id, threadId: bot.threadId, messageId: v.id });
  };

  const pinButton = !shared && (
    <button
      onClick={() =>
        dispatch({
          type: "updateTask",
          botId: bot.id,
          threadId: bot.threadId,
          patch: { pinnedMessageId: bot.pinnedMessageId === message.id ? "" : message.id },
        })
      }
      aria-label={bot.pinnedMessageId === message.id ? t("chat.unpinMessage") : t("chat.pinMessage")}
      title={bot.pinnedMessageId === message.id ? t("chat.unpinHint") : t("chat.pinHint")}
      className={cn(messageActionClass, remoteClient && "hidden")}
    >
      {bot.pinnedMessageId === message.id ? <PinOff size={14} /> : <Pin size={14} />}
    </button>
  );

  const replyQuote = (
    <>
      {replyTarget && (
        <div className="mb-2">
          <ReplyQuote
            message={replyTarget}
            fallbackName={bot.name}
            compact
            onJump={() =>
              dispatch({ type: "focusMessage", threadId: bot.threadId, messageId: replyTarget.id })
            }
          />
        </div>
      )}
      {shared && message.replyToId && !replyTarget && <div className="mb-2 rounded-lg border-s-2 border-accent/60 bg-inset/70 px-2.5 py-1.5 text-xs text-ink-secondary">Reply to an earlier message</div>}
    </>
  );

  const reactionChips = reactionList.length > 0 && <div className={cn("mt-1 flex flex-wrap items-center gap-1", user ? "justify-end" : "justify-start")}>
    {reactionList.map(([emoji, actors]) => <button key={emoji} type="button" disabled={!react} aria-label={`${emoji}, ${actors.length} reactions`} aria-pressed={actors.includes(selfActor)} onClick={() => react?.(emoji)} className={cn("relative z-[1] flex h-6 items-center gap-1 rounded-full border px-1.5 text-[12px] tabular-nums", actors.includes(selfActor) ? "border-accent/40 bg-accent/15 text-ink" : "chat-hairline bg-app text-ink-secondary", react && "hover:bg-raised")}>
      <span className="text-[13px] leading-none">{emoji}</span>{actors.length > 1 && actors.length}
    </button>)}
  </div>;

  const pinnedNote = shared?.annotateMessage && sharedMeta?.pinnedBy && <div className="mt-1 text-[11px] text-ink-secondary">
    <button type="button" className="rounded-full px-2 py-0.5 hover:bg-raised" onClick={() => void shared.annotateMessage?.(message.id, { pinned: false })}>Pinned · Unpin</button>
  </div>;

  const leadAction = message.leadAction && <div role="status" className="mb-1 rounded-lg border border-line bg-card px-3 py-2 text-xs text-ink-secondary">
    <span className="font-medium">{message.leadAction.status} · {state.bots.find(b => b.id === message.leadAction?.leadBotId)?.name ?? "Lead"}</span>
    <div>{message.leadAction.requiredAction}</div>
    {message.leadAction.resolution && <div>{message.leadAction.resolution.decision} · {message.leadAction.resolution.evidence}</div>}
  </div>;

  if (user) {
    const canEdit = (shared ? Boolean(shared.editMessage) : botControlAvailable(bot, "edit") && !bot.busy) && message.kind === "text" && !webhookView && !hasAttachments;
    return (
      <div className="group flex w-full flex-col items-end" title={new Date(message.at).toLocaleString()}>
        {leadAction}
        {/* chatgpt puts what you attached above your bubble, not inside it */}
        {attachments && (attachments.images.length > 0 || attachments.files.length > 0) && (
          <div className="mb-1 flex w-full justify-end">
            <AttachmentGallery variant="user" images={attachments.images} files={attachments.files} message={{ threadId: bot.threadId, messageId: message.id }} eager={eagerAttachments} className="mb-0" />
          </div>
        )}
        {shared && message.sharedAttachments?.length ? (
          <div className="mb-1 flex max-w-[70%] flex-col items-end gap-1">
            {message.sharedAttachments.map(attachment => <SharedAttachmentTile key={attachment.id} roomId={bot.threadId.slice("shared:".length)} attachment={attachment} />)}
          </div>
        ) : null}
        {(webhookView || visibleText || replyTarget || (shared && message.replyToId)) && (
          <div
            className={cn(
              "w-fit min-w-0",
              emerging && "turn-answer",
              arriving && !emerging && "msg-spring origin-right",
              webhookView
                ? "conversation-bubble max-w-[70%] overflow-hidden border border-accent/25 bg-card text-ink shadow-[0_10px_30px_rgba(0,0,0,0.18)]"
                : "chat-user-bubble whitespace-pre-wrap",
            )}
          >
            {replyQuote}
            {webhookView ? (
              <div className="min-w-[300px] max-w-[520px]">
                <div className="flex items-center gap-2 border-b border-accent/15 bg-accent/[0.055] px-4 py-2.5 text-[11.5px] font-medium text-accent">
                  <Webhook size={13} />
                  <span>{t("chat.webhookTask")}</span>
                </div>
                <div className="chat-text px-4 py-3 whitespace-pre-wrap">{webhookView.task}</div>
                {webhookView.payload && (
                  <details className="border-t border-hairline/30 bg-inset/25 px-4 py-2.5 text-[11.5px] text-ink-secondary">
                    <summary className="cursor-pointer select-none hover:text-ink">{t("chat.viewPayload")}</summary>
                    <pre className="mt-2 max-h-48 overflow-auto rounded-lg border border-hairline/25 bg-black/25 p-3 font-mono text-[10.5px] leading-relaxed whitespace-pre-wrap text-ink-secondary">{webhookView.payload}</pre>
                  </details>
                )}
              </div>
            ) : (
              <>
                {visibleText && (
                  <div
                    className={cn("chat-text", collapsible && "max-h-40 overflow-hidden [mask-image:linear-gradient(to_bottom,black_60%,transparent)]")}
                  >
                    <ThreadRefText text={visibleText} peers={mentionPeers} />
                  </div>
                )}
                {collapsible && (
                  <button onClick={() => setExpanded(true)} className="mt-1 text-[12.5px] chat-text-secondary hover:text-ink">
                    {t("chat.showFull")}
                  </button>
                )}
                {expanded && (
                  <button onClick={() => setExpanded(false)} className="mt-1 text-[12.5px] chat-text-secondary hover:text-ink">
                    {t("chat.showLess")}
                  </button>
                )}
              </>
            )}
            {sharedMeta?.editedAt && <div className="mt-1 text-[10px] chat-text-tertiary" title={new Date(sharedMeta.editedAt).toLocaleString()}>edited</div>}
          </div>
        )}
        {message.steerDelivery === "outcome_unknown" ? (
          <div className="mt-1 text-[11px] text-warning" title={t("chat.steerUnknownHint")}>
            {t("chat.steerUnknown")}
          </div>
        ) : message.steered && (
          <div className="mt-1 text-[11px] chat-text-tertiary" title={t("chat.sentMidTurnHint")}>
            {t("chat.sentMidTurn")}
          </div>
        )}
        {reactionChips}
        <TurnActionRow persistent={false} align="end" at={message.at}>
          {versions.length > 1 && botControlAvailable(bot, "versions") && (
            <div className="flex items-center gap-0.5 text-[12px] chat-text-tertiary tabular-nums">
              <button
                onClick={() => switchTo(versions[versionIndex - 1])}
                disabled={versionIndex <= 0 || bot.busy}
                className={turnActionClass}
                title={t("chat.previousVersion")}
                aria-label={t("chat.previousVersion")}
              >
                <ChevronLeft size={16} />
              </button>
              <span>{versionIndex + 1}/{versions.length}</span>
              <button
                onClick={() => switchTo(versions[versionIndex + 1])}
                disabled={versionIndex >= versions.length - 1 || bot.busy}
                className={turnActionClass}
                title={t("chat.nextVersion")}
                aria-label={t("chat.nextVersion")}
              >
                <ChevronRight size={16} />
              </button>
            </div>
          )}
          {Boolean(visibleText.trim()) && <TurnCopyButton text={visibleText} label={t("chat.copyMessage")} />}
          {canEdit && (
            <button onClick={onStartEdit} aria-label={t("chat.editMessage")} title={t("chat.editMessage")} className={turnActionClass}>
              <Pencil size={18} aria-hidden="true" />
            </button>
          )}
          <MessageActions side="user" variant="turn" onReply={onReply} onReact={react}>
            {shared?.annotateMessage && !sharedMeta?.pinnedBy && <button type="button" onClick={() => void shared.annotateMessage?.(message.id, { pinned: true })} aria-label={t("chat.pinMessage")} title={t("chat.pinMessage")} className={messageActionClass}><Pin size={14} /></button>}
            {shared?.deleteMessage && <button type="button" onClick={() => shared.onRequestDelete?.(message.id)} aria-label="Remove message" title="Remove message" className={cn(messageActionClass, "text-danger")}><Trash2 size={14} /></button>}
            {pinButton}
          </MessageActions>
        </TurnActionRow>
        {pinnedNote}
      </div>
    );
  }

  const bodyText = text ? withoutMemorySourceMarkers(text) : "";
  return (
    <div className="group flex w-full min-w-0 flex-col items-start">
      {leadAction}
      {peer && <PeerLabel peer={peer} />}
      <div
        className={cn(
          "w-full min-w-0 text-ink",
          emerging && "turn-answer",
          arriving && !emerging && "chat-enter",
        )}
        title={new Date(message.at).toLocaleString()}
      >
        {replyQuote}
        {shared && message.sharedAttachments?.map(attachment => <SharedAttachmentTile key={attachment.id} roomId={bot.threadId.slice("shared:".length)} attachment={attachment} />)}
        <MessageBoundary key={viewRaw ? "raw" : "rendered"} fallbackText={text || t("chat.generatedImage")}>
          <AttachmentGallery images={generatedPaths} files={linkedFiles} message={{ threadId: bot.threadId, messageId: message.id }} className={text ? undefined : "mb-0"} eager={eagerAttachments} />
          {viewRaw && text ? (
            <RawMarkdownView text={text} />
          ) : text ? (
            <ChatMarkdown text={bodyText} mentionPeers={mentionPeers} message={{ threadId: bot.threadId, messageId: message.id, uiState: message.uiState }} />
          ) : null}
        </MessageBoundary>
        {editOutput && <OutputEditor bot={bot} message={message} onClose={() => setEditOutput(false)} />}
        {!shared && !peer && text && <AnswerMemorySources botId={bot.id} threadId={bot.threadId} messageId={message.id} text={text} />}
        {sharedMeta?.editedAt && <div className="mt-1 text-[10px] chat-text-tertiary" title={new Date(sharedMeta.editedAt).toLocaleString()}>edited</div>}
      </div>
      {reactionChips}
      <TurnActionRow persistent={(isLastBotText && !bot.busy) || viewRaw || speaking} at={message.at}>
        {text && <TurnCopyButton text={bodyText} />}
        {!shared && message.kind === "text" && text && !peer && (
          <SpeakButton text={text} botId={bot.id} messageId={message.id} voiceId={bot.voice} iconSize={18} className={cn(turnActionClass, "opacity-100")} />
        )}
        {react && text && <FeedbackButtons active={feedback} onReact={react} />}
        {text && <ShareButton text={bodyText} />}
        <MessageActions side="bot" variant="turn" forceOpen={viewRaw || speaking} onReply={onReply} onReact={react}>
          {!shared && !peer && message.kind === "text" && text && !bot.id.startsWith("rb-") && !bot.busy && <button type="button" className={messageActionClass} aria-label="edit and comment on output" title="edit and comment on output" onClick={() => setEditOutput(true)}><Pencil size={14} /></button>}
          {text && <RawToggleAction active={viewRaw} onToggle={() => setViewRaw((r) => !r)} className="opacity-100" />}
          {!shared && isLastBotText && !bot.busy && onRegenerate && (
            <button
              onClick={onRegenerate}
              aria-label={t("chat.regenerate")}
              title={t("chat.regenerate")}
              className={messageActionClass}
            >
              <RefreshCw size={14} />
            </button>
          )}
          {pinButton}
        </MessageActions>
      </TurnActionRow>
      {pinnedNote}
    </div>
  );
}

/** Who wrote a relayed line and how it arrived, above the bubble — the
 * same shape as a room's cluster label. Looked up by id, then by name for
 * rows that predate Message.peerAsk; a peer since renamed or deleted still
 * shows the name the line carries. */
function PeerLabel({ peer }: { peer: PeerLine }) {
  const { state } = useStore();
  const author =
    state.bots.find((b) => b.id === peer.botId) ?? state.bots.find((b) => b.name === peer.name);
  const how =
    peer.delivery === "delegate_bot"
      ? t("chat.peer.delegated")
      : peer.delivery === "start_thread"
        ? t("chat.peer.openedThread")
        : t("chat.peer.asked");
  return (
    <div className="mb-1 flex items-center gap-1.5 pl-0.5" data-testid="peer-label">
      <BotAvatar
        bot={author ?? { name: peer.name, color: "blue" }}
        state={normalizeState(author?.mascotExpression) ?? undefined}
        size={16}
        motion="none"
        motionKey={0}
        animated={false}
      />
      <span className="text-[11px] font-medium text-ink-secondary">{peer.name}</span>
      <span className="text-[11px] text-ink-secondary/70">· {how}</span>
    </div>
  );
}

/** A tool run: spinner while live, check/cross once settled. */
function ActivityChip({ message, place = "auto" }: { message: Message; place?: EffectivePlace }) {
  const { state, dispatch } = useStore();
  const tool = message.tool;
  if (!tool) return null;
  if (message.threadRef) return <ThreadChip message={message} />;
  // bot⇄bot comm chip: opens the channel where the exchange lives
  const comm = message.comm;
  if (comm) {
    const withBot = state.bots.find((b) => b.id === comm.withBotId);
    return (
      <div className="flex justify-start">
        <button
          onClick={() => dispatch({ type: "select", id: comm.groupId })}
          title={t("chat.openConversationWith", { name: comm.withName })}
          className="flex items-center gap-2 rounded-full border border-hairline/40 bg-panel px-3 py-1.5 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink"
        >
          <BotAvatar bot={withBot ?? { name: comm.withName, color: comm.withColor }} size={16} />
          <span className="max-w-[480px] truncate">{tool.name}</span>
          <ChevronRight size={13} />
        </button>
      </div>
    );
  }
  return <ToolActivity stopReason={message.turnOutcome?.stopReason} tool={tool} place={toolPlace(tool.name, place)} />;
}

type RowItem = TranscriptItem;

function rowKey(item: RowItem): string {
  return item.kind === "message" ? item.message.id : item.id;
}

/** First-sight height guess (row padding included) until the row is
 * measured; close enough that spacers rarely jolt the scrollbar. */
function estimateRowHeight(item: RowItem): number {
  if (item.kind !== "message") return 48;
  const m = item.message;
  switch (m.kind) {
    case "activity": case "digest": case "compaction": return 44;
    case "screen": return 360;
    case "options": case "secret": case "connector": case "routine.run": return 180;
    default: {
      const length = m.text?.length ?? 0;
      return 52 + Math.min(600, Math.ceil(length / 90) * 22);
    }
  }
}

/** Who a row speaks for, for the speaker header: the person's own lines
 * and relayed peer lines carry their own label, so they return null. */
function rowSpeaker(item: RowItem): string | null {
  if (item.kind !== "message") return "bot";
  const m = item.message;
  if (m.role === "user") return null;
  if (m.kind === "compaction" || m.kind === "digest") return null;
  return m.from?.botId ?? m.from?.name ?? "bot";
}

/** Rows that are known to render nothing are left out before windowing, so
 * they never take a spacer slot or a gap. Mirrors TranscriptRow's nulls. */
function rowRenders(item: RowItem, showToolCalls: boolean, transcript: Message[]): boolean {
  if (item.kind === "run") return showToolCalls;
  if (item.kind === "turn") return showToolCalls || item.messages.some((message) => message.kind === "text");
  const m = item.message;
  switch (m.kind) {
    case "secret": return Boolean(m.secret);
    case "connector": return Boolean(m.connector);
    case "options": return !(m.card?.requestId && (m.card.questionRequest || m.card.tool)) ? !shouldHideOnboardingCard(m, transcript) : true;
    case "activity": return Boolean(m.tool?.name.startsWith("error:")) || showToolCalls || Boolean(m.comm || m.threadRef);
    case "digest": return showToolCalls;
    case "screen": return Boolean(m.png);
    default: return true;
  }
}

/** Bot props that matter to a row. The message list itself changes on every
 * event and rows never read it for anything a new row would not also get. */
function sameRowBot(a: Bot, b: Bot): boolean {
  if (a === b) return true;
  const keys = Object.keys(a) as (keyof Bot)[];
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => key === "messages" || a[key] === b[key]);
}

function sameRowItem(a: RowItem, b: RowItem): boolean {
  if (a === b) return true;
  if (a.kind === "message" || b.kind === "message") {
    return a.kind === "message" && b.kind === "message" && a.message === b.message;
  }
  if (a.kind !== b.kind || a.id !== b.id || a.messages.length !== b.messages.length) return false;
  if (a.kind === "turn" && b.kind === "turn" && (a.label !== b.label || a.steps.length !== b.steps.length)) return false;
  return a.messages.every((message, index) => message === b.messages[index]);
}

interface TranscriptRowProps {
  item: RowItem;
  newDay: boolean;
  /** first row of a bot's reply: avatar + name above it */
  speaker: boolean;
  bot: Bot;
  shared?: SharedChatOptions;
  showToolCalls: boolean;
  place: EffectivePlace;
  focusedId: string | null;
  editing: boolean;
  isLastBotText: boolean;
  emerging: boolean;
  arriving: boolean;
  eagerAttachments: boolean;
  /** this row is the newest and a retry is allowed */
  canRetry: boolean;
  engine: InstanceInfo | undefined;
  onStartEdit: (id: string) => void;
  onCancelEdit: () => void;
  onSubmitEdit: (id: string, text: string) => void;
  onRegenerate?: () => void;
  onReply: (message: Message) => void;
}

/** One transcript row. Memoized on its own message(s) and flags, so a new
 * row or a store change re-renders the rows it touches, not the thread. */
const TranscriptRow = memo(function TranscriptRow({
  item, newDay, speaker, bot, shared, showToolCalls, place, focusedId, editing, isLastBotText, emerging, arriving,
  eagerAttachments, canRetry, engine, onStartEdit, onCancelEdit, onSubmitEdit, onRegenerate, onReply,
}: TranscriptRowProps) {
  const first = item.kind === "message" ? item.message : item.messages[0];
  const voice = speaker ? first.from : undefined;
  const header = speaker ? (
    <div className="-mb-1">
      <SpeakerHeader
        bot={voice ? shared?.mentionBots.find((candidate) => candidate.id === voice.botId) ?? { name: voice.name, color: voice.color ?? bot.color } : bot}
        name={voice?.name ?? bot.name}
        person={voice?.person}
      />
    </div>
  ) : null;
  if (item.kind === "turn") {
    const shown = showToolCalls ? item.messages : item.messages.filter((message) => message.kind === "text");
    if (!shown.length) return null;
    const label = item.label;
    return (
      <>
        {newDay && <DaySeparator at={first.at} />}
        {header}
        <TurnNarrationRun label={label} forceOpen={item.messages.some((message) => message.id === focusedId)}>
          {shown.map((message) => (
            <div key={message.id} className="contents" data-mid={message.id}>
              {message.kind === "activity" ? <ActivityChip message={message} place={place} /> : (
                <Bubble
                  bot={bot}
                  message={message}
                  shared={shared}
                  editing={false}
                  isLastBotText={false}
                  onStartEdit={noop}
                  onCancelEdit={noop}
                  onSubmitEdit={noop}
                  replyTarget={message.replyToId
                    ? bot.messages.find((candidate) => candidate.id === message.replyToId)
                    : undefined}
                  onReply={() => onReply(message)}
                />
              )}
            </div>
          ))}
        </TurnNarrationRun>
      </>
    );
  }
  if (item.kind === "run") {
    if (!showToolCalls) return null;
    return (
      <>
        {newDay && <DaySeparator at={first.at} />}
        {header}
        <ActivityRun messages={item.messages} forceOpen={item.messages.some((step) => step.id === focusedId)}>
          {item.messages.map((step) => (
            <div key={step.id} className="contents" data-mid={step.id}>
              <ActivityChip message={step} place={place} />
            </div>
          ))}
        </ActivityRun>
      </>
    );
  }
  const m = item.message;
  const row = (() => {
    switch (m.kind) {
      case "secret":
        if (!m.secret) return null;
        return bot.remote ? <RemoteOnlyCard bot={bot} /> : <SecretRequestCard botId={bot.id} threadId={bot.threadId} message={m} />;
      case "connector":
        if (!m.connector) return null;
        return bot.remote ? <RemoteOnlyCard bot={bot} /> : <ConnectorCard botId={bot.id} threadId={bot.threadId} message={m} />;
      case "options": {
        // a live permission ask gets the approval box; a structured
        // ask gets the question box; anything else keeps the list
        // card. The first-run quiz drops out once they talk (rowRenders).
        // Cards are bot-authored and persisted, so one that will not
        // draw must fall back to its text on every open, not take the
        // whole page down every time this chat is selected.
        const card = m.card?.requestId && m.card.questionRequest ? (
          <QuestionCard threadId={bot.threadId} bot={bot} message={m} />
        ) : m.card?.requestId && m.card.tool ? (
          <ApprovalCard bot={bot} message={m} />
        ) : (
          <OptionCard botId={bot.id} threadId={bot.threadId} message={m} />
        );
        return (
          <MessageBoundary fallbackText={m.card?.subtitle || m.card?.title || ""}>
            {card}
            {!bot.remote && m.card?.requestId && (m.card.tool || m.card.questionRequest) && !m.card.answered && !m.card.dismissed && <RequestPhoneLink botId={bot.id} threadId={bot.threadId} messageId={m.id} requestId={m.card.requestId} />}
          </MessageBoundary>
        );
      }
      case "routine.run":
        return <RoutineRunRow bot={bot} message={m} />;
      case "activity": {
        // a failed turn is an error, not a tool run — render it as one.
        // bot⇄bot comm chips and opened-thread chips stay because they
        // link to another conversation.
        // plain tool runs stay out unless Settings → Tool calls is on.
        if (m.tool?.name.startsWith("error:")) {
          return (
            <ErrorRow
              message={m.tool.name.slice(6).trim()}
              onRetry={canRetry ? onRegenerate : undefined}
              setupInstance={m.tool.setup ? engine : undefined}
            />
          );
        }
        if (!showToolCalls && !m.comm && !m.threadRef) return null;
        return <ActivityChip message={m} place={place} />;
      }
      case "digest":
        // the summary of the turn's tool chips: shown under the same setting
        return showToolCalls ? <DigestChip message={m} /> : null;
      case "compaction":
        return <CompactionChip message={m} />;
      case "screen":
        return m.png ? <ScreenFrame png={m.png} mime={m.mime} /> : null;
      default: {
        const bubble = (
          <Bubble
            bot={bot}
            message={m}
            shared={shared}
            emerging={emerging}
            arriving={arriving}
            eagerAttachments={eagerAttachments}
            editing={editing}
            isLastBotText={isLastBotText}
            onStartEdit={() => onStartEdit(m.id)}
            onCancelEdit={onCancelEdit}
            onSubmitEdit={(text) => onSubmitEdit(m.id, text)}
            onRegenerate={onRegenerate}
            replyTarget={m.replyToId ? bot.messages.find((candidate) => candidate.id === m.replyToId) : undefined}
            onReply={() => onReply(m)}
          />
        );
        if (m.routineRun) {
          return (
            <div className="flex flex-col gap-1">
              {bubble}
              <RoutineFooter bot={bot} message={m} />
            </div>
          );
        }
        const card = m.onboarding?.card?.kind;
        return card === "engine" || card === "suggestions" ? (
          <div className="flex flex-col gap-2.5">
            {bubble}
            <OnboardingChatCard bot={bot} message={m} />
          </div>
        ) : bubble;
      }
    }
  })();
  if (!row) return null;
  return (
    <>
      {newDay && <DaySeparator at={m.at} />}
      {header}
      {row}
    </>
  );
}, (previous, next) => {
  const keys = Object.keys(next) as (keyof TranscriptRowProps)[];
  return keys.every((key) => {
    if (key === "item") return sameRowItem(previous.item, next.item);
    if (key === "bot") return sameRowBot(previous.bot, next.bot);
    return previous[key] === next[key];
  });
});

/** A routine run card reads the roster to know whether its execution thread
 * can still be opened; only this row subscribes to that. */
function RoutineRunRow({ bot, message }: { bot: Bot; message: Message }) {
  const { state, dispatch } = useStore();
  const executionThreadId = message.routineRun?.executionThreadId;
  const canOpen = executionThreadId && state.bots.some((candidate) =>
    candidate.threadId === executionThreadId || hasRoutineExecutionTask(candidate.tasks, executionThreadId)
  );
  return (
    <RoutineRunCard
      message={message}
      onOpen={canOpen && executionThreadId
        ? () => openNotificationTarget(
            dispatch,
            { botId: bot.id, threadId: executionThreadId },
            state,
          )
        : undefined}
    />
  );
}

/** A routine's result reads as a normal message; this quiet line says which
 * routine sent it and opens the run's own thread. */
function RoutineFooter({ bot, message }: { bot: Bot; message: Message }) {
  const { state, dispatch } = useStore();
  const run = message.routineRun!;
  const executionThreadId = run.executionThreadId;
  const canOpen = executionThreadId && state.bots.some((candidate) =>
    candidate.threadId === executionThreadId || hasRoutineExecutionTask(candidate.tasks, executionThreadId)
  );
  return (
    <div className="pl-1 text-[11px] text-muted-foreground/70">
      from {run.routineName}{message.at ? ` · ${formatTime(message.at)}` : ""}
      {canOpen && executionThreadId && (
        <>
          {" · "}
          <button
            type="button"
            className="underline-offset-2 hover:underline"
            onClick={() => openNotificationTarget(dispatch, { botId: bot.id, threadId: executionThreadId }, state)}
          >
            log
          </button>
        </>
      )}
    </div>
  );
}

/** The settled transcript, memoized as one unit: during streaming every
 * frame re-renders ChatView, but all of these props keep their identity
 * (bot/messages only change on real message events), so the whole list —
 * every markdown tree, every code block — bails out of React work and only
 * the streaming tail below it commits. This is the t3code structural-sharing
 * idea at component granularity.
 *
 * Only rows near the viewport mount (lib/virtual-range): each row is a real
 * box (`data-vkey`) measured by a ResizeObserver, spacers hold the measured
 * height of the rest. A row above the viewport that changes height (first
 * measurement, an image, an expanded fold) shifts scrollTop by the same
 * amount, because the scroller has browser scroll anchoring turned off. */
const MessagesList = memo(function MessagesList({
  bot,
  messages,
  locale,
  transcript,
  editingId,
  lastBotTextId,
  emergingId,
  canRetryLast,
  engine,
  onStartEdit,
  onCancelEdit,
  onSubmitEdit,
  onRegenerate,
  onReply,
  shared,
  scrollRef,
  following,
}: {
  bot: Bot;
  messages: Message[];
  /** Refresh the memoized transcript and its derived turn labels when the
   * language changes, even when the messages themselves stay unchanged. */
  locale: string;
  /** Active-branch messages, including ones outside the mounted window. */
  transcript: Message[];
  editingId: string | null;
  lastBotTextId: string | undefined;
  emergingId?: string | null;
  canRetryLast: boolean;
  /** This bot's engine, for rendering setup help on a `setup` error. */
  engine: InstanceInfo | undefined;
  onStartEdit: (id: string) => void;
  onCancelEdit: () => void;
  onSubmitEdit: (id: string, text: string) => void;
  onRegenerate?: () => void;
  onReply: (message: Message) => void;
  shared?: SharedChatOptions;
  /** The scroller the list virtualizes against. */
  scrollRef: RefObject<HTMLDivElement | null>;
  /** Bottom-follow: while set, the newest rows are the ones mounted. */
  following: RefObject<boolean>;
}) {
  const { state, dispatch } = useStore();
  const showToolCalls = showToolCallsEnabled(state.config);
  // Messages that land while the chat is open spring in; history stays still.
  const arrivals = useRef<ArrivalState | null>(null);
  arrivals.current = trackArrivals(arrivals.current, bot.threadId, transcript, Date.now());
  // Finished tool chips become compact runs; a settled turn's narration and
  // steps become one reversible row while the terminal answer stays visible.
  const items = useMemo(() => shared ? messages.map(message => ({ kind: "message" as const, message })) : groupTranscript(messages), [messages, locale, shared]);
  const rows = useMemo(() => {
    const out: { key: string; item: RowItem; newDay: boolean; speaker: boolean }[] = [];
    // the speaker of the last row that rendered: a new bot reply (or the
    // other bot in a room) gets the avatar + name header, its follow-on
    // rows do not
    let lastSpeaker: string | null = null;
    items.forEach((item, i) => {
      const previous = items[i - 1];
      const prev = previous && (previous.kind === "message" ? previous.message : previous.messages.at(-1));
      const first = item.kind === "message" ? item.message : item.messages[0];
      const newDay = !prev || new Date(prev.at).toDateString() !== new Date(first.at).toDateString();
      if (!rowRenders(item, showToolCalls, transcript)) return;
      const who = rowSpeaker(item);
      const speaker = who !== null && (who !== lastSpeaker || newDay);
      if (item.kind !== "message" || item.message.role === "user" || who !== null) lastSpeaker = who;
      out.push({ key: rowKey(item), item, newDay, speaker });
    });
    return out;
  }, [items, showToolCalls, transcript]);
  // Where this conversation works, for the place icon on screen and page tools.
  const place = effectivePlace(bot, bot.tasks?.find((task) => task.threadId === bot.threadId));
  const newestMessageId = messages.at(-1)?.id;
  const newestUserMessageId = [...messages].reverse().find((message) => message.role === "user")?.id;
  // A search hit inside a folded run has to open it: the fold keeps the
  // row out of the DOM, and there is nothing for the scroll to land on.
  const focus = state.focusMessage;
  const focusedId = focus && !focus.consumed && focus.threadId === bot.threadId ? focus.messageId : null;

  // ---- virtualization ----
  const listRef = useRef<HTMLDivElement>(null);
  const heightCache = useMemo(() => rowHeightCache(bot.threadId), [bot.threadId]);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const heightOf = (row: { key: string; item: RowItem }) => heightCache.get(row.key) ?? estimateRowHeight(row.item);
  const [range, setRange] = useState<VirtualRange | null>(null);
  const computeRange = useCallback((): IndexRange => {
    const current = rowsRef.current;
    const heights = current.map((row) => heightCache.get(row.key) ?? estimateRowHeight(row.item));
    const scroller = scrollRef.current;
    const list = listRef.current;
    const viewport = scroller?.clientHeight || window.innerHeight || 800;
    if (following.current || !scroller || !list) return tailRange(heights, viewport);
    const viewTop = scroller.getBoundingClientRect().top - list.getBoundingClientRect().top;
    return viewportRange(heights, viewTop, viewTop + viewport);
  }, [heightCache, scrollRef, following]);
  const frame = useRef(0);
  const scheduleRange = useCallback(() => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      const current = rowsRef.current;
      if (!current.length) return;
      const next = computeRange();
      const following_ = following.current;
      const nextRange: VirtualRange = {
        startKey: current[next.start].key,
        endKey: following_ || next.end >= current.length ? null : current[next.end].key,
      };
      setRange((previous) => sameVirtualRange(previous, nextRange) ? previous : nextRange);
    });
  }, [computeRange, following]);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    scroller.addEventListener("scroll", scheduleRange, { passive: true });
    window.addEventListener("resize", scheduleRange);
    return () => { scroller.removeEventListener("scroll", scheduleRange); window.removeEventListener("resize", scheduleRange); };
  }, [scrollRef, scheduleRange]);
  // New rows: re-derive after the commit (and after ChatView's prepend
  // restore), never synchronously from a scroll position about to move.
  useEffect(() => { scheduleRange(); }, [rows, scheduleRange]);

  const keys = useMemo(() => rows.map((row) => row.key), [rows]);
  let mounted = resolveVirtualRange(keys, range) ?? computeRange();
  mounted = includeIndex(mounted, focusedId ? rows.findIndex((row) =>
    row.item.kind === "message" ? row.item.message.id === focusedId : row.item.messages.some((message) => message.id === focusedId)) : -1, rows.length);
  const heights = rows.map(heightOf);
  const topSpace = spanHeight(heights, 0, mounted.start);
  const bottomSpace = spanHeight(heights, mounted.end, rows.length);

  // Measure mounted rows; shift the viewport by growth above it. One
  // observer for the list's life; it reads the current thread's cache and
  // scheduler through refs.
  const heightCacheRef = useRef(heightCache);
  heightCacheRef.current = heightCache;
  const scheduleRef = useRef(scheduleRange);
  scheduleRef.current = scheduleRange;
  const observer = useRef<ResizeObserver | null>(null);
  const observed = useRef(new Set<HTMLElement>());
  useLayoutEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    if (!observer.current) {
      observer.current = new ResizeObserver((entries) => {
        const scroller = scrollRef.current;
        const cache = heightCacheRef.current;
        const byKey = new Map(rowsRef.current.map((row) => [row.key, row.item]));
        const viewTop = scroller?.getBoundingClientRect().top ?? 0;
        let shift = 0;
        for (const entry of entries) {
          const element = entry.target as HTMLElement;
          const key = element.dataset.vkey;
          const item = key ? byKey.get(key) : undefined;
          if (!key || !item || !element.isConnected) continue;
          const height = element.offsetHeight;
          const before = cache.get(key) ?? estimateRowHeight(item);
          cache.set(key, height);
          if (height !== before && !following.current && element.getBoundingClientRect().top < viewTop) shift += height - before;
        }
        if (shift && scroller) scroller.scrollTop += shift;
        scheduleRef.current();
      });
    }
    const list = listRef.current;
    const live = new Set(list ? [...list.querySelectorAll<HTMLElement>(":scope > [data-vkey]")] : []);
    for (const element of observed.current) {
      if (!live.has(element)) { observer.current.unobserve(element); observed.current.delete(element); }
    }
    for (const element of live) {
      if (!observed.current.has(element)) { observer.current.observe(element); observed.current.add(element); }
    }
  });
  useEffect(() => () => { observer.current?.disconnect(); observer.current = null; observed.current.clear(); }, []);

  return (
    <>
      {messages.length === 0 && !bot.busy && !shared?.historyLoading && (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 py-24 text-center">
          {shared?.faces ? <GroupMark members={shared.faces} size={64} /> : <BotAvatar bot={bot} state="idle" size={64} motion="none" motionKey={0} />}
          {shared || bot.remote ? <div className="text-[17px] font-semibold text-ink">{bot.name}</div> : <RenameTitle
            value={bot.name}
            onCommit={(name) => {
              if (window.ogb?.remoteClient?.active) {
                void api(`/api/bots/${bot.id}/profile`, { method: "PATCH", body: JSON.stringify({ name }) })
                  .then(({ bot: updated }) => dispatch({ type: "botPatched", bot: updated }))
                  .catch((cause) => dispatch({ type: "error", message: cause instanceof Error ? cause.message : String(cause) }));
              } else {
                dispatch({ type: "updateBot", botId: bot.id, patch: { name } });
              }
            }}
            className="text-[17px] font-semibold text-ink"
            inputClassName="rounded bg-inset px-1.5 py-0.5 text-center text-[17px] font-semibold"
          />}
          <div className="max-w-[360px] text-[14px] text-ink-secondary">
            {shared ? "@mention your bots here — no need to add them" : bot.description || t("chat.emptyPrompt")}
          </div>
        </div>
      )}
      {rows.length > 0 && (
        // -mt-3 cancels the first row's pt-3 against the log's gap-3: rows
        // carry their own gap so a spacer can stand in for any of them.
        <div ref={listRef} className="-mt-3 flex flex-col" data-testid="transcript-rows">
          {topSpace > 0 && <div aria-hidden="true" style={{ height: topSpace }} />}
          {rows.slice(mounted.start, mounted.end).map(({ key, item, newDay, speaker }) => {
            const m = item.kind === "message" ? item.message : undefined;
            return (
              <div key={key} data-vkey={key} data-mid={m?.id} className="flex flex-col gap-3 pt-3 empty:hidden">
                <TranscriptRow
                  item={item}
                  newDay={newDay}
                  speaker={speaker}
                  bot={bot}
                  shared={shared}
                  showToolCalls={showToolCalls}
                  place={place}
                  focusedId={item.kind === "message" ? null : focusedId}
                  editing={editingId === m?.id}
                  isLastBotText={m?.id === lastBotTextId}
                  emerging={m?.id === emergingId}
                  arriving={m ? isArriving(arrivals.current, m.id) : false}
                  eagerAttachments={Boolean(m) && (m?.id === newestMessageId || m?.id === newestUserMessageId)}
                  canRetry={Boolean(m) && m?.id === newestMessageId && canRetryLast}
                  engine={engine}
                  onStartEdit={onStartEdit}
                  onCancelEdit={onCancelEdit}
                  onSubmitEdit={onSubmitEdit}
                  onRegenerate={onRegenerate}
                  onReply={onReply}
                />
              </div>
            );
          })}
          {bottomSpace > 0 && <div aria-hidden="true" style={{ height: bottomSpace }} />}
        </div>
      )}
    </>
  );
});

/** Secret and connector requests are answered on the Mac the bot lives on. */
function RemoteOnlyCard({ bot }: { bot: Bot }) {
  return (
    <div className="rounded-lg border border-hairline/40 bg-panel px-3 py-2 text-[12.5px] text-ink-secondary">
      {bot.name} is asking for something only its own Mac can provide. Answer it {remoteBotHint(bot) ?? "there"}.
    </div>
  );
}

/** The one pinned message, above the transcript: sender, one line, click to
 * jump, X to unpin. Resolves the pin id against the full message list; a
 * pin that no longer resolves renders nothing (edited away or deleted). */
function PinnedBanner({
  bot,
  pinnedId,
  messages,
  onJump,
  onUnpin,
}: {
  bot: Bot;
  pinnedId?: string;
  messages: Message[];
  onJump: (messageId: string) => void;
  onUnpin?: () => void;
}) {
  const pinned = messages.find((m) => m.id === pinnedId);
  if (!pinned || pinned.kind !== "text") return null;
  const pinnedPeer = peerLine(pinned);
  const sender =
    pinned.role === "user" ? (pinnedPeer?.name ?? t("chat.you")) : (pinned.from?.name ?? bot.name);
  const text = (pinnedPeer?.body ?? pinned.text ?? "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  return (
    <div className="w-full px-5">
      <div className="mb-2 flex items-center gap-2 rounded-lg border border-accent/25 bg-accent/[0.07] px-3 py-1.5">
        <Pin size={12} className="shrink-0 text-accent" />
        <button
          onClick={() => onJump(pinned.id)}
          className="flex min-w-0 flex-1 items-baseline gap-2 text-left"
          title={t("chat.pinnedJump")}
        >
          <span className="shrink-0 text-[11.5px] font-medium text-accent">{sender}</span>
          <span className="truncate text-[12.5px] text-ink-secondary">{text}</span>
        </button>
        {onUnpin && <button
          onClick={onUnpin}
          aria-label={t("chat.unpinMessage")}
          title={t("chat.unpin")}
          className="shrink-0 rounded p-0.5 text-ink-secondary hover:bg-raised hover:text-ink"
        >
          <X size={13} />
        </button>}
      </div>
    </div>
  );
}

export function ChatView({ bot: profile, shared }: { bot: Bot; shared?: SharedChatOptions }) {
  const bot = useMemo(() => currentTaskBot(profile), [profile]);
  const { state, dispatch } = useStore();
  const remoteClient = window.ogb?.remoteClient?.active === true;
  // A bot relayed from a linked Mac: conversation works, its settings stay there.
  const remoteHint = remoteBotHint(bot);
  const local = !shared && !remoteHint;
  // Windows has no native caption buttons (renderer-drawn, see
  // WindowCaptionButtons); this header is the window drag region, and the
  // icon row shifts below the 26px-tall corner the buttons occupy.
  const { dragStyle: headerDragStyle, noDragStyle: headerNoDragStyle, controlsShiftStyle } = useCaptionChrome();
  const scrollRef = useRef<HTMLDivElement>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const composerDockRef = useRef<HTMLDivElement>(null);
  const composerDock = useComposerDockPad(composerDockRef);

  // only this thread's stream re-renders the chat, not every bot's tokens
  const streaming = useStreamText(bot.threadId);
  const reasoning = useStreamText(bot.threadId, "reasoning");
  const provisioning = state.provisioning[bot.id];
  const mascotMotion = state.mascotMotion?.botId === bot.id ? state.mascotMotion : null;
  const [findOpen, setFindOpen] = useState(false);
  const { replyTo, selectReply, clearReply, consumeReply, restoreReply } = useReplyDraft(
    bot.threadId,
    `bot:${bot.id}:${bot.threadId}`,
    bot.messages,
  );
  useEffect(() => setFindOpen(false), [bot.threadId]);
  useEffect(() => {
    const onFind = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        if (shared) shared.onOpenSearch?.(); else setFindOpen(true);
      }
    };
    window.addEventListener("keydown", onFind);
    return () => window.removeEventListener("keydown", onFind);
  }, [shared]);

  // only the active branch is rendered; forks stay reachable via ‹ › nav
  const messages = useMemo(() => visibleMessages(bot), [bot]);
  // The bot's run in the current ask — every command it ran, the control-CLI
  // ones verified — for the run card. Saving mirrors the /learn gate: the
  // flag, an engine with the agents tools, and a bot that can take a message
  // now — plus a run with something to keep.
  const recordedRun = useMemo(() => runSteps(messages), [messages]);
  const recordedRunCounts = runSummary(recordedRun);
  const engineSupportsAgents = Boolean(
    state.instances.find((instance) => instance.instanceId === bot.modelSelection.instanceId)?.capabilities?.agentsMcp,
  );
  const canSaveRun =
    skillAuthoringEnabled(state.config) && engineSupportsAgents && recordedRunCounts.passed > 0 && recordedRunCounts.running === 0 && !bot.busy;
  // A dismissal is pinned to the run's last step, per thread: the card comes
  // back when the bot runs another command, not merely when a step settles,
  // and stays away across a switch to another thread and back.
  const [runDismissed, setRunDismissed] = useState<ReadonlyMap<string, string>>(() => new Map());
  const lastRunStep = recordedRun.at(-1);

  // Windowed transcript. MessagesList virtualizes its rows, so the whole
  // held page is handed to it (start 0); the window now only narrows to a
  // bounded range around a search hit, with Show earlier/later pills. The
  // boundary is anchored per bot+task; a render-phase reset re-tails it on
  // switch so the old thread's boundary never flashes into the new one.
  // Everything derived below (lastBotTextId, lastUserMessage, working dots)
  // stays computed from the FULL list.
  const transcriptKey = `${bot.id}:${bot.threadId}`;
  const [transcriptWindow, setTranscriptWindow] = useState<{
    key: string;
    start: number;
    end: number | null;
  }>(() => ({
    key: transcriptKey,
    start: 0,
    end: null,
  }));
  if (transcriptWindow.key !== transcriptKey) {
    setTranscriptWindow({ key: transcriptKey, start: 0, end: null });
  }
  const {
    visible: windowedMessages,
    hiddenCount,
    laterCount,
    startIndex,
    endIndex,
  } = useMemo(
    () => resolveTranscriptWindow(messages, transcriptWindow.start, TRANSCRIPT_WINDOW_SIZE, transcriptWindow.end),
    [messages, transcriptWindow.start, transcriptWindow.end],
  );

  const lastBotTextId = useMemo(
    () => [...messages].reverse().find((m) => m.role === "bot" && m.kind === "text")?.id,
    [messages],
  );

  // one message at a time may be in edit mode
  const [editingId, setEditingId] = useState<string | null>(null);
  const [sharedEditPending, setSharedEditPending] = useState(false);
  const [sharedEditError, setSharedEditError] = useState("");
  const [removeTarget, setRemoveTarget] = useState<string | null>(null);
  const [removePending, setRemovePending] = useState(false);
  const [removeError, setRemoveError] = useState("");
  const messageMutationPending = useRef(false);
  useEffect(() => setEditingId(null), [bot.id, bot.threadId]);
  useEffect(() => {
    if (shared && replyTo && shared.messageMeta?.[replyTo.id]?.deletedAt) clearReply();
    if (shared && editingId && shared.messageMeta?.[editingId]?.deletedAt) setEditingId(null);
  }, [shared, replyTo, clearReply, editingId]);
  // stable handler identities — MessagesList is memo'd on them
  const startEdit = useCallback((id: string) => { setSharedEditError(""); setEditingId(id); }, []);
  const cancelEdit = useCallback(() => setEditingId(null), []);
  const submitEdit = useCallback(
    (messageId: string, text: string) => {
      if (shared) {
        if (!shared.editMessage || messageMutationPending.current) return;
        messageMutationPending.current = true;
        setSharedEditPending(true); setSharedEditError("");
        void shared.editMessage(messageId, text).then(() => setEditingId(null))
          .catch(cause => setSharedEditError(cause instanceof Error ? cause.message : "Could not save changes."))
          .finally(() => { messageMutationPending.current = false; setSharedEditPending(false); });
        return;
      }
      setEditingId(null); // closes the editor first — a double Enter can't fork twice
      dispatch({ type: "editMessage", botId: bot.id, threadId: bot.threadId, messageId, text });
    },
    [bot.id, bot.threadId, dispatch, shared],
  );
  const removeSharedMessage = () => {
    if (!removeTarget || !shared?.deleteMessage || messageMutationPending.current) return;
    messageMutationPending.current = true; setRemovePending(true); setRemoveError("");
    void shared.deleteMessage(removeTarget).then(() => setRemoveTarget(null))
      .catch(cause => setRemoveError(cause instanceof Error ? cause.message : "Could not remove message."))
      .finally(() => { messageMutationPending.current = false; setRemovePending(false); });
  };
  // Memoized: a fresh object here on every streamed frame would defeat
  // MessagesList's memo and re-render a shared room's whole transcript.
  const renderedShared = useMemo(() => shared ? {
    ...shared, editingPending: sharedEditPending, editingError: sharedEditError,
    onRequestDelete: (id: string) => {
      if (messages.some(message => message.id === id && message.role === "user") && !shared.messageMeta?.[id]?.deletedAt) {
        setRemoveError(""); setRemoveTarget(id);
      }
    },
  } : undefined, [shared, sharedEditPending, sharedEditError, messages]);
  const lastUserMessage = useMemo(
    () => [...messages].reverse().find((m) => m.role === "user" && m.kind === "text" && !peerLine(m)),
    [messages],
  );
  const lastUserMessageHasAttachments = useMemo(() => {
    if (!lastUserMessage?.text) return false;
    const attached = splitTranscriptAttachments(lastUserMessage.text);
    return attached.images.length > 0 || attached.files.length > 0;
  }, [lastUserMessage]);

  // Mascot while the turn works. Streaming stays invisible — when the reply
  // is finished, the whole bubble pops in above the mascot.
  const lastMessage = messages.at(-1);
  const toolInFlight = lastMessage?.kind === "activity" && lastMessage.tool?.ok === undefined;
  const activityLabel = liveActivityLabel(lastMessage);
  const waiting = shared ? Boolean(shared.activeBotIds?.length) : Boolean(
    bot.busy &&
      bot.activity !== "waiting-on-you" &&
      showWorkingDots(bot.busy, lastMessage),
  );
  const wasWaiting = useRef(false);
  const [popping, setPopping] = useState<string | null>(null);
  const poppingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (poppingTimer.current) clearTimeout(poppingTimer.current);
  }, []);
  useLayoutEffect(() => {
    if (poppingTimer.current) clearTimeout(poppingTimer.current);
    poppingTimer.current = null;
    wasWaiting.current = false;
    setPopping(null);
  }, [bot.id]);
  useEffect(() => {
    if (waiting) wasWaiting.current = true;
  }, [waiting]);
  useLayoutEffect(() => {
    if (lastMessage?.role !== "bot" || lastMessage.kind !== "text" || !wasWaiting.current) return;
    wasWaiting.current = false;
    const messageId = lastMessage.id;
    if (poppingTimer.current) clearTimeout(poppingTimer.current);
    setPopping(messageId);
    poppingTimer.current = setTimeout(() => {
      poppingTimer.current = null;
      setPopping((current) => current === messageId ? null : current);
    }, 520);
  }, [lastMessage?.id, lastMessage?.role, lastMessage?.kind]);
  const presenceVisible = waiting || popping !== null;
  // Room decoration is not the bot speaking. Keep simultaneous speakers separate.
  const presenceBots = shared ? (shared.activeBotIds?.length
    ? shared.activeBotIds.map(id => shared.mentionBots.find(candidate => candidate.id === id)
      ?? { ...bot, id, name: "Bot", color: "blue" as const, mascotBody: null, avatarUrl: null })
    : [shared.mentionBots.find(candidate => candidate.id === lastMessage?.from?.botId)].filter((candidate): candidate is Bot => Boolean(candidate))) : [bot];
  // Wall-clock anchor for the working row's elapsed readout — the server
  // stamps the turn's real start (turnStartedAt), so switching threads keeps
  // the count truthful; Date.now() only covers servers without the stamp.
  const [busySince, setBusySince] = useState<number | null>(null);
  useEffect(() => {
    setBusySince(bot.busy ? bot.turnStartedAt ?? Date.now() : null);
  }, [bot.busy, bot.id, bot.threadId, bot.turnStartedAt]);

  // regenerate = fork the last user message with the same text — reuses the
  // existing branch machinery, so the old answer stays reachable via ‹ ›
  const regenerate = useCallback(() => {
    if (lastUserMessage?.text && !bot.busy) {
      dispatch({ type: "editMessage", botId: bot.id, threadId: bot.threadId, messageId: lastUserMessage.id, text: lastUserMessage.text });
    }
  }, [lastUserMessage, bot.busy, bot.id, bot.threadId, dispatch]);

  // Scroll pinning: follow the bottom while the user hasn't scrolled away.
  // Follow breaks ONLY on an upward user gesture (wheel/touch), never on
  // scroll position checks — streamed content growth flickers "at bottom"
  // false for a frame, and breaking there kills follow permanently
  // (upstream-verified failure). Scrolling back to the end re-arms it.
  const [follow, setFollow] = useState(true);
  const followRef = useRef(true);
  const previousScrollTop = useRef(0);
  const touchY = useRef(0);

  const setBottomFollow = useCallback((next: boolean) => {
    followRef.current = next;
    setFollow(next);
  }, []);
  useBottomFollowResize(scrollRef, transcriptRef, followRef, transcriptKey);

  useEffect(() => setBottomFollow(true), [bot.id, setBottomFollow]);

  // A search result may be hundreds of rows before the mounted tail. Open a
  // bounded window around it first; useFocusMessage then scrolls and flashes
  // the row after React commits that window.
  const appliedFocus = useRef<number | null>(null);
  useEffect(() => {
    const focus = state.focusMessage;
    if (!focus || focus.consumed || focus.threadId !== bot.threadId || appliedFocus.current === focus.nonce) return;
    const targetIndex = messages.findIndex((message) => message.id === focus.messageId);
    if (targetIndex < 0) return;
    appliedFocus.current = focus.nonce;
    const range = focusWindowRange(messages.length, targetIndex);
    setBottomFollow(false);
    setTranscriptWindow({ key: transcriptKey, start: range.start, end: range.end });
  }, [bot.threadId, messages, setBottomFollow, state.focusMessage, transcriptKey]);
  useFocusMessage(bot.threadId, messages.length > 0);

  // deps track the FULL messages.length, so expanding the window (which only
  // changes windowedMessages) can never re-trigger this bottom scrollTo.
  // `follow` is intentionally omitted: flipping it true used to yank the
  // viewport to the end. Re-pinning only arms future content; Jump to latest
  // and this effect on new rows do the scrolling.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !followRef.current) return;
    el.scrollTo({ top: el.scrollHeight });
    previousScrollTop.current = el.scrollTop;
  }, [bot.id, messages.length, streaming, reasoning, bot.busy, composerDock.pad]);

  // Report the rendered tail only after layout. A focused window can still
  // be reading scrollback, including a bounded search-result window.
  const onLatestVisible = shared?.onLatestVisible;
  useEffect(() => {
    if (!onLatestVisible) return;
    const el = scrollRef.current;
    if (!el) return;
    let frame = 0;
    const report = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const landing = state.focusMessage && !state.focusMessage.consumed && state.focusMessage.threadId === bot.threadId;
        const visible = !landing && endIndex >= messages.length && el.clientHeight > 0
          && el.scrollHeight - el.scrollTop - el.clientHeight <= 24;
        onLatestVisible(visible ? messages.at(-1)?.id ?? null : null);
      });
    };
    el.addEventListener("scroll", report, { passive: true });
    const resize = new ResizeObserver(report);
    resize.observe(el);
    if (transcriptRef.current) resize.observe(transcriptRef.current);
    report();
    return () => { cancelAnimationFrame(frame); resize.disconnect(); el.removeEventListener("scroll", report); onLatestVisible(null); };
  }, [onLatestVisible, messages, endIndex, bot.threadId, state.focusMessage]);

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
    const nextEnd = Math.min(messages.length, endIndex + TRANSCRIPT_WINDOW_SIZE);
    setTranscriptWindow((w) => ({ ...w, end: nextEnd >= messages.length ? null : nextEnd }));
  };

  // Scrollback across the network: the snapshot holds a bounded page, and
  // everything before it is still on the server. Asking for it prepends rows
  // exactly like expanding the local window, so the same height capture keeps
  // the viewport still — here it is applied when the transcript grows at the
  // front rather than when the boundary moves.
  const olderPending = shared ? Boolean(shared.olderLoading) : Boolean(state.loadingOlder[bot.threadId]);
  // A cached copy shown while its thread switch is in flight (App.tsx): the
  // store does not own this thread yet, so it cannot page it.
  const switchPreview = !shared && state.pendingThreadSwitch[bot.id] === bot.threadId;
  // `fill`: fetched on the reader's behalf (see below) while they may still be
  // following the bottom; then the prepend must not break follow, and the
  // follow effect keeps the newest row in view.
  const lastOlderRequest = useRef(0);
  const loadOlder = (fill = false) => {
    lastOlderRequest.current = Date.now();
    if (!(fill && followRef.current)) {
      preExpandHeight.current = scrollRef.current ? { key: transcriptKey, height: scrollRef.current.scrollHeight } : null;
      setBottomFollow(false);
    }
    if (shared) void shared.loadOlder?.();
    else dispatch({ type: "loadOlderMessages", threadId: bot.threadId });
  };
  // Scrolling near the top asks for the next page itself; the pill stays for
  // keyboard and screen-reader use.
  const nearTopLoad = () => {
    const el = scrollRef.current;
    if (!el || switchPreview || followRef.current || hiddenCount > 0 || !bot.hasMore || olderPending) return;
    if (el.scrollTop > OLDER_PAGE_TRIGGER_PX || Date.now() - lastOlderRequest.current < 800) return;
    loadOlder();
  };
  // A page that holds under two prompts reads as "tool calls and the last
  // message": an older server ignores ?turns=, and the startup snapshot is a
  // raw-row page. Fetch on until the conversation shows, a few pages at most.
  const fillPages = useRef<{ key: string; count: number }>({ key: "", count: 0 });
  const promptCount = useMemo(() => messages.reduce((count, message) => count + (message.role === "user" && message.kind === "text" ? 1 : 0), 0), [messages]);
  useEffect(() => {
    if (fillPages.current.key !== transcriptKey) fillPages.current = { key: transcriptKey, count: 0 };
    if (switchPreview || hiddenCount > 0 || !bot.hasMore || olderPending || promptCount >= 2) return;
    if (fillPages.current.count >= MAX_FILL_PAGES) return;
    fillPages.current.count += 1;
    loadOlder(true);
    // loadOlder is recreated every render; the inputs above decide.
  }, [transcriptKey, switchPreview, hiddenCount, bot.hasMore, olderPending, promptCount]);
  const oldestId = messages[0]?.id;
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const captured = preExpandHeight.current;
    if (!captured || !el) return;
    preExpandHeight.current = null;
    if (captured.key !== transcriptKey) return;
    el.scrollTop += el.scrollHeight - captured.height;
    previousScrollTop.current = el.scrollTop;
  }, [oldestId, transcriptKey]);

  // keyboard is a scroll gesture too (upstream lesson): PageUp/Home/ArrowUp
  // break follow like an upward wheel; the at-end onScroll check re-arms it.
  // ArrowUp only counts outside inputs — in the composer it edits, not scrolls.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement;
      if (e.key === "PageUp" || ((e.key === "Home" || e.key === "ArrowUp") && !typing)) {
        setBottomFollow(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setBottomFollow]);

  const atEnd = () => {
    const el = scrollRef.current;
    return !el || el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_FOLLOW_THRESHOLD;
  };
  const jumpToLatest = () => {
    setBottomFollow(true);
    setTranscriptWindow({ key: transcriptKey, start: 0, end: null });
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
    });
  };

  const routineExecution = state.routineRuns.find((run) => run.target === "bot" && run.botId === bot.id && run.threadId === bot.threadId);
  const resultsThreadId = routineExecution?.resultsThreadId ?? routineExecution?.sourceThreadId;
  const canOpenResults = resultsThreadId && [...state.bots, ...state.groups].some((owner) => owner.threadId === resultsThreadId || owner.tasks?.some((task) => task.threadId === resultsThreadId));

  return (
    <main className="relative flex h-full min-w-0 flex-1 flex-col bg-app">
      <ConfirmDialog open={removeTarget !== null} title="Remove this message?"
        body={removeError || "The message will be replaced with a removed-message notice for everyone. This cannot be undone."}
        confirmLabel={removePending ? "Removing…" : "Remove message"}
        onCancel={() => { if (!removePending) setRemoveTarget(null); }} onConfirm={removeSharedMessage} />
      {/* Call mode covers the thread while the bot is on the line */}
      <BotCallOverlay bot={bot} />
      {local && <ModSurfaces botId={bot.id} surface="chip" />}
      {/* Header */}
      <ConversationHeader style={headerDragStyle}>
        {/* Grok's header: the bot as one pill in the middle, tools at the end.
            The empty spacer keeps the pill centred while the tools grow; on a
            phone-width header there's no room to centre, so the pill sits left
            and the tools keep their full width instead of overlapping it. */}
        <div className="min-w-0 flex-1 basis-0 @max-xl/chathead:hidden" aria-hidden="true" />
        <div className="flex min-w-0 shrink items-center gap-2 rounded-full border border-hairline/50 bg-app py-1 pe-4 ps-1.5 shadow-[0_6px_24px_rgba(0,0,0,0.35)]" style={headerNoDragStyle} data-testid="chat-title-pill">
          {(messages.length > 0 || bot.busy || shared) && (
          <button
            onClick={() => { if (shared) shared.onOpenDetails?.(); else if (local) dispatch({ type: "toggleSettings", open: true }); }}
            className="flex size-9 shrink-0 items-center justify-center rounded-full hover:bg-raised/50"
            title={shared ? "Conversation details" : t("chat.openProfile")}
            aria-label={shared ? `Open ${bot.name} conversation details` : t("chat.openProfileAria", { name: bot.name })}
          >
            {/* a person's photo arrives as a data: image, which bot avatars
                refuse by design; show it the same size a bot avatar sits */}
            {shared?.faces && shared.faces.length > 0 ? (
              <GroupMark members={shared.faces} size={34} />
            ) : shared && bot.avatarUrl?.startsWith("data:image/") ? (
              <PersonPhoto src={bot.avatarUrl} size={28} testId="shared-person-avatar" />
            ) : (
              <BotAvatar
                bot={bot}
                state={stateForBot({ ...bot, messages })}
                face={glyphFaceForBot({ ...bot, messages })}
                size={28}
                motion={mascotMotion?.kind ?? "none"}
                motionKey={mascotMotion?.nonce ?? 0}
              />
            )}
          </button>
          )}
          {shared ? <button type="button" onClick={shared.onOpenDetails} className="truncate text-[15px] font-semibold text-ink hover:underline">{bot.name}</button> : !local ? <span className="truncate text-[15px] font-semibold text-ink">{bot.name}</span> : <RenameTitle
            value={bot.name}
            onCommit={(name) => {
              if (window.ogb?.remoteClient?.active) {
                void api(`/api/bots/${bot.id}/profile`, { method: "PATCH", body: JSON.stringify({ name }) })
                  .then(({ bot: updated }) => dispatch({ type: "botPatched", bot: updated }))
                  .catch((cause) => dispatch({ type: "error", message: cause instanceof Error ? cause.message : String(cause) }));
              } else {
                dispatch({ type: "updateBot", botId: bot.id, patch: { name } });
              }
            }}
            onActivate={() => dispatch({ type: "toggleSettings", open: true })}
            className="truncate text-[15px] font-semibold text-ink"
            inputClassName="max-w-[220px] rounded bg-inset px-1.5 py-0.5 text-[15px] font-semibold"
          />}
          {remoteHint && <span className="shrink-0 truncate text-[12px] text-ink-secondary" data-testid="remote-bot-hint">{remoteHint}</span>}
          {/* The role is spoken, not shown: a coloured title pill next to the
              name cheapened the header (Firaz, 2026-10-12). */}
          {!shared && bot.chiefOfStaff && <span className="sr-only">{t("chat.chiefOfStaff")}</span>}
          {bot.busy && <WorkingDots className="text-ink-secondary" />}
        </div>
        <div
          className="flex min-w-0 flex-1 basis-0 items-center justify-end gap-2 @max-xl/chathead:flex-none @max-xl/chathead:basis-auto"
          // The caption buttons sit over the header's right end; drop this
          // icon row 16px (visual only — the header keeps its height) so the
          // buttons clear the 26px overlay while the rest of the layout stays.
          style={controlsShiftStyle}
        >
          {shared?.actions}
          {!shared && <HeaderCallSlot bot={bot} />}
          {!shared&&<ThreadDoneButton key={`${bot.id}:${bot.threadId}`} bot={bot}/>}
          <ConversationActions key={bot.threadId} bot={bot} messages={messages} local={local && !shared && !remoteClient}>
          {<button
            onClick={() => shared ? shared.onOpenSearch?.() : setFindOpen((open) => !open)}
            aria-label={t("chat.find")}
            aria-pressed={findOpen}
            className={cn(
              "rounded-md p-1.5 hover:bg-raised",
              findOpen ? "text-accent" : "text-ink-secondary hover:text-ink",
            )}
            title={t("chat.findShortcut")}
          >
            <Search size={18} /><span>{t("chat.find")}</span>
          </button>}


          {!remoteHint && <ExportTranscriptMenu
            title={bot.name}
            messages={messages}
            botName={bot.name}
          />}

          {local && <TerminalButton target={{ botId: bot.id, threadId: bot.threadId, name: bot.name }} className="rounded-md" />}
          {local&&<details className="conversation-advanced"><summary className="cursor-pointer list-none rounded-lg px-2.5 py-2 text-xs text-ink-secondary hover:bg-raised">Advanced</summary>          {local && <button
            data-tour="computer"
            onClick={() => dispatch({ type: "toggleComputer" })}
            className={cn(
              "rounded-md p-1.5 hover:bg-raised",
              state.computerOpen ? "text-accent" : "text-ink-secondary hover:text-ink",
            )}
            title={t("chat.computer")}
          >
            <Monitor size={18} /><span>{t("chat.computer")}</span>
          </button>}
          {!remoteClient&&<button className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs text-ink-secondary hover:bg-raised" onClick={()=>dispatch({type:'toggleInspector'})}><Bug size={15}/>{t('chat.inspector')}</button>}</details>}
          </ConversationActions>
        </div>
      </ConversationHeader>

      {shared?.banner}
      {!shared && remoteBotNotice(bot) && <div role="status" className="mx-5 my-2 rounded-xl border border-hairline/40 bg-raised px-3 py-2 text-sm text-ink-secondary">{remoteBotNotice(bot)}</div>}

      {!shared && <BotActivityPicker bot={bot} />}
      {routineExecution && <div className="mx-5 mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[11.5px] text-ink-secondary">
        <span className="min-w-0 flex-1 truncate">{t("routines.executionDetails", { name: routineExecution.routineName })}</span>
        {canOpenResults && resultsThreadId && <button type="button" onClick={() => openNotificationTarget(dispatch, { botId: bot.id, threadId: resultsThreadId }, state)} className="rounded px-2 py-1 text-accent hover:bg-raised">{t("routines.results.back")}</button>}
        <button type="button" onClick={() => dispatch({ type: "showRoutines", section: "logs", routineId: routineExecution.routineId, botId: bot.id })} className="rounded px-2 py-1 hover:bg-raised hover:text-ink">{t("routines.logs")}</button>
      </div>}
      {!shared && findOpen && <ChatFindBar threadId={bot.threadId} onClose={() => setFindOpen(false)} />}

      {/* Error banner */}
      {state.error && (
        <div className="w-full px-5">
          <div className="mb-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[13px] text-danger">
            {state.error}
          </div>
        </div>
      )}
      {state.notice && (
        <div className="w-full px-5">
          <div role="status" className="mb-2 rounded-lg border border-hairline/40 bg-panel px-3 py-2 text-[13px] text-ink-secondary">
            {state.notice.botName ? t("thread.goneShowing", { name: state.notice.botName }) : t("thread.gone")}
          </div>
        </div>
      )}

      {/* Shared rooms store pins on messages; bot chats store one pin per task. */}
      {shared ? <div className="max-h-36 overflow-y-auto">
        {messages.filter(message => shared.messageMeta?.[message.id]?.pinnedBy && !shared.messageMeta?.[message.id]?.deletedAt).map(message => <PinnedBanner
          key={message.id} bot={bot} pinnedId={message.id} messages={messages}
          onJump={messageId => dispatch({ type: "focusMessage", threadId: bot.threadId, messageId })}
          onUnpin={shared.annotateMessage ? () => { void shared.annotateMessage?.(message.id, { pinned: false }); } : undefined}
        />)}
      </div> : <PinnedBanner
        bot={bot}
        pinnedId={bot.pinnedMessageId}
        messages={messages}
        onJump={(messageId) => dispatch({ type: "focusMessage", threadId: bot.threadId, messageId })}
        onUnpin={remoteClient ? undefined : () => dispatch({ type: "updateTask", botId: bot.id, threadId: bot.threadId, patch: { pinnedMessageId: "" } })}
      />}


      {/* Messages + composer share one pane so bubbles scroll into the pill
          instead of dying on a rectangular clip above a black dock. */}
      <div className="relative min-h-0 flex-1">
      <div
        ref={scrollRef}
        className="chat-thread h-full overflow-x-hidden overflow-y-auto overscroll-y-contain px-4 [overflow-anchor:none]"
        onPointerDown={(e) => {
          // grabbing the scrollbar is a scroll gesture too — the lane lives
          // past the content box (clientWidth excludes it)
          const el = scrollRef.current;
          if (el && e.target === el && e.nativeEvent.offsetX >= el.clientWidth) setBottomFollow(false);
        }}
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
          nearTopLoad();
          // Opening a bounded search/source window changes scrollHeight.
          // Its synthetic scroll event must not re-arm bottom-follow before
          // useFocusMessage has landed on the requested row.
          const landing = state.focusMessage && !state.focusMessage.consumed && state.focusMessage.threadId === bot.threadId;
          if (resume && !landing) setBottomFollow(true);
        }}
      >
        <div
          ref={transcriptRef}
          className="mx-auto flex w-full max-w-[768px] flex-col gap-3"
          style={{ paddingBottom: composerDock.pad }}
          role="log"
          aria-live="polite"
          aria-label={t("chat.conversationWith", { name: bot.name })}
        >
          {hiddenCount > 0 ? (
            <div className="flex justify-center pt-2">
              <button
                onClick={showEarlier}
                className="rounded-full border border-hairline/40 bg-panel px-3 py-1 text-[12.5px] text-ink-secondary hover:bg-raised hover:text-ink"
              >
                {t("chat.showEarlier", { count: hiddenCount })}
              </button>
            </div>
          ) : bot.hasMore && !switchPreview ? (
            <div className="flex justify-center pt-2">
              <button
                onClick={() => loadOlder()}
                disabled={olderPending}
                className="rounded-full border border-hairline/40 bg-panel px-3 py-1 text-[12.5px] text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-60"
              >
                {olderPending ? t("chat.loadingEarlier") : t("chat.loadEarlier")}
              </button>
            </div>
          ) : null}
          <SharedTranscriptAnchor revision={shared?.changeRevision ?? 0} scroll={scrollRef} following={followRef}>
          <MessagesList
            bot={bot}
            shared={renderedShared}
            locale={activeLocale()}
            messages={windowedMessages}
            transcript={messages}
            editingId={editingId}
            lastBotTextId={lastBotTextId}
            emergingId={popping}
            canRetryLast={local && !bot.busy && Boolean(lastUserMessage)}
            engine={state.instances.find((i) => i.instanceId === bot.modelSelection.instanceId)}
            onStartEdit={startEdit}
            onCancelEdit={cancelEdit}
            onSubmitEdit={submitEdit}
            onRegenerate={local ? regenerate : undefined}
            onReply={selectReply}
            scrollRef={scrollRef}
            following={followRef}
          />
          </SharedTranscriptAnchor>
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
          {provisioning && (
            <div className="flex justify-start">
              <div className="flex items-center gap-2 rounded-full border border-hairline/40 bg-panel px-3 py-1.5 text-[13px] text-ink-secondary">
                <WorkingDots size={3.5} />
                {t("chat.provisioning")}
              </div>
            </div>
          )}
          {presenceBots.map(speaker => <TurnPresence
            key={speaker.id}
            avatar={
              // an uploaded profile image (and a chosen mascot body) must
              // match the sidebar row
              <ActivityMascot
                bot={speaker}
                gesture={turnGesture({ toolInFlight, toolName: lastMessage?.tool?.name })}
              />
            }
            visible={presenceVisible}
            label={shared ? `${speaker.name} · ${activityLabel}` : activityLabel}
            answering={popping !== null && (!shared || !shared.activeBotIds?.includes(speaker.id))}
            since={busySince}
          />)}
        </div>
      </div>

      {/* Reading scrollback — one tap back to the end, streaming or not */}
      {!follow && (
        <button
          onClick={jumpToLatest}
          aria-label={t("chat.jumpToLatestAria")}
          className="animate-pop-in absolute left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-hairline/40 bg-raised px-3 py-1.5 text-[12.5px] text-ink shadow-lg hover:bg-raised-hover"
          style={{ bottom: composerDock.height }}
        >
          <ArrowDown size={13} /> {t("chat.jumpToLatest")}
        </button>
      )}

      {/* Keyed by task: each conversation keeps its own draft and a failed
          request can restore the old task without spilling into the newly
          selected one. ArrowUp-to-edit stays gated on busy because editing
          rewinds the thread, which a live turn forbids (the server 409s it). */}
      <div ref={composerDockRef} className="absolute inset-x-0 bottom-0 z-[2]">
      {/* The bot's run in this ask as a checklist, once it is worth one (a
          verified step, or more than one command). Save fills this thread's
          composer with the run and the person's request and hands the caret
          over; the person adds context and sends — nothing is sent from
          here. In the dock so its height is measured with the composer's:
          the transcript pad, the jump pill and bottom-follow all move with
          it. */}
      {/* Only once it matters: the run is over and could become a skill (a
          verified step, or three or more that passed). While the bot works
          the transcript already shows every step. */}
      {local && <ApprovalRuleOffer botId={bot.id} threadId={bot.threadId} messages={messages} />}
      {lastRunStep && showRun(recordedRun) && canSaveRun && (recordedRunCounts.verified > 0 || recordedRunCounts.passed >= 3)
        && !skillStaged(messages, recordedRun) && runDismissed.get(transcriptKey) !== lastRunStep.id && (
        <div className="px-5 pb-2">
          <VerifyCard
            key={transcriptKey}
            steps={recordedRun}
            canSave={canSaveRun}
            staged={skillStaged(messages, recordedRun)}
            onDismiss={() => setRunDismissed((current) => new Map(current).set(transcriptKey, lastRunStep.id))}
            onSave={() => {
              appendComposerDraft(`bot:${bot.id}:${bot.threadId}`, skillPrompt(recordedRun, askText(messages)));
              composerDockRef.current?.querySelector("textarea")?.focus();
            }}
          />
        </div>
      )}
      {local && <><ModCommands botId={bot.id} threadId={bot.threadId} /><ModSurfaces botId={bot.id} surface="band" /></>}
      <Composer
        key={bot.threadId}
        bot={profile}
        shared={shared}
        // A cached transcript shown while its thread switch is in flight is
        // read-only until the server confirms the switch.
        locked={shared?.historyLoading || switchPreview}
        replyTo={shared && replyTo ? messages.find(message => message.id === replyTo.id) ?? replyTo : replyTo}
        onClearReply={clearReply}
        onConsumeReply={consumeReply}
        onRestoreReply={restoreReply}
        onEditLast={local && lastUserMessage && !lastUserMessageHasAttachments && !bot.busy
          ? () => setEditingId(lastUserMessage.id)
          : undefined}
      />
      </div>
      </div>

    </main>
  );
}

/** What the open task has spent — quiet until the first turn settles.
 * Click opens the bot's settings, where the Usage card has the breakdown. */
/** Starting a voice call lives in the composer (Grok's white wave button)
 * once xAI voice is set up; the header keeps the live call chip and the
 * older call mode. */
function HeaderCallSlot({ bot }: { bot: Bot }) {
  const { state } = useStore();
  const engine = useRealtimeCall();
  const snapshot = useCallSnapshot(engine);
  if (state.config?.xai?.configured === true && !(engine && callIsOn(snapshot))) return null;
  return <BotCallButton bot={bot} />;
}
