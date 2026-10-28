// Glyph mascot faces: a flat body, two bold stroked glyph eyes, and one
// accent glyph floating outside the body.
//
// The table is not written here. `Resources/glyph-faces.json` is generated
// from `shared/glyph-faces.ts` (`pnpm gen:glyphs`) and golden-tested against
// it, so desktop and phone draw the same face for the same state. This file
// reads that json, parses the paths once, and ports the three small rules
// the desktop applies around it: `glyphStateFor`, `resolveMausColor` and
// `glyphInk`. Drawing lives in the app (`GlyphMark`).
import CoreGraphics
import Foundation

/// The B sharp-dots emote set (2026-10-27), in the table's order. Raw values
/// are the desktop's names; `CaseIterable` order is `document.states`.
public enum GlyphFaceState: String, CaseIterable, Codable, Sendable {
    // home base
    case idle, glance, listening, noticed, drowsy, asleep
    // working, from the real tool
    case thinking, searching, reading, writing, working, focused, sending
    case waiting, finished
    case nailedIt = "nailed-it"
    // feelings
    case happy, love, excited, surprised, confused, skeptical, determined
    case sad, scared, shy, wink, dizzy, failed
    // more life
    case waking, yawn, curious, proud, laughing
    case mindBlown = "mind-blown"
    case celebrate, nervous, bored, voice, calling
    case handingOff = "handing-off"
    case waitingMate = "waiting-mate"
    // cash only
    case kaChing = "ka-ching"
}

public enum GlyphAccentAnchor: String, Codable, Sendable {
    case left
    case topRight = "top-right"
    case split
    /// on the body, under the eyes (a blush)
    case cheek
    /// under the body (a pencil, a hand-off arrow)
    case below
}

/// One stroke of an eye: a glyph and its stroke weight as a multiple of the
/// table's stroke. A heavy round-cap `dot` (3.2) is the resting eye; brows and
/// lids are extra parts in the same eye box.
public struct GlyphEyePart: Codable, Equatable, Sendable {
    public let glyph: String
    public let weight: CGFloat
    public init(glyph: String, weight: CGFloat = 1) { self.glyph = glyph; self.weight = weight }
}

/// The sheet's motion names for a face; a still surface ignores them. Times
/// and curves: `GlyphMotionCurves` in the app (src/components/glyph-motion.css).
public struct GlyphMotion: Codable, Equatable, Sendable {
    public let eyes: String?
    public let accent: String?
    public let body: String?
    public init(eyes: String? = nil, accent: String? = nil, body: String? = nil) {
        self.eyes = eyes; self.accent = accent; self.body = body
    }
}

public struct GlyphFace: Codable, Equatable, Sendable {
    /// each eye's main glyph (its first part)
    public let left: String
    public let right: String
    public let accent: String?
    public let anchor: GlyphAccentAnchor?
    /// every part of each eye, main glyph first
    public let leftParts: [GlyphEyePart]
    public let rightParts: [GlyphEyePart]
    /// where the eyes look: both shift by [x, y] body diameters, before the tilt
    public let gaze: [CGFloat]
    public let motion: GlyphMotion

    public init(left: String, right: String, accent: String?, anchor: GlyphAccentAnchor?,
                leftParts: [GlyphEyePart]? = nil, rightParts: [GlyphEyePart]? = nil,
                gaze: [CGFloat] = [0, 0], motion: GlyphMotion = GlyphMotion()) {
        self.left = left; self.right = right; self.accent = accent; self.anchor = anchor
        self.leftParts = leftParts ?? [GlyphEyePart(glyph: left)]
        self.rightParts = rightParts ?? [GlyphEyePart(glyph: right)]
        self.gaze = gaze; self.motion = motion
    }

    public var gazeOffset: CGSize { CGSize(width: gaze.first ?? 0, height: gaze.count > 1 ? gaze[1] : 0) }
}

public struct GlyphAccentPlacement: Codable, Equatable, Sendable {
    /// Box centre from the body centre, in body diameters.
    public let x: CGFloat
    public let y: CGFloat
    /// Box side, in body diameters.
    public let box: CGFloat
    /// Stroke width in the 24 box.
    public let stroke: CGFloat
    /// Set on accents drawn on the body itself: they take the colour opposite
    /// the eyes at this alpha.
    public let onBodyAlpha: CGFloat?
}

public struct GlyphLayout: Codable, Equatable, Sendable {
    public let eyeBox: CGFloat
    public let eyeX: CGFloat
    public let eyeY: CGFloat
    public let accent: [String: GlyphAccentPlacement]
    public let accentMinSize: CGFloat
    public let minStrokePx: CGFloat
}

/// `shared/glyph-faces.json`, as decoded.
public struct GlyphFacesDocument: Codable, Sendable {
    public let version: Int
    public let stroke: CGFloat
    public let tiltDeg: CGFloat
    public let viewBox: CGFloat
    public let states: [String]
    public let faces: [String: GlyphFace]
    public let paths: [String: String]
    public let layout: GlyphLayout
    public let expressions: [String: String]
    public let liveStates: [String]
    public let palette: [String: String]
    public let fallbackColor: String
}

public enum GlyphFaces {
    /// The bundled table. A missing or broken resource is a build mistake the
    /// golden test catches, so this traps rather than drawing nothing.
    public static let document: GlyphFacesDocument = {
        guard let url = Bundle.module.url(forResource: "glyph-faces", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let document = try? JSONDecoder().decode(GlyphFacesDocument.self, from: data)
        else { fatalError("CompanionCore is missing Resources/glyph-faces.json") }
        return document
    }()

    /// Every glyph parsed once, in its 24 box.
    private static let parsed: [String: CGPath] = document.paths.mapValues(parsePath)

    public static var stroke: CGFloat { document.stroke }
    public static var tiltDegrees: CGFloat { document.tiltDeg }
    public static var viewBox: CGFloat { document.viewBox }
    public static var layout: GlyphLayout { document.layout }

    public static func face(_ state: GlyphFaceState) -> GlyphFace {
        document.faces[state.rawValue] ?? document.faces["idle"]!
    }

    /// The glyph's path in its 24 box; an unknown id is an empty path.
    public static func path(_ id: String) -> CGPath {
        parsed[id] ?? CGMutablePath()
    }

    /// The weight a glyph wears when a reader names it without parts (a
    /// look override, a phone-only mood): its weight as the leading part of
    /// the first face that leads with it, else 1. `dot` is 3.2.
    public static func weight(_ glyph: String) -> CGFloat {
        leadWeights[glyph] ?? 1
    }

    private static let leadWeights: [String: CGFloat] = {
        var weights: [String: CGFloat] = [:]
        for state in document.states {
            guard let face = document.faces[state] else { continue }
            for part in [face.leftParts.first, face.rightParts.first].compactMap({ $0 }) where weights[part.glyph] == nil {
                weights[part.glyph] = part.weight
            }
        }
        return weights
    }()

    public static func placement(_ anchor: GlyphAccentAnchor) -> GlyphAccentPlacement? {
        document.layout.accent[anchor.rawValue]
    }

    // MARK: - Paths

    /// Absolute M, L, C and Z only: the table promises nothing else.
    static func parsePath(_ data: String) -> CGPath {
        let path = CGMutablePath()
        var command: Character = "M"
        var numbers: [CGFloat] = []
        var token = ""

        func takeNumber() {
            if let value = Double(token) { numbers.append(CGFloat(value)) }
            token = ""
        }
        func flush() {
            takeNumber()
            switch command {
            case "M":
                var i = 0
                while i + 1 < numbers.count {
                    let point = CGPoint(x: numbers[i], y: numbers[i + 1])
                    if i == 0 { path.move(to: point) } else { path.addLine(to: point) }
                    i += 2
                }
            case "L":
                var i = 0
                while i + 1 < numbers.count {
                    path.addLine(to: CGPoint(x: numbers[i], y: numbers[i + 1]))
                    i += 2
                }
            case "C":
                var i = 0
                while i + 5 < numbers.count {
                    path.addCurve(
                        to: CGPoint(x: numbers[i + 4], y: numbers[i + 5]),
                        control1: CGPoint(x: numbers[i], y: numbers[i + 1]),
                        control2: CGPoint(x: numbers[i + 2], y: numbers[i + 3]))
                    i += 6
                }
            case "Z":
                if !path.isEmpty { path.closeSubpath() }
            default:
                break
            }
            numbers.removeAll()
        }

        for character in data {
            switch character {
            case "M", "L", "C", "Z":
                flush()
                command = character
            case "-":
                takeNumber()
                token = "-"
            case " ", ",", "\n":
                takeNumber()
            default:
                token.append(character)
            }
        }
        flush()
        return path
    }

    // MARK: - State

    /// Every expression name the apps use, mapped to a glyph face — the
    /// desktop's `EXPRESSION_STATES`, name for name: every face maps to
    /// itself, then the aliases. Anything else rests on idle.
    static let expressionStates: [String: GlyphFaceState] = {
        var map = Dictionary(uniqueKeysWithValues: GlyphFaceState.allCases.map { ($0.rawValue, $0) })
        let aliases: [String: GlyphFaceState] = [
            // tool poses (shared/mascot-choreography.ts toolGesture)
            "browsing": .searching,
            // the sheet's own words
            "rest": .idle, "needs-you": .waiting, "done": .finished, "nailed": .nailedIt, "mind blown": .mindBlown,
            "handoff": .handingOff, "kaching": .kaChing, "waking-up": .waking,
            // CursorAvatar lifecycle
            "sleeping": .asleep, "spawning": .noticed, "humming": .idle,
            // CursorAvatar reactions
            "suspicious": .skeptical, "angry": .determined, "playful": .wink,
            // CursorAvatar agent morphs
            "orbit": .searching, "radar": .searching, "progress": .working,
            // CursorAvatar product cycle
            "loading": .working, "dictating": .voice, "receiving": .reading, "uploading": .sending,
            "notifying": .waiting, "alerting": .waiting, "dragging": .working, "bouncing": .happy,
            "powering-down": .drowsy,
            // legacy ten-face names
            "deadpan": .idle, "friendly": .happy, "sleepy": .drowsy, "worried": .nervous, "mischievous": .wink,
            // MAUS_MOTIONS
            "none": .idle, "arrive": .noticed, "switch": .glance, "customize": .happy, "alert": .waiting,
            "launch": .working, "success": .finished, "blink": .idle, "surprise": .surprised, "failure": .failed,
            // plain words the plan's table uses
            "pending": .waiting, "thanked": .happy, "stopped": .sad, "error": .failed, "dead": .failed,
            // voice calls
            "ringing": .calling, "speaking": .voice,
        ]
        map.merge(aliases) { _, alias in alias }
        return map
    }()

    /// Faces that already describe a live turn; a working bot keeps one of
    /// these instead of being flattened to `working`.
    private static let liveStates: Set<GlyphFaceState> = [
        .thinking, .searching, .reading, .writing, .working, .focused, .sending,
        .confused, .skeptical, .determined, .nervous, .voice, .calling, .handingOff, .waitingMate,
    ]

    /// The desktop's `glyphStateFor`. `activity` is the wire `BotActivity`
    /// ("working", "waiting-on-you", "idle", "no-signal", "dead").
    public static func state(for expression: String?, activity: String? = nil) -> GlyphFaceState {
        let fromExpression = expression.flatMap { expressionStates[$0] } ?? .idle
        switch activity {
        case "dead": return .failed
        case "waiting-on-you": return .waiting
        case "working": return liveStates.contains(fromExpression) ? fromExpression : .working
        default: return fromExpression
        }
    }

    // MARK: - Colour

    /// A bot colour as "#RRGGBB": a palette name maps to its hex, a 6-digit
    /// hex passes through uppercased, anything else is the fallback green.
    public static func resolveColor(_ color: String?) -> String {
        guard let color else { return document.fallbackColor }
        if let named = document.palette[color] { return named }
        if isHex(color) { return color.uppercased() }
        return document.fallbackColor
    }

    public static func isHex(_ value: String) -> Bool {
        let scalars = Array(value.unicodeScalars)
        guard scalars.count == 7, scalars[0] == "#" else { return false }
        return scalars.dropFirst().allSatisfy { ("0"..."9").contains($0) || ("a"..."f").contains($0) || ("A"..."F").contains($0) }
    }

    /// The 13 named colours in the desktop's order, for the preset swatches.
    public static let paletteNames = [
        "green", "blue", "red", "orange", "purple", "cyan", "pink",
        "yellow", "teal", "coral", "white", "brown", "gray",
    ]

    /// WCAG 2 relative luminance of anything `resolveColor` accepts.
    public static func luminance(_ color: String) -> Double {
        let hex = resolveColor(color)
        func channel(_ offset: Int) -> Double {
            let start = hex.index(hex.startIndex, offsetBy: offset)
            let value = Double(Int(hex[start..<hex.index(start, offsetBy: 2)], radix: 16) ?? 0) / 255
            return value <= 0.04045 ? value / 12.92 : pow((value + 0.055) / 1.055, 2.4)
        }
        return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5)
    }

    /// Eye colour for a body: black when black contrasts at least as well as
    /// white, else white. The desktop's `glyphInk`.
    public static func ink(_ color: String) -> String {
        let l = luminance(color)
        return (l + 0.05) / 0.05 >= 1.05 / (l + 0.05) ? "#000000" : "#FFFFFF"
    }

    /// Contrast ratio between two colours `resolveColor` accepts.
    public static func contrast(_ a: String, _ b: String) -> Double {
        let la = luminance(a), lb = luminance(b)
        return (max(la, lb) + 0.05) / (min(la, lb) + 0.05)
    }
}
