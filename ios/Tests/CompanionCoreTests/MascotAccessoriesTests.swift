// Mascot accessories: the lenient wire read, the profile patch, and the
// anchor math, checked against numbers printed by the desktop's
// `accessoryAnchors` (shared/mascot-accessory-art.ts).
import CoreGraphics
import XCTest
@testable import CompanionCore

final class MascotAccessoriesTests: XCTestCase {
    private func bot(_ accessories: String?) throws -> Bot {
        let field = accessories.map { #","mascotAccessories":\#($0)"# } ?? ""
        return try JSONDecoder().decode(Bot.self, from: Data("""
        {"id":"b1","threadId":"t1","name":"Scout","title":"","description":"","notifications":true,
         "color":"blue","unread":false,"modelSelection":{"instanceId":"e","model":"m"},"createdAt":1\(field)}
        """.utf8))
    }

    func testDecodesWornPiecesSlotBySlot() throws {
        let worn = try XCTUnwrap(bot(#"{"head":"top-hat","eyes":"sunglasses","neck":"bow-tie"}"#).mascotAccessories)
        XCTAssertEqual(worn[.head], "top-hat")
        XCTAssertEqual(worn[.eyes], "sunglasses")
        XCTAssertNil(worn[.mouth])
        XCTAssertEqual(worn[.neck], "bow-tie")
    }

    func testMissingOrNullReadsAsBare() throws {
        XCTAssertNil(try bot(nil).mascotAccessories)
        XCTAssertNil(try bot("null").mascotAccessories)
    }

    func testMalformedValuesNeverBreakTheBot() throws {
        for raw in [#""top-hat""#, "[1,2]", "42", "true", #"{"head":7,"eyes":["x"],"neck":null}"#] {
            let decoded = try bot(raw)
            XCTAssertEqual(decoded.name, "Scout", raw)
            XCTAssertTrue(decoded.mascotAccessories?.isEmpty ?? true, raw)
        }
    }

    func testUnknownSlotsAndIdsDropOutAlone() throws {
        let worn = try XCTUnwrap(bot(#"{"head":"jetpack","eyes":"round-glasses","tail":"bow","neck":"crown","mouth":"mustache"}"#).mascotAccessories)
        XCTAssertEqual(worn.raw, ["eyes": "round-glasses", "mouth": "mustache"])
    }

    func testCatalogMatchesDesktop() {
        XCTAssertEqual(MascotAccessoryCatalog.all.map(\.id), ["top-hat", "cap", "beanie", "crown", "party-hat", "bow", "headphones",
                                                             "round-glasses", "sunglasses", "mustache", "bow-tie", "scarf"])
        XCTAssertEqual(MascotAccessoryCatalog.pieces(for: .head).count, 7)
        XCTAssertEqual(MascotAccessoryCatalog.pieces(for: .neck).map(\.name), ["Bow tie", "Scarf"])
    }

    func testProfilePatchSendsPresentSlotsOrNull() throws {
        func wire(_ patch: BotProfilePatch) throws -> [String: Any] {
            try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(patch)) as? [String: Any])
        }
        let worn = try wire(BotProfilePatch(mascotAccessories: MascotAccessories([.head: "crown", .mouth: "mustache"])))
        XCTAssertEqual(worn["mascotAccessories"] as? [String: String], ["head": "crown", "mouth": "mustache"])
        let cleared = try wire(BotProfilePatch(mascotAccessories: MascotAccessories()))
        XCTAssertTrue(cleared["mascotAccessories"] is NSNull)
        XCTAssertNil(try wire(BotProfilePatch(name: "bos"))["mascotAccessories"])
    }

    func testSettingAPieceInTheWrongSlotClearsIt() {
        var worn = MascotAccessories([.head: "cap"])
        worn[.head] = "scarf"
        XCTAssertNil(worn[.head])
        XCTAssertNil(worn.nonEmpty)
    }

    // MARK: anchors

    private func assertAnchors(_ a: MascotAccessoryAnchors, centre: (CGFloat, CGFloat), head: (CGFloat, CGFloat, CGFloat),
                               sides: (CGFloat, CGFloat), neck: (CGFloat, CGFloat, CGFloat, CGFloat, CGFloat),
                               _ name: String, file: StaticString = #filePath, line: UInt = #line) {
        let e: CGFloat = 1e-6
        XCTAssertEqual(a.centre.x, centre.0, accuracy: e, name, file: file, line: line)
        XCTAssertEqual(a.centre.y, centre.1, accuracy: e, name, file: file, line: line)
        XCTAssertEqual(a.head.x, head.0, accuracy: e, name, file: file, line: line)
        XCTAssertEqual(a.head.y, head.1, accuracy: e, name, file: file, line: line)
        XCTAssertEqual(a.head.width, head.2, accuracy: e, name, file: file, line: line)
        XCTAssertEqual(a.sides.left, sides.0, accuracy: e, name, file: file, line: line)
        XCTAssertEqual(a.sides.right, sides.1, accuracy: e, name, file: file, line: line)
        XCTAssertEqual(a.neck.x, neck.0, accuracy: e, name, file: file, line: line)
        XCTAssertEqual(a.neck.y, neck.1, accuracy: e, name, file: file, line: line)
        XCTAssertEqual(a.neck.width, neck.2, accuracy: e, name, file: file, line: line)
        XCTAssertEqual(a.neck.left, neck.3, accuracy: e, name, file: file, line: line)
        XCTAssertEqual(a.neck.right, neck.4, accuracy: e, name, file: file, line: line)
    }

    func testAnchorsMatchDesktopForSeveralBodies() {
        assertAnchors(MascotAccessoryArt.anchors(bodyId: "circle"), centre: (50, 50), head: (50, 10.81640625, 60.008391203703695),
                      sides: (10, 90), neck: (50, 90, 63.27546296296295, 18.36226851851852, 81.63773148148147), "circle")
        assertAnchors(MascotAccessoryArt.anchors(bodyId: "cat"), centre: (40, 50), head: (40, 22.75, 70),
                      sides: (11.06640625, 90.103515625), neck: (40, 91.5703125, 66.29926215277777, 17.5, 83.79926215277777), "cat")
        assertAnchors(MascotAccessoryArt.anchors(bodyId: "bear"), centre: (40, 50), head: (40, 21.123914930555557, 67.15733506944444),
                      sides: (12.426866319444445, 89.07834201388889), neck: (40, 91.58275462962962, 67.06966145833333, 16.17860243055556, 83.24826388888889), "bear")
        assertAnchors(MascotAccessoryArt.anchors(bodyId: "bunny"), centre: (40, 58), head: (40, 31.34317129629629, 64.08441840277777),
                      sides: (10.3046875, 88.85937499999997), neck: (40, 92.75, 68.671875, 16, 84.671875), "bunny")
    }

    func testAnchorsFollowAnExplicitFaceCentre() {
        assertAnchors(MascotAccessoryArt.anchors(bodyId: "circle", centre: CGPoint(x: 52, y: 55)), centre: (52, 55),
                      head: (52, 11.435185185185185, 60.008391203703695), sides: (10.366898148148149, 89.63310185185185),
                      neck: (52, 90, 63.27546296296295, 18.36226851851852, 81.63773148148147), "circle@52,55")
    }

    // MARK: art

    func testTopHatAndBowTieMatchDesktopMarkup() throws {
        // desktop: <g transform="translate(50 15.82) rotate(-10) scale(1.17)"> with a red band,
        // and the bow tie at translate(50 88) with a #AE3C42 knot, for a blue circle
        let face = MascotFace(centre: CGPoint(x: 50, y: 50))
        let shapes = MascotAccessoryArt.shapes(MascotAccessories([.head: "top-hat", .neck: "bow-tie"]), bodyId: "circle", color: "blue", face: face)
        XCTAssertEqual(shapes.map(\.slot), [.neck, .neck, .neck, .head, .head, .head])
        XCTAssertEqual(shapes[2].fill, "#AE3C42")
        XCTAssertEqual(shapes[5].fill, "#D94B52")
        let knot = shapes[2].path.boundingBoxOfPath
        XCTAssertEqual(knot.midX, 50, accuracy: 1e-6)
        XCTAssertEqual(knot.midY, 88, accuracy: 1e-6)
        let s = (60.008391203703695 * 0.78) / 40, angle = -10 * CGFloat.pi / 180
        let brim = shapes[3].path.boundingBoxOfPath
        XCTAssertEqual(brim.midX, 50 - sin(angle) * -1.5 * s, accuracy: 1e-6)
        XCTAssertEqual(brim.midY, 10.81640625 + 5 + cos(angle) * -1.5 * s, accuracy: 1e-6)
    }

    func testFacePiecesRideTheFace() {
        let glasses = MascotAccessories([.eyes: "round-glasses"])
        let here = MascotAccessoryArt.shapes(glasses, bodyId: "circle", color: "green", face: MascotFace(centre: CGPoint(x: 50, y: 50)))
        let there = MascotAccessoryArt.shapes(glasses, bodyId: "circle", color: "green", face: MascotFace(centre: CGPoint(x: 56, y: 47)))
        XCTAssertEqual(there[0].path.boundingBoxOfPath.midX - here[0].path.boundingBoxOfPath.midX, 6, accuracy: 1e-6)
        XCTAssertEqual(there[0].path.boundingBoxOfPath.midY - here[0].path.boundingBoxOfPath.midY, -3, accuracy: 1e-6)
        let big = MascotAccessoryArt.shapes(glasses, bodyId: "circle", color: "green", face: MascotFace(centre: CGPoint(x: 50, y: 50), diameter: 160))
        XCTAssertEqual(big[0].lineWidth, 6, accuracy: 1e-6)
    }

    func testBareBotDrawsNothingAndEveryPieceDrawsOnEveryBody() {
        XCTAssertTrue(MascotAccessoryArt.shapes(nil, bodyId: "cat", color: "red").isEmpty)
        XCTAssertTrue(MascotAccessoryArt.shapes(MascotAccessories(), bodyId: "cat", color: "red").isEmpty)
        for body in FlatMascotBodies.all {
            for piece in MascotAccessoryCatalog.all {
                let shapes = MascotAccessoryArt.shapes(MascotAccessories([piece.slot: piece.id]), bodyId: body.id, color: "white")
                XCTAssertFalse(shapes.isEmpty, "\(body.id) \(piece.id)")
                for shape in shapes {
                    let box = shape.path.boundingBoxOfPath
                    XCTAssertTrue(box.minY > -40 && box.maxY < 140 && box.minX > -40 && box.maxX < 140, "\(body.id) \(piece.id) \(box)")
                }
            }
        }
    }

    func testAccessoriesStandOutAgainstTheBody() {
        XCTAssertEqual(MascotAccessoryArt.against("#D94B52", MascotAccessoryArt.red, MascotAccessoryArt.gold), MascotAccessoryArt.gold)
        XCTAssertEqual(MascotAccessoryArt.deepen("#D94B52"), "#AE3C42")
    }
}
