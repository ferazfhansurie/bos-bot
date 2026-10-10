// The motion behind a mascot that answers to something live: its own voice on
// a call, a finger on its profile. The resting renderers play a state; these
// turn live input into a pose, one frame at a time. Pure and clocked by the
// caller, so `swift test` can run a whole call through them without a screen.
import CoreGraphics
import Foundation

/// Everything a frame moves. Units are the body's own: gaze is -1...1 per
/// axis (x right, y down), lift is in body heights (up), lean in degrees.
public struct LiveMascotPose: Equatable, Sendable {
    public var gaze: CGPoint = .zero
    /// Its own voice right now, 0 silent ... 1 loud. There is no mouth: the
    /// body pulses and the eyes squash with it.
    public var voice: CGFloat = 0
    /// +1 tall and thin ... -1 short and wide.
    public var stretch: CGFloat = 0
    /// Forward dip of a nod; 0 is upright, 1 the bottom of the nod.
    public var nod: CGFloat = 0
    public var lean: CGFloat = 0
    public var lift: CGFloat = 0
    /// Eye size; above 1 is wide-eyed attention.
    public var eyeScale: CGFloat = 1

    public init(gaze: CGPoint = .zero, voice: CGFloat = 0, stretch: CGFloat = 0, nod: CGFloat = 0,
                lean: CGFloat = 0, lift: CGFloat = 0, eyeScale: CGFloat = 1) {
        self.gaze = gaze; self.voice = voice; self.stretch = stretch; self.nod = nod
        self.lean = lean; self.lift = lift; self.eyeScale = eyeScale
    }

    public static let rest = LiveMascotPose()

    /// Reduce Motion: the body holds still. The eyes still say where it is
    /// looking, and their squash that it is the one talking.
    public var calmed: LiveMascotPose { LiveMascotPose(gaze: gaze, voice: voice, eyeScale: eyeScale) }
}

enum LiveMotion {
    /// Frame-rate independent ease toward a target.
    static func approach(_ value: CGFloat, _ target: CGFloat, rate: CGFloat, dt: CGFloat) -> CGFloat {
        value + (target - value) * (1 - exp(-rate * dt))
    }

    /// A small deterministic hash, so glances land somewhere new each beat
    /// without a random source the tests cannot pin.
    static func hash01(_ n: Double) -> CGFloat {
        let x = sin(n * 127.1 + 311.7) * 43758.5453
        return CGFloat(x - floor(x))
    }

    /// Where an idle face glances: a fresh spot every few seconds, back to
    /// centre half the time, so it reads as looking around and not drifting.
    static func idleGlance(at t: TimeInterval, every period: Double = 3.7) -> CGPoint {
        let beat = floor(t / period)
        guard hash01(beat) > 0.45 else { return .zero }
        return CGPoint(x: (hash01(beat + 17) * 2 - 1) * 0.7, y: (hash01(beat + 41) * 2 - 1) * 0.4)
    }

    /// A jelly wobble after a poke: a decaying wave, gone in about a second.
    static func jelly(since: TimeInterval) -> CGFloat {
        guard since >= 0, since < 1.2 else { return 0 }
        return CGFloat(sin(since * 22) * exp(-since * 5))
    }
}

/// The mascot on a voice call. Its body and eyes follow its own voice (the
/// tts playback level), it looks at you and nods along while the mic hears
/// you, and it drifts off into thought between turns.
public struct CallMascotMotion: Sendable {
    public enum Mode: Sendable { case idle, listening, thinking, speaking }

    private var voice: CGFloat = 0
    private var mic: CGFloat = 0
    private var nod: CGFloat = 0
    private var nodVelocity: CGFloat = 0
    private var lastNod: TimeInterval = -.infinity
    private var gaze: CGPoint = .zero
    private var lean: CGFloat = 0
    private var eyes: CGFloat = 1
    private var last: TimeInterval?

    /// Speech rms sits around 0.02-0.15; this lifts it into 0...1.
    static let gain: CGFloat = 7
    /// A nod's spring: stiff enough to read as a dip, under-damped so it comes
    /// back up past upright a touch, like a real nod.
    static let nodStiffness: CGFloat = 120
    static let nodDamping: CGFloat = 10
    static let nodKick: CGFloat = 7
    /// Never nod faster than this, however busy the mic is.
    static let nodGap: TimeInterval = 0.6
    /// While you keep talking with no clear syllable onsets, nod on this beat.
    static let nodBeat: TimeInterval = 1.7

    public init() {}

    /// One frame. `t` is any monotonic clock in seconds; `speaker` and `mic`
    /// are the raw rms levels the call already measures.
    public mutating func step(at t: TimeInterval, mode: Mode, speaker: Float, mic micLevel: Float) -> LiveMascotPose {
        let dt = CGFloat(min(max(t - (last ?? t), 0), 0.1))
        last = t

        // The voice rises on the attack and falls a little slower, so the
        // body pulses with words rather than buzzing with every buffer.
        let loud = mode == .speaking ? min(1, CGFloat(speaker) * Self.gain) : 0
        voice = LiveMotion.approach(voice, loud, rate: loud > voice ? 32 : 14, dt: dt)

        // Nods: on a syllable onset while you talk, or on a slow beat.
        let heard = mode == .listening ? min(1, CGFloat(micLevel) * Self.gain) : 0
        let onset = heard > 0.3 && heard > mic * 1.35
        mic = LiveMotion.approach(mic, heard, rate: 10, dt: dt)
        if mode == .listening, t - lastNod > Self.nodGap, onset || t - lastNod > Self.nodBeat {
            nodVelocity += Self.nodKick
            lastNod = t
        }
        nodVelocity += (-Self.nodStiffness * nod - Self.nodDamping * nodVelocity) * dt
        nod = min(max(nod + nodVelocity * dt, -0.5), 1)

        let target: (gaze: CGPoint, lean: CGFloat, eyes: CGFloat)
        switch mode {
        case .listening:
            // eyes on you, a little wider: it is paying attention
            target = (CGPoint(x: 0, y: 0.2), 0, 1.12)
        case .speaking:
            target = (CGPoint(x: 0.15 * CGFloat(sin(t * 0.9)), y: 0.05), 2 * CGFloat(sin(t * 1.3)) * voice, 1)
        case .thinking:
            // up and away, toward the question mark, swaying slowly
            target = (CGPoint(x: -0.7 + 0.15 * CGFloat(sin(t * 0.8)), y: -0.75), -5 + 2 * CGFloat(sin(t * 1.1)), 0.95)
        case .idle:
            target = (LiveMotion.idleGlance(at: t), 0, 1)
        }
        gaze.x = LiveMotion.approach(gaze.x, target.gaze.x, rate: 6, dt: dt)
        gaze.y = LiveMotion.approach(gaze.y, target.gaze.y, rate: 6, dt: dt)
        lean = LiveMotion.approach(lean, target.lean, rate: 4, dt: dt)
        eyes = LiveMotion.approach(eyes, target.eyes, rate: 8, dt: dt)

        let breath = mode == .speaking ? 0 : 0.012 * CGFloat(sin(t * 2 * .pi / 3.4))
        return LiveMascotPose(gaze: gaze, voice: voice, stretch: voice * 0.7, nod: nod,
                              lean: lean, lift: breath + voice * 0.03, eyeScale: eyes)
    }
}

/// The mascot on its profile: it watches your finger, leans toward it, and
/// wobbles when you tap it. Left alone it breathes and glances around.
public struct FingerMascotMotion: Sendable {
    /// The finger relative to the mascot's centre, in mascot widths; nil
    /// when nothing is touching.
    public var finger: CGPoint?
    private var pokedAt: TimeInterval?
    private var gaze: CGPoint = .zero
    private var lean: CGFloat = 0
    private var eyes: CGFloat = 1
    private var last: TimeInterval?

    public init() {}

    public mutating func poke(at t: TimeInterval) { pokedAt = t }

    public mutating func step(at t: TimeInterval) -> LiveMascotPose {
        let dt = CGFloat(min(max(t - (last ?? t), 0), 0.1))
        last = t
        var look = LiveMotion.idleGlance(at: t, every: 4.3)
        var tilt: CGFloat = 0
        if let finger {
            // the eyes reach the edge of their travel a body-width away
            let length = max(hypot(finger.x, finger.y), 0.0001)
            let reach = min(length, 1)
            look = CGPoint(x: finger.x / length * reach, y: finger.y / length * reach)
            tilt = max(-8, min(8, finger.x * 10))
        }
        gaze.x = LiveMotion.approach(gaze.x, look.x, rate: finger == nil ? 5 : 18, dt: dt)
        gaze.y = LiveMotion.approach(gaze.y, look.y, rate: finger == nil ? 5 : 18, dt: dt)
        lean = LiveMotion.approach(lean, tilt, rate: 9, dt: dt)
        eyes = LiveMotion.approach(eyes, finger == nil ? 1 : 1.12, rate: 10, dt: dt)
        let wobble = pokedAt.map { LiveMotion.jelly(since: t - $0) } ?? 0
        let breath = 0.012 * CGFloat(sin(t * 2 * .pi / 3.4))
        return LiveMascotPose(gaze: gaze, stretch: wobble * 0.9, lean: lean,
                              lift: breath + (finger == nil ? 0 : 0.02), eyeScale: eyes)
    }
}

public enum LiveMascotColor {
    /// Two colours ("#RRGGBB" or palette names) mixed in sRGB, as "#RRGGBB":
    /// the body's colour partway through a change.
    public static func blend(_ from: String, _ to: String, _ t: CGFloat) -> String {
        let a = rgb(GlyphFaces.resolveColor(from)), b = rgb(GlyphFaces.resolveColor(to))
        let k = min(max(t, 0), 1)
        func mix(_ x: Int, _ y: Int) -> Int { Int((CGFloat(x) + CGFloat(y - x) * k).rounded()) }
        return String(format: "#%02X%02X%02X", mix(a.0, b.0), mix(a.1, b.1), mix(a.2, b.2))
    }

    private static func rgb(_ hex: String) -> (Int, Int, Int) {
        let value = Int(hex.replacingOccurrences(of: "#", with: ""), radix: 16) ?? 0
        return ((value >> 16) & 0xFF, (value >> 8) & 0xFF, value & 0xFF)
    }
}
