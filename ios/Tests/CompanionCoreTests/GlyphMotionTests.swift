import CoreGraphics
import XCTest
@testable import CompanionCore

final class GlyphMotionTests: XCTestCase {
    private func near(_ a: CGFloat, _ b: CGFloat, _ tol: CGFloat = 0.01, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertEqual(a, b, accuracy: tol, file: file, line: line)
    }

    func testEveryMotionNameTheTableUsesHasCurves() throws {
        for state in GlyphFaceState.allCases {
            let m = GlyphFaces.face(state).motion
            if let e = m.eyes { XCTAssertTrue(GlyphMotionCurves.eyes[e] != nil || GlyphMotionCurves.eachEye[e] != nil, "\(state) eyes \(e)") }
            if let a = m.accent { XCTAssertNotNil(GlyphMotionCurves.accent[a], "\(state) accent \(a)") }
            if let b = m.body { XCTAssertNotNil(GlyphMotionCurves.body[b], "\(state) body \(b)") }
        }
    }

    func testLookHoldsAtTheSheetsKeyframes() {
        let look = GlyphMotionCurves.eyes["look"]!
        near(look.frame(at: 0).dx, 0)
        near(look.frame(at: 3.2 * 0.4).dx, -5)   // 30–45% held left
        near(look.frame(at: 3.2 * 0.65).dx, 5)   // 55–75% held right, a touch up
        near(look.frame(at: 3.2 * 0.65).dy, -1)
        near(look.frame(at: 3.2 * 0.25).dx, -2.5, 0.6) // halfway along an eased segment
        near(look.frame(at: 3.2 + 3.2 * 0.4).dx, -5)   // loops
    }

    func testReadStepsWithoutEasing() {
        let read = GlyphMotionCurves.eyes["read"]!
        let f = read.frame(at: 2.4 * 0.2)
        near(f.dx, 0); near(f.dy, -2)
        let g = read.frame(at: 2.4 * 0.9)
        near(g.dx, 5); near(g.dy, 2)
    }

    func testOpacityAndTransformAreSeparateTracks() {
        let fly = GlyphMotionCurves.accent["fly"]!
        let f = fly.frame(at: 2 * 0.2)
        near(f.opacity, 1)
        XCTAssertGreaterThan(f.dx, -14)       // transform keeps easing across the 20% opacity key
        XCTAssertLessThan(f.dx, 0)
        let burst = GlyphMotionCurves.accent["burst"]!
        near(burst.frame(at: 2.4 * 0.3).opacity, 0)
        near(burst.frame(at: 2.4 * 0.7).sx, 1.1)
    }

    func testHopLiftsNineSheetPxAt72() {
        let hop = GlyphMotionCurves.body["hop"]!
        let f = hop.frame(at: 2.4 * 0.72)
        near(f.dy, -9); near(f.sx, 0.94); near(f.sy, 1.06)
        XCTAssertTrue(hop.frame(at: 2.4 * 0.3).isIdentity)
    }

    func testBezierOvershoots() {
        // cubic-bezier(.3,1.6,.5,1) overshoots past 1 midway
        XCTAssertGreaterThan(GlyphTiming.bezier(0.3, 1.6, 0.5, 1)(0.5), 1)
        near(GlyphTiming.easeInOut(0.5), 0.5)
        near(GlyphTiming.linear(0.3), 0.3)
    }

    func testBlinksAreRandomSometimesDoubleAndNeverInSync() {
        let seedA = GlyphBlink.seed("cash"), seedB = GlyphBlink.seed("oracle")
        var starts: [Double] = []
        var closedA = 0, together = 0
        var wasShut = false
        var t = 0.0
        while t < 3600 {
            let a = GlyphBlink.openness(at: t, seed: seedA)
            let b = GlyphBlink.openness(at: t, seed: seedB)
            let shut = a < 0.5
            if shut && !wasShut { starts.append(t) }
            wasShut = shut
            if shut { closedA += 1; if b < 0.5 { together += 1 } }
            XCTAssertGreaterThanOrEqual(a, 0.07); XCTAssertLessThanOrEqual(a, 1)
            t += 0.02
        }
        let gaps = zip(starts.dropFirst(), starts).map { $0 - $1 }
        let mean = gaps.reduce(0, +) / Double(gaps.count)
        XCTAssertGreaterThan(mean, 6); XCTAssertLessThan(mean, 14)
        XCTAssertTrue(gaps.contains { abs($0 - 0.38) < 0.05 }, "some blinks come as a pair")
        XCTAssertGreaterThan(Set(gaps.map { Int($0) }).count, 5, "gaps vary")
        XCTAssertLessThan(Double(together) / Double(max(closedA, 1)), 0.2)
    }

    func testBlinkShutsToEightPercent() {
        let seed = GlyphBlink.seed("cash")
        var lowest: CGFloat = 1
        var t = 0.0
        while t < 60 { lowest = min(lowest, GlyphBlink.openness(at: t, seed: seed)); t += 0.005 }
        near(lowest, 0.08, 0.02)
    }

    func testIdleGazeIsSmallAndMostlyCentred() {
        let seed = GlyphBlink.seed("cash")
        var off = 0, n = 0
        var t = 0.0
        while t < 600 {
            let g = GlyphIdleGaze.offset(at: t, seed: seed)
            XCTAssertLessThanOrEqual(abs(g.width), 0.08); XCTAssertLessThanOrEqual(abs(g.height), 0.07)
            if g != .zero { off += 1 }
            n += 1; t += 0.1
        }
        XCTAssertGreaterThan(off, 0)
        XCTAssertLessThan(Double(off) / Double(n), 0.2)
    }

    func testSlowBlinkFacesSkipRandomBlinks() {
        for state in GlyphFaceState.allCases where GlyphFaces.face(state).motion.eyes == "slow" {
            XCTAssertTrue(GlyphMotionCurves.skipsBlink(GlyphFaces.face(state)))
        }
        XCTAssertFalse(GlyphMotionCurves.skipsBlink(GlyphFaces.face(.idle)))
    }
}
