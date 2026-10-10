// One conversation: the transcript, the approval cards, and the composer.
//
// The transcript is whatever the harness folded — settled text, tool chips,
// option cards, screenshots. This renders those and nothing else; it does
// not re-derive anything from provider events, because the server already
// did that and having two folds is how two clients start disagreeing.
import SwiftUI
import CompanionCore
import PhotosUI
import UniformTypeIdentifiers
import ImageIO
// Unconditional, because the uses below are: `Color(uiColor:)` and
// `UIImage(data:)` are reached on every path through this file. A
// `canImport` guard around the import alone does not make the file portable
// — it only moves the failure from "no such module" to "no such type", and
// hides that this view is iOS-only behind something that looks like it
// isn't. The App target is iOS; CompanionCore is where the portable half
// lives.
import UIKit
import AVFoundation
import CryptoKit

struct ChatView: View {
    let chat: Chat
    /// Set when this chat is the side pane of a wide window: there is no
    /// stack to pop, so leaving closes the pane instead.
    var onClose: (() -> Void)?
    @State private var selectedThreadId: String
    @EnvironmentObject private var session: Session
    @Environment(\.dismiss) private var dismiss
    /// Present only on a wide window's primary pane with room for a second.
    @Environment(\.openBeside) private var openBeside
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    /// The draft lives in its own object so a keystroke redraws the
    /// composer, not this whole view and every row of the transcript.
    @State private var composerDraft = ComposerDraft()
    /// Where the header and its face sit, for the empty thread's mascot.
    @State private var mascotDock = MascotDock()
    private var draft: String {
        get { composerDraft.text }
        nonmutating set { composerDraft.text = newValue }
    }
    @State private var replyTarget: Message?
    /// Names picked in the @ drawer. Sent as `@name` text, so they route the
    /// same as typed mentions.
    @State private var mentionPicks: [MentionTarget] = []
    @State private var showingTasks = false
    @State private var creatingThread = false
    @State private var showingWalkie = false
    /// Realtime voice calls live app-wide; this chat starts one and shows
    /// the rows a call leaves behind.
    @ObservedObject private var voiceCalls = VoiceCallCenter.shared
    @State private var showingComputer = false
    @State private var showingPlus = false
    @State private var showingProfile = false
    @State private var showCommandHUD = false
    @State private var shareFile: ShareFile?
    @State private var showingPhotoPicker = false
    @State private var showingFileImporter = false
    @State private var selectedPhotos: [PhotosPickerItem] = []
    @State private var attachments: [PendingMessageAttachment] = []
    @State private var activeArchive: BotDraft?
    @State private var activeScope: String?
    @State private var archives: [String: BotDraft] = [:]
    @State private var uploadStatus: String?
    @State private var preparingAttachments = false
    @State private var sendingMessage = false
    /// Queue or block for the next send while a turn runs. Every send puts
    /// it back to queue, so block is never sticky.
    @State private var sendPriority: MessagePriority = .queue
    /// The held send open in the queued-message editor.
    @State private var editingQueued: QueuedSend?
    @State private var attachmentError: String?
    @State private var openingFileName: String?
    @State private var fileOpenError: String?
    @State private var filePreview: FilePreviewItem?
    @State private var fileDownloadTask: Task<Void, Never>?
    @State private var fileDownloadRequestID: UUID?
    @State private var threadOpenTask: Task<Void, Never>?
    /// Messages that land while the chat is open spring in; history stays still.
    @State private var arrivals = MessageArrivals()
    /// The header face's beats: reading, nods, moods, the card hop.
    @State private var mascot = ThreadMascotDirector()
    @FocusState private var composerFocused: Bool
    @StateObject private var dictation = SpeechDictation()
    /// The opening beat: the island grows with the bot's face in it, then
    /// shrinks away as the face settles into the header. `facePhase` is 1
    /// with the face in the island, 0 with it home in the header.
    @State private var islandExpanded = false
    @State private var islandVisible = false
    @State private var facePhase: CGFloat = 0
    /// Whether the reader is at the newest line, and when each room member's
    /// row last pulled the transcript down. A plain object, not state: it
    /// changes on every scroll and every token, and none of that should
    /// re-evaluate this view.
    @State private var follow = ScrollFollow()
    /// The reader has scrolled up off the newest line: show the jump-down
    /// button. Changes only when that flips, not on every scroll.
    @State private var readingStore: ReadingPositionStore?
    @State private var savedReading: ReadingPosition?
    @State private var visibleReadingID: String?
    @State private var lastReadingID: String?
    @State private var newestObservedID: String?
    @State private var readingTarget: String?
    @State private var restoringReading = true
    @State private var readingOpenedUnread = false
    @State private var newMessagesBoundary: String?
    @State private var readingError: String?
    @State private var scrolledAway = false
    /// Bumped by the jump-down button; on iOS 18 the scroll position goes to
    /// the bottom edge.
    @State private var jumpRequest = 0
    /// Something landed while the reader was scrolled away.
    @State private var unseenBelow = false
    /// The chat's height above the keyboard, so the @ drawer can leave the
    /// conversation some room on a small phone with the keyboard up.
    @State private var chatHeight: CGFloat = 0

    @AppStorage(PrefKey.islandIntro) private var islandIntro = IslandIntro.oncePerBot.rawValue
    @AppStorage(PrefKey.islandSeen) private var islandSeen = ""
    @AppStorage(PrefKey.activityDetail) private var activityDetail = ActivityDetail.reduced.rawValue
    @AppStorage(PrefKey.quickReplies) private var quickReplies = ""

    /// This composer's own claim on `LiveTextStore.composing`; two panes can
    /// each have a draft open.
    @State private var composerID = UUID()

    init(chat: Chat, onClose: (() -> Void)? = nil) {
        self.chat = chat
        self.onClose = onClose
        _selectedThreadId = State(initialValue: chat.threadId)
    }

    /// The live bubble's scroll target. A constant because there is at most
    /// one per chat and it has no message id to borrow.
    static let liveBubbleId = "companion.live"
    /// The very end of the transcript, below any live rows, so "newest"
    /// includes a reply still being typed or a member still working.
    static let bottomId = "companion.bottom"

    /// The live chat record, so busy/unread stay current as frames land.
    /// The person this phone speaks as in a room, so other people's lines
    /// sit on their side with their name.
    private var roomSelfID: String? {
        guard case let .room(room) = current else { return nil }
        return session.roomActorId ?? room.ownerPersonId
    }

    private var current: Chat {
        switch chat {
        case let .bot(bot):
            if let view = session.state.bot(bot.id)?.projected(forThread: selectedThreadId) { return .bot(view) }
            // Keep the exact target until a removed thread dismisses. Never
            // briefly fall back to a sibling while the view is closing.
            var removed = bot
            removed.threadId = selectedThreadId
            removed.busy = false
            return .bot(removed)
        case let .room(room):
            return session.state.rooms.first { $0.id == room.id }.map(Chat.room) ?? chat
        }
    }

    /// Bot selection is local to this screen; another device's navigation
    /// must not move a draft, approval, or Stop action to a different thread.
    private var threadId: String { current.threadId }

    private var selectedThreadWasRemoved: Bool {
        guard case let .bot(bot) = chat else { return false }
        guard let live = session.state.bot(bot.id) else { return true }
        return live.tasks.map { !$0.contains { $0.threadId == selectedThreadId } } ?? false
    }

    /// A task changes a bot's thread, but it does not make it a new bot.
    /// Intro history follows the chat itself so switching tasks cannot replay
    /// a once-per-bot greeting.
    private var islandIntroID: String {
        switch current {
        case let .bot(bot): "bot.\(bot.id)"
        case let .room(room): "room.\(room.id)"
        }
    }

    private var messages: [Message] {
        session.state.visibleTranscript(forThread: threadId)
    }

    /// The transcript as the reader has asked to see it: every chip, folded
    /// runs, or none at all.
    ///
    /// The steps of a turn that is still running are not in here — they
    /// belong to the working indicator below the transcript, which shows
    /// them as they land. They fold into a normal run row the moment the
    /// turn settles, so nothing is drawn twice and nothing disappears.
    ///
    /// A room running members side by side has no single tail: each working
    /// member's steps are drawn in its own live row, so those ids are left
    /// out here instead.
    private func rows(memberSteps: [String: [Message]]) -> [TranscriptRow] {
        let detail = ActivityDetail(rawValue: activityDetail) ?? .reduced
        let live = Set(memberSteps.values.joined().map(\.id))
        let settled = !live.isEmpty ? messages.filter { !live.contains($0.id) }
            : liveSteps.isEmpty ? messages : Array(messages.dropLast(liveSteps.count))
        if case .room = current {
            return transcriptRows(groupRoomTurns(settled), detail: detail, foldFailures: true)
        }
        return transcriptRows(settled, detail: detail)
    }

    /// The tail of activity belonging to the turn in flight.
    private var liveSteps: [Message] {
        guard current.busy, (ActivityDetail(rawValue: activityDetail) ?? .reduced) != .hidden else { return [] }
        // Parallel rooms split their activity per member; see memberSteps.
        if case let .room(room) = current, room.activeBotIds != nil { return [] }
        var tail: [Message] = []
        for message in messages.reversed() {
            guard message.kind == .activity else { break }
            tail.insert(message, at: 0)
        }
        return tail
    }

    /// Each working room member's steps so far, for the room's per-member
    /// live rows. Empty outside a room running members side by side.
    private var memberSteps: [String: [Message]] {
        guard case let .room(room) = current, let active = room.activeBotIds, !active.isEmpty,
              (ActivityDetail(rawValue: activityDetail) ?? .reduced) != .hidden
        else { return [:] }
        return roomMemberLiveSteps(messages, botIds: active)
    }

    /// When a member's turn began, for its live row's clock: its first step,
    /// else the person's latest message — not the transcript's last line,
    /// which every other member's reply moves.
    private func memberStartedAt(_ steps: [Message]?) -> Date {
        let ms = steps?.first?.at ?? messages.last(where: { $0.role == .user })?.at ?? messages.last?.at
        return ms.map { Date(timeIntervalSince1970: $0 / 1000) } ?? Date()
    }

    /// The composer's chip row, as edited in Settings.
    private var storedChips: [ActionChipItem] {
        QuickReply.decode(quickReplies).map {
            ActionChipItem(id: $0.id, title: $0.title, icon: $0.icon, prompt: $0.prompt)
        }
    }

    /// Unread elsewhere — what the back pill's badge counts, like Messages.
    private var unreadElsewhere: Int {
        let mine = current.unread ? 1 : 0
        return max(0, session.state.unreadCount - mine)
    }

    var body: some View {
#if DEBUG
        let _ = MainThreadProbe.shared.chatBody()

#endif
        // Read the transcript once for this render. Pagination changes the
        // array as a unit; repeatedly reaching through ObservableObject for
        // every row only recomputes the same value.
        let steps = memberSteps
        let transcript = rows(memberSteps: steps)
        let visible = messages
        let _ = arrivals.track(threadId: threadId, messages: visible.map { ($0.id, $0.at) }, now: Date().timeIntervalSince1970)
        // Each row's branch versions, worked out once for the whole
        // transcript rather than by every row scanning all of it.
        let versions = Self.versionsByParent(session.state.transcript(forThread: threadId))
        let replyTargets = Dictionary(visible.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        // A VStack with the composer as a sibling, rather than a scroll view
        // with `.safeAreaInset`. The inset version sized itself to its
        // content, so a short transcript left the composer floating in the
        // middle of the screen with black beneath it. Here the scroll area is
        // explicitly told to take everything the composer does not.
        let transcriptView = VStack(spacing: 0) {
            if let notice = chat.remoteConnectionNotice {
                Text(notice).font(.caption).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(12)
                    .background(Color.secondary.opacity(0.08))
            }
            ScrollViewReader { proxy in
                ScrollView {
                    // Lazy: only the rows on screen are built and laid out.
                    // An eager VStack measured every message's text whenever
                    // anything in the list changed, which with several bots
                    // streaming was most of each frame. A lazy stack only
                    // estimates the height of rows it has not built, so the
                    // anchor alone can open mid-way; the explicit scroll to
                    // the newest row on appear below settles it.
                    LazyVStack(alignment: .leading, spacing: 14) {
                        // room for the floating face when scrolled to the top
                        Color.clear.frame(height: 4)

                        if session.state.hasMore[threadId] == true {
                            Button("Load earlier messages") {
                                // keep the reader where they were: after older
                                // messages are prepended, sit back on the one
                                // that used to be at the top
                                let anchor = transcript.first?.id
                                Task {
                                    await session.loadOlder(threadId: threadId)
                                    if let anchor { proxy.scrollTo(anchor, anchor: .top) }
                                }
                            }
                            .font(.footnote)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 8)
                        }

                        ForEach(Array(transcript.enumerated()), id: \.element.id) { index, row in
                            VStack(alignment: .leading, spacing: 6) {
                                if row.id == newMessagesBoundary {
                                    Text("New messages · since last seen on this phone")
                                        .font(.caption.weight(.semibold)).foregroundStyle(Color.accentColor)
                                        .frame(maxWidth: .infinity).padding(.vertical, 6)
                                }
                                // a gap in time is worth marking; a timestamp
                                // on every message is just noise
                                if startsANewStretch(at: index, in: transcript) {
                                    Text(RelativeStamp.separator(row.head.date))
                                        .font(.system(size: 12, weight: .medium))
                                        .foregroundStyle(Color.secondary.opacity(0.7))
                                        .frame(maxWidth: .infinity)
                                        .padding(.top, 10)
                                        .padding(.bottom, 4)
                                }
                                switch row {
                                case let .message(message):
                                    MessageRow(
                                        chat: current,
                                        message: message,
                                        selfID: roomSelfID,
                                        endsRun: endsRun(at: index, in: transcript),
                                        openLink: openLink,
                                        openThread: openThread,
                                        onReply: { replyTarget = $0; composerFocused = true },
                                        replyTarget: message.replyToId.flatMap { replyTargets[$0] },
                                        versions: Self.versions(of: message, in: versions)
                                    )
                                    .equatable()
                                    .arrivalSpring(arrives(message), fromTrailing: message.role == .user && !message.isFromAnotherPerson(selfID: roomSelfID), reduceMotion: reduceMotion)
                                case let .activityRun(items):
                                    ActivityRunChip(items: items, openThread: openThread)
                                }
                                ForEach(voiceRecords(after: index, in: transcript)) { record in
                                    VoiceCallEndedRow(record: record)
                                }
                            }
                            .id(row.id)
                        }

                        // The reply as it is typed. It sits after the last
                        // settled message and disappears the moment the real
                        // one arrives — the store clears it on the same frame
                        // that appends the message, so there is never a beat
                        // where both are on screen.
                        if case let .room(room) = current {
                            ForEach(channelMembers) { bot in
                                RoomMemberLiveReply(live: session.liveText.entry(RuntimeEvent.roomStreamKey(threadId: threadId, botId: bot.id)), bot: bot,
                                    busy: hostLive && room.activeBotIds?.contains(bot.id) == true,
                                    face: memberFace(bot, in: room),
                                    named: transcript.last?.senderName != bot.name,
                                    steps: steps[bot.id] ?? [],
                                    startedAt: memberStartedAt(steps[bot.id]),
                                    onContent: { hasContent in
                                        let id = Self.liveBubbleId + ":" + bot.id
                                        if !restoringReading, follow.shouldScroll(id, hasContent: hasContent) { proxy.scrollTo(id, anchor: .bottom) }
                                    })
                            }
                            if room.activeBotIds == nil {
                                LiveReplyRow(live: session.liveText.entry(threadId), color: current.color, busy: current.busy) {
                                    WorkingSteps(items: liveSteps, startedAt: Date(timeIntervalSince1970: (liveSteps.first?.at ?? messages.last?.at ?? Date().timeIntervalSince1970 * 1000) / 1000))
                                }
                            }
                        } else {
                            LiveReplyRow(live: session.liveText.entry(threadId), color: current.color, busy: current.busy) {
                                // the desktop's TurnPresence: the bot's own face, moving,
                                // leads the working line in a 1:1
                                let face = MausState.forThread(current, in: session.state) ?? .thinking
                                WorkingSteps(
                                    items: liveSteps,
                                    startedAt: Date(timeIntervalSince1970: (liveSteps.first?.at ?? messages.last?.at ?? Date().timeIntervalSince1970 * 1000) / 1000),
                                    avatar: AnyView(ChatAvatarView(chat: current, size: 22, state: face, animated: true))
                                )
                            }
                        }
                        Color.clear.frame(height: 1).id(Self.bottomId)
                            .modifier(ReportsVisible { visible in
                                // The geometry callback can miss its last
                                // change while the header settles on open;
                                // the end itself in view is unambiguous.
                                if visible, !restoringReading, !follow.pinned { follow.pinned = true; pinnedChanged(true) }
                            })
                    }
                    .scrollTargetLayout()
                    .environment(\.mentionContext, mentionContext)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
                    .frame(maxWidth: CompanionLayout.chatWidth, alignment: .leading)
                    .frame(maxWidth: .infinity)
                }
                // The header lives in the scroll view's top safe area: the
                // transcript starts below it and scrolls under it — that is
                // what the glass is for. An inset rather than a content
                // margin, because `.defaultScrollAnchor(.bottom)` anchored
                // unreliably against a margin and opened chats mid-way.
                // The blur is only the top strip — back, computer — the way
                // a system bar is; the transcript starts on that line and
                // scrolls under the face and name, which float over it.
                .safeAreaInset(edge: .top, spacing: 0) {
                    headerBar
                        .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { mascotDock.header = $0 }
                }
                // A fresh thread is the bot itself, alive in the middle of
                // it, until the first message sends it up into the header.
                .overlay {
                    if case let .bot(bot) = current {
                        EmptyThreadMascot(bot: bot, threadId: threadId, isEmpty: showsEmptyMascot,
                                          draft: composerDraft, focused: composerFocused,
                                          dictating: dictation.isListening,
                                          unread: onClose == nil ? unreadElsewhere : 0,
                                          others: session.state.bots, dock: mascotDock)
                            .id(threadId)
                    }
                }
                // A conversation grows from the bottom: a transcript shorter
                // than the screen rests at the bottom, and opening a chat
                // starts on the newest message rather than the oldest.
                .defaultScrollAnchor(.bottom)
                .modifier(ReadingScrollPosition(visibleID: $visibleReadingID, jumpToEnd: jumpRequest))
                .onChange(of: visibleReadingID) { _, id in
                    if let id, messages.contains(where: { $0.id == id }) { lastReadingID = id }
                }
                .onChange(of: readingTarget) { _, id in
                    if let id { proxy.scrollTo(id, anchor: .top) }
                }
                .onChange(of: restoringReading) { _, restoring in
                    if !restoring, readingTarget == nil, session.focusedMessageId == nil {
                        proxy.scrollTo(Self.bottomId, anchor: .bottom)
                    }
                }
                .modifier(TrackPinnedToBottom(follow: follow, onChange: pinnedChanged))
                .overlay(alignment: .bottomTrailing) {
                    if scrolledAway {
                        JumpToLatestButton(unseen: unseenBelow) {
                            Haptics.selection()
                            unseenBelow = false
                            jumpToLatest(proxy, lastRow: transcript.last?.id)
                        }
                        .padding(.trailing, 16).padding(.bottom, 10)
                        .transition(.scale(scale: 0.6).combined(with: .opacity))
                    }
                }
                // Tapping the transcript puts the keyboard away. The composer
                // is a sibling of this scroll view rather than inside it, so
                // nothing else here drops its focus — until this, the only way
                // back to the whole conversation was to leave the chat.
                // Simultaneous, not `.onTapGesture`: a tap that lands on a
                // link, a card button or a selected word still reaches the row
                // that owns it, and only also closes the keyboard.
                .simultaneousGesture(TapGesture().onEnded {
                    if composerFocused { composerFocused = false }
                })
                // And a drag down over the transcript pushes it away, the way
                // it does in Mail and Messages.
                .scrollDismissesKeyboard(.interactively)
                // The header face: a fresh start per thread, the turn's mood
                // when it settles, and the lean toward an open card.
                .onChange(of: threadId, initial: true) { _, _ in
                    mascot.reset(busy: current.busy, cardOpen: cardWaiting)
                }
                .onChange(of: current.busy) { _, busy in
                    mascot.busyChanged(busy, mood: settledMood)
                }
                .onChange(of: cardWaiting) { _, open in mascot.cardChanged(open) }
                .onChange(of: transcript.last?.id) { _, _ in
                    guard !restoringReading, transcript.last != nil else { return }
                    if let head = transcript.last?.head, head.role == .bot, head.kind == .text { mascot.replyLanded() }
                    if follow.pinned { newestObservedID = transcript.last?.id }
                    // Your own message always brings you down to it; a reply
                    // arriving while you read further up waits behind the
                    // jump button instead of yanking the page.
                    let mine = transcript.last?.head.role == .user
                    guard mine || follow.pinned else { unseenBelow = true; return }
                    withAnimation { proxy.scrollTo(Self.bottomId, anchor: .bottom) }
                }
                // Follow the text as it arrives. Keyed on length rather than
                // the string so this fires once per delta batch, and without
                // animation — animating every token turns a smooth stream
                // into a stutter, because each scroll interrupts the last.
                // Subscribed directly, so a token scrolls without asking this
                // whole view to re-evaluate.
                .onReceive(session.liveText.entry(threadId).$text.map(\.count).removeDuplicates()) { length in
                    // Only while the reader is at the newest line; someone
                    // who scrolled up to read is left where they are.
                    guard !restoringReading, length > 0, follow.pinned else { return }
                    proxy.scrollTo(Self.liveBubbleId, anchor: .bottom)
                }
                .onChange(of: session.focusedMessageId) { _, messageId in
                    guard let messageId,
                          messages.contains(where: { $0.id == messageId })
                    else { return }
                    withAnimation { proxy.scrollTo(messageId, anchor: .center) }
                    session.consumeFocus(messageId)
                }
                .task {
                    guard let messageId = session.focusedMessageId,
                          messages.contains(where: { $0.id == messageId })
                    else {
                        // Open on the newest message. The bottom anchor
                        // aims at an estimate until the rows near it are
                        // built; scrolling to the row itself is exact.
                        if !restoringReading, readingTarget == nil, transcript.last != nil { proxy.scrollTo(Self.bottomId, anchor: .bottom) }
                        return
                    }
                    proxy.scrollTo(messageId, anchor: .center)
                    session.consumeFocus(messageId)
                }
#if DEBUG
                .task { await runAutopilot(proxy) }
#endif
            }
            .id(threadId)
            .frame(maxWidth: .infinity, maxHeight: .infinity)

            if let readingError { Text(readingError).font(.caption).foregroundStyle(.secondary) }
            if let uploadStatus { Text(uploadStatus).font(.caption).foregroundStyle(.secondary).accessibilityIdentifier("composer-upload-progress") }
            composer
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)

        let lifecycleView = transcriptView
        .onGeometryChange(for: CGFloat.self) { $0.size.height.rounded() } action: { chatHeight = $0 }
        .overlay(alignment: .bottom) { plusSheet }
        .toolbar(.hidden, for: .navigationBar)
        .navigationBarBackButtonHidden(true)
        .navigationDestination(isPresented: $showingComputer) {
            if case let .bot(bot) = current { ComputerView(bot: bot) }
        }
        .task(id: "\(session.connection?.id ?? "unpaired"):\(session.credentialEntryResetGeneration):\(threadId)") {
            if selectedThreadWasRemoved { leave(); return }
            if activeArchive == nil { restoreDraft() }
            session.setNotificationVisible(threadId: threadId, visible: true)
            let openedChat = current
            let unreadAtOpen = openedChat.unread
            saveReadingPosition()
            readingOpenedUnread = unreadAtOpen
            beginReadingPosition()
            await session.loadThreadIfNeeded(openedChat.threadId)
            await restoreReadingPosition(thread: openedChat.threadId, unread: unreadAtOpen)
            // opening a chat is what marks it read, exactly as on the desktop
            if openedChat.unread { await session.markRead(openedChat) }
#if DEBUG
            // `-open-plus`: the + sheet up, for the screenshot harness
            if ProcessInfo.processInfo.arguments.contains("-open-plus") { showingPlus = true }
            // Profile parity screenshots without automating a tap through the
            // animated island/header transition.
            if ProcessInfo.processInfo.arguments.contains("-open-profile") { showingProfile = true }
            // `-mention-picks a,b -mention-draft @p`: the @ drawer mid-pick
            let args = ProcessInfo.processInfo.arguments
            if let i = args.firstIndex(of: "-mention-picks"), i + 1 < args.count {
                let names = args[i + 1].split(separator: ",").map(String.init)
                mentionPicks = names.compactMap { name in mentionPool.first { $0.name == name } }
            }
            if let i = args.firstIndex(of: "-mention-draft"), i + 1 < args.count {
                draft = args[i + 1]; composerFocused = true
            }
#endif
        }
        .onChange(of: selectedThreadWasRemoved) { _, removed in
            if removed { leave() }
        }
#if DEBUG
        .onAppear { Autopilot.chatAppeared?() }
        .onDisappear { Autopilot.chatDisappeared?() }
#endif
        .onChange(of: session.state.hasLoadedPage(forThread: threadId)) { _, loaded in
            let requestedThread = threadId
            if !loaded { Task { await session.loadThreadIfNeeded(requestedThread) } }
            else if restoringReading { Task { await restoreReadingPosition(thread: requestedThread, unread: readingOpenedUnread) } }
        }
        .onChange(of: current.unread) { _, unread in
            // A message can arrive while this chat is already on screen. The
            // initial task above will not run again, so clear that new unread
            // bit here rather than leaving a badge on an open conversation.
            let readChat = current
            if unread { Task { await session.markRead(readChat) } }
        }
        .onChange(of: threadId) { previous, next in
            session.setNotificationVisible(threadId: previous, visible: false)
            session.setNotificationVisible(threadId: next, visible: true)
            saveReadingPosition()
            checkpointDraft()
            dictation.stop()
            restoreDraft()
            mentionPicks = []
            selectedPhotos = []
            showCommandHUD = false
            showingPlus = false
            // The local task picker changed threads. A download
            // started in the previous task must not open a sheet (or surface
            // its error) in the new one when the network reply arrives late.
            resetFilePreview()
            cancelThreadOpen()
        }
        .onChange(of: session.connection?.id) { _, _ in
            saveReadingPosition()
            checkpointDraft()
            restoreDraft()
            cancelThreadOpen()
        }
        .onChange(of: session.status) { _, status in
            if status == .live { checkpointDraft(); restoreDraft() }
        }
        .onChange(of: session.credentialEntryResetGeneration) { _, _ in
            checkpointDraft(); activeScope = nil; restoreDraft()
        }
        .onChange(of: attachments) { _, _ in checkpointDraft() }
        .onChange(of: replyTarget) { _, _ in checkpointDraft() }
        .onDisappear {
            saveReadingPosition()
            checkpointDraft()
            session.setNotificationVisible(threadId: threadId, visible: false)
            session.liveText.setComposing(false, by: composerID)
            dictation.stop()
            resetFilePreview()
            cancelThreadOpen()
        }
        .onChange(of: scenePhase) { _, phase in
            if phase != .active { saveReadingPosition(); checkpointDraft(); dictation.stop() }
        }
        .onChange(of: showingComputer) { _, shown in
            if shown { dictation.stop() }
        }
        .onChange(of: showingTasks) { _, shown in
            if shown { dictation.stop() }
        }
        .onChange(of: showingProfile) { _, shown in
            if shown { dictation.stop() }
        }
        .onChange(of: showingPlus) { _, shown in
            if shown { dictation.stop() }
        }

        return lifecycleView
        .onReceive(NotificationCenter.default.publisher(for: AVAudioSession.interruptionNotification)) { note in
            let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey]
            let value = (raw as? NSNumber)?.uintValue ?? (raw as? UInt)
            if value == AVAudioSession.InterruptionType.began.rawValue {
                dictation.stop()
            }
        }
        .onChange(of: dictation.transcript) { _, spoken in
            // Always join against the text frozen at capture start. A newer
            // partial then replaces the older partial instead of duplicating it.
            draft = Dictation.draft(base: dictation.base, transcript: spoken)
        }
        .onChange(of: dictation.isListening) { _, listening in
            if listening { composerFocused = false }
        }
        .fullScreenCover(isPresented: $showingWalkie) {
            WalkieView { selected in
                showingWalkie = false
                if selected.id == current.id { selectedThreadId = selected.threadId }
            }.session(session)
        }
        .sheet(isPresented: $showingTasks) {
            if current.supportsTasks {
                TaskManagerView(chat: current) { selectedThreadId = $0 }
            }
        }
        .sheet(isPresented: $showingProfile) {
            switch current {
            case let .bot(bot): AgentProfileView(bot: bot)
            case let .room(room): ChannelSettingsView(room: room)
            }
        }
        .sheet(item: $shareFile) { file in
            ActivityShareSheet(items: [file.url])
        }
        .sheet(item: $editingQueued) { send in
            // Pinned to the thread and chat it was opened from, so a switch
            // underneath can never retarget the save.
            let editThreadId = threadId
            let editChat = current
            QueuedSendEditor(
                send: send,
                recipient: queuedRecipientName,
                threadTitle: queuedThreadTitle,
                live: (session.state.pendingQueued[editThreadId] ?? []).first { $0.queueId == send.queueId }
            ) { text in
                await session.editQueued(send, threadId: editThreadId, in: editChat, text: text)
            }
        }
        .photosPicker(
            isPresented: $showingPhotoPicker,
            selection: $selectedPhotos,
            maxSelectionCount: max(1, AttachmentPolicy.maximumItems - attachments.count),
            matching: .images,
            preferredItemEncoding: .current
        )
        .onChange(of: selectedPhotos) { _, items in
            guard !items.isEmpty else { return }
            Task { await importPhotos(items) }
        }
        .fileImporter(
            isPresented: $showingFileImporter,
            allowedContentTypes: [.content],
            allowsMultipleSelection: true,
            onCompletion: importFiles
        )
        .fullScreenCover(item: $filePreview) { preview in
            FilePreviewView(item: preview) {
                filePreview = nil
            }
        }
    }

    /// Rows far above the end only have estimated heights in the lazy stack,
    /// so in a long transcript `proxy.scrollTo` to the end stopped short or
    /// didn't move at all. On iOS 18 the scroll position goes to the bottom
    /// edge, which doesn't depend on finding a row. On 17, go to the last
    /// row, which the stack can always find, then settle on the end marker.
    private func jumpToLatest(_ proxy: ScrollViewProxy, lastRow: String?) {
        if #available(iOS 18.0, *) {
            jumpRequest += 1
            return
        }
        if let lastRow { proxy.scrollTo(lastRow, anchor: .bottom) }
        Task { @MainActor in
            for pass in 0..<10 {
                try? await Task.sleep(for: .milliseconds(60))
                proxy.scrollTo(Self.bottomId, anchor: .bottom)
                if pass >= 2, follow.pinned { return }
            }
        }
    }

    private func pinnedChanged(_ pinned: Bool) {
        guard !restoringReading else { follow.pinned = false; return }
        if pinned { newestObservedID = messages.last?.id }
        if scrolledAway == pinned { withAnimation(.snappy(duration: 0.2)) { scrolledAway = !pinned } }
        if mascot.lookingBack == pinned { mascot.lookingBack = !pinned }
        if pinned { unseenBelow = false }
    }

    // MARK: - Header

    /// Back on the left with the rest-of-app unread count, threads and the
    /// bot's computer on the right — a blurred strip to the top edge.
    private var headerBar: some View {
        ChatHeaderBar(name: current.name, unreadElsewhere: onClose == nil ? unreadElsewhere : 0,
                      canOpenThreads: current.supportsTasks,
                      // A bot on another Mac has no settings or computer the
                      // server will open for this phone.
                      canOpenSettings: !current.isRemoteBot,
                      onBack: leave,
                      onThreads: { showingTasks = true }, onSettings: { showingProfile = true },
                      accessory: rosterAccessory,
                      closesPane: onClose != nil,
                      beside: openBeside.map { open in AnyView(OpenBesideMenu(current: current, open: open)) },
                      onNewThread: current.supportsTasks ? { newThread() } : nil,
                      onCall: { Haptics.selection(); startVoice() },
                      threadDone: threadDone) {
            // The activity feed's face for this exact thread, so the header
            // moves while the bot works here; without a feed entry, the
            // still idle face it always had.
            ThreadHeaderFace(chat: current, size: 30, live: MausState.forThread(current, in: session.state),
                             director: mascot, draft: composerDraft, typing: composerFocused)
                .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { mascotDock.avatar = $0 }
                // While the empty thread's mascot is out it is the bot; a
                // second face up here is one too many. It comes back as the
                // mascot is sucked up into it.
                .opacity(showsEmptyMascot ? 0 : 1)
                .animation(.easeOut(duration: 0.18).delay(showsEmptyMascot ? 0 : 0.4), value: showsEmptyMascot)
        }
    }

    /// A bot thread that has loaded and has nothing in it yet: no messages,
    /// no turn running, nothing on its way.
    private var showsEmptyMascot: Bool {
        guard case .bot = current else { return false }
        return session.state.hasLoadedPage(forThread: threadId) && messages.isEmpty && !current.busy && !sendingMessage
    }

    /// True when a bot's turn here has settled on its own reply, so the next
    /// step is the person's: an empty composer offers to carry on.
    private var canContinue: Bool {
        guard case .bot = current, !current.busy, !sendingMessage, attachments.isEmpty,
              let last = messages.last(where: { $0.kind != .activity }) else { return false }
        return last.role == .bot && last.kind == .text
    }

    /// A fresh, empty thread with this chat, opened in place.
    private func newThread() {
        guard !creatingThread else { return }
        Haptics.selection()
        creatingThread = true
        let chat = current
        Task {
            defer { creatingThread = false }
            switch chat {
            case let .bot(bot):
                if let created = await session.createTask(for: bot, title: nil) { selectedThreadId = created.threadId }
                else if session.actionError == nil { session.actionError = "Couldn't create a thread. Check the connection and try again." }
            case let .room(room):
                guard room.busyBotId == nil else {
                    session.actionError = "Try again when the current reply finishes."
                    return
                }
                _ = await session.createTask(for: room, title: nil)
            }
        }
    }

    /// "Mark done" for the open thread, or "Unarchive" once it is archived.
    /// Bot threads only; a working thread cannot be marked done.
    private var threadDone: ThreadDoneAction? {
        guard case let .bot(bot) = chat,
              let task = session.state.bot(bot.id)?.tasks?.first(where: { $0.threadId == selectedThreadId })
        else { return nil }
        if task.isArchived {
            return ThreadDoneAction(title: "Unarchive", systemImage: "arrow.uturn.backward", disabled: false) {
                setArchived(task, in: bot, archivedAt: nil)
            }
        }
        return ThreadDoneAction(title: "Mark done", systemImage: "checkmark.circle", disabled: !task.canMarkDone) {
            // The desktop sends Date.now(); the server takes any epoch number.
            setArchived(task, in: bot, archivedAt: (Date().timeIntervalSince1970 * 1000).rounded())
            // Back to the list right away: the optimistic update has already
            // taken the thread out of it, and a failed write restores it.
            // The bot's row checks off there once the pop has landed.
            Haptics.success()
            DoneMoments.shared.celebrate(bot.id, after: 0.4)
            leave()
        }
    }

    private func setArchived(_ task: BotTask, in bot: Bot, archivedAt: Double?) {
        let session = session
        Task { @MainActor in
            guard let live = session.state.bot(bot.id) else { return }
            await session.setTaskArchived(task, for: live, archivedAt: archivedAt)
        }
    }

    /// Back on a phone or a primary pane; close on a side pane.
    private func leave() {
        if let onClose { onClose() } else { dismiss() }
    }

    private var channelMembers: [Bot] {
        guard case let .room(room) = current else { return [] }
        return room.members(from: session.state.bots)
    }
    private var hostLive: Bool { if case .live = session.status { return true }; return false }
    private var rosterAccessory: AnyView? {
        guard case let .room(room) = current else { return nil }
        return AnyView(ChannelRosterChip(
            roster: ChannelRoster(room: room, members: channelMembers, hostLive: hostLive),
            notifications: room.notifications,
            faces: Dictionary(uniqueKeysWithValues: channelMembers.compactMap { bot in memberFace(bot, in: room).map { (bot.id, $0) } })
        ) { showingProfile = true })
    }

    /// The activity feed's face for one member working in this room, or nil
    /// for the still face. Scoped to the room, so the same bot busy in
    /// another chat never moves here.
    private func memberFace(_ bot: Bot, in room: Room) -> MausState? {
        let feed = session.state.activityFeed
        guard let live = feed.busiest(bot: bot.id, room: room.id) ?? feed.entry(bot: bot.id, thread: room.threadId) else { return nil }
        return MausState.forFeed(live)
    }

    // MARK: - Mentions

    private var workingMembers: Set<String> {
        guard case let .room(room) = current else { return [] }
        return Set(channelMembers.filter { ChannelMemberStatus.resolve(room: room, bot: $0, hostLive: hostLive) == .working }.map(\.id))
    }

    /// Who the @ drawer offers here: @everyone and the members in a room,
    /// the other local bots in a bot's chat — the desktop composer's pool.
    private var mentionPool: [MentionTarget] {
        MentionPool.targets(for: current, bots: session.state.bots)
    }

    /// The names messages here can mention, so they draw as tokens.
    private var mentionContext: MentionContext {
        let found = MentionPool.peers(for: current, bots: session.state.bots)
        return MentionContext(peers: found.peers, everyone: found.everyone)
    }

    /// A pick keeps the drawer open on a fresh @ so the next one is one tap.
    private func toggleMention(_ target: MentionTarget) {
        Haptics.selection()
        withAnimation(.snappy(duration: 0.22)) {
            if let index = mentionPicks.firstIndex(where: { $0.id == target.id }) { mentionPicks.remove(at: index) }
            else { mentionPicks.append(target) }
        }
        draft = ChannelMentionPicker.removingQuery(from: draft) + "@"
        composerFocused = true
    }

    private func closeMentionDrawer() {
        draft = ChannelMentionPicker.removingQuery(from: draft)
        composerFocused = true
    }

    // MARK: - The + sheet

    /// What the composer's + opens: a glass sheet of the things you can do
    /// here, each with a line saying what it does. Rises above the composer;
    /// tapping anywhere else, or the × the + became, puts it away.
    private var plusSheet: some View { ChatActionSheet(showing: $showingPlus, actions: plusActions) }

    private typealias PlusAction = ChatActionSheet.Action

    private var plusActions: [PlusAction] {
        let canAddAttachment = attachments.count < AttachmentPolicy.maximumItems
            && !preparingAttachments && !sendingMessage
        var out: [PlusAction] = [
            PlusAction(
                id: "photos", systemImage: "photo.on.rectangle", title: "Photo Library",
                subtitle: "Add a photo to this message", disabled: !canAddAttachment
            ) { showingPhotoPicker = true },
            PlusAction(
                id: "files", systemImage: "paperclip", title: "Choose File",
                subtitle: "Add a document from Files", disabled: !canAddAttachment
            ) { showingFileImporter = true },
        ]
        if case let .bot(bot) = current {
            out.append(PlusAction(
                id: "task", systemImage: "plus.square.on.square", title: "New thread",
                subtitle: "Start a fresh thread with \(bot.name)"
            ) { Task {
                if let created = await session.createTask(for: bot, title: nil) {
                    selectedThreadId = created.threadId
                }
            } })
            out.append(PlusAction(
                id: "tasks", systemImage: "square.stack", title: "Threads",
                subtitle: "Switch, rename or remove one"
            ) { showingTasks = true })
            if bot.remote == nil {
                out.append(PlusAction(
                    id: "settings", systemImage: "gearshape", title: "Bot settings",
                    subtitle: "Model, profile, voice and notifications"
                ) { showingProfile = true })
                out.append(PlusAction(
                    id: "computer", systemImage: "display", title: "Watch computer",
                    subtitle: "Live view of what \(bot.name) is doing"
                ) { showingComputer = true })
            }
        }
        if case let .room(room) = current, room.dm != true {
            out.append(PlusAction(
                id: "task", systemImage: "plus.square.on.square", title: "New thread",
                subtitle: "Start a fresh conversation in \(room.name)",
                disabled: current.busy || hasPendingApproval
            ) { Task { await session.createTask(for: room, title: nil) } })
            out.append(PlusAction(
                id: "tasks", systemImage: "square.stack", title: "Threads",
                subtitle: "Switch, rename or remove one"
            ) { showingTasks = true })
        }
        // Export is refused for a bot on another Mac.
        if !current.isRemoteBot {
        out.append(PlusAction(
            id: "share", systemImage: "doc.plaintext", title: "Share transcript",
            subtitle: "This thread as Markdown"
        ) {
            Task {
                if let url = await session.export(threadId: current.threadId, format: "markdown") {
                    shareFile = ShareFile(url: url)
                }
            }
        })
        out.append(PlusAction(
            id: "share-json", systemImage: "curlybraces", title: "Share as JSON",
            subtitle: "Structured transcript data"
        ) {
            Task {
                if let url = await session.export(threadId: current.threadId, format: "json") {
                    shareFile = ShareFile(url: url)
                }
            }
        })
        }
        out.append(PlusAction(
            id: "walkie", systemImage: "waveform.circle", title: "Walkie-talkie",
            subtitle: "Hold to talk, hear the reply read back"
        ) { openWalkie() })
        if current.busy, case let .bot(bot) = current {
            out.append(PlusAction(
                id: "stop", systemImage: "stop.fill", title: "Interrupt",
                subtitle: "Stop the current turn", destructive: true
            ) { Task { await session.interrupt(bot: bot) } })
        }
        return out
    }

    /// Finished voice calls in this thread that ended after this row and
    /// before the next one. Calls older than the loaded history sit after
    /// the first row rather than vanishing.
    private func voiceRecords(after index: Int, in rows: [TranscriptRow]) -> [VoiceCallRecord] {
        guard case let .bot(bot) = current else { return [] }
        let records = voiceCalls.records(botId: bot.id, threadId: threadId)
        guard !records.isEmpty else { return [] }
        let from = index == 0 ? -Double.infinity : rows[index].at
        let until = index + 1 < rows.count ? rows[index + 1].at : Double.infinity
        return records.filter { $0.endedAt >= from && $0.endedAt < until }
    }

    /// Voice is a realtime call for a bot on this computer; rooms and bots
    /// on another Mac keep the walkie-talkie.
    private func startVoice() {
        if case let .bot(bot) = current, bot.remote == nil {
            voiceCalls.start(bot: bot, threadId: threadId, session: session)
        } else {
            openWalkie()
        }
    }

    private func openWalkie() {
        UserDefaults.standard.set(current.id, forKey: "walkie.target")
        showingWalkie = true
    }

    /// True when this message opens a fresh stretch of conversation — the
    /// first one, or one that follows a gap of half an hour or more.
    private func startsANewStretch(at index: Int, in rows: [TranscriptRow]) -> Bool {
        guard index > 0 else { return true }
        return rows[index].at - rows[index - 1].endAt > 30 * 60 * 1000
    }

    /// True when the next message is from someone else (or there is none),
    /// which is where a run of bubbles gets its tail — one per run, like
    /// every messaging app, rather than one per bubble.
    private func endsRun(at index: Int, in rows: [TranscriptRow]) -> Bool {
        guard index + 1 < rows.count else { return true }
        let this = rows[index], next = rows[index + 1]
        if this.role != next.role { return true }
        if this.senderName != next.senderName { return true }
        // a card or a tool chip between two texts breaks the run visually
        return next.kind != .text
    }

    private var canSend: Bool {
        (!draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !attachments.isEmpty)
            && !preparingAttachments && !sendingMessage
    }

    /// Messages the harness is holding for this thread. They sit above the
    /// composer rather than pretending to be part of the transcript: the
    /// turn that is still running owns the transcript's tail, and these
    /// words have not been said yet.
    private var heldSends: [QueuedSend] {
        session.state.pendingQueued[threadId] ?? []
    }

    private var queuedRecipientName: String {
        switch current {
        case let .bot(bot): return bot.name
        case let .room(room): return "#\(room.name)"
        }
    }

    private var queuedThreadTitle: String? {
        let tasks: [BotTask]?
        switch current {
        case let .bot(bot): tasks = bot.tasks
        case let .room(room): tasks = room.tasks
        }
        return tasks?.first { $0.threadId == threadId }?.title
    }

    /// Rooms run several members at once: the queued head steers into the
    /// member the server will pick for it (its @mention, else the only
    /// active speaker), never whoever happens to be listed busy first. When
    /// that pick is ambiguous or not running, the reason replaces Steer.
    private var roomSteerTarget: (target: Bot?, unavailable: String?)? {
        guard case let .room(room) = current, let head = heldSends.first else { return nil }
        switch RoomSteerTarget.resolve(queuedText: head.text, members: channelMembers,
                                       activeBotIds: RoomSteerTarget.activeBotIds(room)) {
        case let .member(bot): return (bot, nil)
        case .ambiguous: return (nil, String(localized: "Mention one bot to steer"))
        case let .waiting(bots):
            return (nil, bots.count == 1 ? String(localized: "Waits for \(bots[0].name)") : String(localized: "Waits for its turn"))
        }
    }

    private var hasPendingApproval: Bool {
        messages.contains { $0.card?.isPending == true }
    }

    /// A question, approval or secret card is waiting on you here.
    private var cardWaiting: Bool {
        messages.contains { $0.card?.isPending == true || $0.secret?.isPending == true }
    }

    /// How the turn that just settled went, for the header face.
    private func settledMood() -> ThreadMood? {
        var feed: ActivityFeedState?
        if case let .bot(bot) = current { feed = session.state.activityFeed.entry(bot: bot.id, thread: bot.threadId)?.state }
        return ThreadMoodRules.mood(after: messages, feed: feed)
    }

    private func beginReadingPosition() {
        restoringReading = true; readingTarget = nil; visibleReadingID = nil
        lastReadingID = nil; newestObservedID = nil; newMessagesBoundary = nil
        readingStore = nil; savedReading = nil; readingError = nil
        do {
            guard let connection = session.connection,
                  let token = try BosSharedKeychain.token(for: connection.id) else { return }
            let root = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            let store = ReadingPositionStore(root: root.appendingPathComponent("ReadingPositions"), connectionID: connection.id,
                accountIdentity: token, conversationID: current.id, threadID: threadId)
            readingStore = store; savedReading = try store.load()
            newestObservedID = savedReading?.newestObservedID
            follow.pinned = savedReading?.anchorID == nil
        } catch { readingError = "Couldn’t restore this phone’s reading position." }
    }

    private func restoreReadingPosition(thread: String, unread: Bool) async {
        guard session.state.hasLoadedPage(forThread: thread) else {
            readingError = "Reading position will return when this chat reconnects."
            return
        }
        // Bounded history recovery; a removed/very old anchor falls back to
        // latest rather than inventing an unread boundary in a partial page.
        for _ in 0..<8 {
            guard threadId == thread, !Task.isCancelled else { return }
            let ids = messages.map(\.id)
            let needsAnchor = savedReading?.anchorID.map { !ids.contains($0) } ?? false
            let needsBoundary = unread && (savedReading?.newestObservedID.map { !ids.contains($0) } ?? false)
            guard needsAnchor || needsBoundary, session.state.hasMore[thread] == true else { break }
            let oldest = ids.first
            await session.loadOlder(threadId: thread)
            if oldest == messages.first?.id { break }
        }
        guard threadId == thread, !Task.isCancelled else { return }
        let ids = messages.map(\.id)
        newMessagesBoundary = savedReading?.firstNewMessage(in: ids, unread: unread)
        let anchor = savedReading?.retainedAnchor(in: ids)
        readingTarget = session.focusedMessageId == nil ? anchor : nil
        lastReadingID = anchor
        follow.pinned = anchor == nil
        scrolledAway = anchor != nil
        if anchor == nil { newestObservedID = ids.last }
        readingError = nil
        restoringReading = false
    }

    private func saveReadingPosition() {
        guard !restoringReading, let readingStore else { return }
        do { try readingStore.save(.init(anchorID: lastReadingID, newestObservedID: newestObservedID)) }
        catch { readingError = "Couldn’t save this phone’s reading position." }
    }

    private func checkpointDraft() {
        composerDraft.pendingCheckpoint?.cancel()
        guard let archive = activeArchive else { return }
        archive.text = draft; archive.files = attachments; archive.reply = replyTarget
        do { try archive.checkpoint() } catch { attachmentError = archive.error }
    }

    private func restoreDraft() {
        do {
            guard let connection = session.connection,
                  let token = try BosSharedKeychain.token(for: connection.id) else {
                composerDraft.pendingCheckpoint?.cancel(); composerDraft.onEdit = nil
                activeArchive = nil; activeScope = nil
                draft = ""; attachments = []; replyTarget = nil
                attachmentError = "Unlock and reconnect before restoring or sending this draft."
                return
            }
            // A bearer rotation/account re-pair owns a separate namespace.
            // Only its digest reaches disk; credential bytes never do.
            let scope = [connection.id, token, current.id, threadId].joined(separator: "\u{0}")
            let key = SHA256.hash(data: Data(scope.utf8)).map { String(format: "%02x", $0) }.joined()
            guard activeScope != key else { return }
            composerDraft.pendingCheckpoint?.cancel(); composerDraft.onEdit = nil
            let root = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            let archive = archives[key] ?? BotDraft(directory: root.appendingPathComponent("BotDrafts").appendingPathComponent(key))
            archives[key] = archive
            activeArchive = archive; activeScope = key
            draft = archive.text; attachments = archive.files; replyTarget = archive.reply; attachmentError = archive.error
            composerDraft.onEdit = { text in
                archive.text = text
                do { try archive.checkpoint() } catch { attachmentError = archive.error }
            }
        } catch { attachmentError = "Couldn’t restore this draft. Unlock and reconnect before sending." }
    }

    private func submit(_ explicitText: String? = nil) {
        // This also cancels an in-flight permission prompt before it can
        // open the microphone after the message has already been sent.
        dictation.stop()
        let draftAtSend = draft
        let picksAtSend = explicitText == nil ? mentionPicks : []
        let text = (explicitText ?? ChannelMentionPicker.outgoing(draftAtSend, targets: picksAtSend)).trimmingCharacters(in: .whitespacesAndNewlines)
        let outgoingAttachments = attachments
        let replyAtSend = replyTarget
        let chatAtSend = current
        guard !text.isEmpty || !outgoingAttachments.isEmpty,
              !preparingAttachments,
              !sendingMessage
        else { return }
        let priorityAtSend: MessagePriority = chatAtSend.busy ? sendPriority : .queue
        checkpointDraft()
        guard let archive = activeArchive else { return }
        let durableID: String
        do { durableID = try archive.prepareSend(text: text, priority: priorityAtSend) }
        catch { attachmentError = archive.error; return }
        sendPriority = .queue
        sendingMessage = true
        attachmentError = nil
        showCommandHUD = false
        showingPlus = false
        Task {
            let sent = await session.send(
                text: text,
                attachments: outgoingAttachments,
                to: chatAtSend,
                replyToId: replyAtSend?.id,
                priority: priorityAtSend,
                durableSendID: durableID,
                uploadProgress: { name, completed, total in
                    if activeArchive === archive { uploadStatus = "\(name) (\(completed)/\(total))" }
                }
            )
            sendingMessage = false
            uploadStatus = nil
            guard sent else {
                let failure = session.actionError ?? "Couldn't send this message. Try again."
                if activeArchive === archive { attachmentError = failure }
                session.actionError = nil
                Haptics.notification(.error)
                return
            }
            archive.complete(sendID: durableID)
            guard activeArchive === archive else { return }
            attachmentError = archive.error
            if replyTarget?.id == replyAtSend?.id { replyTarget = nil }
            // HUD commands expand `/diff` into a longer prompt. Compare with
            // what was actually in the field at tap time, not the expanded
            // text, so the command clears without erasing a newer edit.
            if draft == draftAtSend {
                draft = ""
            }
            if !picksAtSend.isEmpty, mentionPicks.map(\.id) == picksAtSend.map(\.id) { mentionPicks = [] }
            if attachments.map(\.id) == outgoingAttachments.map(\.id) {
                attachments = []
            }
            SoundEffects.playSent()
            Haptics.impact(.medium)
            mascot.sent()
        }
    }

    private func importPhotos(_ items: [PhotosPickerItem]) async {
        guard !preparingAttachments, !sendingMessage else { return }
        let importingArchive = activeArchive
        let existingAttachments = attachments
        let available = AttachmentPolicy.maximumItems - existingAttachments.count
        guard items.count <= available else {
            selectedPhotos = []
            attachmentError = "Send up to \(AttachmentPolicy.maximumItems) items at a time."
            return
        }

        preparingAttachments = true
        attachmentError = nil
        defer {
            preparingAttachments = false
            selectedPhotos = []
        }

        do {
            var imported: [PendingMessageAttachment] = []
            for (index, item) in items.enumerated() {
                guard let raw = try await item.loadTransferable(type: Data.self) else {
                    throw AttachmentImportError.unreadable("that photo")
                }
                let actualType = CGImageSourceCreateWithData(raw as CFData, nil)
                    .flatMap(CGImageSourceGetType)
                    .flatMap { UTType($0 as String) }
                let actualMime = actualType?.preferredMIMEType
                    .map(AttachmentPolicy.normalizedMIME)

                let data: Data
                let mime: String
                let fileExtension: String
                if let actualMime, AttachmentPolicy.imageMIMETypes.contains(actualMime) {
                    data = raw
                    mime = actualMime
                    fileExtension = actualType?.preferredFilenameExtension ?? "jpg"
                } else if let image = UIImage(data: raw),
                          let jpeg = image.jpegData(compressionQuality: 0.9) {
                    data = jpeg
                    mime = "image/jpeg"
                    fileExtension = "jpg"
                } else {
                    throw AttachmentImportError.unsupported("that photo")
                }

                let candidate = PendingMessageAttachment(
                    id: UUID(),
                    data: data,
                    name: items.count == 1 ? "Photo.\(fileExtension)" : "Photo \(index + 1).\(fileExtension)",
                    mime: mime,
                    kind: .image
                )
                try AttachmentPolicy.validate(existingAttachments + imported + [candidate])
                imported.append(candidate)
            }
            if activeArchive === importingArchive { attachments.append(contentsOf: imported); checkpointDraft() }
            else if let importingArchive {
                importingArchive.files.append(contentsOf: imported)
                try importingArchive.checkpoint()
            }
            Haptics.selection()
        } catch {
            if activeArchive === importingArchive { attachmentError = error.localizedDescription }
        }
    }

    private func importFiles(_ result: Result<[URL], Error>) {
        guard case let .success(urls) = result else {
            if case let .failure(error) = result { attachmentError = error.localizedDescription }
            return
        }
        guard !urls.isEmpty else { return }
        Task { await importFiles(urls) }
    }

    private func importFiles(_ urls: [URL]) async {
        guard !preparingAttachments, !sendingMessage else { return }
        let importingArchive = activeArchive
        let existingAttachments = attachments
        let available = AttachmentPolicy.maximumItems - existingAttachments.count
        guard urls.count <= available else {
            attachmentError = "Send up to \(AttachmentPolicy.maximumItems) items at a time."
            return
        }

        preparingAttachments = true
        attachmentError = nil
        defer { preparingAttachments = false }

        do {
            var imported: [PendingMessageAttachment] = []
            for url in urls {
                let usedBytes = (existingAttachments + imported).reduce(0) { $0 + $1.data.count }
                let remainingBytes = max(0, AttachmentPolicy.maximumTotalBytes - usedBytes)
                let candidate = try await Task.detached(priority: .userInitiated) {
                    try Self.readImportedFile(url, remainingBytes: remainingBytes)
                }.value
                try AttachmentPolicy.validate(existingAttachments + imported + [candidate])
                imported.append(candidate)
            }
            if activeArchive === importingArchive { attachments.append(contentsOf: imported); checkpointDraft() }
            else if let importingArchive {
                importingArchive.files.append(contentsOf: imported)
                try importingArchive.checkpoint()
            }
            Haptics.selection()
        } catch {
            if activeArchive === importingArchive { attachmentError = error.localizedDescription }
        }
    }

    nonisolated private static func readImportedFile(
        _ url: URL,
        remainingBytes: Int
    ) throws -> PendingMessageAttachment {
        let accessed = url.startAccessingSecurityScopedResource()
        defer { if accessed { url.stopAccessingSecurityScopedResource() } }

        let values = try url.resourceValues(
            forKeys: [.contentTypeKey, .isRegularFileKey, .fileSizeKey]
        )
        guard values.isRegularFile != false else {
            throw AttachmentImportError.unreadable(url.lastPathComponent)
        }
        let name = url.lastPathComponent.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { throw AttachmentImportError.unreadable("that file") }
        let inferred = values.contentType ?? UTType(filenameExtension: url.pathExtension)
        let mime = AttachmentPolicy.normalizedMIME(
            inferred?.preferredMIMEType ?? "application/octet-stream"
        )
        guard let kind = AttachmentPolicy.kind(forMIME: mime) else {
            throw AttachmentImportError.unsupported(name)
        }
        let itemLimit = kind == .image
            ? AttachmentPolicy.maximumImageBytes
            : AttachmentPolicy.maximumFileBytes
        let readLimit = min(itemLimit, remainingBytes)
        if let fileSize = values.fileSize, fileSize > readLimit {
            throw AttachmentImportError.tooLarge(name, readLimit)
        }
        // Some document providers do not report a size. Never let that turn
        // into an unbounded read of a provider-controlled file: read one byte
        // past the remaining allowance and reject it before it can become a
        // large in-memory draft.
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        let data = try handle.read(upToCount: readLimit + 1) ?? Data()
        guard data.count <= readLimit else {
            throw AttachmentImportError.tooLarge(name, readLimit)
        }
        return PendingMessageAttachment(
            id: UUID(), data: data, name: name, mime: mime, kind: kind
        )
    }

    /// A chip that opened a thread on this bot switches this screen in
    /// place; one that opened a thread on a teammate pushes that chat.
    private func openThread(_ ref: ThreadRef) {
        cancelThreadOpen()
        let shownBotId: String? = current.isBot ? current.id : nil
        threadOpenTask = Task {
            let openedThreadId = await session.openThread(ref, shownBotId: shownBotId)
            guard !Task.isCancelled else { return }
            threadOpenTask = nil
            if let openedThreadId { selectedThreadId = openedThreadId }
        }
    }

    private func cancelThreadOpen() {
        threadOpenTask?.cancel()
        threadOpenTask = nil
    }

    private func openLink(_ url: URL, from message: Message) -> OpenURLAction.Result {
        guard let target = LocalMessageLink.resolve(url) else {
            fileOpenError = "This link can't be opened securely."
            return .handled
        }
        switch target {
        case let .web(webURL):
            return .systemAction(webURL)
        case let .desktopFile(path):
            openFile(path: path, from: message)
            return .handled
        }
    }

    private func openFile(path: String, from message: Message) {
        fileDownloadTask?.cancel()
        let requestID = UUID()
        fileDownloadRequestID = requestID
        let requestedThreadID = threadId
        fileOpenError = nil
        let name = URL(fileURLWithPath: path).lastPathComponent
        openingFileName = name.isEmpty ? "file" : name
        let task = Task {
            let downloaded = await session.downloadFile(
                threadId: requestedThreadID,
                messageId: message.id,
                path: path
            )
            if let downloaded, let preview = FilePreviewItem(downloaded: downloaded) {
                // Own the temporary file before checking cancellation so an
                // old link tap cannot strand it between Session and the sheet.
                guard !Task.isCancelled, fileDownloadRequestID == requestID else {
                    preview.cleanUp()
                    return
                }
                openingFileName = nil
                filePreview?.cleanUp()
                filePreview = preview
                fileDownloadRequestID = nil
                fileDownloadTask = nil
                return
            }
            guard !Task.isCancelled, fileDownloadRequestID == requestID else { return }
            openingFileName = nil
            fileDownloadRequestID = nil
            fileDownloadTask = nil
            guard downloaded != nil else {
                fileOpenError = session.actionError ?? "Couldn't open that file. Try again."
                session.actionError = nil
                return
            }
            fileOpenError = "The downloaded file couldn't be previewed."
        }
        fileDownloadTask = task
    }

    /// End the preview lifecycle owned by the task that just left the screen.
    private func resetFilePreview() {
        fileDownloadTask?.cancel()
        fileDownloadTask = nil
        fileDownloadRequestID = nil
        openingFileName = nil
        fileOpenError = nil
        filePreview?.cleanUp()
        filePreview = nil
    }

    // MARK: - Composer

    /// The composer's stop square, while a bot is working.
    private var stopAction: (() -> Void)? {
        guard current.busy, case let .bot(bot) = current else { return nil }
        return {
            Haptics.impact(.light)
            Task { await session.interrupt(bot: bot) }
        }
    }

    /// A round + and a glass pill with dictation and send inside it.
    private var composer: some View {
        VStack(spacing: 6) {
            LegacyArchivedBanner()

            if !heldSends.isEmpty {
                let roomSteer = roomSteerTarget
                QueuedSendList(sends: heldSends, steerTargetName: roomSteer?.target?.name,
                               steerUnavailable: roomSteer?.unavailable, steer: { send in
                    await session.steerQueued(send, threadId: threadId, in: current, botId: roomSteer?.target?.id)
                }, edit: { editingQueued = $0 }) { send in
                    Task { await session.cancelQueued(send, threadId: threadId, in: current) }
                }
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }

            if preparingAttachments || sendingMessage {
                HStack(spacing: 8) {
                    ProgressView()
                        .controlSize(.small)
                    Text(preparingAttachments ? "Preparing attachments…" : "Sending…")
                        .font(.system(size: 13, weight: .medium))
                }
                .foregroundStyle(Color.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 4)
                .accessibilityElement(children: .combine)
            }

            if let openingFileName {
                HStack(spacing: 8) {
                    ProgressView()
                        .controlSize(.small)
                    Text("Opening \(openingFileName)…")
                        .font(.system(size: 13, weight: .medium))
                        .lineLimit(1)
                }
                .foregroundStyle(Color.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 4)
                .accessibilityElement(children: .combine)
            }

            if let error = fileOpenError ?? attachmentError {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(Color.orange)
                    Text(error)
                        .font(.system(size: 13))
                        .foregroundStyle(Color.primary)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 4)
                    Button("Dismiss") {
                        fileOpenError = nil
                        attachmentError = nil
                    }
                    .font(.system(size: 13, weight: .semibold))
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 9)
                .background(Color.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 12))
                .accessibilityElement(children: .combine)
            }

            if let error = dictation.error {
                Text(error)
                    .font(.system(size: 13))
                    .foregroundStyle(.orange)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 4)
            }

            if showCommandHUD {
                CommandSkillHUDView(
                    text: $composerDraft.text,
                    isVisible: $showCommandHUD,
                    commands: current.isRemoteBot
                        ? CommandSkillHUDView.defaultCommands.filter { $0.id != "computer" && $0.id != "steer" }
                        : current.isBot
                        ? CommandSkillHUDView.defaultCommands
                        : CommandSkillHUDView.defaultCommands.filter {
                            $0.id != "computer" && (current.supportsTasks || $0.id != "tasks")
                        },
                    accentColor: MausPalette.color(current.color)
                ) { command in
                    switch command.id {
                    case "computer":
                        draft = ""
                        showingComputer = true
                    case "tasks":
                        draft = ""
                        showingTasks = true
                    default: submit(command.command)
                    }
                }
                .transition(.move(edge: .bottom).combined(with: .opacity))
            } else if attachments.isEmpty && !current.busy
                        && !hasPendingApproval && !storedChips.isEmpty && !showsEmptyMascot {
                EmptyDraftOnly(composer: composerDraft) {
                    PredictiveActionChipsView(chips: storedChips, accentColor: MausPalette.color(current.color)) { chip in
                        submit(chip.prompt)
                    }
                    .transition(.opacity)
                }
            }

            if !attachments.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(attachments) { attachment in
                            PendingAttachmentChip(attachment: attachment) {
                                guard !preparingAttachments, !sendingMessage else { return }
                                attachments.removeAll { $0.id == attachment.id }
                                attachmentError = nil
                            }
                        }
                    }
                    .padding(.horizontal, 2)
                }
                .scrollClipDisabled()
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }

            if let replyTarget {
                HStack {
                    VStack(alignment: .leading, spacing: 3) {
                        Label("Replying to " + (replyTarget.from?.name ?? (replyTarget.isFromAnotherPerson(selfID: roomSelfID) ? replyTarget.sender?.name : nil) ?? (replyTarget.role == .user ? "you" : current.name)), systemImage: "arrowshape.turn.up.left.fill")
                            .font(.caption.weight(.semibold))
                        Text(MessageRow.quotePreview(replyTarget)).font(.caption).lineLimit(2).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Button { withAnimation(.snappy(duration: 0.2)) { self.replyTarget = nil } } label: {
                        Image(systemName: "xmark.circle.fill").font(.system(size: 20)).foregroundStyle(.secondary)
                            .frame(width: 44, height: 44).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Cancel reply")
                }.padding(.leading, 10).background(Color.secondary.opacity(0.1), in: RoundedRectangle(cornerRadius: 10))
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }
            let pool = mentionPool
            if !sendingMessage, !pool.isEmpty {
                ChannelMentionDrawerHost(composer: composerDraft, pool: pool, working: workingMembers,
                                         picked: mentionPicks, inRoom: !current.isBot,
                                         maxListHeight: chatHeight > 0 ? chatHeight * 0.32 : nil,
                                         onToggle: toggleMention, onDone: closeMentionDrawer)
            }
            if !mentionPicks.isEmpty {
                ChannelMentionChips(picked: mentionPicks) { target in
                    Haptics.selection()
                    withAnimation(.snappy(duration: 0.22)) { mentionPicks.removeAll { $0.id == target.id } }
                }
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }

            // The bot's turn ended: one tap sends "continue" to pick it back up.
            if canContinue {
                HStack {
                    Button {
                        Haptics.selection()
                        submit(String(localized: "continue"))
                    } label: {
                        Label("Continue", systemImage: "arrow.forward.circle.fill")
                            .font(.system(size: 15, weight: .semibold)).foregroundStyle(Color.primary)
                            .padding(.horizontal, 14).frame(minHeight: 40)
                    }
                    .buttonStyle(.plain).glassCapsule()
                    .accessibilityLabel("Continue \(current.name)'s run")
                    .accessibilityIdentifier("chat-continue")
                    Spacer(minLength: 0)
                }
                .transition(.opacity)
            }

            // Work a call handed to this bot, still running.
            if current.busy, case let .bot(bot) = current, voiceCalls.call?.bot.id == bot.id,
               voiceCalls.call?.handedWork == true {
                VoiceWorkingRow(bot: bot)
                    .transition(.opacity)
            }

            if current.busy, !sendingMessage {
                SendPriorityToggle(priority: $sendPriority, color: MausPalette.color(current.color))
                    .transition(.opacity)
            }

            // The binding is made inside DraftBinding: making it here reads
            // the draft, which would redraw this view on every keystroke.
            DraftBinding(composer: composerDraft) { draft in
                ChatComposerBar(
                    draft: draft, showingPlus: $showingPlus, dictation: dictation,
                    focus: $composerFocused, name: current.name,
                    busy: preparingAttachments || sendingMessage,
                    hasAttachments: !attachments.isEmpty || !mentionPicks.isEmpty, supportsVoiceChat: true,
                    onDraftChange: { value in
#if DEBUG
                        MainThreadProbe.shared.typing(!value.isEmpty)
#endif
                        session.liveText.setComposing(!value.isEmpty, by: composerID)
                        let wantsHUD = value.hasPrefix("/")
                        if showCommandHUD != wantsHUD {
                            withAnimation(.easeInOut(duration: 0.15)) { showCommandHUD = wantsHUD }
                        }
                    },
                    onSend: { submit() },
                    onVoice: { startVoice() },
                    onStop: stopAction,
                    onLongVoice: { openWalkie() }
                )
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, 6)
        .padding(.bottom, 8)
        .frame(maxWidth: CompanionLayout.chatWidth)
        .frame(maxWidth: .infinity)
    }
}

extension ChatView {
    /// A message springs in when it landed while the chat was open, unless
    /// it is a reply that was just streamed: that one is already on screen.
    fileprivate func arrives(_ message: Message) -> Bool {
        guard arrivals.isArriving(message.id) else { return false }
        guard message.role != .user else { return true }
        if session.liveText.streamEndedRecently(threadId) { return false }
        if let botId = message.from?.botId,
           session.liveText.streamEndedRecently(RuntimeEvent.roomStreamKey(threadId: threadId, botId: botId)) { return false }
        return true
    }
}

/// A new bubble pops up from its own side: a small lift and scale with a
/// little overshoot, then it settles. Runs once, when the row is inserted.
#if DEBUG
extension ChatView {
    /// `-autopilot scroll|typing`: the UI test's gestures without the UI
    /// test. Sixteen long scrolls, or six sentences typed a key at a time.
    @MainActor fileprivate func runAutopilot(_ proxy: ScrollViewProxy) async {
        guard let scenario = Autopilot.scenario, scenario == "scroll" || scenario == "typing" else { return }
        try? await Task.sleep(for: .seconds(3))
        Autopilot.log("START \(scenario)")
        if scenario == "scroll" {
            for swipe in 0..<16 {
                let transcript = rows(memberSteps: memberSteps)
                // the test's pattern: down, down, up, up
                if swipe % 4 < 2, let first = transcript.first {
                    withAnimation(.easeOut(duration: 0.4)) { proxy.scrollTo(first.id, anchor: .top) }
                } else if let last = transcript.last {
                    withAnimation(.easeOut(duration: 0.4)) { proxy.scrollTo(last.id, anchor: .bottom) }
                }
                try? await Task.sleep(for: .milliseconds(700))
            }
        } else {
            composerFocused = true
            try? await Task.sleep(for: .seconds(1))
            for _ in 0..<6 {
                for character in "the quick brown fox jumps over the lazy dog " {
                    draft.append(character)
                    try? await Task.sleep(for: .milliseconds(40))
                }
            }
        }
        Autopilot.finish()
    }
}
#endif

private struct ArrivalSpring: ViewModifier {
    let active: Bool
    let fromTrailing: Bool
    let reduceMotion: Bool
    @State private var settled = false

    func body(content: Content) -> some View {
        let resting = !active || reduceMotion || settled
        // A bot's reply lands with more bounce than your own line: it comes
        // from further and overshoots, the face in the header nods with it.
        let bot = !fromTrailing
        content
            .scaleEffect(resting ? 1 : (bot ? 0.86 : 0.92), anchor: fromTrailing ? .bottomTrailing : .bottomLeading)
            .offset(y: resting ? 0 : (bot ? 12 : 6))
            .opacity(resting ? 1 : 0)
            .onAppear {
                guard active, !reduceMotion else { return }
                withAnimation(bot ? .spring(response: 0.42, dampingFraction: 0.6) : .spring(response: 0.3, dampingFraction: 0.72)) {
                    settled = true
                }
            }
    }
}

extension View {
    func arrivalSpring(_ active: Bool, fromTrailing: Bool, reduceMotion: Bool) -> some View {
        modifier(ArrivalSpring(active: active, fromTrailing: fromTrailing, reduceMotion: reduceMotion))
    }
}

@Observable
final class ComposerDraft {
    var onEdit: ((String) -> Void)?
    @ObservationIgnored var pendingCheckpoint: Task<Void, Never>?
    var text = "" {
        didSet {
            pendingCheckpoint?.cancel()
            guard let onEdit else { return }
            let captured = text
            pendingCheckpoint = Task { @MainActor in
                do { try await Task.sleep(for: .milliseconds(200)) } catch { return }
                onEdit(captured)
            }
        }
    }
}

/// Its content only while the draft is empty. Reading the draft here rather
/// than in ChatView keeps keystrokes from redrawing the transcript.
private struct EmptyDraftOnly<Content: View>: View {
    let composer: ComposerDraft
    @ViewBuilder let content: () -> Content
    var body: some View {
        if composer.text.isEmpty { content() }
    }
}

/// Hands its content a binding to the draft, made in this view's body so a
/// keystroke redraws only this.
private struct DraftBinding<Content: View>: View {
    @Bindable var composer: ComposerDraft
    @ViewBuilder let content: (Binding<String>) -> Content
    var body: some View { content($composer.text) }
}

/// The @ drawer, for the name being typed. Reading the draft here rather
/// than in ChatView keeps keystrokes from redrawing the transcript.
private struct ChannelMentionDrawerHost: View {
    let composer: ComposerDraft
    let pool: [MentionTarget]
    let working: Set<String>
    let picked: [MentionTarget]
    let inRoom: Bool
    let maxListHeight: CGFloat?
    let onToggle: (MentionTarget) -> Void
    let onDone: () -> Void

    private var matches: [MentionMatch]? {
        guard let query = ChannelTextPresentation.mentionQuery(composer.text) else { return nil }
        let matches = MentionRanking.rank(pool, query: query)
        return matches.isEmpty ? nil : matches
    }

    var body: some View {
        let matches = matches
        VStack(spacing: 0) {
            if let matches {
                ChannelMentionDrawer(matches: matches, working: working, picked: picked, inRoom: inRoom,
                                     maxListHeight: maxListHeight, onToggle: onToggle, onDone: onDone)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .animation(.snappy(duration: 0.22), value: matches?.map(\.id))
    }
}

/// The chat menu's done / unarchive entry for the open thread.
struct ThreadDoneAction {
    let title: LocalizedStringKey
    let systemImage: String
    let disabled: Bool
    let run: () -> Void
}

struct ChatHeaderBar<Avatar: View>: View {
    let name: String
    let unreadElsewhere: Int
    let canOpenThreads: Bool
    let canOpenSettings: Bool
    let onBack: () -> Void
    let onThreads: () -> Void
    let onSettings: () -> Void
    /// A second row that belongs to the header, under the same glass: the
    /// room roster. Drawn inside so the transcript scrolls beneath it.
    var accessory: AnyView? = nil
    /// A shared group's member count. Shown as a labelled button in the
    /// trailing slot so the people in the room aren't hidden behind the
    /// title; it opens the same details sheet.
    var membersCount: Int? = nil
    /// A side pane closes rather than goes back, and says so.
    var closesPane = false
    /// On a wide window, the menu that opens a second chat beside this one.
    var beside: AnyView? = nil
    /// One tap to a fresh thread with this chat, and one tap to a call.
    var onNewThread: (() -> Void)? = nil
    var onCall: (() -> Void)? = nil
    /// Mark the open thread done, or bring it back; bot threads only.
    var threadDone: ThreadDoneAction? = nil
    @ViewBuilder let avatar: () -> Avatar

    var body: some View {
        VStack(spacing: 6) {
        HStack(alignment: .top) {
            Button(action: onBack) {
                HStack(spacing: 4) {
                    Image(systemName: closesPane ? "xmark" : "chevron.left").font(.system(size: 17, weight: .semibold))
                    if unreadElsewhere > 0 {
                        Text("\(unreadElsewhere)").font(.system(size: 13, weight: .semibold))
                            .padding(.horizontal, 7).frame(minWidth: 22, minHeight: 22)
                            .background(Capsule().fill(Color.secondary.opacity(0.22)))
                    }
                }
                .foregroundStyle(Color.primary)
                .padding(.leading, 12).padding(.trailing, unreadElsewhere > 0 ? 8 : 12)
                .frame(height: 44).contentShape(Capsule())
            }
            .buttonStyle(.plain).glassCapsule().accessibilityLabel(closesPane ? "Close" : "Back")
            Spacer(minLength: 4)
            if !canOpenThreads && canOpenSettings {
                Button(action: onSettings) {
                    HStack(spacing: 8) {
                        avatar()
                        Text(name).font(.system(size: 17, weight: .semibold)).lineLimit(1)
                    }.padding(.horizontal, 12).frame(height: 44)
                }
                .buttonStyle(.plain).glassCapsule()
                .accessibilityLabel("\(name), conversation details")
                .accessibilityIdentifier("chat-options")
            } else {
            Menu {
                if canOpenThreads { Button("Threads", systemImage: "square.stack", action: onThreads) }
                if let threadDone {
                    Button(threadDone.title, systemImage: threadDone.systemImage, action: threadDone.run)
                        .disabled(threadDone.disabled)
                }
                if canOpenSettings { Button("Conversation settings", systemImage: "gearshape", action: onSettings) }
            } label: {
                HStack(spacing: 8) {
                    avatar()
                    Text(name).font(.system(size: 17, weight: .semibold)).lineLimit(1)
                }
                .padding(.horizontal, 12).frame(height: 44)
            }
            .buttonStyle(.plain).glassCapsule()
            .accessibilityLabel("\(name), threads and settings")
            .accessibilityIdentifier("chat-options")
            }
            Spacer(minLength: 4)
            if let beside { beside }
            if let onNewThread {
                GlassButton(systemImage: "square.and.pencil", size: 44, weight: .medium, action: onNewThread)
                    .accessibilityLabel("New thread with \(name)")
                    .accessibilityIdentifier("chat-new-thread")
            }
            if let onCall {
                GlassButton(systemImage: "phone.fill", size: 44, weight: .medium, action: onCall)
                    .accessibilityLabel("Call \(name)")
                    .accessibilityIdentifier("chat-call")
            }
            // The live computer view lives in the + menu ("Watch computer"),
            // not the header: Firaz found it a dead-end preview up here.
            if let membersCount {
                Button(action: onSettings) {
                    Label("\(membersCount)", systemImage: "person.2")
                        .font(.system(size: 15, weight: .semibold)).foregroundStyle(Color.primary)
                        .padding(.horizontal, 12).frame(minWidth: 44, minHeight: 44)
                }
                .buttonStyle(.plain).glassCapsule()
                .accessibilityLabel(membersCount == 1 ? "1 member" : "\(membersCount) members")
                .accessibilityIdentifier("chat-members")
            } else if onNewThread == nil, onCall == nil, beside == nil {
                // Balances the back button so the title stays centred.
                Color.clear.frame(width: 44, height: 44)
            }
        }
        .padding(.horizontal, 16).padding(.top, 4)
        if let accessory { accessory }
        }
        .padding(.bottom, 8)
        .frame(maxWidth: CompanionLayout.headerWidth).frame(maxWidth: .infinity)
        .background(
            Rectangle().fill(.ultraThinMaterial)
                .mask(VStack(spacing: 0) {
                    Color.black
                    LinearGradient(colors: [.black, .clear], startPoint: .top, endPoint: .bottom).frame(height: 20)
                })
                .padding(.bottom, -20).ignoresSafeArea(edges: .top).allowsHitTesting(false)
        )
    }
}

struct ChatActionSheet: View {
    struct Action: Identifiable {
        let id: String
        let systemImage: String
        let title: LocalizedStringKey
        let subtitle: LocalizedStringKey
        var destructive = false
        var disabled = false
        let run: () -> Void
    }

    @Binding var showing: Bool
    let actions: [Action]

    @ViewBuilder var body: some View {
        if showing {
            ZStack(alignment: .bottom) {
                Color.black.opacity(0.35).ignoresSafeArea()
                    .onTapGesture { withAnimation(.snappy(duration: 0.28)) { showing = false } }
                VStack(spacing: 0) {
                    ForEach(actions) { action in
                        Button {
                            withAnimation(.snappy(duration: 0.28)) { showing = false }
                            action.run()
                        } label: {
                            HStack(spacing: 16) {
                                Image(systemName: action.systemImage)
                                    .font(.system(size: 20, weight: .medium))
                                    .foregroundStyle(action.destructive ? Color.red : Color.primary)
                                    .frame(width: 44, height: 44)
                                    .background(Circle().fill(Color.primary.opacity(0.10)))
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(action.title).font(.system(size: 19, weight: .medium))
                                        .foregroundStyle(action.destructive ? Color.red : Color.primary)
                                    Text(action.subtitle).font(.system(size: 13)).foregroundStyle(Color.secondary)
                                }
                                Spacer(minLength: 0)
                            }
                            .padding(.horizontal, 18).frame(height: 64).contentShape(Rectangle())
                        }
                        .buttonStyle(.plain).disabled(action.disabled)
                        .opacity(action.disabled ? 0.45 : 1)
                    }
                }
                .padding(.vertical, 10)
                .frame(maxWidth: CompanionLayout.chatWidth, alignment: .leading)
                .glassSheet(cornerRadius: 30)
                .padding(.horizontal, 12).padding(.bottom, 70)
                .frame(maxWidth: .infinity)
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }.transition(.opacity)
        }
    }
}

/// Shown above the composer while a turn runs. Queue holds the message
/// until the turn settles; block stops the turn and sends this one now.
struct SendPriorityToggle: View {
    @Binding var priority: MessagePriority
    let color: Color

    var body: some View {
        HStack(spacing: 2) {
            option(.queue, "Queue", "tray.and.arrow.down")
            option(.block, "Block", "hand.raised")
        }
        .padding(3)
        .glassCapsule()
        .frame(maxWidth: .infinity, alignment: .trailing)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("While it's working")
    }

    private func option(_ value: MessagePriority, _ title: LocalizedStringKey, _ icon: String) -> some View {
        let selected = priority == value
        return Button {
            Haptics.selection()
            withAnimation(.snappy(duration: 0.2)) { priority = value }
        } label: {
            Label(title, systemImage: icon)
                .font(.caption.weight(.semibold))
                // ink on its opposite, not the bot's colour: a white or
                // pale bot (bos) painted white text on a white pill
                .foregroundStyle(selected ? Color(uiColor: .systemBackground) : Color.secondary)
                .padding(.horizontal, 10).padding(.vertical, 5)
                .background(Capsule().fill(selected ? Color.primary : Color.clear))
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityIdentifier("send-priority-\(value.rawValue)")
    }
}

struct ChatComposerBar: View {
    @Binding var draft: String
    @Binding var showingPlus: Bool
    @ObservedObject var dictation: SpeechDictation
    let focus: FocusState<Bool>.Binding
    let name: String
    let busy: Bool
    let hasAttachments: Bool
    let supportsVoiceChat: Bool
    let onDraftChange: (String) -> Void
    let onSend: () -> Void
    let onVoice: () -> Void
    /// The stop square left of the voice button, while the bot is working.
    var onStop: (() -> Void)? = nil
    /// Long-pressing the voice button: the walkie-talkie.
    var onLongVoice: (() -> Void)? = nil

    private var canSend: Bool {
        (!draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || hasAttachments) && !busy
    }

    var body: some View {
        GlassGroup(spacing: 10) {
            HStack(alignment: .bottom, spacing: 10) {
                Button {
                    dictation.stop()
                    focus.wrappedValue = false
                    withAnimation(.snappy(duration: 0.28)) { showingPlus.toggle() }
                } label: {
                    Image(systemName: "plus")
                        .font(.system(size: 20, weight: .medium))
                        .foregroundStyle(showingPlus ? Color(uiColor: .systemBackground) : Color.primary)
                        .rotationEffect(.degrees(showingPlus ? 45 : 0))
                        .frame(width: 44, height: 44)
                        .background(Circle().fill(showingPlus ? Color.primary : Color.clear))
                        .contentShape(Circle())
                }
                .buttonStyle(.plain).glassCapsule().disabled(busy)
                .accessibilityLabel(showingPlus ? "Close" : "More")

                HStack(alignment: .bottom, spacing: 6) {
                    TextField(busy ? "Sending…" : dictation.isListening ? "Listening…" : "Message \(name)…", text: $draft, axis: .vertical)
                        .lineLimit(1...5).font(.system(size: 17))
                        .padding(.vertical, 11).padding(.leading, 16)
                        .focused(focus)
                        .accessibilityIdentifier("message-input")
                        .allowsHitTesting(!dictation.isListening && !dictation.isStarting && !busy)
                        .onChange(of: draft) { _, value in onDraftChange(value) }
                        .onKeyPress(.return, phases: .down) { press in
                            if press.modifiers.contains(.shift) { return .ignored }
                            if canSend { onSend() }
                            return .handled
                        }
                    Button {
                        focus.wrappedValue = false
                        dictation.toggle(capturing: draft)
                    } label: {
                        Image(systemName: dictation.isListening ? "mic.fill" : "mic")
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(dictation.isListening ? Color.red : Color.primary)
                            .frame(width: 32, height: 32)
                            .background(Circle().fill(dictation.isListening ? Color.red.opacity(0.2) : Color.secondary.opacity(0.12)))
                            .symbolEffect(.pulse, isActive: dictation.isListening)
                    }
                    .buttonStyle(.plain).disabled(busy).padding(.bottom, 6)
                    .accessibilityLabel(dictation.isListening ? "Stop dictation" : "Start dictation")
                    if !canSend, let onStop {
                        Button(action: onStop) {
                            Image(systemName: "stop.fill")
                                .font(.system(size: 12, weight: .bold))
                                .foregroundStyle(Color.white)
                                .frame(width: 36, height: 36)
                                .background(RoundedRectangle(cornerRadius: 10, style: .continuous)
                                    .fill(Color(hex: "#2c2c2e")))
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Stop")
                        .padding(.bottom, 4)
                        .transition(.scale.combined(with: .opacity))
                    }
                    if !canSend, supportsVoiceChat {
                        // Grok's voice button: a solid circle with the
                        // waveform glyph. Tap calls; hold opens the walkie.
                        Image(systemName: "waveform")
                            .font(.system(size: 16, weight: .bold))
                            .foregroundStyle(Color(uiColor: .systemBackground))
                            .frame(width: 36, height: 36)
                            .background(Circle().fill(Color.primary))
                            .contentShape(Circle())
                            .opacity(busy ? 0.4 : 1)
                            .onTapGesture {
                                guard !busy else { return }
                                dictation.stop(); onVoice()
                            }
                            .onLongPressGesture(minimumDuration: 0.5) {
                                guard !busy, let onLongVoice else { return }
                                Haptics.impact(.medium)
                                dictation.stop(); onLongVoice()
                            }
                            .accessibilityElement()
                            .accessibilityAddTraits(.isButton)
                            .accessibilityLabel("Voice call")
                            .accessibilityAction { if !busy { dictation.stop(); onVoice() } }
                            .accessibilityAction(named: "Walkie-talkie") { if !busy { dictation.stop(); onLongVoice?() } }
                            .padding(.trailing, 4).padding(.bottom, 4)
                    } else {
                        Button {
                            if canSend { onSend() }
                        } label: {
                            Image(systemName: "arrow.up")
                                .font(.system(size: 15, weight: .bold))
                                .foregroundStyle(canSend ? Color.white : Color.secondary)
                                .frame(width: 32, height: 32)
                                .background(Circle().fill(canSend ? BubbleColor.mine : Color.secondary.opacity(0.18)))
                        }
                        .buttonStyle(.plain).disabled(busy || !canSend)
                        .accessibilityLabel("Send message")
                        .padding(.trailing, 6).padding(.bottom, 6)
                    }
                }
                .frame(minHeight: 44).glassSheet(cornerRadius: 22)
            }
        }
    }
}

struct MessageRow: View {
    let chat: Chat
    let message: Message
    /// The person this phone speaks as; set in rooms that have people.
    var selfID: String? = nil
    /// Last bubble of a run from the same side: the one that gets the tail.
    var endsRun = true
    let openLink: (URL, Message) -> OpenURLAction.Result
    /// Where an "Opened thread" chip goes; nil leaves the chip a receipt.
    var openThread: ((ThreadRef) -> Void)? = nil
    var onReply: ((Message) -> Void)? = nil
    var replyTarget: Message? = nil
    /// Every version of this message when it was edited and retried, in
    /// order; empty when there is only the one.
    var versions: [Message] = []
    @Environment(\.sessionActions) private var sessionActions
    private var session: Session { sessionActions! }
    @State private var editingText = ""
    @State private var showingEdit = false
    /// The text being selected, and the sheet's presentation in one value.
    @State private var selecting: SelectableText?

    private static let reactionChoices = ["👍", "❤️", "😂", "🎉", "👀"]

    /// The bot whose face pops beside the menu when this is its own text.
    private var faceBot: Bot? {
        guard message.role == .bot, message.kind == .text else { return nil }
        if let id = message.from?.botId, let bot = session.state.bot(id) { return bot }
        if case let .bot(bot) = chat { return bot }
        return nil
    }

    /// Transport tags contain paths on the paired computer. They belong in
    /// attachment cards, never on the clipboard or in the text-selection UI.
    private var attachedContent: AttachedMessageContent {
        AttachedMessageContent.parse(message.text ?? "")
    }

    var body: some View {
        VStack(alignment: message.role == .user && !message.isFromAnotherPerson(selfID: selfID) ? .trailing : .leading, spacing: 6) {
            if let reference = message.replyToId {
                VStack(alignment: .leading, spacing: 3) {
                    Text("Replying to " + (replyTarget?.from?.name ?? (replyTarget?.isFromAnotherPerson(selfID: selfID) == true ? replyTarget?.sender?.name : nil) ?? (replyTarget?.role == .user ? "you" : "an earlier message"))).font(.caption.weight(.semibold))
                    Text(replyTarget.map { Self.quotePreview($0) } ?? String(localized: "Earlier message")).font(.caption).lineLimit(2)
                }.foregroundStyle(.secondary).padding(8)
                .overlay(alignment: .leading) {
                    RoundedRectangle(cornerRadius: 1.5).fill(Color.secondary.opacity(0.45)).frame(width: 3).padding(.vertical, 6)
                }
                .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
                .accessibilityElement(children: .combine)
                    .accessibilityIdentifier("reply-quote-" + reference)
            }
            content
            if let action = message.leadAction {
                Label(action.status.capitalized, systemImage: action.status == "resolved" ? "checkmark.circle" : "exclamationmark.circle")
                    .font(.caption.weight(.medium))
                    .foregroundStyle(action.status == "resolved" ? Color.secondary : Color.orange)
                    .accessibilityLabel("Lead action " + action.status + ": " + action.requiredAction)
            }

            if let comm = message.comm {
                // the chip already says what happened ("Posted in Standup");
                // a linked chip is not always a message sent to someone
                Label(message.tool?.name ?? "Messaged \(comm.withName)", systemImage: "arrow.up.right.bubble")
                    .font(.system(size: 12))
                    .foregroundStyle(Color.secondary)
            }

            if let reactions = message.reactions, !reactions.isEmpty {
                HStack(spacing: 6) {
                    ForEach(reactionGroups(reactions), id: \.emoji) { group in
                        Button("\(group.emoji) \(group.count)") {
                            Haptics.selection()
                            Task { await session.react(to: message, in: chat.threadId, emoji: group.emoji) }
                        }
                        .font(.system(size: 13))
                        .buttonStyle(.bordered)
                        .buttonBorderShape(.capsule)
                        .tint(group.mine ? Color.accentColor : Color.secondary)
                    }
                }
            }

            if versions.count > 1, let index = versions.firstIndex(where: { $0.id == message.id }),
               case let .bot(bot) = chat {
                HStack(spacing: 8) {
                    Button {
                        Task { await session.switchVersion(to: versions[index - 1], for: bot) }
                    } label: { Image(systemName: "chevron.left") }
                    .disabled(index == 0 || bot.busy == true)
                    Text("\(index + 1) of \(versions.count)")
                    Button {
                        Task { await session.switchVersion(to: versions[index + 1], for: bot) }
                    } label: { Image(systemName: "chevron.right") }
                    .disabled(index + 1 >= versions.count || bot.busy == true)
                }
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(Color.secondary)
            }
        }
        .botFaceContextMenu(bot: faceBot, text: attachedContent.text) {
            // When it was said: the transcript only marks gaps, so this is
            // where an exact time lives.
            if message.at > 0 {
                Text(Date(timeIntervalSince1970: message.at / 1000).formatted(date: .abbreviated, time: .shortened))
            }
            if message.kind == .text, !(message.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, let onReply {
                Button("Reply", systemImage: "arrowshape.turn.up.left") { onReply(message) }
            }
            ForEach(Self.reactionChoices, id: \.self) { emoji in
                Button(emoji) {
                    Haptics.selection()
                    Task { await session.react(to: message, in: chat.threadId, emoji: emoji) }
                }
            }
            let visibleText = attachedContent.text
            if !visibleText.isEmpty {
                Divider()
                Button("Copy", systemImage: "doc.on.doc") {
                    PlatformBridge.copyToPasteboard(visibleText)
                    Haptics.success()
                }
            }
            // Copy above takes the whole reply. Selection happens in a sheet
            // because long-press on the bubble already opens this menu.
            if !visibleText.isEmpty {
                Button("Select Text", systemImage: "selection.pin.in.out") {
                    selecting = SelectableText(text: visibleText)
                }
            }
            // An attachment edit cannot faithfully reconstruct the upload.
            // Hiding this action is safer than silently dropping the file or
            // sending its computer-local transport path back as prose.
            if message.role == .user,
               message.kind == .text,
               attachedContent.attachments.isEmpty,
               case let .bot(bot) = chat {
                Divider()
                Button("Edit and retry", systemImage: "pencil") {
                    editingText = message.text ?? ""
                    showingEdit = true
                }
                .disabled(bot.busy == true)
            }
        }
        .alert("Edit and retry", isPresented: $showingEdit) {
            TextField("Message", text: $editingText)
            Button("Cancel", role: .cancel) {}
            if case let .bot(bot) = chat {
                Button("Send") {
                    let text = editingText.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !text.isEmpty else { return }
                    Task { await session.edit(message, for: bot, text: text) }
                }
            }
        } message: {
            Text("This creates a new version and continues from there.")
        }
        .sheet(item: $selecting) { SelectableTextSheet(text: $0.text) }
    }

    @ViewBuilder
    private var content: some View {
        switch message.kind {
        case .text:
            TextBubble(message: message, chat: chat, selfID: selfID, tailed: endsRun, openLink: openLink)
        case .options:
            // A structured ask draws its own card: its answers are the
            // model's questions, not an allow/deny a tap could stand for.
            if message.card?.questions.isEmpty == false {
                QuestionCardView(chat: chat, message: message)
            } else {
                CardView(chat: chat, message: message)
            }
        case .secret:
            if let secret = message.secret, let home = chat.remoteHomeName {
                // Secrets are sealed for the Mac that owns the bot; this
                // phone is paired to a different one.
                RemoteOnlyNoteCard(title: secret.label ?? "API credential", home: home, pending: secret.isPending, tint: MausPalette.color(message.from?.color ?? chat.color))
            } else if let secret = message.secret {
                CredentialRequestCardView(chat: chat, message: message, secret: secret)
            } else if let text = message.text, !text.isEmpty {
                TextBubble(message: message, chat: chat, selfID: selfID, tailed: endsRun, openLink: openLink)
            }
        case .activity:
            ActivityChip(message: message, threadRef: message.threadRef, openThread: openThread)
        case .screen:
            ScreenShot(threadId: chat.threadId, message: message)
        case .digest:
            EmptyView()
        case .unknown:
            // A message kind from a newer computer. Almost everything the
            // harness sends carries `text`, so showing it is usually the
            // whole message and always better than a gap in the transcript.
            // When there is nothing to show, show nothing — a placeholder
            // saying "unsupported" is a worse gap than the gap.
            if let text = message.text, !text.isEmpty {
                TextBubble(message: message, chat: chat, selfID: selfID, tailed: endsRun, openLink: openLink)
            }
        }
    }

    /// A quoted message as one readable line: attachment transport tags
    /// (paths on the computer) dropped, a file-only message named as such.
    static func quotePreview(_ message: Message) -> String {
        let content = AttachedMessageContent.parse(message.text ?? "")
        let text = content.text.split(whereSeparator: \.isNewline).joined(separator: " ")
        if !text.isEmpty { return text }
        return content.attachments.isEmpty ? String(localized: "Earlier message") : String(localized: "Attachment")
    }

    private func reactionGroups(_ reactions: [Reaction]) -> [(emoji: String, count: Int, mine: Bool)] {
        Dictionary(grouping: reactions, by: \.emoji)
            .map { (emoji: $0.key, count: $0.value.count, mine: $0.value.contains { $0.by == "user" }) }
            .sorted { $0.emoji < $1.emoji }
    }
}

extension MessageRow: Equatable {
    /// Only what the row draws. The closures are rebuilt on every ChatView
    /// render and do the same thing each time, so they are not compared;
    /// without this every row redrew whenever anything in the app changed.
    static func == (lhs: MessageRow, rhs: MessageRow) -> Bool {
        lhs.message == rhs.message && lhs.endsRun == rhs.endsRun && lhs.selfID == rhs.selfID
            && lhs.replyTarget == rhs.replyTarget && lhs.versions == rhs.versions
            && (lhs.openThread == nil) == (rhs.openThread == nil)
            && (lhs.onReply == nil) == (rhs.onReply == nil)
            && lhs.chat.threadId == rhs.chat.threadId && lhs.chat.name == rhs.chat.name
            && lhs.chat.color == rhs.chat.color && lhs.chat.isRemoteBot == rhs.chat.isRemoteBot
            && lhs.chat.remoteHomeName == rhs.chat.remoteHomeName
            && lhs.chat.botBusy == rhs.chat.botBusy
    }
}

private extension Chat {
    var botBusy: Bool {
        if case let .bot(bot) = self { return bot.busy == true }
        return false
    }
}

extension ChatView {
    /// User text messages grouped by the message they branch from, keeping
    /// only groups with more than one version. Same order as
    /// `CompanionState.versions(of:inThread:)`.
    static func versionsByParent(_ transcript: [Message]) -> [String?: [Message]] {
        Dictionary(grouping: transcript.filter { $0.role == .user && $0.kind == .text }, by: \.parentId)
            .filter { $0.value.count > 1 }
            .mapValues { $0.sorted { $0.at == $1.at ? $0.id < $1.id : $0.at < $1.at } }
    }

    static func versions(of message: Message, in versions: [String?: [Message]]) -> [Message] {
        guard message.role == .user, message.kind == .text else { return [] }
        return versions[message.parentId] ?? []
    }
}

private struct ShareFile: Identifiable {
    let url: URL
    var id: String { url.path }
}

/// A message's text on its way to the selection sheet.
struct SelectableText: Identifiable {
    let id = UUID()
    let text: String
}

private struct ActivityShareSheet: UIViewControllerRepresentable {
    let items: [Any]

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }

    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}

struct TextBubble: View {
    let message: Message
    let chat: Chat
    var selfID: String? = nil
    var tailed = true
    let openLink: (URL, Message) -> OpenURLAction.Result
    @Environment(\.mentionContext) private var mentions
    @ScaledMetric(relativeTo: .body) private var bodySize: CGFloat = 18

    /// What you typed, as typed, with the names you tagged drawn as tokens.
    static func styledMine(_ text: String, mentions: MentionContext, mine: Bool = true) -> AttributedString {
        var out = AttributedString(text)
        out.styleMentions(mentions, mine: mine)
        return out
    }

    private var attachedContent: AttachedMessageContent {
        AttachedMessageContent.parse(message.text ?? "")
    }

    private var parsedDiff: (filename: String, diff: String)? {
        guard message.role != .user, let source = message.text else { return nil }
        let text = source.trimmingCharacters(in: .whitespacesAndNewlines)
        let diff: String
        if text.hasPrefix("```diff"), text.hasSuffix("```") {
            diff = String(text.dropFirst("```diff".count).dropLast(3))
                .trimmingCharacters(in: .whitespacesAndNewlines)
        } else if text.hasPrefix("diff --git ") {
            diff = text
        } else {
            return nil
        }
        let firstLine = diff.split(separator: "\n", maxSplits: 1).first.map(String.init) ?? ""
        let filename = firstLine.split(separator: " ").last.map(String.init)?
            .replacingOccurrences(of: "b/", with: "") ?? "Git patch"
        return (filename, diff)
    }

    private var parsedTable: (headers: [String], rows: [[String]])? {
        guard message.role != .user, let source = message.text else { return nil }
        let lines = source.components(separatedBy: .newlines)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        guard lines.count >= 3, lines.allSatisfy({ $0.hasPrefix("|") && $0.hasSuffix("|") }) else {
            return nil
        }
        let headers = Self.tableCells(lines[0])
        let separators = Self.tableCells(lines[1])
        guard !headers.isEmpty, separators.count == headers.count,
              separators.allSatisfy(Self.isTableSeparator) else { return nil }
        let rows = lines.dropFirst(2).map(Self.tableCells)
        guard rows.allSatisfy({ $0.count == headers.count }) else { return nil }
        return (headers, rows)
    }

    private static func tableCells(_ line: String) -> [String] {
        var body = line
        if body.first == "|" { body.removeFirst() }
        if body.last == "|" { body.removeLast() }

        var cells: [String] = []
        var cell = ""
        var escaped = false
        for character in body {
            if escaped {
                if character == "|" {
                    cell.append(character)
                } else {
                    cell.append("\\")
                    cell.append(character)
                }
                escaped = false
            } else if character == "\\" {
                escaped = true
            } else if character == "|" {
                cells.append(cell.trimmingCharacters(in: .whitespaces))
                cell = ""
            } else {
                cell.append(character)
            }
        }
        if escaped { cell.append("\\") }
        cells.append(cell.trimmingCharacters(in: .whitespaces))
        return cells
    }

    private static func isTableSeparator(_ cell: String) -> Bool {
        let compact = cell.replacingOccurrences(of: " ", with: "")
        let core = compact.trimmingCharacters(in: CharacterSet(charactersIn: ":"))
        return core.count >= 3 && core.allSatisfy { $0 == "-" }
    }


    /// The room person who wrote this line, as the room lists them.
    private var roomPerson: RoomPerson? {
        guard case let .room(room) = chat, let id = message.sender?.id else { return nil }
        return room.people?.first { $0.id == id }
    }

    var body: some View {
        // A person's line is plain text whoever wrote it; only yours sits on
        // the trailing side.
        let fromPerson = message.role == .user
        let mine = fromPerson && !message.isFromAnotherPerson(selfID: selfID)
        let customCard = parsedDiff != nil || parsedTable != nil
        // rooms attribute each line to the member who said it
        let speaker = message.from
        // No bot face beside the bubble: the bot's face is in the header, and
        // in a room the name line says who spoke. Another person's lines get
        // their face at the end of each run, as on the desktop.
        let otherPerson = fromPerson && !mine ? roomPerson : nil
        HStack(alignment: .bottom, spacing: 0) {
            if mine { Spacer(minLength: 56) }
            if let otherPerson {
                Group {
                    if tailed { PersonFaceView(name: otherPerson.name, avatar: otherPerson.avatar, size: 26) }
                    else { Color.clear }
                }
                .frame(width: 26, height: 26)
                .padding(.trailing, 6)
                .accessibilityHidden(true)
            }

            VStack(alignment: .leading, spacing: 4) {
                if let speaker, !mine, !chat.isBot {
                    Text(speaker.name)
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(MausPalette.color(speaker.color))
                } else if fromPerson, !mine, let person = message.sender {
                    Text(person.name)
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier("room-sender-" + message.id)
                }
                ForEach(message.generatedImages, id: \.path) { attachment in
                    TranscriptAttachmentView(
                        attachment: attachment, threadId: chat.threadId,
                        messageId: message.id, foreground: mine ? BubbleColor.mineText : .primary
                    )
                }
                // Bots get markdown, you do not — the same split the desktop
                // makes. Markdown you did not intend is worse than markdown
                // you did: a message about `**` should show the asterisks.
                if let diff = parsedDiff {
                    GitPRDiffCardView(filename: diff.filename, diffText: diff.diff)
                } else if let table = parsedTable {
                    SQLResultTableView(columns: table.headers, rows: table.rows)
                } else if fromPerson {
                    let shared = attachedContent
                    ForEach(Array(shared.attachments.enumerated()), id: \.offset) { _, attachment in
                        TranscriptAttachmentView(
                            attachment: attachment,
                            threadId: chat.threadId,
                            messageId: message.id
                        )
                    }
                    if !shared.text.isEmpty {
                        Text(Self.styledMine(shared.text, mentions: mentions, mine: mine))
                            .font(.system(size: bodySize))
                            .foregroundStyle(mine ? BubbleColor.mineText : Color.primary)
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                } else {
                    if ChannelTextPresentation.canCollapse(message) {
                        ExpandableBotReply(source: message.text ?? "") { openLink($0, message) }
                    } else {
                        MarkdownText(source: message.text ?? "") { openLink($0, message) }
                            .foregroundStyle(Color.primary).textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            .padding(.horizontal, customCard ? 0 : 15)
            .padding(.vertical, customCard ? 0 : 11)
            .background(
                Group {
                    if !customCard {
                        RoundedRectangle(cornerRadius: 22)
                            .fill(mine ? BubbleColor.mine : BubbleColor.theirs)
                    }
                }
            )
            // leave room for the tail below, so the next row does not sit on it
            .padding(.bottom, 0)

            if !mine { Spacer(minLength: 44) }
        }
    }
}

/// A tool the bot ran. Deliberately quiet — these are the bulk of a busy
/// transcript and they are context, not content.
/// One step on its own — a chip the fold left alone, or a failure, which
/// never folds. Same row as the steps inside a run's sheet, so a reader
/// learns one shape.
struct ActivityChip: View {
    let message: Message
    /// The thread this chip opened, when it opened one.
    var threadRef: ThreadRef? = nil
    var openThread: ((ThreadRef) -> Void)? = nil

    var body: some View {
        if message.tool != nil {
            VStack(alignment: .leading, spacing: 6) {
                ToolStepRow(step: toolStep(from: message), threadRef: threadRef, openThread: openThread)
                if let recovery = message.tool?.recovery, recovery.isOpen {
                    ResumeTurnButton(recovery: recovery)
                }
            }
            .padding(.leading, 2)
        }
    }
}

/// Runs a turn a host restart cut off. The harness never replays it on its
/// own, so this is the owner saying "go on".
struct ResumeTurnButton: View {
    let recovery: TurnRecovery
    @EnvironmentObject private var session: Session
    @State private var resuming = false

    var body: some View {
        Button {
            Haptics.selection()
            resuming = true
            Task {
                await session.resume(recovery)
                resuming = false
            }
        } label: {
            Label(resuming ? "Resuming…" : "Resume", systemImage: "arrow.clockwise")
                .font(.system(size: 14, weight: .semibold))
        }
        .buttonStyle(.bordered)
        .controlSize(.small)
        .disabled(resuming)
    }
}

/// Stands in for an owner-only flow (secret entry, connector setup) on a bot
/// that lives on another linked Mac: the server refuses those from here, so
/// the phone says where to finish it instead of offering a dead form.
struct RemoteOnlyNoteCard: View {
    let title: String
    let home: String
    let pending: Bool
    let tint: Color

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: pending ? "lock.shield" : "checkmark.shield")
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(tint)
            VStack(alignment: .leading, spacing: 3) {
                Text(title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "API credential" : title)
                    .font(.system(size: 15, weight: .semibold))
                Text(pending ? "Finish this on \(home)." : "Handled on \(home).")
                    .font(.system(size: 13))
                    .foregroundStyle(Color.secondary)
            }
            Spacer(minLength: 0)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.secondary.opacity(0.1), in: RoundedRectangle(cornerRadius: 16))
        .accessibilityElement(children: .combine)
    }
}

/// A credential entered here is encrypted for the exact computer whose
/// public key was pinned by the pairing QR. Password AutoFill remains
/// provider-neutral: Apple Passwords works without another subscription,
/// while 1Password, Bitwarden and other enabled providers work as usual.
struct CredentialRequestCardView: View {
    let chat: Chat
    let message: Message
    let secret: SecretRequestCardData
    @EnvironmentObject private var session: Session
    @Environment(\.scenePhase) private var scenePhase
    @State private var value = ""
    @State private var fieldID = UUID()
    @State private var preparedSubmission: PreparedPhoneCredential?
    @State private var submissionTask: Task<Void, Never>?
    @State private var activeSubmissionID: UUID?
    @State private var submitting = false
    @State private var submitted = false
    @State private var submissionError: String?

    private struct RequestIdentity: Equatable {
        let connectionID: String?
        let botID: String?
        let threadID: String
        let messageID: String
        let target: String?
        let requestKey: String?
    }

    private var tint: Color { MausPalette.color(message.from?.color ?? chat.color) }
    private var requester: String { message.from?.name ?? chat.name }
    private var label: String { visible(secret.label) ?? "API credential" }
    private var accessibilityStatus: Text {
        if secret.provided == true {
            return secret.resumed == true
            ? Text("Saved securely. The task resumed.")
            : Text("Saved securely on your computer.")
        }
        if secret.dismissed == true { return Text("Not provided.") }
        if submitted { return Text("Encrypted and sent to your computer.") }
        if canEnterOnPhone { return Text("Enter it securely on this phone.") }
        if !hasSecurePairing { return Text("Pair again by QR code, or finish on your computer.") }
        return Text("Use secure phone access or Tailscale, or finish on your computer.")
    }

    private func visible(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }

    private var helpURL: URL? {
        guard let raw = secret.helpUrl,
              let url = URL(string: raw),
              url.scheme?.lowercased() == "https",
              url.host != nil,
              url.user == nil,
              url.password == nil
        else { return nil }
        return url
    }

    private var hasSecurePairing: Bool {
        guard secret.isPending,
              visible(secret.target) != nil,
              visible(secret.requestKey) != nil,
              let connection = session.connection
        else { return false }
        return connection.secretPublicKey != nil && connection.companionDeviceId != nil
    }

    private var hasProtectedTransport: Bool {
        session.phoneCredentialTransportIsProtected
    }

    private var canEnterOnPhone: Bool { hasSecurePairing && hasProtectedTransport }

    private var placeholder: String { visible(secret.placeholder) ?? label }

    private var canSubmit: Bool {
        guard canEnterOnPhone, !submitting, !submitted else { return false }
        return preparedSubmission != nil
            || !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var requestIdentity: RequestIdentity {
        let botID: String?
        switch chat {
        case let .bot(bot): botID = bot.id
        case .room: botID = message.from?.botId
        }
        return RequestIdentity(
            connectionID: session.connection?.id,
            botID: botID,
            threadID: chat.threadId,
            messageID: message.id,
            target: secret.target,
            requestKey: secret.requestKey
        )
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 11) {
                Image(systemName: "key.fill")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(tint)
                    .frame(width: 38, height: 38)
                    .background(tint.opacity(0.13), in: RoundedRectangle(cornerRadius: 11, style: .continuous))

                VStack(alignment: .leading, spacing: 3) {
                    Text(label)
                        .font(.system(size: 16, weight: .semibold))
                    Text("Requested by \(requester)")
                        .font(.system(size: 12.5))
                        .foregroundStyle(Color.secondary)
                }
                Spacer(minLength: 0)
            }

            if let description = visible(secret.description) {
                Text(description)
                    .font(.system(size: 14.5))
                    .foregroundStyle(Color.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if secret.provided == true {
                VStack(alignment: .leading, spacing: 8) {
                    Label(
                        secret.resumed == true ? "Saved securely. The task resumed." : "Saved securely on your computer.",
                        systemImage: "checkmark.shield.fill"
                    )
                    .foregroundStyle(.green)

                    if secret.resumed != true, let preparedSubmission {
                        Button(action: { send(preparedSubmission) }) {
                            HStack(spacing: 7) {
                                if submitting { ProgressView() }
                                Image(systemName: "arrow.clockwise")
                                Text(submitting ? "Resuming…" : "Try resuming the task")
                            }
                            .font(.system(size: 13, weight: .semibold))
                        }
                        .disabled(submitting || !hasProtectedTransport)
                    }
                }
            } else if secret.dismissed == true {
                Label("Not provided", systemImage: "xmark.circle")
                    .foregroundStyle(Color.secondary)
            } else if submitted {
                Label("Encrypted and saved on your computer", systemImage: "checkmark.shield.fill")
                    .foregroundStyle(.green)
            } else if canEnterOnPhone {
                VStack(alignment: .leading, spacing: 5) {
                    Label("Enter securely on this phone", systemImage: "lock.shield.fill")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(tint)

                    if preparedSubmission == nil {
                        SecureField(placeholder, text: $value)
                            .id(fieldID)
                            .textContentType(.password)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .privacySensitive()
                            .disabled(submitting)
                            .submitLabel(.done)
                            .onSubmit { submit() }
                            .padding(.horizontal, 12)
                            .frame(minHeight: 44)
                            .background(
                                Color.secondary.opacity(0.1),
                                in: RoundedRectangle(cornerRadius: 11, style: .continuous)
                            )
                            .accessibilityLabel(label)
                    } else {
                        Label(
                            submitting ? "Encrypted and saving…" : "Encrypted and ready to retry",
                            systemImage: "lock.fill"
                        )
                        .font(.system(size: 13))
                        .foregroundStyle(Color.secondary)
                        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                        .padding(.horizontal, 12)
                        .background(
                            Color.secondary.opacity(0.1),
                            in: RoundedRectangle(cornerRadius: 11, style: .continuous)
                        )
                    }

                    Button(action: submit) {
                        HStack(spacing: 7) {
                            if submitting { ProgressView().tint(.white) }
                            Image(systemName: "lock.fill")
                            Text(
                                submitting
                                    ? "Saving securely…"
                                    : preparedSubmission == nil ? "Save securely" : "Try again securely"
                            )
                        }
                        .font(.system(size: 14, weight: .semibold))
                        .frame(maxWidth: .infinity, minHeight: 42)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(tint)
                    .disabled(!canSubmit)

                    if preparedSubmission != nil, !submitting, submissionError != nil {
                        Button("Enter a different value") {
                            discardPreparedSubmission()
                        }
                        .font(.system(size: 13, weight: .medium))
                    }

                    Text("Use Apple Passwords, 1Password, Bitwarden, or paste. The value is encrypted for your computer and never added to chat.")
                        .font(.system(size: 13))
                        .foregroundStyle(Color.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(11)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(tint.opacity(0.08), in: RoundedRectangle(cornerRadius: 13, style: .continuous))
            } else if !hasSecurePairing {
                VStack(alignment: .leading, spacing: 5) {
                    Label("Pair again to enter here", systemImage: "qrcode")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(tint)
                    Text("This pairing predates secure phone entry. Scan a fresh QR from BOS, or finish this request on your computer.")
                        .font(.system(size: 13))
                        .foregroundStyle(Color.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(11)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(tint.opacity(0.08), in: RoundedRectangle(cornerRadius: 13, style: .continuous))
            } else {
                VStack(alignment: .leading, spacing: 5) {
                    Label("Secure connection required", systemImage: "lock.shield.fill")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(tint)
                    Text("Switch to Secure phone access (HTTPS) or Tailscale, then try again. You can still finish this request on your computer.")
                        .font(.system(size: 13))
                        .foregroundStyle(Color.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(11)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(tint.opacity(0.08), in: RoundedRectangle(cornerRadius: 13, style: .continuous))
            }

            if let submissionError = visible(submissionError) {
                Label(submissionError, systemImage: "exclamationmark.triangle.fill")
                    .font(.system(size: 12.5))
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if let error = visible(secret.error) {
                Label(error, systemImage: "exclamationmark.triangle.fill")
                    .font(.system(size: 12.5))
                    .foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if let helpURL {
                Link(destination: helpURL) {
                    Label("Where to get this key", systemImage: "arrow.up.right")
                        .font(.system(size: 13, weight: .medium))
                }
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .fill(Color.secondary.opacity(0.09))
        )
        .overlay {
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .strokeBorder(secret.isPending ? tint.opacity(0.65) : Color.clear, lineWidth: 1.25)
        }
        .accessibilityElement(children: canEnterOnPhone ? .contain : .combine)
        .accessibilityLabel("\(label). \(accessibilityStatus)")
        .onAppear {
            preparedSubmission = session.preparedCredential(
                chat: chat,
                message: message,
                secret: secret
            )
        }
        .onChange(of: requestIdentity) { _, _ in
            resetSensitiveState(clearPrepared: true)
            preparedSubmission = session.preparedCredential(
                chat: chat,
                message: message,
                secret: secret
            )
            submitted = false
        }
        .onChange(of: session.credentialEntryResetGeneration) { _, _ in
            suspendSensitiveEntry()
        }
        .onChange(of: session.status) { _, status in
            if status != .live { suspendSensitiveEntry() }
        }
        .onChange(of: scenePhase) { _, phase in
            // Password AutoFill and its Face ID sheet temporarily make the
            // scene inactive. Removing the SecureField at that point breaks
            // the very fill operation the user requested. A true background
            // transition (including locking the phone) still scrubs it.
            if phase == .background { suspendSensitiveEntry() }
        }
        .onDisappear {
            // The async request owns only ciphertext and is safe to finish.
            // Its envelope stays in Session so returning to this card can
            // retry the exact same operation after an ambiguous response.
            clearPlaintext()
            submissionError = nil
        }
    }

    private func submit() {
        guard canSubmit else { return }
        submissionError = nil
        if let preparedSubmission {
            send(preparedSubmission)
            return
        }

        do {
            // Encryption happens synchronously. No task closure ever captures
            // the cleartext, and the native field is replaced immediately.
            let prepared = try session.prepareCredential(
                value,
                chat: chat,
                message: message,
                secret: secret
            )
            clearPlaintext()
            preparedSubmission = prepared
            send(prepared)
        } catch {
            clearPlaintext()
            submissionError = error.localizedDescription
            Haptics.notification(.error)
        }
    }

    private func send(_ prepared: PreparedPhoneCredential) {
        submissionTask?.cancel()
        let submissionID = UUID()
        activeSubmissionID = submissionID
        submissionError = nil
        submitting = true

        submissionTask = Task { @MainActor in
            do {
                try await session.provideCredential(prepared)
                guard !Task.isCancelled, activeSubmissionID == submissionID else { return }
                submitted = true
                Haptics.success()
            } catch {
                guard !Task.isCancelled, activeSubmissionID == submissionID else { return }
                // Keep only the exact ciphertext so Retry is the same
                // idempotent operation. The cleartext field is already gone.
                submissionError = error.localizedDescription
                Haptics.notification(.error)
            }

            guard activeSubmissionID == submissionID else { return }
            activeSubmissionID = nil
            submissionTask = nil
            submitting = false
        }
    }

    private func clearPlaintext() {
        value.removeAll(keepingCapacity: false)
        // Replacing the SecureField also clears UIKit's backing control,
        // including text inserted by Password AutoFill.
        fieldID = UUID()
    }

    private func suspendSensitiveEntry() {
        clearPlaintext()
        activeSubmissionID = nil
        submissionTask?.cancel()
        submissionTask = nil
        submitting = false
        submissionError = nil
        // Keep an already-encrypted envelope. If the request reached the
        // computer before iOS suspended it, foreground Retry must send the
        // exact same operation instead of generating fresh HPKE randomness.
    }

    private func resetSensitiveState(clearPrepared: Bool) {
        suspendSensitiveEntry()
        if clearPrepared, let preparedSubmission {
            session.discardPreparedCredential(preparedSubmission)
            self.preparedSubmission = nil
        }
    }

    private func discardPreparedSubmission() {
        resetSensitiveState(clearPrepared: true)
        submitted = false
    }

}

/// An option card. When it still has a request behind it, this is the
/// screen the companion exists for — a bot stopped, and only a person can
/// let it continue.
struct CardView: View {
    let chat: Chat
    let message: Message
    @Environment(\.sessionActions) private var sessionActions
    private var session: Session { sessionActions! }
    @State private var answering = false

    /// The option this card offers that means "go ahead".
    ///
    /// Deliberately not the literal string "Allow". `options` is whatever the
    /// harness sent, and it only falls back to ["Allow", "Deny"] when the
    /// provider event named no choices of its own (`server/index.ts`) — a card
    /// is free to say "Yes", "Approve", "Allow once". Answering with a string
    /// the card never offered writes the grant and then hands the harness a
    /// choice it can reject, so the bot stays stopped with nothing on screen
    /// to explain it. The conventional label wins when it is present, which
    /// keeps the ordinary permission card behaving exactly as before.
    private var allowChoice: String? {
        guard let options = message.card?.options else { return nil }
        return options.first { $0.caseInsensitiveCompare("Allow") == .orderedSame }
            ?? options.first { !Self.isRefusal($0) }
    }

    /// One definition of "the refusal", shared by the button tint and the
    /// choice above so the two cannot drift apart.
    private static func isRefusal(_ option: String) -> Bool { OptionCard.isRefusal(option) }

    /// The card's options as buttons. A bot on another Mac refuses
    /// always-allow, so an "Always allow" choice is dropped and only the
    /// one-off answers remain.
    private var visibleOptions: [String] {
        guard let card = message.card else { return [] }
        guard chat.isRemoteBot else { return card.options }
        return card.options.filter { !card.shouldRememberPermission(for: $0) }
    }

    private var tint: Color { MausPalette.color(chat.color) }

    var body: some View {
        if let card = message.card {
            VStack(alignment: .leading, spacing: 10) {
                if card.isPending {
                    Label("\(chat.name) is waiting on you", systemImage: "hand.raised.fill")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(tint)
                }
                Text(card.title)
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(Color.primary)
                    .fixedSize(horizontal: false, vertical: true)
                if !card.subtitle.isEmpty {
                    Text(card.subtitle)
                        .font(.system(size: 15))
                        .foregroundStyle(Color.secondary)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                }

                if let skill = card.skillRequest {
                    if let preview = skill.preview, let sha256 = skill.reviewedSha256 {
                        VStack(alignment: .leading, spacing: 7) {
                            HStack {
                                Text("Review the complete SKILL.md")
                                    .font(.system(size: 12, weight: .semibold))
                                Spacer()
                                Text("sha256 \(String(sha256.prefix(8)))")
                                    .font(.system(size: 10, design: .monospaced))
                                    .foregroundStyle(Color.secondary)
                            }
                            Text(skill.source.map { LocalizedStringKey("Source: \($0)") } ?? "Source: unknown")
                                .font(.system(size: 11))
                                .foregroundStyle(Color.secondary)
                                .textSelection(.enabled)
                            ScrollView(.vertical) {
                                Text(preview)
                                    .font(.system(size: 12, design: .monospaced))
                                    .foregroundStyle(Color.primary)
                                    .textSelection(.enabled)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                            .frame(maxHeight: 220)
                            .padding(10)
                            .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
                        }
                    } else {
                        Label(
                            "This proposal was created by an older build and cannot be safely applied. Deny it and ask the bot to create it again.",
                            systemImage: "exclamationmark.shield"
                        )
                        .font(.system(size: 12))
                        .foregroundStyle(.orange)
                    }
                }

                if let held = card.held {
                    Label(held, systemImage: "exclamationmark.shield")
                        .font(.system(size: 13))
                        .foregroundStyle(.orange)
                }

                if card.isPending {
                    HStack(spacing: 8) {
                        ForEach(visibleOptions, id: \.self) { option in
                            Button {
                                Haptics.selection()
                                answering = true
                                Task {
                                    await session.answer(chat: chat, card: card, choice: option)
                                    answering = false
                                }
                            } label: {
                                Text(option)
                                    .font(.system(size: 15, weight: .semibold))
                                    .foregroundStyle(Self.isRefusal(option) ? Color.primary : .white)
                                    .frame(maxWidth: .infinity)
                                    .frame(minHeight: 44)
                                    .background(
                                        Capsule().fill(Self.isRefusal(option) ? Color.secondary.opacity(0.18) : tint)
                                    )
                            }
                            .buttonStyle(.plain)
                            .disabled(
                                answering ||
                                    (card.skillRequest != nil && !Self.isRefusal(option) &&
                                        card.skillRequest?.reviewedSha256 == nil)
                            )
                        }
                    }
                    .padding(.top, 2)

                    // The grant key comes from the card. The phone never
                    // derives its own, so it cannot permit something subtly
                    // wider than the computer would have. The same goes for
                    // the answer: it is one of the options the card offered,
                    // never a string invented here.
                    if card.allowKey != nil, let allow = allowChoice, case let .bot(bot) = chat, bot.remote == nil {
                        Button("Always allow this tool") {
                            Haptics.selection()
                            answering = true
                            Task {
                                await session.alwaysAllow(bot: bot, card: card)
                                await session.answer(
                                    chat: chat,
                                    card: card,
                                    choice: allow,
                                    rememberingPermission: false
                                )
                                answering = false
                            }
                        }
                        .font(.system(size: 12))
                        .foregroundStyle(Color.secondary)
                        .frame(maxWidth: .infinity)
                        .disabled(answering)
                    }
                } else if let answered = card.answered {
                    Label(answered, systemImage: "checkmark.circle")
                        .font(.system(size: 14))
                        .foregroundStyle(Color.secondary)
                }
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 22, style: .continuous)
                    .fill(card.isPending ? tint.opacity(0.12) : Color.secondary.opacity(0.13))
            )
            .overlay {
                RoundedRectangle(cornerRadius: 22, style: .continuous)
                    .strokeBorder(card.isPending ? tint : .clear, lineWidth: 1.5)
            }
        }
    }
}

/// A frame of the bot's computer. In the paged shape the pixels are not in
/// the transcript — they are fetched here, once, when the row appears.
struct ScreenShot: View {
    let threadId: String
    let message: Message
    @Environment(\.sessionActions) private var sessionActions
    private var session: Session { sessionActions! }
    @State private var image: UIImage?

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
                    .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            } else {
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .fill(Color.secondary.opacity(0.13))
                    .frame(height: 160)
                    .overlay { ProgressView() }
            }
        }
        .task {
            guard image == nil else { return }
            let data: Data?
            if let inline = message.png, let decoded = Data(base64Encoded: inline) {
                data = decoded
            } else if message.hasImage == true {
                data = await session.image(threadId: threadId, messageId: message.id)
            } else {
                data = nil
            }
            image = data.flatMap(UIImage.init(data:))
        }
    }
}

/// The reply as it is being typed, styled to match the settled bubble it is
/// about to become — the handover should be invisible, and any difference in
/// padding or corner radius reads as the message jumping on arrival.
///
/// A caret rather than a spinner: a spinner says "something is happening
/// somewhere", which the reader already knows. A caret at the end of real
/// text says how far along it is.
///
/// The caret does not blink, deliberately. The obvious way to blink it —
/// `withAnimation(.repeatForever) { flag.toggle() }` in `onAppear` — animates
/// the change once and then sits still, and a caret that blinks twice and
/// stops looks more broken than one that never blinks. A correct version
/// animates opacity on a separate view, which needs a device to get right;
/// static is honest until then.
/// The typed-so-far reply, or the working steps before any text exists.
/// Observes only its own thread's live text, so it is the one view a
/// streamed token redraws.
private struct LiveReplyRow<Working: View>: View {
    @ObservedObject var live: LiveText
    let color: String
    let busy: Bool
    @ViewBuilder let working: () -> Working

    var body: some View {
        if !live.text.isEmpty {
            StreamingBubble(text: live.text, reasoning: nil, color: color)
                .id(ChatView.liveBubbleId)
        } else if busy {
            working()
                .id(ChatView.liveBubbleId)
        }
    }
}

/// One room member's reply in flight: its text as typed, or the same
/// working steps a 1:1 shows before any text exists. Observes only that
/// member's live text, so its tokens redraw this row and nothing else.
private struct RoomMemberLiveReply: View {
    @ObservedObject var live: LiveText
    let bot: Bot
    let busy: Bool
    /// The feed's face while this member works here; nil keeps it still.
    let face: MausState?
    /// False when the bubble just above is already this member's, so the
    /// name is not said twice in a row.
    var named = true
    let steps: [Message]
    let startedAt: Date
    /// Something in the row grew; true while it has anything to show.
    /// ChatView decides whether that is worth a scroll.
    let onContent: (Bool) -> Void
    var body: some View {
        if !live.text.isEmpty || !live.reasoning.isEmpty || busy {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 6) { BotAvatarView(bot: bot, size: 24, state: face ?? .idle, animated: face?.showsActivity == true); if named { Text(bot.name).font(.caption.weight(.semibold)) } }
                if !live.text.isEmpty || !live.reasoning.isEmpty {
                    StreamingBubble(text: live.text, reasoning: live.reasoning, color: bot.color)
                } else { WorkingSteps(items: steps, startedAt: startedAt) }
            }.id(ChatView.liveBubbleId + ":" + bot.id)
                // One subscription for both streams, so a token is one
                // callback however many lanes it touches.
                .onReceive(live.$text.map(\.count).combineLatest(live.$reasoning.map(\.count)).map { $0 + $1 }.removeDuplicates()) { onContent($0 > 0) }
                .onChange(of: steps.count) { _, _ in onContent(true) }
        }
    }
}

/// Following a room's live rows without fighting the reader.
///
/// Two or three members streaming at once each asked for a scroll on every
/// token, which is a layout pass per character per member — the lag in a
/// busy room. A row now scrolls the first time it has something to show and
/// then at most every quarter second, and only while the reader is at the
/// newest line: someone who has scrolled up to read is left there.
final class ScrollFollow {
    var pinned = true
    private var lastScroll: [String: Date] = [:]
    private static let interval: TimeInterval = 0.25

    func shouldScroll(_ id: String, hasContent: Bool, now: Date = Date()) -> Bool {
        guard hasContent else { lastScroll[id] = nil; return false }
        guard pinned else { return false }
        if let last = lastScroll[id], now.timeIntervalSince(last) < Self.interval { return false }
        lastScroll[id] = now
        return true
    }
}

/// Keeps `ScrollFollow.pinned` current. The geometry callback is iOS 18;
/// on 17 the reader counts as pinned, which is how it behaved before.
private struct TrackPinnedToBottom: ViewModifier {
    let follow: ScrollFollow
    /// Told only when pinned flips, for the jump-down button.
    var onChange: (Bool) -> Void = { _ in }
    func body(content: Content) -> some View {
        if #available(iOS 18.0, *) {
            // The distance to the end rather than a Bool: with a Bool, a
            // quick false-then-true while the lazy rows settled on open
            // could deliver only the false, leaving a reader who was at the
            // bottom marked as scrolled away (no follow, a stray jump
            // button). A distance keeps arriving, so the last one is true.
            content.onScrollGeometryChange(for: CGFloat.self) { geometry in
                max(0, (geometry.contentSize.height - geometry.visibleRect.maxY).rounded())
            } action: { _, distance in
                // a generous margin: a streaming row grows between frames,
                // and the reader resting on the last line counts as at it
                let pinned = distance <= 80
                guard pinned != follow.pinned else { return }
                follow.pinned = pinned
                onChange(pinned)
            }
        } else {
            content
        }
    }
}

/// The transcript's scroll position, reported as the id of the row at the
/// top. On iOS 18 it is a `ScrollPosition`, so the jump-down button can go
/// to the bottom edge: a lazy stack only estimates the rows it hasn't built,
/// and a jump to a row id far below stopped short or didn't move.
struct ReadingScrollPosition: ViewModifier {
    @Binding var visibleID: String?
    /// Each change scrolls to the bottom edge (iOS 18).
    let jumpToEnd: Int
    func body(content: Content) -> some View {
        if #available(iOS 18.0, *) {
            content.modifier(EdgeScrollPosition(visibleID: $visibleID, jumpToEnd: jumpToEnd))
        } else {
            content.scrollPosition(id: $visibleID, anchor: .top)
        }
    }
}

@available(iOS 18.0, *)
private struct EdgeScrollPosition: ViewModifier {
    @Binding var visibleID: String?
    let jumpToEnd: Int
    @State private var position = ScrollPosition(idType: String.self)
    func body(content: Content) -> some View {
        content
            .scrollPosition($position, anchor: .top)
            .onChange(of: position.viewID(type: String.self)) { _, id in
                if let id, id != visibleID { visibleID = id }
            }
            .onChange(of: jumpToEnd) { _, _ in
                position.scrollTo(edge: .bottom)
                // rows near the end replace their estimates as they're
                // built, which can move the end; land on it again
                Task { @MainActor in
                    for _ in 0..<3 {
                        try? await Task.sleep(for: .milliseconds(80))
                        position.scrollTo(edge: .bottom)
                    }
                }
            }
    }
}

/// Whether a view is on screen in its scroll view. iOS 18; a no-op before.
private struct ReportsVisible: ViewModifier {
    let action: (Bool) -> Void
    func body(content: Content) -> some View {
        if #available(iOS 18.0, *) {
            content.onScrollVisibilityChange(threshold: 0.01, action)
        } else {
            content
        }
    }
}

/// The round button that takes a reader who scrolled up back to the newest
/// line, with a dot when something arrived meanwhile.
private struct JumpToLatestButton: View {
    let unseen: Bool
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            Image(systemName: "arrow.down")
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(Color.primary)
                .frame(width: 40, height: 40)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .glassCapsule()
        .overlay(alignment: .topTrailing) {
            if unseen {
                Circle().fill(Color.accentColor).frame(width: 10, height: 10)
                    .overlay(Circle().strokeBorder(Color(uiColor: .systemBackground), lineWidth: 1.5))
                    .offset(x: 1, y: -1)
            }
        }
        .accessibilityLabel(unseen ? "New messages. Jump to latest" : "Jump to latest")
        .accessibilityIdentifier("jump-to-latest")
    }
}

struct StreamingBubble: View {
    let text: String?
    let reasoning: String?
    var color: String = "blue"

    var body: some View {
        HStack(alignment: .bottom, spacing: 0) {
            VStack(alignment: .leading, spacing: 4) {
                if let reasoning, !reasoning.isEmpty, text?.isEmpty != false {
                    AgentThoughtChamberView(
                        reasoning: String(reasoning.suffix(2_000)),
                        botName: "Bot",
                        mascotColor: MausPalette.color(color),
                        isStreaming: true
                    )
                }
                if let text, !text.isEmpty {
                    // Same renderer as the settled bubble, for the same
                    // reason as the padding: a live reply showing `**bold**`
                    // that snaps to bold on arrival is the message jumping,
                    // just in a different dimension. The parser tolerates the
                    // half-finished markdown this is always holding — an
                    // unclosed fence renders as code, an unclosed link as the
                    // characters typed so far.
                    MarkdownText(source: text, caret: true)
                        .foregroundStyle(Color.primary)
                }
            }
            .padding(.horizontal, 15)
            .padding(.vertical, 11)
            .background(RoundedRectangle(cornerRadius: 22).fill(BubbleColor.theirs))
            Spacer(minLength: 44)
        }
        // No `.textSelection` on purpose: selecting text that is still growing
        // fights the reader, and the settled bubble a frame later is
        // selectable anyway.
    }
}

/// The held sends for one thread, as the desktop's composer shows them: one
/// line each, deletable, with a note when the harness held them for thread
/// capacity rather than because a turn is running.
private struct QueuedSendList: View {
    let sends: [QueuedSend]
    /// Room steer: the one running member the server will deliver the head
    /// to, so the button names who actually receives it.
    var steerTargetName: String? = nil
    /// Room steer the server would refuse or hold: shown in place of the
    /// button so nobody taps a Steer that lands nowhere.
    var steerUnavailable: String? = nil
    let steer: (QueuedSend) async -> Void
    @State private var steering = false
    /// Opens the text editor for one entry; nil hides the button.
    var edit: ((QueuedSend) -> Void)? = nil
    let cancel: (QueuedSend) -> Void

    private var showsCapacityNote: Bool {
        sends.contains { $0.reason == "capacity" }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if showsCapacityNote {
                Text("Queued — starts when this bot has a free thread slot.")
                    .font(.system(size: 12))
                    .foregroundStyle(Color.secondary)
            }
            ForEach(Array(sends.enumerated()), id: \.element.queueId) { index, send in
                HStack(spacing: 8) {
                    Image(systemName: "arrow.turn.down.right")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(Color.secondary)
                    QueuedSendPreviewLine(preview: QueuedSendPreview.parse(send.text))
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if index == 0, let steerUnavailable {
                        Text(steerUnavailable)
                            .font(.system(size: 12))
                            .foregroundStyle(Color.secondary)
                            .lineLimit(1)
                            .layoutPriority(-1)
                    } else if index == 0 {
                        Button(steerTargetName.map { String(localized: "Steer \($0)") } ?? String(localized: "Steer")) {
                            guard !steering else { return }
                            steering = true
                            Task { await steer(send); steering = false }
                        }
                        .lineLimit(1)
                        .disabled(steering)
                        .onChange(of: sends) { _, _ in steering = false }
                        .accessibilityLabel(steerTargetName.map { String(localized: "Send this into \($0)'s running turn now") } ?? String(localized: "Steer queued message now"))
                    }
                    if let edit {
                        Button {
                            edit(send)
                        } label: {
                            Image(systemName: "pencil")
                                .font(.system(size: 13, weight: .medium))
                                .foregroundStyle(Color.secondary)
                                .frame(width: 44, height: 44)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Edit queued message \(index + 1) of \(sends.count)")
                    }
                    Button {
                        cancel(send)
                    } label: {
                        Image(systemName: "trash")
                            .font(.system(size: 13, weight: .medium))
                            .foregroundStyle(Color.secondary)
                            .frame(width: 30, height: 30)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Delete queued message \(index + 1) of \(sends.count)")
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 5)
                .background(Color.primary.opacity(0.06), in: RoundedRectangle(cornerRadius: 12))
            }
        }
        .padding(.horizontal, 4)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(sends.count == 1 ? "1 queued message" : "\(sends.count) queued messages")
    }
}

/// One held send: typed words first, then a quiet chip per pasted block or
/// attachment, so the queue never shows the prompt's raw wrapper tags.
private struct QueuedSendPreviewLine: View {
    let preview: QueuedSendPreview

    var body: some View {
        HStack(spacing: 6) {
            if !preview.display.isEmpty {
                Text(preview.display)
                    .font(.system(size: 14))
                    .foregroundStyle(Color.primary)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            ForEach(Array(preview.pastes.enumerated()), id: \.offset) { _, paste in
                chip("doc.on.clipboard", "Pasted · \(paste.lines) lines")
            }
            ForEach(Array(preview.attachments.enumerated()), id: \.offset) { _, attachment in
                chip(attachment.kind == .image ? "photo" : "doc", attachment.name)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private func chip(_ systemImage: String, _ label: String) -> some View {
        HStack(spacing: 3) {
            Image(systemName: systemImage).font(.system(size: 11))
            Text(label).lineLimit(1).truncationMode(.middle)
        }
        .font(.system(size: 12))
        .foregroundStyle(Color.secondary)
        .padding(.horizontal, 6).padding(.vertical, 2)
        .background(Color.primary.opacity(0.07), in: RoundedRectangle(cornerRadius: 6))
        .frame(maxWidth: 140, alignment: .leading)
        .fixedSize(horizontal: false, vertical: true)
    }
}
