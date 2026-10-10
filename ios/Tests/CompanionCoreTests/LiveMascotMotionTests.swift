// The live mascot's motion, run through whole calls and touches at 60fps.
import XCTest
@testable import CompanionCore

final class LiveMascotMotionTests: XCTestCase {
    private let frame = 1.0 / 60

    /// Steps `motion` for `seconds`, returning every pose.
    private func run(_ motion: inout CallMascotMotion, from start: TimeInterval = 0, seconds: TimeInterval,
                     mode: CallMascotMotion.Mode, speaker: (TimeInterval) -> Float = { _ in 0 },
                     mic: (TimeInterval) -> Float = { _ in 0 }) -> [LiveMascotPose] {
        stride(from: start, to: start + seconds, by: frame).map { t in
            motion.step(at: t, mode: mode, speaker: speaker(t), mic: mic(t))
        }
    }

    func testTheMouthFollowsItsOwnVoiceAndClosesWhenItStops() {
        var motion = CallMascotMotion()
        // syllables: loud for 0.15s, quiet for 0.1s
        let speech: (TimeInterval) -> Float = { t in t.truncatingRemainder(dividingBy: 0.25) < 0.15 ? 0.12 : 0.01 }
        let talking = run(&motion, seconds: 2, mode: .speaking, speaker: speech)
        let widest = talking.map(\.mouth).max() ?? 0
        let narrowest = talking.suffix(60).map(\.mouth).min() ?? 1
        XCTAssertGreaterThan(widest, 0.6, "a loud syllable opens the mouth")
        XCTAssertLessThan(narrowest, widest * 0.6, "the mouth shapes syllables instead of hanging open")
        XCTAssertGreaterThan(talking.map(\.stretch).max() ?? 0, 0.3, "the body swells with the voice")

        let after = run(&motion, from: 2, seconds: 0.6, mode: .idle)
        XCTAssertLessThan(after.last?.mouth ?? 1, 0.01, "silence closes it")
    }

    func testTheMouthStaysShutWhileTheCallerTalks() {
        var motion = CallMascotMotion()
        let poses = run(&motion, seconds: 1, mode: .listening, speaker: { _ in 0.2 }, mic: { _ in 0.1 })
        XCTAssertEqual(poses.map(\.mouth).max(), 0)
    }

    func testItNodsAlongWhileYouTalkAndNeverWhileItSpeaks() {
        var motion = CallMascotMotion()
        let you: (TimeInterval) -> Float = { t in t.truncatingRemainder(dividingBy: 0.4) < 0.2 ? 0.1 : 0.005 }
        let listening = run(&motion, seconds: 4, mode: .listening, mic: you)
        // count dips past half way
        var nods = 0, down = false
        for pose in listening {
            if !down, pose.nod > 0.3 { nods += 1; down = true }
            if down, pose.nod < 0.1 { down = false }
        }
        XCTAssertGreaterThanOrEqual(nods, 4, "nods along to your syllables")
        XCTAssertLessThanOrEqual(nods, 8, "but never faster than one every \(CallMascotMotion.nodGap)s")
        XCTAssertGreaterThan(listening.last?.eyeScale ?? 0, 1.05, "wide-eyed while you talk")
        XCTAssertGreaterThan(listening.last?.gaze.y ?? 0, 0.1, "looking at you, not past you")

        var speaking = CallMascotMotion()
        let own = run(&speaking, seconds: 3, mode: .speaking, speaker: { _ in 0.1 }, mic: you)
        XCTAssertLessThan(own.map(\.nod).max() ?? 1, 0.01)
    }

    func testBetweenTurnsItDriftsUpAndAwayIntoThought() {
        var motion = CallMascotMotion()
        let poses = run(&motion, seconds: 2, mode: .thinking)
        let end = poses.last!
        XCTAssertLessThan(end.gaze.y, -0.5, "looks up")
        XCTAssertLessThan(end.gaze.x, -0.4, "and off to the side of its question mark")
        XCTAssertLessThan(end.lean, -2)
        XCTAssertEqual(end.mouth, 0)
    }

    func testAStutteringClockNeverBlowsUpTheSprings() {
        var motion = CallMascotMotion()
        _ = motion.step(at: 0, mode: .listening, speaker: 0, mic: 0.2)
        let pose = motion.step(at: 30, mode: .listening, speaker: 0, mic: 0.2)
        XCTAssertTrue(pose.nod.isFinite && pose.gaze.x.isFinite)
        XCTAssertLessThanOrEqual(pose.nod, 1)
        let back = motion.step(at: 29, mode: .listening, speaker: 0, mic: 0.2)
        XCTAssertTrue(back.nod.isFinite)
    }

    func testTheProfileFaceFollowsYourFingerAndLetsGo() {
        var motion = FingerMascotMotion()
        motion.finger = CGPoint(x: 2, y: -0.5)
        var pose = LiveMascotPose.rest
        for t in stride(from: 0.0, to: 0.5, by: frame) { pose = motion.step(at: t) }
        XCTAssertGreaterThan(pose.gaze.x, 0.85, "looks all the way toward a finger off to the right")
        XCTAssertLessThan(pose.gaze.y, 0, "and up with it")
        XCTAssertLessThanOrEqual(hypot(pose.gaze.x, pose.gaze.y), 1.0001, "eyes stay inside their travel")
        XCTAssertGreaterThan(pose.lean, 5, "leans in")
        XCTAssertGreaterThan(pose.eyeScale, 1.05)

        motion.finger = nil
        for t in stride(from: 0.5, to: 2.5, by: frame) { pose = motion.step(at: t) }
        XCTAssertLessThan(abs(pose.lean), 0.5, "straightens up when you let go")
    }

    func testATapWobblesThenSettles() {
        var motion = FingerMascotMotion()
        motion.poke(at: 0)
        let poses = stride(from: 0.0, to: 1.5, by: frame).map { motion.step(at: $0) }
        XCTAssertGreaterThan(poses.prefix(20).map { abs($0.stretch) }.max() ?? 0, 0.3)
        XCTAssertEqual(poses.last?.stretch, 0)
    }

    func testReduceMotionKeepsTheEyesAndMouthButStillsTheBody() {
        let pose = LiveMascotPose(gaze: CGPoint(x: 0.5, y: 0), mouth: 0.6, stretch: 0.4, nod: 0.8, lean: 6, lift: 0.1, eyeScale: 1.1)
        XCTAssertEqual(pose.calmed, LiveMascotPose(gaze: CGPoint(x: 0.5, y: 0), mouth: 0.6, eyeScale: 1.1))
    }

    func testColourBlendsThroughTheMiddle() {
        XCTAssertEqual(LiveMascotColor.blend("#000000", "#FFFFFF", 0), "#000000")
        XCTAssertEqual(LiveMascotColor.blend("#000000", "#FFFFFF", 1), "#FFFFFF")
        XCTAssertEqual(LiveMascotColor.blend("#000000", "#FF8800", 0.5), "#804400")
        XCTAssertEqual(LiveMascotColor.blend("#000000", "#FFFFFF", 7), "#FFFFFF", "clamped")
        // palette names resolve first
        XCTAssertEqual(LiveMascotColor.blend("green", "green", 0.3), GlyphFaces.resolveColor("green").uppercased())
    }
}
