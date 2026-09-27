import CoreGraphics
import XCTest
@testable import CompanionCore

final class FlatMascotBodiesTests: XCTestCase {
    func testEveryChoiceParsesAndHasTheSameFixedFaceStyle() {
        XCTAssertEqual(FlatMascotBodies.all.count, 40)
        XCTAssertEqual(Set(FlatMascotBodies.all.map(\.id)).count, 40)
        for body in FlatMascotBodies.all {
            let path = FlatMascotBodies.outline(body.id)
            XCTAssertFalse(path.isEmpty, body.id)
            XCTAssertGreaterThan(path.boundingBoxOfPath.width, 30, body.id)
            XCTAssertGreaterThan(path.boundingBoxOfPath.height, 30, body.id)
            guard body.group != "Originals" else { continue }
            for point in [CGPoint(x: 51, y: 43), CGPoint(x: 54, y: 52), CGPoint(x: 73, y: 39), CGPoint(x: 76, y: 48)] {
                for step in 0..<24 {
                    let angle = CGFloat(step) * .pi / 12
                    XCTAssertTrue(path.contains(CGPoint(x: point.x + body.faceX + cos(angle) * 5.5,
                                                       y: point.y + body.faceY + sin(angle) * 5.5)), body.id)
                }
            }
        }
    }
    func testLegacyAliasesAndUnknownValuesRenderSafely() {
        XCTAssertEqual(FlatMascotBodies.body("shield").id, "hexagon")
        XCTAssertEqual(FlatMascotBodies.body("diamond").id, "squircle")
        XCTAssertEqual(FlatMascotBodies.body(nil).id, "circle")
        XCTAssertEqual(FlatMascotBodies.body("future-body").id, "circle")
        XCTAssertFalse(FlatMascotBodies.outline("future-body").isEmpty)
    }
    func testEachPickerSectionContainsEightChoices() {
        XCTAssertEqual(FlatMascotBodies.groups.count, 5)
        for group in FlatMascotBodies.groups { XCTAssertEqual(FlatMascotBodies.all.filter { $0.group == group }.count, 8) }
    }
}
