import SwiftUI
import UIKit
import PhotosUI
import UniformTypeIdentifiers
import CompanionCore

struct SharedChatView: View {
    @EnvironmentObject private var session: Session
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.dismiss) private var dismiss
    let room: SharedRoomSummary
    let selfID: String
    let contacts: [SharedContact]

    @State private var updatedRoom: SharedRoomSummary?
    @State private var showingDetails = false
    @State private var availableBots: [SharedEligibleBot] = []
    @State private var botsError: String?
    @State private var botsLoading = false
    private var currentRoom: SharedRoomSummary { updatedRoom ?? room }
    private var conversationName: String { currentRoom.displayName(contacts: contacts, selfID: selfID) }
    @State private var messages: [SharedChatMessage] = []
    @State private var draft = ""
    @State private var pendingSendID: String?
    @State private var sending = false
    @State private var error: String?
    @State private var connectionError: String?
    @State private var sequence = 0
    @State private var version = 0
    @State private var hasMore = false
    @State private var loadingOlder = false
    @State private var atBottom = true
    @State private var scrollHeight: CGFloat = 0
    @State private var readSequence = 0
    @State private var replyTarget: SharedChatMessage?
    @State private var editingMessage: SharedChatMessage?
    @State private var editText = ""
    @State private var deletingMessage: SharedChatMessage?
    @StateObject private var dictation = SpeechDictation()
    @State private var showingPlus = false
    @State private var showingPhotoPicker = false
    @State private var showingFileImporter = false
    @State private var selectedPhotos: [PhotosPickerItem] = []
    @State private var pendingFiles: [PendingSharedFile] = []
    @State private var uploadedFiles: [UUID: SharedAttachment] = [:]
    @State private var filePreview: FilePreviewItem?
    @FocusState private var composerFocused: Bool

    private var peer: SharedContact? {
        guard !currentRoom.isGroup, currentRoom.memberIds.count == 2 else { return nil }
        return contacts.first { room.memberIds.contains($0.id) && $0.id != selfID }
    }

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 6) {
                        if hasMore {
                            Button(loadingOlder ? "Loading…" : "Load earlier messages") { Task { await loadOlder() } }
                                .font(.caption).disabled(loadingOlder).frame(maxWidth: .infinity).padding(.vertical, 12)
                        }
                        Color.clear.frame(height: 8)
                        ForEach(messages) { message in
                            let mine = message.actor.id == selfID
                            if message.isActivity {
                                // A bot's tool/progress line: a compact step,
                                // never a name label over an empty bubble.
                                if let row = SharedActivityRow(message: message,
                                                               actorName: contacts.first { $0.id == message.actor.id }?.name) {
                                    row.id(message.id)
                                }
                            } else {
                            HStack(alignment: .bottom) {
                                if mine { Spacer(minLength: 44) }
                                VStack(alignment: .leading, spacing: 4) {
                                    if !mine { Text(contacts.first { $0.id == message.actor.id }?.name ?? "Member")
                                        .font(.caption2).foregroundStyle(.secondary) }
                                    if let replyID = message.replyTo, let quoted = messages.first(where: { $0.id == replyID }) {
                                        Text(quoted.deletedAt == nil ? quoted.text : "Message removed")
                                            .font(.caption).lineLimit(2).foregroundStyle(.secondary)
                                            .padding(8).background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
                                    }
                                    if message.deletedAt != nil {
                                        Text("Message removed").font(.subheadline).italic().foregroundStyle(.secondary).padding(12)
                                    }
                                    if message.deletedAt == nil && !message.text.isEmpty { Group {
                                        if message.actor.kind == "bot" { MarkdownText(source: message.text) }
                                        else { Text(message.text) }
                                    }.font(.system(size: 16))
                                        .foregroundStyle(mine ? BubbleColor.mineText : Color.primary)
                                        .textSelection(.enabled)
                                        .padding(.horizontal, 15).padding(.vertical, 11)
                                        .background(RoundedRectangle(cornerRadius: 22).fill(mine ? BubbleColor.mine : BubbleColor.theirs)) }
                                    if message.editedAt != nil && message.deletedAt == nil { Text("Edited").font(.caption2).foregroundStyle(.secondary) }
                                    ForEach(message.attachments ?? []) { attachment in
                                        Button { Task { await openAttachment(attachment) } } label: {
                                            Label(attachment.name, systemImage: attachment.mime.hasPrefix("image/") ? "photo" : attachment.mime.hasPrefix("video/") ? "video" : "paperclip")
                                                .font(.system(size: 14)).lineLimit(1)
                                                .padding(.horizontal, 14).padding(.vertical, 10)
                                                .background(RoundedRectangle(cornerRadius: 16).fill(mine ? BubbleColor.mine : BubbleColor.theirs))
                                        }.buttonStyle(.plain)
                                    }
                                }
                                if !mine { Spacer(minLength: 44) }
                            }
                            .id(message.id)
                            .contextMenu {
                                if message.deletedAt == nil {
                                    Button { replyTarget = message; composerFocused = true } label: { Label("Reply", systemImage: "arrowshape.turn.up.left") }
                                    Button { UIPasteboard.general.string = message.text } label: { Label("Copy", systemImage: "doc.on.doc") }
                                    if mine {
                                        Button { editText = message.text; editingMessage = message } label: { Label("Edit", systemImage: "pencil") }
                                        Button(role: .destructive) { deletingMessage = message } label: { Label("Remove", systemImage: "trash") }
                                    }
                                }
                            }
                            }
                        }
                        Color.clear.frame(height: 1).id("shared-bottom")
                            .background(GeometryReader { geometry in
                                Color.clear.preference(key: SharedChatBottomKey.self, value: geometry.frame(in: .named("shared-scroll")).maxY)
                            })
                    }
                    .padding(.horizontal, 16).padding(.vertical, 12)
                    .frame(maxWidth: CompanionLayout.chatWidth, alignment: .leading)
                    .frame(maxWidth: .infinity)
                }
                .coordinateSpace(name: "shared-scroll")
                .background(GeometryReader { geometry in
                    Color.clear.onChange(of: geometry.size.height, initial: true) { _, height in scrollHeight = height }
                })
                .onChange(of: scrollHeight) { _, _ in
                    if atBottom { proxy.scrollTo("shared-bottom", anchor: .bottom) }
                }
                .onPreferenceChange(SharedChatBottomKey.self) { bottom in
                    atBottom = bottom > 0 && bottom <= scrollHeight + 24
                    if atBottom { Task { await markRead() } }
                }
                .safeAreaInset(edge: .top, spacing: 0) { header }
                .overlay(alignment: .bottomTrailing) {
                    if !atBottom && !messages.isEmpty {
                        Button {
                            withAnimation { proxy.scrollTo("shared-bottom", anchor: .bottom) }
                        } label: {
                            Label("Latest messages", systemImage: "arrow.down")
                                .font(.caption.weight(.semibold)).padding(.horizontal, 14).padding(.vertical, 10)
                                .background(.regularMaterial, in: Capsule())
                        }.buttonStyle(.plain).padding(12)
                    }
                }
                .defaultScrollAnchor(.bottom)
                .scrollDismissesKeyboard(.interactively)
                .onChange(of: messages.count) { _, _ in
                    if atBottom, let last = messages.last { withAnimation { proxy.scrollTo(last.id, anchor: .bottom) }; Task { await markRead() } }
                }
            }
            if connectionError != nil {
                HStack {
                    Label("Can’t refresh this chat. Your draft is saved.", systemImage: "wifi.slash")
                    Spacer()
                    Button("Retry") { Task { await refresh(); await refreshBots() } }
                }.font(.caption).padding(.horizontal, 16).padding(.vertical, 8)
            }
            if let error {
                HStack {
                    Text(error).font(.caption).foregroundStyle(.red)
                    Spacer()
                    Button { self.error = nil } label: { Image(systemName: "xmark.circle") }.accessibilityLabel("Dismiss error")
                }.padding(.horizontal, 16).padding(.vertical, 8)
            }
            if !pendingFiles.isEmpty {
                ScrollView(.horizontal) {
                    HStack {
                        ForEach(pendingFiles) { file in
                            HStack {
                                Image(systemName: file.mime.hasPrefix("image/") ? "photo" : file.mime.hasPrefix("video/") ? "video" : "doc")
                                Text(file.name).lineLimit(1)
                                Button { pendingFiles.removeAll { $0.id == file.id }; uploadedFiles.removeValue(forKey: file.id) } label: { Image(systemName: "xmark.circle.fill") }
                            }.font(.caption).padding(8).background(Color.secondary.opacity(0.14), in: Capsule())
                        }
                    }.padding(.horizontal, 16)
                }
            }
            if let replyTarget {
                HStack {
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Replying to " + (contacts.first { $0.id == replyTarget.actor.id }?.name ?? "Member")).font(.caption.weight(.medium))
                        Text(replyTarget.text).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                    }
                    Spacer()
                    Button { self.replyTarget = nil } label: { Image(systemName: "xmark.circle.fill") }.accessibilityLabel("Cancel reply")
                }.padding(12).background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 12)).padding(.horizontal, 16)
            }
            if let query = mentionQuery, !sending {
                let matches = SharedEligibleBot.matching(availableBots, query: query)
                if availableBots.isEmpty {
                    HStack {
                        Text(botsLoading ? "Loading bots…" : botsError ?? "No bots are shared with you yet.").font(.caption).foregroundStyle(.secondary)
                        Spacer()
                        if botsError != nil { Button("Retry") { Task { await refreshBots() } }.font(.caption) }
                    }.padding(.horizontal, 16).padding(.vertical, 8)
                }
                if !availableBots.isEmpty && matches.isEmpty {
                    Text("No bots match. Search by bot name or owner.")
                        .font(.caption).foregroundStyle(.secondary).padding(.horizontal, 16).padding(.vertical, 8)
                }
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(matches) { bot in
                            Button { insertMention(bot) } label: {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text("@" + bot.name).font(.subheadline.weight(.medium))
                                    if let owner = bot.ownerName { Text(owner + "’s bot").font(.caption).foregroundStyle(.secondary) }
                                    if let status = bot.availabilityLabel { Text(status).font(.caption2).foregroundStyle(.secondary) }
                                }.padding(.horizontal, 12).padding(.vertical, 8)
                                    .background(Color.secondary.opacity(0.1), in: RoundedRectangle(cornerRadius: 12))
                            }.buttonStyle(.plain)
                        }
                    }.padding(.horizontal, 16)
                }
            }
            if messages.isEmpty && error == nil {
                Text("Chat with your people. @mention a bot when you need help.")
                    .font(.caption).foregroundStyle(.secondary).padding(.horizontal, 20).padding(.vertical, 6)
            }
            ChatComposerBar(
                draft: $draft, showingPlus: $showingPlus, dictation: dictation,
                focus: $composerFocused, name: conversationName, busy: sending,
                hasAttachments: !pendingFiles.isEmpty, supportsVoiceChat: false,
                onDraftChange: { _ in pendingSendID = nil },
                onSend: { Task { await send() } }, onVoice: {}
            )
            .padding(.horizontal, 12).padding(.top, 6).padding(.bottom, 8)
            .frame(maxWidth: CompanionLayout.chatWidth).frame(maxWidth: .infinity)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
        .overlay(alignment: .bottom) {
            ChatActionSheet(showing: $showingPlus, actions: [
                .init(id: "photos", systemImage: "photo.on.rectangle", title: "Photo Library", subtitle: "Add a photo to this message", disabled: sending || pendingFiles.count >= 4) { showingPhotoPicker = true },
                .init(id: "files", systemImage: "paperclip", title: "Choose File", subtitle: "Add a document from Files", disabled: sending || pendingFiles.count >= 4) { showingFileImporter = true },
            ])
        }
        .toolbar(.hidden, for: .navigationBar)
        .navigationBarBackButtonHidden(true)
        .onChange(of: dictation.transcript) { _, spoken in
            draft = Dictation.draft(base: dictation.base, transcript: spoken)
        }
        .onDisappear { dictation.stop() }
        .onChange(of: draft) { _, value in UserDefaults.standard.set(value, forKey: "bos.shared-draft.\(room.id)") }
        .onChange(of: scenePhase) { _, phase in if phase == .active { Task { await refresh(); if atBottom { await markRead() } } } }
        .alert("Edit message", isPresented: Binding(get: { editingMessage != nil }, set: { if !$0 { editingMessage = nil } })) {
            TextField("Message", text: $editText)
            Button("Cancel", role: .cancel) { editingMessage = nil }
            Button("Save") { if let target = editingMessage { Task { await edit(target, text: editText) } } }
        } message: { Text("Editing a message does not rerun a bot request.") }
        .confirmationDialog("Remove this message for everyone?", isPresented: Binding(get: { deletingMessage != nil }, set: { if !$0 { deletingMessage = nil } }), titleVisibility: .visible) {
            if let target = deletingMessage { Button("Remove message", role: .destructive) { Task { await edit(target, text: nil) } } }
        }
        .photosPicker(isPresented: $showingPhotoPicker, selection: $selectedPhotos,
                      maxSelectionCount: max(1, 4 - pendingFiles.count), matching: .images)
        .onChange(of: selectedPhotos) { _, items in Task { await importPhotos(items) } }
        .fileImporter(isPresented: $showingFileImporter, allowedContentTypes: [.content], allowsMultipleSelection: true) { result in
            importFiles(result)
        }
        .fullScreenCover(item: $filePreview) { preview in
            FilePreviewView(item: preview) { filePreview = nil }
                .onDisappear { preview.cleanUp() }
        }
        .sheet(isPresented: $showingDetails) {
            SharedConversationDetails(room: currentRoom, selfID: selfID, contacts: contacts,
                changed: { updatedRoom = $0 }, exited: { showingDetails = false; dismiss() })
        }
        .task(id: room.id) {
            draft = UserDefaults.standard.string(forKey: "bos.shared-draft.\(room.id)") ?? ""
            messages = []
            sequence = 0
            version = 0
            while !Task.isCancelled {
                await refreshBots()
                await refresh()
                try? await Task.sleep(for: .seconds(2))
            }
        }
    }

    private var header: some View {
        ChatHeaderBar(name: conversationName, unreadElsewhere: 0,
                      canOpenThreads: false, canOpenSettings: true, canWatchComputer: false,
                      onBack: { dismiss() }, onThreads: {}, onSettings: { showingDetails = true }, onComputer: {}) {
            headerAvatar
        }
    }

    @ViewBuilder private var headerAvatar: some View {
        if let peer, peer.kind == "bot" {
            MausAvatar(color: peer.color ?? "green", size: 30, bodyId: peer.mascotBody, animated: false)
        } else if let peer, let avatar = peer.avatar, PersonCutout.image(dataURL: avatar) != nil {
            PersonPhotoView(dataURL: avatar, size: 30)
        } else if let peer {
            ProfileAvatar(name: peer.name, size: 30)
        } else {
            GroupMarkView(members: GroupMarkView.faces(room, contacts: contacts, selfID: selfID), size: 34)
        }
    }

    private var mentionQuery: String? {
        guard let at = draft.lastIndex(of: "@") else { return nil }
        if at != draft.startIndex && !draft[draft.index(before: at)].isWhitespace { return nil }
        let query = String(draft[draft.index(after: at)...])
        if availableBots.contains(where: { bot in
            let alias = availableBots.filter { $0.name.lowercased() == bot.name.lowercased() }.count > 1
                ? bot.name + " · " + (bot.ownerName ?? "Owner") : bot.name
            return query.lowercased().hasPrefix(alias.lowercased() + " ")
        }) { return nil }
        return query.contains("\n") || query.count > 60 ? nil : query
    }

    private func insertMention(_ bot: SharedEligibleBot) {
        guard let at = draft.lastIndex(of: "@") else { return }
        let ambiguous = availableBots.filter { $0.name.lowercased() == bot.name.lowercased() }.count > 1
        let alias = ambiguous ? bot.name + " · " + (bot.ownerName ?? "Owner") : bot.name
        draft = String(draft[..<at]) + "@" + alias + " "
        pendingSendID = nil
        composerFocused = true
    }

    private func refreshBots() async {
        guard !botsLoading else { return }
        botsLoading = availableBots.isEmpty
        defer { botsLoading = false }
        do { availableBots = try await session.sharedBots(roomId: room.id); botsError = nil }
        catch { botsError = "Bot mentions are unavailable. Check that the host Mac is online and updated." }
    }

    private func refresh() async {
        do {
            let page = try await session.sharedMessagePage(roomId: room.id, after: sequence, version: version, latest: sequence == 0)
            let next = page.messages
            guard !Task.isCancelled else { return }
            if sequence == 0 { hasMore = page.hasMore ?? false }
            version = page.version ?? version
            let changes = Dictionary(uniqueKeysWithValues: (page.changes ?? []).map { ($0.id, $0) })
            messages = messages.map { changes[$0.id] ?? $0 }
            if let last = next.last { sequence = last.sequence }
            let existing = Set(messages.map(\.id))
            messages.append(contentsOf: next.filter { !existing.contains($0.id) })
            connectionError = nil
        } catch { if !Task.isCancelled { connectionError = error.localizedDescription } }
    }

    private func loadOlder() async {
        guard let first = messages.first, !loadingOlder else { return }
        loadingOlder = true
        defer { loadingOlder = false }
        do {
            let page = try await session.sharedMessagePage(roomId: room.id, before: first.sequence)
            let ids = Set(messages.map(\.id))
            version = min(version, page.version ?? version)
            atBottom = false
            messages = page.messages.filter { !ids.contains($0.id) } + messages
            hasMore = page.hasMore ?? false
        } catch { self.error = error.localizedDescription }
    }

    private func markRead() async {
        guard scenePhase == .active, atBottom, sequence > readSequence else { return }
        let seen = sequence
        do { readSequence = try await session.sharedPreferences(roomId: room.id, readSequence: seen).readSequence }
        catch { /* retry when the visible conversation refreshes */ }
    }

    private func edit(_ message: SharedChatMessage, text: String?) async {
        do {
            let edited = try await session.editSharedMessage(roomId: room.id, messageId: message.id, text: text)
            messages = messages.map { $0.id == edited.id ? edited : $0 }
            editingMessage = nil
            deletingMessage = nil
        } catch { self.error = error.localizedDescription }
    }

    private func send() async {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty || !pendingFiles.isEmpty, !sending else { return }
        sending = true
        error = nil
        let sendID = pendingSendID ?? UUID().uuidString
        pendingSendID = sendID
        do {
            var refs: [SharedAttachment] = []
            for file in pendingFiles {
                if let uploaded = uploadedFiles[file.id] { refs.append(uploaded); continue }
                let uploaded = try await session.uploadSharedAttachment(roomId: room.id, name: file.name, mime: file.mime, data: file.data)
                uploadedFiles[file.id] = uploaded
                refs.append(uploaded)
            }
            try await session.sendSharedMessage(roomId: room.id, text: text, sendId: sendID, attachments: refs, replyTo: replyTarget?.id)
            if draft.trimmingCharacters(in: .whitespacesAndNewlines) == text { draft = "" }
            pendingFiles = []
            uploadedFiles = [:]
            pendingSendID = nil
            replyTarget = nil
            atBottom = true
            await refresh()
        } catch { self.error = "Message wasn’t sent. Your text and attachments are still here. " + error.localizedDescription }
        sending = false
    }

    private func importPhotos(_ items: [PhotosPickerItem]) async {
        defer { selectedPhotos = [] }
        for item in items.prefix(max(0, 4 - pendingFiles.count)) {
            guard let data = try? await item.loadTransferable(type: Data.self) else { error = "Could not read photo"; continue }
            let originalMime = item.supportedContentTypes.first?.preferredMIMEType ?? "image/jpeg"
            if ["image/png", "image/jpeg", "image/gif", "image/webp"].contains(originalMime) {
                addPending(name: "Photo-\(UUID().uuidString).jpg", mime: originalMime, data: data)
            } else if let converted = UIImage(data: data)?.jpegData(compressionQuality: 0.85) {
                addPending(name: "Photo-\(UUID().uuidString).jpg", mime: "image/jpeg", data: converted)
            } else { error = "Could not read this photo. Choose a JPEG or PNG image." }
        }
    }

    private func importFiles(_ result: Result<[URL], Error>) {
        do {
            for url in try result.get().prefix(max(0, 4 - pendingFiles.count)) {
                let opened = url.startAccessingSecurityScopedResource()
                defer { if opened { url.stopAccessingSecurityScopedResource() } }
                let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
                guard size > 0 && size <= 25 * 1024 * 1024 else { error = "File must be under 25 MB"; continue }
                let data = try Data(contentsOf: url)
                let mime = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
                addPending(name: url.lastPathComponent, mime: mime, data: data)
            }
        } catch { self.error = error.localizedDescription }
    }

    private func addPending(name: String, mime: String, data: Data) {
        let limit = mime.hasPrefix("image/") ? 10 : 25
        guard !data.isEmpty && data.count <= limit * 1024 * 1024 && pendingFiles.count < 4 else { error = "Attachment must be under \(limit) MB"; return }
        pendingFiles.append(PendingSharedFile(id: UUID(), name: name, mime: mime, data: data))
        pendingSendID = nil
    }

    private func openAttachment(_ attachment: SharedAttachment) async {
        do {
            let loaded = try await session.sharedAttachment(roomId: room.id, attachmentId: attachment.id)
            guard let data = Data(base64Encoded: loaded.data) else { throw APIError.transport("Invalid attachment") }
            let directory = FileManager.default.temporaryDirectory.appendingPathComponent("BOSFilePreviews/\(UUID().uuidString)", isDirectory: true)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let url = directory.appendingPathComponent(URL(fileURLWithPath: attachment.name).lastPathComponent)
            try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            filePreview = FilePreviewItem(downloaded: DownloadedFile(data: data, filename: attachment.name, contentType: attachment.mime, localURL: url))
        } catch { self.error = error.localizedDescription }
    }
}

private struct PendingSharedFile: Identifiable {
    let id: UUID
    let name: String
    let mime: String
    let data: Data
}

/// One shared-room activity line (kind "activity"): the tool's spoken phrase
/// or name, with a quiet status glyph. Nil when there is nothing to show.
private struct SharedActivityRow: View {
    let label: String
    let failed: Bool

    init?(message: SharedChatMessage, actorName: String?) {
        let spoken = message.tool?.spoken?.trimmingCharacters(in: .whitespacesAndNewlines)
        let name = message.tool?.name.trimmingCharacters(in: .whitespacesAndNewlines)
        let text = message.text.trimmingCharacters(in: .whitespacesAndNewlines)
        let phrase = [spoken, text, name].compactMap { $0 }.first { !$0.isEmpty }
        guard let phrase else { return nil }
        if let actorName, !actorName.isEmpty { label = "\(actorName) · \(phrase)" } else { label = phrase }
        failed = message.tool?.ok == false
    }

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: failed ? "exclamationmark.circle" : "wrench.and.screwdriver")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(failed ? Color.orange : Color.secondary)
            Text(label)
                .font(.system(size: 12))
                .foregroundStyle(Color.secondary)
                .lineLimit(1)
                .truncationMode(.tail)
        }
        .padding(.horizontal, 4)
        .padding(.vertical, 2)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

private struct SharedChatBottomKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}
