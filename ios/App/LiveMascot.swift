// A mascot that answers to something live: its own voice on a call, a finger
// on its profile. GlyphMark and MausAvatar play a state; this one draws
// whatever pose `CompanionCore`'s live motion hands it each frame, and morphs
// smoothly when its colour, body or eyes change underneath it.
//
// Calm when left alone, wild when touched. Every bot keeps its own body and
// colour. Reduce Motion keeps the eyes, their squash and the blink, stills the
// body, and turns a body change into a crossfade.
import CompanionCore
import SwiftUI
import UIKit

struct LiveMascot: View {
    let color: String
    var bodyId: String?
    var eyeStyle: MascotEyeStyle = .glyph
    var face: GlyphFaceState = .idle
    /// The state's accent glyph (the thinking `?`); off while it talks or
    /// listens, where the eyes and the nods say it instead.
    var accent = true
    var size: CGFloat
    /// The pose for a frame. Called once per frame on the main actor.
    let pose: (Date) -> LiveMascotPose

    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @State private var memory = LiveMascotMemory()
    @State private var onScreen = false

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 60, paused: scenePhase != .active || !onScreen)) { timeline in
            let now = timeline.date
            let raw = pose(now)
            let frame = memory.frame(at: now, color: color, bodyId: bodyId, eyes: eyeStyle, face: face,
                                     calm: reduceMotion)
            let shown = reduceMotion ? raw.calmed : raw
            let scheme = scheme, face = face, accent = accent
            Canvas { context, canvas in
                let slot = CGRect(x: canvas.width / 4, y: canvas.height / 4, width: canvas.width / 2, height: canvas.height / 2)
                for layer in frame.layers where layer.opacity > 0.01 {
                    var layered = context
                    layered.opacity = layer.opacity
                    Self.draw(in: &layered, slot: slot, color: frame.color, bodyId: layer.bodyId, eyes: layer.eyes,
                              face: face, accent: accent && layer.isCurrent, scheme: scheme, pose: shown,
                              scale: layer.scale, t: now.timeIntervalSinceReferenceDate,
                              sinceFace: frame.sinceFace, blinking: frame.blinking)
                }
            }
        }
        // The accent floats outside the body, so the canvas is twice the
        // slot; only the slot itself takes touches.
        .frame(width: size * 2, height: size * 2)
        .contentShape(Rectangle().inset(by: size / 2))
        .frame(width: size, height: size)
        .onAppear { onScreen = true }
        .onDisappear { onScreen = false }
    }

    // MARK: - Drawing

    /// One frame of one body. The whole body squashes, leans and nods about
    /// the point it stands on, so a nod dips toward you instead of shrinking.
    static func draw(in context: inout GraphicsContext, slot: CGRect, color: String, bodyId: String?,
                     eyes eyeStyle: MascotEyeStyle, face state: GlyphFaceState, accent showAccent: Bool,
                     scheme: ColorScheme, pose: LiveMascotPose, scale: CGFloat, t: TimeInterval,
                     sinceFace: TimeInterval, blinking: Bool) {
        let side = min(slot.width, slot.height)
        let k = side / 100
        let outline = FlatMascotBodies.outline(bodyId)
        let bounds = outline.boundingBoxOfPath
        let origin = CGPoint(x: slot.midX - side / 2, y: slot.midY - side / 2)
        let ground = CGPoint(x: origin.x + bounds.midX * k, y: origin.y + bounds.maxY * k)

        let sy = (1 + 0.09 * pose.stretch - 0.07 * pose.nod) * scale
        let sx = (1 - 0.05 * pose.stretch + 0.035 * pose.nod) * scale
        var body = context
        body.translateBy(x: ground.x, y: ground.y - pose.lift * side + pose.nod * 0.03 * side)
        body.rotate(by: .degrees(Double(pose.lean)))
        body.scaleBy(x: sx, y: sy)
        body.translateBy(x: -ground.x, y: -ground.y)

        if eyeStyle == .glyph {
            drawGlyph(in: &body, accentContext: context, slot: slot, origin: origin, k: k, outline: outline,
                      bounds: bounds, color: color, bodyId: bodyId, state: state, accent: showAccent, scheme: scheme,
                      pose: pose, lift: pose.lift * side, t: t, sinceFace: sinceFace, blinking: blinking)
        } else {
            drawClassic(in: &body, origin: origin, k: k, outline: outline, color: color, bodyId: bodyId,
                        style: eyeStyle, pose: pose, blinking: blinking)
        }
    }

    private static func drawGlyph(in context: inout GraphicsContext, accentContext: GraphicsContext, slot: CGRect,
                                  origin: CGPoint, k: CGFloat, outline: CGPath, bounds: CGRect, color: String,
                                  bodyId: String?, state: GlyphFaceState, accent showAccent: Bool, scheme: ColorScheme,
                                  pose: LiveMascotPose, lift: CGFloat, t: TimeInterval, sinceFace: TimeInterval,
                                  blinking: Bool) {
        let layout = GlyphFaces.layout
        let paint = GlyphMark.colors(color, scheme: scheme)
        let face = GlyphFaces.face(state)
        let side = 100 * k

        var shape = context
        shape.translateBy(x: origin.x, y: origin.y)
        shape.scaleBy(x: k, y: k)
        shape.fill(Path(outline), with: .color(paint.body))
        if GlyphFaces.contrast(GlyphFaces.resolveColor(color), scheme == .dark ? "#111111" : "#FFFFFF") < 1.25 {
            shape.stroke(Path(outline), with: .color(paint.ink.opacity(0.22)), lineWidth: max(1, side / 52) / k)
        }

        let diameter = min(bounds.width, bounds.height) * k
        let centre = CGPoint(x: origin.x + bounds.midX * k, y: origin.y + bounds.midY * k)
        let mass = massCentre[FlatMascotBodies.body(bodyId).id] ?? CGPoint(x: bounds.midX, y: bounds.midY)
        // The face slides over the body toward where it looks, and dips with
        // a nod a touch more than the body does, like a chin tucking in.
        let faceCentre = CGPoint(x: origin.x + mass.x * k + pose.gaze.x * 0.07 * diameter,
                                 y: origin.y + mass.y * k + pose.gaze.y * 0.06 * diameter + pose.nod * 0.05 * diameter)

        let squash = sinceFace < 0.12 ? max(0.15, abs(1 - 2 * sinceFace / 0.12)) : 1
        let eyeSide = layout.eyeBox * diameter * pose.eyeScale
        let eyeScale = eyeSide / GlyphFaces.viewBox
        let eyeStroke = max(GlyphFaces.stroke, layout.minStrokePx / eyeScale)
        var eyes = context
        eyes.translateBy(x: faceCentre.x, y: faceCentre.y)
        eyes.rotate(by: .degrees(GlyphFaces.tiltDegrees))
        for (glyph, x) in [(face.left, -layout.eyeX), (face.right, layout.eyeX)] {
            var eye = eyes
            eye.translateBy(x: x * diameter, y: layout.eyeY * diameter)
            // its own voice squashes the eyes: no mouth, the face talks with them
            eye.scaleBy(x: eyeScale * (1 + 0.08 * pose.voice), y: eyeScale * squash * (1 - 0.32 * pose.voice))
            eye.translateBy(x: -GlyphFaces.viewBox / 2, y: -GlyphFaces.viewBox / 2)
            eye.stroke(Path(GlyphFaces.path(blinking ? "dash" : glyph)), with: .color(paint.ink),
                       style: StrokeStyle(lineWidth: eyeStroke, lineCap: .round, lineJoin: .round))
        }

        guard showAccent, side >= layout.accentMinSize, let accent = face.accent, let anchor = face.anchor,
              let place = GlyphFaces.placement(anchor) else { return }
        let pop = sinceFace < 0.22 ? easeOutBack(sinceFace / 0.22) : 1
        let float = anchor == .split ? 0 : sin(t * 2 * .pi / 1.8) * 0.025 * diameter
        let boxSide = place.box * diameter * pop
        let boxScale = boxSide / GlyphFaces.viewBox
        guard boxScale > 0 else { return }
        // the accent hovers beside the body, so it rides the lift but not the lean
        var mark = accentContext
        mark.translateBy(x: centre.x + place.x * diameter - boxSide / 2,
                         y: centre.y + place.y * diameter - boxSide / 2 + float - lift)
        mark.scaleBy(x: boxScale, y: boxScale)
        mark.stroke(Path(GlyphFaces.path(accent)), with: .color(paint.accent),
                    style: StrokeStyle(lineWidth: max(place.stroke, layout.minStrokePx / boxScale), lineCap: .round, lineJoin: .round))
    }

    /// The picked classic/round/arches/angled eyes, the same outlines as
    /// FlatBotMark, sliding with the gaze and widening with attention.
    private static func drawClassic(in context: inout GraphicsContext, origin: CGPoint, k: CGFloat, outline: CGPath,
                                    color: String, bodyId: String?, style: MascotEyeStyle, pose: LiveMascotPose,
                                    blinking: Bool) {
        let body = FlatMascotBodies.body(bodyId)
        var shape = context
        shape.translateBy(x: origin.x, y: origin.y)
        shape.scaleBy(x: k, y: k)
        shape.fill(Path(outline), with: .color(MausPalette.color(color)))

        let ink = Color(hex: "#151515")
        var face = shape
        face.translateBy(x: body.faceX * 0.5 + pose.gaze.x * 3.5, y: body.faceY + pose.gaze.y * 3 + pose.nod * 2)
        // scale the eyes about their own middle
        let eyeCentre = CGPoint(x: 53.25, y: 45)
        var eyes = face
        eyes.translateBy(x: eyeCentre.x, y: eyeCentre.y)
        eyes.scaleBy(x: pose.eyeScale * (1 + 0.08 * pose.voice), y: pose.eyeScale * (1 - 0.32 * pose.voice))
        eyes.translateBy(x: -eyeCentre.x, y: -eyeCentre.y)
        for path in style.paths(openness: blinking ? 0.14 : 1) {
            eyes.fill(Path(path), with: .color(ink))
        }
    }

    /// Area centroid of every body in its 100 box, sampled once; the glyph
    /// eyes sit on the body's mass, the same way GlyphMark places them.
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

    static func easeOutBack(_ t: Double) -> Double {
        let c = 1.7, u = min(max(t, 0), 1) - 1
        return 1 + (c + 1) * u * u * u + c * u * u
    }
}

/// What the mascot remembers between frames: where its colour was heading,
/// the body it is morphing out of, when its face last changed. A plain class
/// so updating it mid-frame never invalidates the view.
final class LiveMascotMemory {
    struct Layer {
        let bodyId: String?
        let eyes: MascotEyeStyle
        let scale: CGFloat
        let opacity: Double
        let isCurrent: Bool
    }

    struct Frame {
        let color: String
        let layers: [Layer]
        let sinceFace: TimeInterval
        let blinking: Bool
    }

    private var colorFrom: String?
    private var colorTo: String?
    private var colorAt = Date.distantPast
    private var shape: (body: String?, eyes: MascotEyeStyle)?
    private var previous: (body: String?, eyes: MascotEyeStyle)?
    private var shapeAt = Date.distantPast
    private var face: GlyphFaceState?
    private var faceAt = Date.distantPast

    static let colorTime: TimeInterval = 0.4
    static let morphTime: TimeInterval = 0.5

    func frame(at now: Date, color: String, bodyId: String?, eyes: MascotEyeStyle, face: GlyphFaceState,
               calm: Bool) -> Frame {
        // colour: glide from wherever it is right now to the new one
        let shownColor = currentColor(at: now)
        if colorTo == nil { colorTo = color; colorFrom = color }
        if color != colorTo {
            colorFrom = shownColor ?? color
            colorTo = color
            colorAt = now
        }

        let normal = FlatMascotBodies.body(bodyId).id
        if shape == nil { shape = (normal, eyes) }
        if let old = shape, old.body != normal || old.eyes != eyes {
            previous = old
            shape = (normal, eyes)
            shapeAt = now
        }

        if self.face == nil { self.face = face }
        if face != self.face { self.face = face; faceAt = now }

        // the old body shrinks away while the new one pops in past full size
        let p = now.timeIntervalSince(shapeAt) / Self.morphTime
        var layers: [Layer] = []
        if let previous, p < 1 {
            let out = min(1, p * 2)
            layers.append(Layer(bodyId: previous.body, eyes: previous.eyes,
                                scale: calm ? 1 : 1 - 0.35 * out, opacity: 1 - out, isCurrent: false))
        } else {
            previous = nil
        }
        let pop = p < 1 ? (calm ? 1 : 0.55 + 0.45 * LiveMascot.easeOutBack(p)) : 1
        layers.append(Layer(bodyId: normal, eyes: eyes, scale: pop, opacity: p < 1 ? min(1, p * 2.5) : 1,
                            isCurrent: true))

        let sinceFace = now.timeIntervalSince(faceAt)
        // each bot blinks on its own beat
        let beat = Double((colorTo ?? color).unicodeScalars.reduce(0) { $0 &+ Int($1.value) } % 17) / 4
        let blinking = sinceFace > 0.4 && (now.timeIntervalSinceReferenceDate + beat).truncatingRemainder(dividingBy: 4.3) < 0.11

        return Frame(color: currentColor(at: now) ?? color, layers: layers, sinceFace: sinceFace, blinking: blinking)
    }

    private func currentColor(at now: Date) -> String? {
        guard let colorFrom, let colorTo else { return nil }
        let p = now.timeIntervalSince(colorAt) / Self.colorTime
        if p >= 1 { return colorTo }
        // ease out: most of the change lands early, so a swatch tap feels instant
        let eased = 1 - pow(1 - max(0, p), 3)
        return LiveMascotColor.blend(colorFrom, colorTo, CGFloat(eased))
    }
}

// MARK: - Profile

/// The bot on its own profile: its face follows your finger, it leans toward
/// it, and a tap wobbles it and cycles its mood. Left alone it breathes and
/// glances around.
struct ProfileLiveMascot: View {
    let color: String
    var bodyId: String?
    var eyeStyle: MascotEyeStyle = .glyph
    var size: CGFloat = 132
    var name: String

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var motion = FingerMotionBox()
    @State private var mood = 0

    /// The moods a tap walks through; failed is left out on purpose.
    static let moods: [GlyphFaceState] = [.happy, .idle, .thinking, .searching, .working, .waiting, .finished]

    var body: some View {
        GeometryReader { proxy in
            let centre = CGPoint(x: proxy.size.width / 2, y: proxy.size.height / 2)
            LiveMascot(color: color, bodyId: bodyId, eyeStyle: eyeStyle, face: Self.moods[mood], size: size) { date in
                motion.motion.step(at: date.timeIntervalSinceReferenceDate)
            }
            .position(centre)
            .frame(width: proxy.size.width, height: proxy.size.height)
            .contentShape(Rectangle())
            .gesture(DragGesture(minimumDistance: 0, coordinateSpace: .local)
                .onChanged { value in
                    let reach = size * 1.2
                    motion.motion.finger = CGPoint(x: (value.location.x - centre.x) / reach,
                                                   y: (value.location.y - centre.y) / reach)
                }
                .onEnded { value in
                    motion.motion.finger = nil
                    if hypot(value.translation.width, value.translation.height) < 10 { tap() }
                })
        }
        .frame(height: size + 56)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(name) avatar")
        .accessibilityHint("Double tap to change its mood")
        .accessibilityAddTraits(.isButton)
        .accessibilityAction { tap() }
    }

    private func tap() {
        motion.motion.poke(at: Date().timeIntervalSinceReferenceDate)
        mood = (mood + 1) % Self.moods.count
        UIImpactFeedbackGenerator(style: .soft).impactOccurred()
    }
}

/// Holds the spring state outside SwiftUI's diffing; it changes every frame.
final class FingerMotionBox {
    var motion = FingerMascotMotion()
}

/// Same for a call: one per call screen.
final class CallMotionBox {
    var motion = CallMascotMotion()
}

// MARK: - Preview

/// `-call-mascot-preview`: the call mascot on a black stage, driven by a
/// made-up conversation (it talks, you talk, it thinks), so the call face can
/// be checked and screenshotted without a live line. `-call-mascot-mode
/// speaking|listening|thinking` holds one mode.
struct LiveMascotCallPreview: View {
    @State private var motion = CallMotionBox()

    private static let script: [(CallMascotMotion.Mode, TimeInterval)] = [(.speaking, 3), (.listening, 3), (.thinking, 2)]

    private static var held: CallMascotMotion.Mode? {
        let args = ProcessInfo.processInfo.arguments
        guard let i = args.firstIndex(of: "-call-mascot-mode"), i + 1 < args.count else { return nil }
        switch args[i + 1] {
        case "speaking": return .speaking
        case "listening": return .listening
        case "thinking": return .thinking
        default: return .idle
        }
    }

    private static func mode(at t: TimeInterval) -> CallMascotMotion.Mode {
        if let held { return held }
        var left = t.truncatingRemainder(dividingBy: script.reduce(0) { $0 + $1.1 })
        for (mode, length) in script {
            if left < length { return mode }
            left -= length
        }
        return .idle
    }

    var body: some View {
        TimelineView(.periodic(from: .now, by: 0.25)) { timeline in
            let mode = Self.mode(at: timeline.date.timeIntervalSinceReferenceDate)
            ZStack {
                Color.black.ignoresSafeArea()
                VStack(spacing: 6) {
                    LiveMascot(color: "#FF7A1A", bodyId: "squircle", face: mode == .thinking ? .thinking : .waiting,
                               accent: mode == .thinking, size: 96) { date in
                        let t = date.timeIntervalSinceReferenceDate
                        let mode = Self.mode(at: t)
                        // syllables: a voice that rises and falls a few times a second
                        let voice = Float(max(0, sin(t * 9) * 0.6 + sin(t * 3.7) * 0.4)) * 0.13
                        return motion.motion.step(at: t, mode: mode, speaker: mode == .speaking ? voice : 0,
                                                  mic: mode == .listening ? voice : 0)
                    }
                    .padding(.vertical, 6)
                    Text("bos").font(.system(size: 17, weight: .semibold)).foregroundStyle(.white)
                    Text(String(describing: mode)).font(.system(size: 13)).foregroundStyle(.gray)
                    Spacer()
                }
                .padding(.top, 60)
            }
        }
    }
}
