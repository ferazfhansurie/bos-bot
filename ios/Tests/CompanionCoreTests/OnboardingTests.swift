import Foundation
import XCTest
@testable import CompanionCore

final class OnboardingTests: XCTestCase {
    func testFirstLaunchShowsWelcome() {
        XCTAssertEqual(
            CompanionOnboardingRouter.route(for: .init(
                pairingState: .unpaired,
                hasSeenWelcome: false
            )),
            .welcome
        )
    }

    func testSkipShowsUsefulUnpairedHome() {
        XCTAssertEqual(
            CompanionOnboardingRouter.route(for: .init(
                pairingState: .unpaired,
                hasSeenWelcome: true
            )),
            .unpairedHome
        )
    }

    func testResumeAndPendingInviteBothOpenPairing() {
        XCTAssertEqual(
            CompanionOnboardingRouter.route(for: .init(
                pairingState: .unpaired,
                hasSeenWelcome: true,
                pairingRequested: true
            )),
            .pairing
        )
        XCTAssertEqual(
            CompanionOnboardingRouter.route(for: .init(
                pairingState: .unpaired,
                hasSeenWelcome: false,
                hasPendingPairingInvite: true
            )),
            .pairing
        )
    }

    func testExistingPairedUserGoesStraightToChats() {
        XCTAssertEqual(
            CompanionOnboardingRouter.route(for: .init(
                pairingState: .paired,
                hasSeenWelcome: true
            )),
            .chats
        )
    }

    func testPairedUserCanAddAnotherComputer() {
        XCTAssertEqual(
            CompanionOnboardingRouter.route(for: .init(
                pairingState: .paired,
                hasSeenWelcome: true,
                pairingRequested: true
            )),
            .pairing
        )
        XCTAssertEqual(
            CompanionOnboardingRouter.route(for: .init(
                pairingState: .paired,
                hasSeenWelcome: true,
                hasPendingPairingInvite: true
            )),
            .pairing
        )
    }

    func testJustPairedUserSeesNotificationExplanationOnceThenChats() {
        XCTAssertEqual(
            CompanionOnboardingRouter.route(for: .init(
                pairingState: .paired,
                hasSeenWelcome: true,
                notificationOnboardingPending: true,
                notificationAuthorization: .notDetermined
            )),
            .notificationPrompt
        )
        XCTAssertEqual(
            CompanionOnboardingRouter.route(for: .init(
                pairingState: .paired,
                hasSeenWelcome: true,
                notificationOnboardingPending: true,
                hasSeenNotificationPrompt: true
            )),
            .chats
        )
        XCTAssertEqual(
            CompanionOnboardingRouter.route(for: .init(
                pairingState: .paired,
                hasSeenWelcome: true,
                notificationOnboardingPending: true,
                notificationAuthorization: .determined
            )),
            .chats
        )
    }

    func testPendingNotificationEducationSurvivesUnresolvedLaunchAndRelaunch() {
        let unresolved = CompanionOnboardingContext(
            pairingState: .paired,
            hasSeenWelcome: true,
            notificationOnboardingPending: true,
            notificationAuthorization: .unresolved
        )
        XCTAssertEqual(CompanionOnboardingRouter.route(for: unresolved), .chats)
        XCTAssertTrue(CompanionNotificationOnboardingPolicy.shouldKeepPending(
            isPending: true,
            hasCompletedStep: false,
            authorization: .unresolved
        ))

        // A second process launch reads the same durable pending marker. Once
        // iOS resolves to notDetermined, the education step must reappear.
        let relaunchedAndResolved = CompanionOnboardingContext(
            pairingState: .paired,
            hasSeenWelcome: true,
            notificationOnboardingPending: true,
            notificationAuthorization: .notDetermined
        )
        XCTAssertEqual(
            CompanionOnboardingRouter.route(for: relaunchedAndResolved),
            .notificationPrompt
        )
        XCTAssertTrue(CompanionNotificationOnboardingPolicy.shouldKeepPending(
            isPending: true,
            hasCompletedStep: false,
            authorization: .notDetermined
        ))
    }

    func testPendingNotificationPreferenceSurvivesAProcessRelaunch() throws {
        let suiteName = "CompanionOnboardingTests.\(UUID().uuidString)"
        defer { UserDefaults.standard.removePersistentDomain(forName: suiteName) }
        let firstLaunch = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        firstLaunch.set(
            true,
            forKey: CompanionOnboardingPreferences.pendingNotificationOnboardingKey
        )

        let relaunched = try XCTUnwrap(UserDefaults(suiteName: suiteName))

        XCTAssertTrue(relaunched.bool(
            forKey: CompanionOnboardingPreferences.pendingNotificationOnboardingKey
        ))
    }

    func testPairingCommitMarksNotificationStepBeforeSavingConnection() {
        var writes: [String] = []

        CompanionPairingCommitSequence.persist {
            writes.append("notification-pending")
        } saveConnection: {
            writes.append("connection")
        }

        XCTAssertEqual(writes, ["notification-pending", "connection"])
    }

    func testResolvedOrCompletedNotificationEducationClearsPendingMarker() {
        XCTAssertFalse(CompanionNotificationOnboardingPolicy.shouldKeepPending(
            isPending: true,
            hasCompletedStep: false,
            authorization: .determined
        ))
        XCTAssertFalse(CompanionNotificationOnboardingPolicy.shouldKeepPending(
            isPending: true,
            hasCompletedStep: true,
            authorization: .notDetermined
        ))
        XCTAssertTrue(CompanionNotificationOnboardingPolicy.shouldKeepPending(
            isPending: true,
            hasCompletedStep: true,
            authorization: .unresolved
        ))
    }

    func testPairingSubmissionBlocksResetUntilTheAttemptSettles() {
        var submission = CompanionPairingSubmissionState()
        XCTAssertTrue(submission.allowsNavigation)
        XCTAssertTrue(submission.begin())
        XCTAssertTrue(submission.isInFlight)
        XCTAssertFalse(submission.allowsNavigation)
        XCTAssertFalse(submission.begin(), "a second Connect cannot overtake the in-flight request")

        submission.finish()

        XCTAssertFalse(submission.isInFlight)
        XCTAssertTrue(submission.allowsNavigation)
        XCTAssertTrue(submission.begin(), "navigation and retry resume only after completion")
    }

    func testClearedDeferredInviteCannotReopenPairingAfterLaterUnpair() {
        var submission = CompanionPairingSubmissionState()
        XCTAssertTrue(submission.begin())
        XCTAssertFalse(
            submission.allowsNavigation,
            "a second deep link stays deferred while the first pairing commits"
        )
        submission.finish()

        let staleInviteRoute = CompanionOnboardingRouter.route(for: .init(
            pairingState: .unpaired,
            hasSeenWelcome: true,
            hasPendingPairingInvite: true
        ))
        XCTAssertEqual(staleInviteRoute, .pairing)

        let routeAfterSuccessfulPairClearsTheInvite = CompanionOnboardingRouter.route(for: .init(
            pairingState: .unpaired,
            hasSeenWelcome: true,
            hasPendingPairingInvite: false
        ))
        XCTAssertEqual(routeAfterSuccessfulPairClearsTheInvite, .unpairedHome)
    }

    func testPairingInviteQueueClearsAcrossSuccessAndSignOutSequence() {
        let first = PairingInvite(
            connection: Connection(name: "First", host: "first.local", port: 8810),
            credential: "first-code"
        )
        let deferred = PairingInvite(
            connection: Connection(name: "Deferred", host: "deferred.local", port: 8810),
            credential: "deferred-code"
        )
        var pending = CompanionPairingInvitePolicy.nextInvite(
            current: nil,
            after: .received(first)
        )
        pending = CompanionPairingInvitePolicy.nextInvite(
            current: pending,
            after: .received(deferred)
        )
        XCTAssertEqual(pending, deferred)

        pending = CompanionPairingInvitePolicy.nextInvite(
            current: pending,
            after: .pairingSucceeded
        )
        XCTAssertNil(pending)
        pending = CompanionPairingInvitePolicy.nextInvite(
            current: deferred,
            after: .signedOut
        )
        XCTAssertNil(pending)
    }

    func testRevokedPairingAlwaysShowsRecovery() {
        XCTAssertEqual(
            CompanionOnboardingRouter.route(for: .init(
                pairingState: .revoked,
                hasSeenWelcome: false,
                pairingRequested: true,
                hasPendingPairingInvite: true
            )),
            .revoked
        )
    }
}
