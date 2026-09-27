// The bot's face — the same body and the same face placement the desktop draws.
//
// The body is whichever one the bot wears: `MausBodies` in `CompanionCore` is
// the phone's half of the generated catalog that also bakes
// `shared/mascot-bodies.ts`, so the two renderers cannot drift the way
// desktop's 0.74 face scale and the phone's 0.84 already did once. Parsing and
// placing a body is `CompanionCore.MausSilhouette`; this file is the drawing.
//
// What is NOT ported from the desktop: nothing of the face itself. The 25
// expressions, blinking, gaze tracking and motion are all here, in
// `MausFaceEngine` — same tables, same numbers, same face.
import CompanionCore
import SwiftUI
import UIKit

enum MausPalette {
    /// src/lib/mascot.ts — MAUS_COLORS
    private static let hex: [String: String] = [
        "green": "#009957",
        "blue": "#377FE6",
        "red": "#D94B52",
        "orange": "#E78531",
        "purple": "#8057C8",
        "cyan": "#0EA5C6",
        "pink": "#D84F8B",
        "yellow": "#D8A729",
        "teal": "#01A492",
        "coral": "#E5634E",
        "white": "#FFFFFF",
        "brown": "#885E36",
        "gray": "#808080",
    ]

    static func color(_ name: String) -> Color {
        Color(hex: hex[name] ?? "#8E8E93")
    }

}

/// The viewport half of the silhouette: how the face box lands in a rect.
///
/// The body itself — the path data, the parser and the per-body cache — moved
/// to `CompanionCore.MausSilhouette`, where `swift test` can reach it. What
/// stays here is what depends on `MausFaceData`, which is app-side artwork.
extension MausSilhouette {
    /// The face box with the desktop's 15-unit margin around it (its viewBox
    /// is `-15 -15 258.541 258.541`) — room for the body to bob and sway.
    static let margin: CGFloat = 15

    /// The transform that puts the margined face box into `rect`.
    static func fit(_ rect: CGRect) -> CGAffineTransform {
        let side = MausFaceData.faceBox + margin * 2
        let k = min(rect.width, rect.height) / side
        return CGAffineTransform(translationX: margin, y: margin)
            .concatenating(CGAffineTransform(scaleX: k, y: k))
            .concatenating(CGAffineTransform(
                translationX: rect.minX + (rect.width - side * k) / 2,
                y: rect.minY + (rect.height - side * k) / 2
            ))
    }
}

/// A bot, at whatever size the row needs — and alive, exactly the way it is
/// on the desktop. `MausFaceEngine` is a port of the frame loop in
/// `MausMascotios/MausAvatar.tsx`: a state picks a pool of expressions and
/// drifts through them on its cadence, a spring morphs the eyes and mouth
/// between them, it blinks on its own rhythm, and the body bobs, sways,
/// breathes or jitters per state. Same data, same numbers, same face.
struct MausAvatar: View {
    let color: String
    var size: CGFloat = 52
    /// Which body from the catalog to draw. Anything unrecognised — an older
    /// bot with no choice recorded, a newer desktop's body this build has not
    /// shipped yet — falls back to the shipped `cursor`.
    var bodyId: String? = MausSilhouette.defaultBody
    var state: MausState = .idle
    /// Animation is OPT-IN: a mounted face costs a 30fps Canvas redraw, and a
    /// roster of them once pegged the app (and SimRenderServer) all night.
    /// Pass true only where motion carries meaning — a busy bot, an open
    /// profile, the needs-you island's opening beat.
    var animated: Bool = false
    /// Comets orbiting the body — the island's "something is happening".
    var comets: Bool = false

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @State private var engine = MausFaceEngine()

    var body: some View {
        FlatBotMark(color: color, bodyId: bodyId)
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}

/// The resting face for a state, drawn once and still. For places the
/// engine cannot run — a widget, a Live Activity — where the system renders
/// a snapshot and the face can only change between updates.
struct MausFaceStill: View {
    let color: String
    var state: MausState = .idle
    var size: CGFloat = 52
    var bodyId: String? = MausSilhouette.defaultBody
    var comets: Bool = false
    /// The clock for the comets' phase; a different date is a different frame.
    var at: Date = Date()

    var body: some View {
        FlatBotMark(color: color, bodyId: bodyId)
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}

/// The face, frame by frame. One per drawn mascot; holds the morph in
/// progress, the blink, and when the next expression or blink is due.
final class MausFaceEngine {
    private(set) var state: MausState = .idle
    private var expression = 0
    private var currentRings: [[CGPoint]] = [MausFaceData.ring(0, eye: 0), MausFaceData.ring(0, eye: 1)]
    private var targetRings: [[CGPoint]] = [MausFaceData.ring(0, eye: 0), MausFaceData.ring(0, eye: 1)]
    private var currentMouth = MausFaceData.mouth(0)
    private var targetMouth = MausFaceData.mouth(0)
    private var currentGaze = MausFaceData.gaze(0)
    private var targetGaze = MausFaceData.gaze(0)
    private var morph: CGFloat = 1
    private var velocity: CGFloat = 0
    private var blinkStart: Date?
    private var nextExpressionAt: Date?
    private var nextBlinkAt: Date?
    private var stateStart = Date()
    private var last: Date?
    private var started = false

    /// The desktop's `lookAround` default: how much of an expression's own
    /// look-direction to keep.
    private let lookAround: CGFloat = 0.35
    /// Spring stiffness for the morph, the desktop's default.
    private let spring: CGFloat = 7

    func setState(_ new: MausState, now: Date) {
        guard !started || new != state else { return }
        started = true
        state = new
        stateStart = now
        select(MausFaceData.pools[new]?.first ?? 0)
        if last == nil { morph = 1; velocity = 0 } // first frame: rest on it, no morph in
        nextExpressionAt = schedule(MausFaceData.expressionCadence[new], from: now)
        nextBlinkAt = schedule(MausFaceData.blink[new], from: now)
    }

    private func schedule(_ range: (CGFloat, CGFloat)?, from now: Date) -> Date? {
        guard let range else { return nil }
        let ms = range.0 + CGFloat.random(in: 0...1) * (range.1 - range.0)
        return now.addingTimeInterval(TimeInterval(ms / 1000))
    }

    private func select(_ index: Int) {
        let i = ((index % MausFaceData.expressionCount) + MausFaceData.expressionCount) % MausFaceData.expressionCount
        if i == expression && morph >= 1 { return }
        currentRings = displayedRings()
        currentMouth = displayedMouth()
        currentGaze = displayedGaze()
        targetRings = [MausFaceData.ring(i, eye: 0), MausFaceData.ring(i, eye: 1)]
        targetMouth = MausFaceData.mouth(i)
        targetGaze = MausFaceData.gaze(i)
        expression = i
        morph = 0
        velocity = 0
    }

    func step(now: Date) {
        let dt = CGFloat(min(now.timeIntervalSince(last ?? now), 0.1))
        last = now
        // the spring towards morph == 1
        let f = spring
        velocity += (-2 * f * velocity - f * f * (morph - 1)) * dt
        morph += velocity * dt
        if !morph.isFinite { morph = 1; velocity = 0 }

        if let due = nextExpressionAt, now >= due {
            let pool = MausFaceData.pools[state] ?? [0]
            let alternatives = pool.filter { $0 != expression }
            select(alternatives.randomElement() ?? pool[0])
            nextExpressionAt = schedule(MausFaceData.expressionCadence[state], from: now)
        }
        if let due = nextBlinkAt, now >= due {
            blinkStart = now
            nextBlinkAt = schedule(MausFaceData.blink[state], from: now)
        }
    }

    // MARK: - Drawing

    // MARK: - Comets

    /// Comets orbiting the body on tilted rings — the desktop's `trails`.
    struct CometSpec {
        let count: Int
        /// ms for one orbit
        let period: CGFloat
        /// face units
        let radius: CGFloat
        /// half-width at the head
        let width: CGFloat
        /// how much of the orbit one comet covers, radians
        let span: CGFloat
        /// the body's resting scale while the rings are out, so they clear it
        let bodyScale: CGFloat
    }

    static let cometTrails: [MausState: CometSpec] = [
        .orbit: CometSpec(count: 6, period: 3000, radius: 105, width: 5, span: 2.5, bodyScale: 0.72),
        .radar: CometSpec(count: 4, period: 2400, radius: 106, width: 4.5, span: 2.1, bodyScale: 0.72),
        .progress: CometSpec(count: 5, period: 2000, radius: 104, width: 4.8, span: 2.3, bodyScale: 0.74),
        .loading: CometSpec(count: 5, period: 2400, radius: 105, width: 5, span: 2.6, bodyScale: 0.72),
        .uploading: CometSpec(count: 4, period: 1800, radius: 104, width: 4.8, span: 2.2, bodyScale: 0.74),
    ]

    /// One palette per comet: three neighbouring hues along its length. A flat
    /// colour reads as wire; a hue that travels reads as something lit.
    static let cometColors: [[Color]] = [
        ["#A855F7", "#6366F1", "#38BDF8"], ["#22D3EE", "#34D399", "#A3E635"], ["#FB923C", "#F43F5E", "#D946EF"],
        ["#818CF8", "#C084FC", "#F472B6"], ["#FACC15", "#FB923C", "#EC4899"], ["#34D399", "#22D3EE", "#60A5FA"],
    ].map { $0.map { Color(hex: $0) } }

    private struct CometSample { var x: CGFloat; var y: CGFloat; var h: CGFloat }
    private struct CometPiece { let path: Path; let shading: GraphicsContext.Shading; let front: Bool }

    private static func hash01(_ n: CGFloat) -> CGFloat {
        let x = sin(n * 127.1 + 311.7) * 43758.5453
        return x - floor(x)
    }

    /// The comets for this frame, each split at the horizon into pieces that
    /// go behind the body or in front of it.
    private func comets(_ spec: CometSpec, elapsed: CGFloat, centre: CGPoint, strength: CGFloat) -> [CometPiece] {
        var out: [CometPiece] = []
        let samples = 22
        let span = min(spec.span, .pi - 0.05)
        let near: CGFloat = 1.1 // swell at the near point of the ring — perspective, cheaply

        for i in 0..<spec.count {
            let seedA = Self.hash01(CGFloat(i + 3)), seedB = Self.hash01(CGFloat(i + 29)), seedC = Self.hash01(CGFloat(i + 71))
            // every ring its own tip, roll and speed, or they stack into one hoop
            let tilt = 0.3 + seedA * 0.66
            let roll = seedB * 2 * .pi
            let period = spec.period * (0.78 + seedC * 0.55)
            let direction: CGFloat = i % 2 == 0 ? 1 : -1
            let radius = spec.radius * strength * (0.94 + seedB * 0.12)
            let head = direction * (elapsed / period) * 2 * .pi + seedA * 2 * .pi
            let cosT = cos(tilt), sinT = sin(tilt), cosR = cos(roll), sinR = sin(roll)

            var runs: [(samples: [CometSample], front: Bool)] = []
            var run: [CometSample] = []
            var side: CGFloat = 0
            func keep(_ r: [CometSample]) -> Bool {
                guard r.count >= 3 else { return false }
                var length: CGFloat = 0
                for k in 1..<r.count { length += hypot(r[k].x - r[k - 1].x, r[k].y - r[k - 1].y) }
                return length > spec.width * 3.5
            }
            for sIndex in 0..<samples {
                let k = CGFloat(sIndex) / CGFloat(samples - 1)
                let angle = head - direction * span * k
                let ox = cos(angle) * radius, oy = sin(angle) * radius
                let ty = oy * cosT, z = oy * sinT
                let n = 1 + (z / radius) * (near - 1)
                let x = centre.x + (ox * cosR - ty * sinR) * n
                let y = centre.y + (ox * sinR + ty * cosR) * n
                // full at the head, a third by the tail — keeps it a comet, not a brush stroke
                let h = spec.width * n * (1 - 0.68 * pow(k, 1.5)) * strength
                let nowSide: CGFloat = z >= 0 ? 1 : -1
                if nowSide != side {
                    if keep(run) { runs.append((run, side > 0)) }
                    run = run.isEmpty ? [] : [run[run.count - 1]]
                    side = nowSide
                }
                run.append(CometSample(x: x, y: y, h: h))
            }
            if keep(run) { runs.append((run, side > 0)) }
            guard let firstRun = runs.first, let lastRun = runs.last else { continue }

            // one gradient across the whole comet, so a hue runs head to tail across a cut
            let colors = Self.cometColors[i % Self.cometColors.count]
            let shading = GraphicsContext.Shading.linearGradient(
                Gradient(stops: [
                    .init(color: colors[0], location: 0),
                    .init(color: colors[1], location: 0.52),
                    .init(color: colors[2].opacity(0.35), location: 1),
                ]),
                startPoint: CGPoint(x: firstRun.samples[0].x, y: firstRun.samples[0].y),
                endPoint: CGPoint(x: lastRun.samples[lastRun.samples.count - 1].x, y: lastRun.samples[lastRun.samples.count - 1].y)
            )
            for (r, piece) in runs.enumerated() {
                out.append(CometPiece(
                    path: Self.cometPath(piece.samples, capHead: r == 0, capTail: r == runs.count - 1),
                    shading: shading,
                    front: piece.front
                ))
            }
        }
        return out
    }

    /// Head→tail samples to one filled, tapered outline with half-round caps
    /// on the true ends — a comet is an outline, not a stroke.
    private static func cometPath(_ s: [CometSample], capHead: Bool, capTail: Bool) -> Path {
        let n = s.count
        var path = Path()
        guard n >= 2 else { return path }
        var nx: [CGFloat] = [], ny: [CGFloat] = []
        for i in 0..<n {
            let a = s[max(i - 1, 0)], b = s[min(i + 1, n - 1)]
            let tx = b.x - a.x, ty = b.y - a.y
            let len = max(hypot(tx, ty), 0.0001)
            nx.append(-ty / len); ny.append(tx / len)
        }
        func cap(_ i: Int, _ out: CGFloat) -> [CGPoint] {
            let steps = 6
            let x = s[i].x, y = s[i].y, h = s[i].h
            let tx = ny[i], ty = -nx[i]
            return (1..<steps).map { k in
                let a = CGFloat(k) / CGFloat(steps) * .pi
                let dn = out * cos(a), dt = out * sin(a)
                return CGPoint(x: x + (nx[i] * dn + tx * dt) * h, y: y + (ny[i] * dn + ty * dt) * h)
            }
        }
        var outline: [CGPoint] = [CGPoint(x: s[0].x - nx[0] * s[0].h, y: s[0].y - ny[0] * s[0].h)]
        if capHead { outline += cap(0, -1) }
        for i in 0..<n { outline.append(CGPoint(x: s[i].x + nx[i] * s[i].h, y: s[i].y + ny[i] * s[i].h)) }
        if capTail { outline += cap(n - 1, 1) }
        for i in stride(from: n - 1, to: 0, by: -1) { outline.append(CGPoint(x: s[i].x - nx[i] * s[i].h, y: s[i].y - ny[i] * s[i].h)) }
        path.move(to: outline[0])
        for p in outline.dropFirst() { path.addLine(to: p) }
        path.closeSubpath()
        return path
    }

    // MARK: - Drawing

    /// `comets`: orbit the body with the `orbit` state's rings whatever the
    /// face is doing — the island's "something is happening" — in addition to
    /// the states that carry their own. `at` is the clock; pass a fixed date
    /// for a still frame.
    func draw(in context: inout GraphicsContext, size: CGSize, color: String, bodyId: String? = MausSilhouette.defaultBody, bodyMotion: Bool, comets: Bool = false, at now: Date = Date()) {
        let rect = CGRect(origin: .zero, size: size)
        context.concatenate(MausSilhouette.fit(rect))
        let elapsed = CGFloat(now.timeIntervalSince(stateStart) * 1000)
        let spec = Self.cometTrails[state] ?? (comets ? Self.cometTrails[.orbit] : nil)
        let centre = CGPoint(x: MausFaceData.faceBox / 2, y: MausFaceData.faceBox / 2)

        let pieces = spec.map { self.comets($0, elapsed: elapsed, centre: centre, strength: 1) } ?? []
        for piece in pieces where !piece.front { context.fill(piece.path, with: piece.shading) }

        // The body, in its own pushed context so the rings are not under its
        // transform. Comet states sit back a little, so the rings clear them.
        var bodyContext = context
        if let spec {
            bodyContext.translateBy(x: centre.x, y: centre.y)
            bodyContext.scaleBy(x: spec.bodyScale, y: spec.bodyScale)
            bodyContext.translateBy(x: -centre.x, y: -centre.y)
        }
        if bodyMotion {
            bodyContext.concatenate(bodyTransform(MausFaceData.motion[state] ?? MausBodyMotion(), elapsed: elapsed))
        }
        drawBody(in: &bodyContext, color: color, bodyId: bodyId, now: now)

        for piece in pieces where piece.front { context.fill(piece.path, with: piece.shading) }
    }

    private func drawBody(in context: inout GraphicsContext, color: String, bodyId: String?, now: Date) {
        // Wrapping the cached `CGPath` is a retain, not a re-parse: the body
        // is parsed and placed once per id, inside `CompanionCore`.
        let body = Path(MausSilhouette.inFaceBox(bodyId))
        let a = MausSilhouette.anchor(bodyId)

        // The gradient runs corner to corner of the body's own bounds,
        // which is the only place that lookup is still needed.
        let bounds = MausSilhouette.faceBoxBounds(bodyId)
        context.fill(body, with: .linearGradient(
            Gradient(stops: MausPalette.gradientStops(color)),
            startPoint: CGPoint(x: bounds.maxX, y: bounds.minY),
            endPoint: CGPoint(x: bounds.minX, y: bounds.maxY)
        ))

        // The face is painted on the body: clipped to it, anchored in it.
        context.clip(to: body)
        context.translateBy(x: a.x, y: a.y)
        context.scaleBy(x: a.scale, y: a.scale)
        context.translateBy(x: -MausFaceData.faceCentre.x, y: -MausFaceData.faceCentre.y)

        let gaze = displayedGaze()
        let ox = gaze.x * lookAround, oy = gaze.y * lookAround
        let rings = displayedRings().map { $0.map { CGPoint(x: $0.x + ox, y: $0.y + oy) } }
        let blink = blinkScale(now: now)

        for ring in rings {
            let c = Self.centre(ring)
            var path = Path()
            for (i, p) in ring.enumerated() {
                // blink squashes the eye towards its own centre line
                let q = CGPoint(x: p.x, y: c.y + (p.y - c.y) * blink)
                if i == 0 { path.move(to: q) } else { path.addLine(to: q) }
            }
            path.closeSubpath()
            context.fill(path, with: .color(.white))
        }

        let spec = displayedMouth()
        let frame = Self.mouthFrame(rings, spec)
        context.stroke(
            Self.mouthPath(frame, spec),
            with: .color(.white),
            style: StrokeStyle(lineWidth: MausFaceData.mouthStroke, lineCap: .round)
        )
    }

    /// The desktop's `bodyTransform`, in face-box units, elapsed in ms.
    private func bodyTransform(_ m: MausBodyMotion, elapsed: CGFloat) -> CGAffineTransform {
        let centre = MausFaceData.faceBox / 2
        let ground = MausFaceData.faceBox
        func wave(_ period: CGFloat, _ phase: CGFloat = 0) -> CGFloat { sin(elapsed / period * .pi * 2 + phase) }
        var dx: CGFloat = 0, dy: CGFloat = 0
        var rotation = m.tilt ?? 0
        var scale: CGFloat = 1, sx: CGFloat = 1, sy: CGFloat = 1
        if let (amplitude, period) = m.bob {
            let p = wave(period)
            dy -= amplitude * p
            if let squash = m.squash {
                let amount = squash * max(0, -p)
                sy = 1 - amount * 0.5
                sx = 1 + amount * 0.5
            }
        }
        if let (radius, period) = m.circle {
            dx += radius * wave(period)
            dy += radius * wave(period, .pi / 2)
        }
        if let (degrees, period) = m.sway { rotation += degrees * wave(period) }
        if let (fraction, period) = m.pulse { scale *= 1 + fraction * wave(period) }
        if let (amplitude, period) = m.jitter {
            dx += amplitude * wave(period)
            dy += amplitude * wave(period * 0.63, 1.1)
        }
        if let (from, duration) = m.enter {
            let t = elapsed / duration
            scale *= t >= 1 ? 1 : from + (1 - from) * Self.easeOutBack(max(t, 0))
        }
        if let settle = m.settle {
            let t = min(max(elapsed / 1400, 0), 1)
            scale *= 1 + (settle - 1) * Self.easeInOut(t)
        }
        // SVG applies the list right-to-left: squash, then scale, then rotate,
        // then translate. Build it in that order.
        var t = CGAffineTransform.identity
        if sx != 1 || sy != 1 {
            t = t.concatenating(CGAffineTransform(translationX: -centre, y: -ground))
                .concatenating(CGAffineTransform(scaleX: sx, y: sy))
                .concatenating(CGAffineTransform(translationX: centre, y: ground))
        }
        if scale != 1 {
            t = t.concatenating(CGAffineTransform(translationX: -centre, y: -centre))
                .concatenating(CGAffineTransform(scaleX: scale, y: scale))
                .concatenating(CGAffineTransform(translationX: centre, y: centre))
        }
        if rotation != 0 {
            t = t.concatenating(CGAffineTransform(translationX: -centre, y: -centre))
                .concatenating(CGAffineTransform(rotationAngle: rotation * .pi / 180))
                .concatenating(CGAffineTransform(translationX: centre, y: centre))
        }
        if dx != 0 || dy != 0 { t = t.concatenating(CGAffineTransform(translationX: dx, y: dy)) }
        return t
    }

    private func blinkScale(now: Date) -> CGFloat {
        guard let start = blinkStart else { return 1 }
        let t = CGFloat(now.timeIntervalSince(start)) / 0.320
        if t >= 1 { blinkStart = nil; return 1 }
        // fast close, slower open
        return max(t < 0.42 ? 1 - t / 0.42 : (t - 0.42) / 0.58, 0.04)
    }

    private func displayedRings() -> [[CGPoint]] {
        let m = min(max(morph, 0), 1)
        return currentRings.enumerated().map { eye, ring in
            ring.enumerated().map { i, p in
                let q = targetRings[eye][i]
                return CGPoint(x: p.x + (q.x - p.x) * m, y: p.y + (q.y - p.y) * m)
            }
        }
    }
    private func displayedMouth() -> [CGFloat] {
        let m = min(max(morph, 0), 1)
        return currentMouth.enumerated().map { i, v in v + (targetMouth[i] - v) * m }
    }
    private func displayedGaze() -> CGPoint {
        let m = min(max(morph, 0), 1)
        return CGPoint(x: currentGaze.x + (targetGaze.x - currentGaze.x) * m, y: currentGaze.y + (targetGaze.y - currentGaze.y) * m)
    }

    private static func centre(_ ring: [CGPoint]) -> CGPoint {
        var x: CGFloat = 0, y: CGFloat = 0
        for p in ring { x += p.x; y += p.y }
        return CGPoint(x: x / CGFloat(ring.count), y: y / CGFloat(ring.count))
    }

    /// The mouth hangs off the eyes: centred under the pair, tilted with
    /// them, pushed clear of whichever eye is tallest.
    private static func mouthFrame(_ rings: [[CGPoint]], _ spec: [CGFloat]) -> (x: CGFloat, y: CGFloat, angle: CGFloat) {
        let c0 = centre(rings[0]), c1 = centre(rings[1])
        let theta = atan2(c1.y - c0.y, c1.x - c0.x)
        var halfHeight: CGFloat = 0
        for ring in rings {
            var lo = CGFloat.infinity, hi = -CGFloat.infinity
            for p in ring { lo = min(lo, p.y); hi = max(hi, p.y) }
            halfHeight = max(halfHeight, (hi - lo) / 2)
        }
        let drop = halfHeight + spec[2]
        return (
            x: (c0.x + c1.x) / 2 - sin(theta) * drop,
            y: (c0.y + c1.y) / 2 + cos(theta) * drop,
            angle: theta + spec[3] * .pi / 180
        )
    }

    private static func mouthPath(_ frame: (x: CGFloat, y: CGFloat, angle: CGFloat), _ spec: [CGFloat]) -> Path {
        let ca = cos(frame.angle), sa = sin(frame.angle)
        func at(_ lx: CGFloat, _ ly: CGFloat) -> CGPoint {
            CGPoint(x: frame.x + lx * ca - ly * sa, y: frame.y + lx * sa + ly * ca)
        }
        var path = Path()
        path.move(to: at(-spec[0], 0))
        path.addQuadCurve(to: at(spec[0], 0), control: at(0, spec[1]))
        return path
    }

    private static func easeOutBack(_ t: CGFloat) -> CGFloat {
        let c: CGFloat = 1.7, u = t - 1
        return 1 + (c + 1) * u * u * u + c * u * u
    }
    private static func easeInOut(_ t: CGFloat) -> CGFloat { t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t) }
}

/// The person, not a bot — the roster header and the settings row. A letter
/// rather than a mascot, deliberately: the mascots mean "this is a bot", and
/// giving the human one too would blur the only distinction the roster makes.
struct ProfileAvatar: View {
    let name: String
    var size: CGFloat = 34

    var body: some View {
        Circle()
            .fill(MausPalette.color("green"))
            .frame(width: size, height: size)
            .overlay {
                Text(initial)
                    .font(.system(size: size * 0.45, weight: .semibold))
                    .foregroundStyle(.white)
            }
    }

    private var initial: String {
        String(name.trimmingCharacters(in: .whitespaces).prefix(1)).uppercased()
    }
}

extension MausPalette {
    /// The gradient as raw stops, for `Canvas`, which cannot take a
    /// `LinearGradient` directly.
    static func gradientStops(_ name: String) -> [Gradient.Stop] {
        let base = color(name)
        return [
            .init(color: base.mixed(with: .white, amount: 0.55), location: 0),
            .init(color: base, location: 0.55),
            .init(color: base.mixed(with: .black, amount: 0.42), location: 1),
        ]
    }
}

extension Color {
    init(hex: String) {
        var value: UInt64 = 0
        Scanner(string: hex.replacingOccurrences(of: "#", with: "")).scanHexInt64(&value)
        self.init(
            .sRGB,
            red: Double((value >> 16) & 0xFF) / 255,
            green: Double((value >> 8) & 0xFF) / 255,
            blue: Double(value & 0xFF) / 255,
            opacity: 1
        )
    }

    /// Linear mix in sRGB, matching the `mix()` the desktop uses to build its
    /// gradient stops. Not perceptually correct, and deliberately so: the
    /// point is to land on the same colours as the other screen.
    func mixed(with other: Color, amount: Double) -> Color {
        #if canImport(UIKit)
        let a = UIColor(self), b = UIColor(other)
        var ar: CGFloat = 0, ag: CGFloat = 0, ab: CGFloat = 0, aa: CGFloat = 0
        var br: CGFloat = 0, bg: CGFloat = 0, bb: CGFloat = 0, ba: CGFloat = 0
        a.getRed(&ar, green: &ag, blue: &ab, alpha: &aa)
        b.getRed(&br, green: &bg, blue: &bb, alpha: &ba)
        let t = CGFloat(amount)
        return Color(
            .sRGB,
            red: Double(ar + (br - ar) * t),
            green: Double(ag + (bg - ag) * t),
            blue: Double(ab + (bb - ab) * t),
            opacity: 1
        )
        #else
        return self
        #endif
    }
}

// The eight flat bodies share one fixed face on desktop and phone.
struct FlatBotMark: View {
    let color: String
    var bodyId: String?
    static let ids = ["circle", "blob", "squircle", "capsule", "cursor", "hexagon", "star", "drop"]
    static let names = ["circle": "Circle", "blob": "Oval", "squircle": "Square", "capsule": "Capsule", "cursor": "Triangle", "hexagon": "Hexagon", "star": "Cloud", "drop": "Drop"]
    static let outlines: [String: String] = [
        "circle": "M 50 10 C 72 10 90 28 90 50 C 90 72 72 90 50 90 C 28 90 10 72 10 50 C 10 28 28 10 50 10 Z",
        "blob": "M 51 12 C 75 8 88 32 90 53 C 91 77 69 91 47 88 C 22 87 8 70 11 50 C 14 30 29 15 51 12 Z",
        "squircle": "M 31 14 C 42 12 61 12 71 14 C 83 15 86 21 87 33 C 89 44 89 62 87 73 C 86 84 80 87 68 88 C 55 89 40 89 28 87 C 17 86 14 79 13 67 C 12 53 12 40 14 28 C 15 18 20 15 31 14 Z",
        "capsule": "M 34 22 C 14 22 7 33 7 50 C 7 67 18 78 34 78 C 45 78 60 78 69 78 C 87 78 94 66 94 50 C 94 33 83 22 67 22 Z",
        "cursor": "M 44 12 C 47 7 53 7 57 13 C 66 27 80 51 90 72 C 95 83 89 88 79 88 C 60 89 37 89 20 88 C 8 88 6 82 12 72 C 22 51 35 27 44 12 Z",
        "hexagon": "M 45 10 C 48 8 52 8 55 10 C 63 14 73 20 82 26 C 86 28 87 31 87 36 C 87 45 87 58 87 65 C 87 70 85 73 81 75 C 72 80 62 86 55 90 C 52 92 48 92 45 90 C 35 85 26 79 18 74 C 14 72 13 69 13 64 C 13 54 13 44 13 35 C 13 30 15 28 19 25 Z",
        "star": "M 20 38 C 17 17 42 3 57 17 C 74 7 89 21 87 39 C 108 57 94 83 74 82 C 61 97 40 97 27 84 C 3 90 -3 58 20 38 Z",
        "drop": "M 46 9 C 49 5 52 6 55 10 C 64 21 87 46 87 64 C 87 84 71 95 51 95 C 29 95 14 81 15 63 C 16 46 37 20 46 9 Z",
        "shield": "M 45 10 C 48 8 52 8 55 10 C 63 14 73 20 82 26 C 86 28 87 31 87 36 C 87 45 87 58 87 65 C 87 70 85 73 81 75 C 72 80 62 86 55 90 C 52 92 48 92 45 90 C 35 85 26 79 18 74 C 14 72 13 69 13 64 C 13 54 13 44 13 35 C 13 30 15 28 19 25 Z",
        "diamond": "M 31 14 C 42 12 61 12 71 14 C 83 15 86 21 87 33 C 89 44 89 62 87 73 C 86 84 80 87 68 88 C 55 89 40 89 28 87 C 17 86 14 79 13 67 C 12 53 12 40 14 28 C 15 18 20 15 31 14 Z"
    ]
    static func path(_ data: String) -> Path {
        let tokens = data.split(separator: " ").map(String.init)
        var p = Path(); var i = 0
        func point(_ index: Int) -> CGPoint {
            CGPoint(x: Double(tokens[index]) ?? 0, y: Double(tokens[index + 1]) ?? 0)
        }
        while i < tokens.count {
            switch tokens[i] {
            case "M": p.move(to: point(i + 1)); i += 3
            case "C": p.addCurve(to: point(i + 5), control1: point(i + 1), control2: point(i + 3)); i += 7
            case "Z": p.closeSubpath(); i += 1
            default: i += 1
            }
        }
        return p
    }
    var body: some View {
        Canvas { context, size in
            context.scaleBy(x: size.width / 100, y: size.height / 100)
            context.fill(Self.path(Self.outlines[bodyId ?? "circle"] ?? Self.outlines["circle"]!), with: .color(MausPalette.color(color)))
            var eyes = Path()
            eyes.move(to: CGPoint(x: 51, y: 43)); eyes.addLine(to: CGPoint(x: 54, y: 52))
            eyes.move(to: CGPoint(x: 73, y: 39)); eyes.addLine(to: CGPoint(x: 76, y: 48))
            context.stroke(eyes, with: .color(Color(hex: "#151515")), style: StrokeStyle(lineWidth: 6, lineCap: .round))
        }
    }
}

/// A person's photo with its light backdrop cut away so it sits on the
/// background like a bot mascot does. Mirrors `cutout` in
/// `src/components/Avatar.tsx`.
@MainActor
enum PersonCutout {
    private static var cache: [String: UIImage] = [:]

    static func image(dataURL: String) -> UIImage? {
        if let hit = cache[dataURL] { return hit }
        guard let encoded = dataURL.split(separator: ",", maxSplits: 1).last,
              let data = Data(base64Encoded: String(encoded)),
              let photo = UIImage(data: data) else { return nil }
        let result = cut(photo) ?? photo
        cache[dataURL] = result
        return result
    }

    static func isCut(_ image: UIImage) -> Bool { image.accessibilityIdentifier == "person-cutout" }

    private static func cut(_ photo: UIImage) -> UIImage? {
        guard let source = photo.cgImage else { return nil }
        let scale = min(1, 256 / CGFloat(max(source.width, source.height)))
        let width = max(1, Int((CGFloat(source.width) * scale).rounded()))
        let height = max(1, Int((CGFloat(source.height) * scale).rounded()))
        let total = width * height
        var pixels = [UInt8](repeating: 0, count: total * 4)
        guard let context = CGContext(data: &pixels, width: width, height: height, bitsPerComponent: 8,
                                      bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(),
                                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        context.draw(source, in: CGRect(x: 0, y: 0, width: width, height: height))

        func light(_ at: Int) -> Bool {
            let r = pixels[at * 4], g = pixels[at * 4 + 1], b = pixels[at * 4 + 2]
            let low = min(r, g, b), high = max(r, g, b)
            return low > 185 && high - low < 14
        }
        var backdrop = [UInt8](repeating: 0, count: total)
        var seen = [UInt8](repeating: 0, count: total)
        var stack: [Int] = []
        for x in 0..<width { stack.append(x); stack.append((height - 1) * width + x) }
        for y in 0..<height { stack.append(y * width); stack.append(y * width + width - 1) }
        while let at = stack.popLast() {
            if seen[at] == 1 { continue }
            seen[at] = 1
            if pixels[at * 4 + 3] > 0 && !light(at) { continue }
            backdrop[at] = 1
            let x = at % width
            if x > 0 { stack.append(at - 1) }
            if x < width - 1 { stack.append(at + 1) }
            if at >= width { stack.append(at - width) }
            if at < width * (height - 1) { stack.append(at + width) }
        }

        let radius = 4
        func morph(_ mask: [UInt8], grow: Bool) -> [UInt8] {
            var out = [UInt8](repeating: 0, count: total)
            for y in 0..<height {
                for x in 0..<width {
                    var value: UInt8 = grow ? 0 : 1
                    search: for dy in -radius...radius {
                        let yy = y + dy
                        if yy < 0 || yy >= height { continue }
                        for dx in -radius...radius {
                            let xx = x + dx
                            if xx < 0 || xx >= width || dx * dx + dy * dy > radius * radius { continue }
                            let on = mask[yy * width + xx] == 1
                            if grow && on { value = 1; break search }
                            if !grow && !on { value = 0; break search }
                        }
                    }
                    out[y * width + x] = value
                }
            }
            return out
        }
        let subject = backdrop.map { $0 == 1 ? UInt8(0) : UInt8(1) }
        let kept = morph(morph(subject, grow: true), grow: false)
        var cleared = 0
        for at in 0..<total where kept[at] == 0 {
            // Premultiplied alpha: clear every channel.
            pixels[at * 4] = 0; pixels[at * 4 + 1] = 0; pixels[at * 4 + 2] = 0; pixels[at * 4 + 3] = 0
            cleared += 1
        }
        if cleared == 0 { return nil }
        guard let output = context.makeImage() else { return nil }
        let image = UIImage(cgImage: output)
        image.accessibilityIdentifier = "person-cutout"
        return image
    }
}

/// Renders a person's avatar like a bot mascot: the cutout with no circle,
/// or the plain photo in a circle when the cutout found no backdrop.
struct PersonPhotoView: View {
    let dataURL: String
    let size: CGFloat

    var body: some View {
        if let image = PersonCutout.image(dataURL: dataURL) {
            if PersonCutout.isCut(image) {
                Image(uiImage: image).resizable().scaledToFit().frame(width: size, height: size)
            } else {
                Image(uiImage: image).resizable().scaledToFill().frame(width: size, height: size).clipShape(Circle())
            }
        }
    }
}

/// A group's face: up to three members overlapping, bare like the mascots.
/// Mirrors `GroupMark` in `src/components/Avatar.tsx`.
struct GroupMarkView: View {
    let members: [SharedContact]
    let size: CGFloat

    private struct Slot { let x: CGFloat; let y: CGFloat; let s: CGFloat }

    var body: some View {
        let shown = Array(members.prefix(3))
        let slots: [Slot] = shown.count == 2
            ? [Slot(x: 0, y: 0.06, s: 0.66), Slot(x: 0.36, y: 0.32, s: 0.64)]
            : [Slot(x: 0.24, y: 0, s: 0.52), Slot(x: 0, y: 0.44, s: 0.54), Slot(x: 0.46, y: 0.44, s: 0.54)]
        ZStack(alignment: .topLeading) {
            if shown.count <= 1 {
                if let only = shown.first { face(only, size) }
                else { Image(systemName: "person.2.fill").font(.system(size: size * 0.4)).frame(width: size, height: size) }
            } else {
                ForEach(Array(shown.enumerated()), id: \.element.id) { index, member in
                    face(member, (slots[index].s * size).rounded())
                        .offset(x: slots[index].x * size, y: slots[index].y * size)
                        .zIndex(Double(index))
                }
            }
        }
        .frame(width: size, height: size, alignment: .topLeading)
    }

    @ViewBuilder private func face(_ member: SharedContact, _ px: CGFloat) -> some View {
        if member.kind == "bot" {
            MausAvatar(color: member.color ?? "green", size: px, bodyId: member.mascotBody, animated: false)
        } else if let avatar = member.avatar, PersonCutout.image(dataURL: avatar) != nil {
            PersonPhotoView(dataURL: avatar, size: px)
        } else {
            ProfileAvatar(name: member.name, size: px)
        }
    }

    /// Everyone but me first, so the mark shows who else is here.
    static func faces(_ room: SharedRoomSummary, contacts: [SharedContact], selfID: String?) -> [SharedContact] {
        let order = room.memberIds.filter { $0 != selfID } + (selfID.map { [$0] } ?? [])
        return order.compactMap { id in contacts.first { $0.id == id } }
    }
}
