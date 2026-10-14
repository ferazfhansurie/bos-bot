// The message bubble, tail included.
//
// The tail is not an approximation: its four Bézier segments are the ones
// from the reference vector (`docs/ios/bubble-tail-reference.svg`), scaled
// so the reference's cap radius becomes this bubble's corner radius. That is why it curls in, drops, and ends soft rather than in a
// point — the shape is the drawing, not a guess at it.
import SwiftUI
import CompanionCore

struct SpeechBubble: Shape {
    enum Tail { case none, leading, trailing }

    var tail: Tail = .none
    var cornerRadius: CGFloat = 22

    /// How far below the bubble's bottom edge the tail reaches, so callers can
    /// leave room for it. Depends on the corner radius the same way the tail
    /// does.
    static func tailDrop(cornerRadius: CGFloat = 22) -> CGFloat {
        cornerRadius / referenceCapRadius * referenceTailDrop
    }

    // The reference: a 772×428 pill whose right cap has this radius, whose
    // right edge is at x=766.342 and bottom edge at y=361.317, and whose tail
    // hangs 68 below the bottom edge.
    private static let referenceCapRadius: CGFloat = 179
    private static let referenceTailDrop: CGFloat = 68
    private static let referenceOrigin = CGPoint(x: 766.342, y: 361.317)
    private static let referenceTail: [(CGPoint, CGPoint, CGPoint)] = [
        (CGPoint(x: 766.342, y: 249.767), CGPoint(x: 727.342, y: 299.817), CGPoint(x: 699.842, y: 323.317)),
        (CGPoint(x: 699.842, y: 323.317), CGPoint(x: 677.085, y: 338.817), CGPoint(x: 674.342, y: 354.817)),
        (CGPoint(x: 668.342, y: 389.817), CGPoint(x: 700.829, y: 410.817), CGPoint(x: 691.829, y: 421.317)),
        (CGPoint(x: 684.629, y: 429.717), CGPoint(x: 615.056, y: 378.235), CGPoint(x: 580.342, y: 361.317)),
    ]

    func path(in rect: CGRect) -> Path {
        let r = min(cornerRadius, rect.height / 2, rect.width / 2)
        guard tail != .none else {
            return RoundedRectangle(cornerRadius: r, style: .continuous).path(in: rect)
        }
        var path = trailingTailPath(in: rect, radius: r)
        if tail == .leading {
            // Mirror the trailing shape about the rect's vertical centre line.
            let flip = CGAffineTransform(translationX: rect.minX + rect.maxX, y: 0).scaledBy(x: -1, y: 1)
            path = path.applying(flip)
        }
        return path
    }

    /// The bubble with the tail at bottom-right, drawn clockwise from the top
    /// edge. The three plain corners are circular arcs; the fourth is the
    /// reference's cap-and-tail, scaled.
    private func trailingTailPath(in rect: CGRect, radius r: CGFloat) -> Path {
        let s = r / Self.referenceCapRadius
        let origin = CGPoint(x: rect.maxX, y: rect.maxY)
        func map(_ p: CGPoint) -> CGPoint {
            CGPoint(x: origin.x + (p.x - Self.referenceOrigin.x) * s, y: origin.y + (p.y - Self.referenceOrigin.y) * s)
        }

        var path = Path()
        path.move(to: CGPoint(x: rect.minX + r, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.maxX - r, y: rect.minY))
        path.addArc(
            center: CGPoint(x: rect.maxX - r, y: rect.minY + r), radius: r,
            startAngle: .degrees(-90), endAngle: .degrees(0), clockwise: false
        )
        // Down the right edge to where the reference cap begins — exactly one
        // radius above the bottom, which is where the first segment starts.
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY - r))
        for (c1, c2, end) in Self.referenceTail {
            path.addCurve(to: map(end), control1: map(c1), control2: map(c2))
        }
        // The last segment lands back on the bottom edge, left of the corner.
        path.addLine(to: CGPoint(x: rect.minX + r, y: rect.maxY))
        path.addArc(
            center: CGPoint(x: rect.minX + r, y: rect.maxY - r), radius: r,
            startAngle: .degrees(90), endAngle: .degrees(180), clockwise: false
        )
        path.addLine(to: CGPoint(x: rect.minX, y: rect.minY + r))
        path.addArc(
            center: CGPoint(x: rect.minX + r, y: rect.minY + r), radius: r,
            startAngle: .degrees(180), endAngle: .degrees(270), clockwise: false
        )
        path.closeSubpath()
        return path
    }
}

/// The two bubble fills. Solid rather than translucent on purpose: the tail
/// is part of the same fill, and a see-through bubble shows the seam.
enum BubbleColor {
    /// What you said, in the theme's accent.
    static var mine: Color {
        ThemeSurfaces.current.accent
    }
    static let mineText = Color.white

    /// What a bot said: the theme's raised surface, or the app's own greys
    /// (near-black on dark, a soft grey on light) on Classic.
    static var theirs: Color { Color(uiColor: ThemeSurfaces.current.bubbleUIColor) }

    /// A bot's bubble washed with that bot's colour, the way Grok tints a
    /// reply: the theme's bubble with a soft layer of the colour over it,
    /// a little stronger on dark where a faint tint disappears. Never the
    /// saturated colour itself; that is reserved for what you said.
    static func theirs(tint name: String?) -> Color {
        guard let tint = tintComponents(name) else { return theirs }
        let base = ThemeSurfaces.current.bubbleUIColor
        return Color(uiColor: UIColor { trait in blend(base.resolvedColor(with: trait), tint, trait) })
    }

    /// Text on a tinted bubble: near-black or white, whichever the blended
    /// fill is lighter or darker than, so a custom theme with a mid-tone
    /// surface still reads.
    static func theirsText(tint name: String?) -> Color {
        guard let tint = tintComponents(name) else { return .primary }
        let base = ThemeSurfaces.current.bubbleUIColor
        return Color(uiColor: UIColor { trait in
            let fill = blend(base.resolvedColor(with: trait), tint, trait)
            return luminance(fill) > 0.40
                ? UIColor(red: 0.07, green: 0.07, blue: 0.08, alpha: 1)
                : UIColor.white
        })
    }

    private static func tintComponents(_ name: String?) -> (r: CGFloat, g: CGFloat, b: CGFloat)? {
        guard let name, !name.isEmpty else { return nil }
        var value: UInt64 = 0
        let hex = GlyphFaces.resolveColor(name).replacingOccurrences(of: "#", with: "")
        guard hex.count == 6, Scanner(string: hex).scanHexInt64(&value) else { return nil }
        return (CGFloat((value >> 16) & 0xFF) / 255, CGFloat((value >> 8) & 0xFF) / 255, CGFloat(value & 0xFF) / 255)
    }

    private static func blend(_ base: UIColor, _ tint: (r: CGFloat, g: CGFloat, b: CGFloat), _ trait: UITraitCollection) -> UIColor {
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        base.getRed(&r, green: &g, blue: &b, alpha: &a)
        let k: CGFloat = trait.userInterfaceStyle == .dark ? 0.22 : 0.14
        return UIColor(red: r + (tint.r - r) * k, green: g + (tint.g - g) * k, blue: b + (tint.b - b) * k, alpha: a)
    }

    /// WCAG relative luminance.
    private static func luminance(_ color: UIColor) -> CGFloat {
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        color.getRed(&r, green: &g, blue: &b, alpha: &a)
        func linear(_ c: CGFloat) -> CGFloat { c <= 0.03928 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4) }
        return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
    }
}
