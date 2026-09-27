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
    @State private var current: SharedRoomSummary?
    @State private var name = ""
    @State private var saving = false
    @State private var error: String?
    @State private var notifications = "all"
    @State private var confirmLeave = false
    @State private var confirmDelete = false
    @State private var memberToRemove: SharedContact?
    private var displayed: SharedRoomSummary { current ?? room }
    private var canManage: Bool { selfID == (displayed.createdBy ?? "\(displayed.homeId):person:owner") || selfID == "\(displayed.homeId):person:owner" }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    VStack(spacing: 12) {
                        GroupMarkView(members: GroupMarkView.faces(displayed, contacts: contacts, selfID: selfID), size: 68)
                        Text(displayed.name).font(.title2.weight(.semibold))
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
                    if displayed.isGroup && canManage {
                        Menu {
                            ForEach(contacts.filter { $0.kind == "person" && !displayed.memberIds.contains($0.id) }) { contact in
                                Button(contact.name) { Task { await update(members: displayed.memberIds + [contact.id]) } }
                            }
                        } label: { Label("Add people", systemImage: "person.badge.plus") }
                    }
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
            .task { do { notifications = try await session.sharedPreferences(roomId: displayed.id).notifications } catch { self.error = error.localizedDescription } }
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
