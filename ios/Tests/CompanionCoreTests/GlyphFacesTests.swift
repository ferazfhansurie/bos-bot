import CoreGraphics
import XCTest
@testable import CompanionCore

final class GlyphFacesTests: XCTestCase {
    func testBundledTableMatchesSharedJsonByteForByte() throws {
        let shared = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent("shared/glyph-faces.json")
        let core = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources/CompanionCore/Resources/glyph-faces.json")
        XCTAssertEqual(try Data(contentsOf: shared), try Data(contentsOf: core))
    }

    func testTableCoversEveryStateAndGlyph() {
        XCTAssertEqual(GlyphFaces.document.states, GlyphFaceState.allCases.map(\.rawValue))
        for state in GlyphFaceState.allCases {
            let face = GlyphFaces.face(state)
            for id in [face.left, face.right] + (face.accent.map { [$0] } ?? []) {
                let box = GlyphFaces.path(id).boundingBoxOfPath
                XCTAssertFalse(GlyphFaces.path(id).isEmpty, id)
                XCTAssertTrue(box.minX >= 0 && box.maxX <= 24 && box.minY >= 0 && box.maxY <= 24, "\(id) \(box)")
            }
            XCTAssertEqual(face.accent == nil, face.anchor == nil, state.rawValue)
            if let anchor = face.anchor { XCTAssertNotNil(GlyphFaces.placement(anchor)) }
        }
        XCTAssertEqual(GlyphFaces.face(.finished), GlyphFace(left: "gt", right: "lt", accent: "spark", anchor: .split))
        XCTAssertEqual(GlyphFaces.stroke, 3.2)
        XCTAssertEqual(GlyphFaces.tiltDegrees, -12)
    }

    func testPathParserReadsLinesCurvesAndCloses() {
        let dash = GlyphFaces.path("dash").boundingBoxOfPath
        XCTAssertEqual(dash.minX, 4.5, accuracy: 0.001)
        XCTAssertEqual(dash.maxX, 19.5, accuracy: 0.001)
        XCTAssertEqual(dash.height, 0, accuracy: 0.001)
        // three separate strokes: the two chevrons and the slash
        var moves = 0
        GlyphFaces.path("code").applyWithBlock { if $0.pointee.type == .moveToPoint { moves += 1 } }
        XCTAssertEqual(moves, 3)
        let ring = GlyphFaces.path("ring").boundingBoxOfPath
        XCTAssertEqual(ring.midX, 12, accuracy: 0.01)
        XCTAssertEqual(ring.height, 13, accuracy: 0.01)
    }

    private struct Parity: Decodable {
        struct State: Decodable { let expression: String?; let activity: String?; let state: String }
        struct Colour: Decodable { let color: String?; let resolved: String; let ink: String }
        let states: [State]
        let colors: [Colour]
    }

    /// Fixture written by running shared/glyph-faces.ts itself, so this is
    /// the desktop's answer for every name the apps use.
    func testStateColourAndInkMatchTheDesktop() throws {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "glyph-parity", withExtension: "json", subdirectory: "Fixtures"))
        let parity = try JSONDecoder().decode(Parity.self, from: Data(contentsOf: url))
        XCTAssertGreaterThan(parity.states.count, 400)
        for row in parity.states {
            XCTAssertEqual(GlyphFaces.state(for: row.expression, activity: row.activity).rawValue, row.state,
                           "\(row.expression ?? "nil") / \(row.activity ?? "nil")")
        }
        for row in parity.colors {
            XCTAssertEqual(GlyphFaces.resolveColor(row.color), row.resolved, row.color ?? "nil")
            XCTAssertEqual(GlyphFaces.ink(row.color ?? ""), row.ink, row.color ?? "nil")
        }
    }

    func testPaletteNamesMatchTheTable() {
        XCTAssertEqual(Set(GlyphFaces.paletteNames), Set(GlyphFaces.document.palette.keys))
        XCTAssertTrue(GlyphFaces.isHex("#1e1E2e"))
        XCTAssertFalse(GlyphFaces.isHex("1E1E2E"))
        XCTAssertFalse(GlyphFaces.isHex("#1E1E2"))
    }
}
