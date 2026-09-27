// Settings stays status-first. Network details and destructive pairing
// controls live one level deeper so the everyday screen remains calm.
import SwiftUI
import CompanionCore
import UIKit

struct SettingsView: View {
    @EnvironmentObject private var session: Session
    @State private var enablingNotifications = false
    @AppStorage(PrefKey.activityDetail) private var activityDetail = ActivityDetail.reduced.rawValue
    @AppStorage(PrefKey.islandIntro) private var islandIntro = IslandIntro.oncePerBot.rawValue
    @AppStorage(PrefKey.language) private var language = AppLanguage.system.rawValue
    @AppStorage(PrefKey.appearance) private var appearance = AppAppearance.system.rawValue
    private let onConnect: (() -> Void)?

    init(onConnect: (() -> Void)? = nil) {
        self.onConnect = onConnect
    }

    var body: some View {
        Form {
            Section("Computer") {
                if let connection = session.connection {
                    NavigationLink {
                        ConnectedComputersView()
                    } label: {
                        ComputerSettingsRow(
                            name: Text(verbatim: connection.name),
                            status: computerStatusText,
                            connected: session.status == .live
                        )
                    }
                } else {
                    Button {
                        onConnect?()
                    } label: {
                        ComputerSettingsRow(
                            name: Text("Connect a computer"),
                            status: Text("Not connected"),
                            connected: false
                        )
                    }
                    .disabled(onConnect == nil)
                }
            }

            if session.connection != nil {
                Section("Subscription limits") {
                    NavigationLink { ProviderUsageView() } label: {
                        Label("Claude & Codex", systemImage: "chart.bar.fill")
                    }
                }
            }

            Section {
                if notificationsAreEnabled {
                    notificationRow
                        .accessibilityHint(notificationAccessibilityHint)
                } else {
                    Button {
                        enablingNotifications = true
                        Task {
                            await session.enableNotifications()
                            enablingNotifications = false
                        }
                    } label: {
                        notificationRow
                    }
                    .disabled(enablingNotifications)
                    .accessibilityHint(notificationAccessibilityHint)
                }
            } footer: {
                Text("Alerts arrive while BOS is open or was recently in the background. Closed-app delivery is not available yet.")
            }

            Section {
                Picker(selection: $activityDetail) {
                    ForEach(ActivityDetail.allCases, id: \.rawValue) { level in
                        Text(LocalizedStringKey(level.label)).tag(level.rawValue)
                    }
                } label: {
                    Label {
                        Text("Activity")
                    } icon: {
                        SettingsIcon(symbol: "wrench.and.screwdriver.fill", color: .purple)
                    }
                }

                Picker(selection: $islandIntro) {
                    ForEach(IslandIntro.allCases, id: \.rawValue) { option in
                        Text(LocalizedStringKey(option.label)).tag(option.rawValue)
                    }
                } label: {
                    Label {
                        Text("Bot intro animation")
                    } icon: {
                        SettingsIcon(symbol: "sparkles", color: .pink)
                    }
                }

                NavigationLink {
                    QuickRepliesEditor()
                } label: {
                    Label {
                        Text("Quick Replies")
                    } icon: {
                        SettingsIcon(symbol: "bolt.fill", color: .yellow)
                    }
                }
            } header: {
                Text("Chat")
            } footer: {
                Text(LocalizedStringKey(ActivityDetail(rawValue: activityDetail)?.caption ?? ""))
            }

            Section {
                NavigationLink {
                    AppearancePickerView()
                } label: {
                    Label {
                        HStack {
                            Text("Appearance")
                            Spacer()
                            Text(AppAppearance(rawValue: appearance)?.label ?? "Automatic")
                                .foregroundStyle(.secondary)
                        }
                    } icon: {
                        SettingsIcon(symbol: "circle.lefthalf.filled", color: .indigo)
                    }
                }

                Picker(selection: $language) {
                    ForEach(AppLanguage.allCases) { option in
                        Text(option.label).tag(option.rawValue)
                    }
                } label: {
                    Label {
                        Text("Language")
                    } icon: {
                        SettingsIcon(symbol: "globe", color: .teal)
                    }
                }
            } footer: {
                Text("Automatic appearance follows this device's display setting. Language changes inside BOS; iOS buttons follow the device language.")
            }

            if session.connection != nil {
                Section("Workspace") {
                    NavigationLink {
                        TasksRoutinesView()
                    } label: {
                        Label {
                            Text("Threads & Routines")
                        } icon: {
                            SettingsIcon(symbol: "calendar.badge.clock", color: .orange)
                        }
                    }

                    // Connecting apps needs the admin scope; a chat-only
                    // server session leaves it to the owner, in the server's UI.
                    if session.canAdminister {
                        NavigationLink {
                            ConnectedAppsView()
                        } label: {
                            Label {
                                Text("Connected Apps")
                            } icon: {
                                SettingsIcon(symbol: "link", color: .blue)
                            }
                        }
                    }
                }
            }
            Section("Help & feedback") {
                Link(destination: URL(string: "mailto:ferazfhansurie@gmail.com?subject=BOS%20alpha%20feedback")!) {
                    Label("Contact BOS", systemImage: "envelope")
                }
                Text("For help, alpha feedback or privacy requests: ferazfhansurie@gmail.com").font(.footnote).foregroundStyle(.secondary).textSelection(.enabled)
                Text("Include your app version and steps to reproduce. Please leave out passwords, keys and private conversations.").font(.footnote).foregroundStyle(.secondary)
            }
        }
        .navigationTitle("Settings")
        .navigationBarTitleDisplayMode(.inline)
        .task { await session.refreshNotificationAuthorization() }
    }

    private var notificationsAreEnabled: Bool {
        switch session.notificationAuthorization {
        case .authorized, .provisional, .ephemeral: return true
        default: return false
        }
    }

    private var notificationAccessibilityHint: LocalizedStringKey {
        if notificationsAreEnabled { return "Notifications are enabled" }
        if session.notificationAuthorization == .denied { return "Opens device Settings" }
        return "Asks for permission to send notifications"
    }

    private var notificationRow: some View {
        HStack(spacing: 12) {
            SettingsIcon(symbol: "bell.fill", color: .red)
            Text("Notifications")
                .foregroundStyle(.primary)
            Spacer()
            if enablingNotifications {
                ProgressView()
                    .controlSize(.small)
            } else {
                Text(LocalizedStringKey(session.notificationStatusText))
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var statusText: Text { session.status.settingsText }

    private var computerStatusText: Text {
        guard session.connections.count > 1 else { return statusText }
        return statusText + Text(verbatim: " · ") + Text("\(session.connections.count) saved")
    }
}

private struct AppearancePickerView: View {
    @AppStorage(PrefKey.appearance) private var appearance = AppAppearance.system.rawValue
    @AppStorage(PrefKey.theme) private var theme = AppTheme.midnight.rawValue
    @AppStorage(PrefKey.themeApplied) private var themeApplied = AppTheme.midnight.rawValue
    @Environment(\.colorScheme) private var scheme

    private var selectedTheme: AppTheme { AppTheme(rawValue: theme) ?? .midnight }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Text("Make BOS yours.")
                    .font(.title2.bold())
                Text("Pick a theme, then how bright you want it.")
                    .foregroundStyle(.secondary)
                Text("Theme")
                    .font(.headline)
                LazyVGrid(columns: [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)], spacing: 12) {
                    ForEach(AppTheme.allCases, id: \.rawValue) { option in
                        ThemeCard(theme: option, scheme: scheme, selected: theme == option.rawValue) {
                            withAnimation(.easeInOut(duration: 0.2)) { theme = option.rawValue }
                            ThemeSurfaces.apply(option)
                        }
                    }
                }
                Text("Brightness")
                    .font(.headline)
                ForEach(AppAppearance.allCases, id: \.rawValue) { option in
                    Button {
                        appearance = option.rawValue
                    } label: {
                        HStack(spacing: 18) {
                            Group {
                                if option == .system {
                                    HStack(spacing: 2) {
                                        AppearancePreview(scheme: .light, theme: selectedTheme)
                                        AppearancePreview(scheme: .dark, theme: selectedTheme)
                                    }
                                    .clipShape(RoundedRectangle(cornerRadius: 15))
                                } else {
                                    AppearancePreview(scheme: option.colorScheme ?? .light, theme: selectedTheme)
                                }
                            }
                            .frame(width: 112, height: 112)
                            VStack(alignment: .leading, spacing: 6) {
                                Text(option.label)
                                    .font(.headline)
                                    .foregroundStyle(.primary)
                                Text(option == .system
                                     ? "Follows this device's display setting"
                                     : option == .light ? "Bright and clear" : "Easy on the eyes")
                                    .font(.subheadline)
                                    .foregroundStyle(.secondary)
                                    .multilineTextAlignment(.leading)
                            }
                            Spacer(minLength: 0)
                            Image(systemName: appearance == option.rawValue ? "checkmark.circle.fill" : "circle")
                                .font(.title3)
                                .foregroundStyle(appearance == option.rawValue ? selectedTheme.accent : Color.secondary)
                        }
                        .padding(14)
                        .background(ThemeSwatch.surface(selectedTheme, scheme, \.composer, fallback: Color(uiColor: .secondarySystemGroupedBackground)),
                                    in: RoundedRectangle(cornerRadius: 22))
                        .overlay(RoundedRectangle(cornerRadius: 22)
                            .strokeBorder(appearance == option.rawValue ? selectedTheme.accent : Color.secondary.opacity(0.15), lineWidth: appearance == option.rawValue ? 2 : 1))
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(appearance == option.rawValue ? .isSelected : [])
                }
            }
            .padding(20)
            .frame(maxWidth: 640)
            .frame(maxWidth: .infinity)
        }
        // The rest of the app picks the new theme up when this screen closes;
        // this screen paints its own page so the choice shows straight away.
        .background(ThemeSwatch.surface(selectedTheme, scheme, \.panel, fallback: Color(uiColor: .systemGroupedBackground)).ignoresSafeArea())
        .toolbarBackground(ThemeSwatch.surface(selectedTheme, scheme, \.panel, fallback: Color(uiColor: .systemGroupedBackground)), for: .navigationBar)
        .navigationTitle("Appearance")
        .navigationBarTitleDisplayMode(.inline)
        .onDisappear { themeApplied = theme }
    }
}

private enum ThemeSwatch {
    static func surface(_ theme: AppTheme, _ scheme: ColorScheme, _ key: KeyPath<ThemePalette, UInt32>, fallback: Color) -> Color {
        guard let palette = theme.palette(scheme == .dark ? .dark : .light) else { return fallback }
        return Color(uiColor: UIColor(hex: palette[keyPath: key]))
    }
}

private struct ThemeCard: View {
    let theme: AppTheme
    let scheme: ColorScheme
    let selected: Bool
    let action: () -> Void

    private var accent: Color { Color(uiColor: theme.accentUIColor.resolvedColor(with: traits)) }
    private var traits: UITraitCollection { UITraitCollection(userInterfaceStyle: scheme == .dark ? .dark : .light) }

    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 10) {
                AppearancePreview(scheme: scheme, theme: theme, compact: true)
                    .frame(height: 92)
                HStack(alignment: .firstTextBaseline) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(theme.label).font(.headline).foregroundStyle(.primary)
                        Text(theme.caption).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    }
                    Spacer(minLength: 4)
                    Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                        .foregroundStyle(selected ? accent : Color.secondary.opacity(0.5))
                }
            }
            .padding(10)
            .background(ThemeSwatch.surface(theme, scheme, \.composer, fallback: Color(uiColor: .secondarySystemGroupedBackground)),
                        in: RoundedRectangle(cornerRadius: 20))
            .overlay(RoundedRectangle(cornerRadius: 20)
                .strokeBorder(selected ? accent : Color.secondary.opacity(0.15), lineWidth: selected ? 2 : 1))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text(theme.label))
        .accessibilityHint(Text(theme.caption))
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

private struct AppearancePreview: View {
    let scheme: ColorScheme
    let theme: AppTheme
    var compact = false

    private var dark: Bool { scheme == .dark }
    private var traits: UITraitCollection { UITraitCollection(userInterfaceStyle: dark ? .dark : .light) }
    private func resolved(_ color: UIColor) -> Color { Color(uiColor: color.resolvedColor(with: traits)) }

    private var page: Color {
        if let palette = theme.palette(dark ? .dark : .light) { return Color(uiColor: UIColor(hex: palette.app)) }
        return dark ? Color(red: 0.07, green: 0.07, blue: 0.08) : .white
    }
    private var accent: Color { resolved(theme.accentUIColor) }
    private var theirs: Color { resolved(theme.bubbleUIColor) }

    var body: some View {
        VStack(alignment: .leading, spacing: compact ? 6 : 8) {
            HStack(spacing: 5) {
                Circle().fill(accent).frame(width: compact ? 12 : 15, height: compact ? 12 : 15)
                RoundedRectangle(cornerRadius: 2).fill(dark ? Color.white.opacity(0.85) : Color.black.opacity(0.8))
                    .frame(width: compact ? 32 : 39, height: compact ? 4 : 5)
            }
            .padding(.bottom, compact ? 1 : 3)
            bubble(width: 67, mine: false)
            bubble(width: 55, mine: true)
            if !compact { bubble(width: 72, mine: false) }
            Spacer(minLength: 0)
            RoundedRectangle(cornerRadius: 9)
                .fill(dark ? Color.white.opacity(0.12) : Color.black.opacity(0.07))
                .frame(height: compact ? 10 : 13)
        }
        .padding(compact ? 9 : 11)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(page, in: RoundedRectangle(cornerRadius: compact ? 12 : 15))
        .overlay(RoundedRectangle(cornerRadius: compact ? 12 : 15).strokeBorder(.primary.opacity(0.12)))
        .shadow(color: .black.opacity(compact ? 0.06 : 0.12), radius: compact ? 3 : 6, y: compact ? 1 : 3)
        .environment(\.colorScheme, scheme)
    }

    private func bubble(width: CGFloat, mine: Bool) -> some View {
        RoundedRectangle(cornerRadius: 6)
            .fill(mine ? accent : theirs)
            .frame(width: compact ? width * 0.8 : width, height: compact ? 11 : 14)
            .frame(maxWidth: .infinity, alignment: mine ? .trailing : .leading)
    }
}

private struct ComputerSettingsRow: View {
    let name: Text
    let status: Text
    let connected: Bool

    var body: some View {
        HStack(spacing: 12) {
            ZStack {
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(MausPalette.color("blue").opacity(0.14))
                    .frame(width: 38, height: 38)
                Image(systemName: "laptopcomputer")
                    .foregroundStyle(MausPalette.color("blue"))
            }
            .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 3) {
                name
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                HStack(spacing: 5) {
                    Circle()
                        .fill(connected ? Color.green : Color.secondary)
                        .frame(width: 7, height: 7)
                    status
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}

private struct SettingsIcon: View {
    let symbol: String
    let color: Color

    var body: some View {
        Image(systemName: symbol)
            .font(.system(size: 15, weight: .semibold))
            .foregroundStyle(.white)
            .frame(width: 28, height: 28)
            .background(color, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
            .accessibilityHidden(true)
    }
}

struct ConnectedComputersView: View {
    @EnvironmentObject private var session: Session
    @State private var pendingRemoval: Connection?

    /// The dialog interpolates the computer's own name. With no name there is
    /// copy to fall back to, rather than an English word inside a translated
    /// sentence.
    private var removalTitle: LocalizedStringKey {
        guard let name = pendingRemoval?.name else { return "Remove this computer?" }
        return "Remove \(name)?"
    }

    private var otherComputers: [Connection] {
        session.connections.filter { $0.id != session.connection?.id }
    }

    var body: some View {
        List {
            if let active = session.connection {
                Section("Current computer") {
                    NavigationLink {
                        ConnectionSecurityView()
                    } label: {
                        ComputerSettingsRow(
                            name: Text(verbatim: active.name),
                            status: session.status.settingsText,
                            connected: session.status == .live
                        )
                    }
                }
            }

            if !otherComputers.isEmpty {
                Section("Other computers") {
                    ForEach(otherComputers) { computer in
                        Button {
                            Haptics.selection()
                            session.switchComputer(to: computer.id)
                        } label: {
                            HStack(spacing: 12) {
                                ProfileAvatar(name: computer.name, size: 38)
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(computer.name)
                                        .foregroundStyle(.primary)
                                        .lineLimit(1)
                                    Text("Tap to switch")
                                        .font(.footnote)
                                        .foregroundStyle(.secondary)
                                }
                                Spacer()
                                Text("Use")
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(MausPalette.color("blue"))
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .swipeActions {
                            Button("Remove", role: .destructive) {
                                pendingRemoval = computer
                            }
                        }
                        .accessibilityHint("Switches BOS to this computer")
                    }
                }
            }

            Section {
                Button {
                    Haptics.selection()
                    session.beginPairing()
                } label: {
                    Label("Connect another computer", systemImage: "plus.circle.fill")
                }
            } footer: {
                Text("Each computer is paired separately. Only the selected computer is active at a time.")
            }
        }
        .navigationTitle("Computers")
        .navigationBarTitleDisplayMode(.inline)
        .confirmationDialog(
            removalTitle,
            isPresented: Binding(
                get: { pendingRemoval != nil },
                set: { if !$0 { pendingRemoval = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("Remove from this device", role: .destructive) {
                guard let pendingRemoval else { return }
                session.forgetConnection(id: pendingRemoval.id)
                self.pendingRemoval = nil
            }
            Button("Cancel", role: .cancel) { pendingRemoval = nil }
        } message: {
            Text("This removes the saved connection from this device only.")
        }
    }
}

struct ConnectionSecurityView: View {
    @EnvironmentObject private var session: Session
    @Environment(\.dismiss) private var dismiss
    @State private var confirmingSignOut = false
    @State private var editingAddress = false
    @State private var addressText = ""
    @State private var showingFullAddress = false
    @State private var copiedAddress = false
    @State private var refreshing = false

    var body: some View {
        Form {
            if let connection = session.connection {
                Section {
                    HStack(spacing: 14) {
                        ProfileAvatar(name: connection.name, size: 46)
                        VStack(alignment: .leading, spacing: 4) {
                            Text(connection.name)
                                .font(.headline)
                            Label {
                                session.status.settingsText
                            } icon: {
                                Image(systemName: session.status == .live ? "checkmark.circle.fill" : "circle.dotted")
                            }
                                .font(.subheadline)
                                .foregroundStyle(session.status == .live ? Color.green : Color.secondary)
                        }
                    }
                    .padding(.vertical, 4)
                    .accessibilityElement(children: .combine)
                }

                Section {
                    DisclosureGroup("Connection details") {
                        VStack(alignment: .leading, spacing: 12) {
                            Group {
                                if showingFullAddress {
                                    Text(connection.displayAddress)
                                        .textSelection(.enabled)
                                } else {
                                    Text(shortened(connection.displayAddress))
                                        .lineLimit(1)
                                        .truncationMode(.middle)
                                }
                            }
                            .font(.footnote.monospaced())
                            .foregroundStyle(.secondary)

                            HStack(spacing: 16) {
                                Button(showingFullAddress ? "Hide full address" : "Show full address") {
                                    showingFullAddress.toggle()
                                }
                                Button(copiedAddress ? "Copied" : "Copy") {
                                    UIPasteboard.general.string = connection.displayAddress
                                    copiedAddress = true
                                    Task {
                                        try? await Task.sleep(for: .seconds(2))
                                        copiedAddress = false
                                    }
                                }
                            }
                            .font(.subheadline.weight(.medium))
                        }
                        .padding(.top, 10)
                    }

                    Button("Edit address") {
                        addressText = connection.displayAddress
                        editingAddress = true
                    }
                }

                Section("Troubleshooting") {
                    troubleshootingText
                        .font(.subheadline)
                        .foregroundStyle(.secondary)

                    Button {
                        refreshing = true
                        Task {
                            await session.refresh()
                            refreshing = false
                        }
                    } label: {
                        HStack {
                            Text("Try reconnecting")
                            if refreshing {
                                Spacer()
                                ProgressView().controlSize(.small)
                            }
                        }
                    }
                    .disabled(refreshing)
                }

                Section {
                    Button("Remove connection from this device", role: .destructive) {
                        confirmingSignOut = true
                    }
                }
            } else {
                ContentUnavailableView("No computer connected", systemImage: "laptopcomputer.slash")
            }
        }
        .navigationTitle("Connection & Security")
        .navigationBarTitleDisplayMode(.inline)
        .alert("Edit address", isPresented: $editingAddress) {
            TextField("Computer address", text: $addressText)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            Button("Save") {
                if !session.updateAddress(addressText) {
                    session.actionError = "That address doesn't look right. Copy it from Phone settings and try again."
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Use the address shown in Phone settings on your computer. Your pairing is kept.")
        }
        .confirmationDialog(
            "Remove this connection?",
            isPresented: $confirmingSignOut,
            titleVisibility: .visible
        ) {
            Button("Remove from this device", role: .destructive) {
                session.signOut()
                dismiss()
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This removes the connection from this device only. It does not revoke this device on your Mac. To remove Mac-side access, open BOS → Settings → Phone and remove it there.")
        }
    }

    /// Our copy, except for `.offline`, whose text the computer itself sent and
    /// which is shown exactly as it arrived.
    private var troubleshootingText: Text {
        switch session.status {
        case .live:
            return Text("This computer is connected and responding normally.")
        case .connecting:
            return Text("BOS is trying the saved connection automatically.")
        case let .offline(reason):
            return Text(verbatim: reason)
        case .unauthorized:
            return Text("This device was removed from the computer. Pair it again to reconnect.")
        case .unpaired:
            return Text("This device is not paired with a computer.")
        }
    }

    private func shortened(_ address: String) -> String {
        guard address.count > 14 else { return address }
        let leadingCount = min(20, max(8, address.count - 8))
        return "\(address.prefix(leadingCount))…\(address.suffix(6))"
    }
}

private extension Session.Status {
    var settingsText: Text {
        switch self {
        case .live: return Text("Connected")
        case .connecting: return Text("Connecting…")
        case .unpaired: return Text("Not paired")
        case .unauthorized: return Text("Needs pairing")
        case .offline: return Text("Offline")
        }
    }
}
