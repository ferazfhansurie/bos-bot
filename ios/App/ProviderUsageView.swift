import SwiftUI
import CompanionCore

struct ProviderUsageView: View {
    @EnvironmentObject private var session: Session
    @State private var accounts: [ProviderUsageAccount] = []
    @State private var loading = true
    @State private var error: String?

    var body: some View {
        List {
            if loading && accounts.isEmpty {
                ProgressView("Loading limits…").frame(maxWidth: .infinity)
            }
            if let error {
                Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.secondary)
            }
            if !loading && error == nil && accounts.isEmpty {
                ContentUnavailableView("No Claude or Codex account configured.", systemImage: "gauge.with.dots.needle.0percent")
            }
            ForEach(accounts) { account in
                Section("\(account.provider.capitalized) · \(account.account)") {
                    if let fiveHour = account.fiveHour { meter("5h", fiveHour) }
                    meter("7d", account.sevenDay)
                }
            }
        }
        .navigationTitle("Subscription limits")
        .refreshable { await refresh() }
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
        } catch {
            self.error = "Limits unavailable. Pull to retry."
        }
        loading = false
    }
}
