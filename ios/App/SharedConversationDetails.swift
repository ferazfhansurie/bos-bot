import SwiftUI
import CompanionCore

struct SharedConversationDetails: View {
    @EnvironmentObject private var session: Session
    @Environment(\.dismiss) private var dismiss
    let room: SharedRoomSummary
    let selfID: String
    let contacts: [SharedContact]
    let changed: (SharedRoomSummary) -> Void
    let exited: () -> Void
    let showMessage: (SharedFile) async throws -> Void
    let showRequestMessage: (String, Int) async throws -> Void
    var bots: [SharedEligibleBot] = []
    @State private var current: SharedRoomSummary?
    @State private var name = ""
    @State private var saving = false
    @State private var error: String?
    @State private var notifications = "all"
    @State private var replyMode = "follow"
    @State private var replyBotId = ""
    @State private var preferencesLoaded = false
    @State private var confirmedReplyMode = "follow"
    @State private var confirmedReplyBotId = ""
    @State private var confirmLeave = false
    @State private var confirmDelete = false
    @State private var memberToRemove: SharedContact?
    private var displayed: SharedRoomSummary { current ?? room }
    private var canManage: Bool { selfID == (displayed.createdBy ?? "\(displayed.homeId):person:owner") || selfID == "\(displayed.homeId):person:owner" }

    private func saveReplies(mode: String? = nil, botId: String? = nil) async {
        saving = true
        defer { saving = false }
        do {
            let pref = try await session.sharedPreferences(roomId: displayed.id, replyMode: mode, replyBotId: botId)
            confirmedReplyMode = pref.replyMode ?? "follow"; confirmedReplyBotId = pref.replyBotId ?? ""
            replyMode = confirmedReplyMode; replyBotId = confirmedReplyBotId
        } catch {
            replyMode = confirmedReplyMode; replyBotId = confirmedReplyBotId
            self.error = error.localizedDescription
        }
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    VStack(spacing: 12) {
                        GroupMarkView(members: GroupMarkView.faces(displayed, contacts: contacts, selfID: selfID), size: 68)
                        Text(displayed.displayName(contacts: contacts, selfID: selfID)).font(.title2.weight(.semibold))
                        Text(displayed.isGroup ? "\(displayed.memberIds.count) people" : "Direct conversation").font(.subheadline).foregroundStyle(.secondary)
                    }.frame(maxWidth: .infinity).padding(.vertical, 16)
                }.listRowBackground(Color.clear)
                if displayed.isGroup {
                    Section("Group name") {
                        TextField("Name", text: $name)
                        Button("Save name") { Task { await update(name: name.trimmingCharacters(in: .whitespacesAndNewlines)) } }
                            .disabled(saving || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || name == displayed.name)
                    }
                }
                Section("People") {
                    Text("New members can see retained history and files. Removing someone stops future access; copies they already saved cannot be erased.").font(.caption).foregroundStyle(.secondary)
                    ForEach(displayed.memberIds, id: \.self) { id in
                        HStack(spacing: 12) {
                            let contact = contacts.first { $0.id == id }
                            if let avatar = contact?.avatar, PersonCutout.image(dataURL: avatar) != nil {
                                PersonPhotoView(dataURL: avatar, size: 34)
                            } else {
                                ProfileAvatar(name: contact?.name ?? "Member", size: 34)
                            }
                            VStack(alignment: .leading, spacing: 3) {
                                Text(contact?.name ?? "Member")
                                if id == selfID { Text("You").font(.caption).foregroundStyle(.secondary) }
                                else if id == displayed.createdBy { Text("Group creator").font(.caption).foregroundStyle(.secondary) }
                            }
                            Spacer()
                            if displayed.isGroup && canManage && id != selfID, let contact {
                                Button(role: .destructive) { memberToRemove = contact } label: { Image(systemName: "minus.circle") }
                                    .accessibilityLabel("Remove \(contact.name)")
                            }
                        }
                    }
                    if displayed.isGroup && canManage && contacts.contains(where: { $0.kind == "person" && !displayed.memberIds.contains($0.id) }) {
                        Menu {
                            ForEach(contacts.filter { $0.kind == "person" && !displayed.memberIds.contains($0.id) }) { contact in
                                Button(contact.name) { Task { await update(members: displayed.memberIds + [contact.id]) } }
                            }
                        } label: { Label("Add people", systemImage: "person.badge.plus") }
                    }
                }
                Section {
                    NavigationLink {
                        SharedConversationSearch(roomId: displayed.id, selfID: selfID, contacts: contacts, bots: bots, showMessage: showRequestMessage)
                    } label: { Label("Search conversation", systemImage: "magnifyingglass") }
                    NavigationLink {
                        SharedConversationFiles(roomId: displayed.id, selfID: selfID, contacts: contacts, showMessage: showMessage)
                    } label: { Label("Shared files", systemImage: "paperclip") }
                }
                Section {
                    NavigationLink {
                        SharedConversationRequests(roomId: displayed.id, selfID: selfID, contacts: contacts, showMessage: showRequestMessage)
                    } label: { Label("Bot requests", systemImage: "checklist") }
                }
                Section("Notifications") {
                    Picker("Notify me", selection: $notifications) {
                        Text("All messages").tag("all")
                        Text("Mentions and my bot requests").tag("mentions")
                        Text("Muted").tag("muted")
                    }.onChange(of: notifications) { _, value in Task {
                        do { _ = try await session.sharedPreferences(roomId: displayed.id, notifications: value) }
                        catch { self.error = error.localizedDescription }
                    } }
                }
                if displayed.isGroup {
                    Section("Who replies to you") {
                        Picker("Reply options", selection: $replyMode) {
                            Text("Follow my last @bot").tag("follow")
                            Text("Use a chosen bot").tag("fixed")
                            Text("Only when I @mention").tag("mentions")
                        }.onChange(of: replyMode) { _, value in
                            guard preferencesLoaded, value != confirmedReplyMode else { return }
                            Task { await saveReplies(mode: value) }
                        }
                        if replyMode == "fixed" {
                            Picker("Reply bot", selection: $replyBotId) {
                                Text("Choose a bot").tag("")
                                ForEach(bots) { bot in Text("\(bot.name) · \(bot.ownerName ?? "Owner")").tag(bot.id) }
                            }.onChange(of: replyBotId) { _, value in
                                guard preferencesLoaded, value != confirmedReplyBotId else { return }
                                Task { await saveReplies(botId: value) }
                            }
                        }
                        Text("Applies to your messages. In follow mode, mentioning a person pauses bot replies until you mention a bot again.")
                            .font(.subheadline).foregroundStyle(.secondary)
                    }.disabled(!preferencesLoaded)
                }
                Section("Working with bots") {
                    Label("Mention your bot in the conversation", systemImage: "at")
                    Text("You don’t need to add bots as members. Everyone here can see the reply. Your private bot conversations stay separate.")
                        .font(.subheadline).foregroundStyle(.secondary)
                }
                if let error { Section { Text(error).font(.subheadline).foregroundStyle(.red) } }
                if displayed.isGroup {
                    Section {
                        if displayed.memberIds.count > 1 { Button("Leave group", role: .destructive) { confirmLeave = true } }
                        if canManage { Button("Delete for everyone", role: .destructive) { confirmDelete = true } }
                    }
                }
            }
            .disabled(saving)
            .navigationTitle(displayed.isGroup ? "Group details" : "Conversation")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .onAppear { name = displayed.name }
            .task { do {
                let pref = try await session.sharedPreferences(roomId: displayed.id)
                notifications = pref.notifications; replyMode = pref.replyMode ?? "follow"; replyBotId = pref.replyBotId ?? ""
                confirmedReplyMode = replyMode; confirmedReplyBotId = replyBotId
                preferencesLoaded = true
            } catch { self.error = error.localizedDescription } }
            .confirmationDialog("Leave \(displayed.name)?", isPresented: $confirmLeave, titleVisibility: .visible) {
                Button("Leave group", role: .destructive) { Task { await exit(delete: false) } }
            } message: { Text("You will lose access to this conversation until someone adds you again.") }
            .confirmationDialog("Delete this group for everyone?", isPresented: $confirmDelete, titleVisibility: .visible) {
                Button("Delete group", role: .destructive) { Task { await exit(delete: true) } }
            } message: { Text("The conversation and its history will be removed for all members.") }
            .confirmationDialog("Remove \(memberToRemove?.name ?? "member")?", isPresented: Binding(get: { memberToRemove != nil }, set: { if !$0 { memberToRemove = nil } }), titleVisibility: .visible) {
                if let member = memberToRemove {
                    Button("Remove from group", role: .destructive) { Task { await update(members: displayed.memberIds.filter { $0 != member.id }) } }
                }
            }
        }
    }

    private func update(name: String? = nil, members: [String]? = nil) async {
        saving = true
        defer { saving = false }
        do {
            let updated = try await session.updateSharedRoom(id: displayed.id, revision: displayed.revision ?? 1, name: name, memberIds: members)
            current = updated
            self.name = updated.name
            error = nil
            changed(updated)
        } catch { self.error = error.localizedDescription }
    }

    private func exit(delete: Bool) async {
        saving = true
        defer { saving = false }
        do {
            if delete { try await session.deleteSharedRoom(displayed) }
            else { try await session.leaveSharedRoom(id: displayed.id, revision: displayed.revision ?? 1) }
            exited()
        } catch { self.error = error.localizedDescription }
    }
}

private struct SharedConversationFiles: View {
    @EnvironmentObject private var session: Session
    let roomId: String
    let selfID: String
    let contacts: [SharedContact]
    let showMessage: (SharedFile) async throws -> Void
    @State private var files: [SharedFile] = []
    @State private var before: Int?
    @State private var hasMore = false
    @State private var loaded = false
    @State private var loading = false
    @State private var opening = false
    @State private var error: String?
    @State private var preview: FilePreviewItem?

    var body: some View {
        List {
            if loaded && files.isEmpty {
                ContentUnavailableView("No shared files yet", systemImage: "paperclip", description: Text("Images and documents shared in this conversation will appear here."))
            }
            ForEach(files) { file in
                VStack(alignment: .leading, spacing: 8) {
                    Button { Task { await open(file.attachment) } } label: {
                        Label(file.attachment.name, systemImage: file.attachment.mime.hasPrefix("image/") ? "photo" : "doc")
                            .font(.body.weight(.medium)).lineLimit(2)
                    }.buttonStyle(.borderless).disabled(opening)
                    Text("\(author(file)) · \(Date(timeIntervalSince1970: file.at / 1000).formatted(date: .abbreviated, time: .omitted)) · \(ByteCountFormatter.string(fromByteCount: Int64(file.attachment.size), countStyle: .file))")
                        .font(.caption).foregroundStyle(.secondary)
                    Button("Show message") { Task {
                        opening = true; error = nil
                        defer { opening = false }
                        do { try await showMessage(file) }
                        catch { self.error = error.localizedDescription }
                    } }.buttonStyle(.borderless).font(.caption).disabled(opening)
                }.padding(.vertical, 4)
            }
            if loading || opening { ProgressView(opening ? "Opening…" : "Loading files…") }
            if let error { Text(error).font(.subheadline).foregroundStyle(.red) }
            if !loading && (!loaded || hasMore) { Button(error == nil ? "Load earlier files" : "Try again") { Task { await load() } } }
        }
        .navigationTitle("Shared files")
        .task { if !loaded { await load() } }
        .fullScreenCover(item: $preview) { item in
            FilePreviewView(item: item) { preview = nil }.onDisappear { item.cleanUp() }
        }
    }

    private func author(_ file: SharedFile) -> String {
        file.actor.id == selfID ? "You" : contacts.first { $0.id == file.actor.id }?.name ?? (file.actor.kind == "bot" ? "Bot" : "Member")
    }
    private func load() async {
        guard !loading else { return }
        loading = true; error = nil
        defer { loading = false }
        do {
            let page = try await session.sharedFiles(roomId: roomId, before: before)
            try Task.checkCancellation()
            let existing = Set(files.map(\.id))
            files.append(contentsOf: page.files.filter { !existing.contains($0.id) })
            before = page.before; hasMore = page.hasMore; loaded = true
        } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
    }
    private func open(_ attachment: SharedAttachment) async {
        guard !opening else { return }
        opening = true; error = nil
        defer { opening = false }
        do {
            let response = try await session.sharedAttachment(roomId: roomId, attachmentId: attachment.id)
            try Task.checkCancellation()
            guard let data = Data(base64Encoded: response.data) else { throw APIError.transport("Invalid attachment") }
            let directory = FileManager.default.temporaryDirectory.appendingPathComponent("BOSFilePreviews/\(UUID().uuidString)", isDirectory: true)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let url = directory.appendingPathComponent(URL(fileURLWithPath: attachment.name).lastPathComponent)
            try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            preview = FilePreviewItem(downloaded: DownloadedFile(data: data, filename: attachment.name, contentType: attachment.mime, localURL: url))
        } catch { self.error = error.localizedDescription }
    }
}


private struct SharedConversationRequests: View {
    @EnvironmentObject private var session: Session
    let roomId: String
    let selfID: String
    let contacts: [SharedContact]
    let showMessage: (String, Int) async throws -> Void
    @State private var page: SharedRequestsResponse?
    @State private var before: Int?
    @State private var busy = false
    @State private var acting = false
    @State private var error: String?
    var body: some View {
        List {
            if let page {
                if page.requests.isEmpty {
                    ContentUnavailableView("No bot requests yet", systemImage: "checklist", description: Text("Mention a bot to start work together. Its progress and results will appear here."))
                }
                ForEach(page.requests) { request in
                    VStack(alignment: .leading, spacing: 8) {
                        HStack(alignment: .firstTextBaseline) {
                            Text(request.botName).font(.headline)
                            Spacer()
                            Text(request.stateLabel).font(.caption).foregroundStyle(.secondary)
                        }
                        Text("\(request.ownerName)’s bot · requested by \(request.requesterId == selfID ? "you" : contacts.first(where: { $0.id == request.requesterId })?.name ?? "a member")")
                            .font(.caption).foregroundStyle(.secondary)
                        if let explanation = request.explanation { Text(explanation).font(.subheadline).foregroundStyle(.secondary) }
                        ViewThatFits(in: .horizontal) {
                            HStack(spacing: 20) { actions(request) }
                            VStack(alignment: .leading, spacing: 12) { actions(request) }
                        }.font(.subheadline).disabled(acting)
                    }.padding(.vertical, 4)
                }
                if before != nil { Button("Recent requests") { before = nil } }
                if page.hasMore { Button("Earlier requests") { before = page.before } }
            } else if error == nil { ProgressView("Loading requests…") }
            if let error { Text(error).font(.subheadline).foregroundStyle(.red); Button("Retry") { Task { await refresh() } } }
        }
        .navigationTitle("Bot requests")
        .task(id: before) {
            page = nil
            while !Task.isCancelled {
                await refresh()
                try? await Task.sleep(for: .seconds(2))
            }
        }
    }
    @ViewBuilder private func actions(_ request: SharedBotRequest) -> some View {
        if let sequence = request.sourceSequence {
            Button("Show request") { open(request.sourceId, sequence: sequence) }.buttonStyle(.borderless)
        }
        if let id = request.resultId, let sequence = request.resultSequence {
            Button("Show result") { open(id, sequence: sequence) }.buttonStyle(.borderless)
        }
        if request.canCancel(actorId: selfID) {
            Button("Stop", role: .destructive) { Task {
                acting = true; error = nil
                defer { acting = false }
                do { _ = try await session.cancelSharedRequest(roomId: roomId, requestId: request.id); await refresh() }
                catch { self.error = error.localizedDescription }
            } }.buttonStyle(.borderless)
        }
    }
    private func open(_ id: String, sequence: Int) {
        Task {
            acting = true; error = nil
            defer { acting = false }
            do { try await showMessage(id, sequence) }
            catch { self.error = error.localizedDescription }
        }
    }
    private func refresh() async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        do {
            let next = try await session.sharedRequests(roomId: roomId, before: before)
            try Task.checkCancellation()
            page = next; error = nil
        } catch { if !Task.isCancelled { self.error = "Could not refresh bot requests. Check your connection and try again." } }
    }
}
