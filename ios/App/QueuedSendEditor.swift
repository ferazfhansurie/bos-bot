import CompanionCore
import SwiftUI

/// Edits the typed words of one held send. The entry keeps its queueId,
/// position, recipient and attachments; saving replaces its text in place on
/// the computer and never sends anything. Every refusal keeps the edit here.
struct QueuedSendEditor: View {
    /// The entry as it was when the editor opened; its text is what the
    /// computer must still hold for the save to apply.
    let send: QueuedSend
    /// Who receives it, as the chat header names them.
    let recipient: String
    let threadTitle: String?
    /// The same entry as the queue holds it now; nil once it drained or was
    /// deleted while the editor was open.
    let live: QueuedSend?
    let save: (String) async -> Result<QueuedSend, QueuedSendEditError>

    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var draft: QueuedSendDraft
    @State private var fields: [String]
    @State private var saving = false
    @State private var failure: QueuedSendEditError?
    @FocusState private var focused: Int?

    init(send: QueuedSend, recipient: String, threadTitle: String? = nil, live: QueuedSend?,
         save: @escaping (String) async -> Result<QueuedSend, QueuedSendEditError>) {
        self.send = send
        self.recipient = recipient
        self.threadTitle = threadTitle
        self.live = live
        self.save = save
        let draft = QueuedSendDraft(send)
        _draft = State(initialValue: draft)
        _fields = State(initialValue: draft.fields)
    }

    private var problem: QueuedSendDraft.Problem? { draft.problem(with: fields) }
    private var intended: String { draft.text(with: fields) }
    private var gone: Bool { live == nil || failure == .gone }
    /// Another device changed it after this editor opened. Holding exactly
    /// this edit already means an earlier save landed.
    private var changedUnderneath: Bool { live.map { $0.text != send.text && $0.text != intended } ?? false }
    private var canSave: Bool {
        !saving && problem == nil && !gone && !changedUnderneath
            && (failure == nil || failure?.isRetryable == true)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    header
                    ForEach(fields.indices, id: \.self) { index in
                        field(index)
                    }
                    if !draft.attachments.isEmpty || !draft.pastes.isEmpty { keptContent }
                    notice
                }
                .padding(16)
            }
            .navigationTitle("Edit queued message")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .frame(minWidth: 44, minHeight: 44)
                }
                ToolbarItem(placement: .confirmationAction) {
                    if saving {
                        ProgressView()
                            .frame(minWidth: 44, minHeight: 44)
                            .accessibilityLabel("Saving")
                    } else {
                        Button("Save") { Task { await commit() } }
                            .fontWeight(.semibold)
                            .disabled(!canSave)
                            .frame(minWidth: 44, minHeight: 44)
                            .accessibilityHint("Replaces the queued text. Nothing is sent now.")
                    }
                }
            }
            .interactiveDismissDisabled(saving)
            .animation(reduceMotion ? nil : .easeOut(duration: 0.2), value: failure)
            .animation(reduceMotion ? nil : .easeOut(duration: 0.2), value: gone)
            .onAppear { focused = 0 }
            .onChange(of: fields) { _, _ in
                // A refusal about the words themselves clears once they change;
                // a gone or changed entry stays reported.
                if case .refused = failure { failure = nil }
            }
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 2) {
            Label {
                Text("To \(recipient)").font(.system(size: 15, weight: .semibold))
            } icon: {
                Image(systemName: "arrow.turn.down.right")
            }
            if let threadTitle, !threadTitle.isEmpty {
                Text(threadTitle)
                    .font(.system(size: 13))
                    .foregroundStyle(Color.secondary)
                    .lineLimit(1)
            }
            Text("Stays in the queue in the same place. Starts when the bot is free.")
                .font(.system(size: 12))
                .foregroundStyle(Color.secondary)
        }
        .accessibilityElement(children: .combine)
    }

    private func field(_ index: Int) -> some View {
        TextEditor(text: $fields[index])
            .font(.system(size: 16))
            .focused($focused, equals: index)
            .frame(minHeight: fields.count == 1 ? 140 : 72)
            .padding(8)
            .scrollContentBackground(.hidden)
            .background(Color.primary.opacity(0.06), in: RoundedRectangle(cornerRadius: 12))
            .disabled(saving)
            .overlay(alignment: .topLeading) {
                if fields[index].isEmpty {
                    Text(draft.fields[index].isEmpty ? "Add a message" : "Message")
                        .font(.system(size: 16))
                        .foregroundStyle(Color.secondary)
                        .padding(.horizontal, 13).padding(.vertical, 16)
                        .allowsHitTesting(false)
                }
            }
            .accessibilityLabel(fields.count == 1
                ? String(localized: "Queued message text")
                : String(localized: "Queued message text, part \(index + 1) of \(fields.count)"))
    }

    /// Files and pastes are shown, never editable, so it is plain what goes
    /// along with the edited words.
    private var keptContent: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Kept as is")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(Color.secondary)
            ForEach(Array(draft.pastes.enumerated()), id: \.offset) { _, paste in
                keptRow("doc.on.clipboard", String(localized: "Pasted · \(paste.lines) lines"))
            }
            ForEach(Array(draft.attachments.enumerated()), id: \.offset) { _, attachment in
                keptRow(attachment.kind == .image ? "photo" : "doc", attachment.name)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(String(localized: "Kept unchanged: \(keptSummary)"))
    }

    private var keptSummary: String {
        (draft.pastes.map { String(localized: "pasted text, \($0.lines) lines") } + draft.attachments.map(\.name))
            .joined(separator: ", ")
    }

    private func keptRow(_ systemImage: String, _ label: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: systemImage).font(.system(size: 13))
            Text(label).lineLimit(1).truncationMode(.middle)
            Spacer(minLength: 0)
            Image(systemName: "lock").font(.system(size: 11))
        }
        .font(.system(size: 14))
        .foregroundStyle(Color.secondary)
        .padding(.horizontal, 10)
        .frame(minHeight: 36)
        .background(Color.primary.opacity(0.05), in: RoundedRectangle(cornerRadius: 10))
    }

    @ViewBuilder private var notice: some View {
        if let message = noticeText {
            VStack(alignment: .leading, spacing: 8) {
                Label(message, systemImage: gone || failure != nil ? "exclamationmark.triangle" : "info.circle")
                    .font(.system(size: 13))
                    .foregroundStyle(gone || failure != nil ? Color.orange : Color.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                if gone || changedUnderneath || failure?.isRetryable == false {
                    // Nothing was applied; keep the words reachable without
                    // ever turning them into a new send.
                    Button {
                        PlatformBridge.copyToPasteboard(intended)
                    } label: {
                        Label("Copy my edit", systemImage: "doc.on.doc")
                            .frame(minHeight: 44)
                    }
                    .accessibilityHint("Copies your edited text. Nothing is sent.")
                }
            }
            .accessibilityElement(children: .contain)
            .transition(.opacity)
        }
    }

    private var noticeText: String? {
        if let failure { return failure.message }
        if live == nil { return QueuedSendEditError.gone.message }
        if changedUnderneath { return QueuedSendEditError.changed.message }
        if let problem, problem != .unchanged { return problem.message }
        return nil
    }

    private func commit() async {
        guard canSave else { return }
        let text = intended
        saving = true
        failure = nil
        let result = await save(text)
        saving = false
        switch result {
        case .success:
            Haptics.success()
            dismiss()
        case .failure(.changed) where QueuedSendEditError.landed(text, live: live):
            // A lost response on an earlier try: the computer already holds it.
            dismiss()
        case let .failure(error):
            failure = error
        }
    }
}
