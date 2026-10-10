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

public enum GlyphFaceState: String, CaseIterable, Codable, Sendable {
    case idle, thinking, searching, working, waiting, finished, happy, failed, asleep
}

public enum GlyphAccentAnchor: String, Codable, Sendable {
    case left
    case topRight = "top-right"
    case split
}

public struct GlyphFace: Codable, Equatable, Sendable {
    public let left: String
    public let right: String
    public let accent: String?
    public let anchor: GlyphAccentAnchor?
}

public struct GlyphAccentPlacement: Codable, Equatable, Sendable {
    /// Box centre from the body centre, in body diameters.
    public let x: CGFloat
    public let y: CGFloat
    /// Box side, in body diameters.
    public let box: CGFloat
    /// Stroke width in the 24 box.
    public let stroke: CGFloat
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
    /// desktop's `EXPRESSION_STATES`, name for name. Anything else rests on idle.
    static let expressionStates: [String: GlyphFaceState] = [
        "idle": .idle, "thinking": .thinking, "searching": .searching, "working": .working,
        "waiting": .waiting, "finished": .finished, "happy": .happy, "failed": .failed,
        "sleeping": .asleep, "waking": .idle, "listening": .searching,
        "excited": .happy, "surprised": .waiting, "suspicious": .thinking, "angry": .waiting,
        "drowsy": .idle, "curious": .thinking, "confused": .thinking, "bored": .idle,
        "proud": .finished, "shy": .happy, "sad": .idle, "laughing": .finished,
        "scared": .waiting, "playful": .happy, "celebrate": .finished,
        "orbit": .searching, "radar": .searching, "progress": .working,
        "spawning": .idle, "humming": .idle, "loading": .working, "dictating": .searching,
        "writing": .working, "sending": .working, "receiving": .searching, "uploading": .working,
        "notifying": .waiting, "alerting": .waiting, "dragging": .working, "bouncing": .happy,
        "powering-down": .idle,
        "deadpan": .idle, "friendly": .happy, "focused": .working, "sleepy": .idle,
        "skeptical": .thinking, "worried": .waiting, "mischievous": .happy,
        "none": .idle, "arrive": .idle, "switch": .idle, "customize": .idle, "alert": .waiting,
        "launch": .working, "success": .finished, "blink": .idle, "surprise": .waiting, "failure": .failed,
        "pending": .waiting, "thanked": .happy, "stopped": .failed, "error": .failed, "dead": .failed,
    ]

    private static let liveStates: Set<GlyphFaceState> = [.thinking, .searching, .working]

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
