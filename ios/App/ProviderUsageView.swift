import SwiftUI
import CompanionCore

struct ProviderUsageView: View {
    @EnvironmentObject private var session: Session
    @State private var accounts: [ProviderUsageAccount] = []
    @State private var loading = true
    @State private var error: String?
    @State private var checkedAt: Date?

    var body: some View {
        List {
            if loading && accounts.isEmpty {
                RosterSkeleton()
            }
            if let error {
                Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.secondary)
            }
            if !loading && error == nil && accounts.isEmpty {
                ContentUnavailableView("No Claude or Codex account configured.", systemImage: "gauge.with.dots.needle.0percent")
            }
            if let checkedAt {
                Text("Fetched \(checkedAt.formatted(date: .abbreviated, time: .shortened)). Pull to refresh.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            ForEach(accounts) { account in
                Section("\(account.account) · \(account.providerName)") {
                    let names = session.state.bots.filter { $0.remote == nil && $0.modelSelection.instanceId == account.instanceId }.map(\.name)
                    if !names.isEmpty { Text(names.joined(separator: " + ")).font(.caption).foregroundStyle(.secondary) }
                    if let fiveHour = account.fiveHour { meter("5h", fiveHour) }
                    meter("7d", account.sevenDay)
                }
            }
        }
        .navigationTitle("Subscription limits")
        .bosRefreshable { await refresh() }
        .task { await refresh() }
    }

    private func meter(_ title: String, _ window: ProviderUsageWindow) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(title).font(.headline)
                Spacer()
                Text(window.usedPercent.map { "\(Int($0.rounded()))% used" } ?? "Unavailable")
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
            }
            if let percent = window.usedPercent {
                ProgressView(value: min(100, max(0, percent)), total: 100)
                    .tint(percent >= 85 ? .red : percent >= 65 ? .orange : .accentColor)
            }
            if let reset = window.resetsAt {
                Text("Resets \(Date(timeIntervalSince1970: reset).formatted(date: .abbreviated, time: .shortened))")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }.padding(.vertical, 4)
    }

    private func refresh() async {
        do {
            accounts = try await session.loadProviderUsage()
            error = nil
            checkedAt = Date()
        } catch {
            self.error = "Limits unavailable. Pull to retry."
        }
        loading = false
    }
}
