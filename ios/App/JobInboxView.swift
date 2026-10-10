import SwiftUI
import CompanionCore

/// Every readable job: what it is for, where it stands, who owns each part
/// and what its owners reported. Opening this screen is a read — it never
/// resumes or dispatches work. A row opens the job's existing thread.
struct JobInboxView: View {
    var onOpen: (Chat) -> Void
    @EnvironmentObject private var session: Session
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @State private var jobs: [JobInboxItem] = []
    @State private var loaded = false
    @State private var errorMessage: String?
    @State private var opening: String?
    @State private var openError: String?

    /// Changes whenever any thread's running, waiting or unread state does,
    /// so the inbox re-reads on task changes instead of on a tight timer.
    private var taskSignature: String {
        session.state.bots.map { bot in
            bot.id + (bot.tasks ?? []).map { "\($0.threadId)\($0.activity ?? "")\($0.busy == true)" }.joined()
        }.joined() + session.state.rooms.map { $0.threadId + "\($0.activeBotIds ?? [])" }.joined()
    }

    var body: some View {
        NavigationStack {
            List {
                if let errorMessage {
                    Section {
                        Label(errorMessage, systemImage: "exclamationmark.circle")
                            .foregroundStyle(.secondary)
                    }
                } else if loaded && jobs.isEmpty {
                    Section {
                        Text("No jobs yet. When a bot plans work with its team, it shows up here.")
                            .foregroundStyle(.secondary)
                    }
                }
                let open = jobs.filter { $0.state != .completed }
                let done = jobs.filter { $0.state == .completed }
                if !open.isEmpty {
                    Section("In progress") { ForEach(open) { row($0) } }
                }
                if !done.isEmpty {
                    Section("Finished") { ForEach(done) { row($0) } }
                }
            }
            .overlay {
                if !loaded && errorMessage == nil { ProgressView() }
            }
            .navigationTitle("Jobs")
            .navigationBarTitleDisplayMode(.inline)
            .navigationDestination(for: JobInboxItem.self) { job in
                JobDetailView(job: job, opening: opening == job.id) { open(job) }
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }
            }
            .alert("Couldn't open this job", isPresented: Binding(
                get: { openError != nil },
                set: { if !$0 { openError = nil } }
            )) {
                Button("OK", role: .cancel) { openError = nil }
            } message: {
                Text(openError ?? "")
            }
            .bosRefreshable { await load() }
            .task(id: taskSignature) {
                guard scenePhase == .active else { return }
                await load()
            }
            .task {
                // Refresh while visible; the task ends with the screen.
                while !Task.isCancelled {
                    try? await Task.sleep(for: .seconds(30))
                    guard !Task.isCancelled else { return }
                    if scenePhase == .active { await load() }
                }
            }
        }
    }

    private func row(_ job: JobInboxItem) -> some View {
        NavigationLink(value: job) {
            JobRow(job: job, leadName: session.state.ownerName(job.botId))
        }
        .accessibilityIdentifier("job-row-\(job.id)")
    }

    private func load() async {
        do {
            let next = try await session.loadJobs()
            guard !Task.isCancelled else { return }
            jobs = next
            errorMessage = nil
        } catch is CancellationError {
            return
        } catch let APIError.status(code, _) where code == 404 {
            jobs = []
            errorMessage = "This computer doesn't have the job inbox yet. Update BOS on it to see jobs here."
        } catch {
            guard !Task.isCancelled else { return }
            // Keep the last good list on a transient failure.
            if jobs.isEmpty { errorMessage = error.localizedDescription }
        }
        loaded = true
    }

    private func open(_ job: JobInboxItem) {
        guard opening == nil else { return }
        opening = job.id
        Task {
            defer { opening = nil }
            guard let chat = await session.open(job) else {
                openError = session.actionError ?? "That job's conversation isn't on this phone yet."
                return
            }
            Haptics.selection()
            onOpen(chat)
        }
    }
}

struct JobStateBadge: View {
    let state: JobState

    private var tint: Color {
        switch state {
        case .needsYou: return .orange
        case .blocked: return .red
        case .moving: return .accentColor
        case .completed: return .green
        default: return .secondary
        }
    }

    var body: some View {
        Text(state.label)
            .font(.caption.weight(.semibold))
            .foregroundStyle(tint)
            .padding(.horizontal, 8).padding(.vertical, 3)
            .background(tint.opacity(0.14), in: Capsule())
    }
}

struct JobRow: View {
    let job: JobInboxItem
    let leadName: String

    private var progress: String {
        job.steps.isEmpty ? leadName : "\(leadName) · \(job.doneCount)/\(job.steps.count) steps"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline) {
                Text(verbatim: job.outcome)
                    .font(.subheadline.weight(.medium))
                    .lineLimit(2)
                Spacer(minLength: 8)
                JobStateBadge(state: job.state)
            }
            Text(verbatim: progress)
                .font(.caption)
                .foregroundStyle(.secondary)
            if let reason = job.reason, job.state == .needsYou || job.state == .blocked {
                Text(verbatim: reason)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            } else if let next = job.nextStep, job.state != .completed {
                Text(verbatim: "Next: \(next.action)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }
}

/// One job in full: outcome, state, lead and helpers, each step with its
/// owner, and results labelled as what their owner reported.
struct JobDetailView: View {
    let job: JobInboxItem
    let opening: Bool
    let onOpenThread: () -> Void
    @EnvironmentObject private var session: Session

    var body: some View {
        List {
            Section {
                Text(verbatim: job.outcome).font(.headline)
                HStack {
                    JobStateBadge(state: job.state)
                    if let reason = job.reason {
                        Text(verbatim: reason).font(.caption).foregroundStyle(.secondary)
                    }
                }
                Button {
                    onOpenThread()
                } label: {
                    HStack {
                        Label("Open conversation", systemImage: "bubble.left.and.bubble.right")
                        Spacer()
                        if opening { ProgressView().controlSize(.small) }
                    }
                }
                .disabled(opening)
                .accessibilityIdentifier("job-open-thread")
            }

            Section("Owners") {
                LabeledContent("Lead", value: session.state.ownerName(job.botId))
                if !job.helperBotIds.isEmpty {
                    LabeledContent("Helpers", value: job.helperBotIds.map(session.state.ownerName).joined(separator: ", "))
                }
            }

            if !job.steps.isEmpty {
                Section("Steps") {
                    ForEach(job.steps) { step in
                        VStack(alignment: .leading, spacing: 3) {
                            HStack(alignment: .firstTextBaseline) {
                                Image(systemName: icon(step.status))
                                    .foregroundStyle(step.isDone ? Color.green : step.status == "blocked" ? .red : .secondary)
                                Text(verbatim: step.action).font(.subheadline)
                            }
                            Text(verbatim: "\(session.state.ownerName(step.ownerBotId)) · \(step.status)")
                                .font(.caption).foregroundStyle(.secondary)
                            if let reason = step.reason {
                                Text(verbatim: reason).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        .accessibilityElement(children: .combine)
                    }
                }
            }

            if !job.results.isEmpty {
                Section {
                    ForEach(Array(job.results.enumerated()), id: \.offset) { _, result in
                        VStack(alignment: .leading, spacing: 3) {
                            Text(verbatim: result.evidence).font(.subheadline).textSelection(.enabled)
                            Text(verbatim: "Reported by \(session.state.ownerName(result.ownerBotId))")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    }
                } header: {
                    Text("Results")
                } footer: {
                    Text("What each owner reported. BOS hasn't checked these independently.")
                }
            }
        }
        .navigationTitle("Job")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func icon(_ status: String) -> String {
        switch status {
        case "done": return "checkmark.circle.fill"
        case "blocked": return "exclamationmark.octagon"
        case "ready": return "circle"
        default: return "clock"
        }
    }
}
