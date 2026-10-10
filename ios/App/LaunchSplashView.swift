// Cold-launch overlay: the person's own bots, drawn exactly as they are
// everywhere else (flat body, glyph eyes), spring up out of the launch
// screen's black and smile; then the host lifts the squad away as the app
// zooms in underneath (`SplashLift`). Native and system-sprung, so it starts
// on the first frame instead of waiting for a web view, and it holds the app
// for about a second. Connection and deep links run underneath throughout.
import CompanionCore
import SwiftUI

struct LaunchSplashView: View {
    /// The roster on hand at launch (the cached one on a cold start). The
    /// chief stands in the middle; up to two more on each side.
    let bots: [Bot]
    var onFinished: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var shown = false
    @State private var smiling = false

    /// The launch screen's colour, so the hand-off is seamless.
    static let background = Color(red: 13 / 255, green: 13 / 255, blue: 13 / 255)

    private struct Member: Identifiable {
        let id: String
        let color: String
        let bodyId: String?
        /// 0 is the middle; 1 and 2 step outwards.
        let rank: Int
        /// -1 left, 0 middle, 1 right.
        let side: CGFloat
    }

    private var squad: [Member] {
        let visible = bots.filter { $0.hidden != true }
        guard !visible.isEmpty else {
            return [Member(id: "bos", color: "#FFFFFF", bodyId: nil, rank: 0, side: 0)]
        }
        let chief = visible.first { $0.chiefOfStaff == true } ?? visible[0]
        let rest = visible.filter { $0.id != chief.id }.prefix(4)
        var members = [Member(id: chief.id, color: chief.color, bodyId: chief.mascotBody, rank: 0, side: 0)]
        for (i, bot) in rest.enumerated() {
            members.append(Member(id: bot.id, color: bot.color, bodyId: bot.mascotBody,
                                  rank: i / 2 + 1, side: i.isMultiple(of: 2) ? -1 : 1))
        }
        return members
    }

    var body: some View {
        ZStack {
            Self.background.ignoresSafeArea()
            VStack(spacing: 28) {
                ZStack(alignment: .bottom) {
                    // outermost first so the middle one lands on top
                    ForEach(squad.sorted { $0.rank > $1.rank }) { member in face(member) }
                }
                .frame(height: 104, alignment: .bottom)
                Text("BOS")
                    .font(.system(size: 30, weight: .bold))
                    .tracking(-0.5)
                    .foregroundStyle(.white)
                    .opacity(shown ? 1 : 0)
                    .offset(y: shown || reduceMotion ? 0 : 10)
                    .animation(reduceMotion ? .easeOut(duration: 0.2) : .smooth(duration: 0.45).delay(0.22), value: shown)
            }
            .offset(y: -24)
        }
        .accessibilityHidden(true)
        .task { await play() }
    }

    private func face(_ member: Member) -> some View {
        let size: CGFloat = member.rank == 0 ? 96 : member.rank == 1 ? 64 : 48
        let x = member.side * (member.rank == 1 ? 74 : 128)
        // the squad stands on an arc: the middle one tallest, the outer ones
        // a step lower
        let y: CGFloat = member.rank == 0 ? 0 : member.rank == 1 ? -4 : -10
        // outer ones land first, the middle one last, like they make room
        let delay = Double(2 - member.rank) * 0.07
        return GlyphMark(color: member.color, bodyId: member.bodyId,
                         state: smiling && member.rank < 2 ? .happy : .idle,
                         size: size, animated: !reduceMotion)
            .scaleEffect(shown || reduceMotion ? 1 : 0.35, anchor: .bottom)
            .offset(x: x, y: y + (shown || reduceMotion ? 0 : 36))
            .opacity(shown ? 1 : 0)
            .blur(radius: shown || reduceMotion ? 0 : 6)
            .animation(reduceMotion ? .easeOut(duration: 0.2) : .spring(duration: 0.55, bounce: 0.32).delay(delay), value: shown)
    }

    private func play() async {
        shown = true
        try? await Task.sleep(for: .seconds(reduceMotion ? 0.6 : 0.62))
        smiling = true
        try? await Task.sleep(for: .seconds(reduceMotion ? 0.1 : 0.42))
        guard !Task.isCancelled else { return }
        onFinished()
    }
}

/// How the splash leaves: the squad lifts towards you, softens and fades,
/// while the app underneath settles up from 0.94 (`launchReveal`).
struct SplashLift: ViewModifier {
    let active: Bool
    func body(content: Content) -> some View {
        content
            .scaleEffect(active ? 1.12 : 1)
            .blur(radius: active ? 8 : 0)
            .opacity(active ? 0 : 1)
    }
}

extension AnyTransition {
    static var splashLift: AnyTransition {
        UIAccessibility.isReduceMotionEnabled
            ? .opacity
            : .asymmetric(insertion: .identity,
                          removal: .modifier(active: SplashLift(active: true), identity: SplashLift(active: false)))
    }
}

extension Animation {
    /// The splash's exit and the app's zoom-in share one curve.
    static let launchReveal: Animation = .smooth(duration: 0.42)
}
