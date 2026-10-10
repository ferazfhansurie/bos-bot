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
        let state = shown, color = color, bodyId = bodyId, scheme = scheme, changedAt = changedAt
        return Canvas { context, canvas in
            let slot = CGRect(x: canvas.width / 4, y: canvas.height / 4, width: canvas.width / 2, height: canvas.height / 2)
            Self.draw(in: &context, slot: slot, color: color, bodyId: bodyId, state: state,
                      scheme: scheme, now: now, changedAt: changedAt)
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
    /// for); the accent may land outside it. `now` nil is a still frame.
    static func draw(in context: inout GraphicsContext, slot: CGRect, color: String, bodyId: String?,
                     state: GlyphFaceState, scheme: ColorScheme, now: Date? = nil, changedAt: Date? = nil,
                     look: GlyphLook = GlyphLook()) {
        let layout = GlyphFaces.layout
        let paint = colors(color, scheme: scheme)
        let base = GlyphFaces.face(state)
        let face = (left: look.left ?? base.left, right: look.right ?? base.right,
                    accent: look.accent ?? (look.hidesAccent ? nil : base.accent),
                    anchor: look.accent != nil ? look.anchor : base.anchor)
        let side = min(slot.width, slot.height)

        // The body, from the same 100-box catalog the flat mark draws.
        let k = side / 100
        let outline = FlatMascotBodies.outline(bodyId)
        var bodyContext = context
        bodyContext.translateBy(x: slot.midX - side / 2, y: slot.midY - side / 2)
        bodyContext.scaleBy(x: k, y: k)
        bodyContext.fill(Path(outline), with: .color(paint.body))
        // a white bot on a light screen (or a near-black one on dark) still
        // needs an edge, or only its eyes are left floating
        if GlyphFaces.contrast(GlyphFaces.resolveColor(color), scheme == .dark ? "#111111" : "#FFFFFF") < 1.25 {
            bodyContext.stroke(Path(outline), with: .color(paint.ink.opacity(0.22)), lineWidth: max(1, side / 52) / k)
        }

        // Proportions are in body diameters, measured from the body centre.
        let bounds = outline.boundingBoxOfPath
        let diameter = min(bounds.width, bounds.height) * k
        let centre = CGPoint(x: slot.midX - side / 2 + bounds.midX * k, y: slot.midY - side / 2 + bounds.midY * k)
        // Glyph eyes span almost half the body, wider than the classic eyes
        // the catalog's faceX was tuned for, so they sit on the body's mass
        // instead: a bean's notch would otherwise swallow the left eye.
        let mass = massCentre[FlatMascotBodies.body(bodyId).id] ?? CGPoint(x: bounds.midX, y: bounds.midY)
        let faceCentre = CGPoint(x: slot.midX - side / 2 + mass.x * k, y: slot.midY - side / 2 + mass.y * k)

        let t = now.map { $0.timeIntervalSinceReferenceDate } ?? 0
        let sinceChange = now.flatMap { now in changedAt.map { now.timeIntervalSince($0) } } ?? .infinity

        // Eyes: a quick squash when the face changes, and a blink to `- -`.
        let squash = (sinceChange < 0.12 ? max(0.15, abs(1 - 2 * sinceChange / 0.12)) : 1) * look.eyeSquash
        // each bot blinks on its own beat, not the whole list at once
        let beat = Double(color.unicodeScalars.reduce(0) { $0 &+ Int($1.value) } % 17) / 4
        let blinking = now != nil && sinceChange > 0.4 && (t + beat).truncatingRemainder(dividingBy: 4.3) < 0.11
        let eyeSide = layout.eyeBox * diameter
        let eyeScale = eyeSide / GlyphFaces.viewBox
        let eyeStroke = max(GlyphFaces.stroke, layout.minStrokePx / eyeScale)
        var eyes = context
        eyes.translateBy(x: faceCentre.x, y: faceCentre.y)
        eyes.rotate(by: .degrees(GlyphFaces.tiltDegrees))
        for (glyph, x) in [(face.left, -layout.eyeX), (face.right, layout.eyeX)] {
            var eye = eyes
            eye.translateBy(x: (x + look.eyeShift.width) * diameter, y: (layout.eyeY + look.eyeShift.height) * diameter)
            eye.scaleBy(x: eyeScale, y: eyeScale * squash)
            eye.translateBy(x: -GlyphFaces.viewBox / 2, y: -GlyphFaces.viewBox / 2)
            eye.stroke(Path(GlyphFaces.path(blinking ? "dash" : glyph)), with: .color(paint.ink),
                       style: StrokeStyle(lineWidth: eyeStroke, lineCap: .round, lineJoin: .round))
        }

        // The accent carries the mood at a glance; under the minimum size it
        // is noise, so small faces show the eyes alone.
        guard side >= layout.accentMinSize, let accent = face.accent, let anchor = face.anchor,
              let place = GlyphFaces.placement(anchor) else { return }
        let pop = sinceChange < 0.22 ? easeOutBack(sinceChange / 0.22) : 1
        let float = now == nil || anchor == .split ? 0 : sin(t * 2 * .pi / 1.8) * 0.025 * diameter
        let boxSide = place.box * diameter * pop
        let boxScale = boxSide / GlyphFaces.viewBox
        guard boxScale > 0 else { return }
        var mark = context
        mark.translateBy(x: centre.x + place.x * diameter - boxSide / 2, y: centre.y + place.y * diameter - boxSide / 2 + float)
        mark.scaleBy(x: boxScale, y: boxScale)
        mark.stroke(Path(GlyphFaces.path(accent)), with: .color(paint.accent),
                    style: StrokeStyle(lineWidth: max(place.stroke, layout.minStrokePx / boxScale), lineCap: .round, lineJoin: .round))
    }

    /// Area centroid of every body in its 100 box, sampled once.
    private static let massCentre: [String: CGPoint] = Dictionary(uniqueKeysWithValues: FlatMascotBodies.all.map { body in
        let outline = FlatMascotBodies.outline(body.id)
        var sum = CGPoint.zero, count = 0.0
        for y in stride(from: 1.0, to: 100, by: 2) {
            for x in stride(from: 1.0, to: 100, by: 2) where outline.contains(CGPoint(x: x, y: y)) {
                sum.x += x; sum.y += y; count += 1
            }
        }
        return (body.id, count > 0 ? CGPoint(x: sum.x / count, y: sum.y / count) : CGPoint(x: 50, y: 50))
    })

    private static func easeOutBack(_ t: Double) -> Double {
        let c = 1.7, u = min(max(t, 0), 1) - 1
        return 1 + (c + 1) * u * u * u + c * u * u
    }
}

/// A face drawn off its state's table: other eye glyphs, another accent, the
/// eyes shifted (a glance, in body diameters, before the tilt) or squashed (a
/// blink). The chat list's idle faces use it; everything else draws plain.
struct GlyphLook: Equatable {
    var left: String?
    var right: String?
    var accent: String?
    var anchor: GlyphAccentAnchor?
    var hidesAccent = false
    var eyeShift: CGSize = .zero
    var eyeSquash: CGFloat = 1
}

extension MausState {
    /// The glyph face for this state. `listening` is how the phone spells
    /// "waiting on you" (`MausState.face(for: .waiting)`), so it gets the
    /// waiting face rather than the desktop's listening -> searching.
    var glyphState: GlyphFaceState {
        self == .listening ? .waiting : GlyphFaces.state(for: rawValue)
    }
}
