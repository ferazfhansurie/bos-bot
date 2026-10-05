import CoreGraphics

public enum MascotEyeStyle: String, CaseIterable, Sendable {
    case classic, round, arches, angled
    public init(stored: String?) { self = stored.flatMap(Self.init(rawValue:)) ?? .classic }
    public func paths(openness: Double = 1) -> [CGPath] {
        let open = CGFloat(max(0.14, min(1.1, openness)))
        return [CGFloat(40), CGFloat(60)].map { x in
            let path = CGMutablePath()
            switch self {
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
