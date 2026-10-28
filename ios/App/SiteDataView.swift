import CompanionCore
import SwiftUI

/// The owner's bosbot.my numbers on glass: today up top, a tile per number
/// that matters, and a tab each for the funnel, ads, desktop and the free
/// tier. Only the computer's owner, on a computer holding the site's data
/// token, ever gets here; the phone itself never holds that token.
struct SiteDataView: View {
    @EnvironmentObject private var session: Session
    @Environment(\.dismiss) private var dismiss

    @State private var summary: SiteDataSummary?
    @State private var fetchedAt: Date?
    @State private var problem: String?
    @State private var loading = false
    @State private var tab: Tab = .now

    enum Tab: String, CaseIterable, Identifiable {
        case now, funnel, ads, desktop, free
        var id: String { rawValue }
        var symbol: String {
            switch self {
            case .now: "sun.max.fill"
            case .funnel: "line.3.horizontal.decrease"
            case .ads: "megaphone.fill"
            case .desktop: "desktopcomputer"
            case .free: "gift.fill"
            }
        }
    }

    static let brand = Color(red: 0, green: 0x99 / 255, blue: 0x57 / 255)

    var body: some View {
        ZStack(alignment: .bottom) {
            Color.black.ignoresSafeArea()
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    topBar
                    content
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 110)
            }
            .scrollIndicators(.hidden)
            .refreshable { await load(fresh: true) }
            tabBar
        }
        .preferredColorScheme(.dark)
        .task { await load(fresh: false) }
        .animation(.snappy(duration: 0.25), value: tab)
    }

    // MARK: - Top

    private var topBar: some View {
        HStack(spacing: 10) {
            HStack(spacing: 8) {
                Circle()
                    .fill(pillColor)
                    .frame(width: 8, height: 8)
                Text(pillText)
                    .font(.subheadline.weight(.medium))
                    .lineLimit(1)
            }
            .padding(.horizontal, 14)
            .frame(height: 40)
            .glassCapsule(interactive: false)
            .accessibilityElement(children: .combine)
            Spacer(minLength: 0)
            GlassGroup(spacing: 8) {
                HStack(spacing: 8) {
                    GlassButton(systemImage: "arrow.clockwise", size: 40) { Task { await load(fresh: true) } }
                        .accessibilityLabel("Refresh")
                        .disabled(loading)
                    GlassButton(systemImage: "xmark", size: 40) { dismiss() }
                        .accessibilityLabel("Close")
                }
            }
        }
        .padding(.top, 8)
    }

    private var pillText: String {
        if let problem, summary == nil { return problem.lowercased() }
        if let summary { return summary.statusLine }
        return "checking bosbot.my"
    }

    private var pillColor: Color {
        guard let summary else { return problem == nil ? .secondary : .orange }
        if summary.healthy { return Self.brand }
        return summary.needsLook.contains { $0.status == "critical" || $0.status == "serious" } ? .red : .orange
    }

    @ViewBuilder
    private var content: some View {
        if let summary {
            switch tab {
            case .now: NowTab(summary: summary, fetchedAt: fetchedAt, problem: problem, tab: $tab)
            case .funnel: FunnelTab(summary: summary)
            case .ads: AdsTab(summary: summary)
            case .desktop: DesktopTab(summary: summary)
            case .free: FreeTab(summary: summary)
            }
        } else if let problem, !loading {
            VStack(alignment: .leading, spacing: 12) {
                Text("Couldn't load the numbers").font(.headline)
                Text(problem).font(.subheadline).foregroundStyle(.secondary)
                Button("Try again") { Task { await load(fresh: true) } }
                    .buttonStyle(.borderedProminent)
                    .tint(Self.brand)
            }
            .padding(20)
            .frame(maxWidth: .infinity, alignment: .leading)
            .glassSheet()
        } else {
            SiteDataSkeleton()
        }
    }

    // MARK: - Tabs

    private var tabBar: some View {
        GlassGroup(spacing: 4) {
            HStack(spacing: 2) {
                ForEach(Tab.allCases) { item in
                    Button {
                        guard tab != item else { return }
                        Haptics.selection()
                        tab = item
                    } label: {
                        VStack(spacing: 3) {
                            Image(systemName: item.symbol).font(.system(size: 17, weight: .semibold))
                            Text(item.rawValue).font(.caption2.weight(.medium))
                        }
                        .foregroundStyle(tab == item ? Self.brand : .secondary)
                        .frame(maxWidth: .infinity, minHeight: 52)
                        .background {
                            if tab == item { Capsule().fill(Color.white.opacity(0.10)) }
                        }
                        .contentShape(Capsule())
                    }
                    .buttonStyle(BosPressStyle())
                    .accessibilityAddTraits(tab == item ? .isSelected : [])
                }
            }
            .padding(5)
            .glassCapsule()
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 8)
    }

    // MARK: - Loading

    private func load(fresh: Bool) async {
        guard !loading else { return }
        loading = true
        defer { loading = false }
        do {
            let response = try await session.loadSiteData(fresh: fresh)
            let next = SiteDataSummary(response.data)
            withAnimation(.snappy) {
                summary = next
                fetchedAt = response.fetchedAt.map { Date(timeIntervalSince1970: $0 / 1000) }
                problem = nil
            }
        } catch {
            problem = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }
}

// MARK: - Now

private struct NowTab: View {
    let summary: SiteDataSummary
    let fetchedAt: Date?
    let problem: String?
    @Binding var tab: SiteDataView.Tab

    private static let day: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_GB")
        formatter.dateFormat = "EEEE d MMM"
        return formatter
    }()

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 2) {
                Text("today").font(.system(size: 34, weight: .bold, design: .rounded))
                Text("\(Self.day.string(from: summary.generatedAt ?? Date()).lowercased()) · last 24 hours")
                    .font(.subheadline).foregroundStyle(.secondary)
            }
            hero
            LazyVGrid(columns: [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)], spacing: 12) {
                if let tile = summary.visits {
                    SiteTile(title: "site visits", period: "24h", symbol: "eye.fill", color: .blue, tile: tile) { tab = .funnel }
                }
                if let tile = summary.newPeople {
                    SiteTile(title: "new people", period: "7d", symbol: "person.2.fill", color: .pink, tile: tile) { tab = .funnel }
                }
                if let tile = summary.firstMessage {
                    SiteTile(title: "first message", period: "7d", symbol: "bubble.left.fill", color: .purple, tile: tile) { tab = .free }
                }
                if let tile = summary.usingBos {
                    SiteTile(title: "using bos", period: "today", symbol: "laptopcomputer", color: .orange, tile: tile) { tab = .desktop }
                }
            }
            if let budget = summary.budget {
                Button { tab = .ads } label: { BudgetTile(budget: budget) }
                    .buttonStyle(BosPressStyle())
            }
            if !summary.checks.isEmpty { ChecksCard(checks: summary.checks) }
            footer
        }
    }

    private var hero: some View {
        HStack(alignment: .center, spacing: 8) {
            VStack(alignment: .leading, spacing: 6) {
                Text("visits to bosbot.my").font(.subheadline.weight(.medium)).foregroundStyle(.secondary)
                Text(summary.views24h.map(SiteDataSummary.count) ?? "–")
                    .font(.system(size: 56, weight: .bold, design: .rounded))
                    .monospacedDigit()
                    .contentTransition(.numericText())
                if let story = summary.story {
                    Text(story).font(.subheadline).foregroundStyle(.primary.opacity(0.85))
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 0)
            ProfileLiveMascot(color: "#009957", eyeStyle: .glyph, size: 90, name: "bos",
                              fixedFace: summary.healthy ? .finished : .waiting)
                .frame(width: 110)
        }
        .padding(.leading, 20)
        .padding(.trailing, 8)
        .padding(.vertical, 10)
        .glassSheet(cornerRadius: 30, tint: SiteDataView.brand.opacity(0.18))
    }

    private var footer: some View {
        Group {
            if let problem {
                Text("Showing the last numbers. \(problem)")
            } else if let fetchedAt {
                Text("Updated \(fetchedAt, style: .relative) ago")
            }
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .frame(maxWidth: .infinity)
    }
}

private struct SiteTile: View {
    let title: String
    let period: String
    let symbol: String
    let color: Color
    let tile: SiteDataSummary.Tile
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 8) {
                HStack(alignment: .top) {
                    Image(systemName: symbol)
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(.white)
                        .frame(width: 30, height: 30)
                        .background(color.gradient, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
                    Spacer()
                    Text(period).font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
                }
                Text(title).font(.subheadline.weight(.medium)).foregroundStyle(.secondary)
                HStack(alignment: .firstTextBaseline, spacing: 4) {
                    Text(SiteDataSummary.count(tile.value))
                        .font(.system(size: 32, weight: .bold, design: .rounded))
                        .monospacedDigit()
                        .contentTransition(.numericText())
                    if !tile.unit.isEmpty {
                        Text(tile.unit).font(.subheadline.weight(.semibold)).foregroundStyle(.secondary)
                    }
                }
                .foregroundStyle(.primary)
                Text(tile.note).font(.caption).foregroundStyle(.secondary).lineLimit(1).minimumScaleFactor(0.8)
                Sparkline(values: tile.spark, color: color).frame(height: 30)
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .glassSheet(cornerRadius: 24)
        }
        .buttonStyle(BosPressStyle())
        .accessibilityElement(children: .combine)
    }
}

private struct BudgetTile: View {
    let budget: SiteDataSummary.Budget

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                Image(systemName: "megaphone.fill")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: 30, height: 30)
                    .background(Color.teal.gradient, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
                VStack(alignment: .leading, spacing: 1) {
                    Text("ad spend").font(.subheadline.weight(.medium)).foregroundStyle(.secondary)
                    if let name = budget.name { Text(name).font(.caption).foregroundStyle(.secondary).lineLimit(1) }
                }
                Spacer()
            }
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                Text("rm\(SiteDataSummary.money(budget.spentRM))")
                    .font(.system(size: 30, weight: .bold, design: .rounded)).monospacedDigit()
                Text("of rm\(SiteDataSummary.count(budget.capRM)) cap").font(.subheadline.weight(.semibold)).foregroundStyle(.secondary)
            }
            .foregroundStyle(.primary)
            GeometryReader { proxy in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.white.opacity(0.10))
                    Capsule().fill(LinearGradient(colors: [.teal, SiteDataView.brand], startPoint: .leading, endPoint: .trailing))
                        .frame(width: max(8, proxy.size.width * budget.fraction))
                }
            }
            .frame(height: 8)
            Text(note).font(.caption).foregroundStyle(.secondary)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassSheet(cornerRadius: 24)
        .accessibilityElement(children: .combine)
    }

    private var note: String {
        var parts: [String] = []
        if let daily = budget.dailyRM { parts.append("rm\(SiteDataSummary.count(daily))/day") }
        if let left = budget.daysLeft { parts.append(String(format: "%.1f days left", left)) }
        return parts.joined(separator: " · ")
    }
}

private struct ChecksCard: View {
    let checks: [SiteDataSummary.Check]
    @State private var open = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                Haptics.selection()
                withAnimation(.snappy) { open.toggle() }
            } label: {
                HStack {
                    Text("checks").font(.headline)
                    Spacer()
                    Text("\(checks.filter(\.good).count) of \(checks.count) good").font(.subheadline).foregroundStyle(.secondary)
                    Image(systemName: "chevron.down").font(.footnote.weight(.semibold)).foregroundStyle(.secondary)
                        .rotationEffect(.degrees(open ? 180 : 0))
                }
                .padding(16)
                .contentShape(Rectangle())
            }
            .buttonStyle(BosPressStyle())
            if open {
                ForEach(checks) { check in
                    Divider().overlay(Color.white.opacity(0.06))
                    HStack(alignment: .top, spacing: 10) {
                        Circle().fill(color(check.status)).frame(width: 8, height: 8).padding(.top, 6)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(check.label).font(.subheadline.weight(.medium))
                            if !check.detail.isEmpty { Text(check.detail).font(.caption).foregroundStyle(.secondary) }
                        }
                        Spacer()
                        Text(check.value).font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.trailing)
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                    .accessibilityElement(children: .combine)
                }
            }
        }
        .glassSheet(cornerRadius: 24)
    }

    private func color(_ status: String) -> Color {
        switch status {
        case "good": SiteDataView.brand
        case "warning": .orange
        case "serious", "critical": .red
        default: .secondary
        }
    }
}

private struct Sparkline: View {
    let values: [Double]
    let color: Color

    var body: some View {
        if values.count > 1 {
            GeometryReader { proxy in
                let line = path(in: proxy.size)
                ZStack {
                    filled(line, size: proxy.size)
                        .fill(LinearGradient(colors: [color.opacity(0.35), color.opacity(0)], startPoint: .top, endPoint: .bottom))
                    line.stroke(color, style: StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
                }
            }
            .accessibilityHidden(true)
        } else {
            Color.clear
        }
    }

    private func path(in size: CGSize) -> Path {
        let top = values.max() ?? 1, low = values.min() ?? 0
        let span = max(top - low, 1)
        return Path { path in
            for (index, value) in values.enumerated() {
                let point = CGPoint(x: size.width * CGFloat(index) / CGFloat(values.count - 1),
                                    y: 2 + (size.height - 4) * (1 - CGFloat((value - low) / span)))
                index == 0 ? path.move(to: point) : path.addLine(to: point)
            }
        }
    }

    private func filled(_ line: Path, size: CGSize) -> Path {
        var area = line
        area.addLine(to: CGPoint(x: size.width, y: size.height))
        area.addLine(to: CGPoint(x: 0, y: size.height))
        area.closeSubpath()
        return area
    }
}

// MARK: - Other tabs

private struct TabHeader: View {
    let title: String
    let subtitle: String
    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title).font(.system(size: 34, weight: .bold, design: .rounded))
            Text(subtitle).font(.subheadline).foregroundStyle(.secondary)
        }
    }
}

/// A titled glass card of bars, longest first in scale, in the order given.
private struct BarsCard: View {
    let title: String
    let steps: [SiteDataSummary.Step]
    var color: Color = SiteDataView.brand

    var body: some View {
        let top = max(steps.map(\.count).max() ?? 1, 1)
        VStack(alignment: .leading, spacing: 12) {
            Text(title).font(.headline)
            ForEach(steps) { step in
                VStack(alignment: .leading, spacing: 5) {
                    HStack {
                        Text(step.label).font(.subheadline)
                        Spacer()
                        Text(SiteDataSummary.count(step.count)).font(.subheadline.weight(.semibold)).monospacedDigit()
                    }
                    GeometryReader { proxy in
                        ZStack(alignment: .leading) {
                            Capsule().fill(Color.white.opacity(0.08))
                            Capsule().fill(color.gradient).frame(width: max(6, proxy.size.width * CGFloat(step.count / top)))
                        }
                    }
                    .frame(height: 6)
                }
                .accessibilityElement(children: .combine)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassSheet(cornerRadius: 24)
    }
}

private struct PairsCard: View {
    let title: String
    let pairs: [SiteDataSummary.Pair]

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(title).font(.headline).padding(16)
            ForEach(Array(pairs.enumerated()), id: \.element.id) { index, pair in
                if index > 0 { Divider().overlay(Color.white.opacity(0.06)).padding(.leading, 16) }
                HStack {
                    Text(pair.label).font(.subheadline)
                    Spacer()
                    Text(pair.value).font(.subheadline.weight(.semibold)).monospacedDigit().foregroundStyle(.secondary)
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 11)
                .accessibilityElement(children: .combine)
            }
        }
        .padding(.bottom, 4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassSheet(cornerRadius: 24)
    }
}

private struct FunnelTab: View {
    let summary: SiteDataSummary
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            TabHeader(title: "funnel", subtitle: "visit to download to install")
            if !summary.funnel7d.isEmpty { BarsCard(title: "last 7 days", steps: summary.funnel7d) }
            if !summary.sources7d.isEmpty {
                PairsCard(title: "where visits came from · 7d", pairs: summary.sources7d.map {
                    .init(label: $0.name, value: "\(SiteDataSummary.count($0.views)) · \(SiteDataSummary.count($0.downloads)) dl · \(SiteDataSummary.count($0.installs)) inst")
                })
            }
            if !summary.activation.isEmpty { BarsCard(title: "desktop activation · 7d", steps: summary.activation, color: .orange) }
            if !summary.funnel30d.isEmpty { BarsCard(title: "last 30 days", steps: summary.funnel30d, color: .blue) }
        }
    }
}

private struct AdsTab: View {
    let summary: SiteDataSummary
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            TabHeader(title: "ads", subtitle: "meta, spend against the cap")
            if let budget = summary.budget { BudgetTile(budget: budget) }
            ForEach(summary.ads) { ad in
                PairsCard(title: ad.name, pairs: rows(ad))
                    .overlay(alignment: .topTrailing) {
                        Text(ad.live ? "live" : "paused")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(ad.live ? SiteDataView.brand : .secondary)
                            .padding(16)
                    }
            }
            if summary.ads.isEmpty && summary.budget == nil {
                Text("No ad numbers from bosbot.my.").font(.subheadline).foregroundStyle(.secondary)
            }
        }
    }

    private func rows(_ ad: SiteDataSummary.Ad) -> [SiteDataSummary.Pair] {
        var rows: [SiteDataSummary.Pair] = []
        if let v = ad.spendRM { rows.append(.init(label: "spent", value: "rm\(SiteDataSummary.money(v))")) }
        if let v = ad.impressions { rows.append(.init(label: "views", value: SiteDataSummary.count(v))) }
        if let v = ad.clicks { rows.append(.init(label: "link clicks", value: SiteDataSummary.count(v))) }
        if let v = ad.ctrPercent { rows.append(.init(label: "click rate", value: String(format: "%.2f%%", v))) }
        if let v = ad.landingViews { rows.append(.init(label: "landing views", value: SiteDataSummary.count(v))) }
        if let v = ad.registrations { rows.append(.init(label: "meta registrations", value: SiteDataSummary.count(v))) }
        if let v = ad.signups { rows.append(.init(label: "our sign-ups", value: SiteDataSummary.count(v))) }
        return rows
    }
}

private struct DesktopTab: View {
    let summary: SiteDataSummary
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            TabHeader(title: "desktop", subtitle: "real people on the mac and windows app")
            if let tile = summary.usingBos {
                SiteTile(title: "using bos", period: "today", symbol: "laptopcomputer", color: .orange, tile: tile) {}
            }
            if !summary.desktop.isEmpty { PairsCard(title: "people", pairs: summary.desktop) }
            if !summary.platforms.isEmpty { BarsCard(title: "platform · 30d", steps: summary.platforms, color: .orange) }
            if !summary.versions.isEmpty { BarsCard(title: "versions · 30d", steps: summary.versions, color: .teal) }
        }
    }
}

private struct FreeTab: View {
    let summary: SiteDataSummary
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            TabHeader(title: "free", subtitle: "app.bosbot.my, outside people only")
            if let tile = summary.firstMessage {
                SiteTile(title: "first message", period: "7d", symbol: "bubble.left.fill", color: .purple, tile: tile) {}
            }
            if !summary.free.isEmpty { PairsCard(title: "free tier", pairs: summary.free) }
            if !summary.freeFunnel.isEmpty { BarsCard(title: "sign-up funnel · 30d", steps: summary.freeFunnel, color: .purple) }
        }
    }
}

// MARK: - Skeleton

private struct SiteDataSkeleton: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 8) {
                SkeletonBlock(width: 110, height: 34)
                SkeletonBlock(width: 200, height: 14)
            }
            SkeletonBlock(height: 150)
            LazyVGrid(columns: [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)], spacing: 12) {
                ForEach(0..<4, id: \.self) { _ in SkeletonBlock(height: 170) }
            }
            SkeletonBlock(height: 120)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Loading bosbot.my numbers")
    }
}
