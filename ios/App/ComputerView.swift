// A bot's computer, live.
//
// The harness already screenshots a working bot every few seconds and pushes
// the frame to any client that asked for it. This is that, and nothing more:
// no clicking, no typing, no control. Watching is the useful half on a phone
// — you want to know what it is doing, not to do it yourself on a screen the
// size of a playing card.
//
// Frames are expensive (hundreds of kilobytes of base64 each), so they are
// off unless this view is on screen. `watchScreen` reopens the stream asking
// for them and `stopWatchingScreen` reopens it asking not to; both resume
// from the cursor, so the reconnect costs nothing but a round trip.
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
    @State private var showingBrowser = false
    @State private var previewWaitExpired = false
    @State private var confirmingDesktop = false
    @State private var openingDesktop = false
    @State private var desktopURL: URL?
    @State private var desktopError: String?

    private var frame: ScreenFrame? { session.state.screens[bot.id] }

    /// The latest bot state. Busy alone does not guarantee a screen frame.
    private var current: Bot { session.state.bot(bot.id) ?? bot }

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            if let image = frame.flatMap(\.data).flatMap(UIImage.init(data:)) {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
                    // The desktop is wider than the phone, so it lands as a
                    // letterbox. Pinch-to-zoom would be the obvious next
                    // thing; scaledToFit is the honest starting point.
                    .accessibilityLabel("\(current.name)'s computer")
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
                // Busy is the difference between "the picture is a moment old"
                // and "the picture is however it was left" — worth saying,
                // because a still frame looks identical either way.
                Text(frame == nil ? "No screen" : current.busy == true ? "Preview" : "Idle")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(frame != nil && current.busy == true ? Color.green : Color.secondary)
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
                .background(.ultraThinMaterial)
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
        .navigationDestination(isPresented: $showingBrowser) { BrowserLiveView(bot: bot) }
        .task(id: "\(current.id):\(current.busy == true):\(frame != nil)") {
            previewWaitExpired = false
            guard frame == nil, current.busy == true else { return }
            do { try await Task.sleep(for: .seconds(10)) } catch { return }
            guard frame == nil else { return }
            previewWaitExpired = true
        }
        .onAppear {
            session.watchScreen(of: bot.id)
        }
        .onDisappear {
            session.stopWatchingScreen(of: bot.id)
        }
    }

    private var waiting: some View {
        VStack(spacing: 14) {
            if current.busy == true && !previewWaitExpired {
                ProgressView().tint(.white)
                Text("Waiting for screen activity…").foregroundStyle(.white.opacity(0.7))
            } else {
                Image(systemName: "display").font(.system(size: 30)).foregroundStyle(.white.opacity(0.4))
                Text("No screen activity yet").foregroundStyle(.white.opacity(0.7))
            }
            Text("Computer previews appear when \(current.name) uses a screen. Open the browser to see web pages.")
                .font(.footnote).foregroundStyle(.white.opacity(0.5))
                .multilineTextAlignment(.center).padding(.horizontal, 32)
            if current.remote == nil {
                Button("Open browser") { showingBrowser = true }
                    .buttonStyle(.bordered).tint(.white)
                    .accessibilityIdentifier("preview-open-browser")
            }
        }
        .font(.subheadline)
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
