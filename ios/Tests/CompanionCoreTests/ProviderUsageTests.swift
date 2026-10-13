import XCTest
@testable import CompanionCore

final class ProviderUsageTests: XCTestCase {
    func testNamedAccountsKeepDistinctIdentityWithTheSameLabel() throws {
        let accounts = try decode(#"{"accounts":[{"provider":"claude","instanceId":"personal","account":"claude","sevenDay":{"usedPercent":24,"resetsAt":null},"status":"available"},{"provider":"claude","instanceId":"work","account":"claude","sevenDay":{"usedPercent":74,"resetsAt":null},"status":"available"}]}"#)
        XCTAssertNotEqual(accounts[0].id, accounts[1].id)
        XCTAssertEqual(accounts[0].peakPercent, 24)
        XCTAssertEqual(accounts[1].peakPercent, 74)
    }

    private func decode(_ json: String) throws -> [ProviderUsageAccount] {
        try JSONDecoder().decode(ProviderUsageResponse.self, from: Data(json.utf8)).accounts
    }

    func testClaudeShowsBothWindowsAndBarsTheFullerOne() throws {
        let account = try XCTUnwrap(decode(#"{"accounts":[{"provider":"claude","account":"me","fiveHour":{"usedPercent":25.4,"resetsAt":1700000000},"sevenDay":{"usedPercent":56,"resetsAt":null},"status":"ok"}]}"#).first)
        XCTAssertEqual(account.providerName, "Claude")
        XCTAssertEqual(account.compactSummary, "5h 25% · 7d 56%")
        XCTAssertEqual(account.peakPercent, 56)
    }

    func testCodexWithoutFiveHourAndAnUnreadWindow() throws {
        let accounts = try decode(#"{"accounts":[{"provider":"codex","account":"me","sevenDay":{"usedPercent":60,"resetsAt":null},"status":"ok"},{"provider":"codex","account":"two","sevenDay":{"usedPercent":null,"resetsAt":null},"status":"error"}]}"#)
        XCTAssertEqual(accounts[0].providerName, "Codex")
        XCTAssertEqual(accounts[0].compactSummary, "7d 60%")
        XCTAssertEqual(accounts[1].compactSummary, "7d \u{2013}")
        XCTAssertNil(accounts[1].peakPercent)
    }
}
