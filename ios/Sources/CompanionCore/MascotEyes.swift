import CoreGraphics

public enum MascotEyeStyle: String, CaseIterable, Sendable {
    /// `glyph` draws through `GlyphFaces` (shared/glyph-faces.json) and is the
    /// default for every bot, matching `botMascotEyes` in shared/mascot-eyes.ts;
    /// an explicit classic/round/arches/angled stays as picked.
    case glyph, classic, round, arches, angled
    public init(stored: String?) { self = stored.flatMap(Self.init(rawValue:)) ?? .glyph }
    /// The desktop's `MASCOT_EYE_STYLES` names.
    public var label: String {
        switch self {
        case .glyph: "Glyph"
        case .classic: "Classic"
        case .round: "Round"
        case .arches: "Arches"
        case .angled: "Angled"
        }
    }
    /// Filled eye outlines in the flat body's 100 box. A glyph face is drawn
    /// by `GlyphMark`; here it is its resting pair of solid dots, for any
    /// caller that only knows outlines.
    public func paths(openness: Double = 1) -> [CGPath] {
        let open = CGFloat(max(0.14, min(1.1, openness)))
        return [CGFloat(40), CGFloat(60)].map { x in
            let path = CGMutablePath()
            switch self {
            case .glyph:
                path.addEllipse(in: CGRect(x: x + 3.25 - 4.25, y: 45 - 4.25 * open, width: 8.5, height: 8.5 * open))
            case .classic:
                let rect = CGRect(x: x, y: 45 - 7 * open, width: 6.5, height: 14 * open)
                path.addRoundedRect(in: rect, cornerWidth: min(3.25, 7 * open), cornerHeight: min(3.25, 7 * open))
            case .round:
                path.addEllipse(in: CGRect(x: x - 1.75, y: 45 - 5 * open, width: 10, height: 10 * open))
            case .arches:
                path.move(to: CGPoint(x: x - 1, y: 47))
                path.addQuadCurve(to: CGPoint(x: x + 7.5, y: 47), control: CGPoint(x: x + 3.25, y: 47 - 13 * open))
                return path.copy(strokingWithWidth: 4, lineCap: .round, lineJoin: .round, miterLimit: 1)
            case .angled:
                path.move(to: CGPoint(x: x + 1.75, y: 45 - 6 * open))
                path.addLine(to: CGPoint(x: x + 4.75, y: 45 + 6 * open))
                return path.copy(strokingWithWidth: 6, lineCap: .round, lineJoin: .round, miterLimit: 1)
            }
            return path
        }
    }
}
