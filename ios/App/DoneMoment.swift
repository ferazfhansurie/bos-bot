// The moment a thread is marked done.
//
// Every done action plays the same beat: one success tap, a small disc in
// the bot's colour pops on with a squash, its check draws itself, and the
// bot's eyes go to happy arcs while the row settles. About half a second of
// motion, never in the way of the next tap. Reduce motion keeps the tap and
// a plain fade of the finished check.
import SwiftUI

/// Which chat-list rows are celebrating a thread just marked done. Shared,
/// so the thread screen can mark done, go back, and the list plays it.
@MainActor @Observable final class DoneMoments {
    static let shared = DoneMoments()

    /// Chat ids whose row shows the check right now.
    private(set) var showing = Set<String>()

    /// Starts the row's moment, after `delay` so a closing menu or a pop
    /// back to the list doesn't hide it.
    func celebrate(_ id: String, after delay: Double = 0) {
        Task { @MainActor in
            if delay > 0 { try? await Task.sleep(for: .seconds(delay)) }
            withAnimation(.spring(response: 0.3, dampingFraction: 0.7)) { _ = showing.insert(id) }
            try? await Task.sleep(for: .seconds(1.1))
            withAnimation(.easeOut(duration: 0.25)) { _ = showing.remove(id) }
        }
    }
}

/// A disc in the bot's colour whose check draws itself as it lands.
struct DoneCheck: View {
    var color: Color
    var size: CGFloat = 22
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var drawn = false
    @State private var landed = 0

    var body: some View {
        ZStack {
            Circle().fill(color)
            CheckStroke()
                .trim(from: 0, to: drawn ? 1 : 0)
                .stroke(.white, style: StrokeStyle(lineWidth: max(2, size * 0.13), lineCap: .round, lineJoin: .round))
                .padding(size * 0.28)
        }
        .frame(width: size, height: size)
        .keyframeAnimator(initialValue: Squash(), trigger: landed) { view, s in
            view.scaleEffect(x: s.sx, y: s.sy)
        } keyframes: { _ in
            KeyframeTrack(\.sx) {
                CubicKeyframe(0.35, duration: 0.01)
                SpringKeyframe(1.18, duration: 0.16, spring: .snappy)
                CubicKeyframe(0.94, duration: 0.1)
                SpringKeyframe(1, duration: 0.28, spring: .bouncy)
            }
            KeyframeTrack(\.sy) {
                CubicKeyframe(0.35, duration: 0.01)
                SpringKeyframe(0.86, duration: 0.16, spring: .snappy)
                CubicKeyframe(1.08, duration: 0.1)
                SpringKeyframe(1, duration: 0.28, spring: .bouncy)
            }
        }
        .onAppear {
            if reduceMotion { drawn = true; return }
            landed += 1
            withAnimation(.easeOut(duration: 0.22).delay(0.12)) { drawn = true }
        }
        .accessibilityHidden(true)
    }

    private struct Squash { var sx: CGFloat = 1; var sy: CGFloat = 1 }
}

/// A checkmark drawn from its short arm to its long one, so `trim` writes it.
struct CheckStroke: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: rect.minX, y: rect.midY + rect.height * 0.04))
        path.addLine(to: CGPoint(x: rect.minX + rect.width * 0.38, y: rect.maxY - rect.height * 0.08))
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.minY + rect.height * 0.1))
        return path
    }
}
