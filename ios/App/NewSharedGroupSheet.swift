import SwiftUI
import CompanionCore

struct NewSharedGroupSheet: View {
    @EnvironmentObject private var session: Session
    @Environment(\.dismiss) private var dismiss
    let contacts: [SharedContact]
    let selfID: String
    let created: (SharedRoomSummary) -> Void

    @State private var name = ""
    @State private var selected = Set<String>()
    @State private var saving = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                TextField("Group name", text: $name)
                Section { Text("Start with your people. Mention a bot whenever you need it.").font(.subheadline).foregroundStyle(.secondary) }
                Section("People") {
                    ForEach(contacts.filter { $0.kind == "person" && $0.id != selfID }) { contact in
                        Button {
                            if !selected.insert(contact.id).inserted { selected.remove(contact.id) }
                        } label: {
                            HStack {
                                Text(contact.name)
                                if contact.kind == "bot" { Text("bot").foregroundStyle(.secondary) }
                                Spacer()
                                if selected.contains(contact.id) { Image(systemName: "checkmark") }
                            }
                        }
                    }
                }
                if let error { Text(error).foregroundStyle(.red) }
            }
            .navigationTitle("New group chat")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Create") { Task { await create() } }
                        .disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || selected.isEmpty || saving)
                }
            }
        }
    }

    private func create() async {
        saving = true
        defer { saving = false }
        do {
            let room = try await session.createSharedRoom(name: name.trimmingCharacters(in: .whitespacesAndNewlines), memberIds: [selfID] + selected.sorted())
            created(room)
        } catch { self.error = error.localizedDescription }
    }
}
