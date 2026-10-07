#if DEBUG
import CompanionCore
import SwiftUI

/// BOS 2.0 cloud rooms, slice 2: email-OTP sign-in against a local issuer
/// and two-person chat over /v2. Debug builds only, and only when launched
/// with BOS_CLOUD_ROOMS=1 plus CLOUD_ROOMS_URL and CLOUD_ISSUER_URL (env or
/// `-KEY value` launch arguments). Nothing here ships in a release build.
enum CloudRoomsConfig {
    static func value(_ key: String) -> String? {
        ProcessInfo.processInfo.environment[key] ?? UserDefaults.standard.string(forKey: key)
    }

    static var enabled: Bool { value("BOS_CLOUD_ROOMS") == "1" && roomsURL != nil && issuerURL != nil }
    static var roomsURL: URL? { value("CLOUD_ROOMS_URL").flatMap(URL.init(string:)) }
    static var issuerURL: URL? { value("CLOUD_ISSUER_URL").flatMap(URL.init(string:)) }
}

@MainActor
final class CloudRoomsModel: ObservableObject {
    enum Phase: Equatable {
        case starting
        case email
        case code(email: String)
        case ready
        /// The issuer said the session is gone; sign in again.
        case revoked
    }

    struct RoomRow: Identifiable, Equatable {
        var ref: CloudRoomRef
        var policyRevision: CloudSequence
        var id: String { ref.workspaceId + "/" + ref.roomId }
    }

    @Published private(set) var phase: Phase = .starting
    @Published private(set) var identity: CloudIdentity?
    @Published private(set) var rows: [RoomRow] = []
    @Published private(set) var rooms: [String: CloudRoomState] = [:]
    @Published private(set) var outbox: CloudOutbox?
    @Published var selected: CloudRoomRef?
    @Published private(set) var busy = false
    @Published private(set) var problem: String?
    /// Identity outage: shown, retried, never treated as signed out.
    @Published private(set) var unavailable = false
    @Published private(set) var lastInvite: String?
    @Published private(set) var live = false

    let identityCoordinator: CloudIdentityCoordinator
    private let client: CloudClient
    private let storageRoot: URL
    private var session = CloudSession(account: nil)
    private var store: CloudAccountStore?
    private var socket: Task<Void, Never>?
    private var windows: [String: CloudSendWindow] = [:]

    init(roomsURL: URL, issuerURL: URL) {
        let coordinator = CloudIdentityCoordinator(issuer: CloudIssuerClient(baseURL: issuerURL), roomsURL: roomsURL, store: CloudKeychainStore())
        identityCoordinator = coordinator
        client = CloudClient(baseURL: roomsURL) { try await coordinator.bearer() }
        storageRoot = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    }

    // MARK: - lifecycle

    func start() async {
        do {
            switch try await identityCoordinator.restore() {
            case .signedIn(let identity), .unavailable(let identity, _): enter(identity)
            case .revoked: phase = .revoked
            case .signedOut: phase = .email
            }
        } catch {
            // Locked keychain: the bearer may exist, so wait rather than sign out.
            problem = "keychain locked, unlock the device"
            phase = .starting
        }
    }

    func foreground() { run(session.reduce(.foreground)) }

    func background() {
        for key in rooms.keys { _ = rooms[key]?.background() }
        run(session.reduce(.background))
    }

    // MARK: - sign-in

    func requestCode(_ email: String) async {
        await work {
            try await self.identityCoordinator.requestCode(email: email)
            self.phase = .code(email: CloudIssuerClient.normalizedEmail(email) ?? email)
        }
    }

    func verify(_ code: String) async {
        guard case .code(let email) = phase else { return }
        await work {
            let identity = try await self.identityCoordinator.signIn(email: email, code: code)
            self.enter(identity)
        }
    }

    func restartSignIn() { phase = .email; problem = nil }

    func signOut() async {
        socket?.cancel()
        await identityCoordinator.signOut()
        run(session.reduce(.signedOut))
        identity = nil
        phase = .email
    }

    private func enter(_ identity: CloudIdentity) {
        self.identity = identity
        phase = .ready
        problem = nil
        run(session.reduce(.accountChanged(identity.key)))
        run(session.reduce(.foreground))
    }

    // MARK: - rooms

    func select(_ ref: CloudRoomRef?) {
        session.selected = ref
        selected = ref
        if ref != nil { run(session.reduce(.retryDue(.recovery, generation: session.generation))) }
    }

    func send(_ text: String, in ref: CloudRoomRef) async {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let policy = rooms[key(ref)]?.policyRevision ?? rows.first(where: { $0.ref.sameRoom(ref) })?.policyRevision else { return }
        await work {
            let window = try await self.window(for: ref.workspaceId)
            let envelope = CloudSendEnvelope(window: window, roomId: ref.roomId, threadId: ref.threadId, text: trimmed, expectedPolicyRevision: policy)
            guard var outbox = self.outbox, let expiry = window.expiryDate else { return }
            let effects = try outbox.enqueue(envelope, windowExpiresAt: expiry, now: Date())
            self.outbox = outbox
            self.runOutbox(effects)
        }
    }

    func redeem(_ token: String) async {
        let token = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !token.isEmpty else { return }
        await work {
            _ = try await self.client.redeemInvite(token: token)
            self.run(self.session.reduce(.retryDue(.recovery, generation: self.session.generation)))
        }
    }

    /// Owner setup for a fresh account: a workspace, one room, one member invite.
    func createRoomAndInvite(name: String) async {
        await work {
            let workspace = try await self.client.createWorkspace(name: name)
            let room = try await self.client.createRoom(workspaceId: workspace.workspaceId, name: name)
            let invite = try await self.client.createInvite(workspaceId: workspace.workspaceId, role: .member, roomIds: [room.roomId])
            self.lastInvite = invite.token
            self.run(self.session.reduce(.retryDue(.recovery, generation: self.session.generation)))
        }
    }

    func invite(to ref: CloudRoomRef) async {
        await work {
            self.lastInvite = try await self.client.createInvite(workspaceId: ref.workspaceId, role: .member, roomIds: [ref.roomId]).token
        }
    }

    func room(_ ref: CloudRoomRef) -> CloudRoomState? { rooms[key(ref)] }

    func pending(in ref: CloudRoomRef) -> [CloudOutboxEntry] {
        (outbox?.entries ?? []).filter { $0.envelope.roomId == ref.roomId && $0.envelope.namespace.workspaceId == ref.workspaceId && !$0.status.isResolved }
    }

    // MARK: - effects

    private func run(_ effects: [CloudSessionEffect]) {
        var subscriptions: [CloudRoomRef] = []
        var open: Int?
        for effect in effects {
            switch effect {
            case .refreshAuth(let generation):
                Task { await self.refreshAuth(generation) }
            case .syncDiscovery(let generation):
                Task { await self.syncDiscovery(generation) }
            case .removeRoom(let ref):
                rooms[key(ref)] = nil
                try? store?.removeRoom(workspaceId: ref.workspaceId, roomId: ref.roomId)
                if var outbox { runOutbox(outbox.roomRemoved(roomId: ref.roomId)); self.outbox = outbox }
                if selected.map({ $0.sameRoom(ref) }) == true { selected = nil }
            case .openSocket(let generation):
                open = generation
            case .subscribe(let ref):
                subscriptions.append(ref)
            case .closeSocket:
                socket?.cancel(); socket = nil; live = false
            case .recoverOperations:
                if var outbox { let effects = outbox.wake(now: Date()); self.outbox = outbox; runOutbox(effects) }
            case .schedule(let timer, let after, let generation):
                Task {
                    try? await Task.sleep(for: .seconds(after))
                    self.run(self.session.reduce(.retryDue(timer, generation: generation)))
                }
            case .clearVisibleState:
                rooms = [:]; rows = []; selected = nil; outbox = nil; windows = [:]; lastInvite = nil; live = false
            case .openStore(let account):
                let store = CloudAccountStore(root: storageRoot, account: account)
                self.store = store
                var outbox = (try? store.loadOutbox()) ?? CloudOutbox(account: account)
                let effects = outbox.recoverAfterLaunch(now: Date())
                self.outbox = outbox
                runOutbox(effects)
            case .eraseStore(let account):
                try? CloudAccountStore(root: storageRoot, account: account).erase()
                store = nil
            case .requireSignIn:
                store = nil
                identity = nil
                phase = .revoked
            }
        }
        if let open { openSocket(open, subscriptions) }
    }

    private func refreshAuth(_ generation: Int) async {
        switch await identityCoordinator.validate() {
        case .signedIn:
            unavailable = false
            run(session.reduce(.authRefreshed(generation: generation)))
        case .unavailable(_, let retryAfter):
            unavailable = true
            run(session.reduce(.authFailed(generation: generation, retryAfter: retryAfter)))
        case .revoked, .signedOut:
            run(session.reduce(.sessionInvalid(generation: generation)))
        }
    }

    private func syncDiscovery(_ generation: Int) async {
        do {
            let discovery = try await client.discovery()
            rows = discovery.workspaces.flatMap { workspace in
                workspace.rooms.map { RoomRow(ref: CloudRoomRef(workspaceId: workspace.workspaceId, roomId: $0.roomId, threadId: $0.threadId, role: workspace.role), policyRevision: $0.policyRevision) }
            }
            run(session.reduce(.discoverySynced(generation: generation, discovery)))
        } catch let error as CloudError {
            if await rejected(error.error, generation: generation) { return }
            run(session.reduce(.discoveryFailed(generation: generation, retryAfter: error.retryAfter)))
        } catch {
            run(session.reduce(.discoveryFailed(generation: generation, retryAfter: nil)))
        }
    }

    /// session_invalid from the room service fails closed like a 401.
    private func rejected(_ code: CloudErrorCode, generation: Int) async -> Bool {
        unavailable = code == .identityUnavailable
        guard code.isSessionInvalid else { return false }
        await identityCoordinator.sessionRejected()
        run(session.reduce(.sessionInvalid(generation: generation)))
        return true
    }

    private func openSocket(_ generation: Int, _ refs: [CloudRoomRef]) {
        socket?.cancel()
        let frames: [CloudOutboundFrame] = refs.map { ref in
            let state = roomState(ref)
            return .subscribe(workspaceId: ref.workspaceId, roomId: ref.roomId, threadId: ref.threadId, cursor: state.cursor, snapshotId: state.snapshotId)
        }
        socket = Task {
            do {
                let stream = try await client.realtime(subscriptions: frames)
                for try await frame in stream {
                    guard generation == self.session.generation else { return }
                    await self.receive(frame, generation: generation)
                }
                if !Task.isCancelled { run(session.reduce(.socketEnded(generation: generation, retryAfter: nil))) }
            } catch {
                if !Task.isCancelled { run(session.reduce(.socketEnded(generation: generation, retryAfter: nil))) }
            }
        }
    }

    private func receive(_ frame: CloudFrame, generation: Int) async {
        let target: (String, String)?
        switch frame {
        case .batch(let batch): target = (batch.workspaceId, batch.roomId)
        case .reset(let reset): target = (reset.workspaceId, reset.roomId)
        case .error(let code):
            if await rejected(code, generation: generation) { return }
            target = nil
        case .heartbeat: return
        }
        _ = session.reduce(.socketLive(generation: generation))
        guard let (workspaceId, roomId) = target,
              let ref = rows.first(where: { $0.ref.workspaceId == workspaceId && $0.ref.roomId == roomId })?.ref
        else { return }
        var state = roomState(ref)
        let effects = state.receive(frame)
        rooms[key(ref)] = state
        if case .batch(let batch) = frame, batch.live { live = true }
        runRoom(effects, ref)
    }

    private func runRoom(_ effects: [CloudRoomEffect], _ ref: CloudRoomRef) {
        for effect in effects {
            switch effect {
            case .persist:
                if let state = rooms[key(ref)] { try? store?.save(state) }
            case .subscribe:
                run(session.reduce(.retryDue(.reconnect, generation: session.generation)))
            case .fetchSnapshot:
                Task {
                    guard let snapshot = try? await self.client.snapshot(ref), var state = self.rooms[self.key(ref)] else { return }
                    let effects = state.apply(snapshot)
                    self.rooms[self.key(ref)] = state
                    self.runRoom(effects, ref)
                }
            case .closeStream:
                break
            case .observedOwnSend(let message):
                if var outbox { let effects = outbox.observed(message, now: Date()); self.outbox = outbox; runOutbox(effects) }
            case .audienceChanged:
                if var outbox { let effects = outbox.audienceChanged(roomId: ref.roomId); self.outbox = outbox; runOutbox(effects) }
            case .resyncDiscovery:
                run(session.reduce(.retryDue(.recovery, generation: session.generation)))
            }
        }
    }

    private func runOutbox(_ effects: [CloudOutboxEffect]) {
        guard let account = outbox?.account else { return }
        for effect in effects {
            switch effect {
            case .persist:
                if let outbox { try? store?.save(outbox) }
            case .submit(let envelope):
                answer(envelope.clientOperationId, account) { await self.client.submit(envelope) }
            case .lookup(let id, let workspaceId):
                answer(id, account) { await self.client.lookup(id, workspaceId: workspaceId) }
            case .seal(let envelope):
                answer(envelope.clientOperationId, account) { await self.client.seal(envelope) }
            case .scheduleWake(let after):
                Task {
                    try? await Task.sleep(for: .seconds(after))
                    guard var outbox = self.outbox, outbox.account == account else { return }
                    let effects = outbox.wake(now: Date())
                    self.outbox = outbox
                    self.runOutbox(effects)
                }
            }
        }
    }

    private func answer(_ id: CloudOperationID, _ account: CloudAccountKey, _ call: @escaping () async -> CloudSubmitResult) {
        let generation = outbox?.generation ?? 0
        Task {
            let result = await call()
            // An answer for an account that is no longer on screen is dropped.
            guard var outbox = self.outbox, outbox.account == account else { return }
            let effects = outbox.answered(id, result: result, generation: generation, now: Date())
            self.outbox = outbox
            self.runOutbox(effects)
        }
    }

    private func window(for workspaceId: String) async throws -> CloudSendWindow {
        if let window = windows[workspaceId], let expiry = window.expiryDate, expiry > Date().addingTimeInterval(60) { return window }
        let window = try await client.operationWindow(workspaceId: workspaceId)
        windows[workspaceId] = window
        return window
    }

    private func roomState(_ ref: CloudRoomRef) -> CloudRoomState {
        if let state = rooms[key(ref)] { return state }
        var state = (try? store?.loadRoom(workspaceId: ref.workspaceId, roomId: ref.roomId))
            ?? CloudRoomState(workspaceId: ref.workspaceId, roomId: ref.roomId, threadId: ref.threadId, me: identity?.accountId ?? "", role: ref.role)
        state.role = ref.role
        rooms[key(ref)] = state
        return state
    }

    private func key(_ ref: CloudRoomRef) -> String { ref.workspaceId + "/" + ref.roomId }

    private func work(_ body: @escaping () async throws -> Void) async {
        busy = true
        problem = nil
        defer { busy = false }
        do {
            try await body()
        } catch let error as CloudIdentityError {
            problem = switch error {
            case .invalidEmail: "enter a valid email"
            case .invalidCode: "that code didn't work, check it or ask for a new one"
            case .unavailable: "sign-in service unavailable, try again"
            case .sessionInvalid: "signed out, sign in again"
            case .invalidResponse: "sign-in failed, ask for a new code"
            }
        } catch let error as CloudError {
            if await rejected(error.error, generation: session.generation) { return }
            problem = error.error.rawValue.replacingOccurrences(of: "_", with: " ")
        } catch {
            problem = error.localizedDescription
        }
    }
}

// MARK: - views

struct CloudRoomsRoot: View {
    @StateObject private var model: CloudRoomsModel
    @Environment(\.scenePhase) private var scenePhase

    init(roomsURL: URL, issuerURL: URL) {
        _model = StateObject(wrappedValue: CloudRoomsModel(roomsURL: roomsURL, issuerURL: issuerURL))
    }

    var body: some View {
        NavigationStack {
            Group {
                switch model.phase {
                case .starting: ProgressView().accessibilityIdentifier("cloud.starting")
                case .email, .code, .revoked: CloudSignInView(model: model)
                case .ready: CloudRoomListView(model: model)
                }
            }
            .safeAreaInset(edge: .top) {
                if model.unavailable {
                    Text("sign-in service unavailable, retrying")
                        .font(.footnote).padding(6).frame(maxWidth: .infinity)
                        .background(.yellow.opacity(0.3))
                        .accessibilityIdentifier("cloud.identityUnavailable")
                }
            }
        }
        .task { await model.start() }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .active: model.foreground()
            case .background: model.background()
            default: break
            }
        }
    }
}

struct CloudSignInView: View {
    @ObservedObject var model: CloudRoomsModel
    @State private var email = ""
    @State private var code = ""

    var body: some View {
        Form {
            if model.phase == .revoked {
                Section {
                    Text("your session ended. sign in again.").accessibilityIdentifier("cloud.revoked")
                }
            }
            switch model.phase {
            case .code(let address):
                Section("code sent to \(address)") {
                    TextField("8-digit code", text: $code)
                        .keyboardType(.numberPad).textContentType(.oneTimeCode)
                        .accessibilityIdentifier("cloud.code")
                    Button("sign in") { Task { await model.verify(code) } }
                        .disabled(model.busy).accessibilityIdentifier("cloud.verify")
                    Button("use a different email") { code = ""; model.restartSignIn() }
                }
            default:
                Section("cloud rooms") {
                    TextField("email", text: $email)
                        .keyboardType(.emailAddress).textContentType(.emailAddress)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .accessibilityIdentifier("cloud.email")
                    Button("send code") { Task { await model.requestCode(email) } }
                        .disabled(model.busy).accessibilityIdentifier("cloud.sendCode")
                }
            }
            if let problem = model.problem {
                Section { Text(problem).foregroundStyle(.red).accessibilityIdentifier("cloud.problem") }
            }
        }
        .navigationTitle("sign in")
    }
}

struct CloudRoomListView: View {
    @ObservedObject var model: CloudRoomsModel
    @State private var token = ""
    @State private var newRoom = ""

    var body: some View {
        List {
            if let identity = model.identity {
                Section("signed in") {
                    Text(identity.subject).font(.caption.monospaced()).accessibilityIdentifier("cloud.subject")
                    Button("sign out", role: .destructive) { Task { await model.signOut() } }
                        .accessibilityIdentifier("cloud.signOut")
                }
            }
            Section("rooms") {
                if model.rows.isEmpty { Text("no rooms yet").foregroundStyle(.secondary) }
                ForEach(model.rows) { row in
                    NavigationLink(value: row.ref) {
                        VStack(alignment: .leading) {
                            Text(row.ref.roomId).font(.body.monospaced())
                            Text(row.ref.role.rawValue).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    .accessibilityIdentifier("cloud.room.\(row.ref.roomId)")
                }
            }
            Section("join with an invite") {
                TextField("invite token", text: $token)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                    .accessibilityIdentifier("cloud.inviteToken")
                Button("join") { Task { await model.redeem(token); token = "" } }
                    .disabled(model.busy).accessibilityIdentifier("cloud.redeem")
            }
            Section("new room") {
                TextField("name", text: $newRoom).accessibilityIdentifier("cloud.newRoomName")
                Button("create and invite") { Task { await model.createRoomAndInvite(name: newRoom.isEmpty ? "room" : newRoom) } }
                    .disabled(model.busy).accessibilityIdentifier("cloud.createRoom")
            }
            if let invite = model.lastInvite {
                Section("invite token") {
                    Text(invite).font(.caption.monospaced()).textSelection(.enabled)
                        .accessibilityIdentifier("cloud.lastInvite")
                    Button("copy") { UIPasteboard.general.string = invite }
                }
            }
            if let problem = model.problem {
                Section { Text(problem).foregroundStyle(.red).accessibilityIdentifier("cloud.problem") }
            }
        }
        .navigationTitle("cloud rooms")
        .navigationDestination(for: CloudRoomRef.self) { ref in
            CloudRoomChatView(model: model, ref: ref)
        }
        .refreshable { model.select(model.selected) }
    }
}

struct CloudRoomChatView: View {
    @ObservedObject var model: CloudRoomsModel
    let ref: CloudRoomRef
    @State private var draft = ""

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                List {
                    ForEach(model.room(ref)?.messages ?? [], id: \.messageId) { message in
                        let mine = message.actorId == model.identity?.accountId
                        VStack(alignment: mine ? .trailing : .leading, spacing: 2) {
                            Text(message.text)
                            Text(mine ? "you" : message.actorId).font(.caption2).foregroundStyle(.secondary)
                        }
                        .frame(maxWidth: .infinity, alignment: mine ? .trailing : .leading)
                        .accessibilityIdentifier("cloud.message.\(message.messageId)")
                        .id(message.messageId)
                    }
                    ForEach(model.pending(in: ref)) { entry in
                        HStack {
                            Spacer()
                            Text(entry.envelope.text).foregroundStyle(.secondary)
                            Text(entry.status.label.rawValue).font(.caption2).foregroundStyle(.secondary)
                        }
                        .accessibilityIdentifier("cloud.pending.\(entry.status.label.rawValue)")
                    }
                }
                .listStyle(.plain)
                .onChange(of: model.room(ref)?.messages.last?.messageId) { _, id in
                    if let id { withAnimation { proxy.scrollTo(id, anchor: .bottom) } }
                }
            }
            if let problem = model.problem {
                Text(problem).font(.footnote).foregroundStyle(.red).accessibilityIdentifier("cloud.problem")
            }
            HStack {
                TextField("message", text: $draft, axis: .vertical)
                    .textFieldStyle(.roundedBorder)
                    .accessibilityIdentifier("cloud.composer")
                Button("send") {
                    let text = draft
                    draft = ""
                    Task { await model.send(text, in: ref) }
                }
                .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .accessibilityIdentifier("cloud.send")
            }
            .padding()
        }
        .navigationTitle(ref.roomId)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if ref.role == .owner || ref.role == .admin {
                Button("invite") { Task { await model.invite(to: ref) } }.accessibilityIdentifier("cloud.invite")
            }
        }
        .onAppear { model.select(ref) }
        .onDisappear { if model.selected == ref { model.select(nil) } }
        .overlay(alignment: .top) {
            Text(model.live ? "live" : "connecting").font(.caption2).foregroundStyle(.secondary)
                .accessibilityIdentifier(model.live ? "cloud.live" : "cloud.connecting")
        }
    }
}
#endif
