import { Component, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import {
  AlertTriangle,
  ArrowDown,
  Check,
  ChevronLeft,
  ChevronRight,
  Bug,
  Copy,
  Crown,
  MessageSquareReply,
  Monitor,
  Pencil,
  Pin,
  PinOff,
  RefreshCw,
  Search,
  Square,
  Trash2,
  Webhook,
  X,
} from "lucide-react";
import { WorkingDots } from "@/components/WorkingIndicator";
import { MessageActions, messageActionClass } from "@/components/MessageActions";
import { useSpeech } from "@/lib/tts/useSpeech";
import { useCaptionChrome } from "@/components/DesktopCapabilities";
import { cachedInput, cachedKnown, contextChip, contextDetail, contextShare, costCaption, formatTokens, formatUsd, freshTokens, hasFiniteCost, lastTurnDetail, usageChip, usageDetail } from "@/lib/usage";
import {
  api,
  currentTaskBot,
  useStore,
  useStreaming,
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
import { showToolCallsEnabled, skillAuthoringEnabled } from "@/lib/feature-flags";
import { normalizeState, stateForBot } from "@/lib/mascot";
import { peerLine, type PeerLine } from "@/lib/peer-message";
import { showWorkingDots } from "@/lib/turn-tail";
import { liveActivityLabel } from "@/lib/live-activity";
import { ChatMarkdown } from "./ChatMarkdown";
import { RawMarkdownView, RawToggleAction } from "./RawMarkdownToggle";
import { ThreadChip } from "./ThreadChip";
import { VerifyCard } from "./VerifyCard";
import { askText, runSteps, runSummary, showRun, skillPrompt, skillStaged } from "@/lib/verify-steps";
import { ToolActivity } from "./ToolActivity";
import { ThreadRefText } from "./ThreadRefs";
import { OptionCard, shouldHideOnboardingCard } from "./OptionCard";
import { ApprovalCard } from "./ApprovalCard";
import { QuestionCard } from "./QuestionCard";
import { Composer } from "./Composer";
import { ConversationHeader } from "./ConversationChrome";
import { SharedAttachmentTile } from "./SharedAttachmentTile";
import type { SharedComposer } from "./shared-conversation";
import { ConfirmDialog } from "./ConfirmDialog";

interface SharedChatOptions extends SharedComposer {
  faces?: GroupMarkMember[]; actions?: ReactNode; banner?: ReactNode; onOpenDetails?: () => void;
  loadOlder?: () => Promise<void>; olderLoading?: boolean; historyLoading?: boolean;
  editMessage?: (id: string, text: string) => Promise<void>;
  deleteMessage?: (id: string) => Promise<void>;
  messageMeta?: Record<string, { editedAt?: number; deletedAt?: number }>;
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
import { SecretRequestCard } from "./SecretRequestCard";
import { hasRoutineExecutionTask, RoutineRunCard } from "./RoutineRunCard";
import { AttachmentGallery, collectMessageFiles } from "./AttachmentGallery";
import { ScreenFrame } from "./ScreenFrame";
import { CompactionChip, DigestChip } from "./DigestChip";
import { RenameTitle } from "./RenameTitle";
import { BotActivityPicker, TaskPicker } from "./TaskPicker";
import { ModelPicker } from "./ModelPicker";
import { ExportTranscriptMenu } from "./ExportTranscriptMenu";
import { botControlAvailable, remoteBotHint, remoteBotNotice } from "@/lib/remote-bot";

import { SpeakButton } from "./SpeakButton";
import { CallButton, CallOverlay } from "./CallView";
import { effectivePlace, toolPlace, type EffectivePlace } from "@/lib/place";
import { cn } from "@/lib/cn";
import { activeLocale, t } from "@/lib/i18n";
import { COMPACT_BUBBLE } from "@/lib/compact-chip";
import { useFocusMessage } from "@/lib/focus-message";
import { groupTranscript } from "@/lib/activity-runs";
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
  tailWindowStart,
} from "@/lib/transcript-window";
import { appendComposerDraft, useReplyDraft } from "@/lib/drafts";

/** Long user messages collapse behind a fade so pasted walls of text don't
 * bury the conversation; bots get full markdown. */
const USER_COLLAPSE_CHARS = 600;
const USER_COLLAPSE_LINES = 8;
const noop = () => {};

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

/** Hover/focus-revealed copy control shared by user + bot bubbles. */
function CopyButton({ text, className }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        void navigator.clipboard?.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
      aria-label={t("chat.copyMessage")}
      title={t("chat.copyMessage")}
      className={cn(
        "rounded-md p-1.5 text-ink-secondary opacity-0 transition-opacity hover:bg-raised hover:text-ink focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100",
        className,
      )}
    >
      {copied ? <Check size={14} className="text-success" /> : <Copy size={14} />}
    </button>
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
        <div className="chat-text w-fit max-w-[min(42rem,78%)] rounded-2xl bg-card px-4 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap text-ink">
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
  const mentionPeers = useMemo(() => shared?.mentionBots ?? state.bots.filter((peer) => peer.id !== bot.id), [shared, state.bots, bot.id]);
  const [expanded, setExpanded] = useState(false);
  const [viewRaw, setViewRaw] = useState(false);
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
    {!user && message.from && <div className="mb-1 text-[11px] text-ink-secondary">{message.from.name}</div>}
    <div className="rounded-2xl bg-card px-4 py-2.5 text-sm italic text-ink-secondary">Message removed</div>
  </div>;

  if (user && editing && !webhookView && !hasAttachments) {
    return (
      <div className="flex w-full justify-end">
        <BubbleEditor initial={text} onCancel={onCancelEdit} onSubmit={onSubmitEdit} pending={shared?.editingPending} error={shared?.editingError} saveLabel={shared ? "Save changes" : undefined} />
      </div>
    );
  }

  // "‹ 2/3 ›" under an edited message — every fork it belongs to
  const versions = user && !shared ? messageVersions(bot, message) : [message];
  const versionIndex = versions.findIndex((v) => v.id === message.id);
  const switchTo = (v: Message | undefined) => {
    if (v && !bot.busy) dispatch({ type: "switchBranch", botId: bot.id, threadId: bot.threadId, messageId: v.id });
  };

  return (
    <div className={cn("group flex w-full flex-col", user ? "animate-msg-in items-end" : "items-start")}>
      {peer && <PeerLabel peer={peer} />}
      {shared && !user && message.from && <div className="mb-1 pl-0.5 text-[11px] font-medium text-ink-secondary">{message.from.name}</div>}
      <div className={cn("flex w-full items-center gap-1.5", user ? "justify-end" : "justify-start")}>
        {user && (
          <MessageActions side="user">
            {/* editing rewinds the thread, so it waits for the turn to end —
                same rule as the version switcher below */}
            {(shared ? Boolean(shared.editMessage) : botControlAvailable(bot, "edit") && !bot.busy) && message.kind === "text" && !webhookView && !hasAttachments && (
              <button
                onClick={onStartEdit}
                aria-label={t("chat.editMessage")}
                title={t("chat.editMessage")}
                className={messageActionClass}
              >
                <Pencil size={14} />
              </button>
            )}
            {Boolean(visibleText.trim()) && <CopyButton text={visibleText} className="opacity-100" />}
            <button
              type="button"
              onClick={onReply}
              aria-label={t("chat.replyToMessage")}
              title={t("chat.reply")}
              className={messageActionClass}
            >
              <MessageSquareReply size={14} />
            </button>
            {shared?.deleteMessage && <button type="button" onClick={() => shared.onRequestDelete?.(message.id)} aria-label="Remove message" title="Remove message" className={cn(messageActionClass, "text-danger")}><Trash2 size={14} /></button>}
            {!shared && <button
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
            </button>}
          </MessageActions>
        )}
        <div
          className={cn(
            "w-fit max-w-[min(42rem,78%)] rounded-2xl text-[15px] leading-relaxed",
            emerging && "turn-answer",
            user && webhookView
              ? "overflow-hidden border border-accent/25 bg-card text-ink shadow-[0_10px_30px_rgba(0,0,0,0.18)]"
              : user
                ? "bg-bubble-user px-4 py-2.5 whitespace-pre-wrap text-ink"
                : "bg-card px-4 py-2.5 text-ink",
          )}
          title={new Date(message.at).toLocaleString()}
        >
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
          {shared && message.sharedAttachments?.map(attachment => <SharedAttachmentTile key={attachment.id} roomId={bot.threadId.slice("shared:".length)} attachment={attachment} />)}
          {user && webhookView ? (
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
          ) : user ? (
            <>
              {attachments && <AttachmentGallery images={attachments.images} files={attachments.files} message={{ threadId: bot.threadId, messageId: message.id }} eager={eagerAttachments} className={!visibleText ? "mb-0" : undefined} />}
              {visibleText && (
                <div
                  className={cn("chat-text", collapsible && "max-h-40 overflow-hidden [mask-image:linear-gradient(to_bottom,black_60%,transparent)]")}
                >
                  <ThreadRefText text={visibleText} peers={mentionPeers} />
                </div>
              )}
              {message.steered && (
                <div className="mt-1 text-[11px] text-ink-secondary/70" title={t("chat.sentMidTurnHint")}>
                  {t("chat.sentMidTurn")}
                </div>
              )}
              {collapsible && (
                <button onClick={() => setExpanded(true)} className="mt-1 text-[12.5px] text-ink-secondary hover:text-ink">
                  {t("chat.showFull")}
                </button>
              )}
              {expanded && (
                <button onClick={() => setExpanded(false)} className="mt-1 text-[12.5px] text-ink-secondary hover:text-ink">
                  {t("chat.showLess")}
                </button>
              )}
            </>
          ) : (
            <MessageBoundary key={viewRaw ? "raw" : "rendered"} fallbackText={text || t("chat.generatedImage")}>
              <AttachmentGallery images={generatedPaths} files={linkedFiles} message={{ threadId: bot.threadId, messageId: message.id }} className={text ? undefined : "mb-0"} eager={eagerAttachments} />
              {viewRaw && text ? (
                <RawMarkdownView text={text} />
              ) : text ? (
                <ChatMarkdown text={text} mentionPeers={mentionPeers} message={{ threadId: bot.threadId, messageId: message.id }} />
              ) : null}
            </MessageBoundary>
          )}
          {sharedMeta?.editedAt && <div className="mt-1 text-[10px] text-ink-secondary" title={new Date(sharedMeta.editedAt).toLocaleString()}>edited</div>}
        </div>
        {!user && (
          <MessageActions side="bot" forceOpen={viewRaw || speaking}>
            {text && <CopyButton text={text} className="opacity-100" />}
            {text && <RawToggleAction active={viewRaw} onToggle={() => setViewRaw((r) => !r)} className="opacity-100" />}
            {!shared && message.kind === "text" && text && !peer && (
              <SpeakButton text={text} botId={bot.id} messageId={message.id} voiceId={bot.voice} className="opacity-100" />
            )}
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
            <button
              type="button"
              onClick={onReply}
              aria-label={t("chat.replyToMessage")}
              title={t("chat.reply")}
              className={messageActionClass}
            >
              <MessageSquareReply size={14} />
            </button>
            {!shared && <button
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
            </button>}
          </MessageActions>
        )}
        <span
          className={cn(
            "self-end pb-1 text-[11px] tabular-nums text-ink-secondary/70 opacity-0 transition-opacity group-hover:opacity-100",
            user ? "order-first mr-1" : "ml-1",
          )}
        >
          {formatTime(message.at)}
        </span>
      </div>
      {versions.length > 1 && botControlAvailable(bot, "versions") && (
        <div className="mt-1 flex items-center gap-0.5 pr-1 text-[12px] text-ink-secondary">
          <button
            onClick={() => switchTo(versions[versionIndex - 1])}
            disabled={versionIndex <= 0 || bot.busy}
            className="rounded p-0.5 hover:bg-raised hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent"
            title={t("chat.previousVersion")}
          >
            <ChevronLeft size={14} />
          </button>
          <span className="tabular-nums">
            {versionIndex + 1}/{versions.length}
          </span>
          <button
            onClick={() => switchTo(versions[versionIndex + 1])}
            disabled={versionIndex >= versions.length - 1 || bot.busy}
            className="rounded p-0.5 hover:bg-raised hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent"
            title={t("chat.nextVersion")}
          >
            <ChevronRight size={14} />
          </button>
        </div>
      )}
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
        state={normalizeState(author?.mascotExpression) ?? "happy"}
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
          <BotAvatar bot={withBot ?? { name: comm.withName, color: comm.withColor }} state="happy" size={16} />
          <span className="max-w-[480px] truncate">{tool.name}</span>
          <ChevronRight size={13} />
        </button>
      </div>
    );
  }
  return <ToolActivity tool={tool} place={toolPlace(tool.name, place)} />;
}

/** The settled transcript, memoized as one unit: during streaming every
 * frame re-renders ChatView, but all of these props keep their identity
 * (bot/messages only change on real message events), so the whole list —
 * every markdown tree, every code block — bails out of React work and only
 * the streaming tail below it commits. This is the t3code structural-sharing
 * idea at component granularity. */
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
}) {
  const { state, dispatch } = useStore();
  const showToolCalls = showToolCallsEnabled(state.config);
  // Finished tool chips become compact runs; settled assistant narration
  // becomes one reversible turn row while the terminal answer stays visible.
  const items = useMemo(() => shared ? messages.map(message => ({ kind: "message" as const, message })) : groupTranscript(messages), [messages, locale, shared]);
  // Where this conversation works, for the place icon on screen and page tools.
  const place = effectivePlace(bot, bot.tasks?.find((task) => task.threadId === bot.threadId));
  const newestMessageId = messages.at(-1)?.id;
  const newestUserMessageId = [...messages].reverse().find((message) => message.role === "user")?.id;
  // A search hit inside a folded run has to open it: the fold keeps the
  // row out of the DOM, and there is nothing for the scroll to land on.
  const focus = state.focusMessage;
  const focusedId = focus && !focus.consumed && focus.threadId === bot.threadId ? focus.messageId : null;
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
      {items.map((item, i) => {
        const previous = items[i - 1];
        const prev = previous && (previous.kind === "message" ? previous.message : previous.messages.at(-1));
        const first = item.kind === "message" ? item.message : item.messages[0];
        const newDay = !prev || new Date(prev.at).toDateString() !== new Date(first.at).toDateString();
        if (item.kind === "turn") {
          return (
            <div key={item.id} className="contents">
              {newDay && <DaySeparator at={first.at} />}
              <TurnNarrationRun
                label={item.label}
                forceOpen={item.messages.some((message) => message.id === focusedId)}
              >
                {item.messages.map((message) => (
                  <div key={message.id} className="contents" data-mid={message.id}>
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
                  </div>
                ))}
              </TurnNarrationRun>
            </div>
          );
        }
        if (item.kind === "run") {
          if (!showToolCalls) return null;
          return (
            <div key={item.id} className="contents">
              {newDay && <DaySeparator at={first.at} />}
              <ActivityRun messages={item.messages} forceOpen={item.messages.some((step) => step.id === focusedId)}>
                {item.messages.map((step) => (
                  <div key={step.id} className="contents" data-mid={step.id}>
                    <ActivityChip message={step} place={place} />
                  </div>
                ))}
              </ActivityRun>
            </div>
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
              // card. The first-run quiz drops out once they talk.
              // Cards are bot-authored and persisted, so one that will not
              // draw must fall back to its text on every open, not take the
              // whole page down every time this chat is selected.
              const card = m.card?.requestId && m.card.questionRequest ? (
                <QuestionCard threadId={bot.threadId} bot={bot} message={m} />
              ) : m.card?.requestId && m.card.tool ? (
                <ApprovalCard bot={bot} message={m} />
              ) : shouldHideOnboardingCard(m, transcript) ? null : (
                <OptionCard botId={bot.id} threadId={bot.threadId} message={m} />
              );
              if (!card) return null;
              return (
                <MessageBoundary fallbackText={m.card?.subtitle || m.card?.title || ""}>
                  {card}
                </MessageBoundary>
              );
            }
            case "routine.run": {
              const executionThreadId = m.routineRun?.executionThreadId;
              const canOpen = executionThreadId && state.bots.some((candidate) =>
                candidate.threadId === executionThreadId || hasRoutineExecutionTask(candidate.tasks, executionThreadId)
              );
              return (
                <RoutineRunCard
                  message={m}
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
            case "activity": {
              // a failed turn is an error, not a tool run — render it as one.
              // bot⇄bot comm chips and opened-thread chips stay because they
              // link to another conversation.
              // plain tool runs stay out unless Settings → Tool calls is on.
              if (m.tool?.name.startsWith("error:")) {
                return (
                  <ErrorRow
                    message={m.tool.name.slice(6).trim()}
                    onRetry={m.id === messages.at(-1)?.id && canRetryLast ? onRegenerate : undefined}
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
            default:
              return (
                <Bubble
                  bot={bot}
                  message={m}
                  shared={shared}
                  emerging={m.id === emergingId}
                  eagerAttachments={m.id === newestMessageId || m.id === newestUserMessageId}
                  editing={editingId === m.id}
                  isLastBotText={m.id === lastBotTextId}
                  onStartEdit={() => onStartEdit(m.id)}
                  onCancelEdit={onCancelEdit}
                  onSubmitEdit={(text) => onSubmitEdit(m.id, text)}
                  onRegenerate={onRegenerate}
                  replyTarget={m.replyToId ? bot.messages.find((candidate) => candidate.id === m.replyToId) : undefined}
                  onReply={() => onReply(m)}
                />
              );
          }
        })();
        if (!row) return null;
        return (
          <div key={m.id} className="contents" data-mid={m.id}>
            {newDay && <DaySeparator at={m.at} />}
            {row}
          </div>
        );
      })}
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

  const stream = useStreaming();
  const streaming = stream.streaming[bot.threadId];
  const reasoning = stream.reasoning[bot.threadId];
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
      if (!shared && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        setFindOpen(true);
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

  // Windowed transcript: only a tail of the thread mounts (screenshots make
  // full threads DOM-heavy). The boundary is anchored per bot+task; a
  // render-phase reset re-tails it on switch so the old thread's boundary
  // never flashes into the new one. Everything derived below (lastBotTextId,
  // lastUserMessage, working dots) stays computed from the FULL list.
  const transcriptKey = `${bot.id}:${bot.threadId}`;
  const [transcriptWindow, setTranscriptWindow] = useState<{
    key: string;
    start: number;
    end: number | null;
  }>(() => ({
    key: transcriptKey,
    start: tailWindowStart(messages.length),
    end: null,
  }));
  if (transcriptWindow.key !== transcriptKey) {
    setTranscriptWindow({ key: transcriptKey, start: tailWindowStart(messages.length), end: null });
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
  const renderedShared = shared ? {
    ...shared, editingPending: sharedEditPending, editingError: sharedEditError,
    onRequestDelete: (id: string) => {
      if (messages.some(message => message.id === id && message.role === "user") && !shared.messageMeta?.[id]?.deletedAt) {
        setRemoveError(""); setRemoveTarget(id);
      }
    },
  } : undefined;
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
  const waiting = Boolean(
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
  const loadOlder = () => {
    preExpandHeight.current = scrollRef.current ? { key: transcriptKey, height: scrollRef.current.scrollHeight } : null;
    setBottomFollow(false);
    if (shared) void shared.loadOlder?.();
    else dispatch({ type: "loadOlderMessages", threadId: bot.threadId });
  };
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
    setTranscriptWindow({ key: transcriptKey, start: tailWindowStart(messages.length), end: null });
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
      <CallOverlay bot={bot} />
      {/* Header */}
      <ConversationHeader style={headerDragStyle}>
        <div className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-1.5 py-1" style={headerNoDragStyle}>
          <button
            onClick={() => { if (shared) shared.onOpenDetails?.(); else if (local) dispatch({ type: "toggleSettings", open: true }); }}
            className="flex size-10 shrink-0 items-center justify-center rounded-lg hover:bg-raised/50"
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
                size={28}
                motion={mascotMotion?.kind ?? "none"}
                motionKey={mascotMotion?.nonce ?? 0}
              />
            )}
          </button>
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
            showEditButton
            className="truncate text-[15px] font-semibold text-ink"
            inputClassName="max-w-[220px] rounded bg-inset px-1.5 py-0.5 text-[15px] font-semibold"
          />}
          {remoteHint && <span className="shrink-0 truncate text-[12px] text-ink-secondary" data-testid="remote-bot-hint">{remoteHint}</span>}
          {!shared && bot.chiefOfStaff && (
            <span className="flex items-center gap-1 rounded-full bg-accent/12 px-2 py-0.5 text-[11px] font-medium text-accent">
              <Crown size={11} /> {t("chat.chiefOfStaff")}
            </span>
          )}
          {bot.busy && <WorkingDots className="text-ink-secondary" />}
        </div>
        <div
          className="flex shrink-0 items-center gap-2"
          // The caption buttons sit over the header's right end; drop this
          // icon row 16px (visual only — the header keeps its height) so the
          // buttons clear the 26px overlay while the rest of the layout stays.
          style={controlsShiftStyle}
        >
          {shared?.actions}
          {!shared && <button
            onClick={() => setFindOpen((open) => !open)}
            aria-label={t("chat.find")}
            aria-pressed={findOpen}
            className={cn(
              "rounded-md p-1.5 hover:bg-raised",
              findOpen ? "text-accent" : "text-ink-secondary hover:text-ink",
            )}
            title={t("chat.findShortcut")}
          >
            <Search size={18} />
          </button>}
          {!remoteHint && <ExportTranscriptMenu
            title={bot.name}
            messages={messages}
            botName={bot.name}
          />}
          {!shared && bot.busy && (
            <button
              onClick={() => dispatch({ type: "interrupt", botId: bot.id, threadId: bot.threadId })}
              className={cn(
                "flex items-center gap-1.5 rounded-full border border-hairline/40 bg-raised/60 px-2.5 py-1 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink",
                COMPACT_BUBBLE,
              )}
              title={t("chat.stopTurn")}
            >
              <Square size={12} className="fill-current" />
              <span className="@max-4xl/chathead:hidden">{t("chat.stop")}</span>
            </button>
          )}
          {!shared && <TaskPicker bot={bot} />}
          {local && <div className="@max-3xl/chathead:hidden"><UsageChip bot={bot} /></div>}
          {local && !remoteClient && <div className="@max-3xl/chathead:hidden"><ModelPicker key={bot.threadId} bot={bot} threadId={bot.threadId} /></div>}
          {!shared && <CallButton bot={bot} />}
          {local && <button
            data-tour="computer"
            onClick={() => dispatch({ type: "toggleComputer" })}
            className={cn(
              "rounded-md p-1.5 hover:bg-raised",
              state.computerOpen ? "text-accent" : "text-ink-secondary hover:text-ink",
            )}
            title={t("chat.computer")}
          >
            <Monitor size={18} />
          </button>}
          {local && !remoteClient && <button
            onClick={() => dispatch({ type: "toggleInspector" })}
            aria-label={t("chat.inspector")}
            aria-pressed={state.inspectorOpen}
            className={cn(
              "rounded-md p-1.5 hover:bg-raised @max-3xl/chathead:hidden",
              state.inspectorOpen ? "text-accent" : "text-ink-secondary hover:text-ink",
            )}
            title={t("chat.inspectorHint")}
          >
            <Bug size={18} />
          </button>}
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

      {/* Pinned message banner */}
      <PinnedBanner
        bot={bot}
        pinnedId={bot.pinnedMessageId}
        messages={messages}
        onJump={(messageId) =>
          dispatch({ type: "focusMessage", threadId: bot.threadId, messageId })
        }
        onUnpin={remoteClient ? undefined : () =>
          dispatch({ type: "updateTask", botId: bot.id, threadId: bot.threadId, patch: { pinnedMessageId: "" } })
        }
      />


      {/* Messages + composer share one pane so bubbles scroll into the pill
          instead of dying on a rectangular clip above a black dock. */}
      <div className="relative min-h-0 flex-1">
      <div
        ref={scrollRef}
        className="h-full overflow-x-hidden overflow-y-auto overscroll-y-contain px-5 [overflow-anchor:none]"
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
          if (resume) setBottomFollow(true);
        }}
      >
        <div
          ref={transcriptRef}
          className="flex w-full flex-col gap-3"
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
          ) : bot.hasMore ? (
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
          <TurnPresence
            avatar={
              // BotAvatar, not a bare MausAvatar: an uploaded profile image
              // (and a chosen mascot body) must match the sidebar row.
              <BotAvatar
                bot={bot}
                state={toolInFlight ? "working" : "thinking"}
                size={36}
                forward={false}
                lookAround={1}
                trackPointer={false}
              />
            }
            visible={presenceVisible}
            label={activityLabel}
            answering={popping !== null}
            since={busySince}
          />
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
      {lastRunStep && showRun(recordedRun) && runDismissed.get(transcriptKey) !== lastRunStep.id && (
        <div className="flex justify-end px-5 pb-2">
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
      <Composer
        key={bot.threadId}
        bot={profile}
        shared={shared}
        locked={shared?.historyLoading}
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
function UsageChip({ bot }: { bot: Bot }) {
  const { state, dispatch } = useStore();
  const usage = bot.tasks?.find((t) => t.threadId === bot.threadId)?.usage;
  const text = usage ? usageChip(usage) : "";
  if (!usage || !text) return null;
  const billing = state.instances.find((i) => i.instanceId === bot.modelSelection.instanceId)?.snapshot.billing;
  const share = contextShare(usage);
  const detail = [
    usage.turns === 1 ? t("chat.usage.turnsOne") : t("chat.usage.turnsMany", { count: usage.turns }),
    usageDetail(usage),
    lastTurnDetail(usage),
    contextDetail(usage),
    // the whole thread rides along on every turn, so most of "in" is the
    // model re-reading what it already saw — say so, or the figure reads as
    // a bug (issue #527); past 80% of the window the fix is a new thread
    share?.tone === "danger" ? t("chat.usage.contextNudge") : null,
    cachedInput(usage) > 0 ? (cachedKnown(usage) ? t("chat.usage.newNote") : t("chat.usage.cachedNote")) : null,
    hasFiniteCost(usage.costUsd) ? `${formatUsd(usage.costUsd)} ${costCaption(billing)}` : null,
  ]
    .filter(Boolean)
    .join("\n");
  // folded: one figure — cost when the engine reports one, else new tokens
  const short = hasFiniteCost(usage.costUsd) ? formatUsd(usage.costUsd) : formatTokens(cachedKnown(usage) ? freshTokens(usage) : usage.input + usage.output);
  const ctx = contextChip(usage);
  return (
    <button
      onClick={() => dispatch({ type: "toggleSettings", open: true, section: "usage" })}
      className="whitespace-nowrap rounded-full border border-hairline/40 bg-raised/60 px-2.5 py-1 text-[12px] tabular-nums text-ink-secondary hover:bg-raised hover:text-ink @max-4xl/chathead:px-2"
      title={detail}
      data-testid="usage-chip"
    >
      <span className="@max-4xl/chathead:hidden">{text}</span>
      <span className="hidden @max-4xl/chathead:inline">{short}</span>
      {ctx && <span className={cn("ml-1.5 @max-4xl/chathead:hidden", share?.tone === "danger" ? "text-danger" : share?.tone === "warning" ? "text-warning" : "")} data-testid="usage-context">{ctx}</span>}
    </button>
  );
}
