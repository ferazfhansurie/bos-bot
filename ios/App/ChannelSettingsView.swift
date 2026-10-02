import SwiftUI
import PhotosUI
import UIKit
import CompanionCore

/// Settings for local bot channels, separate from people-first shared rooms.
struct ChannelSettingsView: View {
    let room: Room
    @EnvironmentObject private var session: Session
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var saving = false
    @State private var error: String?
    @State private var photo: PhotosPickerItem?
    @State private var removing: Bot?
    @State private var openingContext: RoomSettingsContext?
    private var contextIsCurrent: Bool { openingContext?.permits(session.roomSettingsContext) == true }
    private var current: Room { contextIsCurrent ? session.state.rooms.first { $0.id == room.id } ?? room : room }
    private var members: [Bot] { current.memberIds.compactMap { session.state.bot($0) } }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    ChannelAvatarView(room: current, size: 72).frame(maxWidth: .infinity)
                    if session.canAdminister {
                        PhotosPicker(selection: $photo, matching: .images) { Label("Choose group photo", systemImage: "photo") }
                        if current.avatarUrl != nil {
                            Button("Remove group photo") { Task { await save(RoomSettingsPatch(avatarUrl: .clear)) } }
                        }
                    }
                    TextField("Group name", text: $name)
                    Button("Save name") { Task { await save(RoomSettingsPatch(name: name.trimmingCharacters(in: .whitespacesAndNewlines))) } }
                        .disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || name == current.name)
                }
                if session.canAdminister, current.dm != true {
                    Section("Members") {
                        ForEach(members) { bot in
                            VStack(alignment: .leading, spacing: 8) {
                                HStack {
                                    BotAvatarView(bot: bot, size: 32)
                                    Text(bot.name)
                                    Spacer()
                                    if current.memberIds.count > 1 {
                                        Button(role: .destructive) { removing = bot } label: { Image(systemName: "minus.circle") }
                                            .accessibilityLabel("Remove \(bot.name)")
                                    }
                                }
                                Picker("When \(bot.name) replies", selection: Binding(
                                    get: { current.replyMode(for: bot.id) },
                                    set: { value in Task {
                                        var modes = current.memberReplyModes ?? [:]
                                        modes[bot.id] = value
                                        await save(RoomSettingsPatch(memberReplyModes: modes))
                                    } }
                                )) {
                                    Text("Always").tag("always")
                                    Text("Only when tagged").tag("mentions")
                                }
                            }
                        }
                        Text("Removing a bot stops future participation. The conversation history stays here.").font(.caption).foregroundStyle(.secondary)
                    }
                }
                if session.canAdminister {
                    Section("Notifications") {
                        Picker("Notify me", selection: Binding(
                            get: { current.notifications ?? "all" },
                            set: { value in Task { await save(RoomSettingsPatch(notifications: value)) } }
                        )) {
                            Text("All messages").tag("all")
                            Text("Mentions only").tag("mentions")
                            Text("Muted").tag("muted")
                        }
                    }
                }
                if let error { Section { Text(error).foregroundStyle(.red).accessibilityAddTraits(.isStaticText) } }
            }
            .disabled(saving || !contextIsCurrent)
            .navigationTitle("Group settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .onAppear { if openingContext == nil { openingContext = session.roomSettingsContext }; name = current.name }
            .onChange(of: session.roomSettingsContext) { _, _ in if !contextIsCurrent { dismiss() } }
            .onChange(of: photo) { _, item in if let item { Task { await upload(item) } } }
            .confirmationDialog("Remove \(removing?.name ?? "bot") from \(current.name)?", isPresented: Binding(
                get: { removing != nil }, set: { if !$0 { removing = nil } }), titleVisibility: .visible) {
                    if let bot = removing {
                        Button("Remove bot", role: .destructive) { Task {
                            await save(RoomSettingsPatch(memberIds: current.memberIds.filter { $0 != bot.id }))
                            removing = nil
                        } }
                    }
                } message: { Text("Existing messages are retained.") }
        }
    }

    private func save(_ patch: RoomSettingsPatch) async {
        guard !saving, let context = openingContext, context.permits(session.roomSettingsContext) else { return }
        saving = true; defer { saving = false }
        do {
            let updated = try await session.updateRoom(current, patch: patch, context: context)
            name = updated.name; error = nil
        } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
    }

    private func upload(_ item: PhotosPickerItem) async {
        guard !saving, let context = openingContext, context.permits(session.roomSettingsContext) else { return }
        saving = true; defer { saving = false; photo = nil }
        do {
            guard let data = try await item.loadTransferable(type: Data.self),
                  let mime = Self.imageMIME(data), !data.isEmpty, data.count <= 10 * 1_024 * 1_024
            else { throw APIError.transport("Choose a PNG, JPEG, GIF, or WebP image up to 10 MB.") }
            _ = try await session.uploadRoomAvatar(data, mime: mime, room: current, context: context)
            error = nil
        } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
    }

    private static func imageMIME(_ data: Data) -> String? {
        let bytes = [UInt8](data.prefix(12))
        if bytes.starts(with: [0x89, 0x50, 0x4e, 0x47]) { return "image/png" }
        if bytes.starts(with: [0xff, 0xd8, 0xff]) { return "image/jpeg" }
        if bytes.starts(with: Array("GIF8".utf8)) { return "image/gif" }
        if bytes.count >= 12, String(bytes: bytes[0..<4], encoding: .ascii) == "RIFF",
           String(bytes: bytes[8..<12], encoding: .ascii) == "WEBP" { return "image/webp" }
        return nil
    }
}
