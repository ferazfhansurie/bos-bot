import SwiftUI
import CompanionCore

struct ProviderUsageView: View {
    @EnvironmentObject private var session: Session
    @State private var accounts: [ProviderUsageAccount] = []
    @State private var loading = true
    @State private var error: String?

    var body: some View {
        List {
            if loading { ProgressView("Loading limits…") }
            if let error { Text(error).foregroundStyle(.secondary) }
            if !loading && error == nil && accounts.isEmpty {
                Text("No Claude or Codex account configured.").foregroundStyle(.secondary)
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
                    .foregroundStyle(.secondary)
            }
            if let percent = window.usedPercent {
                ProgressView(value: min(100, max(0, percent)), total: 100)
                    .tint(percent >= 85 ? .red : percent >= 65 ? .orange : .green)
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

/// Claude and Codex limits at the top of the chat list, like the mac
/// sidebar's row under Tools: one line per account and a thin bar for the
/// window closest to its cap. Tapping opens the full limits with reset times.
struct RosterUsageRow: View {
    @EnvironmentObject private var session: Session
    @State private var accounts: [ProviderUsageAccount] = []

    var body: some View {
        // a real container even while empty, or the polling task never starts
        VStack(spacing: 0) {
            if !accounts.isEmpty {
                NavigationLink { ProviderUsageView() } label: {
                    VStack(spacing: 8) {
                        ForEach(accounts) { account in
                            VStack(spacing: 4) {
                                HStack {
                                    Text(verbatim: account.providerName).foregroundStyle(.primary)
                                    Spacer()
                                    Text(verbatim: account.compactSummary)
                                        .monospacedDigit().foregroundStyle(.secondary).lineLimit(1)
                                }
                                .font(.footnote)
                                if let peak = account.peakPercent {
                                    ProgressView(value: min(100, max(0, peak)), total: 100)
                                        .tint(peak >= 85 ? .red : peak >= 65 ? .orange : .accentColor)
                                        .scaleEffect(y: 0.6)
                                }
                            }
                        }
                    }
                    .padding(.horizontal, 14).padding(.vertical, 10)
                    .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 14))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .padding(.horizontal, 16).padding(.top, 4)
                .accessibilityLabel(accounts.map { "\($0.providerName) \($0.compactSummary)" }.joined(separator: ", "))
                .accessibilityHint("Opens subscription limits")
                .accessibilityIdentifier("roster-usage")
            }
        }
        // same 30s cadence as the mac row
        .task(id: session.connection?.id) {
            guard session.connection != nil else { accounts = []; return }
            while !Task.isCancelled {
                if let latest = try? await session.loadProviderUsage() { accounts = latest }
                try? await Task.sleep(for: .seconds(30))
            }
        }
    }
}
