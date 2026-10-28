// The two screens behind the chat list's ⋯ menu, beside Apps.
//
// Notifications is the inbox: what stopped for you, what is running, what
// finished unread, and one action that clears the lot (routine runs each
// leave an unread thread, and the badge counts every one of them).
// Today is the day at a glance: routines still to come, what already ran,
// and the chats that moved since midnight.
import SwiftUI
import CompanionCore

struct NotificationsView: View {
    let open: (Chat) -> Void
    @EnvironmentObject private var session: Session
    @Environment(\.dismiss) private var dismiss
    @State private var clearing = false

    private var updates: [ChatUpdate] { session.state.updates }
    private var unread: Int {
        session.state.unreadCount + session.satellites.reduce(0) { $0 + $1.state.unreadCount }
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    if updates.isEmpty {
                        ContentUnavailableView(
                            "You're all caught up",
                            systemImage: "bell",
                            description: Text("When a bot stops for an answer, is mid-task, or finishes something, it shows up here.")
                        )
                        .padding(.top, 48)
                    } else {
                        section("Needs you", kind: .needsYou)
                        section("Working", kind: .working)
                        section("Unread", kind: .toReview)
                    }
                }
                .padding(.bottom, 24)
            }
            .navigationTitle("Notifications")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    if unread > 0 {
                        Button(clearing ? "Clearing…" : "Mark all read") {
                            clearing = true
                            Task {
                                await session.markAllRead()
                                clearing = false
                                Haptics.success()
                            }
                        }
                        .disabled(clearing)
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
        .presentationBackground(.thinMaterial)
        .presentationCornerRadius(28)
    }

    @ViewBuilder
    private func section(_ title: LocalizedStringKey, kind: ChatUpdate.Kind) -> some View {
        let items = updates.filter { $0.kind == kind }
        if !items.isEmpty {
            SectionLabel(title: title, count: items.count,
                         tint: kind == .needsYou ? MausPalette.color(items[0].chat.color) : .secondary)
            ForEach(items) { update in
                UpdateRow(update: update) { open(update.chat) }
            }
        }
    }
}

struct TodayView: View {
    let open: (Chat) -> Void
    @EnvironmentObject private var session: Session
    @Environment(\.dismiss) private var dismiss
    @State private var routines: [Routine] = []
    @State private var runs: [RoutineRun] = []
    @State private var loading = true

    private var calendar: Calendar { .current }
    private func date(_ ms: Double) -> Date { Date(timeIntervalSince1970: ms / 1_000) }
    private func isToday(_ ms: Double?) -> Bool { ms.map { calendar.isDateInToday(date($0)) } ?? false }

    private var comingUp: [Routine] {
        let now = Date().timeIntervalSince1970 * 1_000
        return routines
            .filter { $0.enabled && isToday($0.nextRunAt) && ($0.nextRunAt ?? 0) >= now }
            .sorted { ($0.nextRunAt ?? 0) < ($1.nextRunAt ?? 0) }
    }

    private var ranToday: [RoutineRun] {
        runs.filter { isToday($0.startedAt ?? $0.scheduledFor) }
            .sorted { ($0.startedAt ?? $0.scheduledFor) > ($1.startedAt ?? $1.scheduledFor) }
    }

    /// Bot threads that moved since midnight, newest first.
    private var chatsToday: [(chat: Chat, at: Double, title: String)] {
        session.state.bots.filter { $0.hidden != true }.flatMap { bot in
            bot.visibleTasks.compactMap { task -> (Chat, Double, String)? in
                guard let at = task.lastActivityAt, isToday(at),
                      let chat = session.state.chat(forThread: task.threadId) else { return nil }
                return (chat, at, task.title)
            }
        }
        .sorted { $0.1 > $1.1 }
        .map { (chat: $0.0, at: $0.1, title: $0.2) }
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    HStack(spacing: 10) {
                        TodayStat(value: session.state.updates.filter { $0.kind == .needsYou }.count, label: "need you", tint: .orange)
                        TodayStat(value: ranToday.count, label: "ran", tint: .green)
                        TodayStat(value: comingUp.count, label: "coming up", tint: .blue)
                    }
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets())
                } header: {
                    Text(Date().formatted(.dateTime.weekday(.wide).day().month(.wide)))
                }

                Section("Coming up") {
                    if comingUp.isEmpty {
                        Text(loading ? "Loading…" : "Nothing else scheduled today.").foregroundStyle(.secondary)
                    }
                    ForEach(comingUp) { routine in
                        HStack(spacing: 12) {
                            avatar(routine.botId)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(routine.name).lineLimit(1)
                                Text(verbatim: session.state.bot(routine.botId)?.name ?? "").font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer()
                            Text(date(routine.nextRunAt ?? 0).formatted(date: .omitted, time: .shortened))
                                .font(.subheadline.monospacedDigit()).foregroundStyle(.secondary)
                        }
                    }
                }

                Section("Ran today") {
                    if ranToday.isEmpty {
                        Text(loading ? "Loading…" : "No routine has run yet today.").foregroundStyle(.secondary)
                    }
                    ForEach(ranToday) { run in
                        Button {
                            if let threadId = run.threadId, let chat = session.state.chat(forThread: threadId) { open(chat) }
                        } label: {
                            HStack(spacing: 12) {
                                avatar(run.botId)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(run.routineName).lineLimit(1).foregroundStyle(Color.primary)
                                    Text(date(run.startedAt ?? run.scheduledFor).formatted(date: .omitted, time: .shortened))
                                        .font(.caption).foregroundStyle(.secondary)
                                }
                                Spacer()
                                Text(run.status == "waiting" ? "Needs you" : run.status.capitalized)
                                    .font(.caption.weight(.medium)).foregroundStyle(runTint(run.status))
                            }
                        }
                        .buttonStyle(.plain)
                    }
                }

                Section("Chats today") {
                    if chatsToday.isEmpty {
                        Text("No chats moved today.").foregroundStyle(.secondary)
                    }
                    ForEach(chatsToday.prefix(30), id: \.chat.conversationID) { item in
                        Button { open(item.chat) } label: {
                            HStack(spacing: 12) {
                                ChatAvatarView(chat: item.chat, size: 32, state: MausState.forChat(item.chat, in: session.state))
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(verbatim: item.chat.name).font(.subheadline.weight(.semibold)).foregroundStyle(Color.primary)
                                    Text(verbatim: item.title).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                                }
                                Spacer()
                                Text(date(item.at).formatted(date: .omitted, time: .shortened))
                                    .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                            }
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .navigationTitle("Today")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
            .task { await reload() }
            .bosRefreshable { await reload() }
        }
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
        .presentationBackground(.thinMaterial)
        .presentationCornerRadius(28)
    }

    private func reload() async {
        let loaded = await session.loadRoutines()
        routines = loaded.routines
        runs = loaded.runs
        loading = false
    }

    @ViewBuilder private func avatar(_ botId: String) -> some View {
        if let bot = session.state.bot(botId) {
            BotAvatarView(bot: bot, size: 32, state: .idle, animated: false)
        } else {
            Image(systemName: "calendar").frame(width: 32, height: 32)
        }
    }

    private func runTint(_ status: String) -> Color {
        switch status {
        case "completed": .green
        case "waiting": .orange
        case "failed", "missed": .red
        default: .secondary
        }
    }
}

private struct TodayStat: View {
    let value: Int
    let label: LocalizedStringKey
    let tint: Color

    var body: some View {
        VStack(spacing: 2) {
            Text("\(value)").font(.title2.bold().monospacedDigit()).foregroundStyle(value > 0 ? tint : .secondary)
            Text(label).font(.caption).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 12)
        .glassSheet(cornerRadius: 18)
    }
}

private struct SectionLabel: View {
    let title: LocalizedStringKey
    let count: Int
    let tint: Color

    var body: some View {
        HStack(spacing: 6) {
            Text(title).textCase(.uppercase).font(.caption.bold()).tracking(0.5)
            Text("\(count)").font(.caption.monospacedDigit())
        }
        .foregroundStyle(tint)
        .padding(.horizontal, 20)
        .padding(.top, 14)
        .padding(.bottom, 2)
    }
}
