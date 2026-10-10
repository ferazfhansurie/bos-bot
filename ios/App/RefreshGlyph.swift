// Pull to refresh, the way Instagram does it: the bos mark's outline traces
// itself in as the list comes down, its eyes open with a light tap the
// moment the system arms the refresh, a bright arc chases round the outline
// while it runs, and the mark springs away when it lands.
//
// It lives inside the scroll view's own UIRefreshControl (whose spinner is
// tinted clear), so UIKit keeps placing it in the gap — above a large title,
// under a custom header — and the pull physics and hold stay the system's.
import CompanionCore
import SwiftUI
import UIKit

extension View {
    /// `.refreshable`, drawn with the bos mark instead of the stock spinner.
    func bosRefreshable(_ action: @escaping @Sendable () async -> Void) -> some View {
        modifier(BosRefreshModifier(action: action))
    }
}

private struct BosRefreshModifier: ViewModifier {
    let action: @Sendable () async -> Void
    @State private var model = RefreshGlyphModel()

    func body(content: Content) -> some View {
        content
            .background(RefreshGlyphInstaller(model: model))
            .refreshable { await model.run(action) }
    }
}

@MainActor @Observable final class RefreshGlyphModel {
    enum Phase { case pulling, refreshing, landing }

    /// How much of the outline is drawn while pulling, 0...1.
    var progress: CGFloat = 0
    var phase: Phase = .pulling
    var startedAt = Date()

    /// The pull at which UIRefreshControl fired last time. The outline
    /// finishes exactly there, so the full mark and the tap coincide.
    private static var threshold: CGFloat = 110
    @ObservationIgnored fileprivate var pull: CGFloat = 0

    func run(_ action: @Sendable () async -> Void) async {
        if pull > 40 { Self.threshold = min(180, pull) }
        startedAt = .now
        progress = 1
        phase = .refreshing
        Haptics.impact(.light)
        await action()
        // a refresh that lands instantly still gets one beat of the arc
        let held = Date().timeIntervalSince(startedAt)
        if held < 0.5 { try? await Task.sleep(for: .seconds(0.5 - held)) }
        phase = .landing
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(0.45))
            guard let self, phase == .landing else { return }
            phase = .pulling
            progress = min(1, pull / Self.threshold)
        }
    }

    fileprivate func scrolled(pull: CGFloat) {
        self.pull = pull
        guard phase == .pulling else { return }
        let next = min(1, max(0, pull / Self.threshold))
        if abs(next - progress) > 0.002 || (next == 0) != (progress == 0) { progress = next }
    }
}

// MARK: - The mark

struct RefreshGlyph: View {
    let model: RefreshGlyphModel
    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// Body diameter and line, about the weight of a tab bar glyph.
    private static let size: CGFloat = 26
    private static let line: CGFloat = 1.6
    private static let canvas: CGFloat = 36
    /// One lap of the arc.
    private static let lap = 0.9

    var body: some View {
        let phase = model.phase
        TimelineView(.animation(paused: phase != .refreshing)) { timeline in
            let t = timeline.date.timeIntervalSince(model.startedAt)
            Canvas { context, canvas in draw(&context, in: canvas, t: t) }
        }
        .frame(width: Self.canvas, height: Self.canvas)
        .scaleEffect(phase == .landing ? 0.4 : 1)
        .opacity(phase == .landing ? 0 : 1)
        .animation(reduceMotion ? .easeOut(duration: 0.2) : .spring(duration: 0.4, bounce: 0), value: phase)
        .accessibilityHidden(true)
    }

    private func draw(_ context: inout GraphicsContext, in canvas: CGSize, t: TimeInterval) {
        let ink = scheme == .dark ? Color.white : Color.black
        let centre = CGPoint(x: canvas.width / 2, y: canvas.height / 2)
        let ring = Self.ring(centre: centre, radius: Self.size / 2)
        let stroke = StrokeStyle(lineWidth: Self.line, lineCap: .round)

        switch model.phase {
        case .pulling:
            let p = model.progress
            guard p > 0 else { return }
            // grey while it traces, full ink once it closes
            context.stroke(ring.trimmedPath(from: 0, to: p), with: .color(ink.opacity(0.3 + 0.7 * p)), style: stroke)
            let wake = min(1, max(0, (p - 0.55) / 0.4))
            if wake > 0 { eyes(&context, centre: centre, face: GlyphFaces.face(.idle), ink: ink.opacity(wake), pop: 0.7 + 0.3 * wake) }

        case .refreshing:
            let face = GlyphFaces.face(.searching)
            // the eyes snap open on the tap
            let pop = 1 + 0.25 * sin(.pi * min(1, t / 0.22))
            if reduceMotion {
                let breath = 0.45 + 0.55 * (0.5 + 0.5 * cos(t * 2 * .pi / 1.4))
                context.stroke(ring, with: .color(ink.opacity(breath)), style: stroke)
                eyes(&context, centre: centre, face: face, ink: ink, pop: pop)
                return
            }
            context.stroke(ring, with: .color(ink.opacity(0.18)), style: stroke)
            // the closed outline unwinds into the arc, then the arc laps
            let unwind = Self.easeInOut(min(1, t / 0.32))
            let length = 1 - unwind * (1 - (0.24 + 0.06 * sin(t * 2 * .pi / Self.lap)))
            let head = t / Self.lap
            for (from, to) in Self.wrapped(from: head - length, to: head) {
                context.stroke(ring.trimmedPath(from: from, to: to), with: .color(ink), style: stroke)
            }
            // and the eyes follow it round
            let angle = (head.truncatingRemainder(dividingBy: 1)) * 2 * .pi - .pi / 2
            let glance = CGSize(width: cos(angle) * Self.size * 0.07 * unwind, height: sin(angle) * Self.size * 0.07 * unwind)
            eyes(&context, centre: centre, face: face, ink: ink, pop: pop, shift: glance)

        case .landing:
            context.stroke(ring, with: .color(ink), style: stroke)
            eyes(&context, centre: centre, face: GlyphFaces.face(.finished), ink: ink, pop: 1)
        }
    }

    /// The glyph eyes, laid out exactly as GlyphMark lays them on a body
    /// this size, stroked at the outline's weight.
    private func eyes(_ context: inout GraphicsContext, centre: CGPoint, face: GlyphFace, ink: Color,
                      pop: CGFloat, shift: CGSize = .zero) {
        let layout = GlyphFaces.layout, d = Self.size
        let scale = layout.eyeBox * d / GlyphFaces.viewBox * pop
        var eyes = context
        eyes.translateBy(x: centre.x + shift.width, y: centre.y + shift.height)
        eyes.rotate(by: .degrees(GlyphFaces.tiltDegrees))
        for (glyph, x) in [(face.left, -layout.eyeX), (face.right, layout.eyeX)] {
            var eye = eyes
            eye.translateBy(x: x * d, y: layout.eyeY * d)
            eye.scaleBy(x: scale, y: scale)
            eye.translateBy(x: -GlyphFaces.viewBox / 2, y: -GlyphFaces.viewBox / 2)
            eye.stroke(Path(GlyphFaces.path(glyph)), with: .color(ink),
                       style: StrokeStyle(lineWidth: Self.line * 1.15 / scale, lineCap: .round, lineJoin: .round))
        }
    }

    /// A circle that starts at twelve o'clock and runs clockwise, so a trim
    /// draws it the way a hand would.
    private static func ring(centre: CGPoint, radius: CGFloat) -> Path {
        var path = Path()
        path.addArc(center: centre, radius: radius, startAngle: .degrees(-90), endAngle: .degrees(270), clockwise: false)
        return path
    }

    /// A trim range that may cross twelve o'clock, split into pieces in 0...1.
    private static func wrapped(from: Double, to: Double) -> [(CGFloat, CGFloat)] {
        guard to - from < 0.999 else { return [(0, 1)] }
        let a = from - floor(from), b = to - floor(from)
        return b <= 1 ? [(a, b)] : [(a, 1), (0, b - 1)]
    }

    private static func easeInOut(_ x: Double) -> Double {
        x < 0.5 ? 4 * x * x * x : 1 - pow(-2 * x + 2, 3) / 2
    }
}

// MARK: - Installing it in the refresh control

/// Finds the scroll view `.refreshable` gave a UIRefreshControl, tints the
/// stock spinner clear, hosts the mark inside the control and feeds it the
/// pull distance straight from contentOffset.
private struct RefreshGlyphInstaller: UIViewRepresentable {
    let model: RefreshGlyphModel

    func makeUIView(context: Context) -> Probe { Probe(model: model) }
    func updateUIView(_ probe: Probe, context: Context) { probe.attach() }

    final class Probe: UIView {
        private let model: RefreshGlyphModel
        private weak var scroll: UIScrollView?
        private weak var control: UIRefreshControl?
        private var host: UIHostingController<AnyView>?
        private var watch: NSKeyValueObservation?

        init(model: RefreshGlyphModel) {
            self.model = model
            super.init(frame: .zero)
            isUserInteractionEnabled = false
        }

        @available(*, unavailable)
        required init?(coder: NSCoder) { fatalError() }

        override func didMoveToWindow() {
            super.didMoveToWindow()
            attach()
            // `.refreshable` installs its control a layout pass later
            DispatchQueue.main.async { [weak self] in self?.attach() }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in self?.attach() }
        }

        override func layoutSubviews() {
            super.layoutSubviews()
            attach()
        }

        func attach() {
            guard window != nil else { return }
            if let scroll, let control, scroll.refreshControl === control, host?.view.superview === control {
                quiet(control)
                return
            }
            guard let found = nearestRefreshingScroll(), let refresh = found.refreshControl else { return }
            scroll = found
            control = refresh
            quiet(refresh)

            let host = self.host ?? {
                let host = UIHostingController(rootView: AnyView(EmptyView()))
                host.view.backgroundColor = .clear
                host.view.isUserInteractionEnabled = false
                host.view.clipsToBounds = false
                host.safeAreaRegions = []
                return host
            }()
            // pinned a fixed way down from the top of the gap, so the list
            // uncovers it as it comes down instead of dragging it along
            host.rootView = AnyView(RefreshGlyph(model: model)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                .padding(.top, 12))
            host.view.frame = refresh.bounds
            host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            refresh.addSubview(host.view)
            self.host = host

            watch = found.observe(\.contentOffset, options: [.initial, .new]) { [weak self] scroll, _ in
                MainActor.assumeIsolated { self?.scrolled(scroll) }
            }
#if DEBUG
            preview(found, refresh)
#endif
        }

        private func scrolled(_ scroll: UIScrollView) {
            guard let control else { return }
            quiet(control)
            // while it refreshes the control pads the inset itself; keep the
            // pull it fired at
            guard !control.isRefreshing else { return }
            model.scrolled(pull: max(0, -(scroll.contentOffset.y + scroll.adjustedContentInset.top)))
        }

        private func quiet(_ control: UIRefreshControl) {
            if control.tintColor != .clear { control.tintColor = .clear }
        }

        /// The scroll view this modifier sits on: the probe is its background,
        /// so it is the refreshing scroll view under the probe, found from the
        /// nearest common ancestor outwards.
        private func nearestRefreshingScroll() -> UIScrollView? {
            let mine = convert(bounds, to: nil)
            var ancestor = superview
            for _ in 0..<8 {
                guard let current = ancestor else { return nil }
                var best: (UIScrollView, CGFloat)?
                var queue: [UIView] = [current]
                while !queue.isEmpty {
                    let view = queue.removeFirst()
                    if let scroll = view as? UIScrollView, scroll.refreshControl != nil {
                        let overlap = scroll.convert(scroll.bounds, to: nil).intersection(mine)
                        let area = overlap.isNull ? 0 : overlap.width * overlap.height
                        if area > (best?.1 ?? 0) { best = (scroll, area) }
                        continue
                    }
                    queue.append(contentsOf: view.subviews)
                }
                if let best { return best.0 }
                ancestor = current.superview
            }
            return nil
        }

#if DEBUG
        private static var previewed = false
        /// `-pull-preview`: hold the list pulled down for a screenshot;
        /// `-pull-refresh-preview` also runs a real refresh from there.
        private func preview(_ scroll: UIScrollView, _ control: UIRefreshControl) {
            let args = ProcessInfo.processInfo.arguments
            guard !Self.previewed, args.contains("-pull-preview") || args.contains("-pull-refresh-preview") else { return }
            Self.previewed = true
            DispatchQueue.main.asyncAfter(deadline: .now() + 4) {
                scroll.setContentOffset(CGPoint(x: 0, y: -scroll.adjustedContentInset.top - 120), animated: false)
                if args.contains("-pull-refresh-preview") { control.sendActions(for: .valueChanged) }
            }
        }
#endif
    }
}
