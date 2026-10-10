// The ringing mascot: it hops on each ring, watches the answer thumb, and
// comes to rest flat once answered so the call screen can take it over.
import XCTest
@testable import CompanionCore

final class RingMascotMotionTests: XCTestCase {
    private let frame = 1.0 / 120

    private func run(_ motion: inout RingMascotMotion, from start: TimeInterval = 0,
                     seconds: TimeInterval) -> [LiveMascotPose] {
        stride(from: start, to: start + seconds, by: frame).map { motion.step(at: $0) }
    }

    func testHopsOncePerRing() {
        var motion = RingMascotMotion()
        let poses = run(&motion, seconds: RingMascotMotion.period * 3)
        let perRing = Int(RingMascotMotion.period / frame)
        for ring in 0..<3 {
            let slice = poses[(ring * perRing)..<min((ring + 1) * perRing, poses.count)]
            XCTAssertGreaterThan(slice.map(\.lift).max() ?? 0, 0.12, "ring \(ring) leaves the ground")
        }
        // quiet between hops: the last second of a ring is calm
        let tail = poses[(perRing - 100)..<perRing]
        XCTAssertLessThan(tail.map { abs($0.stretch) }.max() ?? 1, 0.1)
    }

    func testWatchesTheThumbAndCalmsAsItIsPulled() {
        var motion = RingMascotMotion()
        motion.thumb = CGPoint(x: 1.2, y: 2)
        motion.pull = 0.8
        let poses = run(&motion, seconds: RingMascotMotion.period)
        let last = poses.last!
        XCTAssertGreaterThan(last.gaze.y, 0.6, "looks down at the thumb")
        XCTAssertGreaterThan(last.gaze.x, 0.3)
        XCTAssertGreaterThan(last.eyeScale, 1.2, "wide-eyed")
        // pulled most of the way, the hops are gone
        XCTAssertLessThan(poses.map(\.lift).max() ?? 1, 0.1)
    }

    func testSettlesFlatWhenAnswered() {
        var motion = RingMascotMotion()
        _ = run(&motion, seconds: 0.3)
        motion.settled = true
        let last = run(&motion, from: 0.3, seconds: 0.8).last!
        XCTAssertEqual(last.lift, 0, accuracy: 0.01)
        XCTAssertEqual(last.stretch, 0, accuracy: 0.02)
        XCTAssertEqual(last.gaze.x, 0, accuracy: 0.02)
        XCTAssertEqual(last.eyeScale, 1, accuracy: 0.02)
    }
}
