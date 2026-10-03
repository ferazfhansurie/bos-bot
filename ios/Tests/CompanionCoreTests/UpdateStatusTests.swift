import XCTest
@testable import CompanionCore

final class UpdateStatusTests: XCTestCase {
    private func decode(_ json: String) throws -> UpdateStatusResponse {
        try JSONDecoder().decode(UpdateStatusResponse.self, from: Data(json.utf8))
    }

    func testReadyNamesTheCandidate() throws {
        let status = try decode(#"{"state":"ready","current":{"version":"1.2.0","sha":"2d83ba23"},"candidate":{"version":"1.3.0","sha":"abc","stagedAt":1700000000000},"busyTurns":[{"botId":"b","threadId":"t"}]}"#)
        XCTAssertEqual(status.summary, "1.3.0 ready · update from the mac")
        XCTAssertFalse(status.isRunning)
    }

    func testRunningStepAndIsoTimestampsDecode() throws {
        let status = try decode(#"{"state":"applying","current":{"version":"1.2.0","sha":"x"},"busyTurns":[],"lastResult":{"state":"done","at":"2026-10-03T23:00:00Z"}}"#)
        XCTAssertEqual(status.summary, "Updating · installing")
        XCTAssertTrue(status.isRunning)
    }

    func testRolledBackSaysWhy() throws {
        let status = try decode(#"{"state":"idle","current":{"version":"1.2.0","sha":"x"},"busyTurns":[],"lastResult":{"state":"rolled_back","at":1,"detail":"health check failed","rollback":true}}"#)
        XCTAssertEqual(status.summary, "Rolled back: health check failed")
    }
}
