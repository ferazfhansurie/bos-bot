// The sheet's per-face motion (src/components/glyph-motion.css), as pure
// functions of time, so the phone plays the same moves on the same beats as
// the desktop. Each named motion is the CSS animation's duration, timing
// function and keyframes; distances are the sheet's px on a 64px body, so a
// caller multiplies `dx`/`dy` by its body diameter / 64.
//
// Also here: when a resting face blinks (`GlyphBlink`, the desktop's
// src/lib/alive-eyes.ts cadence) and where an idle face glances
// (`GlyphIdleGaze`). Both are seeded per bot and need no state, so a Canvas
// can ask for any frame.
import CoreGraphics
import Foundation

/// A 2D transform the motion asks for: translate in sheet px, scale, rotate
/// in degrees, and an opacity. The identity is the resting face.
public struct GlyphMotionFrame: Equatable, Sendable {
    public var dx: CGFloat = 0
    public var dy: CGFloat = 0
    public var sx: CGFloat = 1
    public var sy: CGFloat = 1
    public var rotate: CGFloat = 0
    public var opacity: CGFloat = 1

    public init(dx: CGFloat = 0, dy: CGFloat = 0, sx: CGFloat = 1, sy: CGFloat = 1, rotate: CGFloat = 0, opacity: CGFloat = 1) {
        self.dx = dx; self.dy = dy; self.sx = sx; self.sy = sy; self.rotate = rotate; self.opacity = opacity
    }

    public static let identity = GlyphMotionFrame()
    public var isIdentity: Bool { self == .identity }
}

/// A CSS timing function.
public enum GlyphTiming: Sendable {
    case linear, ease, easeIn, easeOut, easeInOut, stepStart
    case bezier(CGFloat, CGFloat, CGFloat, CGFloat)

    func callAsFunction(_ x: CGFloat) -> CGFloat {
        switch self {
        case .linear: return x
        case .stepStart: return 0 // steps(1): hold the segment's first value
        case .ease: return Self.cubic(0.25, 0.1, 0.25, 1, x)
        case .easeIn: return Self.cubic(0.42, 0, 1, 1, x)
        case .easeOut: return Self.cubic(0, 0, 0.58, 1, x)
        case .easeInOut: return Self.cubic(0.42, 0, 0.58, 1, x)
        case let .bezier(x1, y1, x2, y2): return Self.cubic(x1, y1, x2, y2, x)
        }
    }

    /// y on the cubic-bezier(x1, y1, x2, y2) curve at progress x.
    static func cubic(_ x1: CGFloat, _ y1: CGFloat, _ x2: CGFloat, _ y2: CGFloat, _ x: CGFloat) -> CGFloat {
        if x <= 0 { return 0 }
        if x >= 1 { return 1 }
        func bez(_ a: CGFloat, _ b: CGFloat, _ t: CGFloat) -> CGFloat {
            let u = 1 - t
            return 3 * u * u * t * a + 3 * u * t * t * b + t * t * t
        }
        // bisect t for x; the curve's x is monotonic for 0 <= x1, x2 <= 1
        var lo: CGFloat = 0, hi: CGFloat = 1, t = x
        for _ in 0..<24 {
            t = (lo + hi) / 2
            if bez(x1, x2, t) < x { lo = t } else { hi = t }
        }
        return bez(y1, y2, t)
    }
}

/// One CSS @keyframes animation. Transform and opacity are separate tracks,
/// the way CSS interpolates them: a keyframe that only names opacity leaves
/// the transform to its neighbours. Missing 0%/100% frames are the identity.
public struct GlyphKeyframes: Sendable {
    public let duration: Double
    public let timing: GlyphTiming
    let transform: [(CGFloat, GlyphMotionFrame)]
    let opacity: [(CGFloat, CGFloat)]

    init(_ duration: Double, _ timing: GlyphTiming, transform: [(CGFloat, GlyphMotionFrame)] = [], opacity: [(CGFloat, CGFloat)] = []) {
        self.duration = duration
        self.timing = timing
        self.transform = Self.closed(transform, identity: GlyphMotionFrame.identity)
        self.opacity = opacity.isEmpty ? [] : Self.closed(opacity, identity: 1)
    }

    private static func closed<V>(_ frames: [(CGFloat, V)], identity: V) -> [(CGFloat, V)] {
        guard !frames.isEmpty else { return [] }
        var out = frames.sorted { $0.0 < $1.0 }
        if out.first!.0 > 0 { out.insert((0, identity), at: 0) }
        if out.last!.0 < 1 { out.append((1, identity)) }
        return out
    }

    /// The frame `seconds` into the loop.
    public func frame(at seconds: Double) -> GlyphMotionFrame {
        let p = CGFloat((seconds / duration).truncatingRemainder(dividingBy: 1))
        let progress = p < 0 ? p + 1 : p
        var frame = transform.isEmpty ? .identity : Self.sample(transform, at: progress, timing: timing, mix: Self.mix)
        if !opacity.isEmpty { frame.opacity = Self.sample(opacity, at: progress, timing: timing) { a, b, k in a + (b - a) * k } }
        return frame
    }

    private static func sample<V>(_ frames: [(CGFloat, V)], at p: CGFloat, timing: GlyphTiming, mix: (V, V, CGFloat) -> V) -> V {
        for i in 1..<frames.count where p <= frames[i].0 {
            let (a, va) = frames[i - 1], (b, vb) = frames[i]
            let span = b - a
            return span <= 0 ? vb : mix(va, vb, timing((p - a) / span))
        }
        return frames.last!.1
    }

    private static func mix(_ a: GlyphMotionFrame, _ b: GlyphMotionFrame, _ k: CGFloat) -> GlyphMotionFrame {
        GlyphMotionFrame(dx: a.dx + (b.dx - a.dx) * k, dy: a.dy + (b.dy - a.dy) * k,
                         sx: a.sx + (b.sx - a.sx) * k, sy: a.sy + (b.sy - a.sy) * k,
                         rotate: a.rotate + (b.rotate - a.rotate) * k, opacity: a.opacity + (b.opacity - a.opacity) * k)
    }
}

public enum GlyphMotionCurves {
    private typealias F = GlyphMotionFrame
    private static func t(_ dx: CGFloat, _ dy: CGFloat) -> F { F(dx: dx, dy: dy) }
    private static func s(_ x: CGFloat, _ y: CGFloat? = nil) -> F { F(sx: x, sy: y ?? x) }

    /// The eye pair's motions, moved in screen space about the face centre
    /// at eye height. spin, twinkle and beat live in `eachEye`.
    public static let eyes: [String: GlyphKeyframes] = [
        "look": GlyphKeyframes(3.2, .easeInOut, transform: [(0, .identity), (0.2, .identity), (0.3, t(-5, 0)), (0.45, t(-5, 0)),
                                                            (0.55, t(5, -1)), (0.75, t(5, -1)), (1, .identity)]),
        "lean": GlyphKeyframes(2, .easeInOut, transform: [(0, t(2, 4)), (0.5, t(3, 5)), (1, t(2, 4))]),
        "drift": GlyphKeyframes(3, .easeInOut, transform: [(0, t(4, -5)), (0.5, t(1, -6)), (1, t(4, -5))]),
        "scan": GlyphKeyframes(2.2, .easeInOut, transform: [(0, t(-5, 0)), (0.5, t(5, 0)), (1, t(-5, 0))]),
        "read": GlyphKeyframes(2.4, .stepStart, transform: [(0, t(-5, -2)), (0.16, t(0, -2)), (0.33, t(5, -2)),
                                                            (0.5, t(-5, 2)), (0.66, t(0, 2)), (0.83, t(5, 2))]),
        "bob": GlyphKeyframes(0.9, .easeInOut, transform: [(0, t(0, 4)), (0.5, t(1, 5.5)), (1, t(0, 4))]),
        "pulse": GlyphKeyframes(1.6, .easeInOut, transform: [(0, .identity), (0.5, s(1.14)), (1, .identity)]),
        "pop": GlyphKeyframes(2.4, .bezier(0.3, 1.6, 0.5, 1), transform: [(0, .identity), (0.6, .identity), (0.7, s(1.35)), (1, .identity)]),
        "shake": GlyphKeyframes(0.45, .linear, transform: [(0, .identity), (0.25, t(-1.5, 0)), (0.75, t(1.5, 0)), (1, .identity)]),
        "breathe": GlyphKeyframes(3.6, .easeInOut, transform: [(0, .identity), (0.5, t(0, 1.5)), (1, .identity)]),
        "slow": GlyphKeyframes(5, .easeInOut, transform: [(0, s(1, 0.45)), (0.4, s(1, 0.45)), (0.6, s(1, 0.1)), (0.7, s(1, 0.1)), (1, s(1, 0.45))]),
        "tilt": GlyphKeyframes(2.6, .easeInOut, transform: [(0, .identity), (0.5, F(rotate: -10)), (1, .identity)]),
        "giggle": GlyphKeyframes(0.35, .easeInOut, transform: [(0, .identity), (0.5, t(0, -2)), (1, .identity)]),
    ]

    /// Motions that turn each eye about its own centre.
    public static let eachEye: [String: GlyphKeyframes] = [
        "spin": GlyphKeyframes(1.4, .linear, transform: [(0, .identity), (1, F(rotate: 360))]),
        "twinkle": GlyphKeyframes(1.2, .easeInOut, transform: [(0, .identity), (0.5, F(sx: 0.8, sy: 0.8, rotate: 30)), (1, .identity)]),
        "beat": GlyphKeyframes(1, .easeInOut, transform: [(0, .identity), (0.15, s(1.25)), (0.3, .identity), (0.45, s(1.18)), (1, .identity)]),
    ]

    /// The accent's motions; burst and ring turn about the accent's centre.
    public static let accent: [String: GlyphKeyframes] = [
        "fly": GlyphKeyframes(2, .easeIn, transform: [(0, t(-14, 10)), (1, t(14, -14))], opacity: [(0, 0), (0.2, 1), (1, 0)]),
        "float": GlyphKeyframes(2.6, .easeInOut, transform: [(0, .identity), (0.5, t(0, -4)), (1, .identity)]),
        "burst": GlyphKeyframes(2.4, .easeOut, transform: [(0, s(0.3)), (0.55, s(0.3)), (0.7, s(1.1)), (1, s(1.4))],
                                opacity: [(0, 0), (0.55, 0), (0.7, 1), (1, 0)]),
        "pulse": GlyphKeyframes(1, .easeInOut, opacity: [(0, 0.4), (0.5, 1), (1, 0.4)]),
        "ring": GlyphKeyframes(0.5, .linear, transform: [(0, F(rotate: -12)), (0.5, F(rotate: 12)), (1, F(rotate: -12))]),
        "slide": GlyphKeyframes(1.6, .easeInOut, transform: [(0, t(-6, 0)), (1, t(10, 0))], opacity: [(0, 0), (0.4, 1), (1, 0)]),
    ]

    /// The whole body's motions, about the point it stands on.
    public static let body: [String: GlyphKeyframes] = [
        "hop": GlyphKeyframes(2.4, .bezier(0.3, 1.4, 0.5, 1), transform: [(0, .identity), (0.55, .identity), (0.62, s(1.1, 0.88)),
                                                                          (0.72, F(dy: -9, sx: 0.94, sy: 1.06)), (0.84, s(1.06, 0.94)), (1, .identity)]),
        "squish": GlyphKeyframes(3.6, .easeInOut, transform: [(0, .identity), (0.5, s(1.03, 0.97)), (1, .identity)]),
        "stretch": GlyphKeyframes(3.2, .easeInOut, transform: [(0, .identity), (0.3, .identity), (0.5, s(0.9, 1.16)), (0.65, s(0.9, 1.16)),
                                                               (0.75, s(1.08, 0.92)), (1, .identity)]),
        "giggle": GlyphKeyframes(0.35, .easeInOut, transform: [(0, .identity), (0.5, s(1.04, 0.96)), (1, .identity)]),
        "tap": GlyphKeyframes(1.2, .easeInOut, transform: [(0, .identity), (0.2, t(0, -3)), (0.4, .identity), (1, .identity)]),
    ]

    /// Every frame a face's motion asks for `seconds` after the face appeared.
    public static func frames(_ motion: GlyphMotion, at seconds: Double) -> (eyes: GlyphMotionFrame, eachEye: GlyphMotionFrame,
                                                                             accent: GlyphMotionFrame, body: GlyphMotionFrame) {
        let name = motion.eyes
        return (eyes: name.flatMap { eyes[$0] }?.frame(at: seconds) ?? .identity,
                eachEye: name.flatMap { eachEye[$0] }?.frame(at: seconds) ?? .identity,
                accent: motion.accent.flatMap { accent[$0] }?.frame(at: seconds) ?? .identity,
                body: motion.body.flatMap { body[$0] }?.frame(at: seconds) ?? .identity)
    }

    /// True when the face's own eye motion already closes the eyes (a slow
    /// blink), or its eyes are shut, so a random blink leaves them be.
    public static func skipsBlink(_ face: GlyphFace) -> Bool {
        face.motion.eyes == "slow" || face.left == "lid"
    }
}

/// Random blinks, now and then a double, never a fixed loop
/// (src/lib/alive-eyes.ts): a resting face blinks every 6–14s, one blink in
/// seven comes as a pair 380ms apart, and each blink squashes the eyes to 8%
/// over 180ms. Seeded per bot so a list of faces never blinks in sync.
public enum GlyphBlink {
    public static let rest: ClosedRange<Double> = 6...14
    public static let doubleChance = 1.0 / 7
    public static let doubleGap = 0.38
    public static let duration = 0.18

    /// The blink times around `seconds`, for a stable seed. Time is cut into
    /// windows the length of the slowest gap; each window holds one blink at
    /// a seeded spot, so consecutive blinks land 0–2x the window apart and
    /// average the cadence's middle.
    static func blinks(near seconds: Double, seed: UInt64, slow: Bool) -> [Double] {
        let window = (rest.lowerBound + rest.upperBound) / 2 * (slow ? 2 : 1)
        let index = Int64((seconds / window).rounded(.down))
        var times: [Double] = []
        for i in (index - 1)...(index + 1) {
            let r1 = unit(seed, i, 1), r2 = unit(seed, i, 2)
            let at = (Double(i) + r1) * window
            times.append(at)
            if r2 < doubleChance { times.append(at + doubleGap) }
        }
        return times
    }

    /// Eye height multiplier at `seconds`: 1 open, 0.08 shut at mid-blink.
    public static func openness(at seconds: Double, seed: UInt64, slow: Bool = false) -> CGFloat {
        for start in blinks(near: seconds, seed: seed, slow: slow) {
            let into = seconds - start
            guard into >= 0, into < duration else { continue }
            // bos-avatar-blink: 50% { scaleY(.08) }, ease-in-out
            let half = into < duration / 2 ? into / (duration / 2) : (duration - into) / (duration / 2)
            return 1 - 0.92 * GlyphTiming.easeInOut(CGFloat(half))
        }
        return 1
    }

    /// A stable seed from a bot's id or colour.
    public static func seed(_ key: String) -> UInt64 {
        var hash: UInt64 = 1469598103934665603
        for byte in key.utf8 { hash = (hash ^ UInt64(byte)) &* 1099511628211 }
        return hash
    }

    /// A deterministic 0..<1 for (seed, window, salt).
    static func unit(_ seed: UInt64, _ index: Int64, _ salt: UInt64) -> Double {
        var x = seed &+ UInt64(bitPattern: index) &* 0x9E3779B97F4A7C15 &+ salt &* 0xBF58476D1CE4E5B9
        x = (x ^ (x >> 30)) &* 0xBF58476D1CE4E5B9
        x = (x ^ (x >> 27)) &* 0x94D049BB133111EB
        x ^= x >> 31
        return Double(x >> 11) / Double(1 << 53)
    }
}

/// Where a resting face looks while nobody touches it: now and then a glance
/// to one side or up, held a moment, then back to the middle. In body
/// diameters before the tilt, like a face's own gaze. Seeded per bot.
public enum GlyphIdleGaze {
    static let window = 7.0
    static let chance = 0.35
    static let hold = 1.4
    static let ease = 0.25

    public static func offset(at seconds: Double, seed: UInt64) -> CGSize {
        let index = Int64((seconds / window).rounded(.down))
        guard GlyphBlink.unit(seed, index, 11) < chance else { return .zero }
        let start = Double(index) * window + GlyphBlink.unit(seed, index, 12) * (window - hold)
        let into = seconds - start
        guard into >= 0, into < hold else { return .zero }
        let k = into < ease ? into / ease : into > hold - ease ? (hold - into) / ease : 1
        let amount = GlyphTiming.easeInOut(CGFloat(k))
        // the sheet's look: about 5 sheet px aside, a touch up
        let side: CGFloat = GlyphBlink.unit(seed, index, 13) < 0.5 ? -1 : 1
        let up = GlyphBlink.unit(seed, index, 14) < 0.3
        let x = up ? 0.02 * side : 0.078 * side
        let y: CGFloat = up ? -0.06 : -0.016
        return CGSize(width: x * amount, height: y * amount)
    }
}
