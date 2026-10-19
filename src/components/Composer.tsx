import { RemoteFullAccess } from "./RemoteFullAccess";
import { useSharedDelivery } from "@/lib/shared-delivery";
import { track } from "@/lib/analytics";
import { useCallback, useEffect, useMemo, useRef, useState, type SetStateAction } from "react";
import { ArrowUp, AudioLines, BookOpen, Clock, Folder, ListEnd, Loader2, Mic, Paperclip, Square, Target, Users, X } from "lucide-react";
import { startRealtimeCall, useRealtimeCall } from "@/lib/voice-call/session";
import { callIsOn, useCallSnapshot } from "./voice-call/VoiceCall";
import { useStore, visibleMessages, currentTaskBot, signInBeforeSend, type Bot, type Group, type Message } from "@/state/store";
import { EnginesBeat } from "./onboarding/beats/EnginesBeat";
import { cn } from "@/lib/cn";
import { activeLocale, t } from "@/lib/i18n";
import {
  draftRevision,
  restoreComposerDraft,
  replyDraft,
  appendDraftAttachments,
  changeDraftAttachmentPending,
  forgetFailedComposerSend,
  markDraftEdited,
  recoverFailedComposerSend,
  rememberFailedComposerSend,
  replaceDraftAttachment,
  restoredSendId,
  useComposerDraft,
  useComposerChannelMode,
  useDraftAttachmentPending,
  useFailedComposerSends,
  type ComposerSendSnapshot,
  type FailedComposerSend,
} from "@/lib/drafts";
import { BotAvatar, PersonPhoto } from "./Avatar";
import { ConversationComposerFrame, ConversationTools } from "./ConversationChrome";
import { MentionTextarea } from "./MentionTextarea";
import { ComposerAttachments, pathForFile, uploadOnlyIntake } from "./ComposerAttachments";
import { AppshotMenuItem, AppshotPicker } from "./AppshotPicker";
import { appshotsAvailable, useAppshotHost } from "@/lib/appshot";
import { LocalComputerAutoWarning } from "./LocalComputerAutoWarning";
import { PlaceChip } from "./PlaceChip";
import { ModelPicker } from "./ModelPicker";
import { ComposerDictation } from "./ComposerDictation";
import { ComposerVoicePending, ComposerVoiceRecorder } from "./ComposerVoiceRecorder";
import { micProblem, micSettingsPlace, VoiceRecording, voiceRecordingSupported } from "@/lib/voice-recorder";
import { deliverVoice, discardPendingVoice, queueVoiceMessage, restorePendingVoice, usePendingVoice, type VoiceDispatch, type VoiceTarget } from "@/lib/voice-send";
import { FullAccessWarning } from "./FullAccessWarning";
import { ApprovalModeSelector } from "./ApprovalModeSelector";
import { approvalModeFor, type ApprovalMode } from "../../shared/approval-mode";
import {
  appendPastedText,
  handoffAttachmentImagePreview,
  clipboardHasImages,
  clipboardImageFiles,
  composeMessage,
  imageAttachmentFromFile,
  intakeFiles,
  isLongPaste,
  optimisticImageAttachment,
  pasteAttachment,
  releaseAttachmentImagePreview,
  type Attachment,
  type PasteAttachment,
} from "@/lib/composer-attachments";
import { normalizeState } from "@/lib/mascot";
import { goalCoordinatorForComposer, groupComposerHint, roomRespondersForComposer, roomSteerTarget } from "@/lib/group-routing";
import { PendingApprovalActions, PendingApprovalPanel, pendingApprovals } from "./PendingApproval";
import { useDesktopCapabilities } from "./DesktopCapabilities";
import { ReplyQuote } from "./ReplyQuote";
import { useThreadRefs } from "./ThreadRefs";
import {
  QueuedComposerMessages,
  composerCanSteerQueuedMessages,
} from "./ComposerQueuedMessages";
import { skillAuthoringEnabled } from "@/lib/feature-flags";
import { attentionPreferences } from "@/lib/attention-preferences";
import { composerPriorityVisible, effectiveSendPriority, type SendPriority } from "@/lib/composer-priority";
import { mentionChoicesForQuery, mentionMatchRange } from "@/lib/mentions";
import { roomMentionPool, roomBotSupportsImages } from "@/lib/room-members";
import { botControlAvailable, mentionableBots } from "@/lib/remote-bot";
import { sharedAttachmentError, type SharedComposer } from "./shared-conversation";
import { serializeThreadRefs, threadTokenFromPaste, threadTokenSpacing } from "@/lib/thread-refs";
import {
  composerSlashTrigger,
  goalTextFromComposer,
  replaceComposerSlashTrigger,
  type ComposerSlashCommand,
} from "@/lib/composer-commands";

/** The active @mention query at the caret: the text between an `@` that
 * starts a word and the caret. null = no mention being typed. */
function mentionQueryAt(text: string, caret: number): { start: number; query: string } | null {
  const upto = text.slice(0, caret);
  const at = upto.lastIndexOf("@");
  if (at === -1) return null;
  if (at > 0 && !/\s/.test(upto[at - 1])) return null; // user@host, not a tag
  const query = upto.slice(at + 1);
  if (query.length > 24 || query.includes("@") || query.includes("\n")) return null;
  return { start: at, query };
}

type MentionChoice = { id: string; name: string; bot?: Bot; searchText?: string; avatar?: string | null };

interface ComposerDraftSnapshot extends ComposerSendSnapshot {
  reply: Message | null;
}

/** Renders the editable message composer and its pending attachments. */
export function Composer({
  bot: profile,
  group,
  members,
  shared,
  onEditLast,
  replyTo,
  replyToAuthor,
  onClearReply,
  onConsumeReply,
  onRestoreReply,
  locked: setupLocked = false,
}: {
  bot?: Bot;
  group?: Group;
  members?: Bot[];
  shared?: SharedComposer;
  onEditLast?: () => void;
  replyTo?: Message | null;
  /** The quoted line's author when it isn't the message's own label (another person in a room). */
  replyToAuthor?: string;
  onClearReply?: () => void;
  onConsumeReply?: () => void;
  onRestoreReply?: (message: Message, threadId: string) => void;
  /** New rooms keep the composer inert until their setup is saved or skipped. */
  locked?: boolean;
}) {
  const bot = profile ? currentTaskBot(profile) : undefined;
  const locked = setupLocked || Boolean(bot?.awaitingThreadSnapshot);
  const { state, dispatch } = useStore();
  // no engine is signed in: the message stays in the composer until one is
  const needsSignIn = Boolean(bot && !group && !shared) && signInBeforeSend(state, bot?.id);
  const signInCardInThread = Boolean(bot?.messages.some((m) => m.onboarding?.card?.kind === "engine"));
  const { threads, currentBotId } = useThreadRefs();
  const { capabilities } = useDesktopCapabilities();
  // Grok's composer ends in the voice button: a 1:1 chat with xAI voice set
  // up starts the call from here, the header only shows a call in progress.
  const callEngine = useRealtimeCall();
  const callSnapshot = useCallSnapshot(callEngine);
  const voiceCallReady = Boolean(bot && !group && !shared && state.config?.xai?.configured === true && !(callEngine && callIsOn(callSnapshot)));
  const remoteClient = window.ogb?.remoteClient?.active === true;
  // Unified target: a 1:1 bot thread or a room. In a room the @ picker
  // offers members plus @everyone; explicit mentions override the room's
  // configured default responder.
  const busy = !shared && (group ? Boolean(group.working || group.busyBotId) : Boolean(bot?.busy));
  // an engine with a live session takes a message INTO the running turn;
  // for those the composer never locks — the server steers instead of 409.
  // A room steers through its busy speaker's engine, mirroring how the
  // server's queue-steer route resolves the running turn.
  const steerInstanceId = group
    ? members?.find((member) => member.id === group.busyBotId)?.modelSelection.instanceId
    : bot?.modelSelection.instanceId;
  const canSteer =
    state.instances.find((i) => i.instanceId === steerInstanceId)?.capabilities?.queueing === true;
  // a pending approval blocks the prompt until it is answered
  const threadId = group?.threadId ?? bot?.threadId ?? "";
  // The conversation's own place, when pinned; the chip reads it next to the bot default.
  const composerTask = profile?.tasks?.find((task) => task.threadId === threadId);
  // the VISIBLE branch only — an approval left on a branch you edited away
  // from must not keep blocking the composer
  const approvals = pendingApprovals(group ? group.messages : bot ? visibleMessages(bot) : []);
  const approval = approvals[0];
  const approvalBot = group
    ? members?.find((member) => member.id === approval?.message.from?.botId) ??
      members?.find((member) => member.id === group.busyBotId)
    : bot;
  const busyName = group
    ? (members?.find((b) => b.id === group.busyBotId)?.name ??
      (group.working ? t("composer.busy.team") : t("composer.busy.aBot")))
    : (bot?.name ?? t("composer.busy.theBot"));
  // Per-thread draft: switching bots unmounts this component, so both the
  // text and its attachment chips have to outlive it (see lib/drafts).
  const draftId = group
    ? `group:${group.id}:${group.threadId}`
    : `bot:${bot?.id ?? ""}:${bot?.threadId ?? ""}`;
  const [text, setText, attachments, setAttachments] = useComposerDraft(
    draftId,
    !group && bot ? `bot:${bot.id}` : undefined,
  );
  const attachmentPending = useDraftAttachmentPending(draftId);
  const failedSends = useFailedComposerSends(draftId);
  // Goal mode is opt-in and one-shot so the next ordinary channel message
  // cannot accidentally start another multi-turn team run.
  const [channelMode, setChannelMode] = useComposerChannelMode(draftId);
  const { delivery: sharedDelivery, files: sharedFiles, status: sharedStatus, error: sharedError } = useSharedDelivery(draftId);
  const sharedSending = sharedStatus === "sending";
  const [sharedIntakeError, setSharedError] = useState("");
  const editText = useCallback(
    (next: string) => {
      markDraftEdited(draftId);
      if (shared) sharedDelivery.edit();
      setText(next);
    },
    [draftId, setText, shared, sharedDelivery],
  );
  const editAttachments = useCallback(
    (next: SetStateAction<Attachment[]>) => {
      markDraftEdited(draftId);
      setAttachments(next);
    },
    [draftId, setAttachments],
  );
  const restoreDraft = useCallback(
    (sent: ComposerDraftSnapshot) => {
      // Shared recovery reaches a newly mounted view after navigation and
      // falls back to a separate retry item when a newer draft already exists.
      if (recoverFailedComposerSend(sent) === "restored") {
        if (sent.reply) onRestoreReply?.(sent.reply, sent.threadId);
      }
    },
    [onRestoreReply],
  );
  const addAttachments = useCallback(
    (next: Attachment[]) => appendDraftAttachments(draftId, next),
    [draftId],
  );
  const removeAttachment = useCallback(
    (id: string) => {
      const removed = attachments.find((attachment) => attachment.id === id);
      if (removed?.kind === "image") releaseAttachmentImagePreview(removed);
      editAttachments((prev) => prev.filter((attachment) => attachment.id !== id));
    },
    [attachments, editAttachments],
  );
  const displayPasteInChatBox = useCallback(
    /** Moves one pasted attachment into the editable draft and restores focus. */
    function displayPasteInChatBox(attachment: PasteAttachment) {
      const nextText = appendPastedText(text, attachment.text);
      editText(nextText);
      editAttachments((prev) => prev.filter((a) => a.id !== attachment.id));
      setCaret(nextText.length);
      setDismissedAt(null);
      requestAnimationFrame(() => {
        const input = inputRef.current;
        if (!input) return;
        input.focus();
        input.setSelectionRange(nextText.length, nextText.length);
      });
    },
    [text, editText, editAttachments],
  );
  const [recording, setRecording] = useState(false);
  const [speechFinishing, setSpeechFinishing] = useState(false);
  const speechDraft = useRef("");
  const speechCancelled = useRef(false);
  const speechSendRequested = useRef(false);
  const latestSend = useRef<(dictatedText?: string) => void>(() => {});
  const speechText = useRef("");
  const speechDraftId = useRef(draftId);
  const latestDraftId = useRef(draftId);
  latestDraftId.current = draftId;
  const [speechError, setSpeechError] = useState<string | null>(null);
  // Browser voice messages (no native dictation here): record, then the
  // recording is sent as audio plus its transcript by lib/voice-send.
  const [voice, setVoice] = useState<{ recording: VoiceRecording | null; draftId: string; target: VoiceTarget; reply: boolean } | null>(null);
  const voiceRef = useRef(voice);
  voiceRef.current = voice;
  const pendingVoice = usePendingVoice(draftId);
  const editSharedFiles = (change: (previous: File[]) => File[]) => {
    markDraftEdited(draftId);
    sharedDelivery.setFiles(change);
  };
  const [caret, setCaret] = useState(0);
  const [highlight, setHighlight] = useState(0);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null); // Esc'd this @
  const [dismissedSlashAt, setDismissedSlashAt] = useState<number | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const mentionListRef = useRef<HTMLDivElement>(null);
  // what was typed before the mic went on — partials append after it
  const baseText = useRef("");

  // image paste is offered only when every bot that will actually answer
  // can open one. sendGroup routes to mentions, else the room default —
  // `members.some` would let a mixed room send <attached-image> to Grok.
  // A bot relayed from a linked Mac runs an engine this Mac may not have
  // installed; its own server decides, so never gate it on local instances.
  const botSupportsImages = (candidate?: Bot) => roomBotSupportsImages(candidate, state.instances);
  const imageTargetsSupport = (message: string, mode: "chat" | "goal") => {
    if (!group) return botSupportsImages(bot);
    // A remote room's provider is decided on its host. Upload pixels even
    // before a mention is typed; never fall back to a path on this Mac.
    if (group.home && mode === "chat") return true;
    if (mode === "goal") {
      return botSupportsImages(goalCoordinatorForComposer(message, members ?? [], group) ?? undefined);
    }
    const responders = roomRespondersForComposer(message, members ?? [], group);
    return responders.length > 0 && responders.every(botSupportsImages);
  };
  const typedGoalText = group && !group.dm ? goalTextFromComposer(text) : null;
  const effectiveText = typedGoalText ?? text;
  const effectiveChannelMode = typedGoalText !== null ? "goal" : channelMode;
  const engineSupportsImages = imageTargetsSupport(effectiveText, effectiveChannelMode);

  // ── Slash commands and @mentions ─────────────────────────────────────
  const slash = composerSlashTrigger(text, caret);
  const locale = activeLocale();
  const commandCandidates = useMemo(() => {
    if (shared || !slash || slash.start === dismissedSlashAt) return [];
    const supportsAgents = (candidate?: Bot) =>
      Boolean(
        candidate &&
          state.instances.find(
            (instance) => instance.instanceId === candidate.modelSelection.instanceId,
          )?.capabilities?.agentsMcp,
      );
    const available: ComposerSlashCommand[] = [];
    if (group && !group.dm) available.push({
      id: "goal",
      label: "/goal",
      description: t("composer.command.goalDesc"),
    });
    if (
      skillAuthoringEnabled(state.config) &&
      (group ? (members ?? []).some(supportsAgents) : supportsAgents(bot))
    ) {
      available.push({
        id: "learn",
        label: "/learn",
        description: t("composer.command.learnDesc"),
      });
    }
    // Setup mode needs the agents tools (propose_profile and friends) and a
    // single bot: a room cannot set itself up.
    if (!group && supportsAgents(bot)) available.push({
      id: "setup",
      label: "/setup",
      description: t("composer.command.setupDesc"),
    });
    const query = slash.query.toLowerCase();
    return available.filter(
      (command) =>
        !query ||
        command.id.startsWith(query) ||
        command.description.toLowerCase().includes(query),
    );
  }, [slash, dismissedSlashAt, group, members, bot, state.config, state.instances, locale, shared]);
  const commandPickerOpen = commandCandidates.length > 0;

  // Tag another bot; the agent reaches it via ask_bot.
  const mention = mentionQueryAt(text, caret);
  const candidates = useMemo(() => {
    if (!mention || mention.start === dismissedAt) return [];
    const pool: MentionChoice[] = shared
      ? [...(shared.mentionPeople ?? []).map(person => ({ ...person, searchText: "Person" })), ...shared.mentionBots.map(member => ({ id: member.id, name: member.name, bot: member, searchText: member.title }))]
      : group
      ? roomMentionPool(group, members ?? [])
      : mentionableBots(state.bots, bot?.id)
          .map((member) => ({ id: member.id, name: member.name, bot: member }));
    return mentionChoicesForQuery(pool, mention.query);
  }, [mention, dismissedAt, state.bots, bot?.id, group, members, shared]);
  const mentionPickerOpen = candidates.length > 0;

  useEffect(
    () => setHighlight(0),
    [mention?.start, mention?.query, slash?.start, slash?.query],
  );

  useEffect(() => {
    if (!mentionPickerOpen) return;
    mentionListRef.current
      ?.querySelector<HTMLElement>(`[data-mention-index="${highlight}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [highlight, mentionPickerOpen]);

  const pickMention = (peer: MentionChoice) => {
    if (!mention) return;
    const after = text.slice(caret);
    // tagging mid-sentence already has a space after the caret; don't double it
    const gap = /^\s/.test(after) ? "" : " ";
    const next = `${text.slice(0, mention.start)}@${peer.name}${gap}${after}`;
    editText(next);
    const newCaret = mention.start + peer.name.length + 2;
    setCaret(newCaret);
    // picking completes this tag — close the popup so the next Enter sends
    setDismissedAt(mention.start);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(newCaret, newCaret);
    });
  };

  const pickCommand = (command: ComposerSlashCommand) => {
    if (!slash) return;
    const replacement = command.id === "learn" ? "/learn " : command.id === "setup" ? "/setup " : "";
    const next = replaceComposerSlashTrigger(text, slash, replacement);
    editText(next.text);
    setCaret(next.caret);
    setDismissedSlashAt(slash.start);
    setChannelMode(command.id === "goal" ? "goal" : "chat");
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(next.caret, next.caret);
    });
  };

  // Busy sends are owned by the harness immediately for both channels and
  // 1:1 chats. Keeping a channel follow-up in this component used to lose its
  // auto-send intent whenever navigation unmounted the composer.
  const pendingCount = (state.pendingQueued[threadId] ?? []).length;
  const queuedMessages = state.pendingQueued[threadId] ?? [];
  // Steering a relayed bot's queue is refused by its server; cancel still works.
  const canSteerQueued = botControlAvailable(bot, "steer") && composerCanSteerQueuedMessages(
    busy,
    locked,
    pendingCount,
    Boolean(approval),
  );
  const [steering, setSteering] = useState(false);
  const [stopping, setStopping] = useState(false);
  const stopPending = useRef(false);
  useEffect(() => {
    stopPending.current = false;
    setStopping(false);
  }, [threadId, busy]);
  useEffect(() => {
    if (!stopping) return;
    const timeout = window.setTimeout(() => {
      stopPending.current = false;
      setStopping(false);
    }, 15000);
    return () => window.clearTimeout(timeout);
  }, [stopping]);
  const interruptTurn = () => {
    if (stopPending.current || (!group && !bot)) return;
    stopPending.current = true;
    setStopping(true);
    const onError = () => { stopPending.current = false; setStopping(false); };
    if (group) dispatch({ type: "interruptGroup", groupId: group.id, threadId, onError });
    else if (bot) dispatch({ type: "interrupt", botId: bot.id, threadId, onError });
  };
  const queueHeadId = queuedMessages[0]?.queueId;
  // Rooms run several members at once: a queued item steers into the member
  // the server will pick for it (its @mention, else the only active speaker),
  // never whoever happens to be listed busy first.
  const roomSteerFor = (text: string) => {
    if (!group) return null;
    const target = roomSteerTarget(
      text,
      members ?? [],
      group.activeBotIds?.length ? group.activeBotIds : group.busyBotId ? [group.busyBotId] : [],
    );
    const member = target.kind === "member" ? target.member : undefined;
    const capable = member
      ? state.instances.find((i) => i.instanceId === member.modelSelection.instanceId)?.capabilities?.queueing === true
      : canSteer;
    const unavailable = target.kind === "ambiguous"
      ? t("composer.queued.steerChoose")
      : target.kind === "waiting"
        ? target.members.length === 1
          ? t("composer.queued.waitsFor", { name: target.members[0]!.name })
          : t("composer.queued.waitsForTurn")
        : undefined;
    return { member, capable, unavailable };
  };
  const roomSteer = queuedMessages[0] ? roomSteerFor(queuedMessages[0].text) : null;
  const roomSteerMember = roomSteer?.member;
  const roomSteerCapable = roomSteer ? roomSteer.capable : canSteer;
  const roomSteerUnavailable = roomSteer?.unavailable;
  /** Steer one queued item that already sits at the head. */
  const steerHeadItem = (queueId: string, text: string) => {
    setSteering(true);
    const settle = () => setSteering(false);
    const room = roomSteerFor(text);
    if (group && room?.member && room.capable) {
      // A steer-capable room folds the queued head into the running turn
      // through the server; it never interrupts the turn to do it. Naming
      // the member makes the server refuse rather than deliver elsewhere.
      dispatch({ type: "steerGroupQueued", groupId: group.id, threadId, queueId, botId: room.member.id, onError: settle, onSettled: settle });
    } else if (group && room?.unavailable) {
      settle();
    } else if (group) {
      // A room whose running engine cannot steer keeps the old behavior:
      // Steer ends the running turn so the next queued message starts.
      dispatch({ type: "interruptGroup", groupId: group.id, threadId, onError: settle });
    } else if (bot && canSteer) {
      // A steer-capable engine folds the queued words into the running turn
      // through the server; it never interrupts the turn to do it.
      dispatch({ type: "steerQueued", botId: bot.id, threadId, queueId, onError: settle, onSettled: settle });
    } else if (bot) {
    // Unlike the general Stop control, Steer belongs to this exact queue.
    // Scoping prevents a 1:1 queue from interrupting the same bot in a room
    // (or a routine) whose work is unrelated to the words shown here.
      dispatch({ type: "interrupt", botId: bot.id, threadId, onError: settle });
    }
  };
  const steerQueued = (queueId: string | undefined = queueHeadId) => {
    const item = queuedMessages.find((entry) => entry.queueId === queueId);
    if (!item) return;
    if (item.queueId === queueHeadId) {
      steerHeadItem(item.queueId, item.text);
      return;
    }
    // "send now" on a later item: move it to the front first, then steer it
    // like the head. A bot queue still carries the rest along behind it.
    const previous = queuedMessages.map((entry) => entry.queueId);
    const order = [item.queueId, ...previous.filter((id) => id !== item.queueId)];
    setSteering(true);
    dispatch({
      type: "reorderQueued",
      threadId,
      order,
      previous,
      ...(group ? { groupId: group.id } : { botId: bot?.id }),
      onSaved: () => steerHeadItem(item.queueId, item.text),
      onError: () => setSteering(false),
    });
  };
  useEffect(() => setSteering(false), [threadId, queueHeadId]);
  // Queue vs block only means something while a turn is running. It is
  // one-shot: every send, and every end of the busy spell, puts it back on
  // queue so an interrupt is never left armed for a later message.
  const [priority, setPriority] = useState<SendPriority>(() => attentionPreferences().followUps);
  const priorityVisible = composerPriorityVisible({
    busy,
    locked,
    shared: Boolean(shared),
    approvalPending: Boolean(approval),
  });
  const blockArmed = effectiveSendPriority(priority, priorityVisible) === "queue";
  useEffect(() => {
    if (!priorityVisible) setPriority(attentionPreferences().followUps);
  }, [priorityVisible]);
  // Most engines acknowledge interruption quickly, but a lost response must
  // not leave a control claiming to steer forever. Queue drain or turn end
  // clears it immediately; twenty seconds is the final recovery floor.
  useEffect(() => {
    if (!busy || pendingCount === 0) {
      setSteering(false);
      return;
    }
    if (!steering) return;
    const timeout = window.setTimeout(() => setSteering(false), 20_000);
    return () => window.clearTimeout(timeout);
  }, [busy, pendingCount, steering]);
  const fileInput = useRef<HTMLInputElement>(null);
  const [approvalWarning, setApprovalWarning] = useState<{
    mode: "auto" | "full";
    botId: string;
    threadId: string;
  } | null>(null);
  const [attachmentNotice, setAttachmentNotice] = useState<string | null>(null);
  // Approval mode belongs to one bot; a room has several, each with its own.
  // A bot on a linked Mac keeps its approval level and place on that Mac.
  const modeBot = group || shared || bot?.remote ? undefined : bot;
  const approvalEngine = modeBot
    ? state.instances.find((instance) => instance.instanceId === modeBot.modelSelection.instanceId)
    : undefined;
  const trustedThreadAccess = Boolean(!remoteClient && window.ogb?.approvals && capabilities.host.packaged);
  const uploadImage = useCallback(async (file: File): Promise<Attachment | null> => {
    const optimistic = optimisticImageAttachment(file);
    if (!optimistic) return null;
    appendDraftAttachments(draftId, [optimistic]);
    try {
      const completed = await imageAttachmentFromFile(file, optimistic);
      if (!completed) {
        replaceDraftAttachment(draftId, optimistic.id, null);
        releaseAttachmentImagePreview(optimistic);
        return null;
      }
      handoffAttachmentImagePreview(completed.path, completed.previewUrl);
      if (!replaceDraftAttachment(draftId, optimistic.id, completed)) {
        // The user removed the chip while its upload was completing.
        releaseAttachmentImagePreview(completed);
      }
      // The keyed draft already owns the completed attachment; returning it
      // would make intakeFiles append a duplicate chip.
      return null;
    } catch (error) {
      replaceDraftAttachment(draftId, optimistic.id, null);
      releaseAttachmentImagePreview(optimistic);
      throw error;
    }
  }, [draftId]);
  const pickFiles = async (picked: FileList | File[] | null) => {
    if (!picked?.length) return;
    if (shared) {
      const next = Array.from(picked);
      const problem = next.map(sharedAttachmentError).find(Boolean);
      if (problem) { setSharedError(problem); return; }
      setSharedError("");
      editSharedFiles(previous => [...previous, ...next].slice(0, 4));
      return;
    }
    changeDraftAttachmentPending(draftId, true);
    try {
      const remote = bot?.remote || group?.home ? uploadOnlyIntake() : null;
      const { attachments: added, notice: intakeNotice } = await intakeFiles(Array.from(picked), {
        allowImages: engineSupportsImages,
        getPath: remote?.getPath ?? pathForFile,
        uploadImage,
      });
      const notice = remote ? remote.notice(intakeNotice) : intakeNotice;
      if (added.length) addAttachments(added);
      if (notice) setAttachmentNotice(notice);
    } finally {
      changeDraftAttachmentPending(draftId, false);
    }
  };
  // Appshots land through the same path as picked files (images upload, a
  // text-only engine gets the usual notice). Only the top composer hosts it.
  const appshotListing = useAppshotHost((file) => {
    void pickFiles([file]);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, !locked);
  const setApprovalMode = (mode: ApprovalMode) => {
    if (!modeBot || modeBot.busy || mode === approvalModeFor(modeBot)) return;
    if ((mode === "full" || mode === "custom") && !trustedThreadAccess) return;
    if (mode === "full") {
      setApprovalWarning({ mode, botId: modeBot.id, threadId: modeBot.threadId });
      return;
    }
    // Safe Auto still needs its dedicated warning when it can drive the host.
    if (mode === "auto" && modeBot.computer === "local") {
      setApprovalWarning({ mode: "auto", botId: modeBot.id, threadId: modeBot.threadId });
      return;
    }
    dispatch({ type: "updateTask", botId: modeBot.id, threadId: modeBot.threadId, patch: { approvalMode: mode } });
  };

  const hasContent = Boolean(effectiveText.trim()) || attachments.length > 0 || sharedFiles.length > 0;
  const retryFailedSend = (failed: FailedComposerSend) => {
    const failedMode = failed.channelMode ?? "chat";
    if (failed.requestText.includes("<attached-image ") && !imageTargetsSupport(failed.requestText, failedMode)) {
      dispatch({ type: "error", message: t("composer.error.noImages") });
      return;
    }
    forgetFailedComposerSend(draftId, failed.id);
    const retry = {
      sendId: failed.sendId,
      text: failed.requestText,
      replyToId: failed.replyToId,
      threadId: failed.threadId,
      onError: () => {
        rememberFailedComposerSend(draftId, {
          sendId: failed.sendId,
          text: failed.text,
          requestText: failed.requestText,
          replyToId: failed.replyToId,
          threadId: failed.threadId,
          channelMode: failed.channelMode,
        });
      },
    };
    if (group) {
      dispatch({ type: "sendGroup", groupId: group.id, mode: failedMode, ...retry });
    } else if (bot) {
      dispatch({ type: "send", botId: bot.id, ...retry });
    }
  };
  const send = (override?: SendPriority, dictatedText?: string) => {
    const sendText = dictatedText ?? text;
    const sendGoal = group && !group.dm ? goalTextFromComposer(sendText) : null;
    const sendEffectiveText = sendGoal ?? sendText;
    const sendChannelMode = sendGoal !== null ? "goal" : channelMode;
    if (locked || attachmentPending || needsSignIn) return;
    if (shared) {
      if ((!sendText.trim() && !sharedFiles.length) || sharedSending) return;
      const sentReplyId = replyTo?.id;
      const revision = draftRevision(draftId);
      void sharedDelivery.send(sendText.trim(), sentReplyId,
        snapshot => shared.send(snapshot.text, snapshot.files, snapshot.sendId, snapshot.replyTo ? { replyTo: snapshot.replyTo } : undefined),
        () => {
          // Notify a newly mounted composer too, and never overwrite edits
          // made while this send was uploading in another conversation.
          if (draftRevision(draftId) === revision) restoreComposerDraft(draftId, { text: "", attachments: [] });
          if (replyDraft(threadId) === sentReplyId) onConsumeReply?.();
        });
      return;
    }
    if (
      attachments.some((attachment) => attachment.kind === "image") &&
      !imageTargetsSupport(sendEffectiveText, sendChannelMode)
    ) {
      dispatch({ type: "error", message: t("composer.error.noImages") });
      return;
    }
    // named `body`, not `t` — that name belongs to the catalog lookup now
    // resolvable "#Title" runs leave as canonical links, so the thread id
    // stays machine-readable in the stored send and the model's context
    const body = composeMessage(serializeThreadRefs(sendEffectiveText, threads, currentBotId), attachments);
    if (!body) return;
    const sentDraft: ComposerDraftSnapshot = {
      draftId,
      revision: draftRevision(draftId),
      sendId: restoredSendId(draftId) ?? crypto.randomUUID(),
      text: sendText,
      requestText: body,
      attachments: [...attachments],
      reply: replyTo ?? null,
      replyToId: replyTo?.id,
      threadId,
      channelMode: group ? sendChannelMode : undefined,
    };
    // An older server ignores "block" and still queues: the chip shows as before.
    const sendPriority = effectiveSendPriority(override ?? priority, priorityVisible);
    if (group) {
      dispatch({
        type: "sendGroup",
        groupId: group.id,
        text: body,
        sendId: sentDraft.sendId,
        replyToId: replyTo?.id,
        threadId,
        mode: sendChannelMode,
        priority: sendPriority,
        onError: () => restoreDraft(sentDraft),
      });
      track("message_sent", { room: true, mode: sendChannelMode, queued: busy });
    } else if (bot) {
      dispatch({
        type: "send",
        botId: bot.id,
        text: body,
        sendId: sentDraft.sendId,
        replyToId: replyTo?.id,
        threadId,
        priority: sendPriority,
        onError: () => restoreDraft(sentDraft),
      });
      track("message_sent", { driver: bot.modelSelection?.instanceId, queued: busy && !canSteer });
    }
    setText("");
    setAttachments([]);
    setPriority(attentionPreferences().followUps);
    onConsumeReply?.();
    if (group) setChannelMode("chat");
  };

  /**
   * Handles clipboard paste events in the composer textarea: converts pasted clipboard
   * images into uploaded attachments (if supported by the responder) and converts oversized
   * text into draft attachment chips.
   *
   * @param e - Clipboard event from the composer textarea.
   */
  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    // an image from the clipboard becomes an uploaded attachment —
    // but only for engines that can open one; a grok bot politely
    // refuses instead of receiving a path it cannot read
    const imageFiles = clipboardImageFiles(e.clipboardData);
    if (imageFiles.length > 0 || clipboardHasImages(e.clipboardData)) {
      e.preventDefault();
      if (shared) {
        if (!imageFiles.length) { setSharedError("Could not read the pasted image."); return; }
        const problem = imageFiles.map(sharedAttachmentError).find(Boolean);
        if (problem) { setSharedError(problem); return; }
        setSharedError("");
        editSharedFiles(previous => [...previous, ...imageFiles].slice(0, 4));
        return;
      }
      if (!engineSupportsImages) {
        dispatch({
          type: "error",
          message: t("composer.error.noImages"),
        });
        return;
      }
      if (!imageFiles.length) {
        dispatch({ type: "error", message: t("composer.error.clipboardImage") });
        return;
      }
      if (imageFiles.length > 0) {
        changeDraftAttachmentPending(draftId, true);
        void (async () => {
          try {
            const results = await Promise.allSettled(imageFiles.map(uploadImage));
            for (const result of results) {
              if (result.status === "rejected") {
                dispatch({
                  type: "error",
                  message: result.reason instanceof Error ? result.reason.message : "image upload failed",
                });
              }
            }
          } finally {
            changeDraftAttachmentPending(draftId, false);
          }
        })();
        return;
      }
    }
    const pasted = e.clipboardData.getData("text/plain");
    // a pasted thread reference — canonical link, its markdown shape, or a
    // raw UUID — becomes the token the composer holds when it names a
    // thread the person can see; anything else stays ordinary text
    const reference = threadTokenFromPaste(pasted, threads, currentBotId);
    if (reference) {
      e.preventDefault();
      const start = e.currentTarget.selectionStart ?? text.length;
      const end = e.currentTarget.selectionEnd ?? start;
      // "#Title" only links at a word boundary, so keep the token clear of
      // the words it may land between
      const { lead, trail } = threadTokenSpacing(text, start, end);
      const token = lead + reference.token + trail;
      editText(text.slice(0, start) + token + text.slice(end));
      const at = start + token.length;
      setCaret(at);
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.setSelectionRange(at, at);
      });
      return;
    }
    // a wall of text becomes a chip instead of burying the input
    if (!isLongPaste(pasted)) return;
    e.preventDefault();
    // Preserve native paste replacement semantics: if text was
    // selected, the attachment replaces that selection.
    const start = e.currentTarget.selectionStart;
    const end = e.currentTarget.selectionEnd;
    if (start !== end) {
      editText(`${text.slice(0, start)}${text.slice(end)}`);
      setCaret(start);
    }
    editAttachments((prev) => [...prev, pasteAttachment(pasted)]);
  };

  latestSend.current = (dictatedText) => send(undefined, dictatedText);

  // native dictation: partials stream into the input while the Swift
  // helper runs; the final transcript stays in the box, ready to edit/send
  useEffect(() => {
    if (!recording) return;
    if (speechDraftId.current !== draftId) {
      speechCancelled.current = true;
      speechSendRequested.current = false;
      setRecording(false);
      return;
    }
    const originDraftId = draftId;
    const bridge = window.ogb;
    if (!bridge) {
      setRecording(false);
      return;
    }
    setSpeechError(null);
    const offTranscript = bridge.onSpeechTranscript((line) => {
      if (!speechCancelled.current && latestDraftId.current === originDraftId && typeof line.text === "string") {
        const base = baseText.current;
        speechText.current = base ? `${base} ${line.text}` : line.text;
        editText(speechText.current);
      }
    });
    const offEnd = bridge.onSpeechEnd(({ code }) => {
      setRecording(false);
      setSpeechFinishing(false);
      const submit = speechSendRequested.current && !speechCancelled.current && code === 0;
      speechSendRequested.current = false;
      if (submit) requestAnimationFrame(() => { if (latestDraftId.current === originDraftId) latestSend.current(speechText.current); });
      if (code === 2) {
        setSpeechError(t("composer.dictation.macOnly"));
      } else if (code === 1) {
        setSpeechError(t("composer.dictation.permission"));
      }
    });
    void bridge.speechStart().catch(() => { setRecording(false); setSpeechError(t("composer.dictation.unavailable")); });
    return () => {
      offTranscript();
      offEnd();
      void bridge.speechStop();
    };
  }, [recording, editText, draftId]);

  const toggleMic = () => {
    if (!capabilities.dictation.available || !window.ogb) {
      setSpeechError(t("composer.dictation.unavailable"));
      return;
    }
    speechDraftId.current = draftId;
    speechDraft.current = text;
    speechText.current = text;
    speechCancelled.current = false;
    speechSendRequested.current = false;
    setSpeechFinishing(false);
    baseText.current = text.trim();
    setRecording(true);
  };

  const cancelDictation = () => {
    speechCancelled.current = true;
    speechSendRequested.current = false;
    setSpeechFinishing(false);
    setRecording(false);
    editText(speechDraft.current);
  };
  const finishDictation = (submit: boolean) => {
    if (speechFinishing) return;
    speechSendRequested.current = submit;
    setSpeechFinishing(true);
    const finish = window.ogb?.speechFinish;
    if (finish) void finish().catch(() => {
      speechSendRequested.current = false;
      setRecording(false);
      setSpeechFinishing(false);
      setSpeechError(t("composer.dictation.unavailable"));
    });
    else {
      setRecording(false);
      setSpeechFinishing(false);
      speechSendRequested.current = false;
      const originDraftId = draftId;
      if (submit) requestAnimationFrame(() => { if (latestDraftId.current === originDraftId) latestSend.current(speechText.current); });
    }
  };

  // ── browser voice messages ──────────────────────────────────────────
  const voiceDispatch: VoiceDispatch = useCallback((action) => dispatch(action), [dispatch]);
  const browserVoice = !capabilities.dictation.available && voiceRecordingSupported() &&
    state.config?.stt?.available === true && !shared && !bot?.remote && !group?.home && Boolean(group || bot);
  useEffect(() => { if (browserVoice) void restorePendingVoice(); }, [browserVoice]);
  const micBlockedLine = (error: unknown) => {
    const problem = micProblem(error);
    if (problem === "denied") return t(`composer.voice.denied.${micSettingsPlace(navigator.userAgent)}`);
    if (problem === "missing") return t("composer.voice.missing");
    if (problem === "busy") return t("composer.voice.busy");
    if (problem === "insecure") return t("composer.voice.insecure");
    return t("composer.voice.failedStart");
  };
  const finishVoice = async (send: boolean, hold?: string) => {
    const current = voiceRef.current;
    if (!current?.recording) {
      if (current) setVoice(null);
      return;
    }
    voiceRef.current = null;
    setVoice(null);
    if (!send) {
      current.recording.cancel();
      return;
    }
    const finished = await current.recording.stop();
    if (finished.blob.size < 800 || finished.durationMs < 600) {
      setSpeechError(t("composer.voice.tooShort"));
      return;
    }
    await queueVoiceMessage({ draftId: current.draftId, target: current.target, ...finished, hold }, voiceDispatch);
    if (current.reply && !hold) onConsumeReply?.();
  };
  const latestFinishVoice = useRef(finishVoice);
  latestFinishVoice.current = finishVoice;
  const startVoice = () => {
    if (voiceRef.current || !(group || bot)) return;
    setSpeechError(null);
    const target: VoiceTarget = group
      ? { groupId: group.id, threadId, mode: channelMode, replyToId: replyTo?.id }
      : { botId: bot!.id, threadId, replyToId: replyTo?.id };
    const pending = { recording: null, draftId, target, reply: Boolean(replyTo) };
    voiceRef.current = pending;
    setVoice(pending);
    // getUserMedia runs inside this tap: iPhone Safari only asks then.
    VoiceRecording.start(() => {
      setSpeechError(t("composer.voice.limit"));
      void latestFinishVoice.current(true);
    }).then((recording) => {
      if (voiceRef.current !== pending) { recording.cancel(); return; }
      const live = { ...pending, recording };
      voiceRef.current = live;
      setVoice(live);
    }, (error) => {
      if (voiceRef.current === pending) { voiceRef.current = null; setVoice(null); }
      setSpeechError(micBlockedLine(error));
    });
  };
  // Leaving the conversation mid-recording keeps the words, unsent.
  useEffect(() => () => {
    if (voiceRef.current?.recording) void latestFinishVoice.current(true, t("composer.voice.leftThread"));
    else voiceRef.current = null;
  }, [draftId]);

  return (
    <div className="pointer-events-none relative px-5 pb-3">
      {/* No fill or hairline on this wrapper — those were the black frame
          in the pill's top corners. The dock overlays the transcript. */}
      {speechError && (
        <div className="pointer-events-auto mb-2 w-full rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-[12px] text-warning">
          {speechError}
        </div>
      )}
      <div className="pointer-events-auto relative w-full">
        <ComposerVoicePending pending={pendingVoice} onRetry={(id) => void deliverVoice(id, voiceDispatch)} onDiscard={discardPendingVoice}/>
        {failedSends.map((failed) => (
          <div
            key={failed.id}
            className="mb-2 flex items-center gap-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[12.5px] text-danger"
          >
            <span className="min-w-0 flex-1 truncate">
              {t("composer.failed.notSent", {
                text: failed.text.trim() || t("composer.failed.attachment"),
              })}
            </span>
            <button
              type="button"
              onClick={() => retryFailedSend(failed)}
              className="shrink-0 rounded px-2 py-1 font-medium hover:bg-danger/10"
            >
              {t("chat.retry")}
            </button>
            <button
              type="button"
              onClick={() => forgetFailedComposerSend(draftId, failed.id)}
              aria-label={t("composer.failed.dismissAria")}
              title={t("composer.failed.dismiss")}
              className="flex size-5 shrink-0 items-center justify-center rounded hover:bg-danger/10"
            >
              <X size={13} strokeWidth={2.5} />
            </button>
          </div>
        ))}
        {commandPickerOpen && (
          <div
            role="listbox"
            aria-label={t("composer.commands.aria")}
            className="absolute bottom-full left-2 z-20 mb-2 w-80 overflow-hidden rounded-xl border border-hairline/40 bg-raised shadow-lg"
          >
            <div className="border-b border-hairline/20 px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-secondary">
              {t("composer.commands.title")}
            </div>
            {commandCandidates.map((command, index) => (
              <button
                key={command.id}
                type="button"
                role="option"
                aria-selected={index === highlight}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => pickCommand(command)}
                onMouseEnter={() => setHighlight(index)}
                className={cn(
                  "flex w-full items-center gap-3 px-3 py-2.5 text-left",
                  index === highlight ? "bg-raised-hover" : "",
                )}
              >
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
                  {command.id === "goal" ? (
                    <Target size={15} aria-hidden="true" />
                  ) : (
                    <BookOpen size={15} aria-hidden="true" />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[14px] font-medium text-accent">{command.label}</span>
                  <span className="block truncate text-xs text-ink-secondary">
                    {command.description}
                  </span>
                </span>
              </button>
            ))}
          </div>
        )}
        {shared && mention && mention.start !== dismissedAt && !mentionPickerOpen && mention.query.trim() && !/\s/.test(mention.query) && (
          <p role="status" className="mb-2 rounded-xl bg-raised px-3 py-2 text-xs text-ink-secondary">No bots match. Search by bot name or owner.</p>
        )}
        {mentionPickerOpen && (
          <div
            role="presentation"
            className="absolute bottom-full left-2 z-20 mb-2 flex max-h-[min(28rem,60vh)] w-[22rem] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-xl border border-hairline/40 bg-raised shadow-lg motion-safe:animate-pop-in"
          >
            <div className="flex items-center justify-between border-b border-hairline/20 px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-secondary">
              <span>{shared ? "Mention a person or bot" : t("composer.mention.aria")}</span>
              <span className="font-normal normal-case tracking-normal" aria-hidden="true">↑↓ · ↵ or tab · esc</span>
            </div>
            <div
              ref={mentionListRef}
              role="listbox"
              aria-label={shared ? "Mention a person or bot" : t("composer.mention.aria")}
              className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain py-1"
            >
            {candidates.map((peer, i) => {
              const match = mentionMatchRange(peer.name, mention?.query ?? "");
              const waiting = peer.bot?.activity === "waiting-on-you";
              const working = !waiting && Boolean(peer.bot?.busy);
              const everyoneRow = peer.id === "__everyone__";
              return (
              <button
                key={peer.id}
                type="button"
                data-mention-index={i}
                role="option"
                aria-selected={i === highlight}
                // keep the caret in the textarea; picking refocuses anyway,
                // but a blur in between flickers the draft's mention mirror
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => pickMention(peer)}
                onMouseEnter={() => setHighlight(i)}
                className={cn(
                  "mx-1 flex w-[calc(100%-0.5rem)] items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left",
                  i === highlight ? "bg-raised-hover" : "",
                )}
              >
                <span className="relative flex shrink-0">
                  {peer.bot ? (
                    <BotAvatar
                      bot={peer.bot}
                      state={normalizeState(peer.bot.mascotExpression) ?? "happy"}
                      size={28}
                      animated={false}
                    />
                  ) : peer.avatar ? (
                    <PersonPhoto src={peer.avatar} size={28} />
                  ) : everyoneRow && members?.length ? (
                    // everyone = the room: a small stack of who it reaches
                    <span className="flex -space-x-2.5">
                      {members.slice(0, 3).map((member) => (
                        <span key={member.id} className="rounded-full ring-2 ring-raised">
                          <BotAvatar bot={member} size={20} animated={false} />
                        </span>
                      ))}
                    </span>
                  ) : (
                    <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-card text-ink-secondary">
                      <Users size={13} aria-hidden="true" />
                    </span>
                  )}
                  {(working || waiting) && (
                    <span
                      className={cn(
                        "absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full ring-2 ring-raised",
                        waiting ? "bg-warning" : "bg-success motion-safe:animate-pulse",
                      )}
                      aria-hidden="true"
                    />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] font-medium text-ink">
                    <span className="text-ink-secondary">@</span>
                    {match ? (
                      <>
                        {peer.name.slice(0, match.start)}
                        <span className="text-accent">{peer.name.slice(match.start, match.end)}</span>
                        {peer.name.slice(match.end)}
                      </>
                    ) : peer.name}
                  </span>
                  {(peer.bot?.title || shared) && (
                    <span className="block truncate text-[11.5px] text-ink-secondary">
                      {peer.bot?.title ?? (shared ? "Person" : "")}
                    </span>
                  )}
                </span>
                <span className={cn("shrink-0 text-[11px]", waiting ? "text-warning" : "text-ink-secondary")}>
                  {waiting
                    ? t("task.waiting")
                    : working
                    ? t("sidebar.preview.working")
                    : everyoneRow
                    ? t("composer.mention.channel")
                    : shared
                    ? ""
                    : t("composer.mention.agent")}
                </span>
              </button>
              );
            })}
            </div>
          </div>
        )}
        {/* An approval takes over the composer: you answer it before you
            can type again, so a waiting bot is impossible to miss. */}
        {approval && (
          <div className="mb-2 overflow-hidden rounded-2xl border border-accent/40 bg-card">
            {/* locale: the panel is memoized and its other props do not
                change with the language — see MessagesList in ChatView */}
            <PendingApprovalPanel
              pending={approval}
              count={approvals.length}
              index={0}
              locale={activeLocale()}
            />
            <PendingApprovalActions
              pending={approval}
              threadId={threadId}
              bot={approvalBot}
              onCancelTurn={interruptTurn}
            />
          </div>
        )}
        {replyTo && (
          <div className="mb-2 px-1">
            <ReplyQuote
              message={replyTo}
              fallbackName={bot?.name}
              authorName={replyToAuthor}
              onClear={onClearReply}
            />
          </div>
        )}
        {sharedIntakeError && <div role="alert" className="mb-2 px-3 text-xs text-danger">{sharedIntakeError}</div>}
        {shared?.replyBots && <div className="mb-2 flex items-center gap-2 px-3 text-xs text-ink-secondary" aria-label="Current responder">
          {shared.replyBots.map(peer => <span key={peer.id} className="flex items-center gap-1.5"><BotAvatar bot={peer} size={22} animated={false} />{peer.name}</span>)}
          <span>{shared.replyBots.length ? "will reply · @someone else to switch" : shared.replyMode === "mentions" ? "Mention a bot for a reply" : "Bot replies paused · @a bot to start"}</span>
        </div>}
        {shared && sharedStatus === "sending" && <div role="status" className="mb-2 px-3 text-xs text-ink-secondary">Sending…</div>}
        {shared && sharedStatus === "sent" && <div role="status" className="mb-2 px-3 text-xs text-ink-secondary">Sent</div>}
        {shared && sharedStatus === "failed" && <div role="alert" className="mb-2 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">
          Couldn’t confirm this send. Your message and files are kept. {sharedError}
          <button type="button" className="ml-2 font-medium underline" onClick={() => send()}>Retry send</button>
        </div>}
        {sharedFiles.length > 0 && <div className="mb-2 flex flex-wrap gap-2">{sharedFiles.map(file => <span key={`${file.name}-${file.lastModified}`} className="flex items-center gap-1 rounded-lg bg-raised px-2 py-1 text-xs">{file.name}<button type="button" aria-label={`Remove ${file.name}`} onClick={() => editSharedFiles(previous => previous.filter(item => item !== file))}><X size={13} /></button></span>)}</div>}
        {!shared && <ComposerAttachments
          items={attachments}
          onAdd={addAttachments}
          onRemove={removeAttachment}
          onDisplayInChatBox={displayPasteInChatBox}
          allowImages={engineSupportsImages}
          notice={attachmentNotice}
          onNotice={setAttachmentNotice}
          onPendingChange={(pending) => changeDraftAttachmentPending(draftId, pending)}
          uploadImage={uploadImage}
          uploadOnly={Boolean(bot?.remote || group?.home)}
        />}
        <QueuedComposerMessages
          items={queuedMessages}
          onResume={() => dispatch({ type: "resumeQueued", threadId, ...(group ? { groupId: group.id } : { botId: bot?.id }) })}
          onSteer={canSteerQueued && canSteer && !queuedMessages.some(item => item.paused) ? () => steerQueued() : undefined}
          onSteerItem={canSteerQueued && canSteer && !queuedMessages.some(item => item.paused) ? steerQueued : undefined}
          steerInterrupts={group ? !roomSteerCapable : !canSteer}
          steerTargetName={roomSteerMember?.name}
          steerUnavailable={canSteerQueued ? roomSteerUnavailable : undefined}
          steerMode={group ? "next" : "all"}
          steering={steering}
          onCancel={(queueId) => {
            if (group) dispatch({ type: "cancelGroupQueued", groupId: group.id, threadId, queueId });
            else if (bot) dispatch({ type: "cancelQueued", botId: bot.id, threadId, queueId });
          }}
          onEdit={group || bot ? (queueId, text, expectedText) => dispatch({
            type: "editQueued",
            threadId,
            queueId,
            text,
            expectedText,
            ...(group ? { groupId: group.id } : { botId: bot?.id }),
          }) : undefined}
          onReorder={group || bot ? (order) => dispatch({
            type: "reorderQueued",
            threadId,
            order,
            previous: queuedMessages.map((entry) => entry.queueId),
            ...(group ? { groupId: group.id } : { botId: bot?.id }),
          }) : undefined}
        />
        <div className="composer-dock relative">
          {/* App-ground from the pill midline down, full-bleed. Bubbles may
              tuck into the top half of the radius; they must not show below
              center. End at the dock's pb-3 padding: a viewport-height
              backdrop extends the document and lets focus scroll the header
              away. Only the decoration is bounded; upward menus stay free. */}
          <div
            aria-hidden
            data-composer-backdrop
            className="pointer-events-none absolute -left-5 -right-5 -bottom-3 top-1/2 bg-app"
          />
        {needsSignIn && (signInCardInThread ? (
          <p data-composer-sign-in className="relative mx-4 mb-2 text-[13px] text-ink-secondary">
            Sign in with Claude or ChatGPT above to send. Your message stays here.
          </p>
        ) : (
          <div data-composer-sign-in className="relative mx-3 mb-2 rounded-2xl border border-hairline/40 bg-card px-4 py-3.5">
            <p className="mb-3 text-[13.5px] text-ink">Sign in with Claude or ChatGPT to send. Your message stays here.</p>
            <EnginesBeat inline onNext={() => {}} setMascot={() => {}} bump={() => {}} />
          </div>
        ))}
        {modeBot && !shared && !group && !remoteClient && <div className="composer-context-strip relative mx-3 flex items-center gap-4 rounded-t-[20px] bg-raised px-3 pb-5 pt-2 text-[13px] text-ink-secondary">
          <span className="flex min-w-0 items-center gap-2" title={composerTask?.cwd ?? modeBot.cwd ?? "Private bot workspace"}><Folder size={16} className="shrink-0"/><span className="composer-chip-label max-w-48 truncate">{(composerTask?.cwd ?? modeBot.cwd)?.split(/[\\/]/).filter(Boolean).pop() ?? "Bot workspace"}</span></span>
              {modeBot && !remoteClient && (
                <PlaceChip
                  bot={modeBot}
                  task={composerTask}
                  live={Boolean(modeBot.busy)}
                  showLabel
                  disabled={Boolean(modeBot.busy)}
                  onPin={(surface) => dispatch({ type: "updateTask", botId: modeBot.id, threadId: modeBot.threadId, patch: { surface } })}
                />
              )}
        </div>}
        <ConversationComposerFrame>
        <div className="composer-layout" data-recording={recording || undefined}>
          <input
            ref={fileInput}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              void pickFiles(e.target.files);
              // same file twice in a row still fires onChange
              e.target.value = "";
            }}
          />
          {!locked && (
            <ConversationTools composer>
              <button
                type="button"
                onClick={() => fileInput.current?.click()}
                aria-label={t("composer.attach")}
                title={t("composer.attach")}
                className="flex size-8 shrink-0 items-center justify-center rounded-full text-ink-secondary hover:bg-control hover:text-ink"
              >
                <Paperclip size={17} /><span>Attach files</span>
              </button>
              {appshotsAvailable() && <AppshotMenuItem onError={(message) => dispatch({ type: "error", message })} />}
              {group && !group.dm && (
                <button
                  type="button"
                  aria-pressed={effectiveChannelMode === "goal"}
                  aria-label={t("composer.goal.aria")}
                  title={t("composer.goal.title")}
                  onClick={() => {
                    markDraftEdited(draftId);
                    if (typedGoalText !== null) {
                      const nextCaret = Math.max(0, caret - (text.length - typedGoalText.length));
                      editText(typedGoalText);
                      setCaret(nextCaret);
                      setChannelMode("chat");
                      requestAnimationFrame(() => {
                        inputRef.current?.focus();
                        inputRef.current?.setSelectionRange(nextCaret, nextCaret);
                      });
                      return;
                    }
                    setChannelMode((current) => current === "goal" ? "chat" : "goal");
                  }}
                  className={cn(
                    "flex h-8 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 text-[13px] transition-colors",
                    effectiveChannelMode === "goal"
                      ? "border-accent/35 bg-accent/10 text-accent"
                      : "border-hairline/20 bg-transparent text-ink-secondary hover:bg-raised hover:text-ink",
                  )}
                >
                  <Target size={14} aria-hidden="true" />
                  {effectiveChannelMode === "goal" ? "/goal" : t("composer.goal.chip")}
                </button>
              )}
              {modeBot && approvalEngine && ["codex", "claudeAgent"].includes(approvalEngine.driverKind) && <RemoteFullAccess botId={modeBot.id} threadId={modeBot.threadId} busy={Boolean(modeBot.busy)} candidates={state.bots.filter(b => !b.remote && state.instances.some(i => i.instanceId === currentTaskBot(b).modelSelection.instanceId && ["codex", "claudeAgent"].includes(i.driverKind))).map(b => ({ botId: b.id, threadId: b.threadId, name: b.name, busy: Boolean(b.busy) }))} />}
            </ConversationTools>
          )}
          {appshotListing && <AppshotPicker key={appshotListing.rows.map((row) => row.id).join("|") + appshotListing.permission} listing={appshotListing} />}
          <div className="composer-access" data-access-mode={modeBot ? approvalModeFor(modeBot) : undefined}>
              {modeBot && approvalEngine && !remoteClient && (
                <ApprovalModeSelector
                  wide
                  approvalMode={modeBot.approvalMode}
                  autoApprove={modeBot.autoApprove}
                  providerName={approvalEngine.displayName}
                  driverKind={approvalEngine.driverKind}
                  onSelect={setApprovalMode}
                  disabled={Boolean(modeBot.busy)}
                  trustedModesAvailable={trustedThreadAccess}
                />
              )}
          </div>
          <MentionTextarea
          inputRef={inputRef}
          peers={shared ? [...(shared.mentionPeople ?? []), ...shared.mentionBots] : group ? members ?? [] : state.bots.filter((member) => member.id !== bot?.id)}
          everyone={Boolean(group && !group.dm)}
          // the message is composed in the writer's language, not the UI's
          dir="auto"
          rows={1}
          value={text}
          onChange={(e) => {
            editText(e.target.value);
            shared?.onTyping?.(Boolean(e.target.value.trim()));
            setCaret(e.target.selectionStart ?? e.target.value.length);
            setDismissedAt(null);
            setDismissedSlashAt(null);
          }}
          onPaste={handlePaste}
          onKeyUp={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart ?? 0)}
          onClick={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart ?? 0)}
          onKeyDown={(e) => {
            if (commandPickerOpen) {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                const delta = e.key === "ArrowDown" ? 1 : -1;
                setHighlight((current) =>
                  (current + delta + commandCandidates.length) % commandCandidates.length,
                );
                return;
              }
              if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                pickCommand(commandCandidates[highlight]);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setDismissedSlashAt(slash?.start ?? null);
                return;
              }
            }
            if (mentionPickerOpen) {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                const delta = e.key === "ArrowDown" ? 1 : -1;
                setHighlight((h) => (h + delta + candidates.length) % candidates.length);
                return;
              }
              if ((e.key === "Home" || e.key === "End") && !e.shiftKey) {
                e.preventDefault();
                setHighlight(e.key === "Home" ? 0 : candidates.length - 1);
                return;
              }
              if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                pickMention(candidates[highlight]);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setDismissedAt(mention?.start ?? null);
                return;
              }
            }
            // an empty composer + ArrowUp = edit your last message (like a chat app)
            if (e.key === "ArrowUp" && !hasContent && onEditLast) {
              e.preventDefault();
              onEditLast();
              return;
            }
            // Shift+Enter inserts a newline; plain Enter sends; Option/Alt+Enter
            // queues After this while a turn is running
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (recording) finishDictation(true);
              else send(e.altKey && priorityVisible ? "queue" : undefined);
            }
            if (e.key === "Escape" && recording) cancelDictation();
          }}
          disabled={Boolean(approval) || locked || attachmentPending}
          aria-busy={bot?.awaitingThreadSnapshot || undefined}
          placeholder={
            setupLocked
              ? t("composer.placeholder.locked")
              : approval
              ? t("composer.placeholder.approval")
              : attachmentPending
              ? t("composer.placeholder.attaching")
              : recording
              ? t("composer.placeholder.listening")
              : shared
                ? "Message… @mention a person or bot"
              : busy && canSteer
                ? t("composer.placeholder.steer", { name: busyName })
              : busy
                ? group
                  ? t("composer.placeholder.queueGroup", { name: busyName })
                  : t("composer.placeholder.queue", { name: busyName })
                : group
                  ? channelMode === "goal"
                    ? t("composer.placeholder.goal", { name: group.name })
                    : t("composer.placeholder.group", {
                        name: group.name,
                        hint: groupComposerHint(group, members ?? []),
                      })
                  : t("composer.placeholder.bot", { name: bot?.name ?? "" })
          }
          aria-label={t("composer.placeholder.bot", { name: group ? group.name : (bot?.name ?? "") })}
            className="block max-h-[12rem] min-h-[36px] w-full resize-none overflow-y-auto bg-transparent px-2 py-1.5 text-[15px] leading-6 placeholder:text-ink-secondary focus:outline-none"
          />
          <div className="composer-end flex min-w-0 items-center justify-end gap-1">
          {bot && !group && !shared && !remoteClient && <ModelPicker bot={bot} threadId={threadId} placement="above" className="composer-model min-w-0"/>}
          {/* No queue/block chip: sending while busy queues; option-enter
              still interrupts for the rare case it is wanted. */}
          {/* Stop stays a stop. Stop-then-steer is named beside the queued
              message above, where its effect is visible before activation. */}
          {busy && !locked && (
          <button
            onClick={interruptTurn}
            disabled={stopping}
            aria-busy={stopping}
            aria-label={stopping ? "Stopping…" : t("chat.stopTurn")}
            className="flex h-9 min-w-9 shrink-0 items-center justify-center gap-2 rounded-full bg-ink px-2.5 text-app transition-transform active:scale-90 disabled:cursor-wait"
            title={t("chat.stop")}
          >
            {stopping ? <><Loader2 size={14} className="animate-spin" /><span role="status" className="text-xs">Stopping…</span></> : <Square size={14} className="fill-current" />}
          </button>
        )}
        {!locked && !busy && !recording && capabilities.dictation.available && (
          <button
            onClick={toggleMic}
            aria-label={recording ? t("composer.dictation.stop") : t("composer.dictation.start")}
            className={cn(
              "flex size-9 shrink-0 items-center justify-center rounded-full",
              recording
                ? "animate-pulse bg-danger/20 text-danger"
                : "bg-raised text-ink-secondary hover:bg-raised-hover hover:text-ink",
            )}
            title={recording ? t("composer.dictation.stopHint") : t("composer.dictation.hint")}
          >
            <Mic size={18} />
          </button>
        )}
        {!locked && !recording && !voice && browserVoice && (
          <button
            type="button"
            onClick={startVoice}
            aria-label={t("composer.voice.start")}
            title={t("composer.voice.start")}
            data-voice-start
            className="flex size-9 shrink-0 items-center justify-center rounded-full bg-raised text-ink-secondary hover:bg-raised-hover hover:text-ink"
          >
            <Mic size={18} />
          </button>
        )}
        {!locked && !busy && !hasContent && !recording && voiceCallReady && bot && (
          <button
            type="button"
            onClick={() => startRealtimeCall(bot.id)}
            aria-label={`Call ${bot.name}`}
            title={`Call ${bot.name}`}
            data-voice-call-start
            className="flex size-9 shrink-0 items-center justify-center rounded-full bg-ink text-app hover:bg-ink/90"
          >
            <AudioLines size={18} strokeWidth={2.25} />
          </button>
        )}
        {hasContent && !locked && busy && !shared && <button type="button" disabled={attachmentPending} onClick={() => send("queue")} aria-label="After this" className="composer-after shrink-0 rounded-full px-2 py-1 text-xs text-ink-secondary hover:bg-raised-hover" title="Wait until this work finishes"><ListEnd size={16} aria-hidden="true" /><span>After this</span></button>}
        {hasContent && !locked && (
          <button
            onClick={() => send()}
            disabled={attachmentPending || sharedSending || needsSignIn}
            aria-busy={sharedSending || undefined}
            aria-label={
              blockArmed
                ? "After this"
                : busy && canSteer
                  ? t("composer.send.steer")
                  : busy
                    ? t("composer.send.queue")
                    : t("composer.send.message")
            }
            title={
              blockArmed
                ? "After this"
                : busy && canSteer
                  ? t("composer.send.steer")
                  : busy
                    ? t("composer.send.queueHint")
                    : t("chat.send")
            }
            className={cn(
              "flex size-9 shrink-0 items-center justify-center rounded-full",
              needsSignIn && "pointer-events-none opacity-35",
              busy && !canSteer && !blockArmed
                  ? "bg-raised text-ink-secondary hover:bg-raised-hover"
                  : "bg-ink text-app hover:bg-ink/90",
            )}
          >
            {busy && !canSteer && !blockArmed ? <Clock size={15} /> : <ArrowUp size={17} />}
          </button>
          )}
          </div>
        </div>
        {recording && <ComposerDictation finishing={speechFinishing} onCancel={cancelDictation} onFinish={finishDictation}/>}
        {voice && <ComposerVoiceRecorder stream={voice.recording?.stream ?? null} startedAt={voice.recording?.startedAt ?? Date.now()} starting={!voice.recording} onCancel={() => void finishVoice(false)} onSend={() => void finishVoice(true)}/>}
        </ConversationComposerFrame>
        </div>
      </div>
      <div className="pointer-events-auto">
      <FullAccessWarning
        open={approvalWarning?.mode === "full"}
        scope="thread"
        onCancel={() => setApprovalWarning(null)}
        onConfirm={() => {
          const target = approvalWarning;
          setApprovalWarning(null);
          if (target?.mode !== "full" || !trustedThreadAccess) return;
          dispatch({ type: "updateTask", botId: target.botId, threadId: target.threadId,
            patch: { approvalMode: "full", confirmFullAccess: true } });
        }}
      />
      <LocalComputerAutoWarning
        open={approvalWarning?.mode === "auto"}
        onCancel={() => setApprovalWarning(null)}
        onConfirm={() => {
          if (approvalWarning?.mode === "auto") {
            dispatch({
              type: "updateTask",
              botId: approvalWarning.botId,
              threadId: approvalWarning.threadId,
              patch: { approvalMode: "auto", acknowledgeLocalAuto: true },
            });
          }
          setApprovalWarning(null);
        }}
      />
      </div>
    </div>
  );
}
