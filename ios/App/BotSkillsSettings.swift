import CompanionCore
import SwiftUI

struct BotSkillsSettings: View {
    let bot: Bot
    @EnvironmentObject private var session: Session
    @State private var skills: [BotSkill] = []
    @State private var loading = true
    @State private var problem: String?

    var body: some View {
        List {
            if loading { ProgressView("Loading skills") }
            if let problem { Text(problem).foregroundStyle(.red) }
            if !loading && skills.isEmpty && problem == nil { Text("No skills installed on this bot.").foregroundStyle(.secondary) }
            ForEach(skills) { skill in
                NavigationLink {
                    BotSkillDetail(bot: bot, skill: skill)
                } label: {
                    VStack(alignment: .leading, spacing: 4) {
                        HStack { Text(skill.name); Spacer(); Text(skill.enabled ? "On" : "Off").foregroundStyle(.secondary) }
                        Text(skill.description).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                    }
                }
            }
        }
        .navigationTitle("Skills")
        .task { await load() }
        .refreshable { await load() }
    }

    private func load() async {
        guard session.canAdminister, !bot.isRemote, let client = session.captureSendClient() else { return }
        let connection = session.connection?.id
        loading = true
        do {
            let value = try await client.botSkills(botId: bot.id)
            guard !Task.isCancelled, session.connection?.id == connection else { return }
            skills = value; problem = nil; loading = false
        } catch {
            guard !Task.isCancelled, session.connection?.id == connection else { return }
            problem = error.localizedDescription; loading = false
        }
    }
}

private struct BotSkillDetail: View {
    let bot: Bot
    let skill: BotSkill
    @EnvironmentObject private var session: Session
    @State private var text: String?
    @State private var enabled: Bool?
    @State private var busy = false
    @State private var problem: String?
    @State private var confirmEnable = false
    @State private var loadedConnection: String?

    var body: some View {
        Form {
            Section {
                Text(skill.description)
                Text("Source: \(skill.source)").font(.caption).foregroundStyle(.secondary)
                ForEach(skill.warnings, id: \.self) { warning in
                    Label(warning, systemImage: "exclamationmark.triangle").font(.footnote)
                }
                if let text {
                    Text(text).font(.system(.footnote, design: .monospaced)).textSelection(.enabled)
                } else if problem == nil { ProgressView("Loading instructions") }
            } header: { Text("Review instructions") }
            if let problem { Text(problem).foregroundStyle(.red) }
            Section {
                Button((enabled ?? skill.enabled) ? "Disable skill" : "Enable skill") {
                    if enabled ?? skill.enabled { Task { await setEnabled(false) } }
                    else { confirmEnable = true }
                }
                .disabled(busy || text == nil || loadedConnection != session.connection?.id)
            } footer: {
                Text("Enabled skills add instructions to this bot's future turns. Disabling does not interrupt work already running.")
            }
        }
        .navigationTitle(skill.name)
        .confirmationDialog("Enable this skill?", isPresented: $confirmEnable, titleVisibility: .visible) {
            Button("Enable skill") { Task { await setEnabled(true) } }
            Button("Cancel", role: .cancel) {}
        } message: { Text("Only enable instructions you have reviewed and trust. This skill can guide the bot's use of its permitted tools.") }
        .task {
            guard session.canAdminister, !bot.isRemote, let client = session.captureSendClient() else { return }
            let connection = session.connection?.id
            do {
                let value = try await client.botSkillText(botId: bot.id, name: skill.name)
                guard !Task.isCancelled, session.connection?.id == connection else { return }
                text = value; loadedConnection = connection
            } catch {
                guard !Task.isCancelled, session.connection?.id == connection else { return }
                problem = error.localizedDescription
            }
        }
    }

    private func setEnabled(_ value: Bool) async {
        guard session.canAdminister, !bot.isRemote, loadedConnection == session.connection?.id,
              let client = session.captureSendClient(), !busy else { return }
        let connection = session.connection?.id
        busy = true; problem = nil
        defer { busy = false }
        do {
            let updated = try await client.setBotSkillEnabled(botId: bot.id, name: skill.name, enabled: value, expectedSHA: skill.sha256)
            guard !Task.isCancelled, session.connection?.id == connection else { return }
            enabled = updated.enabled
        } catch {
            guard !Task.isCancelled, session.connection?.id == connection else { return }
            problem = error.localizedDescription
        }
    }
}

struct BotPermissionsSettings: View {
    let bot: Bot
    @EnvironmentObject private var session: Session
    @State private var pending: PhoneApprovalMode?
    @State private var confirming = false
    @State private var busy = false
    @State private var problem: String?
    @State private var ownerConnection: String?
    private var current: Bot { session.state.bot(bot.id)?.projected(forThread: bot.threadId) ?? bot }
    private var mode: String { current.approvalMode ?? (current.autoApprove == true ? "auto" : "ask") }

    var body: some View {
        Section {
            LabeledContent("Current permissions", value: mode.capitalized)
            ForEach(PhoneApprovalMode.allCases, id: \.rawValue) { option in
                Button(label(option)) { pending = option; confirming = true }
                    .disabled(busy || current.busy == true || mode == option.rawValue || mode == "custom")
            }
            if current.busy == true { Text("Stop this thread before changing permissions.").font(.footnote).foregroundStyle(.secondary) }
            if mode == "custom" { Text("Custom permissions must be changed from the desktop.").font(.footnote).foregroundStyle(.secondary) }
            if let problem { Text(problem).font(.footnote).foregroundStyle(.red) }
        } header: { Text("This thread's permissions") } footer: {
            Text("Changes apply only to this thread. Full and custom access retain their existing trusted-device approval requirements.")
        }
        .onAppear { ownerConnection = session.connection?.id }
        .confirmationDialog("Change this thread's permissions?", isPresented: $confirming, titleVisibility: .visible) {
            if let pending { Button(label(pending)) { Task { await apply(pending) } } }
            Button("Cancel", role: .cancel) { pending = nil }
        } message: {
            Text(pending == .auto ? "Auto lets this bot run permitted actions without asking each time, including actions on the selected computer. Review the computer and thread before continuing." : "The server checks which permissions this model supports. Existing thread history is kept.")
        }
    }

    private func label(_ mode: PhoneApprovalMode) -> String {
        switch mode { case .ask: "Ask before actions"; case .edits: "Allow file edits"; case .auto: "Auto approve permitted actions" }
    }

    private func apply(_ mode: PhoneApprovalMode) async {
        guard session.canAdminister, !bot.isRemote, ownerConnection == session.connection?.id,
              let client = session.captureSendClient(), !busy else { return }
        let connection = session.connection?.id
        busy = true; problem = nil
        defer { busy = false; pending = nil }
        do {
            let updated = try await client.setThreadApproval(botId: bot.id, threadId: bot.threadId, mode: mode, acknowledgeLocalAuto: mode == .auto)
            guard !Task.isCancelled, session.connection?.id == connection else { return }
            _ = session.applySettingsBot(updated, expectedConnectionID: connection)
        } catch {
            guard !Task.isCancelled, session.connection?.id == connection else { return }
            problem = error.localizedDescription
        }
    }
}
