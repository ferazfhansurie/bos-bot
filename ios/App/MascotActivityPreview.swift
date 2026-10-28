// Review surface for the native whole-body renderer used by MausAvatar.
// Visual source: Firaz's existing bos-mascot-polish/full-body-mascot-preview.ts.
import SwiftUI
import CompanionCore
import UIKit

struct MascotActivityPreview: View {
    @State private var activity: MascotActivity = .thinking
    @State private var botIndex = 0
    @State private var paused = false
    @State private var reduced = false
    @State private var eyes: MascotEyeStyle = .classic
    @State private var replay = 0
    @State private var viewport = CGRect.zero
    private let bots = [("bos", "star", "white"), ("oracle", "sun", "coral"), ("build", "squircle", "purple"), ("life", "bean", "green")]
    private var bot: (String, String, String) { bots[botIndex] }
    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVStack(spacing: 22) {
                    Text("Whole-body activity preview").font(.title2.bold())
                    Text("App renderer preview · installation waits for review")
                        .font(.caption).foregroundStyle(.secondary)
                    Picker("Bot silhouette", selection: $botIndex) {
                        ForEach(bots.indices, id: \.self) { index in Text(bots[index].0).tag(index) }
                    }.pickerStyle(.segmented)
                    MascotActivityMark(color: bot.2, bodyID: bot.1, activity: activity, size: 200,
                                      paused: paused, reduced: reduced, replay: replay, eyeStyle: eyes)
                        .frame(maxWidth: .infinity).padding(.vertical, 12)
                    HStack(spacing: 22) {
                        VStack { MascotActivityMark(color: bot.2, bodyID: bot.1, activity: activity, size: 32, paused: paused, reduced: reduced, replay: replay, eyeStyle: eyes); Text("32px chat").font(.caption) }
                        VStack { MascotActivityMark(color: bot.2, bodyID: bot.1, activity: activity, size: 44, paused: paused, reduced: reduced, replay: replay, eyeStyle: eyes); Text("44px chat").font(.caption) }
                        VStack { MascotActivityMark(color: bot.2, bodyID: bot.1, activity: activity, size: 48, paused: paused, reduced: reduced, replay: replay, eyeStyle: eyes); Text("48px source").font(.caption) }
                    }
                    Picker("Activity", selection: $activity) {
                        ForEach(MascotActivity.allCases, id: \.self) { Text($0.rawValue.capitalized).tag($0) }
                    }.pickerStyle(.menu)
                    Picker("Eyes", selection: $eyes) {
                        ForEach(MascotEyeStyle.allCases, id: \.self) { Text($0.label).tag($0) }
                    }.pickerStyle(.segmented)
                    HStack {
                        Button(paused ? "Resume" : "Pause") { paused.toggle() }
                        Button("Replay") { replay += 1 }
                        Toggle("Still poses", isOn: $reduced).fixedSize()
                    }.buttonStyle(.bordered)
                    Text("Thinking stretches, curls and unfolds. Search peeks sideways. Work separates into three blobs with eyes on the center. Waiting settles into a puddle. Finish hops once.")
                        .font(.caption).foregroundStyle(.secondary)
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 128))], spacing: 18) {
                        ForEach(bots.indices, id: \.self) { index in
                            VStack {
                                MascotActivityMark(color: bots[index].2, bodyID: bots[index].1, activity: activity,
                                    size: 88, paused: paused, reduced: reduced, replay: replay, eyeStyle: eyes)
                                Text(bots[index].0).font(.caption.weight(.semibold))
                            }.frame(maxWidth: .infinity).padding(14)
                                .background(.quaternary, in: RoundedRectangle(cornerRadius: 16))
                        }
                    }
                    Text("Runtime mapping candidate: approval, queue and teammate waits take priority. Only a live observed turn with a stable terminal ID can trigger one finish hop; reconnect snapshots never replay it.")
                        .font(.caption).foregroundStyle(.secondary)
                }.padding(20)
            }
            .background(GeometryReader { geometry in
                let frame = geometry.frame(in: .global)
                Color.clear.onChange(of: frame, initial: true) { _, next in viewport = next }
            })
            .environment(\.mascotPreviewViewport, viewport)
            .navigationTitle("Mascot review").navigationBarTitleDisplayMode(.inline)
                .background(Color(white: 0.09)).preferredColorScheme(.dark)
        }
    }
}

/// Uses the retained flat catalog/parser and palette. It only adds review
/// choreography to those contours; no separate catalog or face engine.
struct MascotActivityMark: View {
    let color: String
    let bodyID: String
    let activity: MascotActivity
    let size: CGFloat
    var paused: Bool = false
    var reduced: Bool = false
    var replay: Int = 0
    var eyeStyle: MascotEyeStyle = .classic
    var completedTurnID: String? = nil
    var accessories: MascotAccessories? = nil
    @Environment(\.accessibilityReduceMotion) private var systemReduced
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.mascotPreviewViewport) private var viewport
    @State private var visible = false
    @State private var elapsed = 0.0
    @State private var currentActivity: MascotActivity = .idle
    @State private var currentReplay = -1
    @State private var finishRequest: String?
    @State private var pose = MascotActivityPose.idle
    @State private var contour: [CGPoint] = []
    @State private var faceAnchor = CGPoint(x: 50, y: 46)
    private var effectiveActivity: MascotActivity { finishRequest == nil ? activity : .finished }
    private var still: Bool { reduced || systemReduced }
    private var clockKey: String { "\(effectiveActivity.rawValue):\(finishRequest ?? ""):\(bodyID):\(visible):\(scenePhase == .active):\(paused):\(still):\(replay)" }

    var body: some View {
        Canvas { context, canvas in
            // Match the user's existing -17..117 viewport, including hop room.
            context.scaleBy(x: canvas.width / 134, y: canvas.height / 134)
            context.translateBy(x: 17, y: 17)
            let p = still ? MascotActivityChoreography.pose(effectiveActivity, elapsed: 0, reducedMotion: true) : pose
            let ring = still ? MascotActivityGeometry.curledRing(bodyID, amount: p.curl, radius: p.radius) : (contour.isEmpty ? MascotActivityGeometry.ring(bodyID) : contour)
            context.translateBy(x: p.x, y: p.y)
            context.translateBy(x: 50, y: 80)
            context.rotate(by: .degrees(p.rotation))
            context.scaleBy(x: p.scaleX, y: p.scaleY)
            context.translateBy(x: -50, y: -80)
            var shape = Path()
            if let first = ring.first {
                shape.move(to: first)
                for point in ring.dropFirst() { shape.addLine(to: point) }
                shape.closeSubpath()
            }
            // The source's two satellites keep bot color; eyes stay on center.
            for side in 0..<2 where p.split > 0.001 {
                let direction = side == 0 ? -1.0 : 1.0
                let jump = still ? 0 : max(0, sin(elapsed / 0.28 + Double(side) * .pi)) * 6 * p.split
                let center = CGPoint(x: 50 + direction * 31 * p.split, y: 50 - jump)
                let radius = 12 * p.split
                context.fill(Path(ellipseIn: CGRect(x: center.x - radius, y: center.y - radius, width: radius * 2, height: radius * 2)), with: .color(MausPalette.color(color)))
            }
            context.fill(shape, with: .color(MausPalette.color(color)))
            var eyes = context
            eyes.clip(to: shape)
            let catalog = FlatMascotBodies.body(bodyID)
            let anchor = still ? CGPoint(x: 50 + catalog.faceX * (1 - p.curl) * 0.5, y: 46 + catalog.faceY * (1 - p.curl)) : faceAnchor
            let searchingGaze = effectiveActivity == .working && p.split > 0.5 && !still ? sin(elapsed / 0.45) * 6 : p.gaze
            eyes.translateBy(x: anchor.x + searchingGaze * p.faceScale, y: anchor.y + p.gazeY * p.faceScale)
            let eyeYCounter = effectiveActivity == .waiting ? 1 / max(0.3, p.scaleY) : 1
            eyes.scaleBy(x: p.faceScale, y: p.faceScale * eyeYCounter)
            eyes.translateBy(x: -50, y: -46)
            let blink = !still && sin(elapsed / 0.71 + 1.1) > 0.992 ? 0.12 : 1.0
            let openness = max(0.14, p.eyeScale * blink)
            for (index, path) in eyeStyle.paths(openness: openness).enumerated() {
                let x = index == 0 ? 40.0 : 60.0
                var eye = eyes
                if effectiveActivity == .thinking {
                    eye.translateBy(x: x + 3, y: 45)
                    eye.rotate(by: .degrees(index == 0 ? 7 : -7))
                    eye.translateBy(x: -x - 3, y: -45)
                }
                eye.fill(Path(path), with: .color(Color(white: 0.082)))
            }
            // accessories move with the body and ride the eyes' own centre
            if let accessories, !accessories.isEmpty {
                let centre = CGPoint(x: anchor.x + searchingGaze * p.faceScale + 3.25 * p.faceScale,
                                     y: anchor.y + p.gazeY * p.faceScale - p.faceScale)
                var face = MascotFace.classic(centre: centre)
                face.diameter *= p.faceScale
                MascotAccessoryArt.draw(accessories, in: &context, box: CGRect(x: 0, y: 0, width: 100, height: 100),
                                        bodyId: bodyID, color: color, face: face)
            }
        }.frame(width: size, height: size)
            .accessibilityLabel("\(activity.rawValue) mascot preview")
            .background(GeometryReader { geometry in
                Color.clear.preference(key: MascotPreviewVisibilityKey.self,
                    value: geometry.frame(in: .global).intersects(viewport.isEmpty ? UIScreen.main.bounds : viewport))
            })
            .onPreferenceChange(MascotPreviewVisibilityKey.self) { visible = $0 }
            .onDisappear { visible = false }
            .onChange(of: completedTurnID) { _, id in
                if let id { finishRequest = id }
            }
            .onChange(of: activity) { _, next in
                if next != .idle { finishRequest = nil }
            }
            .task(id: clockKey) {
                guard visible, scenePhase == .active, !paused, !still else { return }
                let fromPose = pose
                let fromContour = contour.isEmpty ? MascotActivityGeometry.ring(bodyID) : contour
                let fromAnchor = faceAnchor
                if currentActivity != effectiveActivity || currentReplay != replay {
                    elapsed = 0; currentActivity = effectiveActivity; currentReplay = replay
                }
                var transition = 0.0
                var last = Date()
                while !Task.isCancelled {
                    let now = Date(), delta = min(max(now.timeIntervalSince(last), 0), 6)
                    last = now; elapsed += delta; transition += delta
                    let target = MascotActivityChoreography.pose(effectiveActivity, elapsed: elapsed)
                    let mix = min(1, transition / MascotActivityChoreography.transitionDuration)
                    let eased = mix * mix * (3 - 2 * mix)
                    pose = fromPose.interpolated(to: target, progress: eased)
                    let ring = MascotActivityGeometry.curledRing(bodyID, amount: target.curl, radius: target.radius)
                    contour = ring.enumerated().map { index, point in
                        CGPoint(x: fromContour[index].x + (point.x - fromContour[index].x) * eased,
                                y: fromContour[index].y + (point.y - fromContour[index].y) * eased)
                    }
                    let catalog = FlatMascotBodies.body(bodyID)
                    let anchor = CGPoint(x: 50 + catalog.faceX * (1 - target.curl) * 0.5, y: 46 + catalog.faceY * (1 - target.curl))
                    faceAnchor = CGPoint(x: fromAnchor.x + (anchor.x - fromAnchor.x) * eased, y: fromAnchor.y + (anchor.y - fromAnchor.y) * eased)
                    let delay: Double
                    if transition < MascotActivityChoreography.transitionDuration { delay = 1 / 30 }
                    else if let next = MascotActivityChoreography.nextFrameDelayIfMoving(effectiveActivity, elapsed: elapsed) { delay = next }
                    else { if finishRequest != nil { finishRequest = nil }; break }
                    do { try await Task.sleep(for: .seconds(delay)) } catch { break }
                }
            }
    }
}

private struct MascotPreviewViewportKey: EnvironmentKey {
    static let defaultValue = CGRect.zero
}
private extension EnvironmentValues {
    var mascotPreviewViewport: CGRect {
        get { self[MascotPreviewViewportKey.self] }
        set { self[MascotPreviewViewportKey.self] = newValue }
    }
}

private struct MascotPreviewVisibilityKey: PreferenceKey {
    static var defaultValue = false
    static func reduce(value: inout Bool, nextValue: () -> Bool) { value = value || nextValue() }
}

#if DEBUG
#Preview("Isolated whole-body choreography") { MascotActivityPreview() }
#endif
