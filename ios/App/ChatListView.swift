// The roster.
//
// Messages-shaped: a glass header, built-in and user-named sidebar sections,
// channels as compact tiles, and bot conversations as rows. The floating bar
// keeps Updates, search, organization and new-bot actions within one thumb's
// reach while everything scrolls beneath the glass.
import SwiftUI
import PhotosUI
import CompanionCore

struct ChatListView: View {
    @EnvironmentObject private var session: Session
    @State private var query = ""
    @State private var pinnedChats = PinnedChats()
    @State private var showingProfile = false
    @State private var profilePhoto: PhotosPickerItem?
    @AppStorage("bos.personalAvatar") private var personalAvatar = ""

    @AppStorage(PrefKey.activityDetail) private var activityDetail = ActivityDetail.reduced.rawValue
    /// Driven so that making a bot can open it. Value-based navigation alone
    /// cannot push without a tap, and a new bot appearing silently at the
    /// bottom of the roster is a poor answer to pressing +.
    @State private var path = NavigationPath()
    @State private var searchHits: [SearchHit] = []
    @State private var searching = false
    @State private var searchOpen = false
    @State private var showingUpdates = false
    @State private var showingWalkie = false
    @State private var showingNewGroup = false
    @State private var showingNewBot = false
    @State private var creatingBot = false
    @State private var showingNewSection = false
    @State private var expandedBots = Set<String>()
    @State private var collapsedFolders = Set<String>()
    @State private var creatingThreads = Set<String>()
    @State private var managingThreads: Chat?
    @State private var sharedMe: SharedMe?
    @State private var sharedContacts: [SharedContact] = []
    @State private var sharedRooms: [SharedRoomSummary] = []
    @State private var groupPendingDeletion: SharedRoomSummary?
    @State private var groupDeleteError: String?
    @FocusState private var searchFocused: Bool

    /// Room for the floating bar, so the last row can scroll clear of it.
    private static let barClearance: CGFloat = 20

    var body: some View {
        NavigationStack(path: $path) {
            GeometryReader { geo in
            VStack(spacing: 0) {
                header
                StatusBanner()
                if searchOpen {
                    HStack {
                        TextField("Search bots and messages", text: $query)
                            .focused($searchFocused)
                        Button("Done") { query = ""; searchOpen = false }
                    }
                    .padding(.horizontal, 20).padding(.bottom, 12)
                }

                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        if query.isEmpty {
                            rosterSections
                        } else {
                            if !searchHits.isEmpty {
                                HStack {
                                    sectionLabel(Text("Messages"))
                                    Spacer()
                                    if searching { ProgressView().controlSize(.small) }
                                }
                                .padding(.top, 10)
                                .padding(.bottom, 4)

                                ForEach(searchHits) { hit in
                                    Button {
                                        Task {
                                            if let chat = await session.open(hit) {
                                                Haptics.selection()
                                                path.append(chat)
                                            }
                                        }
                                    } label: {
                                        SearchHitRow(hit: hit)
                                    }
                                    .buttonStyle(.plain)
                                    .padding(.horizontal, 16)
                                }
                                sectionLabel(Text("Threads"))
                                    .padding(.top, 14)
                                    .padding(.bottom, 4)
                            } else if searching {
                                ProgressView()
                                    .controlSize(.small)
                                    .frame(maxWidth: .infinity)
                                    .padding(.top, 24)
                            }

                            botRows(chats)
                        }
                    }
                    .padding(.bottom, Self.barClearance)
                }
                .refreshable { await session.refresh(); await refreshShared() }
                .overlay {
                    if rosterIsEmpty {
                        if query.isEmpty && !session.state.rosterLoaded {
                            ContentUnavailableView {
                                Label("Your chats are not loaded yet", systemImage: "wifi.slash")
                            } description: {
                                Text("Keep BOS open on your Mac. Your chats will appear when the connection is ready.")
                            } actions: {
                                Button("Try again") { Task { await session.refresh(); await refreshShared() } }
                                    .buttonStyle(.bordered)
                            }
                        } else {
                            ContentUnavailableView(
                                query.isEmpty ? "Your chats start here" : "Nothing matches",
                                systemImage: query.isEmpty ? "bubble.left.and.bubble.right" : "magnifyingglass",
                                description: Text(
                                    query.isEmpty
                                        ? "Use + to start a conversation or create a bot."
                                        : "No thread matches \u{201C}\(query)\u{201D}."
                                )
                            )
                        }
                    }
                }
            }
            // top-aligned: the roster fills downward from the header
            .frame(maxWidth: CompanionLayout.rosterWidth, maxHeight: .infinity, alignment: .top)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            // a bot that stopped for you grows out of the island
            .overlay(alignment: .top) {
                if CompanionLayout.supportsIslandPresentation {
                    NeedsYouIsland(
                        update: session.state.updates.first { $0.kind == .needsYou },
                        hasIsland: IslandGeometry.hasIsland(topInset: geo.safeAreaInsets.top)
                    ) { chat in path.append(chat) }
                }
            }
            }
            .toolbar(.hidden, for: .navigationBar)
            .interactiveBackSwipe()
            .navigationDestination(for: Chat.self) { ChatView(chat: $0) }
            .navigationDestination(for: SharedRoomSummary.self) { room in
                SharedChatView(room: room, selfID: sharedMe?.actorId ?? "", contacts: sharedContacts)
            }
            .task(id: session.connection?.id) {
                pinnedChats = PinnedChats.load(scope: session.connection?.id ?? "")
                while !Task.isCancelled {
                    await refreshShared()
                    try? await Task.sleep(for: .seconds(3))
                }
            }
            .onReceive(NotificationCenter.default.publisher(for: .sharedRoomPushTapped)) { event in
                guard let roomID = event.object as? String else { return }
                if let room = sharedRooms.first(where: { $0.id == roomID }) {
                    UserDefaults.standard.removeObject(forKey: "bos.pendingSharedRoomPush")
                    path.append(room)
                } else { Task { await refreshShared() } }
            }
            .task(id: "\(session.connection?.id ?? "")|\(personalAvatar.hashValue)") {
                guard session.connection != nil else { return }
                try? await session.setProfilePhoto(personalAvatar.isEmpty ? nil : personalAvatar)
                await refreshShared()
            }
            .onChange(of: session.notificationChat) { _, chat in
                guard let chat else { return }
                path.append(chat)
                session.consumeNotificationChat()
            }
            .task {
                if let chat = session.notificationChat {
                    path.append(chat)
                    session.consumeNotificationChat()
                }
            }
#if DEBUG
            // Preview-only routes let the screenshot harness reach screens
            // that normally require a paired computer and a tap.
            .task {
                if ProcessInfo.processInfo.arguments.contains("-open-new-section") {
                    showingNewSection = true
                }
                if ProcessInfo.processInfo.arguments.contains("-open-walkie") {
                    showingWalkie = true
                }
                if ProcessInfo.processInfo.arguments.contains("-open-first"),
                   path.isEmpty, let first = chats.first {
                    path.append(first.chat)
                }
            }
#endif
            .sheet(isPresented: $showingUpdates) {
                UpdatesSheet { chat in
                    showingUpdates = false
                    path.append(chat)
                }
            }
            .fullScreenCover(isPresented: $showingWalkie) {
                WalkieView { chat in
                    showingWalkie = false
                    path.append(chat)
                }
                .environmentObject(session)
            }
            .sheet(isPresented: $showingNewBot) {
                NavigationStack {
                    Form {
                        Section {
                            Text("Create a new bot, then choose its name, model and profile in settings.")
                            Button(creatingBot ? "Creating…" : "Create bot") { confirmCreateBot() }
                                .disabled(creatingBot)
                        }
                    }
                    .navigationTitle("New bot")
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) {
                            Button("Cancel") { showingNewBot = false }.disabled(creatingBot)
                        }
                    }
                }
                .interactiveDismissDisabled(creatingBot)
                .presentationDetents([.medium])
            }
            .sheet(isPresented: $showingNewGroup) {
                NewGroupSheet(created: { room in
                    showingNewGroup = false
                    path.append(Chat.room(room))
                }, sharedContacts: sharedContacts, sharedMe: sharedMe, createdShared: { room in
                    showingNewGroup = false
                    sharedRooms.append(room)
                    path.append(room)
                })
            }
            .sheet(isPresented: $showingNewSection) {
                NewSectionSheet()
            }
            .confirmationDialog("Delete group for everyone?", isPresented: Binding(
                get: { groupPendingDeletion != nil },
                set: { if !$0 { groupPendingDeletion = nil } }
            ), titleVisibility: .visible) {
                Button("Delete group", role: .destructive) {
                    guard let room = groupPendingDeletion else { return }
                    groupPendingDeletion = nil
                    Task {
                        do {
                            try await session.deleteSharedRoom(room)
                            sharedRooms.removeAll { $0.id == room.id }
                            await refreshShared()
                        } catch {
                            groupDeleteError = error.localizedDescription
                            await refreshShared()
                        }
                    }
                }
            } message: {
                Text("This removes the group and its messages for all members.")
            }
            .alert("Could not delete group", isPresented: Binding(
                get: { groupDeleteError != nil },
                set: { if !$0 { groupDeleteError = nil } }
            )) {
                Button("OK", role: .cancel) { groupDeleteError = nil }
            } message: {
                Text(groupDeleteError ?? "")
            }
            .sheet(item: $managingThreads) { chat in
                TaskManagerView(chat: chat) { threadId in
                    guard let bot = session.state.bot(forThread: threadId) else { return }
                    managingThreads = nil
                    path.append(Chat.bot(bot))
                }
            }
            .task(id: query) {
                let expected = query
                guard expected.trimmingCharacters(in: .whitespacesAndNewlines).count >= 2 else {
                    searchHits = []
                    searching = false
                    return
                }
                searching = true
                defer {
                    if query == expected { searching = false }
                }
                try? await Task.sleep(for: .milliseconds(250))
                guard !Task.isCancelled, query == expected else { return }
                let hits = await session.search(expected)
                guard !Task.isCancelled, query == expected else { return }
                searchHits = hits
            }
        }
    }

    // MARK: - Header

    /// The paired computer's profile on the left, one settings action on the
    /// right, and where you are in between. The avatar is identity, not a
    /// second hidden route to the same screen.
    private var header: some View {
        HStack {
            Button { showingProfile = true } label: { personalAvatarView }
                .buttonStyle(.plain).accessibilityLabel("Your profile and settings")
            Spacer()
            searchButton
            if session.canAdminister {
                Menu {
                    Button("New group", systemImage: "person.3", action: openNewGroup)
                    Button("New bot", systemImage: "square.and.pencil", action: createBot)
                    Button("New section", systemImage: "folder.badge.plus", action: openNewSection)
                        .disabled(!hasVisibleBots)
                } label: {
                    Image(systemName: "plus")
                        .font(.system(size: 20, weight: .medium))
                        .foregroundStyle(Color.primary)
                        .frame(width: 48, height: 48)
                        .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .glassCapsule()
                .accessibilityLabel("Create")
            } else {
                GlassButton(systemImage: "plus", size: 48, weight: .medium, action: openNewGroup)
                    .accessibilityLabel("New group")
            }
        }
        .padding(.horizontal, 20).padding(.top, 8).padding(.bottom, 20)
        .sheet(isPresented: $showingProfile) {
            NavigationStack {
                Form {
                    Section {
                        PhotosPicker(selection: $profilePhoto, matching: .images) {
                            HStack { personalAvatarView; Text("Change profile photo") }
                        }
                        if !personalAvatar.isEmpty {
                            Button("Remove photo", role: .destructive) {
                                personalAvatar = ""
                                Task { try? await session.setProfilePhoto(nil); await refreshShared() }
                            }
                        }
                    }
                    Section {
                        NavigationLink("Settings & computers") { SettingsView() }
                    }
                }
                .navigationTitle("Your profile")
                .toolbar { ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { showingProfile = false }
                } }
                .onChange(of: profilePhoto) { _, item in
                    Task {
                        guard let data = try? await item?.loadTransferable(type: Data.self),
                              let photo = UIImage(data: data) else { return }
                        let ratio = min(256 / photo.size.width, 256 / photo.size.height)
                        let size = CGSize(width: photo.size.width * ratio, height: photo.size.height * ratio)
                        let thumbnail = UIGraphicsImageRenderer(size: size).image { _ in
                            photo.draw(in: CGRect(origin: .zero, size: size))
                        }
                        personalAvatar = thumbnail.jpegData(compressionQuality: 0.85)?.base64EncodedString() ?? ""
                    }
                }
            }
        }
    }

    @ViewBuilder private var personalAvatarView: some View {
        if PersonCutout.image(dataURL: personalAvatar) != nil {
            PersonPhotoView(dataURL: personalAvatar, size: 44)
        } else {
            ProfileAvatar(name: session.connection?.name ?? "You", size: 44)
        }
    }

    private var headerSubtitle: String {
        let name = session.connection?.name ?? "Not paired"
        switch session.status {
        case .live: return "\(name) · connected"
        case .connecting: return "\(name) · connecting…"
        case .offline: return "\(name) · offline"
        case .unauthorized: return "\(name) · unpaired"
        case .unpaired: return "Not paired"
        }
    }

    // MARK: - Sidebar sections

    /// Every thread across every bot that needs the person right now — the
    /// same rule and order as the thread tree, so the inbox can never
    /// disagree with it.
    private var attention: [AttentionThread] {
        crossBotAttentionThreads(session.state.bots).filter { ["waiting-on-you", "dead", "no-signal"].contains($0.task.activity ?? "") }
    }

    private func refreshShared() async {
        let connectionID = session.connection?.id
        guard connectionID != nil else {
            sharedMe = nil; sharedContacts = []; sharedRooms = []
            return
        }
        do {
            let (me, contacts, rooms) = try await session.sharedRoster()
            guard session.connection?.id == connectionID else { return }
            sharedMe = me
            sharedContacts = contacts
            sharedRooms = rooms
            cacheNotificationAvatars(contacts)
            if let roomID = UserDefaults.standard.string(forKey: "bos.pendingSharedRoomPush"),
               let room = rooms.first(where: { $0.id == roomID }) {
                UserDefaults.standard.removeObject(forKey: "bos.pendingSharedRoomPush")
                path.append(room)
            }
        } catch {
            guard session.connection?.id == connectionID else { return }
            sharedMe = nil; sharedContacts = []; sharedRooms = []
        }
    }

    @MainActor private func cacheNotificationAvatars(_ contacts: [SharedContact]) {
        for contact in contacts {
            if contact.kind == "bot" {
                let renderer = ImageRenderer(content: MausAvatar(color: contact.color ?? "green", size: 128,
                                                                  bodyId: contact.mascotBody, animated: false)
                    .frame(width: 128, height: 128))
                if let data = renderer.uiImage?.pngData() {
                    NotificationAvatarCache.store(data, for: contact.id)
                }
            } else if let avatar = contact.avatar,
                      let encoded = avatar.split(separator: ",", maxSplits: 1).last,
                      let data = Data(base64Encoded: String(encoded)),
                      let photo = (PersonCutout.image(dataURL: avatar) ?? UIImage(data: data))?.pngData() {
                NotificationAvatarCache.store(photo, for: contact.id)
            }
        }
        for bot in session.state.bots {
            let renderer = ImageRenderer(content: MausAvatar(color: bot.color, size: 128,
                                                              bodyId: bot.mascotBody, animated: false)
                .frame(width: 128, height: 128))
            if let data = renderer.uiImage?.pngData() {
                NotificationAvatarCache.store(data, for: "bot:\(bot.id)")
            }
        }
    }

    @ViewBuilder
    private var rosterSections: some View {
        if !attention.isEmpty {
            sectionLabel(Text("Needs attention"))
                .padding(.top, 10)
                .padding(.bottom, 4)
            ForEach(attention) { entry in
                Button {
                    Haptics.selection()
                    openAttention(entry)
                } label: {
                    AttentionRow(entry: entry)
                }
                .buttonStyle(.plain)
                .padding(.horizontal, 16)
            }
        }

        if !pinnedConversations.isEmpty { pinnedConversationGrid }

        sectionLabel(Text("Chats")).padding(.top, 18).padding(.bottom, 4)
        ForEach(orderedConversations.filter { !pinnedChats.ids.contains($0.id) }) { entry in
            switch entry {
            case .local(let summary): botRows([summary])
            case .contact(let contact): contactRow(contact)
            case .room(let room):
                Button { path.append(room) } label: {
                    sharedConversationRow(name: room.displayName(contacts: sharedContacts, selfID: sharedMe?.actorId ?? ""), subtitle: nil, preview: room.preview ?? "", at: room.lastActivity ?? 0, unreadCount: room.unreadCount ?? 0) {
                        GroupMarkView(members: GroupMarkView.faces(room, contacts: sharedContacts, selfID: sharedMe?.actorId), size: 52)
                    }
                }
                .buttonStyle(.plain)
                .contextMenu {
                    pinButton(.room(room))
                    if room.isGroup {
                        Button("Delete group", systemImage: "trash", role: .destructive) {
                            groupPendingDeletion = room
                        }
                    }
                }
            }
        }
    }

    private var pinnedConversations: [ConversationEntry] {
        // Search also exposes local bot rooms. Resolve their saved pins even
        // though the ordinary recent list shows people, shared groups and bots.
        let localRooms = session.state.chatSummaries(activity: activity).filter {
            if case .room = $0.chat { return true }; return false
        }.map(ConversationEntry.local)
        let byID = Dictionary(uniqueKeysWithValues: (orderedConversations + localRooms).map { ($0.id, $0) })
        return pinnedChats.visibleIDs(available: Set(byID.keys)).compactMap { byID[$0] }
    }

    private func togglePin(_ entry: ConversationEntry) {
        pinnedChats.toggle(entry.id)
        pinnedChats.save(scope: session.connection?.id ?? "")
        Haptics.selection()
    }

    private func pinButton(_ entry: ConversationEntry) -> some View {
        Button(pinnedChats.ids.contains(entry.id) ? "Unpin chat" : "Pin chat",
               systemImage: pinnedChats.ids.contains(entry.id) ? "pin.slash" : "pin") { togglePin(entry) }
    }

    private var pinnedConversationGrid: some View {
        LazyVGrid(columns: Array(repeating: GridItem(.flexible()), count: min(3, pinnedConversations.count)), spacing: 20) {
            ForEach(pinnedConversations) { entry in
                Button { openConversation(entry) } label: {
                    VStack(spacing: 7) {
                        ZStack(alignment: .topTrailing) {
                            pinnedAvatar(entry).frame(width: 82, height: 82)
                            if conversationBusy(entry) {
                                ProgressView().controlSize(.small)
                                    .padding(5).background(.background, in: Circle())
                            } else if conversationUnread(entry) {
                                Circle().fill(Color.accentColor).frame(width: 11, height: 11)
                                    .overlay(Circle().stroke(.background, lineWidth: 2))
                            }
                        }
                        Text(conversationName(entry)).font(.subheadline).foregroundStyle(.primary)
                            .lineLimit(2).multilineTextAlignment(.center)
                    }
                    .frame(maxWidth: .infinity, minHeight: 118, alignment: .top)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("\(conversationName(entry)), pinned chat\(conversationBusy(entry) ? ", working" : conversationUnread(entry) ? ", unread" : "")")
                .contextMenu {
                    pinButton(entry)
                    if pinnedChats.ids.first != entry.id {
                        Button("Move to front", systemImage: "arrow.up.to.line") {
                            pinnedChats.moveToFront(entry.id)
                            pinnedChats.save(scope: session.connection?.id ?? "")
                        }
                    }
                }
            }
        }
        .padding(.horizontal, 24).padding(.top, 20).padding(.bottom, 6)
        .accessibilityIdentifier("pinned-chats")
    }

    @ViewBuilder private func pinnedAvatar(_ entry: ConversationEntry) -> some View {
        switch entry {
        case .local(let summary):
            ChatAvatarView(chat: summary.chat, size: 82,
                           state: MausState.forChat(summary.chat, in: session.state), animated: false)
        case .contact(let contact): contactAvatar(contact, size: 82)
        case .room(let room): GroupMarkView(members: GroupMarkView.faces(room, contacts: sharedContacts, selfID: sharedMe?.actorId), size: 82)
        }
    }

    private func conversationName(_ entry: ConversationEntry) -> String {
        switch entry {
        case .local(let summary): return summary.chat.name
        case .contact(let contact): return contact.name
        case .room(let room): return room.displayName(contacts: sharedContacts, selfID: sharedMe?.actorId ?? "")
        }
    }
    private func conversationBusy(_ entry: ConversationEntry) -> Bool {
        if case .local(let summary) = entry { return summary.chat.busy }
        return false
    }
    private func conversationUnread(_ entry: ConversationEntry) -> Bool {
        switch entry {
        case .local(let summary): return summary.chat.unread
        case .room(let room): return (room.unreadCount ?? 0) > 0
        case .contact(let contact):
            return sharedRooms.contains { !$0.isGroup && $0.memberIds.count == 2 && $0.memberIds.contains(contact.id) && $0.memberIds.contains(sharedMe?.actorId ?? "") && ($0.unreadCount ?? 0) > 0 }
        }
    }
    private func openConversation(_ entry: ConversationEntry) {
        switch entry {
        case .local(let summary): path.append(homeChat(summary.chat))
        case .room(let room): path.append(room)
        case .contact(let contact): openContact(contact)
        }
    }
    private func openContact(_ contact: SharedContact) {
        let connectionID = session.connection?.id
        Task {
            do {
                let room = try await session.openSharedDM(targetId: contact.id)
                guard session.connection?.id == connectionID else { return }
                if !sharedRooms.contains(where: { $0.id == room.id }) { sharedRooms.append(room) }
                path.append(room)
            } catch { session.actionError = error.localizedDescription }
        }
    }

    private enum ConversationEntry: Identifiable {
        case local(ChatSummary), contact(SharedContact), room(SharedRoomSummary)
        var id: String {
            switch self {
            case .local(let summary): return "local:\(summary.id)"
            case .contact(let contact): return "contact:\(contact.id)"
            case .room(let room): return "room:\(room.id)"
            }
        }
    }

    private var orderedConversations: [ConversationEntry] {
        let selfID = sharedMe?.actorId ?? ""
        // Only people are shared-room contacts. A linked Mac's bots now arrive
        // through /api/bots as ordinary (remote) bots and render as local rows.
        let remoteContacts = sharedContacts.filter { contact in
            contact.id != selfID && contact.kind == "person"
        }
        let contactIDs = Set(remoteContacts.map(\.id))
        let directRooms = sharedRooms.filter { $0.memberIds.count == 2 && !$0.isGroup && $0.memberIds.contains(selfID) }
        let entries: [(ConversationEntry, Double)] =
            session.state.chatSummaries(activity: activity).filter { if case .bot = $0.chat { return true }; return false }
                .map { (.local($0), $0.lastActivity) }
            + remoteContacts.map { contact in
                (.contact(contact), directRooms.first(where: { $0.memberIds.contains(contact.id) })?.lastActivity ?? 0)
            }
            + sharedRooms.filter { room in !room.memberIds.contains(where: contactIDs.contains) || room.memberIds.count != 2 || room.isGroup }
                .map { (.room($0), $0.lastActivity ?? 0) }
        return entries.sorted { left, right in
            if left.1 != right.1 { return left.1 > right.1 }
            return left.0.id < right.0.id
        }.map(\.0)
    }

    private func contactRow(_ contact: SharedContact) -> some View {
        let room = sharedRooms.first { $0.memberIds.count == 2 && !$0.isGroup && $0.memberIds.contains(sharedMe?.actorId ?? "") && $0.memberIds.contains(contact.id) }
        return Button { openContact(contact) } label: {
            sharedConversationRow(name: contact.name, subtitle: contact.title, preview: room?.preview ?? "", at: room?.lastActivity ?? 0, unreadCount: room?.unreadCount ?? 0) {
                contactAvatar(contact, size: 52)
            }
        }
        .buttonStyle(.plain)
        .contextMenu { pinButton(.contact(contact)) }
    }

    private func sharedConversationRow<Avatar: View>(name: String, subtitle: String?, preview: String, at: Double, unreadCount: Int = 0, @ViewBuilder avatar: () -> Avatar) -> some View {
        HStack(alignment: .top, spacing: 0) {
            Color.clear.frame(width: 22)
            HStack(alignment: .top, spacing: 14) {
                avatar().padding(.top, 12)
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 8) {
                        Text(name).font(.system(size: 17, weight: .semibold)).foregroundStyle(Color.primary).lineLimit(1).layoutPriority(1)
                        Spacer(minLength: 4)
                        if unreadCount > 0 { Text(unreadCount > 99 ? "99+" : String(unreadCount)).font(.caption.weight(.semibold)).foregroundStyle(.white).padding(.horizontal, 6).padding(.vertical, 3).background(Color.accentColor, in: Capsule()).accessibilityLabel("\(unreadCount) unread messages") }
                        if at > 0 { Text(RelativeStamp.list(at)).font(.system(size: 15)).foregroundStyle(Color.secondary).fixedSize() }
                        Image(systemName: "chevron.right").font(.system(size: 13, weight: .semibold)).foregroundStyle(Color.secondary.opacity(0.5))
                    }
                    if let subtitle, !subtitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        Text(subtitle).font(.system(size: 13, weight: .medium)).foregroundStyle(Color.secondary).lineLimit(2)
                    }
                    Text(preview.isEmpty ? " " : preview).font(.system(size: 15)).foregroundStyle(Color.secondary).lineLimit(1)
                }
                .padding(.vertical, 12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .overlay(alignment: .bottom) { Divider() }
            }
            .padding(.trailing, 16)
        }
        .padding(.leading, 6)
        .contentShape(Rectangle())
    }

    @ViewBuilder private func contactAvatar(_ contact: SharedContact, size: CGFloat) -> some View {
        if contact.kind == "bot" {
            MausAvatar(color: contact.color ?? "green", size: size, bodyId: contact.mascotBody, animated: false)
        } else if let avatar = contact.avatar, PersonCutout.image(dataURL: avatar) != nil {
            PersonPhotoView(dataURL: avatar, size: size)
        } else {
            ProfileAvatar(name: contact.name, size: size)
        }
    }

    private func channelsStrip(title: LocalizedStringKey, rooms: [Room], showsCreate: Bool) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            sectionLabel(Text(title))
            channelTiles(rooms, showsCreate: showsCreate)
        }
        .padding(.top, 2)
    }

    private func channelTiles(_ rooms: [Room], showsCreate: Bool) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(rooms) { room in
                    NavigationLink(value: Chat.room(room)) {
                        GroupTile(room: room)
                    }
                    .buttonStyle(.plain)
                }
                if showsCreate {
                    Button {
                        Haptics.selection()
                        showingNewGroup = true
                    } label: {
                        GroupTile(room: nil)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("New group")
                }
            }
            .padding(.horizontal, 16)
        }
    }

    private func homeChat(_ chat: Chat) -> Chat {
        if case let .bot(bot) = chat { return .bot((session.state.bot(bot.id) ?? bot).homeThread) }
        return chat
    }

    @ViewBuilder
    private func botRows(_ rows: [ChatSummary]) -> some View {
        ForEach(Array(rows.enumerated()), id: \.element.id) { index, summary in
            VStack(spacing: 0) {
                NavigationLink(value: homeChat(summary.chat)) {
                    ChatRow(
                        chat: summary.chat,
                        preview: summary.chat.busy ? "Working…" : summary.preview,
                        at: summary.lastActivity,
                        state: MausState.forChat(summary.chat, in: session.state),
                        waiting: waitingChats.contains(summary.chat.id),
                        last: index == rows.count - 1
                    )
                }
                .buttonStyle(.plain)
                .contextMenu { pinButton(.local(summary)) }

            }
        }
    }

    // MARK: - Bottom bar

    private var bottomBar: some View {
        GlassGroup(spacing: 8) {
            HStack(spacing: 8) {
                if searchOpen {
                    HStack(spacing: 8) {
                        Image(systemName: "magnifyingglass")
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(Color.secondary)
                        TextField("Search threads", text: $query)
                            .font(.system(size: 17))
                            .submitLabel(.search)
                            .autocorrectionDisabled()
                            .focused($searchFocused)
                        if !query.isEmpty {
                            Button {
                                query = ""
                            } label: {
                                Image(systemName: "xmark.circle.fill").foregroundStyle(Color.secondary)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(.horizontal, 16)
                    .frame(height: 52)
                    .glassCapsule()

                    Button("Cancel") {
                        query = ""
                        searchOpen = false
                        searchFocused = false
                    }
                    .font(.system(size: 17))
                    .foregroundStyle(Color.primary)
                    .padding(.horizontal, 16)
                    .frame(height: 52)
                    .glassCapsule()
                } else {
                    ViewThatFits(in: .horizontal) {
                        expandedBottomActions
                        compactBottomActions
                    }
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 8)
        .animation(.snappy(duration: 0.25), value: searchOpen)
    }

    private var expandedBottomActions: some View {
        HStack(spacing: 8) {
            updatesButton
                .frame(width: 180)
            searchButton
            walkieButton
            if session.canAdminister {
                sectionButton
                newBotButton
            }
        }
    }

    private var compactBottomActions: some View {
        HStack(spacing: 8) {
            updatesButton
                .frame(minWidth: 148)
            searchButton
            walkieButton
            // Creating bots and sections needs the admin scope on a server;
            // a chat-only phone is not shown buttons the server would refuse.
            if session.canAdminister {
                Menu {
                    Button("New group", systemImage: "person.3", action: openNewGroup)
                    Button("New section", systemImage: "folder.badge.plus", action: openNewSection)
                        .disabled(!hasVisibleBots)
                    Button("New bot", systemImage: "square.and.pencil", action: createBot)
                } label: {
                    Image(systemName: "plus")
                        .font(.system(size: 20, weight: .medium))
                        .foregroundStyle(Color.primary)
                        .frame(width: 48, height: 48)
                        .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .glassCapsule()
                .accessibilityLabel("Create")
            }
        }
    }

    private var updatesButton: some View {
        UpdatesPill(updates: session.state.updates) {
            Haptics.selection()
            showingUpdates = true
        }
        .frame(height: 52)
    }

    private var searchButton: some View {
        GlassButton(systemImage: "magnifyingglass", size: 48, weight: .semibold) {
            Haptics.selection()
            searchOpen = true
            searchFocused = true
        }
        .accessibilityLabel("Search")
    }

    /// Walkie: hold-to-talk with every agent's state at a glance.
    private var walkieButton: some View {
        GlassButton(systemImage: "waveform", size: 48, weight: .semibold) {
            Haptics.selection()
            showingWalkie = true
        }
        .accessibilityLabel("Walkie")
    }

    private var sectionButton: some View {
        GlassButton(systemImage: "folder.badge.plus", size: 48, weight: .medium, action: openNewSection)
            .disabled(!hasVisibleBots)
            .opacity(hasVisibleBots ? 1 : 0.45)
            .accessibilityLabel("New section")
    }

    private var newBotButton: some View {
        GlassButton(systemImage: "square.and.pencil", size: 48, weight: .medium, action: createBot)
            .accessibilityLabel("New bot")
    }

    private var hasVisibleBots: Bool {
        session.state.bots.contains { $0.hidden != true }
    }

    private func openNewGroup() {
        Haptics.selection()
        showingNewGroup = true
    }

    private func openNewSection() {
        Haptics.selection()
        showingNewSection = true
    }

    private func createBot() {
        showingNewBot = true
    }

    private func confirmCreateBot() {
        guard !creatingBot else { return }
        creatingBot = true
        Task {
            defer { creatingBot = false }
            if let bot = await session.createBot() {
                showingNewBot = false
                Haptics.success()
                path.append(Chat.bot(bot))
            }
        }
    }

    // MARK: - Data

    /// The reader's activity level, which the roster preview folds by.
    private var activity: ActivityDetail { .hidden }

    private var chats: [ChatSummary] {
        let all = session.state.chatSummaries(activity: activity)
        guard !query.isEmpty else {
            // rooms live in the strip; the list is bots
            return all.filter { if case .bot = $0.chat { return true } else { return false } }
        }
        return all.filter {
            $0.chat.name.localizedCaseInsensitiveContains(query)
                || $0.chat.subtitle.localizedCaseInsensitiveContains(query)
                || $0.preview.localizedCaseInsensitiveContains(query)
                || matchesThread($0.chat)
        }
    }

    private func matchesThread(_ chat: Chat) -> Bool {
        guard case let .bot(bot) = chat else { return false }
        return !bot.threadGroups(matching: query, queuedThreadIds: session.state.queuedThreadIds).isEmpty
    }

    private func openAttention(_ entry: AttentionThread) {
        guard let bot = entry.destinationBot(in: session.state) else { return }
        path.append(Chat.bot(bot))
    }

    private func summaries(for bots: [Bot]) -> [ChatSummary] {
        let ids = Set(bots.map(\.id))
        return session.state.chatSummaries(activity: activity).filter { summary in
            if case let .bot(bot) = summary.chat { return ids.contains(bot.id) }
            return false
        }
    }

    private var waitingChats: Set<String> {
        Set(session.state.pendingApprovals.compactMap { session.state.chat(forThread: $0.threadId)?.id })
    }

    private var rosterIsEmpty: Bool {
        if query.isEmpty {
            return session.state.bots.allSatisfy { $0.hidden == true } && session.state.rooms.isEmpty && sharedContacts.isEmpty && sharedRooms.isEmpty
        }
        return chats.isEmpty && searchHits.isEmpty && !searching
    }

    private func sectionLabel(_ text: Text) -> some View {
        text
            .textCase(.uppercase)
            .font(.system(size: 13, weight: .semibold))
            .tracking(0.4)
            .foregroundStyle(Color.secondary)
            .padding(.horizontal, 20)
    }
}

// MARK: - Rows and tiles

/// A room as a round tile: the first two members' mascots stacked, its name
/// beneath. `nil` is the "make one" tile.
struct GroupTile: View {
    let room: Room?
    @EnvironmentObject private var session: Session

    var body: some View {
        VStack(spacing: 7) {
            ZStack {
                if let room {
                    Circle().fill(Color.secondary.opacity(0.14))
                    let bots = memberBots(room)
                    if let first = bots.first {
                        BotAvatarView(bot: first, size: 34, state: .happy, animated: false)
                            .offset(x: -9, y: -6)
                    }
                    if bots.count > 1 {
                        BotAvatarView(bot: bots[1], size: 30, state: .happy, animated: false)
                            .padding(2)
                            .background(Circle().fill(Color(uiColor: .systemBackground)))
                            .offset(x: 11, y: 9)
                    }
                    if room.unread {
                        Circle()
                            .fill(MausPalette.color("blue"))
                            .frame(width: 10, height: 10)
                            .overlay(Circle().stroke(Color(uiColor: .systemBackground), lineWidth: 2))
                            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing)
                            .padding(3)
                    }
                } else {
                    Circle()
                        .strokeBorder(style: StrokeStyle(lineWidth: 1.5, dash: [4, 4]))
                        .foregroundStyle(Color.secondary.opacity(0.6))
                    Image(systemName: "plus")
                        .font(.system(size: 22, weight: .medium))
                        .foregroundStyle(Color.secondary)
                }
            }
            .frame(width: 64, height: 64)

            Text(room?.name ?? "New group")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(room == nil ? Color.secondary : Color.primary)
                .lineLimit(1)
        }
        .frame(width: 76)
        .contentShape(Rectangle())
    }

    private func memberBots(_ room: Room) -> [Bot] {
        room.memberIds.compactMap { session.state.bot($0) }
    }
}

/// One thread that needs the person, from any bot: title, status, and the
/// bot it belongs to, ready to jump straight there. Waiting outranks
/// working, which outranks queued and unread — the same order as the tree.
struct AttentionRow: View {
    let entry: AttentionThread

    private var waiting: Bool { entry.task.activity == "waiting-on-you" }
    private var working: Bool { !waiting && (entry.task.busy == true || entry.task.activity == "working") }
    private var queued: Bool { !waiting && !working && entry.task.activity == "queued" }

    private var statusText: String {
        if waiting { return "Waiting on you" }
        if working { return "Working" }
        if queued { return "Queued" }
        return "Unread"
    }

    var body: some View {
        HStack(spacing: 12) {
            Group {
                if working {
                    ProgressView().controlSize(.small)
                } else {
                    Image(systemName: waiting ? "exclamationmark.circle.fill" : queued ? "clock" : "bell.badge.fill")
                        .font(.system(size: 15, weight: .medium))
                }
            }
            .foregroundStyle(waiting ? Color.orange : queued ? Color.secondary : Color.accentColor)
            .frame(width: 24)

            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: entry.task.displayTitle)
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(Color.primary)
                    .lineLimit(1)
                Text("\(entry.botName) · \(statusText)")
                    .font(.system(size: 12))
                    .foregroundStyle(Color.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 8)
        .frame(minHeight: 44)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(entry.task.displayTitle), \(entry.botName), \(statusText)")
    }
}

struct ChatRow: View {
    let chat: Chat
    let preview: String
    let at: Double
    var state: MausState = .idle
    var waiting = false
    var last = false

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            // the unread dot, in the bot's own colour, at the very edge
            ZStack {
                if chat.unread && !chat.busy {
                    Circle()
                        .fill(MausPalette.color(chat.color))
                        .frame(width: 10, height: 10)
                }
            }
            .frame(width: 22)
            .frame(maxHeight: .infinity)

            HStack(alignment: .top, spacing: 14) {
                ChatAvatarView(chat: chat, size: 52, state: state, animated: state.showsActivity)
                    .padding(.top, 12)

                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 8) {
                        Text(chat.name)
                            .font(.system(size: 17, weight: .semibold))
                            .foregroundStyle(Color.primary)
                            .lineLimit(1)
                            .layoutPriority(1)

                        Spacer(minLength: 4)

                        Text(RelativeStamp.list(at))
                            .font(.system(size: 15))
                            .foregroundStyle(Color.secondary)
                            .fixedSize()
                        Image(systemName: "chevron.right")
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(Color.secondary.opacity(0.5))
                    }

                    if chat.isBot, !chat.subtitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        Text(chat.subtitle)
                            .font(.system(size: 13, weight: .medium))
                            .foregroundStyle(Color.secondary)
                            .lineLimit(2)
                            .fixedSize(horizontal: false, vertical: true)
                    }

                    HStack(alignment: .top, spacing: 8) {
                        // one line for every bot, so the rows keep one rhythm
                        Text(preview.isEmpty ? " " : preview)
                            .font(.system(size: 15))
                            .foregroundStyle(Color.secondary)
                            .lineLimit(1)

                        Spacer(minLength: 0)

                        if chat.busy {
                            ProgressView().controlSize(.mini).padding(.top, 3)
                        }
                    }

                    if waiting {
                        Label("Waiting on you", systemImage: "hand.raised.fill")
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(.white)
                            .padding(.horizontal, 9)
                            .padding(.vertical, 4)
                            .background(Capsule().fill(MausPalette.color(chat.color)))
                            .padding(.top, 4)
                    }
                }
                .padding(.vertical, 12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .overlay(alignment: .bottom) {
                    if !last { Divider() }
                }
            }
            .padding(.trailing, 16)
        }
        .padding(.leading, 6)
        .contentShape(Rectangle())
    }
}

/// The floating pill: who is doing what right now, at a glance.
struct UpdatesPill: View {
    let updates: [ChatUpdate]
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                if !updates.isEmpty {
                    MascotStack(colors: Array(updates.prefix(3).map(\.chat.color)))
                }
                VStack(alignment: .leading, spacing: 1) {
                    HStack(spacing: 4) {
                        if let first = updates.first {
                            switch first.kind {
                            case .needsYou:
                                Image(systemName: "hand.raised.fill")
                                    .font(.system(size: 11, weight: .bold))
                                    .foregroundStyle(MausPalette.color(first.chat.color))
                                Text("\(first.chat.name) needs you")
                            case .working:
                                Text("\(first.chat.name) is working")
                            case .toReview:
                                Text("\(first.chat.name) has an update")
                            }
                        } else {
                            Text("All quiet")
                        }
                    }
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(updates.isEmpty ? Color.secondary : Color.primary)
                    .lineLimit(1)

                    Text(subline)
                        .font(.system(size: 12))
                        .foregroundStyle(Color.secondary)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.up")
                    .font(.system(size: 12, weight: .bold))
                    .foregroundStyle(Color.secondary)
            }
            .padding(.leading, updates.isEmpty ? 16 : 7)
            .padding(.trailing, 12)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .glassCapsule()
        .accessibilityLabel("Updates")
        .accessibilityIdentifier("updates-button")
    }

    private var subline: String {
        guard let first = updates.first else { return "Nothing needs you" }
        let rest = updates.count - 1
        if rest == 0 { return first.line.isEmpty ? " " : first.line }
        return rest == 1 ? "1 more update" : "\(rest) more updates"
    }
}

/// Up to three mascots overlapping, the way a group of faces reads at a glance.
struct MascotStack: View {
    let colors: [String]
    var size: CGFloat = 28
    var overlap: CGFloat = 12

    var body: some View {
        HStack(spacing: -overlap) {
            ForEach(Array(colors.enumerated()), id: \.offset) { _, color in
                MausAvatar(color: color, size: size, state: .idle, animated: false)
                    .padding(2)
                    .background(Circle().fill(Color(uiColor: .systemBackground)))
            }
        }
    }
}

/// Connection state, shown only when it is not "fine".
struct StatusBanner: View {
    @EnvironmentObject private var session: Session

    var body: some View {
        Group {
            switch session.status {
            case .live, .unpaired:
                EmptyView()
            case .connecting:
                banner("Connecting…", systemImage: "arrow.triangle.2.circlepath", tint: .secondary)
            case let .offline(reason):
                banner(reason, systemImage: "wifi.slash", tint: .orange)
            case .unauthorized:
                banner("This device was unpaired on the computer.", systemImage: "lock.slash", tint: .red)
            }
        }
        .animation(.default, value: session.status)
    }

    private func banner(_ text: String, systemImage: String, tint: Color) -> some View {
        Label(text, systemImage: systemImage)
            .font(.footnote)
            .foregroundStyle(tint)
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .glassCapsule(interactive: false)
            .padding(.bottom, 8)
    }
}

struct SearchHitRow: View {
    let hit: SearchHit

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: hit.role == .user ? "person.fill" : "bubble.left.fill")
                .foregroundStyle(Color.secondary)
                .frame(width: 26, height: 26)
                .background(Circle().fill(Color.secondary.opacity(0.13)))

            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text(hit.name).font(.system(size: 15, weight: .semibold))
                    if let task = hit.task, !task.isEmpty {
                        Text(task).font(.system(size: 12)).foregroundStyle(Color.secondary)
                    }
                    Spacer()
                    Text(RelativeStamp.list(hit.at))
                        .font(.system(size: 12))
                        .foregroundStyle(Color.secondary)
                }
                Text(hit.snippet)
                    .font(.system(size: 14))
                    .foregroundStyle(Color.secondary)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
            }
        }
        .padding(.vertical, 10)
        .contentShape(Rectangle())
    }
}

/// Timestamps the way a messaging app writes them.
enum RelativeStamp {
    /// Roster: time today, weekday this week, date beyond that.
    static func list(_ at: Double) -> String {
        guard at > 0 else { return "" }
        let date = Date(timeIntervalSince1970: at / 1000)
        let calendar = Calendar.current
        if calendar.isDateInToday(date) {
            return date.formatted(date: .omitted, time: .shortened)
        }
        if calendar.isDateInYesterday(date) { return "Yesterday" }
        if let week = calendar.date(byAdding: .day, value: -6, to: Date()), date > week {
            return date.formatted(.dateTime.weekday(.wide))
        }
        return date.formatted(.dateTime.day().month(.abbreviated))
    }

    /// In a transcript: enough to place a gap in the conversation.
    static func separator(_ date: Date) -> String {
        let calendar = Calendar.current
        let time = date.formatted(date: .omitted, time: .shortened)
        if calendar.isDateInToday(date) { return "Today \(time)" }
        if calendar.isDateInYesterday(date) { return "Yesterday \(time)" }
        return "\(date.formatted(.dateTime.day().month(.abbreviated))) \(time)"
    }
}
