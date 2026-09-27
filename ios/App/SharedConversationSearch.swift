import SwiftUI
import CompanionCore

struct SharedConversationSearch: View {
    @EnvironmentObject private var session: Session
    let roomId: String
    let selfID: String
    let contacts: [SharedContact]
    let bots: [SharedEligibleBot]
    let showMessage: (String, Int) async throws -> Void
    @State private var query = ""
    @State private var kind = "all"
    @State private var author = ""
    @State private var messages: [SharedChatMessage] = []
    @State private var hasMore = false
    @State private var before: Int?
    @State private var loading = false
    @State private var opening = false
    @State private var error: String?
    @State private var generation = UUID()
    private var searchKey: [String] { [roomId, query, kind, author] }

    var body: some View {
        List {
            Section {
                Picker("Message type", selection: $kind) {
                    Text("All messages").tag("all"); Text("People").tag("people")
                    Text("Bots").tag("bots"); Text("Files").tag("files")
                    Text("Links").tag("links"); Text("Bot results").tag("results"); Text("Pinned").tag("pinned")
                }
                Picker("From", selection: $author) {
                    Text("Anyone").tag("")
                    ForEach(contacts.filter { $0.kind == "person" }) { contact in Text(contact.id == selfID ? "You" : contact.name).tag(contact.id) }
                    ForEach(bots) { bot in Text(botLabel(bot)).tag(bot.id) }
                }
            }
            Section {
                if !loading && error == nil && messages.isEmpty {
                    ContentUnavailableView("No matching messages", systemImage: "magnifyingglass", description: Text("Try another word or filter."))
                }
                ForEach(messages) { message in
                    Button { Task {
                        opening = true; error = nil
                        defer { opening = false }
                        do { try await showMessage(message.id, message.sequence) }
                        catch { self.error = error.localizedDescription }
                    } } label: {
                        VStack(alignment: .leading, spacing: 6) {
                            HStack(alignment: .firstTextBaseline) {
                                Text(name(message)).font(.caption.weight(.semibold))
                                Spacer()
                                Text(Date(timeIntervalSince1970: message.at / 1000).formatted(date: .abbreviated, time: .omitted)).font(.caption)
                            }.foregroundStyle(.secondary)
                            Text(message.text.isEmpty ? "Shared file" : message.text).font(.subheadline).lineLimit(4).foregroundStyle(.primary)
                            if let files = message.attachments, !files.isEmpty {
                                Label(files.map(\.name).joined(separator: ", "), systemImage: "paperclip").font(.caption).lineLimit(2).foregroundStyle(.secondary)
                            }
                        }.padding(.vertical, 4)
                    }.buttonStyle(.plain).disabled(opening)
                }
                if loading { ProgressView("Searching…") }
                if let error { Text(error).font(.subheadline).foregroundStyle(.red); Button("Try again") { Task { await load() } } }
                if hasMore && !loading { Button("Load earlier matches") { Task { await load(earlier: true) } } }
            }
        }
        .navigationTitle("Search conversation")
        .searchable(text: $query, prompt: "Messages and file names")
        .onChange(of: query) { _, value in if value.count > 200 { query = String(value.prefix(200)) } }
        .task(id: searchKey) {
            generation = UUID(); messages = []; before = nil; hasMore = false; error = nil; loading = true
            do { try await Task.sleep(for: .milliseconds(250)); try Task.checkCancellation(); await load() }
            catch { /* superseded search */ }
        }
    }
    private func name(_ message: SharedChatMessage) -> String {
        if message.actor.id == selfID { return "You" }
        if let bot = bots.first(where: { $0.id == message.actor.id }) { return botLabel(bot) }
        return contacts.first(where: { $0.id == message.actor.id })?.name ?? (message.actor.kind == "bot" ? "Bot" : "Member")
    }
    private func botLabel(_ bot: SharedEligibleBot) -> String {
        guard let owner = bot.ownerName, !owner.isEmpty else { return bot.name }
        return "\(bot.name) · \(owner)"
    }
    private func load(earlier: Bool = false) async {
        let token = UUID(); generation = token; loading = true; error = nil
        defer { if generation == token { loading = false } }
        do {
            let page = try await session.searchSharedMessages(roomId: roomId, text: query, kind: kind, author: author, before: earlier ? before : nil)
            try Task.checkCancellation()
            guard generation == token else { return }
            let ids = Set(messages.map(\.id))
            messages = earlier ? messages + page.messages.filter { !ids.contains($0.id) } : page.messages
            hasMore = page.hasMore; before = page.before
        } catch { if generation == token && !Task.isCancelled { self.error = "Could not search this conversation. Check the connection and try again." } }
    }
}
