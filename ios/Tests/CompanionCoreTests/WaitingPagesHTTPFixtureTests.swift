import Foundation
import XCTest
@testable import CompanionCore

final class WaitingPagesHTTPFixtureTests: XCTestCase {
    func testApprovalRecoveryThroughDelayedLoopbackPages() async throws {
        guard let raw = ProcessInfo.processInfo.environment["WAITING_PAGES_FIXTURE_PORT"], let port = Int(raw) else {
            throw XCTSkip("Run scripts/testing/waiting-pages-fixture.mjs for the isolated HTTP fixture.")
        }
        let client = CompanionClient(connection: Connection(name: "Isolated fixture", host: "127.0.0.1", port: port), token: "fixture-token")
        let snapshot = try await client.fleetForHydration()
        XCTAssertEqual(snapshot.waitingThreads.count, 9)
        var state = CompanionState()
        state.hydrate(snapshot.fleet, waitingThreads: snapshot.waitingThreads)
        XCTAssertEqual(state.pendingApprovals.count, 9)
        XCTAssertEqual(Set(state.pendingApprovals.map(\.threadId)), Set((0..<9).map { "wait-\($0)" }))
        XCTAssertNil(state.cursor, "Fetching pages must not advance the replay cursor.")
    }
}
