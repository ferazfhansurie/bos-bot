import CompanionCore
import SwiftUI

/// Tools destination only. A sandbox is not a portable bot runtime.
struct BotComputerSettings: View {
    let bot: Bot
    @EnvironmentObject private var session: Session
    @State private var status: BotRuntimeStatus?
    @State private var loading = false
    @State private var problem: String?
    @State private var pending: BotComputerOption?

    var body: some View {
        Section {
            if let status {
                LabeledContent("Bot runtime", value: status.runtimeLocation == "box-agent" ? "Box agent · server managed" : "Connected server")
                Menu {
                    Button("Follow bot default") { select(nil) }
                    ForEach(status.options) { option in
                        Button(option.label) { pending = option }
                            .disabled(!option.available)
                    }
                } label: {
                    LabeledContent("This thread’s computer", value: status.options.first { $0.surface == status.selected }?.label ?? "Follow bot default")
                }
                .accessibilityIdentifier("thread-computer-picker")
                .accessibilityValue(status.options.first { $0.surface == status.selected }?.label ?? "Follow bot default")
                .disabled(loading || status.busy)
                if status.busy { Text("Stop this thread before changing its computer.").font(.caption).foregroundStyle(.secondary) }
                Text("Changes apply to the next turn. Files, logins and the bot runtime stay where they are; the connected server must remain online.")
                    .font(.caption).foregroundStyle(.secondary)
            } else if loading { ProgressView("Checking computer options") }
            if let problem { Text(problem).font(.caption).foregroundStyle(.secondary) }
            Button("Refresh computer status") { Task { await refresh() } }.disabled(loading)
        } header: { Text("Computer") }
        .task(id: "\(session.connection?.id ?? ""):\(bot.id):\(bot.threadId)") { await refresh() }
        .confirmationDialog("Use this computer for the next turn?", isPresented: Binding(get: { pending != nil }, set: { if !$0 { pending = nil } })) {
            if let option = pending { Button("Use \(option.label)") { select(option.surface); pending = nil } }
            Button("Cancel", role: .cancel) { pending = nil }
        } message: {
            Text("Selecting saves your preference without starting a computer. The next task may start compute and incur charges. This does not transfer files or move the bot runtime.")
        }
    }

    private func refresh() async {
        let connectionID = session.connection?.id
        loading = true
        defer { loading = false }
        do {
            let result = try await session.botRuntime(botId: bot.id, threadId: bot.threadId)
            guard !Task.isCancelled, session.connection?.id == connectionID else { return }
            status = result; problem = nil
        } catch {
            guard !Task.isCancelled, session.connection?.id == connectionID else { return }
            status = nil; problem = error.localizedDescription
        }
    }

    private func select(_ surface: String?) {
        let connectionID = session.connection?.id
        loading = true
        Task {
            do {
                try await session.selectThreadComputer(botId: bot.id, threadId: bot.threadId, surface: surface)
                guard session.connection?.id == connectionID else { return }
                await refresh()
            } catch {
                guard session.connection?.id == connectionID else { return }
                problem = error.localizedDescription
            }
            loading = false
        }
    }
}
