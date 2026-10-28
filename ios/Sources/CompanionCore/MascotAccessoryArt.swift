// How mascot accessories are drawn: the desktop's
// `shared/mascot-accessory-art.ts`, number for number. Every piece is flat
// art in the flat bodies' 100-unit box, placed from the body's own outline
// (`anchors`), so a new body needs no hand-tuned numbers.
//
// This half is pure CoreGraphics: `shapes` returns finished paths already
// placed in the 100 box, with their paint, so it can be tested without a
// screen. `MascotAccessoryArt.draw` and `MascotAccessoriesLayer` (in
// MascotAccessoryView.swift) put them on a SwiftUI canvas.
import CoreGraphics
import Foundation

/// Where a face's eyes sit, in the body's 100 box. Eye and mouth pieces ride
/// it; hats and neckwear are anchored around its centre.
public struct MascotFace: Equatable, Sendable {
    /// The face centre the eyes are laid out around.
    public var centre: CGPoint
    /// The body diameter the eye spacing is measured in (80 on desktop).
    public var diameter: CGFloat
    /// A glance, in body diameters before the tilt (`GlyphLook.eyeShift`).
    public var shift: CGSize
    /// The face's tilt in degrees; the glyph face leans, classic eyes don't.
    public var tilt: CGFloat

    public init(centre: CGPoint, diameter: CGFloat = 80, shift: CGSize = .zero, tilt: CGFloat = GlyphFaces.tiltDegrees) {
        self.centre = centre
        self.diameter = diameter
        self.shift = shift
        self.tilt = tilt
    }

    /// The phone's glyph face: eyes on the body's mass, spaced by its
    /// shorter side (what `GlyphMark` draws).
    public static func glyph(bodyId: String?) -> MascotFace {
        let body = FlatMascotBodies.body(bodyId)
        let bounds = FlatMascotBodies.outline(body.id).boundingBoxOfPath
        return MascotFace(centre: massCentres[body.id] ?? CGPoint(x: bounds.midX, y: bounds.midY),
                          diameter: min(bounds.width, bounds.height))
    }

    /// Classic (non-glyph) eyes, as `MascotEyeStyle.paths` lays them out:
    /// centred on (53.25, 45), 20 apart, upright, shifted by half the
    /// catalog's face offset like the desktop's live mascot.
    public static func classic(bodyId: String?) -> MascotFace {
        let body = FlatMascotBodies.body(bodyId)
        return classic(centre: CGPoint(x: 53.25 + body.faceX * 0.5, y: 45 + body.faceY))
    }

    /// Classic eyes whose centre the caller already knows (an animated pose).
    public static func classic(centre: CGPoint) -> MascotFace {
        // glasses 20 apart instead of the glyph face's 35.2
        MascotFace(centre: centre, diameter: 56, tilt: 0)
    }

    /// Area centroid of every body in its 100 box, sampled once.
    public static let massCentres: [String: CGPoint] = Dictionary(uniqueKeysWithValues: FlatMascotBodies.all.map { body in
        let outline = FlatMascotBodies.outline(body.id)
        var sum = CGPoint.zero, count = 0.0
        for y in stride(from: 1.0, to: 100, by: 2) {
            for x in stride(from: 1.0, to: 100, by: 2) where outline.contains(CGPoint(x: x, y: y)) {
                sum.x += x; sum.y += y; count += 1
            }
        }
        return (body.id, count > 0 ? CGPoint(x: sum.x / count, y: sum.y / count) : CGPoint(x: 50, y: 50))
    })
}

/// The desktop's `AccessoryAnchors`, in the 100 box.
public struct MascotAccessoryAnchors: Equatable, Sendable {
    /// Face centre the eyes are laid out around.
    public var centre: CGPoint
    /// Where a hat sits: the body's top above the face, and its width there.
    public var head: (x: CGFloat, y: CGFloat, width: CGFloat)
    /// The body's sides at eye level, for headphone cups.
    public var sides: (left: CGFloat, right: CGFloat)
    /// The body's bottom edge below the face, and its span a little above it.
    public var neck: (x: CGFloat, y: CGFloat, width: CGFloat, left: CGFloat, right: CGFloat)

    public static func == (a: Self, b: Self) -> Bool {
        a.centre == b.centre && a.head == b.head && a.sides == b.sides && a.neck == b.neck
    }
}

/// One finished piece of accessory art, placed in the body's 100 box.
public struct MascotAccessoryShape: @unchecked Sendable {
    public var slot: MascotAccessorySlot
    public var path: CGPath
    /// "#RRGGBB", or nil for no fill.
    public var fill: String?
    public var fillOpacity: Double = 1
    public var stroke: String?
    public var strokeOpacity: Double = 1
    /// Already scaled with the piece, in 100-box units.
    public var lineWidth: CGFloat = 0
    public var lineCap: CGLineCap = .butt
    public var lineJoin: CGLineJoin = .miter
}

public enum MascotAccessoryArt {
    // MARK: - Geometry

    private final class OutlineCache: @unchecked Sendable {
        let lock = NSLock()
        var points: [String: [CGPoint]] = [:]
    }
    private static let outlineCache = OutlineCache()

    /// Dense points along a body outline (absolute M/C/Z, as the flat bodies
    /// are authored): the M point, then 24 samples per cubic.
    static func outlinePoints(_ path: String) -> [CGPoint] {
        outlineCache.lock.lock()
        let hit = outlineCache.points[path]
        outlineCache.lock.unlock()
        if let hit { return hit }
        let regex = try! NSRegularExpression(pattern: "[MCZ]|-?\\d*\\.?\\d+")
        let ns = path as NSString
        let tokens = regex.matches(in: path, range: NSRange(location: 0, length: ns.length)).map { ns.substring(with: $0.range) }
        var points: [CGPoint] = []
        var i = 0
        var pen = CGPoint.zero
        var command = ""
        func n(_ k: Int) -> CGFloat { i + k < tokens.count ? CGFloat(Double(tokens[i + k]) ?? .nan) : .nan }
        while i < tokens.count {
            let t = tokens[i]
            if t == "M" || t == "C" || t == "Z" { command = t; i += 1; if t == "Z" { continue } }
            if command == "M" {
                pen = CGPoint(x: n(0), y: n(1)); points.append(pen); i += 2
            } else if command == "C" {
                let (x0, y0) = (pen.x, pen.y)
                let (x1, y1, x2, y2, x3, y3) = (n(0), n(1), n(2), n(3), n(4), n(5))
                for s in 1...24 {
                    let u = CGFloat(s) / 24, v = 1 - u
                    points.append(CGPoint(
                        x: v * v * v * x0 + 3 * v * v * u * x1 + 3 * v * u * u * x2 + u * u * u * x3,
                        y: v * v * v * y0 + 3 * v * v * u * y1 + 3 * v * u * u * y2 + u * u * u * y3))
                }
                pen = CGPoint(x: x3, y: y3)
                i += 6
            } else {
                i += 1
            }
        }
        outlineCache.lock.lock()
        outlineCache.points[path] = points
        outlineCache.lock.unlock()
        return points
    }

    static func edgeAt(_ points: [CGPoint], _ x: CGFloat, top: Bool) -> CGFloat {
        for band: CGFloat in [2.5, 6, 12, 50] {
            let ys = points.filter { abs($0.x - x) <= band }.map(\.y)
            if let edge = top ? ys.min() : ys.max() { return edge }
        }
        return top ? 10 : 90
    }

    static func spanAt(_ points: [CGPoint], _ y: CGFloat) -> (CGFloat, CGFloat) {
        for band: CGFloat in [2, 5, 10, 50] {
            let xs = points.filter { abs($0.y - y) <= band }.map(\.x)
            if xs.count >= 2, let lo = xs.min(), let hi = xs.max() { return (lo, hi) }
        }
        return (10, 90)
    }

    /// Anchors for `bodyId` with its face at `centre` (default: the catalog
    /// face offset, the desktop sidebar's placement).
    public static func anchors(bodyId: String?, centre: CGPoint? = nil) -> MascotAccessoryAnchors {
        let body = FlatMascotBodies.body(bodyId)
        let c = centre ?? CGPoint(x: 50 + body.faceX, y: 50 + body.faceY)
        let points = outlinePoints(body.path)
        // the head's top across the face's middle, so a hat sits between ears
        // rather than balanced on one (columns past a narrow top are skipped)
        let tops = [-10, -5, 5, 10].map { edgeAt(points, c.x + CGFloat($0), top: true) }.filter { $0 < c.y - 10 }
        let top = ([edgeAt(points, c.x, top: true)] + tops).max()!
        let (hl, hr) = spanAt(points, top + 12)
        let bottom = edgeAt(points, c.x, top: false)
        let (nl, nr) = spanAt(points, bottom - 14)
        return MascotAccessoryAnchors(
            centre: c,
            head: (c.x, top, min(hr - hl, 70)),
            sides: spanAt(points, c.y),
            neck: (c.x, bottom, nr - nl, nl, nr))
    }

    // MARK: - Colour

    static let ink = "#1E1C22"
    static let red = "#D94B52", gold = "#F2B824", silver = "#C9CED6", blue = "#377FE6", coral = "#E5634E"
    static let pink = "#D84F8B", teal = "#01A492", orange = "#E78531", cream = "#F6EBD9"

    static func rgb(_ hex: String) -> [Double] {
        let digits = Array(hex.dropFirst())
        return stride(from: 0, to: 6, by: 2).map { i in
            i + 1 < digits.count ? Double(Int(String(digits[i...i + 1]), radix: 16) ?? 0) : 0
        }
    }

    static func distance(_ x: String, _ y: String) -> Double {
        let a = rgb(x), b = rgb(y)
        return ((a[0] - b[0]) * (a[0] - b[0]) + (a[1] - b[1]) * (a[1] - b[1]) + (a[2] - b[2]) * (a[2] - b[2])).squareRoot()
    }

    /// The piece's own colour, unless it would melt into the body: then the
    /// fallback, then gold, blue or ink, whichever stands out first.
    static func against(_ body: String, _ colour: String, _ fallback: String) -> String {
        [colour, fallback, gold, blue, ink].first { distance(body, $0) >= 90 } ?? ink
    }

    /// The shade a piece uses for its band, knot or brim.
    static func deepen(_ colour: String) -> String {
        "#" + rgb(colour).map { String(format: "%02X", Int(($0 * 0.8).rounded(.toNearestOrAwayFromZero))) }.joined()
    }

    // MARK: - Art

    /// Paint order: what sits behind the face first, what covers it last.
    public static let order: [MascotAccessorySlot] = [.neck, .mouth, .eyes, .head]

    /// Every shape `accessories` puts on this body, in paint order, placed in
    /// the 100 box; empty when it wears nothing.
    public static func shapes(_ accessories: MascotAccessories?, bodyId: String?, color: String?,
                              face: MascotFace? = nil) -> [MascotAccessoryShape] {
        guard let accessories, !accessories.isEmpty else { return [] }
        let face = face ?? .glyph(bodyId: bodyId)
        let body = GlyphFaces.resolveColor(color)
        let pen = Pen(anchors: anchors(bodyId: bodyId, centre: face.centre), face: face,
                      body: body, whiteInk: GlyphFaces.ink(body) == "#FFFFFF")
        return order.flatMap { slot -> [MascotAccessoryShape] in
            guard let id = accessories[slot] else { return [] }
            return pen.draw(id).map { var shape = $0; shape.slot = slot; return shape }
        }
    }

    static let eyeX = GlyphFaces.layout.eyeX * 80
    static let eyeY = GlyphFaces.layout.eyeY * 80

    private struct Pen {
        let anchors: MascotAccessoryAnchors
        let face: MascotFace
        let body: String
        let whiteInk: Bool

        // MARK: transforms

        /// Head pieces are authored 40 wide, origin at their bottom centre.
        func hat(sink: CGFloat = 4, rotate: CGFloat = -8, widthScale: CGFloat = 1, dx: CGFloat = 0) -> CGAffineTransform {
            let head = anchors.head
            let s = max(0.55, min(1.25, (head.width * 0.78 * widthScale) / 40))
            return CGAffineTransform(translationX: head.x + dx * head.width, y: head.y + sink)
                .rotated(by: rotate * .pi / 180).scaledBy(x: s, y: s)
        }

        /// Eye and mouth pieces ride the face: centred on it, tilted with it,
        /// glancing with it, and sized to its eye spacing.
        func onFace(dy: CGFloat) -> CGAffineTransform {
            let k = face.diameter / 80
            return CGAffineTransform(translationX: face.centre.x, y: face.centre.y)
                .rotated(by: face.tilt * .pi / 180)
                .translatedBy(x: face.shift.width * face.diameter, y: face.shift.height * face.diameter)
                .scaledBy(x: k, y: k)
                .translatedBy(x: 0, y: dy)
        }

        // MARK: primitives

        func path(_ data: String, _ t: CGAffineTransform) -> CGPath {
            var t = t
            return GlyphFaces.parsePath(data).copy(using: &t) ?? GlyphFaces.parsePath(data)
        }

        func rect(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat, rx: CGFloat = 0, _ t: CGAffineTransform) -> CGPath {
            var t = t
            let r = CGRect(x: x, y: y, width: w, height: h)
            let corner = min(rx, w / 2, h / 2)
            return corner > 0 ? CGPath(roundedRect: r, cornerWidth: corner, cornerHeight: corner, transform: &t)
                              : CGPath(rect: r, transform: &t)
        }

        func circle(_ cx: CGFloat, _ cy: CGFloat, _ r: CGFloat, _ t: CGAffineTransform) -> CGPath {
            var t = t
            return CGPath(ellipseIn: CGRect(x: cx - r, y: cy - r, width: 2 * r, height: 2 * r), transform: &t)
        }

        func fill(_ path: CGPath, _ colour: String, opacity: Double = 1) -> MascotAccessoryShape {
            MascotAccessoryShape(slot: .head, path: path, fill: colour, fillOpacity: opacity)
        }

        func stroke(_ path: CGPath, _ colour: String, width: CGFloat, _ t: CGAffineTransform, opacity: Double = 1,
                    cap: CGLineCap = .butt, join: CGLineJoin = .miter, fill: String? = nil, fillOpacity: Double = 1) -> MascotAccessoryShape {
            MascotAccessoryShape(slot: .head, path: path, fill: fill, fillOpacity: fillOpacity, stroke: colour,
                                 strokeOpacity: opacity, lineWidth: width * scale(t), lineCap: cap, lineJoin: join)
        }

        func scale(_ t: CGAffineTransform) -> CGFloat { abs(t.a * t.d - t.b * t.c).squareRoot() }

        // MARK: pieces

        func draw(_ id: String) -> [MascotAccessoryShape] {
            switch id {
            case "top-hat":
                let t = hat(sink: 5, rotate: -10)
                return [fill(rect(-24, -5, 48, 7, rx: 3, t), MascotAccessoryArt.ink),
                        fill(rect(-15, -33, 30, 30, rx: 3, t), MascotAccessoryArt.ink),
                        fill(rect(-15, -12, 30, 6, t), against(body, red, gold))]
            case "cap":
                let t = hat(sink: 6, rotate: -6)
                let c = against(body, blue, red), deep = deepen(c)
                return [fill(path("M 10 -2 C 22 -4 34 -2 37 1 C 38 3 36 4 33 4 L 10 4 Z", t), deep),
                        fill(path("M -21 3 C -22 -24 22 -24 21 3 Z", t), c),
                        fill(circle(0, -18, 3, t), deep)]
            case "beanie":
                let t = hat(sink: 6, rotate: -6)
                let c = against(body, coral, teal), deep = deepen(c)
                return [fill(circle(0, -26, 6, t), cream),
                        fill(path("M -21 0 C -22 -30 22 -30 21 0 Z", t), c),
                        fill(rect(-23, -7, 46, 11, rx: 5, t), deep)]
            case "crown":
                let t = hat(sink: 4, rotate: -8, widthScale: 0.85)
                let c = against(body, gold, silver), jewel = against(body, red, blue)
                return [stroke(path("M -20 3 L -21 -19 L -10 -8 L 0 -24 L 10 -8 L 21 -19 L 20 3 Z", t), c, width: 2, t, join: .round, fill: c),
                        fill(rect(-20, -3, 40, 6, t), deepen(c)),
                        fill(circle(0, -10, 3, t), jewel)]
            case "party-hat":
                let t = hat(sink: 4, rotate: 14, widthScale: 0.8)
                let c = against(body, pink, blue)
                return [stroke(path("M -15 2 L 0 -34 L 15 2 Z", t), c, width: 2, t, join: .round, fill: c),
                        fill(circle(-5, -7, 2.6, t), gold), fill(circle(5, -16, 2.3, t), gold),
                        fill(circle(-1, -24, 1.9, t), gold), fill(circle(0, -36, 4.5, t), gold)]
            case "bow":
                let t = hat(sink: 7, rotate: 18, widthScale: 0.7, dx: 0.22)
                let c = against(body, red, pink), deep = deepen(c)
                return [fill(path("M 0 -6 C -5 -18 -21 -20 -21 -8 C -21 4 -6 2 0 -6 Z", t), c),
                        fill(path("M 0 -6 C 5 -18 21 -20 21 -8 C 21 4 6 2 0 -6 Z", t), c),
                        fill(circle(0, -6, 4.5, t), deep)]
            case "headphones":
                let cup = against(body, orange, blue)
                let left = anchors.sides.left + 2, right = anchors.sides.right - 2
                let y = anchors.centre.y - 2, top = anchors.head.y - 5
                let band = CGMutablePath()
                band.move(to: CGPoint(x: left, y: y))
                band.addCurve(to: CGPoint(x: right, y: y), control1: CGPoint(x: left, y: top - 10), control2: CGPoint(x: right, y: top - 10))
                return [stroke(band, MascotAccessoryArt.ink, width: 5, .identity, cap: .round),
                        fill(rect(left - 6, y - 11, 12, 22, rx: 6, .identity), cup),
                        fill(rect(right - 6, y - 11, 12, 22, rx: 6, .identity), cup)]
            case "round-glasses":
                let t = onFace(dy: eyeY)
                let ink = whiteInk ? "#F4F1EC" : MascotAccessoryArt.ink
                let x = eyeX
                func line(_ points: [CGPoint], curve: Bool = false) -> CGPath {
                    let p = CGMutablePath()
                    p.move(to: points[0], transform: t)
                    if curve { p.addCurve(to: points[3], control1: points[1], control2: points[2], transform: t) }
                    else { p.addLine(to: points[1], transform: t) }
                    return p
                }
                return [stroke(circle(-x, 0, 12.5, t), ink, width: 3, t, cap: .round, fill: "#F4F1EC", fillOpacity: 0.16),
                        stroke(circle(x, 0, 12.5, t), ink, width: 3, t, cap: .round, fill: "#F4F1EC", fillOpacity: 0.16),
                        stroke(line([CGPoint(x: -x + 12.5, y: -1), CGPoint(x: -2, y: -5), CGPoint(x: 2, y: -5), CGPoint(x: x - 12.5, y: -1)], curve: true), ink, width: 3, t, cap: .round),
                        stroke(line([CGPoint(x: -x - 12.5, y: -2), CGPoint(x: -x - 19, y: -5)]), ink, width: 3, t, cap: .round),
                        stroke(line([CGPoint(x: x + 12.5, y: -2), CGPoint(x: x + 19, y: -5)]), ink, width: 3, t, cap: .round)]
            case "sunglasses":
                let t = onFace(dy: eyeY)
                let x = eyeX
                func lens(_ cx: CGFloat) -> CGPath {
                    let p = CGMutablePath()
                    p.move(to: CGPoint(x: cx - 13, y: -9), transform: t)
                    p.addLine(to: CGPoint(x: cx + 13, y: -9), transform: t)
                    p.addCurve(to: CGPoint(x: cx, y: 11), control1: CGPoint(x: cx + 13, y: 5), control2: CGPoint(x: cx + 8, y: 11), transform: t)
                    p.addCurve(to: CGPoint(x: cx - 13, y: -9), control1: CGPoint(x: cx - 8, y: 11), control2: CGPoint(x: cx - 13, y: 5), transform: t)
                    p.closeSubpath()
                    return p
                }
                let parts = [lens(-x), lens(x), rect(-x + 11, -9, 2 * x - 22, 4, t)]
                let frames = parts.map { part in
                    whiteInk ? stroke(part, "#F4F1EC", width: 1.5, t, fill: MascotAccessoryArt.ink)
                             : fill(part, MascotAccessoryArt.ink)
                }
                let glint = CGMutablePath()
                glint.move(to: CGPoint(x: -x - 8, y: -5), transform: t); glint.addLine(to: CGPoint(x: -x - 3, y: -5), transform: t)
                glint.move(to: CGPoint(x: x - 8, y: -5), transform: t); glint.addLine(to: CGPoint(x: x - 3, y: -5), transform: t)
                return frames + [stroke(glint, "#FFFFFF", width: 2, t, opacity: 0.55, cap: .round)]
            case "mustache":
                let t = CGAffineTransform(scaleX: 0.85, y: 0.85).concatenating(onFace(dy: 17))
                return [fill(path("M 0 -2 C -4 -7 -12 -8 -17 -3 C -20 0 -24 -1 -25 -5 C -26 3 -19 8 -11 5 C -6 3 -3 1 0 1 C 3 1 6 3 11 5 C 19 8 26 3 25 -5 C 24 -1 20 0 17 -3 C 12 -8 4 -7 0 -2 Z", t),
                             whiteInk ? "#EFE7DD" : "#3A2618")]
            case "bow-tie":
                let neck = anchors.neck
                let t = CGAffineTransform(translationX: neck.x, y: neck.y - 2).rotated(by: -4 * .pi / 180).scaledBy(x: 0.85, y: 0.85)
                let c = against(body, red, gold), deep = deepen(c)
                return [fill(path("M 0 0 L -15 -9 C -18 -10 -20 -8 -20 -5 L -20 5 C -20 8 -18 10 -15 9 Z", t), c),
                        fill(path("M 0 0 L 15 -9 C 18 -10 20 -8 20 -5 L 20 5 C 20 8 18 10 15 9 Z", t), c),
                        fill(rect(-5, -5, 10, 10, rx: 3, t), deep)]
            case "scarf":
                let neck = anchors.neck
                let c = against(body, teal, red), deep = deepen(c)
                // centred on the body, not the face: a scarf wraps the whole width
                let x = (neck.left + neck.right) / 2, w = neck.width + 6, band = neck.y - 15
                let px = x + w * 0.12, py = band + 4
                let tail = CGAffineTransform(translationX: px, y: py).rotated(by: -8 * .pi / 180).translatedBy(x: -px, y: -py)
                let fringe = CGMutablePath()
                fringe.move(to: CGPoint(x: px + 1, y: band + 14), transform: tail); fringe.addLine(to: CGPoint(x: px + 8.5, y: band + 14), transform: tail)
                fringe.move(to: CGPoint(x: px + 1.6, y: band + 19), transform: tail); fringe.addLine(to: CGPoint(x: px + 9.1, y: band + 19), transform: tail)
                return [fill(rect(x - w / 2, band, w, 10, rx: 5, .identity), c),
                        fill(rect(px, py, 9, 22, rx: 3, tail), deep),
                        stroke(fringe, c, width: 2, tail)]
            default:
                return []
            }
        }
    }
}
