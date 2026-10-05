// The wide-window layout: the roster as a column, the open chat beside it,
// and — the way the desktop's side panel works — a second chat beside that,
// with a divider the person drags.
//
// Only a regular-width window gets here. A compact one keeps the single
// NavigationStack the phone has always had, so nothing about the phone
// changes. The rules for how wide each part may be live in CompanionCore's
// `SplitPanes`; this file only draws them.
import SwiftUI
import CompanionCore

private struct OpenBesideKey: EnvironmentKey {
    static let defaultValue: ((Chat) -> Void)? = nil
}

extension EnvironmentValues {
    /// Opens a chat in the side pane. Set only where a wide window has room
    /// for two chats, and never inside the side pane itself; nil everywhere
    /// else, which is how a chat or a row knows to leave the option out.
    var openBeside: ((Chat) -> Void)? {
        get { self[OpenBesideKey.self] }
        set { self[OpenBesideKey.self] = newValue }
    }
}

struct SplitChatLayout<Sidebar: View, Primary: View, Side: View>: View {
    /// Whether the primary pane holds a chat, or only its placeholder.
    let chatOpen: Bool
    let sideOpen: Bool
    /// The primary pane's share of the chats' width, as stored. Clamped on
    /// the way out, so a value saved on a wider window is still usable here.
    @Binding var fraction: Double
    let openBeside: (Chat) -> Void
    @ViewBuilder let sidebar: () -> Sidebar
    @ViewBuilder let primary: () -> Primary
    @ViewBuilder let side: () -> Side

    /// The fraction while a finger is on the divider. Committed to storage
    /// when the drag ends rather than on every frame of it.
    @State private var dragFraction: Double?
    @State private var dragStart: Double?

    var body: some View {
        GeometryReader { geo in
            let width = Double(geo.size.width)
            let fits = SplitPanes.fitsTwoPanes(in: width)
            let split = sideOpen && fits
            let showsSidebar = SplitPanes.showsSidebar(in: width, panes: chatOpen ? (split ? 2 : 1) : 0)
            // the sidebar's hairline is a point of its own
            let detail = max(0, width - (showsSidebar ? SplitPanes.sidebarWidth + 1 : 0))
            let panes = SplitPanes.paneWidths(dragFraction ?? fraction, in: detail)
            // The primary pane keeps one place in this stack whatever shows
            // around it, so opening or closing the side never rebuilds the
            // chat already open — its draft and scroll stay where they were.
            HStack(spacing: 0) {
                if showsSidebar {
                    sidebar()
                        .environment(\.openBeside, fits ? openBeside : nil)
                        .frame(width: SplitPanes.sidebarWidth)
                    Rectangle().fill(Color.secondary.opacity(0.22)).frame(width: 1).ignoresSafeArea()
                }
                primary()
                    .environment(\.openBeside, fits ? openBeside : nil)
                    .frame(width: split ? panes.primary : detail)
                if split {
                    handle(width: detail)
                    side()
                        .environment(\.openBeside, nil)
                        .frame(width: panes.side)
                }
            }
        }
    }

    /// A hairline with a grip on it. Drag to share the width differently;
    /// double-tap to go back to even.
    private func handle(width: Double) -> some View {
        let shown = SplitPanes.clamp(dragFraction ?? fraction, in: width)
        return ZStack {
            Rectangle().fill(Color.secondary.opacity(0.22)).frame(width: 1)
            Capsule()
                .fill(Color.secondary.opacity(dragFraction == nil ? 0.35 : 0.7))
                .frame(width: 5, height: 44)
        }
        .frame(width: SplitPanes.handleWidth)
        .frame(maxHeight: .infinity)
        .contentShape(Rectangle())
        .ignoresSafeArea(edges: .bottom)
        // Global, because the handle moves under the finger: a translation
        // measured in its own space would chase itself.
        .gesture(
            DragGesture(minimumDistance: 1, coordinateSpace: .global)
                .onChanged { value in
                    let start = dragStart ?? SplitPanes.clamp(fraction, in: width)
                    dragStart = start
                    dragFraction = SplitPanes.dragged(from: start, by: value.translation.width, in: width)
                }
                .onEnded { _ in
                    if let dragFraction { fraction = dragFraction }
                    dragFraction = nil
                    dragStart = nil
                }
        )
        .onTapGesture(count: 2) {
            Haptics.selection()
            withAnimation(.snappy(duration: 0.25)) { fraction = SplitPanes.defaultFraction }
        }
        .accessibilityElement()
        .accessibilityLabel("Split divider")
        .accessibilityValue("\(Int((shown * 100).rounded())) percent")
        .accessibilityAdjustableAction { direction in
            switch direction {
            case .increment: fraction = SplitPanes.clamp(shown + 0.05, in: width)
            case .decrement: fraction = SplitPanes.clamp(shown - 0.05, in: width)
            @unknown default: break
            }
        }
        .accessibilityAction(named: "Split evenly") { fraction = SplitPanes.defaultFraction }
    }
}

/// "Open in split" for a roster row's context menu — nothing at all where
/// the window has no room for a second chat.
struct OpenBesideButton: View {
    let chat: Chat
    @Environment(\.openBeside) private var openBeside

    var body: some View {
        if let openBeside {
            Button("Open in split", systemImage: "rectangle.split.2x1") { openBeside(chat) }
        }
    }
}

/// The open chat's way to put a second one beside it: every bot and room
/// but the conversation already on screen.
struct OpenBesideMenu: View {
    let current: Chat
    let open: (Chat) -> Void
    @EnvironmentObject private var session: Session

    var body: some View {
        Menu {
            ForEach(choices, id: \.conversationID) { chat in
                Button(chat.name) { open(chat) }
            }
        } label: {
            Image(systemName: "rectangle.split.2x1")
                .font(.system(size: 44 * 0.42, weight: .medium))
                .foregroundStyle(Color.primary)
                .frame(width: 44, height: 44)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .glassCapsule()
        .accessibilityLabel("Open beside")
        .accessibilityIdentifier("open-beside")
    }

    /// Bots open on their home thread, the same one their roster row opens.
    private var choices: [Chat] {
        let bots = session.state.bots.filter { $0.hidden != true }.map { Chat.bot($0.homeThread) }
        let rooms = session.state.rooms.map(Chat.room)
        return (bots + rooms)
            .filter { $0 != current }
            .sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
    }
}
