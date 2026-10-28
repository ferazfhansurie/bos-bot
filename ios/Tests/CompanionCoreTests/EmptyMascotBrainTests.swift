import XCTest
@testable import CompanionCore

final class EmptyMascotBrainTests: XCTestCase {
    func testEveryMoodDrawsRealGlyphs() {
        for mood in MascotMood.allCases {
            let face = EmptyMascotBrain.face(mood)
            for id in (face.leftParts + face.rightParts).map(\.glyph) + [face.accent].compactMap({ $0 }) {
                XCTAssertFalse(EmptyMascotBrain.path(id).isEmpty, "\(mood) uses missing glyph \(id)")
                let box = EmptyMascotBrain.path(id).boundingBoxOfPath
                // brows sit above the eye, so they may rise out of the top of the box
                let top: CGFloat = id.hasPrefix("brow") ? -4 : -0.5
                XCTAssertTrue(CGRect(x: -0.5, y: top, width: 25, height: 24.5 - top).contains(box), "\(id) leaves the 24 box")
            }
            XCTAssertEqual(face.accent == nil, face.anchor == nil, "\(mood) accent without anchor")
        }
    }

    func testSharedStatesKeepTheirDesktopFace() {
        let thinking = GlyphFaces.face(.thinking)
        XCTAssertEqual(EmptyMascotBrain.face(.thinking).left, thinking.left)
        XCTAssertEqual(EmptyMascotBrain.face(.thinking).accent, thinking.accent)
    }

    func testDraftReactions() {
        XCTAssertEqual(EmptyMascotBrain.reaction(to: "", focused: false), DraftReaction.none)
        XCTAssertEqual(EmptyMascotBrain.reaction(to: "", focused: true), .listening)
        XCTAssertEqual(EmptyMascotBrain.reaction(to: "the login is Broken again", focused: true), .scared)
        XCTAssertEqual(EmptyMascotBrain.reaction(to: "got an error on deploy", focused: true), .scared)
        XCTAssertEqual(EmptyMascotBrain.reaction(to: "checkout not working", focused: true), .scared)
        XCTAssertEqual(EmptyMascotBrain.reaction(to: "need this ASAP", focused: true), .alert)
        XCTAssertEqual(EmptyMascotBrain.reaction(to: "urgent: call partner", focused: true), .alert)
        XCTAssertEqual(EmptyMascotBrain.reaction(to: "thanks man", focused: true), .happy)
        XCTAssertEqual(EmptyMascotBrain.reaction(to: "ty", focused: true), .happy)
        // a word inside another word does not count
        XCTAssertEqual(EmptyMascotBrain.reaction(to: "debugging the typeface", focused: true), .listening)
        // scared beats thanks
        XCTAssertEqual(EmptyMascotBrain.reaction(to: "thanks but it crashed", focused: true), .scared)
        XCTAssertEqual(EmptyMascotBrain.reaction(to: String(repeating: "and another thing ", count: 12), focused: true), .nodding)
    }

    func testHeavyDelete() {
        XCTAssertTrue(EmptyMascotBrain.isHeavyDelete(from: "i think we should fire everyone", to: ""))
        XCTAssertTrue(EmptyMascotBrain.isHeavyDelete(from: "i think we should fire everyone", to: "i think"))
        XCTAssertFalse(EmptyMascotBrain.isHeavyDelete(from: "i think we should fire everyone", to: "i think we should fire every"))
        XCTAssertFalse(EmptyMascotBrain.isHeavyDelete(from: "short", to: ""))
    }

    func testRest() {
        XCTAssertEqual(EmptyMascotBrain.rest(idleFor: 0), .awake)
        XCTAssertEqual(EmptyMascotBrain.rest(idleFor: 29.9), .awake)
        XCTAssertEqual(EmptyMascotBrain.rest(idleFor: 30), .drowsy)
        XCTAssertEqual(EmptyMascotBrain.rest(idleFor: 90), .asleep)
        XCTAssertEqual(EmptyMascotBrain.nextGlance(after: 10, unit: 0), 15)
        XCTAssertEqual(EmptyMascotBrain.nextGlance(after: 10, unit: 1), 18)
    }

    func testDayMood() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Asia/Kuala_Lumpur")!
        func at(_ day: Int, _ hour: Int) -> Date {
            calendar.date(from: DateComponents(year: 2026, month: 10, day: day, hour: hour))!
        }
        // 2026-10-09 is a friday
        XCTAssertEqual(EmptyMascotBrain.dayMood(at: at(9, 14), calendar: calendar), MascotDayMood(friday: true))
        XCTAssertEqual(EmptyMascotBrain.dayMood(at: at(10, 7), calendar: calendar), MascotDayMood(morning: true))
        XCTAssertEqual(EmptyMascotBrain.dayMood(at: at(10, 1), calendar: calendar), MascotDayMood(late: true))
        XCTAssertEqual(EmptyMascotBrain.dayMood(at: at(10, 15), calendar: calendar), MascotDayMood())
    }

    func testLinesAreLowercasePlainAndStable() {
        let moments: [EmptyMascotBrain.Moment] = [
            .arrive(MascotDayMood()), .arrive(MascotDayMood(morning: true)), .arrive(MascotDayMood(late: true)),
            .arrive(MascotDayMood(friday: true)), .listening, .scared, .alert, .thanks, .nodding, .suspicious,
            .drowsy, .asleep, .woke, .tapped, .dizzy, .purr, .pose, .shaken, .voice, .unread(1), .unread(4), .cameo("Oracle"),
        ]
        for moment in moments {
            for seed in [0, 1, 2, 7, -3, Int.max] {
                let line = EmptyMascotBrain.line(moment, seed: seed)
                XCTAssertFalse(line.isEmpty)
                XCTAssertEqual(line, line.lowercased(), "\(moment) is not lowercase")
                XCTAssertFalse(line.contains("!"), "\(moment) shouts")
                XCTAssertTrue(line.unicodeScalars.allSatisfy { $0.isASCII }, "\(moment) has an emoji or symbol")
            }
        }
        XCTAssertEqual(EmptyMascotBrain.line(.unread(1), seed: 0), "one waiting for you back there")
        XCTAssertEqual(EmptyMascotBrain.line(.unread(3), seed: 9), "3 waiting for you back there")
        XCTAssertEqual(EmptyMascotBrain.seed("thread-a"), EmptyMascotBrain.seed("thread-a"))
        XCTAssertGreaterThanOrEqual(EmptyMascotBrain.seed("thread-a"), 0)
    }

    func testEyesAreTheHeadersGlyphEyes() {
        // at rest it wears the brand's idle face, the same eyes as the header
        XCTAssertEqual(EmptyMascotBrain.face(.idle).leftParts, GlyphFaces.face(.idle).leftParts)
        XCTAssertEqual(EmptyMascotBrain.face(.idle).left, "dot")
        // B eyes: no - - and no ^ ^ anywhere on the empty thread
        for mood in MascotMood.allCases {
            let glyphs = (EmptyMascotBrain.face(mood).leftParts + EmptyMascotBrain.face(mood).rightParts).map(\.glyph)
            XCTAssertFalse(glyphs.contains("caret"), "\(mood)")
            if mood != .suspicious { XCTAssertFalse(glyphs.contains("dash"), "\(mood)") }
        }
        for mood in MascotMood.allCases {
            let face = EmptyMascotBrain.face(mood)
            XCTAssertFalse(EmptyMascotBrain.path(face.left).isEmpty, "\(mood)")
            XCTAssertFalse(EmptyMascotBrain.path(face.right).isEmpty, "\(mood)")
        }
    }
}
