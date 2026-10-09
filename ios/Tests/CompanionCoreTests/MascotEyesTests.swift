import XCTest
@testable import CompanionCore

final class MascotEyesTests: XCTestCase {
    func testDefaultAndUnknownStylesAreGlyph() {
        XCTAssertEqual(MascotEyeStyle(stored: nil), .glyph)
        XCTAssertEqual(MascotEyeStyle(stored: "future"), .glyph)
        XCTAssertEqual(MascotEyeStyle(stored: "classic"), .classic)
        XCTAssertEqual(MascotEyeStyle.allCases.map(\.rawValue), ["glyph", "classic", "round", "arches", "angled"])
        for style in MascotEyeStyle.allCases {
            XCTAssertEqual(style.paths().count, 2)
            XCTAssertTrue(style.paths().allSatisfy { !$0.isEmpty && $0.boundingBoxOfPath.width > 0 })
            guard style != .glyph else { continue }
            XCTAssertLessThan(style.paths(openness: 0.14)[0].boundingBoxOfPath.height, style.paths()[0].boundingBoxOfPath.height)
        }
    }
    func testPatchRoundTripsEyesAndUnrelatedPatchOmitsThem() throws {
        let eyes = try JSONSerialization.jsonObject(with: JSONEncoder().encode(BotProfilePatch(mascotEyes: "round"))) as? [String: String]
        XCTAssertEqual(eyes?["mascotEyes"], "round")
        let unrelated = try JSONSerialization.jsonObject(with: JSONEncoder().encode(BotProfilePatch(name: "bos"))) as? [String: String]
        XCTAssertNil(unrelated?["mascotEyes"])
        let legacy = try JSONDecoder().decode(SharedContact.self, from: Data(#"{"id":"b","name":"bos","kind":"bot"}"#.utf8))
        XCTAssertNil(legacy.mascotEyes)
        let modern = try JSONDecoder().decode(SharedContact.self, from: Data(#"{"id":"b","name":"bos","kind":"bot","mascotEyes":"angled"}"#.utf8))
        XCTAssertEqual(MascotEyeStyle(stored: modern.mascotEyes), .angled)
    }
}
