import Foundation
import CoreGraphics

/// Preview-only choreography parameters layered on the retained flat catalog.
/// This does not replace MausFaceEngine or choose a production bot expression.
public enum MascotActivity: String, CaseIterable, Sendable { case idle, thinking, searching, working, waiting, finished }

public struct MascotActivityPose: Equatable, Sendable {
    public var scaleX: Double = 1
    public var scaleY: Double = 1
    public var rotation: Double = 0
    public var x: Double = 0
    public var y: Double = 0
    public var curl: Double = 0
    public var split: Double = 0
    public var bounce: Double = 0
    public var gaze: Double = 0
    public var eyeScale: Double = 1
    public var faceScale: Double = 1
    public var gazeY: Double = 0
    public var radius: Double = 28
    public static let idle = MascotActivityPose()
    public func interpolated(to other: Self, progress: Double) -> Self {
        let t = min(1, max(0, progress))
        func mix(_ a: Double, _ b: Double) -> Double { a + (b - a) * t }
        return Self(scaleX: mix(scaleX, other.scaleX), scaleY: mix(scaleY, other.scaleY), rotation: mix(rotation, other.rotation),
            x: mix(x, other.x), y: mix(y, other.y), curl: mix(curl, other.curl), split: mix(split, other.split),
            bounce: mix(bounce, other.bounce), gaze: mix(gaze, other.gaze), eyeScale: mix(eyeScale, other.eyeScale),
            faceScale: mix(faceScale, other.faceScale), gazeY: mix(gazeY, other.gazeY), radius: mix(radius, other.radius))
    }
}

public enum MascotActivityChoreography {
    public static let transitionDuration = 0.3
    public static func gestureDuration(_ state: MascotActivity) -> Double {
        switch state { case .idle: return 0; case .thinking: return 1.6; case .searching: return 1.2; case .working: return 1.8; case .waiting: return 0.8; case .finished: return 0.9 }
    }
    public static func period(_ state: MascotActivity) -> Double {
        switch state { case .idle: return 0; case .thinking: return 4.6; case .searching: return 3.7; case .working: return 4.6; case .waiting: return 5; case .finished: return 0.9 }
    }
    public static func pose(_ state: MascotActivity, elapsed: Double, reducedMotion: Bool = false) -> MascotActivityPose {
        let duration = gestureDuration(state)
        guard duration > 0 else { return .idle }
        let local = state == .finished ? max(0, elapsed) : max(0, elapsed).truncatingRemainder(dividingBy: period(state))
        var t = reducedMotion ? 0.5 : min(1, local / duration)
        let rest = state == .waiting ? MascotActivityPose(scaleX: 1.25, scaleY: 0.25, eyeScale: 0.75) : .idle
        guard reducedMotion || local < duration else { return rest }
        if reducedMotion {
            switch state { case .thinking: t = 0.49; case .searching: t = 0.26; case .waiting: t = 1; case .finished: t = 0.36; default: break }
        }
        // Visual provenance: Firaz's existing full-body-mascot-preview.ts in
        // bos-mascot-polish. The contour and keys match; cadence is the shared
        // approved 1.6/1.2/1.8s gestures and 3/2.5/2.8s rest windows.
        let frames: [(Double, MascotActivityPose)]
        switch state {
        case .thinking:
            frames = [(0,.idle),(0.1,.idle),(0.24,.init(scaleX:0.9,scaleY:1.18,y:-4,gazeY:-6)),
                (0.36,.init(scaleX:0.96,scaleY:1.08,rotation:-13,gaze:-4,gazeY:-5)),
                (0.49,.init(y:2,curl:1,eyeScale:0.4,faceScale:0.75)),(0.61,.init(curl:1,gaze:3,faceScale:0.75,gazeY:-4)),
                (0.76,.init(scaleX:1.04,scaleY:0.97,rotation:5)),(0.9,.idle),(1,.idle)]
        case .searching:
            frames = [(0,.idle),(0.1,.idle),(0.26,.init(scaleX:1.2,scaleY:0.88,rotation:-8,x:-7,gaze:-12)),
                (0.38,.init(scaleX:1.1,scaleY:0.95,x:-5,gaze:-10)),(0.5,.idle),
                (0.67,.init(scaleX:1.2,scaleY:0.88,rotation:8,x:7,gaze:12)),(0.77,.init(scaleX:1.08,scaleY:0.94,x:4,gaze:9)),
                (0.9,.init(scaleX:0.98,scaleY:1.03)),(1,.idle)]
        case .working:
            frames = [(0,.init(radius:16)),(0.12,.init(scaleX:1.08,scaleY:0.9,radius:16)),
                (0.24,.init(curl:1,split:1,faceScale:0.44,radius:16)),(0.74,.init(curl:1,split:1,faceScale:0.44,radius:16)),
                (0.85,.init(curl:1,faceScale:0.7,radius:16)),(0.94,.init(scaleX:1.04,scaleY:0.97,radius:16)),(1,.init(radius:16))]
        case .waiting:
            if elapsed >= period(state), !reducedMotion {
                frames = [(0,rest),(0.5,.init(scaleX:1.25,scaleY:0.33,eyeScale:0.75,gazeY:-4)),(1,rest)]
            } else { frames = [(0,.idle),(0.12,.init(scaleX:0.96,scaleY:1.04)),(0.35,rest),(1,rest)] }
        case .finished:
            frames = [(0,.idle),(0.14,.init(scaleX:1.14,scaleY:0.78,y:3,eyeScale:0.55)),
                (0.36,.init(scaleX:0.86,scaleY:1.15,rotation:-17,y:-19,eyeScale:1.1)),
                (0.53,.init(scaleX:0.96,scaleY:1.04,rotation:12,y:-13)),(0.69,.init(scaleX:1.2,scaleY:0.75,y:3,eyeScale:0.35)),
                (0.79,.init(scaleX:0.96,scaleY:1.06,y:-2)),(0.9,.idle),(1,.idle)]
        case .idle: return .idle
        }
        for index in 1..<frames.count where t <= frames[index].0 {
            let a = frames[index - 1], b = frames[index]
            let u = (t - a.0) / (b.0 - a.0)
            return a.1.interpolated(to: b.1, progress: u * u * (3 - 2 * u))
        }
        return frames.last!.1
    }
    /// Sleeps through rest windows: no 30fps idle/offscreen TimelineView.
    public static func nextFrameDelay(_ state: MascotActivity, elapsed: Double) -> Double {
        let duration = gestureDuration(state), cycle = period(state)
        guard cycle > 0 else { return 3600 }
        if state == .finished { return elapsed < duration ? 1 / 30 : 3600 }
        let local = max(0, elapsed).truncatingRemainder(dividingBy: cycle)
        return local < duration ? 1 / 30 : max(1 / 30, cycle - local)
    }
    public static func nextFrameDelayIfMoving(_ state: MascotActivity, elapsed: Double) -> Double? {
        guard state != .idle, state != .finished || elapsed < gestureDuration(state) else { return nil }
        return nextFrameDelay(state, elapsed: elapsed)
    }
    /// Tools whose run reads as a search (the desktop's `SEARCH_TOOLS`): the
    /// mascot peeks side to side rather than working.
    public static let searchTools: Set<String> = ["web_search", "search_query", "browser_search", "search"]
    /// Candidate adapter to existing decoded task/message fields. Uncalled by
    /// the app until preview approval; role titles never choose runtime work.
    public static func activity(task: BotTask, last: Message?) -> MascotActivity {
        activity(runtime: task.activity, busy: task.busy == true,
            waitingOnTeammate: task.waitingOnTeammate == true,
            pendingRequest: last?.card?.isPending == true || last?.secret?.isPending == true,
            toolName: last?.tool?.name)
    }
    /// Proposed production adapter inputs are real runtime fields, not titles
    /// or personality. Approval/teammate/queue waits dominate a stale busy flag.
    public static func activity(runtime: String?, busy: Bool, waitingOnTeammate: Bool, pendingRequest: Bool, toolName: String?) -> MascotActivity {
        if waitingOnTeammate || pendingRequest || ["waiting-on-you", "waiting", "queued"].contains(runtime ?? "") { return .waiting }
        guard busy || ["working", "running", "thinking", "searching"].contains(runtime ?? "") else { return .idle }
        if runtime == "thinking" { return .thinking }
        if runtime == "searching" || searchTools.contains(toolName?.lowercased() ?? "") { return .searching }
        return .working
    }
}

/// Requires a real turn ID and an observed live active turn. Snapshot hydration
/// marks terminal IDs seen, and never produces a celebratory completion.
public struct MascotCompletionLedger {
    private var activeID: String?
    private var finishedIDs: [String] = []
    public init() {}
    public mutating func observe(turnID: String?, active: Bool, completed: Bool, hydration: Bool) -> Bool {
        guard let turnID else { return false }
        if hydration {
            if completed { remember(turnID); if activeID == turnID { activeID = nil } }
            else if active { activeID = turnID }
            return false
        }
        if active { activeID = turnID; return false }
        guard completed, activeID == turnID, !finishedIDs.contains(turnID) else { return false }
        activeID = nil; remember(turnID); return true
    }
    private mutating func remember(_ id: String) {
        if !finishedIDs.contains(id) { finishedIDs.append(id) }
        if finishedIDs.count > 64 { finishedIDs.removeFirst(finishedIDs.count - 64) }
    }
}

/// Reuses FlatMascotBodies' parsed outline; caches perimeter samples once per
/// silhouette. Curling changes contour points, rather than rotating a sticker.
public enum MascotActivityGeometry {
    private static var cache: [String: [CGPoint]] = [:]
    private static let lock = NSLock()
    public static func ring(_ bodyID: String?) -> [CGPoint] {
        let body = FlatMascotBodies.body(bodyID)
        lock.lock(); defer { lock.unlock() }
        if let ring = cache[body.id] { return ring }
        var points: [CGPoint] = [], current = CGPoint.zero, start = CGPoint.zero
        FlatMascotBodies.outline(body.id).applyWithBlock { pointer in
            let element = pointer.pointee
            switch element.type {
            case .moveToPoint: current = element.points[0]; start = current; points.append(current)
            case .addLineToPoint: current = element.points[0]; points.append(current)
            case .addCurveToPoint:
                let a = current, b = element.points[0], c = element.points[1], d = element.points[2]
                for step in 1...16 {
                    let t = CGFloat(step) / 16, u = 1 - t
                    points.append(CGPoint(x: u*u*u*a.x + 3*u*u*t*b.x + 3*u*t*t*c.x + t*t*t*d.x,
                                          y: u*u*u*a.y + 3*u*u*t*b.y + 3*u*t*t*c.y + t*t*t*d.y))
                }
                current = d
            case .closeSubpath: points.append(start); current = start
            default: break
            }
        }
        var distances: [CGFloat] = [0]
        for index in 1..<points.count { distances.append(distances.last! + hypot(points[index].x - points[index - 1].x, points[index].y - points[index - 1].y)) }
        let total = distances.last ?? 0
        var ring: [CGPoint] = []
        for index in 0..<128 {
            let target = total * CGFloat(index) / 128
            let upper = distances.firstIndex { $0 >= target } ?? (points.count - 1)
            let lower = max(0, upper - 1), span = distances[upper] - distances[lower]
            let t = span > 0 ? (target - distances[lower]) / span : 0
            ring.append(CGPoint(x: points[lower].x + (points[upper].x - points[lower].x) * t, y: points[lower].y + (points[upper].y - points[lower].y) * t))
        }
        cache[body.id] = ring; return ring
    }
    public static func curledRing(_ bodyID: String?, amount: Double, radius: Double = 28) -> [CGPoint] {
        let ring = ring(bodyID), t = CGFloat(min(1, max(0, amount)))
        let start = atan2(ring[0].y - 50, ring[0].x - 50)
        let area = ring.enumerated().reduce(CGFloat.zero) { sum, pair in
            let next = ring[(pair.offset + 1) % ring.count]
            return sum + pair.element.x * next.y - next.x * pair.element.y
        }
        let winding: CGFloat = area >= 0 ? 1 : -1
        return ring.enumerated().map { index, point in
            let angle = start + winding * CGFloat(index) / CGFloat(ring.count) * .pi * 2
            let circle = CGPoint(x: 50 + cos(angle) * CGFloat(radius), y: 50 + sin(angle) * CGFloat(radius))
            return CGPoint(x: point.x + (circle.x - point.x) * t, y: point.y + (circle.y - point.y) * t)
        }
    }
}
