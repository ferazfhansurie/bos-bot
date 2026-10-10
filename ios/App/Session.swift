// The app's one long-lived object: who we are paired with, what we know,
// and the stream that keeps it current.
//
// The parsing and folding live in CompanionCore. What lives here is the
// part that cannot be unit-tested and is the actual hard problem in a phone
// client — lifecycle. A phone loses its connection constantly: it locks, it
// backgrounds, it moves between wifi and cellular. So the stream is torn
// down deliberately when the app leaves the screen, and on the way back the
// server is asked what was missed rather than being asked for everything.
import Combine
import Foundation
import Network
import OSLog
import SwiftUI
import CompanionCore
import UserNotifications
import UIKit

/// Stream lifecycle, in Console.app and the Xcode console. A companion that
/// is silently not connected looks exactly like one with nothing to say, so
/// the transitions are worth being able to read.
private let log = Logger(subsystem: "com.openmausbot.companion", category: "stream")

private final class CachedAttachmentDownload: NSObject {
    let value: DownloadedFile

    init(_ value: DownloadedFile) {
        self.value = value
    }
}

/// An immutable, ciphertext-only credential write prepared on the main
/// actor before any asynchronous work begins. HPKE uses fresh randomness for
/// every seal, so retries must reuse this exact value rather than encrypting
/// the same credential again after an ambiguous network failure.
struct PreparedPhoneCredential: Equatable, Sendable {
    fileprivate let requestIdentity: String
    fileprivate let connectionID: String
    fileprivate let botID: String
    fileprivate let messageID: String
    fileprivate let envelope: PhoneSecretEnvelope
}

/// The session, for views that only call into it. `@EnvironmentObject`
/// subscribes a view to every change the session publishes, so when each
/// transcript row held one, any bot finishing a tool step anywhere redrew
/// every row of the open chat. Reading it from here subscribes to nothing.
private struct SessionActionsKey: EnvironmentKey {
    static let defaultValue: Session? = nil
}

extension EnvironmentValues {
    var sessionActions: Session? {
        get { self[SessionActionsKey.self] }
        set { self[SessionActionsKey.self] = newValue }
    }
}

extension View {
    /// Both ways in: observed, and as a plain reference for action-only views.
    func session(_ session: Session) -> some View {
        environmentObject(session).environment(\.sessionActions, session)
    }
}

@MainActor
final class Session: ObservableObject {

    /// App Store and TestFlight builds carry no embedded provisioning profile and
    /// receive production APNs tokens; development-signed builds embed a profile
    /// whose entitlements name the sandbox.
    static let apnsEnvironment: String = {
        guard let url = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision"),
              let data = try? Data(contentsOf: url),
              let text = String(data: data, encoding: .isoLatin1) else { return "production" }
        guard let key = text.range(of: "<key>aps-environment</key>"),
              let value = text.range(of: "<string>", range: key.upperBound..<text.endIndex) else { return "production" }
        return text[value.upperBound...].hasPrefix("development") ? "development" : "production"
    }()
    enum Status: Equatable {
        case unpaired
        case connecting
        case live
        /// The token stopped working — revoked on the computer, most likely.
        case unauthorized
        case offline(String)
    }

    /// Everything the app draws. Not `@Published`: a streamed token only
    /// grows `streaming`/`reasoning`, and republishing the root for that
    /// redrew every screen in the app once per token of every thread. Those
    /// batches fold quietly and reach the one open bubble through
    /// `liveText`; every other change announces itself as before.
    private(set) var state = CompanionState() {
        willSet { if !foldingQuietly { objectWillChange.send() } }
        didSet {
            liveText.sync(from: state)
            stateChanges.send(state)
        }
    }
    /// Every assignment of `state`, quiet ones included, for code that
    /// watches it outside a view (what `$state` was).
    let stateChanges = CurrentValueSubject<CompanionState, Never>(CompanionState())
    /// The reply being typed, per thread, observable one thread at a time.
    let liveText = LiveTextStore()
    @Published private(set) var mascotCompletionIDs: [String: String] = [:]
    private var mascotLedgers: [String: MascotCompletionLedger] = [:]
    private var mascotReplayCutoff: Int?
    private var foldingQuietly = false
    @Published private(set) var connection: Connection?
    @Published private(set) var connections: [Connection] = []
    /// Whether the live pairing may administer the workspace — see
    /// `Connection.canAdminister`. Views hide owner-only controls when this
    /// is false rather than offer buttons the server would answer 403 to.
    var canAdminister: Bool { connection?.canAdminister ?? false }
    @Published private(set) var status: Status = .unpaired
    /// Transient, user-facing failures from an action they just took.
    @Published var actionError: String?
    /// One exact message the next opened chat should reveal.
    @Published private(set) var focusedMessageId: String?
    @Published private(set) var notificationAuthorization: UNAuthorizationStatus = .notDetermined
    /// Distinguishes a real `.notDetermined` result from the in-memory value
    /// used while notification settings are still loading at launch.
    @Published private(set) var notificationAuthorizationResolved = false
    /// A short-lived desktop handoff waiting for PairingView to present it.
    @Published private(set) var pairingInvite: PairingInvite?
    /// Pairing can be opened while another computer remains connected. The
    /// working session is only replaced after the new credential commits.
    @Published private(set) var pairingRequested = false
    /// Views with sensitive input observe this value so an explicit runtime
    /// disconnect clears the field even when the selected connection itself
    /// has not changed.
    @Published private(set) var credentialEntryResetGeneration = 0
    /// Which person this pairing speaks as, per connection, so room lines
    /// from other people can be told apart from yours.
    @Published private var roomSelf: (connectionID: String, me: SharedMe)?
    var roomActorId: String? {
        guard let roomSelf, roomSelf.connectionID == client?.connection.id else { return nil }
        return roomSelf.me.actorId
    }
    var roomHomeId: String? {
        guard let roomSelf, roomSelf.connectionID == client?.connection.id else { return nil }
        return roomSelf.me.homeId
    }

    /// A notification response that should be pushed by the roster's
    /// NavigationStack after the exact detached task has been activated.
    @Published private(set) var notificationChat: Chat?

    private var client: CompanionClient? {
        // Every client this session builds reports write authority back,
        // whichever of the many construction sites made it.
        didSet {
            guard let id = client?.connection.id else { return }
            client?.authorityObserver = { [weak self] event in
                Task { @MainActor in self?.noteWriteAuthority(event, connectionID: id) }
            }
        }
    }
    /// Connections whose workspace moved to BOS cloud: their legacy server
    /// answered a write with `authority_moved`. Persisted so a relaunch shows
    /// it before any write; cleared only when a later send there succeeds.
    @Published private(set) var legacyArchivedIDs: Set<String> =
        Set(UserDefaults.standard.stringArray(forKey: Session.legacyArchivedKey) ?? [])
    private static let legacyArchivedKey = "bos.legacyArchivedConnections"
    /// The selected computer's chats are read-only here; history still loads.
    var legacyArchived: Bool { connection.map { legacyArchivedIDs.contains($0.id) } ?? false }
    /// Ciphertext-only operations survive navigation and transient
    /// disconnects so a retry cannot accidentally reseal the same value with
    /// a different HPKE operation id. Nothing here is persisted to disk.
    private var preparedPhoneCredentials: [String: PreparedPhoneCredential] = [:]
    /// The device token, kept in memory so the client can be rebuilt when the
    /// dial moves to another stored host. The keychain remains the only place
    /// it is persisted.
    private var token: String?
    /// Which of the connection's stored hosts the next attempt dials. The
    /// walk advances on address-shaped failures and the winner is promoted —
    /// and persisted — when a stream goes live.
    private var rotation = CandidateRotation(hosts: [])
    private var streamTask: Task<Void, Never>?
    /// Rooms joined on another home stream from that home through
    /// `/api/groups/:id/events`, one stream per home, beside the main one.
    private var remoteStreams: [String: (groupId: String, task: Task<Void, Never>)] = [:]
    /// Frames received but not yet folded. The first frame after a quiet
    /// spell folds at once, so a send or an approval lands the moment the
    /// server says so; anything that follows within the window waits and
    /// folds with the rest in one mutation. One mutation per ~60ms rather
    /// than one per token is what keeps several streaming threads from
    /// saturating the main thread. The cursor only moves when a frame is
    /// folded, so a frame still waiting here when the stream dies is simply
    /// replayed on reconnect.
    private var pendingFrames: [StreamFrame] = []
    private var frameFlushTask: Task<Void, Never>?
    private var lastFrameFlush: ContinuousClock.Instant?
    /// What the app badge was last set to, so a fold that leaves the unread
    /// count alone does not call into UserNotifications.
    private var appliedBadge: Int?
    private static let frameBatchInterval: Duration = .milliseconds(60)
    /// A batch with a saved message or a bot change in it redraws every
    /// screen that reads the session. With several bots working, their tool
    /// steps alone arrived several times a second and each redraw relaid the
    /// open transcript, so typing and scrolling stalled. Those batches still
    /// fold at once; the redraw they announce waits until this long after
    /// the last one, so it lands at most a few times a second. A stream
    /// starting or ending is always announced at once.
    private static let loudPublishInterval: Duration = .milliseconds(250)
    private var lastLoudPublish: ContinuousClock.Instant?
    private var deferredPublish: Task<Void, Never>?
    private static let frameBatchLimit = 512
    /// Best-effort authenticated route refresh started by the latest live SSE
    /// hello. Kept separate so endpoint discovery never stalls event delivery.
    private var endpointRefreshTask: Task<Void, Never>?
    /// The Mac's remote-access summary from the latest live connection.
    /// `nil` is unknown: not fetched yet, or a desktop too old to say.
    @Published private(set) var companionStatus: CompanionStatus?
    /// Set beside an `.offline` status: the Mac was last reachable from
    /// anywhere, so a failure now more likely means it is asleep than that
    /// this phone is on the wrong network.
    @Published private(set) var macMayBeAsleep = false
    /// Turns a host restart cut off that are still waiting on the owner.
    @Published private(set) var interruptedTurns: [InterruptedTurn] = []
    /// Dials that failed since the stream was last live. A full lap of the
    /// rotation means every known route failed.
    private var failedDialsSinceLive = 0
    /// Watches wifi/cellular handoffs so a stream stranded on a local route
    /// moves to a protected one at once instead of after backoff.
    private let pathMonitor = NWPathMonitor()
    private var pathSignature: String?
    /// Unknown until the first path report; assume the saved order holds.
    private var onLocalNetwork = true
    /// Identifies the task currently stored in `streamTask`. A cancelled task
    /// can finish after its replacement starts; its cleanup must not clear
    /// the replacement's handle.
    private var streamGeneration = 0
    /// The in-flight activity-feed snapshot for the current connection.
    private var activityFeedTask: Task<Void, Never>?
    private var reconnectDelay: UInt64 = 0
    /// How many computer panels are open. A count rather than a flag: the
    /// panel can be pushed twice in a navigation stack, and the last one to
    /// close is the one that should turn screens back off.
    private var screenWatchers = 0
    /// Authenticated avatar bytes shared by roster, header, group and task
    /// surfaces. Both entry count and byte cost are bounded because one valid
    /// uploaded image may be 10 MB.
    private let avatarCache: NSCache<NSString, NSData> = {
        let cache = NSCache<NSString, NSData>()
        cache.countLimit = 64
        cache.totalCostLimit = 32 * 1_024 * 1_024
        return cache
    }()
    /// Concurrent first renders share one download. The id prevents an old
    /// request finishing after sign-out from removing a newer pairing's task
    /// for the same attachment path.
    private var avatarFetches: [String: (id: UUID, task: Task<Data?, Never>)] = [:]
    private var avatarCacheGeneration = 0
    /// Full image bytes are already fetched to draw a thumbnail. Keep a small,
    /// cost-bounded window so tapping that thumbnail opens immediately instead
    /// of downloading the same image twice.
    private let attachmentCache: NSCache<NSString, CachedAttachmentDownload> = {
        let cache = NSCache<NSString, CachedAttachmentDownload>()
        cache.countLimit = 12
        cache.totalCostLimit = 32 * 1_024 * 1_024
        return cache
    }()
    private var attachmentCacheGeneration = 0
    /// An ambiguous network failure may happen after the server accepted a
    /// message. Reusing this id for the exact same retained draft makes Retry
    /// idempotent instead of sending the attachment twice.
    private var attachmentSendIDs: [AttachmentDraftKey: String] = [:]
    /// A saved connection exists, but its token could not be read yet. Keeps
    /// "the keychain is locked" from being mistaken for "not paired".
    private var restorePending = false
    var isRestoringSavedPairing: Bool { restorePending && connection == nil }
    /// A notification can cold-launch the app before protected Keychain data
    /// is available. Retain the last explicitly tapped destination until the
    /// paired client can be rebuilt after unlock.
    private var pendingNotification: NotificationTarget?
    private var notificationVisibleThreads = Set<String>()

    /// The exact route the current client will use for a credential write.
    var phoneCredentialTransportIsProtected: Bool {
        client?.connection.activeEndpoint?.protectsCredentials == true
    }

    private struct AttachmentDraftKey: Hashable {
        let destination: MessageDestination
        let text: String
        let attachmentIDs: [UUID]
        let replyToId: String?
    }

    private var registry = CompanionConnectionRegistry()

    // MARK: - Other homes

    /// True for a session holding one more paired computer beside the
    /// selected one, so its bots sit in the same chat list. It owns no
    /// app-wide handler (notifications, CallKit, badge, network path); the
    /// primary session routes those to it by connection id.
    private(set) var isSatellite = false
    private weak var primary: Session?
    /// Every other paired computer, connected at the same time as this one.
    @Published private(set) var satellites: [Session] = []
    private var satelliteChanges: [AnyCancellable] = []
    private var satellitePushRegistered = false

    private init(satelliteOf saved: Connection, token: String, primary: Session) {
        isSatellite = true
        self.primary = primary
        onLocalNetwork = primary.onLocalNetwork
        registry = BosSharedConnectionStore.loadRegistry()
        connections = registry.connections
        configureActiveConnection(saved, token: token)
    }

    /// Keep one satellite per paired computer other than the selected one.
    /// Runs whenever the registry or the selection changes.
    private func syncSatellites() {
        guard !isSatellite else { return }
        let activeID = connection?.id
        var kept: [Session] = []
        for saved in registry.connections where saved.id != activeID {
            if let existing = satellites.first(where: { $0.connection?.id == saved.id }) {
                kept.append(existing)
                continue
            }
            // A locked keychain or a lost token leaves that home out until
            // the next sync; it is never removed from here.
            guard let stored = (try? Keychain.token(for: saved.id)) ?? nil else { continue }
            kept.append(Session(satelliteOf: saved, token: stored, primary: self))
        }
        for gone in satellites where !kept.contains(where: { $0 === gone }) { gone.retire() }
        satelliteChanges = kept.map { home in
            home.objectWillChange.sink { [weak self] _ in self?.objectWillChange.send() }
        }
        satellites = kept
        if UIApplication.shared.applicationState != .background {
            for home in kept { home.connect() }
        }
        refreshBadge()
    }

    private func retire() {
        stopActiveRuntime()
        connection = nil
        status = .unpaired
    }

    /// The session holding this connection: this one or another home.
    func home(for connectionId: String?) -> Session {
        guard !isSatellite, let connectionId, connectionId != connection?.id else { return self }
        if let home = satellites.first(where: { $0.connection?.id == connectionId }) { return home }
        // A push can cold-launch the app while the keychain was still locked
        // for that home; try once more now before falling back to this one.
        syncSatellites()
        return satellites.first { $0.connection?.id == connectionId } ?? self
    }

    /// The session whose computer this chat's bot or room lives on.
    func owner(of chat: Chat) -> Session {
        func holds(_ session: Session) -> Bool {
            session.state.bot(chat.id) != nil || session.state.rooms.contains { $0.id == chat.id }
        }
        if isSatellite || holds(self) { return self }
        return satellites.first(where: holds) ?? self
    }

    /// The short name a chat row shows for a bot on another home.
    var homeLabel: String {
        let name = connection?.name.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return name.isEmpty ? "other computer" : name
    }

    /// Another paired computer is connected right now, so this one being
    /// down is a sleeping-bots fact, not a reason to shout.
    var anotherHomeIsLive: Bool { satellites.contains { $0.status == .live } }

    /// App coming to the front or going away: every home follows.
    func connectHomes() {
        connect()
        if !isSatellite { syncSatellites() }
    }

    func lingerHomes() {
        linger()
        for home in satellites { home.linger() }
    }

    private func refreshBadge() {
        guard !isSatellite else { primary?.refreshBadge(); return }
        applyBadge(state.unreadCount)
    }

    /// A satellite never navigates the app itself: the chat list watches
    /// the primary's `notificationChat`.
    private func present(_ chat: Chat) {
        if isSatellite, let primary {
            primary.notificationChat = chat
        } else {
            notificationChat = chat
        }
    }

    // MARK: - Pairing

    init() {
        Self.removeStaleFilePreviews()
        _ = NotificationCoordinator.shared
        NotificationCoordinator.shared.foregroundPresentation = { [weak self] target in
            self?.home(for: target.connectionId).notificationPresentation(for: target) ?? .quiet
        }
        NotificationCoordinator.shared.foregroundSharedPresentation = { [weak self] roomID, connectionID in
            guard let self, let connectionID, connectionID == self.client?.connection.id else { return .quiet }
            let visible = UIApplication.shared.applicationState == .active && self.notificationVisibleThreads.contains(connectionID + ":shared:" + roomID)
            // The authenticated server already applies shared-room mute and
            // mentions preferences before emitting this remote push.
            return .resolve(enabled: true, visible: visible, blocking: false)
        }
        NotificationCoordinator.shared.responseHandler = { [weak self] target in
            Task { @MainActor in await self?.openNotification(target) }
        }
        NotificationCoordinator.shared.foregroundVoicePresentation = { [weak self] push, connectionId in
            self?.home(for: connectionId).voicePresentation(for: push) ?? .alert
        }
        NotificationCoordinator.shared.voiceHandler = { [weak self] action in
            Task { @MainActor in await self?.handleVoice(action) }
        }
        NotificationCoordinator.shared.pushTokenHandler = { [weak self] token in
            Task { @MainActor in await self?.registerPushToken(token) }
        }
        // The PushKit token can arrive after the APNs one; register again with both.
        CallKitRinger.shared.tokenHandler = { [weak self] _ in
            Task { @MainActor in
                if let token = UserDefaults.standard.string(forKey: "bos.apnsToken") { await self?.registerPushToken(token) }
            }
        }
        // Live Activity tokens come and go with each island; the Mac needs
        // the current set to drive them while the app is closed.
        LiveActivityTokens.shared.changed = { [weak self] in
            Task { @MainActor in
                if let token = UserDefaults.standard.string(forKey: "bos.apnsToken") { await self?.registerPushToken(token) }
            }
        }
        NotificationCoordinator.shared.sharedRoomHandler = { [weak self] roomID, connectionID in
            Task { @MainActor in
                guard let self else { return }
                guard let connectionID, connectionID == self.client?.connection.id else {
                    self.actionError = "This notification has no matching account. Open its conversation from the original computer."
                    return
                }
                UserDefaults.standard.set(roomID, forKey: "bos.pendingSharedRoomPush")
                NotificationCenter.default.post(name: .sharedRoomPushTapped, object: roomID)
            }
        }
#if DEBUG
        let arguments = ProcessInfo.processInfo.arguments
        if arguments.contains("-shared-chat-preview") {
            let preview = Connection(id: "shared-preview", name: "Offline alpha preview", host: "shared-preview.invalid", port: 8810)
            let configuration = URLSessionConfiguration.ephemeral
            configuration.protocolClasses = [SharedChatPreviewProtocol.self]
            connection = preview
            connections = [preview]
            client = CompanionClient(connection: preview, token: "shared-preview-token", session: URLSession(configuration: configuration))
            state.hydrate(Fleet(bots: [], groups: []))
            UserDefaults.standard.removeObject(forKey: "bos.shared-draft.preview-shared-room")
            status = .live
            return
        }
        if (arguments.contains("-store-preview") || arguments.contains("-computer-switcher-preview")),
           let url = Bundle.main.url(
               forResource: arguments.contains("-room-preview") ? "RoomPreview" : arguments.contains("-images-preview") ? "ImagePreview" : (arguments.contains("-threads-preview") ? "ThreadPreview" : "StorePreview"),
               withExtension: "json"
           ),
           let data = try? Data(contentsOf: url),
           var fleet = try? JSONDecoder().decode(Fleet.self, from: data) {
            // `-empty-thread-preview`: Scout's thread starts empty, for the
            // empty thread's mascot; `-empty-thread-body bean` dresses it.
            if arguments.contains("-empty-thread-preview"), let i = fleet.bots.firstIndex(where: { $0.id == "preview-scout" }) {
                fleet.bots[i].messages = []
                fleet.bots[i].activeLeafId = nil
                if let b = arguments.firstIndex(of: "-empty-thread-body"), b + 1 < arguments.count { fleet.bots[i].mascotBody = arguments[b + 1] }
            }
            let preview = Connection(
                id: "preview-current",
                name: "Milind’s MacBook Pro",
                host: "preview.tailnet.ts.net",
                port: 8810
            )
            connection = preview
            if arguments.contains("-computer-switcher-preview") {
                let other = Connection(
                    id: "preview-other",
                    name: "MacBook Air",
                    host: "air.tailnet.ts.net",
                    port: 8810
                )
                registry = CompanionConnectionRegistry(
                    connections: [preview, other],
                    activeConnectionID: preview.id
                )
                connections = registry.connections
            } else {
                connections = [preview]
            }
            if arguments.contains("-images-preview") {
                let config = URLSessionConfiguration.ephemeral
                config.protocolClasses = [ImagePreviewProtocol.self]
                client = CompanionClient(connection: preview, token: "image-fixture-token", session: URLSession(configuration: config))
            }
            state.hydrate(fleet)
            if arguments.contains("-threads-preview"),
               let pagesURL = Bundle.main.url(forResource: "ThreadPreviewPages", withExtension: "json"),
               let pagesData = try? Data(contentsOf: pagesURL),
               let pages = try? JSONDecoder().decode([String: ThreadPage].self, from: pagesData) {
                for (threadID, page) in pages { state.merge(page, intoThread: threadID) }
            }
            status = .live
            if let i = arguments.firstIndex(of: "-empty-thread-send-after"), i + 1 < arguments.count,
               let seconds = Double(arguments[i + 1]) { startEmptyThreadSendPreview(after: seconds) }
            if arguments.contains("-stream-preview-bots") { startMultiStreamPreview() }
            else if arguments.contains("-stream-preview") { startStreamPreview() }
            return
        }
#endif
        restore()
        startWatchingNetworkPath()
        Task { await refreshNotificationAuthorization() }
    }

    /// Rebuild the selected connection at launch, migrating the previous
    /// single-computer record the first time a multi-computer build runs.
    ///
    /// Three outcomes, and keeping them apart is the whole point. No saved
    /// connection: stay unpaired. A saved connection whose token reads back:
    /// connect. A saved connection whose token cannot be read *yet* — the
    /// locked keychain before a phone's first unlock after reboot, which is
    /// when iOS is most likely to have launched us in the background — hold
    /// on to it and try again. Only the middle case is a real pairing, and
    /// only the first should ever send someone back to the pairing screen.
    private func restore() {
        restorePending = false
        do {
            try BosSharedConnectionStore.recoverRegistry()
        } catch {
            restorePending = true
            status = .offline("Unlock this iPhone to restore its saved Mac connection.")
            return
        }
        registry = BosSharedConnectionStore.loadRegistry()
        // Upgrade existing pairings before a future uninstall loses preferences.
        BosSharedConnectionStore.saveRegistry(registry)
        connections = registry.connections
        // The Share extension can target any saved computer, not only the
        // one active at launch. Move every inactive pre-extension token into
        // the shared Keychain group now; the active token is read below so
        // its locked/error state can still drive the visible connection UI.
        for saved in registry.connections where saved.id != registry.activeConnectionID {
            _ = try? Keychain.token(for: saved.id)
        }
        restoreSelectedConnection()
        syncSatellites()
    }

    /// Find the first selected pairing whose Keychain token still exists.
    /// A missing token is a genuinely unusable saved record; a locked
    /// Keychain is temporary and must leave the record untouched.
    private func restoreSelectedConnection() {
        guard let saved = registry.activeConnection else {
            clearActiveConnection()
            return
        }

        let stored: String?
        do {
            stored = try Keychain.token(for: saved.id)
        } catch {
            // Keep the connection and say why. `.offline` rather than
            // `.unpaired` matters: the latter is what puts PairingView on
            // screen, and asking for a new code is the one recovery that
            // costs a walk to the computer.
            connection = saved
            restorePending = true
            status = .offline(
                (error as? KeychainError)?.isLocked == true
                    ? "Unlock this device to reach your computer."
                    : error.localizedDescription
            )
            return
        }
        guard let stored else {
            registry.remove(id: saved.id)
            persistRegistry()
            connections = registry.connections
            restoreSelectedConnection()
            return
        }

        configureActiveConnection(saved, token: stored)
    }

    /// Redeem a one-time pairing credential. On success the device token goes
    /// to the keychain and the connection to defaults — deliberately apart,
    /// so the thing that gets backed up is never the credential.
    func pair(
        with connection: Connection,
        credential: String,
        deviceName: String,
        pairRequestId: String
    ) async throws {
        var invited = connection
        // QR invites already carry this policy. Manual entry reaches the
        // session as a parsed Connection, so establish the same consent
        // boundary here before any health probe or credential redemption.
        if invited.allowedRouteKinds == nil {
            invited.establishRoutePolicyFromInvite()
        }
        // A 12-character code pairs with a server directly (its own sessions,
        // a bearer with the code's scopes); anything else is the companion's.
        if let code = PairingInvite.normalizedServerCode(credential) {
            // Reachability first, on the public descriptor: a wrong address
            // then fails as an address problem rather than a code problem,
            // and no attempt is spent against the server's lockout.
            try await Self.confirmServer(at: invited)
            let paired = try await CompanionClient.pairWithServer(
                connection: invited,
                code: code,
                label: deviceName,
                attemptId: pairRequestId
            )
            var stored = invited
            if !paired.environment.label.isEmpty { stored.name = paired.environment.label }
            stored.serverEnvironmentId = paired.environment.environmentId
            stored.serverScopes = paired.session.scopes
            stored.companionDeviceId = nil
            if let existing = registry.matchingConnection(for: stored) {
                stored.id = existing.id
            }
            try commitPairing(stored, token: paired.token)
            return
        }
        let outcome = try await CompanionClient.pairFirstReachable(
            connection: invited,
            credential: credential,
            deviceName: deviceName,
            pairRequestId: pairRequestId
        )
        let paired = outcome.response
        // prefer the name the computer calls itself over the Bonjour label
        var stored = outcome.connection
        if !paired.serverName.isEmpty { stored.name = paired.serverName }
        stored.companionDeviceId = paired.device.id
        // The computer knows every address it answers on, but redemption may
        // not widen the explicit route consent carried by the invite.
        stored.applyPairingAdvertisement(hosts: paired.hosts, endpoints: paired.endpoints)
        let winner = outcome.connection.activeEndpoint ?? CompanionEndpoint.direct(
            host: outcome.connection.host,
            port: outcome.connection.port,
            priority: 10_000
        )
        if let winner { stored.promote(winner) }
        if stored.endpoints?.isEmpty != false {
            stored.hosts = Array(stored.orderedHosts.prefix(8))
        }
        if let existing = registry.matchingConnection(for: stored) {
            stored.id = existing.id
        }
        try commitPairing(stored, token: paired.token, winner: winner)
    }

    /// The device token goes to the keychain and the connection to defaults —
    /// deliberately apart, so the thing that gets backed up is never the
    /// credential. Shared by companion and server pairing; `winner` is the
    /// route that answered, which a server pairing (one route) has no use for.
    private func commitPairing(_ stored: Connection, token: String, winner: CompanionEndpoint? = nil) throws {
        try Keychain.save(token, for: stored.id)
        let firstPairing = registry.connections.isEmpty
        var updatedRegistry = registry
        // Pairing one more computer adds a home beside the selected one; the
        // selected computer stays the main one. A re-pair of the selected
        // computer, or a first pairing, still makes it active.
        let addsHome = !isSatellite && client != nil && connection.map { $0.id != stored.id } == true
        updatedRegistry.upsert(stored, makeActive: !addsHome)
        if addsHome {
            BosSharedConnectionStore.saveRegistry(updatedRegistry)
            pairingInvite = CompanionPairingInvitePolicy.nextInvite(current: pairingInvite, after: .pairingSucceeded)
            pairingRequested = false
            registry = updatedRegistry
            connections = registry.connections
            satellites.first { $0.connection?.id == stored.id }?.retire()
            satellites.removeAll { $0.connection == nil }
            syncSatellites()
            return
        }
        // Write the first-pair education marker before making the connection
        // restorable. If the process stops between these writes, an orphan
        // marker is harmless while unpaired; the reverse order could restore
        // a pairing which permanently skipped this step.
        // RootView may not have received iOS's notification status yet, and
        // the app may be relaunched before that asynchronous lookup finishes.
        CompanionPairingCommitSequence.persist {
            if firstPairing {
                UserDefaults.standard.set(
                    true,
                    forKey: CompanionOnboardingPreferences.pendingNotificationOnboardingKey
                )
            }
        } saveConnection: {
            BosSharedConnectionStore.saveRegistry(updatedRegistry)
        }

        stopActiveRuntime()
        pairingInvite = CompanionPairingInvitePolicy.nextInvite(
            current: pairingInvite,
            after: .pairingSucceeded
        )
        pairingRequested = false
        registry = updatedRegistry
        connections = registry.connections
        self.connection = stored
        self.token = token
        let liveRoutes = winner.map { route in
            [route] + stored.orderedEndpoints.filter { $0.url != route.url }
        } ?? stored.orderedEndpoints
        self.rotation = CandidateRotation(endpoints: liveRoutes)
        self.client = CompanionClient(
            connection: winner.map(stored.dialing) ?? stored,
            token: token
        )
        self.resetState()
        // A fresh pairing settles any restore that was still waiting on the
        // keychain — the token is in hand, so there is nothing left to retry.
        restorePending = false
        connect()
        syncSatellites()
    }

    /// `GET /.well-known/openmausbot/environment` on a server about to be
    /// paired. Nothing there means this address is not a server; the message
    /// names the address, since that is what the person can fix. Any other
    /// answer — unreachable, a gateway error — is passed through as it is.
    private static func confirmServer(at connection: Connection) async throws {
        let probe = CompanionClient(connection: connection, token: nil, requestTimeout: 8)
        do {
            _ = try await probe.environment()
        } catch APIError.status(404, _) {
            throw APIError.transport(
                "\(connection.displayAddress) isn't an BOS server. Check the address and try again."
            )
        }
    }

    func receivePairingURL(_ url: URL) {
        guard let invite = PairingInvite.parse(url) else {
            actionError = "That pairing invitation is not valid. Start pairing again on your computer."
            return
        }
        pairingInvite = CompanionPairingInvitePolicy.nextInvite(
            current: pairingInvite,
            after: .received(invite)
        )
        pairingRequested = true
    }

    func beginPairing() {
        pairingRequested = true
    }

    func endPairing() {
        pairingRequested = false
        consumePairingInvite()
    }

    func consumePairingInvite() {
        pairingInvite = CompanionPairingInvitePolicy.nextInvite(
            current: pairingInvite,
            after: .consumed
        )
    }

    func switchComputer(to id: String) {
        guard let saved = registry.connection(id: id) else { return }
        if connection?.id == id {
            restartStream()
            connect()
            return
        }

        let stored: String?
        do {
            stored = try Keychain.token(for: id)
        } catch {
            actionError = (error as? KeychainError)?.isLocked == true
                ? "Unlock this device, then try switching computers again."
                : error.localizedDescription
            return
        }
        guard let stored else {
            actionError = "This saved connection is no longer available on this device. Remove it and pair again."
            return
        }

        stopActiveRuntime()
        registry.select(id: id)
        persistRegistry()
        connections = registry.connections
        configureActiveConnection(saved, token: stored)
        connect()
        syncSatellites()
    }

    func forgetConnection(id: String) {
        guard let forgotten = registry.connection(id: id) else { return }
        setLegacyArchived(false, connectionID: id)
        let wasActive = registry.activeConnectionID == id
        // A server session is ended on the server too, best effort: the
        // bearer is discarded locally either way.
        if forgotten.pairedWithServer, let token = try? Keychain.token(for: id) {
            let client = CompanionClient(connection: forgotten, token: token)
            Task.detached { try? await client.logout() }
        }
        if wasActive { stopActiveRuntime() }
        preparedPhoneCredentials = preparedPhoneCredentials.filter { $0.value.connectionID != id }
        Keychain.remove(id)
        RosterCache.remove(for: id)
        registry.remove(id: id)
        persistRegistry()
        connections = registry.connections
        guard wasActive else { syncSatellites(); return }

        connection = nil
        client = nil
        token = nil
        rotation = CandidateRotation(hosts: [])
        resetState()
        resetAvatarCache()
        applyBadge(0)
        restoreSelectedConnection()
        if connection != nil { connect() }
        syncSatellites()
        if connections.isEmpty {
            UserDefaults.standard.removeObject(
                forKey: CompanionOnboardingPreferences.pendingNotificationOnboardingKey
            )
        }
    }

    /// Compatibility for the existing revoked-pairing and detail actions:
    /// sign out now means remove only the selected computer.
    func signOut() {
        guard let id = connection?.id ?? registry.activeConnectionID else {
            clearActiveConnection()
            return
        }
        forgetConnection(id: id)
    }

    private func clearActiveConnection() {
        resetCredentialEntry()
        stopStream()
        endpointRefreshTask?.cancel()
        endpointRefreshTask = nil
        companionStatus = nil
        macMayBeAsleep = false
        failedDialsSinceLive = 0
        restorePending = false
        pendingNotification = nil
        pairingInvite = CompanionPairingInvitePolicy.nextInvite(
            current: pairingInvite,
            after: .signedOut
        )
        pairingRequested = false
        connection = nil
        client = nil
        token = nil
        rotation = CandidateRotation(hosts: [])
        resetState()
        resetAvatarCache()
        resetAttachmentCache()
        attachmentSendIDs.removeAll()
        applyBadge(0)
        status = .unpaired
    }

    private func configureActiveConnection(_ saved: Connection, token stored: String) {
        connection = saved
        token = stored
        // New connections honor the desktop's transport policy. Automatic
        // walking is credential-safe: protected routes stay protected, while
        // a legacy/local route is only tried when it was the exact saved route.
        rotation = CandidateRotation(endpoints: saved.orderedEndpoints, onLocalNetwork: onLocalNetwork)
        let first = rotation.currentEndpoint.map(saved.dialing) ?? saved
        client = CompanionClient(connection: first, token: stored)
        // Draw the last roster now; the first hello carries no cursor, so
        // the server answers `resumed: false` and hydrate replaces it.
        if !state.rosterLoaded, let cached = RosterCache.load(for: saved.id) {
            state.hydrate(cached.fleet)
        }
        status = .connecting
    }

    private func stopActiveRuntime() {
        resetCredentialEntry()
        streamGeneration += 1
        stopStream()
        saveRosterCache()
        endpointRefreshTask?.cancel()
        endpointRefreshTask = nil
        companionStatus = nil
        macMayBeAsleep = false
        failedDialsSinceLive = 0
        restorePending = false
        endLinger()
        pendingNotification = nil
        screenWatchers = 0
        client = nil
        token = nil
        resetState()
        resetAvatarCache()
        resetAttachmentCache()
        attachmentSendIDs.removeAll()
        applyBadge(0)
    }

    private func persistRegistry() {
        BosSharedConnectionStore.saveRegistry(registry)
    }

    private func persistActiveConnection(_ updated: Connection) {
        // A satellite's copy of the registry is stale the moment the primary
        // saves; start from the stored one so its write changes one record.
        if isSatellite { registry = BosSharedConnectionStore.loadRegistry() }
        registry.upsert(updated, makeActive: false)
        connection = updated
        connections = registry.connections
        persistRegistry()
    }

    // MARK: - Lifecycle

    /// Called when the app comes to the front, and once at launch.
    func connect() {
#if DEBUG
        if ProcessInfo.processInfo.arguments.contains("-shared-chat-preview") { status = .live; return }
#endif
        // A restore that found the keychain locked left `client` nil on
        // purpose. Coming to the front is the moment worth retrying on: the
        // app is on screen, so the phone is in someone's hand and unlocked.
        if client == nil, restorePending { restore() }
        if client != nil, let pendingNotification {
            self.pendingNotification = nil
            Task { [weak self] in await self?.openNotification(pendingNotification) }
        }
        // back before the grace period ran out: keep the stream, drop the task
        endLinger()
        // A stream waiting out backoff would leave the person who just
        // opened the app looking at an old failure for up to 15 seconds.
        // Dial now; the cursor survives, so this is a gap, not a reset.
        if streamTask != nil, case .offline = status {
            stopStream()
        }
        guard client != nil, streamTask == nil else { return }
        reconnectDelay = 0
        streamGeneration += 1
        let generation = streamGeneration
        streamTask = Task { [weak self] in
            guard let self else { return }
            await self.run()
            guard self.streamGeneration == generation else { return }
            self.streamTask = nil
        }
    }

    /// Pull-to-refresh: reopen the stream, and hold the control open until
    /// the connection has actually settled one way or the other.
    ///
    /// `connect()` returns the moment the task is spawned, so a `refreshable`
    /// that only calls it snaps the spinner shut before a single byte has
    /// arrived — the gesture reads as "nothing happened", on precisely the
    /// occasion it exists for. Waiting for `status` to leave `.connecting`
    /// makes the spinner mean what it appears to mean; the deadline is there
    /// so a network that never answers still gives the control back.
    func refresh() async {
        restartStream()
        connect()
        let deadline = Date().addingTimeInterval(10)
        while status == .connecting, !Task.isCancelled, Date() < deadline {
            try? await Task.sleep(nanoseconds: 120_000_000)
        }
    }

    func removedRemoteBotIDs() async throws -> Set<String> {
        guard let client else { throw APIError.transport("Computer is offline") }
        return try await client.removedRemoteBotIDs()
    }

    func sharedRoster() async throws -> (SharedMe, [SharedContact], [SharedRoomSummary]) {
        guard let client else { throw APIError.transport("Computer is offline") }
        let me = try await client.sharedMe()
        guard me.actorId != nil else { return (me, [], []) }
        async let contacts = client.sharedContacts()
        async let rooms = client.sharedRooms()
        return try await (me, contacts, rooms)
    }

    func setProfilePhoto(_ jpegBase64: String?) async throws {
        guard let client else { throw APIError.transport("Computer is offline") }
        try await client.setProfilePhoto(jpegBase64)
    }

    func openSharedDM(targetId: String) async throws -> SharedRoomSummary {
        guard let client else { throw APIError.transport("Computer is offline") }
        return try await client.openSharedDM(targetId: targetId)
    }

    func createSharedRoom(name: String, memberIds: [String]) async throws -> SharedRoomSummary {
        guard let client else { throw APIError.transport("Computer is offline") }
        return try await client.createSharedRoom(name: name, memberIds: memberIds)
    }

    func sharedBots(roomId: String) async throws -> [SharedEligibleBot] {
        guard let client else { throw APIError.transport("Computer is offline") }
        return try await client.sharedBots(roomId: roomId)
    }

    func updateSharedRoom(id: String, revision: Int, name: String? = nil, memberIds: [String]? = nil) async throws -> SharedRoomSummary {
        guard let client else { throw APIError.transport("Computer is offline") }
        return try await client.updateSharedRoom(id: id, revision: revision, name: name, memberIds: memberIds)
    }

    func leaveSharedRoom(id: String, revision: Int) async throws {
        guard let client else { throw APIError.transport("Computer is offline") }
        try await client.leaveSharedRoom(id: id, revision: revision)
    }

    /// Removes a linked Mac's bot from this list only; the server never deletes it on the other Mac.
    func removeRemoteBot(_ botId: String) async throws {
        guard let client else { throw APIError.transport("Computer is offline") }
        try await client.removeRemoteBot(id: botId)
        state.apply(.botDeleted(botId: botId))
    }

    func deleteSharedRoom(_ room: SharedRoomSummary) async throws {
        guard let client else { throw APIError.transport("Computer is offline") }
        guard let revision = room.revision else {
            throw APIError.transport("Update BOS on your Mac to delete group chats.")
        }
        try await client.deleteSharedRoom(id: room.id, revision: revision)
    }

    func sharedMessagePage(roomId: String, after: Int = 0, version: Int = 0, before: Int? = nil, latest: Bool = false) async throws -> SharedMessagesResponse {
        guard let client else { throw APIError.transport("Computer is offline") }
        return try await client.sharedMessagePage(roomId: roomId, after: after, version: version, before: before, latest: latest)
    }

    func searchSharedMessages(roomId: String, text: String, kind: String, author: String, before: Int? = nil) async throws -> SharedSearchResponse {
        guard let client else { throw APIError.transport("Computer is offline") }
        return try await client.searchSharedMessages(roomId: roomId, text: text, kind: kind, author: author, before: before)
    }

    func sharedRequests(roomId: String, before: Int? = nil) async throws -> SharedRequestsResponse {
        guard let client else { throw APIError.transport("Computer is offline") }
        return try await client.sharedRequests(roomId: roomId, before: before)
    }

    func cancelSharedRequest(roomId: String, requestId: String) async throws -> SharedBotRequest {
        guard let client else { throw APIError.transport("Computer is offline") }
        return try await client.cancelSharedRequest(roomId: roomId, requestId: requestId)
    }

    func sharedFiles(roomId: String, before: Int? = nil) async throws -> SharedFilesResponse {
        guard let client else { throw APIError.transport("Computer is offline") }
        return try await client.sharedFiles(roomId: roomId, before: before)
    }

    func editSharedMessage(roomId: String, messageId: String, text: String?) async throws -> SharedChatMessage {
        guard let client else { throw APIError.transport("Computer is offline") }
        return try await client.editSharedMessage(roomId: roomId, messageId: messageId, text: text)
    }

    func sharedPreferences(roomId: String, readSequence: Int? = nil, notifications: String? = nil, replyMode: String? = nil, replyBotId: String? = nil) async throws -> SharedConversationPreferences {
        guard let client else { throw APIError.transport("Computer is offline") }
        return try await client.sharedPreferences(roomId: roomId, readSequence: readSequence, notifications: notifications, replyMode: replyMode, replyBotId: replyBotId)
    }

    func sharedMessages(roomId: String, after sequence: Int) async throws -> [SharedChatMessage] {
        guard let client else { throw APIError.transport("Computer is offline") }
        return try await client.sharedMessages(roomId: roomId, after: sequence)
    }

    func sharedMessageTransport() throws -> CompanionClient {
        guard let client else { throw APIError.transport("Computer is offline") }
        return client
    }

    func sendSharedMessage(roomId: String, text: String, sendId: String, attachments: [SharedAttachment] = [], replyTo: String? = nil) async throws {
        guard let client else { throw APIError.transport("Computer is offline") }
        try await client.sendSharedMessage(roomId: roomId, text: text, sendId: sendId, attachments: attachments, replyTo: replyTo)
    }

    func uploadSharedAttachment(roomId: String, name: String, mime: String, data: Data) async throws -> SharedAttachment {
        guard let client else { throw APIError.transport("Computer is offline") }
        return try await client.uploadSharedAttachment(roomId: roomId, name: name, mime: mime, data: data)
    }

    func sharedAttachment(roomId: String, attachmentId: String) async throws -> SharedAttachmentData {
        guard let client else { throw APIError.transport("Computer is offline") }
        return try await client.sharedAttachment(roomId: roomId, attachmentId: attachmentId)
    }

    /// Ask the harness to include this bot's computer in the stream, for as
    /// long as something is showing it.
    ///
    /// This costs a reconnect, which is the right trade: the alternative is
    /// a base64 desktop capture arriving every few seconds for the whole
    /// session, including on cellular, whether or not anyone is looking.
    /// The reconnect resumes from the cursor, so nothing is missed.
    func watchScreen(of botId: String) {
        screenWatchers += 1
        if screenWatchers == 1 { restartStream() }
    }

    func stopWatchingScreen(of botId: String) {
        screenWatchers = max(0, screenWatchers - 1)
        if screenWatchers == 0 {
            state.clearScreen(botId)
            restartStream()
        }
    }

    /// Reopen the stream so its query string matches what we now want. The
    /// cursor survives, so this is a gap, not a reset.
    private func restartStream() {
        guard streamTask != nil else { return }
        stopStream()
        connect()
    }

    /// Called when the app leaves the screen. iOS will kill the connection
    /// anyway; dropping it deliberately means the cursor is written down at
    /// a known point instead of wherever the socket happened to die.
    func disconnect() {
        resetCredentialEntry()
        stopStream()
        saveRosterCache()
        endpointRefreshTask?.cancel()
        endpointRefreshTask = nil
        endLinger()
    }

    /// Written when the stream is put down on purpose — leaving the screen
    /// or switching computers — which is also when the folded state is at a
    /// known point. Forgetting a computer removes it after any such write.
    private func saveRosterCache() {
        guard let id = connection?.id, state.rosterLoaded else { return }
        RosterCache.save(CachedRoster(state: state), for: id)
    }

    private func resetCredentialEntry() {
        credentialEntryResetGeneration &+= 1
    }

    private var lingerTask: UIBackgroundTaskIdentifier = .invalid
    private var lingerSleep: Task<Void, Never>?

    /// Leaving the screen: keep the stream alive for the grace period iOS
    /// allows (~30 s) rather than cutting it at once, so an approval that
    /// lands right after you swipe home still reaches the Live Activity and
    /// the island. After that, iOS suspends us anyway; disconnect cleanly so
    /// the cursor is written down at a known point.
    func linger() {
        guard streamTask != nil, lingerTask == .invalid else { disconnect(); return }
        // A previous request can leave a sleeper behind when iOS refuses the
        // background assertion. Never let it outlive the assertion it belongs
        // to or disconnect a later linger window.
        lingerSleep?.cancel()
        lingerSleep = nil
        let task = UIApplication.shared.beginBackgroundTask(withName: "companion.linger") { [weak self] in
            // time is up before our own timer — the system wants us gone now
            self?.disconnect()
        }
        guard task != .invalid else { disconnect(); return }
        lingerTask = task
        lingerSleep = Task { [weak self] in
            try? await Task.sleep(for: .seconds(25))
            guard !Task.isCancelled, let self, self.lingerTask != .invalid else { return }
            self.disconnect()
        }
    }

    private func endLinger() {
        lingerSleep?.cancel()
        lingerSleep = nil
        guard lingerTask != .invalid else { return }
        UIApplication.shared.endBackgroundTask(lingerTask)
        lingerTask = .invalid
    }

    /// Fold what has been received, then cancel the stream. Flushing first
    /// keeps the cursor and the state in step: every frame that arrived is
    /// either folded with its seq, or was never received.
    private func stopStream() {
        flushFrames()
        activityFeedTask?.cancel()
        activityFeedTask = nil
        stopRemoteStreams()
        streamTask?.cancel()
        streamTask = nil
    }

    /// A fresh state belongs to a different stream; nothing buffered for the
    /// old one may land in it.
    private func resetState() {
        pendingFrames.removeAll()
        frameFlushTask?.cancel()
        frameFlushTask = nil
        deferredPublish?.cancel()
        deferredPublish = nil
        state = CompanionState()
        mascotCompletionIDs.removeAll()
        mascotLedgers.removeAll()
        mascotReplayCutoff = nil
    }

#if DEBUG
    /// Offline stand-in for a long run, for measuring the chat while it
    /// streams: a long history, then a reply typed at provider speed with a
    /// tool step every 700ms, all through the same batching as the wire.
    /// `-empty-thread-send-after n`: n seconds in, a message lands in
    /// Scout's empty thread and a turn starts, the way a real first send
    /// does, so the mascot's trip up into the header can be recorded.
    private func startEmptyThreadSendPreview(after seconds: Double) {
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(seconds))
            guard let self, var bot = self.state.bot("preview-scout") else { return }
            bot.busy = true
            bot.messages = nil
            self.state.apply(.bot(bot))
            let message: [String: Any] = ["id": "empty-send-1", "role": "user", "kind": "text",
                                          "at": Date().timeIntervalSince1970 * 1000, "text": "what changed in the testflight checklist"]
            if let data = try? JSONSerialization.data(withJSONObject: ["kind": "message", "threadId": bot.threadId, "message": message]),
               let frame = try? JSONDecoder().decode(StreamFrame.self, from: data) {
                self.state.apply(frame.frame)
            }
        }
    }

    private func startStreamPreview() {
        let threadId = "preview-gmail"
        func frame(_ json: [String: Any]) -> StreamFrame? {
            guard let data = try? JSONSerialization.data(withJSONObject: json) else { return nil }
            return try? JSONDecoder().decode(StreamFrame.self, from: data)
        }
        let paragraph = "Checked the **inbox** and grouped what matters: three invoices due this week, a contract redline from `legal@`, and two threads that need a reply today. "
        let start = Date().timeIntervalSince1970 * 1000
        // `-stream-preview-history 300`: a longer history, for the jump down
        let args = ProcessInfo.processInfo.arguments
        let history = args.firstIndex(of: "-stream-preview-history").flatMap { args.indices.contains($0 + 1) ? Int(args[$0 + 1]) : nil } ?? 50
        // chained onto the thread's active branch, or a threaded fixture hides it
        var parent = state.activeLeafIds[threadId] ?? state.bot(forThread: threadId)?.activeLeafId
        let branched = parent != nil
        for index in 0..<history {
            var message: [String: Any] = [
                "id": "stream-history-\(index)", "role": index % 2 == 0 ? "user" : "bot", "kind": "text",
                "at": start - Double(history - index) * 60_000,
                "text": index % 2 == 0 ? "check item \(index) and tell me what changed" : String(repeating: paragraph, count: 3) + "\n\n- one\n- two\n- three"
            ]
            if let parent { message["parentId"] = parent }
            parent = "stream-history-\(index)"
            if let seeded = frame(["kind": "message", "threadId": threadId, "message": message]) { state.apply(seeded.frame) }
        }
        if branched { state.activeLeafIds[threadId] = parent }
        Task { @MainActor [weak self] in
            // Start on the first keystroke so the test can reach the
            // composer while the app is still idle.
            while !MainThreadProbe.shared.isTyping && !ProcessInfo.processInfo.arguments.contains("-stream-preview-autostart") { try? await Task.sleep(for: .milliseconds(50)) }
            // without its stored messages, which would replace the history
            if let self, var bot = self.state.bot("preview-pepper") { bot.busy = true; bot.messages = nil; self.state.apply(.bot(bot)) }
            // Paragraphs and a short list, the shape a real long reply has.
            let reply = String(repeating: paragraph, count: 2) + "\n\n- first thing to check\n- second thing to check\n\n"
            let words = reply.split(separator: " ", omittingEmptySubsequences: false).map { $0 + " " }
            var seq = 1, tick = 0
            // `-stream-preview-seconds n`: stream longer, for slow ui tests
            let seconds = args.firstIndex(of: "-stream-preview-seconds").flatMap { args.indices.contains($0 + 1) ? Int(args[$0 + 1]) : nil } ?? 90
            let end = ContinuousClock.now + .seconds(seconds)
            while ContinuousClock.now < end, let self {
                tick += 1
                let delta = (0..<4).map { words[(tick * 4 + $0) % words.count] }.joined()
                if let token = frame(["kind": "runtime", "seq": seq, "event": ["type": "content.delta", "threadId": threadId, "streamKind": "assistant_text", "delta": delta]]) {
                    self.enqueue(token)
                }
                seq += 1
                if tick % 28 == 0, let step = frame(["kind": "message", "seq": seq, "threadId": threadId, "message": [
                    "id": "stream-step-\(tick)", "role": "bot", "kind": "activity", "at": Date().timeIntervalSince1970 * 1000,
                    "tool": ["name": "Bash", "ok": true, "summary": "grep -rn invoice mail/\(tick)"]
                ]]) {
                    self.enqueue(step)
                    seq += 1
                }
                try? await Task.sleep(for: .milliseconds(25))
            }
        }
    }

    /// `-room-preview -stream-preview-bots`: four bots at once, the load that
    /// lagged the phone. Two answer in the HQ room and two in their own 1:1s,
    /// each typing at provider speed with tool steps, item events and the
    /// room's active list changing as they go.
    /// A bot message landing in `threadId` now, for the roster reorder test.
    func debugPostMessage(threadId: String) {
        let json: [String: Any] = ["kind": "message", "threadId": threadId, "message": [
            "id": "debug-\(UUID().uuidString)", "role": "bot", "kind": "text",
            "at": Date().timeIntervalSince1970 * 1000, "text": "moved to the top"
        ]]
        guard let data = try? JSONSerialization.data(withJSONObject: json),
              let frame = try? JSONDecoder().decode(StreamFrame.self, from: data) else { return }
        state.apply(frame.frame)
    }

    /// `-stream-preview-bot-count 3`: drop the last 1:1 to measure three bots.
    private static var previewBotCount: Int {
        let args = ProcessInfo.processInfo.arguments
        guard let i = args.firstIndex(of: "-stream-preview-bot-count"), i + 1 < args.count else { return 4 }
        return Int(args[i + 1]) ?? 4
    }

    private func startMultiStreamPreview() {
        func frame(_ json: [String: Any]) -> StreamFrame? {
            guard let data = try? JSONSerialization.data(withJSONObject: json) else { return nil }
            return try? JSONDecoder().decode(StreamFrame.self, from: data)
        }
        let room = "room-thread-hq"
        // (thread, room member streaming there or nil for a 1:1, bot id)
        let streams: [(thread: String, roomBot: String?, bot: String)] = [
            (room, "room-dev", "room-dev"), (room, "room-pix", "room-pix"),
            ("room-thread-bos", nil, "room-bos"), ("room-thread-oracle", nil, "room-oracle")
        ].prefix(Self.previewBotCount).map { $0 }
        let paragraph = "Checked the **inbox** and grouped what matters: three invoices due this week, a contract redline from `legal@`, and two threads that need a reply today. "
        let start = Date().timeIntervalSince1970 * 1000
        // Every thread gets the same history whatever the bot count, so three
        // and four bots open the same transcripts.
        for thread in [room, "room-thread-bos", "room-thread-oracle"] {
            for index in 0..<60 {
                var message: [String: Any] = [
                    "id": "\(thread)-history-\(index)", "role": index % 2 == 0 ? "user" : "bot", "kind": "text",
                    "at": start - Double(60 - index) * 60_000,
                    "text": index % 2 == 0 ? "check item \(index) and tell me what changed" : String(repeating: paragraph, count: 3) + "\n\n- one\n- two\n- three"
                ]
                if thread == room, index % 2 == 1 { message["from"] = ["botId": streams[index / 2 % 2].bot, "name": "dev", "color": "blue"] }
                if let seeded = frame(["kind": "message", "threadId": thread, "message": message]) { state.apply(seeded.frame) }
            }
        }
        Task { @MainActor [weak self] in
            MainThreadProbe.shared.start()
            for stream in streams { if let self, var bot = self.state.bot(stream.bot) { bot.busy = true; self.state.apply(.bot(bot)) } }
            let reply = String(repeating: paragraph, count: 2) + "\n\n- first thing to check\n- second thing to check\n\n"
            let words = reply.split(separator: " ", omittingEmptySubsequences: false).map { $0 + " " }
            var seq = 1, tick = 0
            let end = ContinuousClock.now + .seconds(180)
            while ContinuousClock.now < end, let self {
                tick += 1
                for (n, stream) in streams.enumerated() {
                    var event: [String: Any] = ["type": "content.delta", "threadId": stream.thread, "streamKind": "assistant_text",
                                                "delta": (0..<4).map { words[(tick * 4 + $0 + n * 7) % words.count] }.joined()]
                    if let bot = stream.roomBot { event["roomBotId"] = bot }
                    if let token = frame(["kind": "runtime", "seq": seq, "event": event]) { self.enqueue(token) }
                    seq += 1
                    // Each bot runs a tool about every 700ms, staggered, and the
                    // server relays its item events alongside the step.
                    if (tick + n * 7) % 28 == 0 {
                        var item: [String: Any] = ["type": "item.started", "threadId": stream.thread]
                        if let bot = stream.roomBot { item["roomBotId"] = bot }
                        if let started = frame(["kind": "runtime", "seq": seq, "event": item]) { self.enqueue(started); seq += 1 }
                        var message: [String: Any] = [
                            "id": "\(stream.bot)-step-\(tick)", "role": "bot", "kind": "activity", "at": Date().timeIntervalSince1970 * 1000,
                            "tool": ["name": "Bash", "ok": true, "summary": "grep -rn invoice mail/\(tick)"]
                        ]
                        if let bot = stream.roomBot { message["from"] = ["botId": bot, "name": bot, "color": "blue"] }
                        if let step = frame(["kind": "message", "seq": seq, "threadId": stream.thread, "message": message]) { self.enqueue(step); seq += 1 }
                    }
                }
                try? await Task.sleep(for: .milliseconds(25))
            }
        }
    }
#endif

    private func enqueue(_ frame: StreamFrame) {
        pendingFrames.append(frame)
        if pendingFrames.count >= Self.frameBatchLimit {
            flushFrames()
            return
        }
        guard frameFlushTask == nil else { return }
        let now = ContinuousClock.now
        guard let last = lastFrameFlush, now - last < Self.frameBatchInterval else {
            flushFrames()
            return
        }
        frameFlushTask = Task { [weak self] in
            try? await Task.sleep(until: last + Self.frameBatchInterval, clock: .continuous)
            guard !Task.isCancelled else { return }
            self?.frameFlushTask = nil
            self?.flushFrames()
        }
    }

    /// Fold every pending frame, in order, as one state mutation.
    private func flushFrames() {
        frameFlushTask?.cancel()
        frameFlushTask = nil
        guard !pendingFrames.isEmpty else { return }
        lastFrameFlush = .now
        let batch = pendingFrames
        pendingFrames.removeAll(keepingCapacity: true)
        var next = state
        for frame in batch {
            if case let .runtime(event) = frame.frame,
               let cutoff = mascotReplayCutoff, let seq = frame.seq, seq > cutoff {
                let key = event.streamKey
                let active = event.type == "turn.started" || event.type == "content.delta"
                let completed = event.type == "turn.completed" && event.ok == true
                if mascotLedgers[key, default: MascotCompletionLedger()].observe(
                    turnID: event.turnId, active: active, completed: completed, hydration: false),
                   let turnID = event.turnId {
                    mascotCompletionIDs[key] = turnID
                }
            }
            next.apply(frame)
            next.advance(to: frame.seq)
        }
        let roomsChanged = batch.contains {
            switch $0.frame { case .room, .roomDeleted: return true; default: return false }
        }
        // A reply's first token starts the typing dot and its end stops it,
        // so which threads are typing has to be announced; the tokens in
        // between reach only the open bubble.
        let typingChanged = Self.typingThreads(in: next) != Self.typingThreads(in: state)
        let quiet = batch.allSatisfy(\.frame.isLiveTextOnly) && !typingChanged
        let now = ContinuousClock.now
        let held = !quiet && !typingChanged
            && lastLoudPublish.map { now - $0 < Self.loudPublishInterval } == true
        foldingQuietly = quiet || held
        state = next
        foldingQuietly = false
        if roomsChanged, let client { reconcileRemoteStreams(using: client) }
        if held {
            schedulePublish()
        } else if !quiet {
            lastLoudPublish = now
            deferredPublish?.cancel()
            deferredPublish = nil
        }
        let notices = batch.compactMap { frame -> (NotificationFrame, Int?)? in
            guard case let .notify(notification) = frame.frame else { return nil }
            return (notification, frame.seq)
        }
        if let connectionID = client?.connection.id {
            for index in NotificationPresentation.coalescedIndices(notices.map { ($0.0.threadId, $0.0.isBlocking) }) {
                let (notification, sequence) = notices[index]
                if notification.kind == "voice_work_done" {
                    // Asked out loud: it reports whatever the bot's switch
                    // says, except while that call is still live and says it.
                    if let callId = notification.callId, callId == VoiceCallCenter.shared.liveCallId {
                        Self.clearVoiceDone(callId: callId)
                        continue
                    }
                } else {
                    guard notificationEnabled(botId: notification.botId, threadId: notification.threadId) else { continue }
                }
                NotificationCoordinator.shared.deliver(notification, sequence: sequence, connectionId: connectionID,
                    requestId: notification.requestId, messageId: notification.messageId)
            }
        }
        for case let .voiceRing(ring) in batch.map(\.frame) {
            receivedRing(ring, connectionId: client?.connection.id)
        }
        applyBadge(state.unreadCount)
    }

    /// Announce a held fold once the interval since the last one is up.
    private func schedulePublish() {
        guard deferredPublish == nil, let last = lastLoudPublish else { return }
        deferredPublish = Task { [weak self] in
            try? await Task.sleep(until: last + Self.loudPublishInterval, clock: .continuous)
            guard !Task.isCancelled, let self else { return }
            self.deferredPublish = nil
            self.lastLoudPublish = .now
            self.objectWillChange.send()
        }
    }

    private static func typingThreads(in state: CompanionState) -> Set<String> {
        Set(state.streaming.lazy.filter { !$0.value.isEmpty }.map(\.key))
    }

    private func applyBadge(_ count: Int) {
        if isSatellite { primary?.refreshBadge(); return }
        let count = count + satellites.reduce(0) { $0 + $1.state.unreadCount }
        guard appliedBadge != count else { return }
        appliedBadge = count
        NotificationCoordinator.shared.setBadge(count)
    }

    private func run() async {
        while !Task.isCancelled {
            guard let client else { return }
            // Retrying a home that is down stays quiet: its bots already
            // sleep, and flipping offline → connecting every backoff would
            // pulse the banner and every face for nothing.
            if case .offline = status {} else { status = .connecting }
            // A server connection first checks it is still the same server.
            // The descriptor is public, so this spends no credential; a
            // changed environment id (the address now belongs to another
            // server, or its data directory was recreated) means "pair
            // again", exactly like a revoked token — the bearer would be
            // refused anyway, and a fresh install must not be shown the old
            // one. Unreachable is not "different": the stream attempt below
            // reports that the usual way.
            if let expected = client.connection.serverEnvironmentId {
                let live = try? await client.environment()
                if Task.isCancelled { return }
                if let live, live.environmentId != expected {
                    log.error("server identity changed: \(expected, privacy: .public) is now \(live.environmentId, privacy: .public)")
                    status = .unauthorized
                    return
                }
            }
            log.info("opening stream, cursor=\(self.state.cursor ?? "none", privacy: .public)")
            do {
                // The query is fixed when the connection opens, so changing
                // it means a new connection — `restartStream()` cancels this
                // task and starts another. Cancellation is the only exit;
                // breaking out here instead would fall through to the "the
                // harness went away" path and flash a lost-connection banner
                // on what is actually a deliberate reconnect.
                for try await frame in try client.events(since: state.cursor, screens: screenWatchers > 0) {
                    if Task.isCancelled { return }
                    reconnectDelay = 0

                    if case let .hello(cursor, resumed) = frame.frame {
                        // Hello names the current head: replayed events cannot celebrate.
                        mascotLedgers.removeAll()
                        mascotCompletionIDs.removeAll()
                        mascotReplayCutoff = cursor.split(separator: ":").last.flatMap { Int($0) }
                        log.info("stream live, resumed=\(resumed, privacy: .public)")
                        // false means the server could not replay the gap —
                        // the one case that costs a full hydrate. Commit the
                        // hello cursor only after that hydrate succeeds: if
                        // the request dies halfway through replay/hydration,
                        // reconnecting must still ask for the missing gap.
                        if !resumed {
                            try await hydrate(using: client)
                            state.resetCursor(cursor)
                        }
                        status = .live
                        // The next cold launch draws this roster at once,
                        // even if this computer is down by then.
                        if !resumed { saveRosterCache() }
                        failedDialsSinceLive = 0
                        // A push may have moved the badge while the stream
                        // was down; set it once from the live count.
                        appliedBadge = nil
                        applyBadge(state.unreadCount)
                        // Remember what actually carried the stream for
                        // display and legacy ordering. Typed routes retain
                        // their explicit security priority next launch.
                        rememberWorkingRoute()
                        refreshConnectionMetadata(using: client)
                        // Every hello, resumed or not: activity pushes may
                        // not be replayable, so a gap is closed by a snapshot.
                        refreshActivityFeed(using: client)
                        reconcileRemoteStreams(using: client)
                        if isSatellite, !satellitePushRegistered,
                           let token = UserDefaults.standard.string(forKey: "bos.apnsToken") {
                            satellitePushRegistered = true
                            await registerPushToken(token)
                        }
                        continue
                    }
                    enqueue(frame)
                }
                flushFrames()
                // the stream ended without an error — the harness went away
                log.notice("stream ended without an error")
                status = .offline(failureMessage(for: URLError(.networkConnectionLost)))
            } catch let error as APIError where error.isUnauthorized {
                log.error("stream refused: unauthorized")
                status = .unauthorized
                return
            } catch {
                // backgrounding cancels the stream on purpose; that is not a
                // failure to report, and it must not be retried
                if Task.isCancelled || error is CancellationError {
                    log.info("stream closed by us")
                    return
                }
                flushFrames()
                log.error("stream failed: \(error.localizedDescription, privacy: .public)")
                status = .offline(failureMessage(for: error))
            }

            if Task.isCancelled { return }
            // 1s, 2s, 4s… to 15s. A phone that woke on a network which is
            // not the laptop's should not hammer it.
            reconnectDelay = reconnectDelay == 0 ? 1 : min(reconnectDelay * 2, 15)
            try? await Task.sleep(nanoseconds: reconnectDelay * 1_000_000_000)
        }
    }

    // MARK: - Rooms on another home

    /// Open a stream for every home this computer joined a room on, and
    /// close the ones whose last room is gone. Only while the main stream
    /// runs: these frames are folded beside it, never on their own.
    private func reconcileRemoteStreams(using client: CompanionClient) {
        guard streamTask != nil else { return stopRemoteStreams() }
        let wanted = remoteRoomStreams(rooms: state.rooms)
        for (homeId, stream) in remoteStreams where wanted[homeId] == nil {
            stream.task.cancel()
            remoteStreams.removeValue(forKey: homeId)
        }
        for (homeId, groupId) in wanted where remoteStreams[homeId] == nil {
            remoteStreams[homeId] = (groupId, openRemoteStream(homeId: homeId, groupId: groupId, using: client))
        }
    }

    private func stopRemoteStreams() {
        for stream in remoteStreams.values { stream.task.cancel() }
        remoteStreams.removeAll()
    }

    /// The relayed stream belongs to the other home: its frames carry that
    /// home's sequence, so they fold without one and never move this
    /// computer's cursor. It cannot resume either, so every hello catches
    /// the joined rooms up from their newest page instead.
    private func openRemoteStream(homeId: String, groupId: String, using client: CompanionClient) -> Task<Void, Never> {
        Task { [weak self] in
            var delay: UInt64 = 0
            while !Task.isCancelled {
                if delay > 0 { try? await Task.sleep(nanoseconds: delay * 1_000_000_000) }
                if Task.isCancelled { return }
                do {
                    for try await frame in try client.roomEvents(groupId: groupId) {
                        guard !Task.isCancelled, let self else { return }
                        delay = 0
                        if case .hello = frame.frame {
                            await self.catchUpRemoteRooms(homeId: homeId, using: client)
                            continue
                        }
                        guard let scoped = remoteRoomFrame(rooms: self.state.rooms, homeId: homeId, frame: frame.frame) else { continue }
                        self.enqueue(StreamFrame(frame: scoped, seq: nil))
                    }
                } catch let APIError.status(code, _) where code == 401 || code == 403 || code == 404 {
                    // An older computer, or a session that may not relay:
                    // the room still refreshes on reopen, as before.
                    log.notice("remote room stream refused: \(code, privacy: .public)")
                    return
                } catch {
                    if Task.isCancelled || error is CancellationError { return }
                }
                delay = delay == 0 ? 2 : min(delay * 2, 30)
            }
        }
    }

    private func catchUpRemoteRooms(homeId: String, using client: CompanionClient) async {
        for room in state.rooms where room.home?.id == homeId {
            guard let page = try? await client.messages(threadId: room.threadId) else { continue }
            if Task.isCancelled { return }
            flushFrames()
            state.merge(page, intoThread: room.threadId)
        }
    }

    // MARK: - Activity feed seam
    //
    // SEAM: the server's activity feed enters the phone in exactly two places.
    //   1. Snapshot — `refreshActivityFeed(using:)` below, on every hello,
    //      GETting `activityFeedSnapshotPath`.
    //   2. Pushes — SSE frames whose `kind` is `activityFeedEventName`, which
    //      `Frame` decodes to `.activity` and `CompanionState.apply(_:)`
    //      folds through `enqueue`/`flushFrames` like any other frame.
    // Both names are declared once at the top of
    // CompanionCore/ActivityFeed.swift.

    /// Fetch the feed snapshot without holding up the stream. A server
    /// without the route (404/405), or any failure, leaves the feed as it is
    /// — empty on a fresh connection, so every face falls back to the bot
    /// and task records exactly as before the feed existed.
    private func refreshActivityFeed(using client: CompanionClient) {
        activityFeedTask?.cancel()
        let generation = streamGeneration
        activityFeedTask = Task { [weak self] in
            guard let self else { return }
            // Pushes already received count as folded, so the mark below
            // covers everything that arrives while the request is out.
            self.flushFrames()
            let mark = self.state.activityFeed.revision
            guard let entries = try? await client.activityFeedSnapshot() else { return }
            guard !Task.isCancelled, self.streamGeneration == generation,
                  self.client?.connection.id == client.connection.id else { return }
            self.flushFrames()
            // A pushed replacement that landed during the fetch is at least
            // as new as this response; applying it would resurrect lanes the
            // push already removed.
            guard self.state.activityFeed.revision == mark else { return }
            self.state.activityFeed.apply(snapshot: entries, preservingUpdatesAfter: mark)
            log.info("activity feed snapshot: \(entries.count, privacy: .public) entries")
        }
    }

    private func hydrate(using client: CompanionClient) async throws {
        let generation = streamGeneration
        // Notification navigation can refresh while run() continues folding
        // live events. Retry once if that makes the fetched snapshot stale.
        for _ in 0..<2 {
            // Buffered frames must count as folded here, or one received
            // during the fetch would not move the cursor and the
            // stale-snapshot check below could not see it.
            flushFrames()
            let expectedCursor = state.cursor
            let snapshot = try await client.fleetForHydration(messages: 50)
            try Task.checkCancellation()
            guard streamGeneration == generation, self.client?.connection.id == client.connection.id else {
                throw CancellationError()
            }
            flushFrames()
            guard state.hydrate(snapshot.fleet, waitingThreads: snapshot.waitingThreads,
                                ifCursorMatches: expectedCursor) else { continue }
            log.info("hydrated \(snapshot.fleet.bots.count, privacy: .public) bots, \(snapshot.fleet.groups.count, privacy: .public) rooms")
            applyBadge(state.unreadCount)
            if roomActorId == nil { Task { await loadRoomSelf(using: client) } }
            return
        }
        throw APIError.status(code: 409, message: "Conversations changed while loading. Please try opening this notification again.")
    }

    // MARK: - Which address to dial

    /// Turn a stream failure into advice a person can act on — and, when the
    /// failure is about the address rather than the pairing, move the dial to
    /// the next stored host so the retry that follows tries somewhere new.
    /// A 401 never reaches here: the unauthorized path returns above, which
    /// is what keeps a token problem from masquerading as an address walk.
    private func failureMessage(for error: Error) -> String {
        guard let connection else { return error.localizedDescription }
        let failed = rotation.currentEndpoint ?? connection.activeEndpoint ??
            CompanionEndpoint.direct(host: connection.host, port: connection.port, priority: 10_000)
        macMayBeAsleep = hostedLastKnownReady && Self.couldMeanMacAsleep(error)
        var next: String?
        if let candidate = rotation.advanceEndpoint(after: error), let token {
            client = CompanionClient(connection: connection.dialing(candidate), token: token)
            next = candidate.displayAddress
            log.info("advancing to companion route \(candidate.url, privacy: .public)")
        }
        // Every known route has now failed once. A hosted route the Mac
        // brought up since the last refresh is only learned by asking, so
        // ask through whichever route the walk is on — a route which answers
        // plain requests while its stream fails can still teach a better one.
        failedDialsSinceLive += 1
        if failedDialsSinceLive >= max(rotation.count, 1), let client {
            failedDialsSinceLive = 0
            refreshConnectionMetadata(using: client)
        }
        if let urlError = error as? URLError {
            return ConnectionAdvice.message(
                for: urlError.code,
                host: failed?.displayAddress ?? connection.host,
                port: failed?.port ?? connection.port,
                tryingNext: next
            )
        }
        if let apiError = error as? APIError,
           case let .status(code, _) = apiError,
           ConnectionAdvice.shouldTryAnotherRoute(after: error) {
            return ConnectionAdvice.message(
                forGatewayStatus: code,
                host: failed?.displayAddress ?? connection.host,
                tryingNext: next
            )
        }
        return error.localizedDescription
    }

    /// Persist the route that carried a live stream. Legacy host lists promote
    /// it for the next launch; typed lists keep their explicit policy order.
    private func rememberWorkingRoute() {
        guard let winner = rotation.currentEndpoint, var updated = connection,
              updated.activeEndpoint?.url != winner.url else { return }
        updated.promote(winner)
        persistActiveConnection(updated)
    }

    /// Whether the Mac was last known reachable from anywhere. The hosted
    /// route is advertised only after the tunnel passes its public health
    /// check, so a saved hosted endpoint stands in for a status not yet
    /// fetched this launch.
    private var hostedLastKnownReady: Bool {
        if let state = companionStatus?.hosted?.state, state != .unknown { return state == .ready }
        return connection?.orderedEndpoints.contains { $0.kind == .hosted } == true
    }

    /// Route-shaped failures: nothing answered, or a gateway answered for a
    /// Mac behind it that did not. A phone with no network at all, or a Mac
    /// that answered with an application error, is not a sleeping Mac.
    private static func couldMeanMacAsleep(_ error: Error) -> Bool {
        if let urlError = error as? URLError { return urlError.code != .notConnectedToInternet }
        return ConnectionAdvice.shouldTryAnotherRoute(after: error)
    }

    /// Learn routes enabled after this phone originally paired. The endpoint
    /// response is authenticated with the existing device token and is a
    /// replacement snapshot, but failure is deliberately non-fatal: older
    /// sidecars return 404 and a transient refresh error must not tear down a
    /// perfectly healthy event stream.
    ///
    /// The remote-access status rides along. While the Mac says its hosted
    /// route is coming up (or up) but no hosted endpoint has been advertised
    /// yet, keep asking at a slow pace: the phone paired on the home wifi
    /// must learn the hosted route before it leaves, not after.
    private func refreshConnectionMetadata(using sourceClient: CompanionClient) {
        // A server has no companion routes to advertise (`/api/companion/*`
        // is the sidecar's); its one address is the one that was paired.
        guard connection?.pairedWithServer != true, let connectionID = connection?.id else { return }
        let workingEndpoint = rotation.currentEndpoint ?? sourceClient.connection.activeEndpoint
        endpointRefreshTask?.cancel()
        endpointRefreshTask = Task { [weak self] in
            for attempt in 0..<Self.hostedRoutePollLimit {
                if attempt > 0 {
                    try? await Task.sleep(for: Self.hostedRoutePollInterval)
                }
                guard !Task.isCancelled else { return }
                var metadata: CompanionConnectionMetadata?
                do {
                    metadata = try await sourceClient.connectionMetadata()
                } catch is CancellationError {
                    return
                } catch {
                    log.debug("endpoint refresh unavailable: \(error.localizedDescription, privacy: .public)")
                }
                var fetchedStatus: CompanionStatus??
                do {
                    fetchedStatus = .some(try await sourceClient.companionStatus())
                } catch {
                    log.debug("companion status unavailable: \(error.localizedDescription, privacy: .public)")
                }
                guard !Task.isCancelled,
                      let self,
                      self.connection?.id == connectionID,
                      self.client?.connection.baseURL == sourceClient.connection.baseURL,
                      var updated = self.connection
                else { return }

                // A 404 is a known "unknown"; a transient error keeps the
                // last value rather than blanking the Settings row.
                if let fetchedStatus { self.companionStatus = fetchedStatus }
                if let metadata {
                    updated.reconcile(metadata)
                    self.persistActiveConnection(updated)

                    // Keep the currently live route first until this stream ends.
                    // CandidateRotation applies the same no-downgrade policy used
                    // by pairing, while the saved connection uses advertised
                    // security priorities on the next launch.
                    let liveRoutes = workingEndpoint.map { route in
                        [route] + updated.orderedEndpoints.filter { $0.url != route.url }
                    } ?? updated.orderedEndpoints
                    self.rotation = CandidateRotation(endpoints: liveRoutes)
                    log.info("refreshed \(metadata.endpoints.count, privacy: .public) companion routes")
                }

                let knowsHosted = updated.orderedEndpoints.contains { $0.kind == .hosted }
                let hostedState = self.companionStatus?.hosted?.state
                let hostedComing = hostedState == .provisioning || hostedState == .ready
                guard !knowsHosted, hostedComing, self.status == .live else { return }
            }
        }
    }

    private static let hostedRoutePollLimit = 10
    private static let hostedRoutePollInterval: Duration = .seconds(30)

    // MARK: - Network path

    private func startWatchingNetworkPath() {
        pathMonitor.pathUpdateHandler = { [weak self] path in
            let satisfied = path.status == .satisfied
            let local = path.usesInterfaceType(.wifi) || path.usesInterfaceType(.wiredEthernet)
            let signature = [
                satisfied, local, path.usesInterfaceType(.cellular), path.usesInterfaceType(.other),
            ].map(String.init).joined(separator: ",")
            Task { @MainActor [weak self] in
                self?.networkPathChanged(satisfied: satisfied, onLocalNetwork: local, signature: signature)
            }
        }
        pathMonitor.start(queue: DispatchQueue(label: "com.openmausbot.companion.path"))
    }

    /// Wifi to cellular, leaving the house, or the network coming back.
    ///
    /// A stream on a LAN, Bonjour or tailnet route may be dead without
    /// knowing it yet, and one waiting out backoff would wait for nothing:
    /// rebuild the walk for the new path and dial now. A live hosted stream
    /// is left alone — it is the route that survives a handoff, and the
    /// stream's own failure path covers the rare case it does not. The first
    /// report is not a change, except that a launch off the local network
    /// must not sit on a cleartext route that cannot answer.
    private func networkPathChanged(satisfied: Bool, onLocalNetwork local: Bool, signature: String) {
        for home in satellites {
            home.networkPathChanged(satisfied: satisfied, onLocalNetwork: local, signature: signature)
        }
        let previous = pathSignature
        pathSignature = signature
        onLocalNetwork = local
        guard satisfied, let connection, let token, client != nil else { return }
        let current = client?.connection.activeEndpoint
        let changed = previous != nil && previous != signature
        let stranded = !local && current?.protectsCredentials == false
        guard stranded || (changed && (status != .live || current?.kind != .hosted)) else { return }

        let walk = CandidateRotation(endpoints: connection.orderedEndpoints, onLocalNetwork: local)
        guard let first = walk.currentEndpoint,
              changed || first.url != current?.url
        else { return }
        log.info("network path changed; dialing \(first.url, privacy: .public)")
        rotation = walk
        failedDialsSinceLive = 0
        client = CompanionClient(connection: connection.dialing(first), token: token)
        // Off screen there is no stream to move; the next `connect()` dials
        // the new walk.
        guard streamTask != nil else { return }
        stopStream()
        connect()
    }

    /// Replace the stored address by hand, keeping the pairing and its token.
    /// False when the text does not parse as a host or host:port.
    @discardableResult
    func updateAddress(_ text: String) -> Bool {
        guard var updated = connection, let parsed = Connection.parse(text) else { return false }
        guard let endpoint = parsed.activeEndpoint ?? CompanionEndpoint.direct(
            host: parsed.host,
            port: parsed.port,
            priority: 0
        ) else { return false }
        updated.resetRoutePolicy(selecting: endpoint)
        persistActiveConnection(updated)
        rotation = CandidateRotation(endpoints: updated.orderedEndpoints)
        if let token {
            client = CompanionClient(connection: updated.dialing(endpoint), token: token)
        }
        // Dial the new address now rather than on the next backoff tick —
        // someone who just typed an address is watching the banner.
        restartStream()
        connect()
        return true
    }

    // MARK: - Actions
    //
    // Each of these does the thing and lets the event stream deliver the
    // result. Nothing here writes to `state` optimistically: the harness is
    // the source of truth, and a phone that draws its own version of events
    // is a phone that disagrees with the laptop.

    func send(_ text: String, to chat: Chat) async {
        let connectionID = client?.connection.id
        var receipt: SendReceipt?
        await perform {
            switch chat {
            case let .bot(bot): receipt = try await $0.send(text: text, toBot: bot.id, threadId: bot.threadId)
            case let .room(room): receipt = try await $0.send(text: text, toRoom: room.id)
            }
        }
        // The receipt describes a queue on the computer this request went
        // to. A machine switched mid-flight has already reset state for the
        // computer now on screen, and that row must not land in it.
        guard client?.connection.id == connectionID else { return }
        rememberQueuedSend(from: receipt, text: text)
    }

    /// Send a composer draft with app-owned attachments. The destination
    /// includes the exact active thread at tap time, so neither a desktop task
    /// switch nor an upload delay can move the message elsewhere. Callers only
    /// clear their draft when this returns true.
    func send(
        text: String,
        attachments: [PendingMessageAttachment],
        to chat: Chat,
        replyToId: String? = nil,
        priority: MessagePriority = .queue,
        durableSendID: String? = nil,
        uploadProgress: ((String, Int, Int) -> Void)? = nil
    ) async -> Bool {
        guard let client else {
            actionError = "This computer is offline."
            return false
        }
        let connectionID = client.connection.id
        actionError = nil
        do {
            try AttachmentPolicy.validate(attachments)
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty || !attachments.isEmpty else {
                actionError = "Write a message or attach a file first."
                return false
            }

            if attachments.contains(where: { $0.kind == .image }) {
                let capable: Set<String>
                do {
                    capable = try await client.imageCapableInstanceIDs()
                } catch APIError.status(code: 404, message: _) {
                    actionError = "Update BOS on this computer before sending images."
                    return false
                }
                guard imageSupported(by: chat, capableInstances: capable) else {
                    actionError = imageCompatibilityMessage(for: chat)
                    return false
                }
            }

            let destination = chat.destination
            let draftKey = AttachmentDraftKey(
                destination: destination,
                text: text,
                attachmentIDs: attachments.map(\.id),
                replyToId: replyToId
            )
            if attachmentSendIDs.count >= 20, attachmentSendIDs[draftKey] == nil {
                attachmentSendIDs.removeAll(keepingCapacity: true)
            }
            let sendID = durableSendID ?? attachmentSendIDs[draftKey] ?? UUID().uuidString
            attachmentSendIDs[draftKey] = sendID

            var uploaded: [SharedAttachmentReference] = []
            uploaded.reserveCapacity(attachments.count)
            for (index, attachment) in attachments.enumerated() {
                uploadProgress?(attachment.name, index, attachments.count)
                try Task.checkCancellation()
                let mime = AttachmentPolicy.normalizedMIME(attachment.mime)
                switch attachment.kind {
                case .image:
                    let path = try await client.uploadImage(
                        data: attachment.data,
                        mime: mime,
                        uploadId: attachment.id.uuidString
                    )
                    uploaded.append(SharedAttachmentReference(
                        path: path,
                        kind: .image,
                        displayName: attachment.name
                    ))
                case .file:
                    let file = try await client.uploadFile(
                        data: attachment.data,
                        name: attachment.name,
                        mime: mime,
                        uploadId: attachment.id.uuidString
                    )
                    uploaded.append(SharedAttachmentReference(
                        path: file.path,
                        kind: .file,
                        displayName: file.name
                    ))
                }
            }

            uploadProgress?("Sending message", attachments.count, attachments.count)
            let message = SharedMessageComposer.compose(
                instruction: text,
                text: [],
                urls: [],
                attachments: uploaded
            )
            let receipt = try await client.send(text: message, to: destination, sendId: sendID, replyToId: replyToId, priority: priority)
            // The send succeeded on the computer it was addressed to, so the
            // draft clears either way. Its queue row belongs to that computer,
            // and must not be drawn on one selected mid-upload.
            if self.client?.connection.id == connectionID {
                rememberQueuedSend(from: receipt, text: text)
            }
            attachmentSendIDs.removeValue(forKey: draftKey)
            actionError = nil
            return true
        } catch is CancellationError {
            return false
        } catch let error as APIError where error.isUnauthorized {
            status = .unauthorized
            actionError = error.localizedDescription
            return false
        } catch {
            actionError = error.localizedDescription
            return false
        }
    }

    /// No unpairing, retrying or draft changes here: the failed write already
    /// reported the friendly error, and the banner says why from now on.
    private func noteWriteAuthority(_ event: WriteAuthority, connectionID: String) {
        setLegacyArchived(event == .moved, connectionID: connectionID)
    }

    private func setLegacyArchived(_ archived: Bool, connectionID: String) {
        guard legacyArchivedIDs.contains(connectionID) != archived else { return }
        if archived { legacyArchivedIDs.insert(connectionID) } else { legacyArchivedIDs.remove(connectionID) }
        UserDefaults.standard.set(legacyArchivedIDs.sorted(), forKey: Self.legacyArchivedKey)
    }

    // MARK: Voice calls

    /// Mint a realtime voice call for a bot. Throws the server's own message
    /// (409 means no xAI key on the computer).
    func startVoiceCall(botId: String, language: String?, callId: String) async throws -> VoiceCallStart {
        guard let client else { throw APIError.transport("This computer is offline.") }
        return try await client.voiceCall(botId: botId, language: language, callId: callId)
    }

    /// Book how long a call was connected. Best effort: a miss only leaves
    /// that call "without a length" in Settings → Usage.
    func reportVoiceCallUsage(callId: String, seconds: Int) {
        guard let client else { return }
        Task { try? await client.reportVoiceCallUsage(callId: callId, seconds: seconds) }
    }

    /// A `send_task` from a voice call, posted into the bot's thread as the
    /// caller's words with the call's origin, the model's restatement as
    /// `job`. Returns nil on success or the failure text; it never touches
    /// `actionError`, because the call reports failures out loud.
    func sendFromVoiceCall(_ text: String, job: String, callId: String, botId: String, threadId: String) async -> String? {
        guard let client else { return "This computer is offline." }
        let connectionID = client.connection.id
        do {
            let receipt = try await client.send(text: text, toBot: botId, threadId: threadId,
                                                origin: .voiceCall(callId: callId, job: job))
            if self.client?.connection.id == connectionID { rememberQueuedSend(from: receipt, text: text) }
            return nil
        } catch {
            return error.localizedDescription
        }
    }

    /// The harness's answer to a send, when it held the message instead of
    /// delivering it. This is wire state, not optimism: the row exists
    /// because the computer said it does, identified by its queueId.
    private func rememberQueuedSend(from receipt: SendReceipt?, text: String) {
        guard let receipt, receipt.queued == true,
              let queueId = receipt.queueId, let threadId = receipt.threadId
        else { return }
        state.rememberQueued(
            QueuedSend(
                queueId: queueId,
                text: text,
                reason: receipt.reason == "capacity" ? "capacity" : nil
            ),
            threadId: threadId
        )
    }

    /// Take back a held message. The row only goes when the computer agrees;
    /// an entry that already drained counts as agreement.
    func setThreadSettlement(days: Int) async {
        await perform { _ = try await $0.setThreadSettlement(days: days) }
    }

    func steerQueued(_ send: QueuedSend, threadId: String, in chat: Chat, botId: String? = nil) async {
        let destination: MessageDestination
        switch chat {
        case let .bot(bot): destination = .bot(id: bot.id, threadId: threadId)
        case let .room(room): destination = .room(id: room.id, threadId: threadId)
        }
        await perform { try await $0.steerQueued(queueId: send.queueId, to: destination, botId: botId) }
    }

    func cancelQueued(_ send: QueuedSend, threadId: String, in chat: Chat) async {
        let connectionID = client?.connection.id
        let destination: MessageDestination
        switch chat {
        case let .bot(bot): destination = .bot(id: bot.id, threadId: threadId)
        case let .room(room): destination = .room(id: room.id, threadId: threadId)
        }
        var agreed = false
        await perform {
            try await $0.cancelQueued(queueId: send.queueId, to: destination)
            agreed = true
        }
        // The cancel landed on the computer that owned the row. One selected
        // mid-request has already reset state; its rows are not this cancel's
        // to retire.
        if agreed, client?.connection.id == connectionID {
            state.cancelQueued(queueId: send.queueId, threadId: threadId)
        }
    }

    /// Replaces one held send's text in place. Errors come back to the
    /// editor rather than the global banner, so the edit stays on screen and
    /// nothing is ever re-sent as a new message.
    func editQueued(_ send: QueuedSend, threadId: String, in chat: Chat, text: String) async -> Result<QueuedSend, QueuedSendEditError> {
        guard let client else { return .failure(.failed(String(localized: "Not connected to the computer."))) }
        let connectionID = client.connection.id
        let destination: MessageDestination
        switch chat {
        case let .bot(bot): destination = .bot(id: bot.id, threadId: threadId)
        case let .room(room): destination = .room(id: room.id, threadId: threadId)
        }
        do {
            try await client.editQueued(queueId: send.queueId, to: destination, expectedText: send.text, text: text)
            var updated = send
            updated.text = text
            // A computer selected mid-request has already reset state; this
            // edit belongs to the row it came from only.
            if self.client?.connection.id == connectionID {
                state.applyQueuedEdit(updated, threadId: threadId)
            }
            return .success(updated)
        } catch let error as APIError where error.isUnauthorized {
            status = .unauthorized
            return .failure(.unauthorized)
        } catch {
            return .failure(.from(error))
        }
    }

    private func imageSupported(by chat: Chat, capableInstances: Set<String>) -> Bool {
        switch chat {
        case let .bot(bot):
            return capableInstances.contains(bot.currentTaskModelSelection.instanceId)
        case let .room(room):
            return !room.memberIds.isEmpty && room.memberIds.allSatisfy { id in
                guard let bot = state.bot(id) else { return false }
                return capableInstances.contains(bot.modelSelection.instanceId)
            }
        }
    }

    private func imageCompatibilityMessage(for chat: Chat) -> String {
        switch chat {
        case let .bot(bot):
            return "\(bot.name)'s current model doesn't support images. Choose another model or remove the image."
        case .room:
            return "Every bot that may answer in this channel must use a model that supports images."
        }
    }

    /// Fetch one app-owned attachment through the message that introduced it.
    /// The caller owns presentation errors so a failed thumbnail or preview can
    /// explain itself beside the attachment that was tapped.
    func fetchAttachment(
        threadId: String,
        messageId: String,
        path: String,
        cacheResult: Bool = false
    ) async throws -> DownloadedFile {
        guard let client else {
            throw APIError.transport("This computer is offline.")
        }
        let cacheKey = "\(threadId)\u{1F}\(messageId)\u{1F}\(path)"
        if cacheResult,
           let cached = attachmentCache.object(forKey: cacheKey as NSString) {
            return cached.value
        }
        let generation = attachmentCacheGeneration
        do {
            // Keep this structured. When the row scrolls away SwiftUI cancels
            // its task, which now propagates directly into URLSession instead
            // of leaving a shared unstructured download running.
            let download = try await client.downloadFile(
                threadId: threadId,
                messageId: messageId,
                path: path
            )
            try Task.checkCancellation()
            guard generation == attachmentCacheGeneration else { throw CancellationError() }
            if cacheResult {
                attachmentCache.setObject(
                    CachedAttachmentDownload(download),
                    forKey: cacheKey as NSString,
                    cost: download.data.count
                )
            }
            return download
        } catch let error as APIError where error.isUnauthorized {
            // A cancelled request from the previous computer may finish after
            // a switch. Its 401 belongs to that old token and must not evict
            // the current live session.
            guard generation == attachmentCacheGeneration, !Task.isCancelled else {
                throw CancellationError()
            }
            status = .unauthorized
            throw error
        } catch {
            if Task.isCancelled || generation != attachmentCacheGeneration {
                throw CancellationError()
            }
            throw error
        }
    }

    /// Fetch and materialize an attachment in a protected temporary directory
    /// for Quick Look, markdown/text preview, and the system share sheet.
    func prepareAttachmentPreview(
        threadId: String,
        messageId: String,
        path: String,
        cacheResult: Bool = false
    ) async throws -> DownloadedFile {
        let download = try await fetchAttachment(
            threadId: threadId,
            messageId: messageId,
            path: path,
            cacheResult: cacheResult
        )
        try Task.checkCancellation()
        let preparation = Task.detached(priority: .userInitiated) {
            // Content-Disposition is the server's canonical, sanitised name.
            // The transport tag's `name` is presentation-only and must never
            // choose the on-disk preview/share filename.
            try Self.materializePreview(download: download, filename: download.filename)
        }
        let prepared = try await withTaskCancellationHandler {
            try await preparation.value
        } onCancel: {
            preparation.cancel()
        }
        do {
            try Task.checkCancellation()
            return prepared
        } catch {
            Self.removePreview(at: prepared.localURL)
            throw error
        }
    }

    /// Compatibility for file links in assistant markdown. User attachment
    /// cards use the throwing API above so their feedback remains local.
    func downloadFile(
        threadId: String,
        messageId: String,
        path: String
    ) async -> DownloadedFile? {
        actionError = nil
        do {
            let download = try await prepareAttachmentPreview(
                threadId: threadId,
                messageId: messageId,
                path: path
            )
            actionError = nil
            return download
        } catch is CancellationError {
            return nil
        } catch {
            actionError = error.localizedDescription
            return nil
        }
    }

    private func resetAttachmentCache() {
        attachmentCacheGeneration += 1
        attachmentCache.removeAllObjects()
    }

    nonisolated private static func materializePreview(
        download: DownloadedFile,
        filename: String
    ) throws -> DownloadedFile {
        let manager = FileManager.default
        let root = manager.temporaryDirectory
            .appendingPathComponent("BOSFilePreviews", isDirectory: true)
        let directory = root.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try Task.checkCancellation()
        try manager.createDirectory(
            at: directory,
            withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]
        )
        let fileURL = directory.appendingPathComponent(filename, isDirectory: false)
        do {
            try download.data.write(
                to: fileURL,
                options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication]
            )
            try Task.checkCancellation()
            return DownloadedFile(
                data: download.data,
                filename: filename,
                contentType: download.contentType,
                localURL: fileURL
            )
        } catch {
            try? manager.removeItem(at: directory)
            throw error
        }
    }

    nonisolated private static func removePreview(at fileURL: URL?) {
        guard let fileURL else { return }
        try? FileManager.default.removeItem(at: fileURL.deletingLastPathComponent())
    }

    private static func removeStaleFilePreviews() {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("BOSFilePreviews", isDirectory: true)
        try? FileManager.default.removeItem(at: root)
    }

    func answer(chat: Chat, card: OptionCard, choice: String, rememberingPermission: Bool = true) async {
        guard let requestId = card.requestId else { return }
        // A bot on another Mac refuses always-allow; its answer is one-off only.
        if rememberingPermission, card.shouldRememberPermission(for: choice), case let .bot(bot) = chat, bot.remote == nil {
            await alwaysAllow(bot: bot, card: card)
        }
        await answer(
            threadId: chat.threadId,
            requestId: requestId,
            choice: choice,
            isPermission: card.isPermission,
            reviewedSha256: card.skillRequest?.reviewedSha256
        )
    }

    /// Synchronously seal a credential before the caller starts an async
    /// request. The caller can then erase its input immediately and retain
    /// only this ciphertext value for an exact, idempotent retry.
    func prepareCredential(
        _ value: String,
        chat: Chat,
        message: Message,
        secret: SecretRequestCardData
    ) throws -> PreparedPhoneCredential {
        guard let client, let connection else {
            throw APIError.transport("This computer is offline.")
        }
        guard let publicKey = connection.secretPublicKey,
              let deviceId = connection.companionDeviceId,
              let target = secret.target,
              let requestKey = secret.requestKey
        else { throw PhoneSecretError.unavailable }
        guard client.connection.activeEndpoint?.protectsCredentials == true else {
            throw PhoneSecretError.insecureTransport
        }

        let botId = try credentialBotID(chat: chat, message: message)
        let context = PhoneSecretRequestContext(
            deviceId: deviceId,
            botId: botId,
            threadId: chat.threadId,
            messageId: message.id,
            target: target,
            requestKey: requestKey
        )
        let keyId = try PhoneSecretCrypto.publicKeyId(publicKey)
        let requestIdentity = phoneCredentialRequestIdentity(
            connectionID: connection.id,
            botID: botId,
            context: context,
            keyID: keyId
        )
        if let prepared = preparedPhoneCredentials[requestIdentity] {
            return prepared
        }
        let envelope = try PhoneSecretCrypto.encrypt(
            value,
            publicKey: publicKey,
            context: context
        )

        let prepared = PreparedPhoneCredential(
            requestIdentity: requestIdentity,
            connectionID: connection.id,
            botID: botId,
            messageID: message.id,
            envelope: envelope
        )
        preparedPhoneCredentials[requestIdentity] = prepared
        return prepared
    }

    /// Recover an ambiguous ciphertext-only operation when a card view is
    /// recreated. This is deliberately in-memory: a force-quit forgets it,
    /// while ordinary navigation, AutoFill, and reconnects do not.
    func preparedCredential(
        chat: Chat,
        message: Message,
        secret: SecretRequestCardData
    ) -> PreparedPhoneCredential? {
        guard let connection,
              let publicKey = connection.secretPublicKey,
              let deviceId = connection.companionDeviceId,
              let target = secret.target,
              let requestKey = secret.requestKey,
              let botId = try? credentialBotID(chat: chat, message: message),
              let keyId = try? PhoneSecretCrypto.publicKeyId(publicKey)
        else { return nil }
        let context = PhoneSecretRequestContext(
            deviceId: deviceId,
            botId: botId,
            threadId: chat.threadId,
            messageId: message.id,
            target: target,
            requestKey: requestKey
        )
        return preparedPhoneCredentials[phoneCredentialRequestIdentity(
            connectionID: connection.id,
            botID: botId,
            context: context,
            keyID: keyId
        )]
    }

    func discardPreparedCredential(_ prepared: PreparedPhoneCredential) {
        if preparedPhoneCredentials[prepared.requestIdentity] == prepared {
            preparedPhoneCredentials.removeValue(forKey: prepared.requestIdentity)
        }
    }

    private func credentialBotID(chat: Chat, message: Message) throws -> String {
        switch chat {
        case let .bot(bot): return bot.id
        case .room:
            guard let sender = message.from?.botId else {
                throw PhoneSecretError.invalidRequest
            }
            return sender
        }
    }

    private func phoneCredentialRequestIdentity(
        connectionID: String,
        botID: String,
        context: PhoneSecretRequestContext,
        keyID: String
    ) -> String {
        [
            connectionID,
            keyID,
            botID,
            context.threadId,
            context.messageId,
            context.target,
            context.requestKey,
        ].joined(separator: "\u{0}")
    }

    /// Send one already-sealed operation. A retry deliberately reuses the
    /// same HPKE envelope; the desktop derives its idempotency key from these
    /// bytes, so a lost response cannot cause a second provider save.
    func provideCredential(_ prepared: PreparedPhoneCredential) async throws {
        guard let client, let connection else {
            throw APIError.transport("This computer is offline.")
        }
        guard connection.id == prepared.connectionID,
              connection.companionDeviceId == prepared.envelope.deviceId,
              let publicKey = connection.secretPublicKey,
              (try? PhoneSecretCrypto.publicKeyId(publicKey)) == prepared.envelope.keyId
        else { throw PhoneSecretError.unavailable }
        guard client.connection.activeEndpoint?.protectsCredentials == true else {
            throw PhoneSecretError.insecureTransport
        }

        do {
            try await client.provideCredential(
                botId: prepared.botID,
                messageId: prepared.messageID,
                envelope: prepared.envelope
            )
        } catch let error as APIError where error.isUnauthorized {
            status = .unauthorized
            throw error
        }
    }

    /// The same answer, from something that only has the ids — the Live
    /// Activity's buttons.
    func answer(
        threadId: String,
        requestId: String,
        choice: String,
        isPermission: Bool,
        reviewedSha256: String? = nil
    ) async {
        await perform {
            // Permission cards answer allow/deny; a question answers with
            // the chosen text. The harness tells them apart by `behavior`.
            let behavior = OptionCard.responseBehavior(for: choice, isPermission: isPermission)
            if behavior != "answer" {
                try await $0.respond(
                    threadId: threadId,
                    requestId: requestId,
                    behavior: behavior,
                    reviewedSha256: behavior == "allow" ? reviewedSha256 : nil
                )
            } else {
                try await $0.respond(threadId: threadId, requestId: requestId, behavior: "answer", message: choice)
            }
        }
    }

    /// "Always allow" — the grant key comes from the card, never from
    /// anything derived here, so the phone and the harness cannot disagree
    /// about what was just permitted.
    func alwaysAllow(bot: Bot, card: OptionCard) async {
        guard let key = card.allowKey else { return }
        await perform { try await $0.alwaysAllow(botId: bot.id, key: key, threadId: bot.threadId) }
    }

    /// Make a new bot. The harness chooses its name, colour and greeting, so
    /// one made here is indistinguishable from one made on the desktop.
    ///
    /// Creating a bot does not broadcast — the desktop adds it optimistically
    /// too — so the new bot is folded in here rather than waited for. Return
    /// it so the caller can open it, which is the only reason anyone taps the
    /// button.
    @discardableResult
    func createBot() async -> Bot? {
        guard let client else { return nil }
        do {
            let bot = try await client.createBot()
            state.apply(.bot(bot))
            return bot
        } catch {
            actionError = error.localizedDescription
            return nil
        }
    }

    /// Make a room from the phone. Same shape as `createBot`: fold it in
    /// rather than wait for a broadcast, and hand it back so it can be opened.
    @discardableResult
    func createRoom(name: String?, memberIds: [String]) async -> Room? {
        guard let client else { return nil }
        do {
            let room = try await client.createRoom(name: name, memberIds: memberIds)
            state.apply(.room(room))
            return room
        } catch {
            actionError = error.localizedDescription
            return nil
        }
    }

    /// Create a sidebar section by assigning its complete starting set in one
    /// request. The server commits the batch before returning, then these
    /// folds make the roster move immediately instead of waiting for SSE.
    @discardableResult
    func assignSection(name: String, botIds: [String]) async -> [Bot]? {
        guard let client else { return nil }
        do {
            let bots = try await client.assignSection(name: name, botIds: botIds)
            for bot in bots { state.apply(.bot(bot)) }
            return bots
        } catch {
            actionError = error.localizedDescription
            return nil
        }
    }

    func interrupt(bot: Bot) async {
        await perform { try await $0.interrupt(botId: bot.id, threadId: bot.threadId) }
    }

    /// Stop from the Live Activity, which knows the thread but not the bot's
    /// current selection.
    func interrupt(botId: String, threadId: String) async {
        await perform { try await $0.interrupt(botId: botId, threadId: threadId) }
    }

    func refreshInterruptedTurns() async {
        await perform(quietly: true) { client in
            let turns = try await client.interruptedTurns()
            self.interruptedTurns = turns
        }
    }

    func resume(_ recovery: TurnRecovery) async {
        await perform { try await $0.resumeTurn(recovery) }
        await refreshInterruptedTurns()
    }

    func resumeAll() async {
        let turns = interruptedTurns
        await perform { try await $0.resumeAllTurns(turns) }
        await refreshInterruptedTurns()
    }

    /// Ask for one fresh cloud viewer URL. Unlike ordinary actions this
    /// returns the value to a browser sheet and never writes it to app state.
    func cloudDesktop(for bot: Bot) async throws -> URL {
        guard let client else { throw APIError.transport("This computer is offline.") }
        do {
            return try await client.cloudDesktop(botId: bot.id).url
        } catch let error as APIError where error.isUnauthorized {
            status = .unauthorized
            throw error
        }
    }

    func markRead(_ chat: Chat) async {
        await perform(quietly: true) {
            switch chat {
            case let .bot(bot): try await $0.markRead(botId: bot.id, threadId: bot.threadId)
            case let .room(room): try await $0.markRead(roomId: room.id)
            }
        }
    }

    func loadOlder(threadId: String) async {
        guard let client, let oldest = state.transcript(forThread: threadId).first else { return }
        do {
            let page = try await client.messages(threadId: threadId, before: oldest.id, limit: 50)
            state.prepend(page, toThread: threadId)
        } catch {
            actionError = error.localizedDescription
        }
    }

    /// A pinned background thread may not be in a fresh fleet snapshot.
    func loadThreadIfNeeded(_ threadId: String) async {
        guard let client, !state.hasLoadedPage(forThread: threadId) else { return }
        do {
            let page = try await client.messages(threadId: threadId)
            state.merge(page, intoThread: threadId)
        } catch { if !Task.isCancelled { actionError = error.localizedDescription } }
    }

    func image(threadId: String, messageId: String) async -> Data? {
        try? await client?.image(threadId: threadId, messageId: messageId)
    }

    func search(_ query: String) async -> [SearchHit] {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count >= 2, let client else { return [] }
        do { return try await client.search(trimmed) }
        catch {
            actionError = error.localizedDescription
            return []
        }
    }

    /// Resolve a SQLite search hit into the live task/branch, load a page
    /// around it, and hand navigation the current chat record.
    func open(_ hit: SearchHit) async -> Chat? {
        guard let client else { return nil }
        do {
            if let botId = hit.botId, var bot = state.bot(botId) {
                if bot.threadId != hit.threadId {
                    bot = try await client.switchTask(botId: bot.id, threadId: hit.threadId)
                    state.apply(.bot(bot))
                }
                if !hit.onActivePath {
                    let leaf = try await client.setActiveBranch(botId: bot.id, messageId: hit.messageId, threadId: hit.threadId)
                    state.apply(.thread(threadId: hit.threadId, activeLeafId: leaf))
                }
                let page = try await client.messages(threadId: hit.threadId, around: hit.messageId)
                state.merge(page, intoThread: hit.threadId)
                focusedMessageId = hit.messageId
                return state.bot(forThread: hit.threadId).map(Chat.bot)
            }
            if let groupId = hit.groupId,
               var room = state.rooms.first(where: { $0.id == groupId }) {
                if room.threadId != hit.threadId {
                    room = try await client.switchTask(groupId: room.id, threadId: hit.threadId)
                    state.apply(.room(room))
                }
                let page = try await client.messages(threadId: hit.threadId, around: hit.messageId)
                state.merge(page, intoThread: hit.threadId)
                focusedMessageId = hit.messageId
                return state.rooms.first(where: { $0.id == groupId }).map(Chat.room)
            }
        } catch { actionError = error.localizedDescription }
        return nil
    }

    func consumeFocus(_ messageId: String) {
        if focusedMessageId == messageId { focusedMessageId = nil }
    }

    @discardableResult
    func createTask(for bot: Bot, title: String?) async -> Bot? {
        guard let client else { return nil }
        do {
            let updated = try await client.createTask(botId: bot.id, title: title)
            state.apply(.bot(updated))
            return updated
        } catch { actionError = error.localizedDescription; return nil }
    }

    @discardableResult
    func switchTask(_ task: BotTask, for bot: Bot) async -> Bot? {
        guard let client else { return nil }
        do {
            let updated = try await client.switchTask(botId: bot.id, threadId: task.threadId)
            state.apply(.bot(updated))
            return updated
        } catch { actionError = error.localizedDescription; return nil }
    }

    @discardableResult
    func renameTask(_ task: BotTask, for bot: Bot, title: String) async -> Bool {
        guard let client else { return false }
        do {
            try await client.renameTask(botId: bot.id, threadId: task.threadId, title: title)
            await refresh()
            return true
        } catch { actionError = error.localizedDescription; return false }
    }

    @discardableResult
    func setTaskArchived(_ task: BotTask, for bot: Bot, archivedAt: Double?, animation: Animation? = nil) async -> Bool {
        guard let client else { return false }
        // Optimistic: the row leaves (or joins) the list now. The server's
        // broadcast and the refresh below settle the real state, and a failed
        // write puts the previous record back.
        let previous = state.bot(bot.id)
        if var optimistic = previous,
           let index = optimistic.tasks?.firstIndex(where: { $0.threadId == task.threadId }) {
            optimistic.tasks?[index].archivedAt = archivedAt
            withAnimation(animation) { state.apply(.bot(optimistic)) }
        }
        do {
            try await client.archiveTask(botId: bot.id, threadId: task.threadId, archivedAt: archivedAt)
            await refresh()
            return true
        } catch {
            if let previous { state.apply(.bot(previous)) }
            actionError = error.localizedDescription
            return false
        }
    }

    @discardableResult
    func deleteTask(_ task: BotTask, for bot: Bot) async -> Bot? {
#if DEBUG
        // The native UI fixture has no paired client. This explicit launch
        // mode exercises list updates and a partial batch failure entirely
        // offline, without touching a person's conversations.
        let arguments = ProcessInfo.processInfo.arguments
        if arguments.contains("-threads-preview-deletion"),
           var updated = state.bot(bot.id),
           task.threadId != bot.threadId,
           updated.visibleTasks.contains(where: { $0.threadId == task.threadId && !$0.isWorking }) {
            if arguments.contains("-threads-preview-deletion-fails-weekend")
                && task.threadId == "preview-weekend" {
                actionError = "Synthetic deletion failure"
                return nil
            }
            updated.tasks?.removeAll { $0.threadId == task.threadId }
            state.apply(.bot(updated))
            return updated
        }
#endif
        guard let client else { return nil }
        do {
            let updated = try await client.deleteTask(botId: bot.id, threadId: task.threadId)
            state.apply(.bot(updated))
            return updated
        } catch { actionError = error.localizedDescription; return nil }
    }

    @discardableResult
    func createTask(for room: Room, title: String?) async -> Bool {
        guard let client else { return false }
        do { state.apply(.room(try await client.createTask(groupId: room.id, title: title))); return true }
        catch { actionError = error.localizedDescription; return false }
    }

    @discardableResult
    func switchTask(_ task: BotTask, for room: Room) async -> Bool {
        guard task.threadId != room.threadId else { return true }
        guard let client else { return false }
        do { state.apply(.room(try await client.switchTask(groupId: room.id, threadId: task.threadId))); return true }
        catch { actionError = error.localizedDescription; return false }
    }

    @discardableResult
    func renameTask(_ task: BotTask, for room: Room, title: String) async -> Bool {
        guard let client else { return false }
        do {
            try await client.renameTask(groupId: room.id, threadId: task.threadId, title: title)
            await refresh()
            return true
        } catch { actionError = error.localizedDescription; return false }
    }

    @discardableResult
    func deleteTask(_ task: BotTask, for room: Room) async -> Bool {
        guard let client else { return false }
        do { state.apply(.room(try await client.deleteTask(groupId: room.id, threadId: task.threadId))); return true }
        catch { actionError = error.localizedDescription; return false }
    }

    // MARK: - Agent profile

    /// The model catalog lives on the paired computer because availability
    /// depends on which engines are installed and signed in there.
    func modelInstances() async -> [Instance] {
        guard let client else { return [] }
        do {
            return try await client.instances()
        } catch {
            if !Task.isCancelled { actionError = error.localizedDescription }
            return []
        }
    }

    func updateModel(_ selection: ModelSelection, for bot: Bot, resetApprovalToAsk: Bool = false, needsConfirmation: (() -> Void)? = nil) async -> Bot? {
        guard let client else { return nil }
        do {
            let updated = try await client.updateModel(botId: bot.id, selection: selection, threadId: bot.threadId, resetApprovalToAsk: resetApprovalToAsk)
            guard !Task.isCancelled else { return nil }
            state.apply(.bot(updated))
            return updated
        } catch {
            if !Task.isCancelled, !resetApprovalToAsk,
               case let APIError.status(code, message) = error,
               code == 400, message?.contains("(resetApprovalToAsk)") == true,
               let needsConfirmation {
                needsConfirmation()
                return nil
            }
            if !Task.isCancelled { actionError = error.localizedDescription }
            return nil
        }
    }

    func updateProfile(_ patch: BotProfilePatch, for bot: Bot) async -> Bot? {
        guard let client else { return nil }
        do {
            let updated = try await client.updateProfile(botId: bot.id, patch: patch)
            guard !Task.isCancelled else { return nil }
            state.apply(.bot(updated))
            return updated
        } catch {
            if !Task.isCancelled { actionError = error.localizedDescription }
            return nil
        }
    }

    func uploadAvatar(_ data: Data, mime: String, for bot: Bot, crop: AvatarCrop) async -> Bot? {
        guard let client else { return nil }
        do {
            let avatarUrl = try await client.uploadAvatar(data: data, mime: mime)
            guard !Task.isCancelled else { return nil }
            let current = state.bot(bot.id) ?? bot
            return await updateProfile(
                BotProfilePatch(avatarUrl: .set(avatarUrl), avatarCrop: crop),
                for: current
            )
        } catch {
            if !Task.isCancelled { actionError = error.localizedDescription }
            return nil
        }
    }

    func generateAvatar(prompt: String, for bot: Bot) async -> Bot? {
        guard let client else { return nil }
        do {
            let updated = try await client.generateAvatar(botId: bot.id, prompt: prompt)
            guard !Task.isCancelled else { return nil }
            state.apply(.bot(updated))
            return updated
        } catch {
            if !Task.isCancelled { actionError = error.localizedDescription }
            return nil
        }
    }

    func avatarData(for bot: Bot) async -> Data? {
        guard let path = bot.avatarUrl else { return nil }
        return await avatarData(path: path)
    }

    var roomSettingsContext: RoomSettingsContext? {
        guard let client else { return nil }
        return RoomSettingsContext(connectionID: client.connection.id, generation: avatarCacheGeneration)
    }

    /// Older computers answer 404 here; their rooms have no people, so every
    /// line stays yours.
    private func loadRoomSelf(using client: CompanionClient) async {
        guard let me = try? await client.sharedMe(), self.client?.connection.id == client.connection.id else { return }
        roomSelf = (client.connection.id, me)
    }

    func addRoomPerson(_ room: Room, personId: String, context: RoomSettingsContext) async throws -> Room {
        guard context.permits(roomSettingsContext), let capturedClient = client else { throw CancellationError() }
        let updated = try await capturedClient.addRoomPerson(roomId: room.id, personId: personId)
        guard !Task.isCancelled, context.permits(roomSettingsContext) else { throw CancellationError() }
        state.apply(.room(updated))
        return updated
    }

    func removeRoomPerson(_ room: Room, personId: String, context: RoomSettingsContext) async throws -> Room {
        guard context.permits(roomSettingsContext), let capturedClient = client else { throw CancellationError() }
        let updated = try await capturedClient.removeRoomPerson(roomId: room.id, personId: personId)
        guard !Task.isCancelled, context.permits(roomSettingsContext) else { throw CancellationError() }
        state.apply(.room(updated))
        return updated
    }

    func createRoomInvite(_ room: Room, context: RoomSettingsContext) async throws -> RoomInvite {
        guard context.permits(roomSettingsContext), let capturedClient = client else { throw CancellationError() }
        return try await capturedClient.createRoomInvite(roomIds: [room.id])
    }

    func roomBotGrants(_ room: Room, context: RoomSettingsContext) async throws -> [String] {
        guard context.permits(roomSettingsContext), let capturedClient = client else { throw CancellationError() }
        return try await capturedClient.roomBotGrants(roomId: room.id)
    }

    func setRoomBotGrants(_ room: Room, botIds: [String], context: RoomSettingsContext) async throws -> [String] {
        guard context.permits(roomSettingsContext), let capturedClient = client else { throw CancellationError() }
        return try await capturedClient.setRoomBotGrants(roomId: room.id, botIds: botIds)
    }

    func roomContacts() async throws -> [SharedContact] {
        guard let client else { throw APIError.transport("Computer is offline") }
        return try await client.sharedContacts().filter { $0.kind == "person" }
    }

    func updateRoom(_ room: Room, patch: RoomSettingsPatch, context: RoomSettingsContext) async throws -> Room {
        guard context.permits(roomSettingsContext), let capturedClient = client else { throw CancellationError() }
        let updated = try await capturedClient.updateRoom(id: room.id, patch: patch)
        guard !Task.isCancelled, context.permits(roomSettingsContext) else { throw CancellationError() }
        state.apply(.room(updated))
        return updated
    }

    func uploadRoomAvatar(_ data: Data, mime: String, room: Room, context: RoomSettingsContext) async throws -> Room {
        guard context.permits(roomSettingsContext), let capturedClient = client else { throw CancellationError() }
        let path = try await capturedClient.uploadAvatar(data: data, mime: mime)
        // A switched pairing ends the operation. Never redirect the saved
        // attachment to the replacement client, and never replay it.
        guard !Task.isCancelled, context.permits(roomSettingsContext) else { throw CancellationError() }
        let updated = try await capturedClient.updateRoom(id: room.id, patch: RoomSettingsPatch(avatarUrl: .set(path)))
        guard !Task.isCancelled, context.permits(roomSettingsContext) else { throw CancellationError() }
        state.apply(.room(updated))
        return updated
    }

    func avatarData(path: String) async -> Data? {
        guard let client else { return nil }
        let key = path as NSString
        if let cached = avatarCache.object(forKey: key) { return cached as Data }
        let generation = avatarCacheGeneration
        let fetch: (id: UUID, task: Task<Data?, Never>)
        if let pending = avatarFetches[path] {
            fetch = pending
        } else {
            let pending = (
                id: UUID(),
                task: Task<Data?, Never> { try? await client.avatar(path: path) }
            )
            avatarFetches[path] = pending
            fetch = pending
        }
        let data = await fetch.task.value
        if avatarFetches[path]?.id == fetch.id { avatarFetches.removeValue(forKey: path) }
        guard !Task.isCancelled, generation == avatarCacheGeneration, let data else { return nil }
        avatarCache.setObject(data as NSData, forKey: key, cost: data.count)
        return data
    }

    private func resetAvatarCache() {
        avatarCacheGeneration += 1
        for fetch in avatarFetches.values { fetch.task.cancel() }
        avatarFetches.removeAll()
        avatarCache.removeAllObjects()
    }

    func voiceOptions() async -> [Voice] {
        guard let client else { return [] }
        do { return try await client.voices() }
        catch { actionError = error.localizedDescription; return [] }
    }

    /// Switch the workspace's voice engine. The fresh status comes back so
    /// the caller can re-derive every provider-dependent row in place.
    func setVoiceProvider(_ provider: VoiceProvider) async -> ConfigStatus? {
        guard let client else { return nil }
        do { return try await client.setVoiceProvider(provider) }
        catch { actionError = error.localizedDescription; return nil }
    }

    func saveChatterboxServer(baseURL: String, model: String) async -> ConfigStatus? {
        guard let client else { return nil }
        do { return try await client.saveChatterboxServer(baseURL: baseURL, model: model) }
        catch { actionError = error.localizedDescription; return nil }
    }

    /// The host's platform, which decides whether its built-in voices are a
    /// real engine choice there or a row that must stay disabled.
    func serverEnvironment() async -> ServerEnvironment? {
        guard let client else { return nil }
        return try? await client.environment()
    }

    func previewVoice(_ voiceId: String, for bot: Bot) async -> Data? {
        guard let client else { return nil }
        do { return try await client.previewVoice(text: "Hello, I'm \(bot.name).", voiceId: voiceId) }
        catch { actionError = error.localizedDescription; return nil }
    }

    func configStatus() async -> ConfigStatus? {
        guard let client else { return nil }
        return try? await client.config()
    }

    func botOverview(for bot: Bot) async -> BotOverview? {
        guard let client else { return nil }
        let connectionID = connection?.id
        do {
            let overview = try await client.overview(botId: bot.id)
            guard !Task.isCancelled, connection?.id == connectionID else { return nil }
            return overview
        } catch {
            guard !Task.isCancelled, connection?.id == connectionID else { return nil }
            guard !(error is CancellationError), (error as? URLError)?.code != .cancelled else { return nil }
            actionError = error.localizedDescription
            return nil
        }
    }

    func loadProviderUsage() async throws -> [ProviderUsageAccount] {
#if DEBUG
        // Screenshot fixture for the roster usage row.
        if ProcessInfo.processInfo.arguments.contains("-usage-preview") {
            let json = #"{"accounts":[{"provider":"claude","account":"preview","fiveHour":{"usedPercent":25,"resetsAt":null},"sevenDay":{"usedPercent":56,"resetsAt":null},"status":"ok"},{"provider":"codex","account":"preview","sevenDay":{"usedPercent":60,"resetsAt":null},"status":"ok"}]}"#
            return try JSONDecoder().decode(ProviderUsageResponse.self, from: Data(json.utf8)).accounts
        }
#endif
        guard let client else { return [] }
        return try await client.providerUsage().accounts
    }

    func loadUpdateStatus() async -> UpdateStatusResponse? {
        guard let client else { return nil }
        return try? await client.updateStatus()
    }

    // MARK: - Job inbox

    /// A pure read: the server scopes plans to this device and never resumes
    /// or dispatches anything because the inbox was opened.
    func loadJobs() async throws -> [JobInboxItem] {
        guard let client else { throw APIError.transport("Computer is offline") }
        return orderedJobs(try await client.jobInbox().items)
    }

    /// The existing conversation a job lives in. A direct thread is projected
    /// locally; a room thread the room is not showing goes through the same
    /// room task switch search results use. Never creates a thread.
    func open(_ job: JobInboxItem) async -> Chat? {
        switch state.destination(for: job) {
        case let .bot(bot)?:
            return .bot(bot)
        case let .room(room, selected)?:
            if selected { return .room(room) }
            guard let client else { return nil }
            do {
                let switched = try await client.switchTask(groupId: room.id, threadId: job.threadId)
                state.apply(.room(switched))
                return state.rooms.first(where: { $0.id == room.id }).map(Chat.room)
            } catch {
                actionError = error.localizedDescription
                return nil
            }
        case nil:
            return nil
        }
    }

    // MARK: - Routines

    func loadRoutines() async -> (routines: [Routine], runs: [RoutineRun]) {
        guard let client else { return ([], []) }
        do { return try await client.routines() }
        catch { actionError = error.localizedDescription; return ([], []) }
    }

    func loadRoutineRunAvailability() async -> RoutineRunAvailability? {
        guard let client else { return nil }
        do {
            // Avoid the release-runtime async-let cleanup abort observed in
            // the routine editor on iOS. Preserve cancellation between requests.
            let config = try await client.config()
            try Task.checkCancellation()
            let instances = try await client.instances()
            try Task.checkCancellation()
            return RoutineRunAvailability(config: config, instances: instances)
        } catch {
            guard !(error is CancellationError), (error as? URLError)?.code != .cancelled else { return nil }
            actionError = error.localizedDescription
            return nil
        }
    }

    func saveRoutine(_ input: RoutineInput, id: String?) async -> Routine? {
        guard let client else { return nil }
        do {
            if let id { return try await client.updateRoutine(id: id, input: input) }
            return try await client.createRoutine(input)
        } catch { actionError = error.localizedDescription; return nil }
    }

    func setRoutineEnabled(_ routine: Routine, enabled: Bool) async -> Routine? {
        guard let client else { return nil }
        do { return try await client.setRoutineEnabled(id: routine.id, enabled: enabled) }
        catch { actionError = error.localizedDescription; return nil }
    }

    func runRoutine(_ routine: Routine) async -> RoutineRun? {
        guard let client else { return nil }
        do { return try await client.runRoutine(id: routine.id) }
        catch { actionError = error.localizedDescription; return nil }
    }

    func deleteRoutine(_ routine: Routine) async -> Bool {
        guard let client else { return false }
        do { try await client.deleteRoutine(id: routine.id); return true }
        catch { actionError = error.localizedDescription; return false }
    }

    // MARK: - Notification navigation

    func setNotificationVisible(threadId: String, visible: Bool) {
        guard let connectionID = client?.connection.id else { return }
        let key = connectionID + ":thread:" + threadId
        if visible { notificationVisibleThreads.insert(key) }
        else { notificationVisibleThreads.remove(key) }
    }

    func setSharedNotificationVisible(roomId: String, visible: Bool) {
        guard let connectionID = client?.connection.id else { return }
        let key = connectionID + ":shared:" + roomId
        if visible { notificationVisibleThreads.insert(key) }
        else { notificationVisibleThreads.remove(key) }
    }

    private func notificationEnabled(botId: String, threadId: String) -> Bool {
        guard state.bot(botId)?.notifications != false else { return false }
        let room = state.rooms.first { $0.threadId == threadId || ($0.tasks ?? []).contains { $0.threadId == threadId } }
        return room?.notifications != "muted"
    }

    private func notificationPresentation(for target: NotificationTarget) -> NotificationPresentation {
        guard target.belongs(to: client?.connection.id) else { return .quiet }
        let visible = UIApplication.shared.applicationState == .active && notificationVisibleThreads.contains((target.connectionId ?? "") + ":thread:" + target.threadId)
        return .resolve(enabled: notificationEnabled(botId: target.botId, threadId: target.threadId),
                        visible: visible, blocking: target.isBlocking)
    }

    func openNotification(_ target: NotificationTarget) async {
        let home = home(for: target.connectionId)
        if home !== self { return await home.openNotification(target) }
        let ownID = isSatellite ? connection?.id : client?.connection.id ?? registry.activeConnectionID
        guard target.belongs(to: ownID) else {
            actionError = "This notification belongs to another or an older connection. Select its computer and open the conversation there."
            return
        }
        guard let client else {
            if restorePending {
                pendingNotification = target
                connect()
            } else {
                actionError = "Pair this device with its original computer to open that task."
            }
            return
        }
        pendingNotification = nil
        notificationChat = nil
        let generation = streamGeneration
        do {
            try await hydrate(using: client)
            let page: ThreadPage
            if let messageID = target.messageId {
                page = try await client.messages(threadId: target.threadId, around: messageID)
            } else {
                page = try await client.messages(threadId: target.threadId)
            }
            try Task.checkCancellation()
            guard streamGeneration == generation, target.belongs(to: self.client?.connection.id) else { throw CancellationError() }
            switch target.requestState(in: page.messages) {
            case .unavailable:
                throw APIError.status(code: 404, message: "That exact request is no longer available. Open the conversation to review its history.")
            case .settled:
                throw APIError.status(code: 409, message: "That request has already been answered or dismissed.")
            case .pending, .notRequired: break
            }
            state.merge(page, intoThread: target.threadId)
            if var room = state.rooms.first(where: {
                $0.threadId == target.threadId || ($0.tasks ?? []).contains(where: { $0.threadId == target.threadId })
            }) {
                if room.threadId != target.threadId {
                    room = try await client.switchTask(groupId: room.id, threadId: target.threadId)
                    guard streamGeneration == generation, target.belongs(to: self.client?.connection.id) else { throw CancellationError() }
                    state.apply(.room(room))
                }
                focusedMessageId = target.messageId
                present(.room(room))
                return
            }
            guard var selected = state.bot(target.botId) else {
                throw APIError.status(code: 404, message: "That agent no longer exists.")
            }
            if target.requiresTaskSwitch(activeThreadId: selected.threadId) {
                selected = try await client.switchTask(botId: selected.id, threadId: target.threadId)
                guard streamGeneration == generation, target.belongs(to: self.client?.connection.id) else { throw CancellationError() }
                state.apply(.bot(selected))
            }
            focusedMessageId = target.messageId
            present(.bot(selected))
        } catch is CancellationError {
            // A previous connection's response cannot navigate the new account.
        } catch {
            guard streamGeneration == generation, target.belongs(to: self.client?.connection.id) else { return }
            actionError = "Couldn't open this notification's exact task. " + error.localizedDescription
        }
    }

    func consumeNotificationChat() { notificationChat = nil }

    // MARK: - Voice pushes

    /// A done push for a live call is the call's to say; a ring while the app
    /// is open becomes the incoming call screen instead of a banner.
    fileprivate func voicePresentation(for push: VoicePush) -> NotificationPresentation {
        switch push {
        case let .workDone(_, threadId, callId, _):
            if let callId, callId == VoiceCallCenter.shared.liveCallId { return .quiet }
            let visible = UIApplication.shared.applicationState == .active
                && notificationVisibleThreads.contains((client?.connection.id ?? "") + ":thread:" + threadId)
            return visible ? .quiet : .alert
        case let .ring(ring):
            receivedRing(ring, connectionId: client?.connection.id)
            let center = VoiceCallCenter.shared
            return center.ringIsBusy(ring.ringId) && center.claimRingBanner(ring.ringId) ? .alert : .quiet
        }
    }

    /// Tell the computer this ring is on screen here; without it, CallKit
    /// rings the phone ~2 s later.
    func ackRing(_ ringId: String) {
        guard let client else { return }
        Task { try? await client.ackRing(ringId) }
    }

    private func receivedRing(_ ring: VoiceRing, connectionId: String?) {
        guard UIApplication.shared.applicationState == .active, connectionId == client?.connection.id,
              let bot = state.bot(ring.botId) else { return }
        VoiceCallCenter.shared.ring(ring, bot: bot, session: self)
    }

    /// The APNs copy of a done push can land while the call is live with the
    /// screen locked; the call is already saying it, so take the banner back.
    private static func clearVoiceDone(callId: String) {
        Task {
            for delay in [2, 6] {
                try? await Task.sleep(for: .seconds(delay))
                NotificationCoordinator.shared.removeVoiceDone(callId: callId)
            }
        }
    }

    func handleVoice(_ action: VoiceNotificationAction) async {
        let connectionId: String? = switch action {
        case let .open(target), let .callBack(target, _): target.connectionId
        case let .accept(_, id): id
        }
        let home = home(for: connectionId)
        if home !== self { return await home.handleVoice(action) }
        switch action {
        case let .open(target):
            await openNotification(target)
        case let .callBack(target, result):
            await openNotification(target)
            guard let bot = await botAfterLaunch(target.botId) else { return }
            let full = target.messageId.flatMap { id in
                state.transcript(forThread: target.threadId).first { $0.id == id }?.text
            }
            VoiceCallCenter.shared.start(bot: bot, threadId: target.threadId, session: self,
                                         opener: RealtimeVoice.callBackOpener(botName: bot.name, result: full ?? result))
        case let .accept(ring, connectionId):
            VoiceCallCenter.shared.markRingAnswered(ring.ringId)
            let threadId = ring.threadId
            if let threadId, let target = NotificationTarget(botId: ring.botId, threadId: threadId, connectionId: connectionId) {
                await openNotification(target)
            }
            guard let bot = await botAfterLaunch(ring.botId) else { return }
            VoiceCallCenter.shared.start(bot: bot, threadId: threadId ?? bot.threadId, session: self,
                                         opener: RealtimeVoice.ringOpener(reason: ring.reason))
        }
    }

    /// The action button, a Shortcut, Siri or the Control Center control:
    /// straight into a live call with the bot, no extra taps. A cold launch
    /// waits up to 20 s for the paired computer to come back first.
    func callFromShortcut(botId: String?, name: String?) async {
        var bot: Bot?
        for _ in 0..<40 {
            if client != nil, let found = shortcutBot(botId: botId, name: name) { bot = found; break }
            // The bot may live on another home; a dead main computer must
            // not hold the call for 20 s.
            if !isSatellite, let home = satellites.first(where: { $0.client != nil && $0.shortcutBot(botId: botId, name: name) != nil }) {
                return await home.callFromShortcut(botId: botId, name: name)
            }
            if client == nil, !restorePending { break }
            try? await Task.sleep(for: .milliseconds(500))
        }
        guard let bot else {
            actionError = "Couldn't find \(name ?? "that bot") on your computer to call."
            return
        }
        // bots on another mac have no realtime call; their chat still opens
        if bot.remote == nil {
            VoiceCallCenter.shared.start(bot: bot, threadId: bot.threadId, session: self)
        }
        if let target = NotificationTarget(botId: bot.id, threadId: bot.threadId,
                                           connectionId: client?.connection.id ?? registry.activeConnectionID) {
            await openNotification(target)
        }
    }

    private func shortcutBot(botId: String?, name: String?) -> Bot? {
        let bots = state.bots.filter { $0.hidden != true }
        if let botId, let bot = bots.first(where: { $0.id == botId }) { return bot }
        guard let name = name?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(), !name.isEmpty else { return nil }
        return bots.first { $0.name.lowercased() == name } ?? bots.first { $0.name.lowercased().hasPrefix(name) }
    }

    /// A tapped Live Activity: the exact thread it was showing.
    func openThreadLink(botId: String, threadId: String) async {
        guard let target = NotificationTarget(botId: botId, threadId: threadId,
                                              connectionId: client?.connection.id ?? registry.activeConnectionID) else { return }
        await openNotification(target)
    }

    /// A tap can launch the app cold: give the connection up to 15 s to
    /// bring the fleet in before calling.
    private func botAfterLaunch(_ botId: String) async -> Bot? {
        for _ in 0..<30 {
            if client != nil, let bot = state.bot(botId) { return bot }
            if client == nil, !restorePending { break }
            try? await Task.sleep(for: .milliseconds(500))
        }
        if let bot = state.bot(botId), client != nil { return bot }
        actionError = "Couldn't reach this computer to start the call."
        return nil
    }

    // MARK: - Thread chips

    /// A tapped "Opened thread #Title on Scout" chip. Lands on that thread by
    /// the route a thread row uses, which only changes what this phone is
    /// looking at — a bot mid-turn keeps working where it was. A thread the
    /// computer no longer has still lands on the bot, with a notice, rather
    /// than nowhere.
    ///
    /// Returns the thread to select in place when the chip's bot is the one
    /// already on screen. Any other bot is pushed the way a notification is,
    /// and nil comes back.
    func openThread(_ ref: ThreadRef, shownBotId: String?) async -> String? {
        guard !Task.isCancelled else { return nil }
        guard let client else {
            actionError = "Pair this device with your computer to open that thread."
            return nil
        }
        let generation = streamGeneration
        let connectionID = client.connection.id
        let requestIsCurrent = {
            !Task.isCancelled && self.streamGeneration == generation && self.client?.connection.id == connectionID
        }
        actionError = nil
        do {
            var bot = state.bot(ref.botId)
            if bot == nil {
                try await hydrate(using: client)
                guard requestIsCurrent() else { return nil }
                bot = state.bot(ref.botId)
            }
            guard var selected = bot else { throw APIError.status(code: 404, message: "That agent no longer exists.") }
            if selected.threadId != ref.threadId {
                do {
                    selected = try await client.switchTask(botId: selected.id, threadId: ref.threadId)
                    guard requestIsCurrent() else { return nil }
                    state.apply(.bot(selected))
                } catch APIError.status(code: 404, message: _) {
                    guard requestIsCurrent() else { return nil }
                    // The thread may be gone (deleted since the chip was
                    // written). The bot's current thread, and a word about
                    // it, beats a dead tap.
                    actionError = "That thread is no longer on your computer."
                }
            }
            guard requestIsCurrent() else { return nil }
            if selected.id == shownBotId { return selected.threadId }
            notificationChat = .bot(selected)
        } catch is CancellationError {
        } catch {
            guard requestIsCurrent() else { return nil }
            actionError = error.localizedDescription
        }
        return nil
    }

    func react(to message: Message, in threadId: String, emoji: String) async {
        guard let client else { return }
        do {
            let patched = try await client.toggleReaction(threadId: threadId, messageId: message.id, emoji: emoji)
            state.apply(.messagePatch(threadId: threadId, message: patched))
        } catch { actionError = error.localizedDescription }
    }

    func edit(_ message: Message, for bot: Bot, text: String) async {
        await perform { try await $0.edit(botId: bot.id, messageId: message.id, text: text, threadId: bot.threadId) }
    }

    func switchVersion(to message: Message, for bot: Bot) async {
        guard let client else { return }
        do {
            let leaf = try await client.setActiveBranch(botId: bot.id, messageId: message.id, threadId: bot.threadId)
            state.apply(.thread(threadId: bot.threadId, activeLeafId: leaf))
        } catch { actionError = error.localizedDescription }
    }

    func export(threadId: String, format: String) async -> URL? {
        guard let client else { return nil }
        do {
            let exported = try await client.export(threadId: threadId, format: format)
            let name = URL(fileURLWithPath: exported.filename).lastPathComponent
            let url = FileManager.default.temporaryDirectory.appendingPathComponent(name)
            try exported.data.write(to: url, options: .atomic)
            return url
        } catch {
            actionError = error.localizedDescription
            return nil
        }
    }

    // MARK: - Connected apps

    func loadConnectorCatalog() async -> ConnectorCatalog? {
        guard let client else { return nil }
        do { return try await client.connectorCatalog() }
        catch { actionError = error.localizedDescription; return nil }
    }

    func loadAllConnectorStatuses() async -> ConnectorStatuses? {
        guard let client else { return nil }
        do { return try await client.allConnectorStatuses() }
        catch { actionError = error.localizedDescription; return nil }
    }

    func authorizeConnector(_ slug: String, alias: String?) async -> URL? {
        guard let client else { return nil }
        do { return try await client.authorizeConnector(slug: slug, alias: alias) }
        catch { actionError = error.localizedDescription; return nil }
    }

    func refreshNotificationAuthorization() async {
        notificationAuthorization = await NotificationCoordinator.shared.authorizationStatus()
        notificationAuthorizationResolved = true
        if notificationAuthorization == .authorized || notificationAuthorization == .provisional {
            UIApplication.shared.registerForRemoteNotifications()
            if let token = UserDefaults.standard.string(forKey: "bos.apnsToken") { await registerPushToken(token) }
        }
    }

    private func registerPushToken(_ token: String) async {
        for home in satellites { await home.registerPushToken(token) }
        guard let client else { return }
        // Live Activities follow the main computer only; another home
        // pushing into the same island would fight it.
        let live = LiveActivityTokens.shared
        try? await client.registerPushToken(token, environment: Self.apnsEnvironment, voipToken: CallKitRinger.shared.voipToken,
                                            liveStartToken: isSatellite ? nil : live.startToken,
                                            liveActivities: isSatellite ? nil : live.activities)
    }

    func enableNotifications() async {
        if notificationAuthorization == .denied {
            if let url = URL(string: UIApplication.openSettingsURLString) {
                await UIApplication.shared.open(url)
            }
            return
        }
        _ = await NotificationCoordinator.shared.requestAuthorization()
        await refreshNotificationAuthorization()
        appliedBadge = nil
        applyBadge(state.unreadCount)
    }

    var notificationStatusText: String {
        switch notificationAuthorization {
        case .authorized: return "On"
        case .provisional: return "Quietly on"
        case .ephemeral: return "Temporarily on"
        case .denied: return "Off in Settings"
        case .notDetermined: return "Not enabled"
        @unknown default: return "Unknown"
        }
    }

    private func perform(quietly: Bool = false, _ body: (CompanionClient) async throws -> Void) async {
        guard let client else { return }
        do {
            try await body(client)
        } catch let error as APIError where error.isUnauthorized {
            status = .unauthorized
        } catch {
            if !quietly { actionError = error.localizedDescription }
        }
    }
}

/// A chat plus the two things a roster row shows that the record itself does
/// not carry: the preview line, and when the thread last moved. Both come out
/// of the same message — the last one in the transcript.
struct ChatSummary: Identifiable, Hashable {
    let chat: Chat
    let preview: String
    let lastActivity: Double
    let pinned: Bool

    var id: String { chat.id }
}

extension CompanionState {
    /// Everything worth showing in the chat list: pinned first, then unread,
    /// then most recently active. Hidden bots stay hidden.
    ///
    /// The derived fields are computed once here rather than asked for as the
    /// list is sorted and filtered. Each one walks a thread's messages to
    /// reach the last of them, and a comparator is called O(n log n) times
    /// while the search predicate runs over every chat on every keystroke —
    /// so the same transcript was being traversed dozens of times per frame
    /// to produce an answer that had not changed. One pass, then sort the
    /// results.
    /// - Parameter activity: how much of a bot's working-out the reader has
    ///   asked to see. The preview honours it the same way the transcript
    ///   does; `lastActivity` deliberately does not, because a thread that
    ///   just ran a tool has still moved and should still rise in the list.
    func chatSummaries(activity: ActivityDetail = .full) -> [ChatSummary] {
        let bots = self.bots.filter { $0.hidden != true }.map(Chat.bot)
        let rooms = self.rooms.map(Chat.room)
        return (bots + rooms)
            .map { chat in
                let messages = visibleTranscript(forThread: chat.threadId)
                return ChatSummary(
                    chat: chat,
                    preview: rosterPreview(messages, detail: activity),
                    lastActivity: rosterActivityAt(messages),
                    pinned: Self.pinned(chat)
                )
            }
            .sorted { left, right in
                if left.pinned != right.pinned { return left.pinned }
                if left.chat.unread != right.chat.unread { return left.chat.unread }
                return left.lastActivity > right.lastActivity
            }
    }

    private static func pinned(_ chat: Chat) -> Bool {
        if case let .bot(bot) = chat { return bot.pinned ?? false }
        return false
    }

}
// branding compatibility (electron/branding-compat.json): data-home: existing desktop and companion homes, backups and lease recovery must open the same data; peer-http: HTTP authentication headers, discovery and domain verification still interoperate with 1.9.1
