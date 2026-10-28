// The car screen's mascot: the bot's own glyph face (its colour, body and
// accessories) for each call state, inside a halo that moves with the state.
// CarPlay takes one animated image per voice-control state, at most 150 pt,
// cycling in 0.3–5 s, so each state is a short loop rendered once and kept.
import CompanionCore
import SwiftUI
import UIKit

/// Who the screen is showing: a bot, or bos's look while the roster loads.
struct CarFace: Equatable {
    var id: String
    var name: String
    var color: String
    var bodyId: String?
    var accessories: MascotAccessories?

    init(_ bot: Bot) {
        id = bot.id
        name = bot.name
        color = bot.color
        bodyId = bot.mascotBody
        accessories = bot.mascotAccessories
    }

    init(id: String, name: String, color: String) {
        self.id = id
        self.name = name
        self.color = color
    }

    static let placeholder = CarFace(id: "", name: "bos", color: "green")
}

@MainActor
enum CarMascotImages {
    static let side: CGFloat = 150
    /// The glyph's accent floats on a 1.8 s sine, so one loop of it is seamless.
    static let cycle: Double = 1.8
    static let frames = 12

    /// One face's loops at a time: a state is ~12 full frames, a few MB at
    /// car scale, so switching bots drops the last bot's.
    private static var cache: [String: UIImage] = [:]
    private static var cachedFace = ""

    static func image(_ face: CarFace, state: CarVoiceState, scale: CGFloat, dark: Bool) -> UIImage? {
        let faceKey = "\(face.id)|\(face.color)|\(face.bodyId ?? "")|\(String(describing: face.accessories))|\(scale)|\(dark)"
        if faceKey != cachedFace { cache = [:]; cachedFace = faceKey }
        let key = state.rawValue
        if let hit = cache[key] { return hit }
        let base = quietStart(face.color)
        let duration = state.repeats ? cycle : 0.9
        let shots = (0..<frames).compactMap { index -> UIImage? in
            let progress = Double(index) / Double(frames)
            return frame(face, state: state, progress: progress, now: base.addingTimeInterval(progress * duration),
                         changedAt: state.repeats ? nil : base, scale: scale, dark: dark)
        }
        guard let last = shots.last else { return nil }
        // saved pops once and holds its last frame
        let image = state.repeats ? UIImage.animatedImage(with: shots, duration: duration) : UIImage.animatedImage(with: shots + [last, last, last], duration: duration)
        if let image { cache[key] = image }
        return image
    }

    /// A still face for list rows.
    static func still(_ face: CarFace, scale: CGFloat, dark: Bool) -> UIImage? {
        frame(face, state: .listening, progress: 0, now: nil, changedAt: nil, scale: scale, dark: dark, halo: false)
    }

    /// A start time whose loop never lands in the glyph's blink window, so
    /// the loop has no half-blink seam (GlyphMark blinks on a 4.3 s beat
    /// offset by the colour).
    private static func quietStart(_ color: String) -> Date {
        let beat = Double(color.unicodeScalars.reduce(0) { $0 &+ Int($1.value) } % 17) / 4
        return Date(timeIntervalSinceReferenceDate: 4.3 * 100_000 + 0.2 - beat)
    }

    private static func frame(_ face: CarFace, state: CarVoiceState, progress: Double, now: Date?, changedAt: Date?,
                              scale: CGFloat, dark: Bool, halo: Bool = true) -> UIImage? {
        let scheme: ColorScheme = dark ? .dark : .light
        let tint = Color(hex: GlyphFaces.resolveColor(face.color))
        let canvas = Canvas { context, size in
            let centre = CGPoint(x: size.width / 2, y: size.height / 2)
            if halo { drawHalo(&context, centre: centre, side: size.width, state: state, progress: progress, tint: tint) }
            let body = size.width * 0.42
            let slot = CGRect(x: centre.x - body / 2, y: centre.y - body / 2, width: body, height: body)
            var mascot = context
            if state == .offline { mascot.opacity = 0.6 }
            GlyphMark.draw(in: &mascot, slot: slot, color: face.color, bodyId: face.bodyId, state: state.face,
                           scheme: scheme, now: now, changedAt: changedAt, accessories: face.accessories)
        }
        .frame(width: side, height: side)
        let renderer = ImageRenderer(content: canvas)
        renderer.scale = max(scale, 1)
        return renderer.uiImage
    }

    /// The halo says the state from across the car: a slow breath while it
    /// listens, ripples while it talks, orbiting dots while it thinks, a
    /// sweep while a job goes out, a full ring when it lands, a turning
    /// dashed ring while the line comes back, a faint dotted one offline.
    private static func drawHalo(_ context: inout GraphicsContext, centre: CGPoint, side: CGFloat,
                                 state: CarVoiceState, progress p: Double, tint: Color) {
        let radius = side * 0.42
        func ring(_ r: CGFloat) -> Path {
            Path(ellipseIn: CGRect(x: centre.x - r, y: centre.y - r, width: r * 2, height: r * 2))
        }
        let wave = sin(p * 2 * .pi)
        switch state {
        case .listening:
            let r = radius * (1 + 0.04 * wave)
            context.fill(ring(r), with: .color(tint.opacity(0.10 + 0.04 * wave)))
            context.stroke(ring(r), with: .color(tint.opacity(0.55)), lineWidth: 3)
        case .talking:
            context.fill(ring(radius * 0.8), with: .color(tint.opacity(0.12)))
            for k in 0..<3 {
                let q = (p + Double(k) / 3).truncatingRemainder(dividingBy: 1)
                let r = side * (0.30 + 0.18 * q)
                context.stroke(ring(r), with: .color(tint.opacity(0.65 * (1 - q))), lineWidth: 3)
            }
        case .thinking:
            context.stroke(ring(radius), with: .color(tint.opacity(0.18)), lineWidth: 2)
            for k in 0..<3 {
                let angle = (p + Double(k) / 3) * 2 * .pi
                let dot = CGPoint(x: centre.x + radius * cos(angle), y: centre.y + radius * sin(angle))
                let size = side * (0.05 - 0.01 * Double(k))
                context.fill(Path(ellipseIn: CGRect(x: dot.x - size / 2, y: dot.y - size / 2, width: size, height: size)),
                             with: .color(tint.opacity(0.95 - 0.25 * Double(k))))
            }
        case .sending:
            context.stroke(ring(radius), with: .color(tint.opacity(0.18)), lineWidth: 3)
            let start = Angle.degrees(p * 360 - 90)
            var arc = Path()
            arc.addArc(center: centre, radius: radius, startAngle: start, endAngle: start + .degrees(100), clockwise: false)
            context.stroke(arc, with: .color(tint), style: StrokeStyle(lineWidth: 5, lineCap: .round))
        case .saved:
            let grow = min(1, p * 1.6)
            context.fill(ring(radius * grow), with: .color(tint.opacity(0.16)))
            context.stroke(ring(radius * (0.9 + 0.1 * grow)), with: .color(tint.opacity(0.9)), lineWidth: 5)
        case .reconnecting:
            context.stroke(ring(radius), with: .color(tint.opacity(0.7)),
                           style: StrokeStyle(lineWidth: 3, lineCap: .round, dash: [8, 10], dashPhase: -p * 36))
        case .offline:
            context.stroke(ring(radius), with: .color(tint.opacity(0.35)),
                           style: StrokeStyle(lineWidth: 3, lineCap: .round, dash: [2, 9]))
        }
    }
}
