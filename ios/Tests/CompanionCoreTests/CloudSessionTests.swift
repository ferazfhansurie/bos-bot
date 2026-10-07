import Foundation
import XCTest
@testable import CompanionCore

final class CloudSessionTests: XCTestCase {
    private typealias F = CloudFixture
    private let alice = CloudFixture.account("alice")
    private let bob = CloudFixture.account("bob")

    /// Runs foreground -> auth -> discovery and returns the discovery effects.
    @discardableResult
    private func recover(_ session: inout CloudSession, with discovery: CloudDiscovery) -> [CloudSessionEffect] {
        let generation = session.generation
        XCTAssertEqual(session.reduce(.foreground), [.refreshAuth(generation: generation)])
        XCTAssertEqual(session.reduce(.authRefreshed(generation: generation)), [.syncDiscovery(generation: generation)])
        return session.reduce(.discoverySynced(generation: generation, discovery))
    }

    func testForegroundRefreshesAuthThenSyncsThenSubscribes() {
        var session = CloudSession(account: alice)
        let effects = recover(&session, with: F.discovery(["r1", "r2"]))
        XCTAssertEqual(effects, [.closeSocket, .openSocket(generation: 0), .subscribe(F.room("r1")), .subscribe(F.room("r2")), .recoverOperations])
        XCTAssertEqual(session.subscribed, [F.room("r1"), F.room("r2")])
        XCTAssertFalse(session.isRecovering)
        // A second foreground while already foregrounded and idle starts a new pass.
        XCTAssertEqual(session.reduce(.foreground), [.refreshAuth(generation: 0)])
        XCTAssertEqual(session.reduce(.foreground), [], "coalesced while recovering")
    }

    func testDiscoveryRemovalsComeBeforeAnyReopen() throws {
        var session = CloudSession(account: alice)
        recover(&session, with: F.discovery(["r1", "r2"]))
        session.selected = F.room("r1")
        XCTAssertEqual(session.reduce(.background), [.closeSocket])

        let effects = recover(&session, with: F.discovery(["r2", "r3"]))
        XCTAssertEqual(effects.first, .removeRoom(F.room("r1")))
        let removal = try XCTUnwrap(effects.firstIndex(of: .removeRoom(F.room("r1"))))
        let firstReopen = try XCTUnwrap(effects.firstIndex { effect in
            switch effect {
            case .openSocket, .subscribe: return true
            default: return false
            }
        })
        XCTAssertLessThan(removal, firstReopen)
        XCTAssertFalse(effects.contains(.subscribe(F.room("r1"))))
        XCTAssertNil(session.selected, "a removed selected room is deselected")
        XCTAssertEqual(session.subscribed, [F.room("r2"), F.room("r3")])
        XCTAssertEqual(effects.last, .recoverOperations)
    }

    func testAtMostFiftySubscriptionsSelectedFirst() throws {
        var session = CloudSession(account: alice)
        let ids = (1...60).map { "r\($0)" }
        session.selected = F.room("r42")
        // Selection set before discovery survives it.
        let effects = recover(&session, with: F.discovery(ids))
        let subscribes = effects.compactMap { effect -> CloudRoomRef? in
            if case .subscribe(let room) = effect { return room } else { return nil }
        }
        XCTAssertEqual(subscribes.count, CloudLimits.subscriptions)
        XCTAssertEqual(subscribes.first, F.room("r42"))
        XCTAssertEqual(Set(subscribes.map(\.roomId)).count, 50, "no duplicates")
        XCTAssertEqual(Array(subscribes.dropFirst().prefix(3)).map(\.roomId), ["r1", "r2", "r3"])
        XCTAssertFalse(subscribes.contains { $0.roomId == "r51" })

        // Selected beyond the first 50 still gets in at the front.
        var late = CloudSession(account: alice)
        late.selected = F.room("r60")
        let lateEffects = recover(&late, with: F.discovery(ids))
        XCTAssertEqual(lateEffects.dropFirst(2).first, .subscribe(F.room("r60")))
        XCTAssertEqual(late.subscribed.count, 50)
    }

    func testBackgroundClosesSocketAndClearsSubscriptions() {
        var session = CloudSession(account: alice)
        recover(&session, with: F.discovery(["r1"]))
        XCTAssertEqual(session.reduce(.background), [.closeSocket])
        XCTAssertTrue(session.subscribed.isEmpty)
        XCTAssertFalse(session.isForeground)
        XCTAssertEqual(session.known, [F.room("r1")], "discovery result is kept")
        // Socket end in the background schedules nothing.
        XCTAssertEqual(session.reduce(.socketEnded(generation: 0, retryAfter: nil)), [])
    }

    func testSocketEndedSchedulesReconnectThenReopens() {
        var session = CloudSession(account: alice)
        recover(&session, with: F.discovery(["r1", "r2"]))
        XCTAssertEqual(session.reduce(.socketLive(generation: 0)), [])

        XCTAssertEqual(session.reduce(.socketEnded(generation: 0, retryAfter: 2)), [.schedule(.reconnect, after: 2, generation: 0)])
        XCTAssertTrue(session.subscribed.isEmpty)
        // A duplicate end while already waiting does not schedule twice.
        XCTAssertEqual(session.reduce(.socketEnded(generation: 0, retryAfter: 2)), [])

        XCTAssertEqual(session.reduce(.retryDue(.reconnect, generation: 0)), [.closeSocket, .openSocket(generation: 0), .subscribe(F.room("r1")), .subscribe(F.room("r2"))])
        XCTAssertEqual(session.subscribed.count, 2)
        XCTAssertEqual(session.reduce(.retryDue(.reconnect, generation: 0)), [], "already subscribed")
        XCTAssertEqual(session.reduce(.socketLive(generation: 0)), [])

        // Without retry-after, backoff is jittered within the ceiling.
        let effects = session.reduce(.socketEnded(generation: 0, retryAfter: nil))
        guard case .schedule(.reconnect, after: let after, generation: 0)? = effects.first, effects.count == 1 else { return XCTFail("\(effects)") }
        XCTAssertLessThanOrEqual(after, CloudBackoff.ceiling(attempt: 1))
    }

    func testAuthFailureSchedulesRecoveryRetry() {
        var session = CloudSession(account: alice)
        XCTAssertEqual(session.reduce(.foreground), [.refreshAuth(generation: 0)])
        XCTAssertEqual(session.reduce(.authFailed(generation: 0, retryAfter: 5)), [.schedule(.recovery, after: 5, generation: 0)])
        XCTAssertEqual(session.reduce(.retryDue(.recovery, generation: 0)), [.refreshAuth(generation: 0)])
        XCTAssertEqual(session.reduce(.discoveryFailed(generation: 0, retryAfter: 1)), [.schedule(.recovery, after: 1, generation: 0)])
    }

    func testAccountChangedBumpsGenerationAndIgnoresLateCallbacks() {
        var session = CloudSession(account: alice)
        recover(&session, with: F.discovery(["r1"]))
        XCTAssertEqual(session.reduce(.foreground), [.refreshAuth(generation: 0)])

        let effects = session.reduce(.accountChanged(bob))
        XCTAssertEqual(effects, [.closeSocket, .clearVisibleState(previousGeneration: 0), .openStore(bob), .refreshAuth(generation: 1)])
        XCTAssertEqual(session.generation, 1)
        XCTAssertEqual(session.account, bob)
        XCTAssertTrue(session.known.isEmpty)
        XCTAssertTrue(session.subscribed.isEmpty)

        // Late answers for alice's generation drop.
        XCTAssertEqual(session.reduce(.authRefreshed(generation: 0)), [])
        XCTAssertEqual(session.reduce(.discoverySynced(generation: 0, F.discovery(["r9"]))), [])
        XCTAssertEqual(session.reduce(.socketEnded(generation: 0, retryAfter: 1)), [])
        XCTAssertEqual(session.reduce(.retryDue(.reconnect, generation: 0)), [])
        XCTAssertTrue(session.known.isEmpty)

        // The current generation still proceeds.
        XCTAssertEqual(session.reduce(.authRefreshed(generation: 1)), [.syncDiscovery(generation: 1)])
        XCTAssertEqual(session.reduce(.accountChanged(bob)), [], "same account is a no-op")
    }

    func testAccountChangedInBackgroundDoesNotStartRecovery() {
        var session = CloudSession(account: alice)
        XCTAssertEqual(session.reduce(.accountChanged(bob)), [.closeSocket, .clearVisibleState(previousGeneration: 0), .openStore(bob)])
        XCTAssertEqual(session.reduce(.accountChanged(nil)), [.closeSocket, .clearVisibleState(previousGeneration: 1)])
        XCTAssertEqual(session.reduce(.foreground), [], "no account, no recovery")
    }

    func testSignedOutErasesStore() {
        var session = CloudSession(account: alice)
        recover(&session, with: F.discovery(["r1"]))
        XCTAssertEqual(session.reduce(.signedOut), [.closeSocket, .clearVisibleState(previousGeneration: 0), .eraseStore(alice)])
        XCTAssertNil(session.account)
        XCTAssertEqual(session.generation, 1)
        XCTAssertTrue(session.known.isEmpty)
        XCTAssertEqual(session.reduce(.signedOut), [])
    }
}
