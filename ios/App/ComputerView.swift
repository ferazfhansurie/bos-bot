import SwiftUI
import CompanionCore
// Unconditional for the same reason as ChatView: `UIImage` is used below
// without a guard, so a conditional import would only change which error a
// non-UIKit build fails with.
import UIKit

struct ComputerView: View {
    let bot: Bot
    @EnvironmentObject private var session: Session
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @State private var showingBrowser = false
    @State private var showingComputerPicker = false
    @State private var image: UIImage?
    @State private var previewError: String?
    @State private var connected = false
    @State private var loading = true
    @State private var surface = ""
    @State private var attempt = 0
    @State private var generation = UUID()
    @State private var confirmingDesktop = false
    @State private var openingDesktop = false
    @State private var desktopURL: URL?
    @State private var desktopError: String?

    /// The latest bot state. Busy alone does not guarantee a screen frame.
    private var current: Bot { session.state.bot(bot.id) ?? bot }

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
                    .accessibilityLabel("Live computer preview")
                    .opacity(connected ? 1 : 0.55)
            } else {
                waiting
            }
        }
        .navigationTitle(current.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                if bot.remote == nil { Button { showingBrowser = true } label: { Image(systemName: "globe") }.accessibilityLabel("Open live browser") }
            }
            ToolbarItem(placement: .topBarTrailing) {
                if !bot.isRemote {
                    Button { showingComputerPicker = true } label: {
                        Image(systemName: "arrow.triangle.swap")
                    }
                    .accessibilityLabel("Switch computer")
                    .accessibilityIdentifier("switch-thread-computer")
                }
            }
            ToolbarItem(placement: .topBarTrailing) {
                // Busy is the difference between "the picture is a moment old"
                // and "the picture is however it was left" — worth saying,
                // because a still frame looks identical either way.
                Text(connected ? "watching" : image == nil ? "connecting" : "offline · last frame")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(.secondary)
            }
        }
        .safeAreaInset(edge: .bottom) {
            // A VPS-backed bot is "cloud" too, but the server refuses to mint
            // an interactive desktop for it — no button beats a dead one. An
            // older harness never sends cloudBackend, so nil keeps the button.
            // Minting a desktop session is admin-only on a server, too.
            if current.computer == "cloud" && current.cloudBackend != "vps" && session.canAdminister {
                VStack(spacing: 8) {
                    if let desktopError {
                        Text(desktopError)
                            .font(.footnote)
                            .foregroundStyle(.red)
                            .multilineTextAlignment(.center)
                    }
                    Button {
                        confirmingDesktop = true
                    } label: {
                        if openingDesktop {
                            ProgressView()
                                .tint(.white)
                                .frame(maxWidth: .infinity)
                        } else {
                            Label("Open live cloud desktop", systemImage: "display")
                                .frame(maxWidth: .infinity)
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(openingDesktop)
                    Text("Interactive VNC session. Access must be enabled for this device in the Mac's Phone settings.")
                        .font(.caption)
                        .foregroundStyle(Color.white.opacity(0.6))
                        .multilineTextAlignment(.center)
                }
                .padding(.horizontal, 18)
                .padding(.vertical, 12)
                .glassSheet(cornerRadius: 18)
            }
        }
        .alert("Open live cloud desktop?", isPresented: $confirmingDesktop) {
            Button("Cancel", role: .cancel) {}
            Button("Open desktop") { Task { await openDesktop() } }
        } message: {
            Text("This gives this device full control of the cloud computer, including anything signed in inside it.")
        }
        .sheet(
            isPresented: Binding(
                get: { desktopURL != nil },
                set: { if !$0 { desktopURL = nil } }
            )
        ) {
            if let desktopURL {
                CloudDesktopBrowser(url: desktopURL)
                    .ignoresSafeArea()
            }
        }
        .sheet(isPresented: $showingComputerPicker, onDismiss: { attempt += 1 }) {
            NavigationStack {
                Form { BotComputerSettings(bot: bot) }
                    .navigationTitle("Switch computer")
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .confirmationAction) {
                            Button("Done") { showingComputerPicker = false }
                        }
                    }
            }
            .presentationDetents([.medium, .large])
        }
        .navigationDestination(isPresented: $showingBrowser) { BrowserLiveView(bot: bot) }
        .safeAreaInset(edge: .bottom) {
            if let previewError {
                VStack(spacing: 8) {
                    Text(previewError).font(.caption).foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                    Button("Reconnect computer") { attempt += 1 }.buttonStyle(.bordered)
                }.padding(12).frame(maxWidth: .infinity).glassSheet(cornerRadius: 18)
            }
        }
        .task(id: "\(session.browserClient?.instanceID.uuidString ?? "none"):\(session.connection?.id ?? "none"):\(session.credentialEntryResetGeneration):\(bot.id):\(bot.threadId):\(scenePhase == .active):\(attempt)") {
            guard scenePhase == .active else { connected = false; return }
            await observe()
        }
        .onDisappear { generation = UUID(); connected = false }

    }

    private var waiting: some View {
        VStack(spacing: 14) {
            if loading {
                ProgressView().tint(.white)
                Text("Opening the live computer…").foregroundStyle(.white.opacity(0.7))
            } else {
                Image(systemName: "display").font(.system(size: 30)).foregroundStyle(.white.opacity(0.4))
                Text(surface == "browser" ? "This conversation is using the browser" : "Computer unavailable")
                    .foregroundStyle(.white.opacity(0.7))
            }
            if current.remote == nil {
                Button("Open browser") { showingBrowser = true }
                    .buttonStyle(.bordered).tint(.white)
                    .accessibilityIdentifier("preview-open-browser")
            }
        }.font(.subheadline)
    }

    @MainActor
    private func observe() async {
        generation = UUID()
        let token = generation
        // Never show another account's cached desktop during reconnect.
        image = nil; previewError = nil; loading = true; connected = false
        guard let client = session.browserClient else {
            loading = false; previewError = "Connect to your computer first."; return
        }
        while !Task.isCancelled, generation == token, scenePhase == .active {
            do {
                let preview = try await client.computerPreview(botId: bot.id, threadId: bot.threadId)
                try Task.checkCancellation()
                let decoded = await Task.detached(priority: .userInitiated) { () -> UIImage? in
                    guard preview.png.utf8.count <= 24 * 1024 * 1024,
                          let bytes = Data(base64Encoded: preview.png), let result = UIImage(data: bytes),
                          result.size.width * result.size.height * result.scale * result.scale <= 16_777_216 else { return nil }
                    return result.preparingForDisplay() ?? result
                }.value
                guard !Task.isCancelled, generation == token,
                      session.browserClient?.instanceID == client.instanceID else { return }
                guard let decoded else { throw APIError.transport("The computer sent an invalid preview.") }
                image = decoded; surface = preview.surface; connected = true; loading = false; previewError = nil
            } catch {
                guard !Task.isCancelled, generation == token,
                      session.browserClient?.instanceID == client.instanceID else { return }
                connected = false; loading = false; previewError = error.localizedDescription
                if case APIError.status(code: 401, message: _) = error { return }
                if case APIError.status(code: 403, message: _) = error { return }
            }
            do { try await Task.sleep(for: .seconds(connected && current.busy == true ? 3 : 10)) }
            catch { return }
        }
    }

    @MainActor
    private func openDesktop() async {
        openingDesktop = true
        desktopError = nil
        defer { openingDesktop = false }
        do {
            desktopURL = try await session.cloudDesktop(for: current)
        } catch {
            desktopError = error.localizedDescription
        }
    }
}
