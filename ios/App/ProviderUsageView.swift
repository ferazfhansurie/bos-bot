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

/// Claude and Codex limits at the top of the chat list, like the mac
/// sidebar's row under Tools: one line per account and a thin bar for the
/// window closest to its cap. Tapping opens the full limits with reset times.
struct RosterUsageRow: View {
    @EnvironmentObject private var session: Session
    @Environment(\.horizontalSizeClass) private var sizeClass
    @State private var accounts: [ProviderUsageAccount] = []
    @State private var showingLimits = false

    var body: some View {
        // a real container even while empty, or the polling task never starts
        VStack(spacing: 0) {
            if !accounts.isEmpty {
                // A wide window's roster sits outside any navigation stack,
                // where a link has nothing to push onto: it opens a sheet.
                if sizeClass == .regular {
                    Button {
                        Haptics.selection()
                        showingLimits = true
                    } label: { summary }
                        .modifier(UsageRowChrome(accounts: accounts))
                } else {
                    NavigationLink { ProviderUsageView() } label: { summary }
                        .modifier(UsageRowChrome(accounts: accounts))
                }
            }
        }
        .sheet(isPresented: $showingLimits) {
            NavigationStack {
                ProviderUsageView()
                    .toolbar {
                        ToolbarItem(placement: .confirmationAction) {
                            Button("Done") { showingLimits = false }
                        }
                    }
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

    private var summary: some View {
        HStack(spacing: 10) {
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
            Image(systemName: "chevron.right")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(Color.secondary.opacity(0.5))
                .accessibilityHidden(true)
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .contentShape(Rectangle())
    }
}

private struct UsageRowChrome: ViewModifier {
    let accounts: [ProviderUsageAccount]

    func body(content: Content) -> some View {
        content
            .buttonStyle(.plain)
            .padding(.horizontal, 16).padding(.top, 4)
            .accessibilityLabel(accounts.map { "\($0.providerName) \($0.compactSummary)" }.joined(separator: ", "))
            .accessibilityHint("Opens subscription limits")
            .accessibilityIdentifier("roster-usage")
    }
}
