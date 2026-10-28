// The glyph face — a flat body in the bot's colour, two bold stroked glyph
// eyes tilted together, and the state's accent glyph floating outside the
// body. Same table, same proportions as the desktop's CursorAvatar: both read
// shared/glyph-faces.ts (the phone through `CompanionCore.GlyphFaces`).
//
// Compiled into the widget extension too, for the Live Activity; there the
// face is always still.
import CompanionCore
import SwiftUI

struct GlyphMark: View {
    let color: String
    var bodyId: String?
    var state: GlyphFaceState = .idle
    var size: CGFloat = 52
    /// Opt-in like MausAvatar's: blink, accent float and the eye squash on a
    /// state change cost a 30fps redraw.
    var animated = false
    /// A turn that just finished plays `finished` for a beat, then settles.
    var completedTurnID: String? = nil
    /// What the mascot wears; nil draws exactly the bare face.
    var accessories: MascotAccessories? = nil

    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @State private var changedAt: Date?
    @State private var finishing = false

    private var shown: GlyphFaceState { finishing ? .finished : state }

    var body: some View {
        content
            // The accent floats outside the body, so the canvas is twice the
            // slot; only the slot itself takes touches.
            .frame(width: size * 2, height: size * 2)
            .contentShape(Rectangle().inset(by: size / 2))
            .frame(width: size, height: size)
            .onChange(of: shown) { _, _ in changedAt = Date() }
            .task(id: completedTurnID) {
                guard completedTurnID != nil else { return }
                finishing = true
                try? await Task.sleep(for: .seconds(2.4))
                if !Task.isCancelled { finishing = false }
            }
    }

    @ViewBuilder private var content: some View {
#if WIDGET_EXTENSION
        canvas(at: nil)
#else
        if animated && !reduceMotion && scenePhase == .active {
            TimelineView(.animation(minimumInterval: 1.0 / 30)) { timeline in canvas(at: timeline.date) }
        } else {
            canvas(at: nil)
        }
#endif
    }

    private func canvas(at now: Date?) -> some View {
        let state = shown, color = color, bodyId = bodyId, scheme = scheme, changedAt = changedAt, accessories = accessories
        return Canvas { context, canvas in
            let slot = CGRect(x: canvas.width / 4, y: canvas.height / 4, width: canvas.width / 2, height: canvas.height / 2)
            Self.draw(in: &context, slot: slot, color: color, bodyId: bodyId, state: state,
                      scheme: scheme, now: now, changedAt: changedAt, accessories: accessories)
        }
    }

    // MARK: - Drawing

    /// The eye and accent colours for a body: eyes black or white by
    /// contrast (`glyphInk`); the accent wears the body colour unless that
    /// would vanish into the background (a dark bot in dark mode, a white
    /// one in light mode), then the background's own ink.
    static func colors(_ color: String, scheme: ColorScheme) -> (body: Color, ink: Color, accent: Color) {
        let hex = GlyphFaces.resolveColor(color)
        let background = scheme == .dark ? "#111111" : "#FFFFFF"
        let accent = GlyphFaces.contrast(hex, background) >= 1.6
            ? Color(hex: hex)
            : (scheme == .dark ? Color.white : Color.black)
        return (Color(hex: hex), Color(hex: GlyphFaces.ink(hex)), accent)
    }

    /// One frame. `slot` is where the body sits (the size the caller asked
    /// for); the accent may land outside it. `now` nil is a still frame: no
    /// sheet motion, no blink, no glance.
    static func draw(in context: inout GraphicsContext, slot: CGRect, color: String, bodyId: String?,
                     state: GlyphFaceState, scheme: ColorScheme, now: Date? = nil, changedAt: Date? = nil,
                     look: GlyphLook = GlyphLook(), accessories: MascotAccessories? = nil) {
        let layout = GlyphFaces.layout
        let paint = colors(color, scheme: scheme)
        let resolved = look.resolve(state)
        let side = min(slot.width, slot.height)

        let k = side / 100
        let outline = FlatMascotBodies.outline(bodyId)
        let origin = CGPoint(x: slot.midX - side / 2, y: slot.midY - side / 2)
        // Proportions are in body diameters, measured from the body centre.
        let bounds = outline.boundingBoxOfPath
        let diameter = min(bounds.width, bounds.height) * k
        let centre = CGPoint(x: origin.x + bounds.midX * k, y: origin.y + bounds.midY * k)
        // Glyph eyes span almost half the body, wider than the classic eyes
        // the catalog's faceX was tuned for, so they sit on the body's mass
        // instead: a bean's notch would otherwise swallow the left eye.
        let mass = massCentre[FlatMascotBodies.body(bodyId).id] ?? CGPoint(x: bounds.midX, y: bounds.midY)
        let faceCentre = CGPoint(x: origin.x + mass.x * k, y: origin.y + mass.y * k)

        let t = now.map { $0.timeIntervalSinceReferenceDate } ?? 0
        let sinceChange = now.flatMap { now in changedAt.map { now.timeIntervalSince($0) } } ?? .infinity
        // the sheet's motion starts when the face appears, like a CSS class mounting
        let motion = now == nil ? GlyphFaceArt.still
            : GlyphMotionCurves.frames(resolved.motion, at: sinceChange.isFinite ? sinceChange : t)

        // The whole body hops, squishes or taps about the point it stands on.
        var root = context
        GlyphFaceArt.apply(motion.body, to: &root, about: CGPoint(x: centre.x, y: origin.y + bounds.maxY * k), unit: diameter / 64)

        var bodyContext = root
        bodyContext.translateBy(x: origin.x, y: origin.y)
        bodyContext.scaleBy(x: k, y: k)
        bodyContext.fill(Path(outline), with: .color(paint.body))
        // a white bot on a light screen (or a near-black one on dark) still
        // needs an edge, or only its eyes are left floating
        if GlyphFaces.contrast(GlyphFaces.resolveColor(color), scheme == .dark ? "#111111" : "#FFFFFF") < 1.25 {
            bodyContext.stroke(Path(outline), with: .color(paint.ink.opacity(0.22)), lineWidth: max(1, side / 52) / k)
        }

        // Eyes: a quick squash when the face changes, a random blink now and
        // then (each bot on its own seed), and a glance while it rests.
        let swap = sinceChange < 0.12 ? max(0.15, abs(1 - 2 * sinceChange / 0.12)) : 1
        let seed = GlyphBlink.seed(color + (bodyId ?? ""))
        let blinks = now != nil && sinceChange > 0.4 && look.eyeSquash == 1 && !resolved.skipsBlink
        let blink = blinks ? GlyphBlink.openness(at: t, seed: seed) : 1
        let glance = now != nil && resolved.rests && look.eyeShift == .zero ? GlyphIdleGaze.offset(at: t, seed: seed) : .zero
        let gaze = CGSize(width: resolved.gaze.width + look.eyeShift.width + glance.width,
                          height: resolved.gaze.height + look.eyeShift.height + glance.height)
        GlyphFaceArt.drawEyes(GlyphFaceArt.Eyes(left: resolved.left, right: resolved.right, gaze: gaze,
                                                squash: swap * blink * look.eyeSquash),
                              in: root, faceCentre: faceCentre, diameter: diameter, ink: paint.ink,
                              motion: motion.eyes, eachEye: motion.eachEye)

        // Accessories ride the same face (glasses follow a glance), over the
        // eyes and under the accent, like the desktop's.
        if let accessories, !accessories.isEmpty {
            MascotAccessoryArt.draw(accessories, in: &root,
                                    box: CGRect(x: origin.x, y: origin.y, width: side, height: side),
                                    bodyId: bodyId, color: color,
                                    face: MascotFace(centre: mass, diameter: min(bounds.width, bounds.height), shift: gaze))
        }

        // The accent carries the mood at a glance; under the minimum size it
        // is noise, so small faces show the eyes alone.
        guard side >= layout.accentMinSize, let accent = resolved.accent, let anchor = resolved.anchor else { return }
        let pop = sinceChange < 0.22 ? easeOutBack(sinceChange / 0.22) : 1
        GlyphFaceArt.drawAccent(accent, anchor: anchor, in: root, centre: centre, diameter: diameter,
                                color: paint.accent, body: color, pop: CGFloat(pop), motion: motion.accent)
    }

    /// A glyph from the shared table, or one of the phone's own mood marks.
    static func glyphPath(_ id: String) -> CGPath {
        extraGlyphs[id] ?? GlyphFaces.path(id)
    }

    /// Marks only the in-thread moods use, in the same 24 box and stroke as
    /// the table's. `drop` is the sheepish face's sweat bead.
    private static let extraGlyphs: [String: CGPath] = {
        let drop = CGMutablePath()
        drop.move(to: CGPoint(x: 12, y: 4))
        drop.addCurve(to: CGPoint(x: 6.5, y: 15), control1: CGPoint(x: 12, y: 4), control2: CGPoint(x: 6.5, y: 10.5))
        drop.addCurve(to: CGPoint(x: 12, y: 20.5), control1: CGPoint(x: 6.5, y: 18), control2: CGPoint(x: 9, y: 20.5))
        drop.addCurve(to: CGPoint(x: 17.5, y: 15), control1: CGPoint(x: 15, y: 20.5), control2: CGPoint(x: 17.5, y: 18))
        drop.addCurve(to: CGPoint(x: 12, y: 4), control1: CGPoint(x: 17.5, y: 10.5), control2: CGPoint(x: 12, y: 4))
        drop.closeSubpath()
        return ["drop": drop]
    }()

    /// Area centroid of every body in its 100 box, sampled once.
    static var massCentre: [String: CGPoint] { MascotFace.massCentres }

    private static func easeOutBack(_ t: Double) -> Double {
        let c = 1.7, u = min(max(t, 0), 1) - 1
        return 1 + (c + 1) * u * u * u + c * u * u
    }
}

/// A face drawn off its state's table: another whole table face, other eye
/// glyphs (a ring when it notices something), another accent, the eyes
/// shifted (a glance, in body diameters, before the tilt) or squashed (a
/// blink sprung from outside). The chat list's idle faces and the thread
/// mascot use it; everything else draws plain.
struct GlyphLook: Equatable {
    var left: String?
    var right: String?
    var accent: String?
    var anchor: GlyphAccentAnchor?
    var hidesAccent = false
    var eyeShift: CGSize = .zero
    var eyeSquash: CGFloat = 1
    /// A table face worn instead of the state's: its layered eyes, gaze,
    /// accent and motion.
    var face: GlyphFaceState?

    /// What to draw for `state` with this look on it.
    func resolve(_ state: GlyphFaceState) -> GlyphFaceArt.Resolved {
        let shown = face ?? state
        let base = GlyphFaces.face(shown)
        let swapped = left != nil || right != nil
        return GlyphFaceArt.Resolved(
            left: left.map { [GlyphFaceArt.part($0)] } ?? base.leftParts,
            right: right.map { [GlyphFaceArt.part($0)] } ?? base.rightParts,
            accent: accent ?? (hidesAccent ? nil : base.accent),
            anchor: accent != nil ? anchor : base.anchor,
            gaze: swapped ? .zero : base.gazeOffset,
            motion: swapped ? GlyphMotion() : base.motion,
            skipsBlink: !swapped && GlyphMotionCurves.skipsBlink(base),
            rests: !swapped && shown == .idle)
    }
}

/// The eyes and accent of a glyph face, drawn the same way by GlyphMark and
/// LiveMascot: layered eye parts at their weights, the face's gaze inside
/// the tilt, and the sheet's motion (src/components/GlyphFace.tsx).
enum GlyphFaceArt {
    struct Resolved {
        var left: [GlyphEyePart]
        var right: [GlyphEyePart]
        var accent: String?
        var anchor: GlyphAccentAnchor?
        /// in body diameters, inside the tilt
        var gaze: CGSize
        var motion: GlyphMotion
        var skipsBlink: Bool
        /// a plain resting face, which may glance about on its own
        var rests: Bool
    }

    struct Eyes {
        var left: [GlyphEyePart]
        var right: [GlyphEyePart]
        /// in body diameters, inside the tilt
        var gaze: CGSize
        /// blink and swap squash, about the face centre
        var squash: CGFloat = 1
        /// each eye's own size: a pose's attention, a voice's stretch
        var scale = CGSize(width: 1, height: 1)
    }

    typealias Frames = (eyes: GlyphMotionFrame, eachEye: GlyphMotionFrame, accent: GlyphMotionFrame, body: GlyphMotionFrame)
    static let still: Frames = (.identity, .identity, .identity, .identity)

    /// A whole eye from one glyph; a dot gets the resting dot's weight.
    static func part(_ glyph: String) -> GlyphEyePart {
        GlyphEyePart(glyph: glyph, weight: glyph == "dot" ? GlyphFaces.face(.idle).leftParts[0].weight : 1)
    }

    /// Applies a sheet motion about `pivot`; distances are sheet px, `unit` apart.
    static func apply(_ frame: GlyphMotionFrame, to context: inout GraphicsContext, about pivot: CGPoint, unit: CGFloat) {
        guard !frame.isIdentity else { return }
        context.translateBy(x: pivot.x + frame.dx * unit, y: pivot.y + frame.dy * unit)
        if frame.rotate != 0 { context.rotate(by: .degrees(Double(frame.rotate))) }
        context.scaleBy(x: frame.sx, y: frame.sy)
        context.translateBy(x: -pivot.x, y: -pivot.y)
        if frame.opacity != 1 { context.opacity *= Double(frame.opacity) }
    }

    static func drawEyes(_ eyes: Eyes, in context: GraphicsContext, faceCentre: CGPoint, diameter: CGFloat, ink: Color,
                         motion: GlyphMotionFrame = .identity, eachEye: GlyphMotionFrame = .identity) {
        let layout = GlyphFaces.layout
        var pair = context
        // the sheet moves the eyes in screen space about the face at eye
        // height, then tilts them; the blink squashes about the face centre
        apply(motion, to: &pair, about: CGPoint(x: faceCentre.x, y: faceCentre.y + layout.eyeY * diameter), unit: diameter / 64)
        pair.translateBy(x: faceCentre.x, y: faceCentre.y)
        pair.rotate(by: .degrees(GlyphFaces.tiltDegrees))
        pair.scaleBy(x: 1, y: max(0.02, eyes.squash))
        pair.translateBy(x: eyes.gaze.width * diameter, y: eyes.gaze.height * diameter)
        let eyeScale = layout.eyeBox * diameter / GlyphFaces.viewBox
        let minStroke = layout.minStrokePx / eyeScale
        for (parts, x) in [(eyes.left, -layout.eyeX), (eyes.right, layout.eyeX)] {
            var eye = pair
            eye.translateBy(x: x * diameter, y: layout.eyeY * diameter)
            // spin, twinkle and beat turn each eye about its own centre
            if eachEye.rotate != 0 { eye.rotate(by: .degrees(Double(eachEye.rotate))) }
            eye.scaleBy(x: eyeScale * eachEye.sx * eyes.scale.width, y: eyeScale * eachEye.sy * eyes.scale.height)
            eye.translateBy(x: -GlyphFaces.viewBox / 2, y: -GlyphFaces.viewBox / 2)
            for part in parts {
                eye.stroke(Path(GlyphMark.glyphPath(part.glyph)), with: .color(ink),
                           style: StrokeStyle(lineWidth: max(GlyphFaces.stroke * part.weight, minStroke), lineCap: .round, lineJoin: .round))
            }
        }
    }

    /// The accent off the body, popped in by `pop`, moving to its motion. A
    /// cheek accent sits on the body, so it takes the colour opposite the eyes.
    static func drawAccent(_ glyph: String, anchor: GlyphAccentAnchor, in context: GraphicsContext, centre: CGPoint,
                           diameter: CGFloat, color: Color, body: String, pop: CGFloat, motion: GlyphMotionFrame = .identity) {
        guard let place = GlyphFaces.placement(anchor), pop > 0.001, motion.opacity > 0.001 else { return }
        let boxScale = place.box * diameter / GlyphFaces.viewBox
        guard boxScale > 0 else { return }
        var mark = context
        apply(motion, to: &mark, about: CGPoint(x: centre.x + place.x * diameter, y: centre.y + place.y * diameter), unit: diameter / 64)
        mark.translateBy(x: centre.x + place.x * diameter, y: centre.y + place.y * diameter)
        mark.scaleBy(x: boxScale * pop, y: boxScale * pop)
        mark.translateBy(x: -GlyphFaces.viewBox / 2, y: -GlyphFaces.viewBox / 2)
        let paint = place.onBodyAlpha.map { alpha in
            (GlyphFaces.ink(GlyphFaces.resolveColor(body)) == "#000000" ? Color.white : Color.black).opacity(Double(alpha))
        } ?? color
        mark.stroke(Path(GlyphMark.glyphPath(glyph)), with: .color(paint),
                    style: StrokeStyle(lineWidth: max(place.stroke, GlyphFaces.layout.minStrokePx / (boxScale * pop)),
                                       lineCap: .round, lineJoin: .round))
    }
}

extension MausState {
    /// The glyph face for this state. `listening` is how the phone spells
    /// "waiting on you" (`MausState.face(for: .waiting)`), so it gets the
    /// waiting face rather than the desktop's listening -> searching.
    var glyphState: GlyphFaceState {
        self == .listening ? .waiting : GlyphFaces.state(for: rawValue)
    }
}
