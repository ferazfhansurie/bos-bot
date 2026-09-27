// Make a channel from the phone: a name, and which bots are in it.
//
// The harness names it after the first member if the name is left blank,
// which is what the desktop's dialog does too — one rule, two screens.
import SwiftUI
import CompanionCore

struct NewGroupSheet: View {
    let created: (Room) -> Void
    let sharedContacts: [SharedContact]
    let sharedMe: SharedMe?
    let createdShared: (SharedRoomSummary) -> Void
    @EnvironmentObject private var session: Session
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var members = Set<String>()
    @State private var creating = false
    @State private var error: String?

    // Remote bots (on another linked Mac) cannot join channels here.
    private var bots: [Bot] { session.state.bots.filter { $0.hidden != true && $0.remote == nil } }

    /// People first, then the other side's bots. Our own bots already show
    /// above from the roster, so their shared copies are skipped.
    private var sharedPicks: [SharedContact] {
        let others = sharedContacts.filter { contact in
            contact.id != sharedMe?.actorId
                && !(contact.kind == "bot" && contact.homeId == sharedMe?.homeId && contact.remote != true)
        }
        return others.filter { $0.kind == "person" } + others.filter { $0.kind == "bot" }
    }

    @ViewBuilder private func sharedAvatar(_ contact: SharedContact) -> some View {
        if contact.kind == "bot" {
            MausAvatar(color: contact.color ?? "green", size: 36, bodyId: contact.mascotBody, animated: false)
        } else if let avatar = contact.avatar, PersonCutout.image(dataURL: avatar) != nil {
            PersonPhotoView(dataURL: avatar, size: 36)
        } else {
            ProfileAvatar(name: contact.name, size: 36)
        }
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    TextField("Group name (optional)", text: $name)
                        .autocorrectionDisabled()
                }
                Section("Members") {
                    ForEach(bots) { bot in
                        Button {
                            if members.contains(bot.id) { members.remove(bot.id) } else { members.insert(bot.id) }
                            Haptics.selection()
                        } label: {
                            HStack(spacing: 12) {
                                BotAvatarView(bot: bot, size: 36, state: .idle, animated: false)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(bot.name).font(.system(size: 16, weight: .semibold)).foregroundStyle(Color.primary)
                                    if !bot.title.isEmpty {
                                        Text(bot.title).font(.system(size: 13)).foregroundStyle(Color.secondary)
                                    }
                                }
                                Spacer()
                                Image(systemName: members.contains(bot.id) ? "checkmark.circle.fill" : "circle")
                                    .font(.system(size: 22))
                                    .foregroundStyle(members.contains(bot.id) ? MausPalette.color(bot.color) : Color.secondary.opacity(0.4))
                            }
                        }
                        .buttonStyle(.plain)
                    }
                    ForEach(sharedPicks) { contact in
                        Button {
                            if members.contains(contact.id) { members.remove(contact.id) } else { members.insert(contact.id) }
                            Haptics.selection()
                        } label: {
                            HStack(spacing: 12) {
                                sharedAvatar(contact)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(contact.name).font(.system(size: 16, weight: .semibold)).foregroundStyle(Color.primary)
                                    if contact.kind == "bot" {
                                        Text(contact.ownerName.map { "\($0)'s bot" } ?? "Shared bot")
                                            .font(.system(size: 13)).foregroundStyle(Color.secondary)
                                    }
                                }
                                Spacer()
                                Image(systemName: members.contains(contact.id) ? "checkmark.circle.fill" : "circle")
                                    .font(.system(size: 22))
                                    .foregroundStyle(members.contains(contact.id)
                                                     ? MausPalette.color(contact.color ?? "green") : Color.secondary.opacity(0.4))
                            }
                        }
                        .buttonStyle(.plain)
                    }
                }
                if let error { Text(error).foregroundStyle(.red) }
            }
            .navigationTitle("New group")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Create") {
                        creating = true
                        Task {
                            // members in roster order, so the room's name (if
                            // it defaults) follows the first bot you picked
                            let ordered = bots.map(\.id).filter(members.contains)
                            let remote = sharedContacts.filter { members.contains($0.id) }
                            if !remote.isEmpty, let me = sharedMe, let actorID = me.actorId {
                                do {
                                    let localIDs = ordered.map { "\(me.homeId):bot:\($0)" }
                                    let title = name.trimmingCharacters(in: .whitespacesAndNewlines)
                                    let room = try await session.createSharedRoom(name: title.isEmpty ? remote[0].name : title, memberIds: [actorID] + localIDs + remote.map(\.id))
                                    Haptics.success()
                                    createdShared(room)
                                } catch { self.error = error.localizedDescription }
                            } else if let room = await session.createRoom(name: name, memberIds: ordered) {
                                Haptics.success()
                                created(room)
                            }
                            creating = false
                        }
                    }
                    .disabled(members.isEmpty || creating)
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }
}
