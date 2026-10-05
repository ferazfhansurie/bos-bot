import SwiftUI
import PhotosUI
import UIKit
import CompanionCore

/// Settings for local bot channels: bots, the people sharing the room, and
/// which bots answer those people.
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
    @State private var contacts: [SharedContact] = []
    @State private var removingPerson: RoomPerson?
    @State private var invite: RoomInvite?
    /// Room bots that answer guests; nil until read, or on older computers.
    @State private var grants: Set<String>?
    private var contextIsCurrent: Bool { openingContext?.permits(session.roomSettingsContext) == true }
    private var current: Room { contextIsCurrent ? session.state.rooms.first { $0.id == room.id } ?? room : room }
    private var members: [Bot] { current.memberIds.compactMap { session.state.bot($0) } }
    private var selfID: String? { session.roomActorId ?? current.ownerPersonId }
    private var people: [RoomPerson] {
        current.people ?? (current.peopleIds ?? []).map { RoomPerson(id: $0, name: $0, homeId: $0.components(separatedBy: ":").first ?? "") }
    }
    /// People known to this computer who are not in the room yet.
    private var addable: [SharedContact] {
        let present = Set(current.peopleIds ?? people.map(\.id))
        return contacts.filter { !present.contains($0.id) && $0.id != selfID }
    }
    /// Older computers send no people list; the section stays hidden there.
    private var supportsPeople: Bool { current.peopleIds != nil || current.people != nil }
    private func grantId(_ bot: Bot) -> String? { session.roomHomeId.map { "\($0):bot:\(bot.id)" } }

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
                if supportsPeople, current.dm != true {
                    Section("People") {
                        ForEach(people) { person in
                            HStack {
                                Image(systemName: "person.crop.circle.fill").font(.title2).foregroundStyle(.secondary)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(person.id == selfID ? "\(person.name) (you)" : person.name)
                                    if let home = person.homeName, !home.isEmpty {
                                        Text(home).font(.caption).foregroundStyle(.secondary)
                                    }
                                }
                                Spacer()
                                if session.canAdminister, person.id != current.ownerPersonId, person.id != selfID {
                                    Button(role: .destructive) { removingPerson = person } label: { Image(systemName: "minus.circle") }
                                        .accessibilityLabel("Remove \(person.name)")
                                }
                            }
                            .accessibilityIdentifier("room-person-" + person.id)
                        }
                        if session.canAdminister {
                            if !addable.isEmpty {
                                Menu {
                                    ForEach(addable) { contact in
                                        Button(contact.name) { Task { await addPerson(contact.id) } }
                                    }
                                } label: { Label("Add person", systemImage: "person.badge.plus") }
                            }
                            if let invite, let url = URL(string: invite.url) {
                                ShareLink(item: url, subject: Text(current.name), message: Text("Join \(current.name) on BOS")) {
                                    Label("Share invite link", systemImage: "square.and.arrow.up")
                                }
                            } else {
                                Button { Task { await makeInvite() } } label: { Label("Create invite link", systemImage: "link.badge.plus") }
                            }
                        }
                        Text("People see this room's conversation. Bots only answer them where allowed below.").font(.caption).foregroundStyle(.secondary)
                    }
                    if session.canAdminister, current.hasGuests, let grants {
                        Section("Bots that answer people") {
                            ForEach(members) { bot in
                                if let id = grantId(bot) {
                                    Toggle(isOn: Binding(
                                        get: { grants.contains(id) },
                                        set: { on in Task { await setGrant(id, on: on) } }
                                    )) {
                                        HStack { BotAvatarView(bot: bot, size: 28); Text(bot.name) }
                                    }
                                }
                            }
                        }
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
            .task { await loadPeopleControls() }
            .confirmationDialog("Remove \(removingPerson?.name ?? "person") from \(current.name)?", isPresented: Binding(
                get: { removingPerson != nil }, set: { if !$0 { removingPerson = nil } }), titleVisibility: .visible) {
                    if let person = removingPerson {
                        Button("Remove person", role: .destructive) { Task {
                            await removePerson(person.id)
                            removingPerson = nil
                        } }
                    }
                } message: { Text("They stop seeing new messages here.") }
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

    private func loadPeopleControls() async {
        guard supportsPeople, session.canAdminister, let context = openingContext ?? session.roomSettingsContext else { return }
        async let known = try? session.roomContacts()
        async let allowed = try? session.roomBotGrants(current, context: context)
        let (people, granted) = await (known, allowed)
        guard context.permits(session.roomSettingsContext) else { return }
        contacts = people ?? []
        grants = granted.map(Set.init)
    }

    private func addPerson(_ id: String) async {
        guard !saving, let context = openingContext, context.permits(session.roomSettingsContext) else { return }
        saving = true; defer { saving = false }
        do { _ = try await session.addRoomPerson(current, personId: id, context: context); error = nil }
        catch { if !Task.isCancelled { self.error = error.localizedDescription } }
    }

    private func removePerson(_ id: String) async {
        guard !saving, let context = openingContext, context.permits(session.roomSettingsContext) else { return }
        saving = true; defer { saving = false }
        do { _ = try await session.removeRoomPerson(current, personId: id, context: context); error = nil }
        catch { if !Task.isCancelled { self.error = error.localizedDescription } }
    }

    private func makeInvite() async {
        guard !saving, let context = openingContext, context.permits(session.roomSettingsContext) else { return }
        saving = true; defer { saving = false }
        do { invite = try await session.createRoomInvite(current, context: context); error = nil }
        catch { if !Task.isCancelled { self.error = error.localizedDescription } }
    }

    private func setGrant(_ id: String, on: Bool) async {
        guard !saving, var next = grants, let context = openingContext, context.permits(session.roomSettingsContext) else { return }
        if on { next.insert(id) } else { next.remove(id) }
        saving = true; defer { saving = false }
        do { grants = Set(try await session.setRoomBotGrants(current, botIds: next.sorted(), context: context)); error = nil }
        catch { if !Task.isCancelled { self.error = error.localizedDescription } }
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
