// Isolated review surface. No production avatar, ChatView, or Session wiring.
// Visual source: Firaz's existing bos-mascot-polish/full-body-mascot-preview.ts.
import SwiftUI
import CompanionCore
import UIKit

struct MascotActivityPreview: View {
    @State private var activity: MascotActivity = .thinking
    @State private var botIndex = 0
    @State private var paused = false
    @State private var reduced = false
    @State private var replay = 0
    @State private var viewport = CGRect.zero
    private let bots = [("bos", "star", "white"), ("oracle", "sun", "coral"), ("build", "squircle", "purple"), ("life", "bean", "green")]
    private var bot: (String, String, String) { bots[botIndex] }
    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVStack(spacing: 22) {
                    Text("Whole-body activity preview").font(.title2.bold())
                    Text("Review only · production avatars stay unchanged")
                        .font(.caption).foregroundStyle(.secondary)
                    Picker("Bot silhouette", selection: $botIndex) {
                        ForEach(bots.indices, id: \.self) { index in Text(bots[index].0).tag(index) }
                    }.pickerStyle(.segmented)
                    MascotPreviewMark(color: bot.2, bodyID: bot.1, activity: activity, size: 200,
                                      paused: paused, reduced: reduced, replay: replay)
                        .frame(maxWidth: .infinity).padding(.vertical, 12)
                    HStack(spacing: 22) {
                        VStack { MascotPreviewMark(color: bot.2, bodyID: bot.1, activity: activity, size: 32, paused: paused, reduced: reduced, replay: replay); Text("32px chat").font(.caption) }
                        VStack { MascotPreviewMark(color: bot.2, bodyID: bot.1, activity: activity, size: 44, paused: paused, reduced: reduced, replay: replay); Text("44px chat").font(.caption) }
                        VStack { MascotPreviewMark(color: bot.2, bodyID: bot.1, activity: activity, size: 48, paused: paused, reduced: reduced, replay: replay); Text("48px source").font(.caption) }
                    }
                    Picker("Activity", selection: $activity) {
                        ForEach(MascotActivity.allCases, id: \.self) { Text($0.rawValue.capitalized).tag($0) }
                    }.pickerStyle(.menu)
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
                                MascotPreviewMark(color: bots[index].2, bodyID: bots[index].1, activity: activity,
                                    size: 88, paused: paused, reduced: reduced, replay: replay)
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
/// choreography to those contours; production MausAvatar is untouched.
private struct MascotPreviewMark: View {
    let color: String
    let bodyID: String
    let activity: MascotActivity
    let size: CGFloat
    let paused: Bool
    let reduced: Bool
    let replay: Int
    @Environment(\.accessibilityReduceMotion) private var systemReduced
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.mascotPreviewViewport) private var viewport
    @State private var visible = false
    @State private var elapsed = 0.0
    @State private var currentActivity: MascotActivity = .idle
    @State private var currentReplay = -1
    @State private var pose = MascotActivityPose.idle
    @State private var contour: [CGPoint] = []
    @State private var faceAnchor = CGPoint(x: 50, y: 46)
    private var still: Bool { reduced || systemReduced }
    private var clockKey: String { "\(activity.rawValue):\(bodyID):\(visible):\(scenePhase == .active):\(paused):\(still):\(replay)" }

    var body: some View {
        Canvas { context, canvas in
            // Match the user's existing -17..117 viewport, including hop room.
            context.scaleBy(x: canvas.width / 134, y: canvas.height / 134)
            context.translateBy(x: 17, y: 17)
            let p = still ? MascotActivityChoreography.pose(activity, elapsed: 0, reducedMotion: true) : pose
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
            let searchingGaze = activity == .working && p.split > 0.5 && !still ? sin(elapsed / 0.45) * 6 : p.gaze
            eyes.translateBy(x: anchor.x + searchingGaze * p.faceScale, y: anchor.y + p.gazeY * p.faceScale)
            let eyeYCounter = activity == .waiting ? 1 / max(0.3, p.scaleY) : 1
            eyes.scaleBy(x: p.faceScale, y: p.faceScale * eyeYCounter)
            eyes.translateBy(x: -50, y: -46)
            let blink = !still && sin(elapsed / 0.71 + 1.1) > 0.992 ? 0.12 : 1.0
            let openness = max(0.14, p.eyeScale * blink)
            for (index, x) in [40.0, 60.0].enumerated() {
                var eye = eyes
                if activity == .thinking {
                    eye.translateBy(x: x + 3, y: 45)
                    eye.rotate(by: .degrees(index == 0 ? 7 : -7))
                    eye.translateBy(x: -x - 3, y: -45)
                }
                let rect = CGRect(x: x, y: 45 - 7 * openness, width: 6.5, height: 14 * openness)
                eye.fill(Path(roundedRect: rect, cornerRadius: min(3.25, 7 * openness)), with: .color(Color(white: 0.082)))
            }
        }.frame(width: size, height: size)
            .accessibilityLabel("\(activity.rawValue) mascot preview")
            .background(GeometryReader { geometry in
                Color.clear.preference(key: MascotPreviewVisibilityKey.self,
                    value: !viewport.isEmpty && geometry.frame(in: .global).intersects(viewport))
            })
            .onPreferenceChange(MascotPreviewVisibilityKey.self) { visible = $0 }
            .onDisappear { visible = false }
            .task(id: clockKey) {
                guard visible, scenePhase == .active, !paused, !still else { return }
                let fromPose = pose
                let fromContour = contour.isEmpty ? MascotActivityGeometry.ring(bodyID) : contour
                let fromAnchor = faceAnchor
                if currentActivity != activity || currentReplay != replay {
                    elapsed = 0; currentActivity = activity; currentReplay = replay
                }
                var transition = 0.0
                var last = Date()
                while !Task.isCancelled {
                    let now = Date(), delta = min(max(now.timeIntervalSince(last), 0), 6)
                    last = now; elapsed += delta; transition += delta
                    let target = MascotActivityChoreography.pose(activity, elapsed: elapsed)
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
                    else if let next = MascotActivityChoreography.nextFrameDelayIfMoving(activity, elapsed: elapsed) { delay = next }
                    else { break }
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
