import SwiftUI
import UIKit
import CompanionCore

private struct DecodedBrowserFrame: @unchecked Sendable {
    let image: UIImage
    let seq: Int
    let width: Int
    let height: Int
}

@MainActor
struct BrowserLiveView: View {
    let bot: Bot
    @EnvironmentObject private var session: Session
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.dismiss) private var dismiss
    @State private var frame: DecodedBrowserFrame?
    @State private var tabs: [BrowserViewerTab] = []
    @State private var viewerId = ""
    @State private var frameClientID: UUID?
    @State private var controlling = false
    @State private var held = false
    @State private var pending = false
    @State private var connected = false
    @State private var frameCurrent = false
    @State private var error: String?
    @State private var accessRequired = false
    @State private var address = ""
    @State private var showingAddress = false
    @State private var showingTabs = false
    @State private var showingChat = false
    @State private var showingKeyboard = false
    @State private var confirmingRestart = false
    @State private var keyboardText = ""
    @State private var actionTask: Task<Void, Never>?
    @State private var attempt = 0
    @State private var generation = UUID()
    @State private var zoom: CGFloat = 1
    @State private var baseZoom: CGFloat = 1
    @State private var pan: CGSize = .zero
    @State private var basePan: CGSize = .zero

    private var domain: String { URL(string: address)?.host ?? "browser" }
    private var status: String {
        if accessRequired { return "access required" }
        if !connected { return error == nil ? "connecting" : frame == nil ? "offline" : "offline · last frame" }
        if held && !controlling { return "another view has control" }
        if !frameCurrent { return "waiting for a frame" }
        if controlling { return "your control" }
        return held ? "another view has control" : "watching \(bot.name)"
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                Button { dismiss() } label: { Image(systemName: "chevron.left").frame(width: 44, height: 44) }.accessibilityLabel("Back to chat")
                Button { showingAddress = true } label: {
                    VStack(spacing: 3) {
                        Text(domain).font(.subheadline.weight(.medium)).lineLimit(1)
                        Text(status).font(.caption2).foregroundStyle(.secondary)
                    }.frame(maxWidth: .infinity)
                }.disabled(!connected)
                Menu {
                    Button("reconnect view") { attempt += 1 }
                    Button("reload page") { schedule(.reload) }.disabled(!controlling || pending)
                    Button("fit page") { resetTransform() }
                    Button("type in page") { showingKeyboard = true }.disabled(!controlling || pending)
                    Button("restart browser session", role: .destructive) { confirmingRestart = true }.disabled(!connected || pending)
                } label: { Image(systemName: "ellipsis").frame(width: 44, height: 44) }.accessibilityLabel("Browser options")
            }.padding(.horizontal, 8).glassSheet(cornerRadius: 18)
            GeometryReader { geometry in
                ZStack {
                    Color.black
                    if let frame {
                        Image(uiImage: frame.image).resizable().scaledToFit()
                            .scaleEffect(zoom).offset(pan)
                            .opacity(connected && frameCurrent ? 1 : 0.55)
                            .accessibilityLabel("Live browser page")
                            .frame(width: geometry.size.width, height: geometry.size.height)
                            .contentShape(Rectangle())
                            .gesture(MagnificationGesture().onChanged { value in
                                guard !controlling else { return }; zoom = min(max(baseZoom * value, 1), 4)
                            }.onEnded { _ in baseZoom = zoom })
                            .simultaneousGesture(DragGesture(minimumDistance: 10).onChanged { value in
                                if !controlling && zoom > 1 { pan = CGSize(width: basePan.width + value.translation.width, height: basePan.height + value.translation.height) }
                            }.onEnded { value in
                                if controlling, frameCurrent, let point = pagePoint(value.startLocation, size: geometry.size, frame: frame) {
                                    schedule(.scroll(seq: frame.seq, x: point.x, y: point.y, deltaX: -Double(value.translation.width), deltaY: -Double(value.translation.height)))
                                } else { basePan = pan }
                            })
                            .simultaneousGesture(SpatialTapGesture().onEnded { value in
                                guard controlling, frameCurrent, let point = pagePoint(value.location, size: geometry.size, frame: frame) else { return }
                                schedule(.tap(seq: frame.seq, x: point.x, y: point.y))
                            })
                    } else {
                        VStack(spacing: 16) {
                            Image(systemName: "globe").font(.system(size: 36)).foregroundStyle(.white.opacity(0.35))
                            if error == nil { ProgressView().tint(.white) }
                            Text(error == nil ? "Opening the live browser…" : accessRequired ? "Computer access needed" : "Browser unavailable").font(.subheadline).foregroundStyle(.white.opacity(0.65))
                        }
                    }
                }.clipped()
            }
            if let error {
                VStack(spacing: 10) {
                    Text(error).font(.caption).foregroundStyle(.secondary).multilineTextAlignment(.center)
                    Button("Reconnect browser") { attempt += 1 }.buttonStyle(.bordered)
                }.padding(12).frame(maxWidth: .infinity)
            }
            HStack(spacing: 8) {
                Button { schedule(.back) } label: { Image(systemName: "chevron.left").frame(width: 44, height: 44) }.disabled(!controlling || pending).accessibilityLabel("Browser back")
                Button { schedule(.forward) } label: { Image(systemName: "chevron.right").frame(width: 44, height: 44) }.disabled(!controlling || pending).accessibilityLabel("Browser forward")
                Spacer(minLength: 0)
                Button { showingTabs = true } label: { Image(systemName: "square.on.square").frame(width: 44, height: 44).overlay(alignment: .topTrailing) { Text("\(tabs.count)").font(.caption2).padding(4) } }.accessibilityLabel("Browser tabs")
                Button { showingChat = true } label: { Image(systemName: "bubble.left").frame(width: 44, height: 44) }.accessibilityLabel("Open chat sheet")
                Button {
                    schedule(controlling ? .release : .take) { resetTransform() }
                } label: {
                    if pending { ProgressView().frame(width: 100, height: 44) }
                    else { Text(controlling ? "give back" : "take control").font(.caption.weight(.semibold)).padding(.horizontal, 12).frame(minHeight: 44) }
                }.buttonStyle(.bordered).disabled(!connected || !frameCurrent || pending || (held && !controlling))
            }.padding(.horizontal, 12).glassSheet(cornerRadius: 18)
        }
        .navigationBarBackButtonHidden(true).toolbar(.hidden, for: .navigationBar)
        .sheet(isPresented: $showingTabs) {
            NavigationStack {
                List {
                    ForEach(tabs) { tab in
                        HStack {
                            Button {
                                guard controlling else { return }
                                schedule(.selectTab(tab.tabId)) { showingTabs = false; resetTransform() }
                            } label: {
                                VStack(alignment: .leading, spacing: 5) {
                                    Text(tab.title.isEmpty ? "New tab" : tab.title).font(.body).lineLimit(1)
                                    Text(URL(string: tab.url)?.host ?? tab.url).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                                }.frame(maxWidth: .infinity, alignment: .leading)
                            }.disabled(!controlling || pending)
                            if tab.active { Image(systemName: "checkmark").foregroundStyle(.secondary) }
                            Button { schedule(.closeTab(tab.tabId)) } label: { Image(systemName: "xmark").frame(width: 44, height: 44) }.disabled(!controlling || pending).accessibilityLabel("Close \(tab.title)")
                        }.buttonStyle(.borderless)
                    }
                    if !controlling { Text("Take control to switch tabs. Watching keeps \(bot.name)'s page unchanged.").font(.caption).foregroundStyle(.secondary) }
                }.navigationTitle("browser tabs").toolbar {
                    ToolbarItem(placement: .topBarLeading) { Button("done") { showingTabs = false } }
                    ToolbarItem(placement: .topBarTrailing) { Button { schedule(.newTab) } label: { Image(systemName: "plus") }.disabled(!controlling || pending) }
                }
            }.presentationDetents([.medium, .large])
        }
        .sheet(isPresented: $showingChat) {
            NavigationStack { ChatView(chat: .bot(bot), onClose: { showingChat = false }) }
                .safeAreaInset(edge: .top) {
                    if controlling { HStack { Text("you have browser control").font(.caption); Spacer(); Button("give back") { schedule(.release) } }.padding(12).glassSheet(cornerRadius: 18) }
                }
                .presentationDetents([.medium, .large]).presentationDragIndicator(.visible)
        }
        .alert("Open a page", isPresented: $showingAddress) {
            TextField("Search or enter an address", text: $address).textInputAutocapitalization(.never).autocorrectionDisabled()
            Button("cancel", role: .cancel) {}
            if controlling { Button("go") { schedule(.navigate(navigationURL(address))) } }
        } message: { if !controlling { Text("Take control to navigate this session.") } }
        .alert("Type in the focused page field", isPresented: $showingKeyboard) {
            TextField("Text", text: $keyboardText)
            Button("cancel", role: .cancel) { keyboardText = "" }
            Button("type") { let text = keyboardText; keyboardText = ""; schedule(.text(text)) }
            Button("enter") { keyboardText = ""; schedule(.enter) }
        } message: { Text("Tap the page field first. Use the website's sign-in flow for passwords.") }
        .confirmationDialog("Restart this browser session?", isPresented: $confirmingRestart, titleVisibility: .visible) {
            Button("restart browser", role: .destructive) { schedule(.restart) { attempt += 1 } }
        } message: { Text("This closes its open pages. Active bot work must finish first.") }
        .onDisappear { invalidate() }
        .onChange(of: scenePhase) { _, phase in if phase != .active { invalidate() } }
        .task(id: "\(session.browserClient?.instanceID.uuidString ?? "none"):\(session.connection?.id ?? "none"):\(session.credentialEntryResetGeneration):\(scenePhase == .active):\(attempt)") {
            guard scenePhase == .active else { connected = false; controlling = false; return }
            await observe()
        }
    }

    private func resetTransform() { zoom = 1; baseZoom = 1; pan = .zero; basePan = .zero }
    private func pagePoint(_ point: CGPoint, size: CGSize, frame: DecodedBrowserFrame) -> (x: Double, y: Double)? {
        let scale = min(size.width / CGFloat(frame.width), size.height / CGFloat(frame.height))
        guard scale > 0 else { return nil }
        let x = (point.x - (size.width - CGFloat(frame.width) * scale) / 2) / scale
        let y = (point.y - (size.height - CGFloat(frame.height) * scale) / 2) / scale
        guard x >= 0, y >= 0, x < CGFloat(frame.width), y < CGFloat(frame.height) else { return nil }
        return (Double(x), Double(y))
    }
    private func navigationURL(_ value: String) -> String {
        let text = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if let url = URL(string: text), ["http", "https"].contains(url.scheme ?? "") { return url.absoluteString }
        if !text.contains(" "), text.contains("."), !text.contains(":") { return "https://\(text)" }
        return "https://www.google.com/search?q=\(text.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed.subtracting(CharacterSet(charactersIn: "&+=?#"))) ?? "")"
    }
    private func invalidate() {
        generation = UUID(); actionTask?.cancel(); actionTask = nil
        viewerId = ""; controlling = false; held = false; connected = false; frameCurrent = false; pending = false
    }
    private func schedule(_ action: BrowserViewerAction, onSuccess: @escaping @MainActor () -> Void = {}) {
        guard let client = session.browserClient, !viewerId.isEmpty, connected, !pending, scenePhase == .active else { return }
        // Capture before scheduling: a gesture never adopts the next viewer.
        let id = viewerId, token = generation, clientID = client.instanceID
        pending = true
        actionTask = Task { @MainActor in
            defer { if generation == token { pending = false; actionTask = nil } }
            guard !Task.isCancelled, generation == token, viewerId == id, scenePhase == .active, session.browserClient?.instanceID == clientID else { return }
            do {
                try await client.browserAction(botId: bot.id, viewerId: id, action: action)
                guard !Task.isCancelled, generation == token, session.browserClient?.instanceID == clientID else { return }
                onSuccess()
            } catch { if !Task.isCancelled && generation == token {
                self.error = error.localizedDescription
                if case APIError.status(code: 403, message: _) = error { accessRequired = true }
            } }
        }
    }
    private func observe() async {
        invalidate()
        let token = generation
        if frameClientID != session.browserClient?.instanceID {
            frame = nil; tabs = []; address = ""; resetTransform()
        }
        frameClientID = session.browserClient?.instanceID
        error = nil; accessRequired = false
        guard let client = session.browserClient else { error = "Connect to your computer first."; return }
        do {
            for try await event in try client.browserEvents(botId: bot.id) {
                try Task.checkCancellation()
                guard generation == token else { return }
                let data = event.payload
                switch event.name {
                case "ready": viewerId = data.viewerId ?? ""; connected = !viewerId.isEmpty
                case "control":
                    controlling = data.controlling == true; held = data.held == true
                    if held && !controlling { frame = nil; tabs = []; address = "" }
                case "tabs": tabs = data.tabs ?? []; address = tabs.first(where: \.active)?.url ?? address
                case "url": address = data.url ?? address
                case "frame":
                    guard let seq = data.seq, let encoded = data.data, let size = data.metadata else { continue }
                    let frameViewer = viewerId
                    let decoded = await Task.detached(priority: .userInitiated) { () -> DecodedBrowserFrame? in
                        guard let bytes = Data(base64Encoded: encoded), let image = UIImage(data: bytes), Int(image.size.width * image.scale) <= 8192, Int(image.size.height * image.scale) <= 8192, image.size.width * image.size.height * image.scale * image.scale <= 16_777_216 else { return nil }
                        return DecodedBrowserFrame(image: image.preparingForDisplay() ?? image, seq: seq, width: size.deviceWidth, height: size.deviceHeight)
                    }.value
                    try Task.checkCancellation()
                    guard generation == token else { return }
                    guard let decoded else { throw APIError.transport("The browser frame could not be decoded.") }
                    frame = decoded; frameCurrent = true
                    // The displayed frame is already current. ACK paces the next
                    // network frame; it must never dim this one or disable controls.
                    // Yield to SwiftUI before asking for the next paced frame.
                    await Task.yield()
                    try Task.checkCancellation()
                    guard generation == token, viewerId == frameViewer else { return }
                    try await client.browserAction(botId: bot.id, viewerId: frameViewer, action: .acknowledge(seq))
                    guard generation == token, viewerId == frameViewer else { return }
                    frameCurrent = true
                case "error": throw APIError.transport(data.message ?? "The browser connection was interrupted.")
                default: break
                }
            }
        } catch {
            if !Task.isCancelled && generation == token {
                self.error = error.localizedDescription
                if case APIError.status(code: 403, message: _) = error { accessRequired = true }
            }
        }
        if generation == token { viewerId = ""; connected = false; frameCurrent = false; controlling = false; pending = false }
    }
}
