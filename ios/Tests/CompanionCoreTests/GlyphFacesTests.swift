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
            let parts = (face.leftParts + face.rightParts).map(\.glyph)
            for id in [face.left, face.right] + parts + (face.accent.map { [$0] } ?? []) {
                let box = GlyphFaces.path(id).boundingBoxOfPath
                XCTAssertFalse(GlyphFaces.path(id).isEmpty, id)
                // brows sit above the eye in the same box, so they may reach y -3
                let top: CGFloat = id.hasPrefix("brow") ? -3 : 0
                XCTAssertTrue(box.minX >= 0 && box.maxX <= 24 && box.minY >= top && box.maxY <= 24, "\(id) \(box)")
            }
            XCTAssertEqual(face.leftParts.first?.glyph, face.left, state.rawValue)
            XCTAssertEqual(face.rightParts.first?.glyph, face.right, state.rawValue)
            XCTAssertEqual(face.gaze.count, 2, state.rawValue)
            XCTAssertEqual(face.accent == nil, face.anchor == nil, state.rawValue)
            if let anchor = face.anchor { XCTAssertNotNil(GlyphFaces.placement(anchor)) }
            // every motion name is one the app knows how to play
            if let eyes = face.motion.eyes { XCTAssertTrue(Self.eyeMotions.contains(eyes), eyes) }
            if let accent = face.motion.accent { XCTAssertTrue(Self.accentMotions.contains(accent), accent) }
            if let body = face.motion.body { XCTAssertTrue(Self.bodyMotions.contains(body), body) }
        }
        XCTAssertEqual(GlyphFaces.face(.finished), GlyphFace(left: "gt", right: "lt", accent: "spark", anchor: .split,
                                                             motion: GlyphMotion(body: "hop")))
        // B eyes: resting is a heavy dot, ++ is the working face only, no ^ ^ or - - at rest
        XCTAssertEqual(GlyphFaces.face(.idle).leftParts, [GlyphEyePart(glyph: "dot", weight: 3.2)])
        for state in GlyphFaceState.allCases where state != .working {
            XCTAssertNotEqual(GlyphFaces.face(state).left, "plus", state.rawValue)
        }
        for state in GlyphFaceState.allCases {
            XCTAssertNotEqual(GlyphFaces.face(state).left, "caret", state.rawValue)
        }
        XCTAssertEqual(GlyphFaces.stroke, 3.2)
        XCTAssertEqual(GlyphFaces.tiltDegrees, -12)
    }

    static let eyeMotions: Set<String> = ["look", "lean", "drift", "scan", "read", "bob", "pulse", "pop", "shake",
                                          "breathe", "slow", "spin", "twinkle", "beat", "tilt", "giggle"]
    static let accentMotions: Set<String> = ["float", "fly", "burst", "pulse", "ring", "slide"]
    static let bodyMotions: Set<String> = ["hop", "squish", "stretch", "giggle", "tap"]

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
