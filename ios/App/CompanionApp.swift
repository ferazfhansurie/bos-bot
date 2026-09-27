// App entry, and the one place that decides when the event stream lives.
//
// A phone is not a desktop: the stream is torn down the moment the app
// leaves the screen's short background grace period, because iOS is going to
// suspend it anyway and doing it deliberately means the cursor is written
// down at a known point. Coming back asks the harness what was missed rather
// than asking for everything.
import SwiftUI
import CompanionCore
import UserNotifications

final class PushAppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let token = deviceToken.map { String(format: "%02x", $0) }.joined()
        UserDefaults.standard.set(token, forKey: "bos.apnsToken")
        Task { @MainActor in NotificationCoordinator.shared.pushTokenHandler?(token) }
    }
}

@main
struct CompanionApp: App {
    @UIApplicationDelegateAdaptor(PushAppDelegate.self) private var pushDelegate
    @StateObject private var session = Session()
    @Environment(\.scenePhase) private var scenePhase
    @State private var liveActivities = LiveActivityCoordinator()
    @AppStorage(PrefKey.language) private var language = AppLanguage.system.rawValue
    @AppStorage(PrefKey.appearance) private var appearance = AppAppearance.system.rawValue
    @AppStorage(PrefKey.theme) private var theme = AppTheme.midnight.rawValue
    @AppStorage(PrefKey.themeApplied) private var themeApplied = AppTheme.midnight.rawValue

    init() {
        ThemeSurfaces.install()
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(session)
                .preferredColorScheme(AppAppearance(rawValue: appearance)?.colorScheme)
                .tint((AppTheme(rawValue: theme) ?? .midnight).accent)
                // One modifier is the whole language seam. SwiftUI resolves a
                // `LocalizedStringKey` against the environment's locale, so
                // every `Text("…")`, `Button("…")`, `Section("…")` and
                // `navigationTitle("…")` already in the app — including the
                // ones inside sheets and pushed screens — follows this line
                // without a call site changing. Following the system means
                // leaving it on the phone's own locale, which is what an app
                // with no language setting would use anyway.
                .environment(\.locale, AppLanguage.resolved(language).locale ?? .autoupdatingCurrent)
                // A navigation title is drawn by UIKit, which reads its string
                // once and does not re-read it when the environment changes —
                // so the body would switch language while the title above it
                // stayed behind. Re-identifying the tree on the chosen language
                // rebuilds that chrome. It costs the navigation stack and any
                // view state below, which is the right trade for something a
                // person changes deliberately and almost never. `session` lives
                // on the App, not here, so the connection survives.
                // A theme lives in UIKit's background colours, which views
                // resolve once; the appearance screen commits a new one on
                // the way out, and re-identifying here repaints everything.
                .id("\(language)|\(themeApplied)")
                .onAppear {
                    OpenMausSharedInbox.removeDirectories(olderThan: 60 * 60)
                    session.connect()
                    liveActivities.attach(to: session)
                }
                .onOpenURL { session.receivePairingURL($0) }
                .onChange(of: scenePhase) { _, phase in
                    switch phase {
                    case .active:
                        OpenMausSharedInbox.removeDirectories(olderThan: 60 * 60)
                        session.connect()
                        Task { await session.refreshNotificationAuthorization() }
                    case .background: session.linger()
                    case .inactive: break
                    @unknown default: break
                    }
                }
        }
        .defaultSize(CompanionLayout.defaultWindowSize)
    }
}

struct RootView: View {
    @EnvironmentObject private var session: Session
    @AppStorage("companion.onboarding.introSeen") private var hasSeenIntro = false
    @State private var showingIntro = false
    @AppStorage("companion.onboarding.welcomeSeen") private var hasSeenWelcome = false
    @AppStorage("companion.onboarding.notificationsSeen") private var hasSeenNotificationPrompt = false
    @AppStorage(CompanionOnboardingPreferences.pendingNotificationOnboardingKey)
    private var notificationOnboardingPending = false
    var body: some View {
        Group {
            if session.isRestoringSavedPairing {
                ProgressView("Restoring your saved Mac connection…")
            } else {
            switch route {
            case .welcome:
                CompanionWelcomeView(
                    onConnect: startPairing,
                    onSkip: {
                        hasSeenWelcome = true
                        session.endPairing()
                    }
                )
            case .pairing:
                PairingView {
                    hasSeenWelcome = true
                    session.endPairing()
                }
                .onAppear {
                    hasSeenWelcome = true
                    session.beginPairing()
                }
            case .unpairedHome:
                UnpairedHomeView(onConnect: startPairing)
            case .notificationPrompt:
                NotificationOnboardingView {
                    hasSeenNotificationPrompt = true
                    notificationOnboardingPending = false
                    session.endPairing()
                }
                .onAppear { hasSeenWelcome = true }
            case .chats:
                ChatListView()
                    .onAppear {
                        hasSeenWelcome = true
                        // This is either an existing pairing or a new pairing
                        // which needed no notification education. Do not let
                        // a later voluntary unpair reopen Pairing by itself.
                        session.endPairing()
                        reconcileNotificationOnboarding()
                    }
            case .revoked:
                UnpairedView(
                    onPairAgain: {
                        session.signOut()
                        startPairing()
                    },
                    onChooseAnother: session.connections.first(where: {
                        $0.id != session.connection?.id
                    }).map { computer in
                        { session.switchComputer(to: computer.id) }
                    }
                )
            }
        }
        }
        .background(Color(uiColor: .systemBackground).ignoresSafeArea())
        .overlay {
            if showingIntro {
                FirstLaunchIntro()
                    .transition(.opacity)
                    .zIndex(1)
            }
        }
        .task {
            guard !hasSeenIntro,
                  !ProcessInfo.processInfo.arguments.contains("-store-preview") else { return }
            hasSeenIntro = true
            showingIntro = true
            try? await Task.sleep(for: .seconds(1.8))
            withAnimation(.easeInOut(duration: 0.45)) { showingIntro = false }
        }
        .onChange(of: session.pairingInvite) { _, invite in
            guard invite != nil else { return }
            hasSeenWelcome = true
            session.beginPairing()
        }
        .onAppear { reconcileNotificationOnboarding() }
        .onChange(of: session.notificationAuthorizationResolved) { _, _ in
            reconcileNotificationOnboarding()
        }
        .onChange(of: session.notificationAuthorization) { _, _ in
            reconcileNotificationOnboarding()
        }
        .onChange(of: notificationOnboardingPending) { _, isPending in
            if isPending { reconcileNotificationOnboarding() }
        }
        .alert(
            "Something went wrong",
            isPresented: Binding(
                get: { session.actionError != nil },
                set: { if !$0 { session.actionError = nil } }
            ),
            presenting: session.actionError
        ) { _ in
            Button("OK", role: .cancel) { session.actionError = nil }
        } message: { message in
            Text(message)
        }
    }

    private var route: CompanionOnboardingRoute {
        let pairingState: CompanionPairingState
        if session.status == .unauthorized {
            pairingState = .revoked
        } else if session.connection != nil {
            pairingState = .paired
        } else {
            pairingState = .unpaired
        }
        return CompanionOnboardingRouter.route(for: .init(
            pairingState: pairingState,
            hasSeenWelcome: hasSeenWelcome,
            pairingRequested: session.pairingRequested,
            hasPendingPairingInvite: session.pairingInvite != nil,
            notificationOnboardingPending: notificationOnboardingPending,
            hasSeenNotificationPrompt: hasSeenNotificationPrompt,
            notificationAuthorization: notificationAuthorizationState
        ))
    }

    private var notificationAuthorizationState: CompanionNotificationAuthorizationState {
        #if DEBUG
        // Store-preview runs are deterministic screenshot fixtures, not a
        // first pairing, and must keep landing on the requested chat surface.
        if ProcessInfo.processInfo.arguments.contains("-store-preview") { return .determined }
        #endif
        guard session.notificationAuthorizationResolved else { return .unresolved }
        return session.notificationAuthorization == .notDetermined ? .notDetermined : .determined
    }

    private func reconcileNotificationOnboarding() {
        notificationOnboardingPending = CompanionNotificationOnboardingPolicy.shouldKeepPending(
            isPending: notificationOnboardingPending,
            hasCompletedStep: hasSeenNotificationPrompt,
            authorization: notificationAuthorizationState
        )
    }

    private func startPairing() {
        hasSeenWelcome = true
        session.beginPairing()
    }
}

private struct FirstLaunchIntro: View {
    @Environment(\.colorScheme) private var colorScheme
    @State private var appeared = false

    var body: some View {
        ZStack {
            Color(uiColor: .systemBackground).ignoresSafeArea()
            VStack(spacing: 18) {
                ZStack {
                    Circle()
                        .fill(Color.blue.opacity(0.12))
                        .frame(width: 112, height: 112)
                    Image(systemName: "bubble.left.and.bubble.right.fill")
                        .font(.system(size: 42, weight: .medium))
                        .foregroundStyle(.blue)
                        .symbolRenderingMode(.hierarchical)
                }
                .scaleEffect(appeared ? 1 : 0.82)
                Text("BOS")
                    .font(.system(size: 43, weight: .bold, design: .rounded))
                    .tracking(-1.5)
                    .foregroundStyle(.primary)
                Text("Your bots, closer.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            .opacity(appeared ? 1 : 0)
            .offset(y: appeared ? 0 : 12)

            VStack {
                Spacer()
                Text("Created by OpenMausBot")
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(.secondary)
                    .padding(.bottom, 32)
            }
            .opacity(appeared ? 1 : 0)
        }
        .onAppear {
            withAnimation(.spring(response: 0.7, dampingFraction: 0.82)) {
                appeared = true
            }
        }
        .accessibilityElement(children: .combine)
    }
}

/// The token stopped working. Almost always because someone revoked this
/// phone on the computer — which is exactly what that button is for, so the
/// honest thing is to say so and offer to pair again.
struct UnpairedView: View {
    let onPairAgain: () -> Void
    let onChooseAnother: (() -> Void)?

    var body: some View {
        NavigationStack {
            ContentUnavailableView {
                Label("This device was unpaired", systemImage: "lock.slash")
            } description: {
                Text("The connection was removed on your computer. Pair again to keep using your chats here.")
            } actions: {
                Button("Pair again", action: onPairAgain)
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                if let onChooseAnother {
                    Button("Use another computer", action: onChooseAnother)
                        .buttonStyle(.bordered)
                        .controlSize(.large)
                }
            }
        }
    }
}
