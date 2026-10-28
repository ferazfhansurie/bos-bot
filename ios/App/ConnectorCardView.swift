// The phone's copy of the desktop connector card (src/components/ConnectorCard.tsx):
// a bot asked for an app mid-task. Connect opens the app's sign-in page,
// the card polls until the computer sees the connection (the server patches
// the message and continues the task), and in 3.0 offers three things to ask
// for next, each sent once as the person.
import CompanionCore
import SwiftUI
import UIKit

struct ConnectorCardView: View {
    let chat: Chat
    let message: Message
    let connector: ConnectorCardData
    @EnvironmentObject private var session: Session
    @Environment(\.smartUIThread) private var thread
    @Environment(\.smartUIV3) private var v3
    @Environment(\.scenePhase) private var scenePhase
    @State private var busy = false
    @State private var localError: String?
    @State private var pendingURL: URL?
    @State private var nativeWhatsApp = false
    @State private var sent: [String] = []

    private var tint: Color { MausPalette.color(message.from?.color ?? chat.color) }
    private var connected: Bool { connector.status == .connected }
    private var botId: String? {
        switch chat {
        case let .bot(bot): bot.id
        case .room: message.from?.botId
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .center, spacing: 11) {
                logo
                VStack(alignment: .leading, spacing: 3) {
                    Text(connector.label)
                        .font(.system(size: 15, weight: .semibold))
                    Text(connector.detail(v3: v3))
                        .font(.system(size: 13))
                        .foregroundStyle(Color.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
                if !connected {
                    Button { dismiss() } label: {
                        Image(systemName: "xmark")
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(Color.secondary)
                            .frame(width: 28, height: 28)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Not now")
                }
            }

            primary

            if nativeWhatsApp && !connected {
                Label("WhatsApp links with a QR code on your computer. Open BOS there and scan it with this phone.", systemImage: "desktopcomputer")
                    .font(.system(size: 13))
                    .foregroundStyle(Color.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if let error = visible(localError) ?? (connector.status == .failed ? visible(connector.error) : nil) {
                Label(error, systemImage: "exclamationmark.triangle.fill")
                    .font(.system(size: 12.5))
                    .foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
            }

            let actions = connector.afterConnectActions(v3: v3)
            if !actions.isEmpty {
                VStack(alignment: .leading, spacing: 7) {
                    Text("What I can do now")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(Color.secondary)
                    ForEach(actions, id: \.self) { action in
                        let done = sent.contains(action)
                        Button {
                            guard !done, let thread else { return }
                            sent.append(action)
                            thread.send(action)
                        } label: {
                            HStack(spacing: 8) {
                                Text(action)
                                    .font(.system(size: 14))
                                    .multilineTextAlignment(.leading)
                                    .fixedSize(horizontal: false, vertical: true)
                                Spacer(minLength: 0)
                                Image(systemName: done ? "checkmark" : "arrow.up.circle.fill")
                                    .foregroundStyle(done ? Color.secondary : tint)
                            }
                            .padding(.horizontal, 12)
                            .padding(.vertical, 9)
                            .background(tint.opacity(done ? 0.04 : 0.09), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                        }
                        .buttonStyle(.plain)
                        .disabled(done || thread == nil)
                        .opacity(done ? 0.6 : 1)
                    }
                }
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .fill(Color.secondary.opacity(0.09))
        )
        .overlay {
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .strokeBorder(connected ? Color.clear : tint.opacity(0.65), lineWidth: 1.25)
        }
        .task(id: connector.status) { await pollWhileAuthorizing() }
        .onChange(of: scenePhase) { _, phase in
            // back from the sign-in page: look once straight away
            if phase == .active, connector.status == .authorizing { Task { _ = await checkStatus() } }
        }
    }

    private var logo: some View {
        let url = URL(string: "https://logos.composio.dev/api/\(connector.slug.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? connector.slug)")
        return AsyncImage(url: url) { phase in
            if let image = phase.image {
                image.resizable().scaledToFit().padding(6)
            } else {
                Image(systemName: "link")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(tint)
            }
        }
        .frame(width: 40, height: 40)
        .background(Color(uiColor: .systemBackground).opacity(0.7), in: RoundedRectangle(cornerRadius: 11, style: .continuous))
        .accessibilityHidden(true)
    }

    @ViewBuilder
    private var primary: some View {
        if connected {
            if connector.resumed == true {
                Label("Connected", systemImage: "checkmark.circle.fill")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(.green)
            } else {
                Button { Task { await resume() } } label: {
                    Text("Continue task").frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .tint(tint)
                .disabled(busy)
            }
        } else if let pendingURL {
            HStack(spacing: 8) {
                Button { UIApplication.shared.open(pendingURL) } label: {
                    Text("Continue").frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .tint(tint)
                if connector.status == .authorizing {
                    ProgressView().controlSize(.small)
                }
            }
        } else {
            Button { Task { await connect() } } label: {
                HStack(spacing: 6) {
                    if busy { ProgressView().controlSize(.small) }
                    Text(connectLabel)
                }
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .tint(tint)
            .disabled(busy || botId == nil)
        }
    }

    private var connectLabel: String {
        switch connector.status {
        case .failed: return "Try again"
        case .authorizing: return "Open again"
        default: return v3 && connector.reconnect == true ? "Reconnect" : "Connect"
        }
    }

    private func visible(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }

    private func connect() async {
        guard let botId else { return }
        busy = true
        localError = nil
        defer { busy = false }
        do {
            switch try await session.authorizeConnectorCard(botId: botId, threadId: chat.threadId, messageId: message.id) {
            case let .signIn(url):
                pendingURL = url
                await UIApplication.shared.open(url)
            case .native:
                nativeWhatsApp = true
            }
        } catch {
            localError = error.localizedDescription
        }
    }

    private func resume() async {
        guard let botId else { return }
        busy = true
        localError = nil
        defer { busy = false }
        do { try await session.resumeConnectorCard(botId: botId, threadId: chat.threadId, messageId: message.id) }
        catch { localError = error.localizedDescription }
    }

    private func dismiss() {
        guard let botId else { return }
        Task { try? await session.dismissConnectorCard(botId: botId, threadId: chat.threadId, messageId: message.id) }
    }

    /// Asks the computer whether the app is connected; on yes the server
    /// patches this message, which redraws the card.
    private func checkStatus() async -> Bool {
        guard let botId else { return false }
        return (try? await session.connectorCardStatus(botId: botId, threadId: chat.threadId, messageId: message.id).connected) ?? false
    }

    /// Same budget as the desktop: every 4s, at most 75 tries (5 minutes).
    private func pollWhileAuthorizing() async {
        guard connector.status == .authorizing, connector.dismissed != true else { return }
        for _ in 0..<75 {
            try? await Task.sleep(for: .seconds(4))
            if Task.isCancelled { return }
            if await checkStatus() { return }
        }
    }
}
