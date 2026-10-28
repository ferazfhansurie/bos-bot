// The owner's bosbot.my screen reads a json the site grows often. These
// check the picks the screen shows, and that a missing field drops its row
// instead of showing a zero nobody measured. Numbers here are made up.
import XCTest
@testable import CompanionCore

final class SiteDataTests: XCTestCase {
    private func summary(_ json: String) throws -> SiteDataSummary {
        let response = try JSONDecoder().decode(SiteDataResponse.self, from: Data(#"{"fetchedAt":1,"data":\#(json)}"#.utf8))
        return SiteDataSummary(response.data)
    }

    func testPicksTheHeroTilesAndAdBudget() throws {
        let s = try summary(#"""
        {"generated_at":"2026-10-26T07:21:59+00:00",
         "acquisition":{"recent":{"views_24h":52,"downloads_24h":4,"installs_24h":1},"daily":{"views":[1,2,3],"installs":[0,1,0]},
                        "7d":{"funnel":{"views":680,"human_downloads":15,"real_new_installs":12,"returning":3},
                              "sources":[{"source":"meta","views":272,"downloads":4,"installs":2}]}},
         "pulse":{"views_7d":680,"web_signups_7d":14,"installs_7d":12,"web_messaged_7d":5,"web_signups_daily":[1,0,2],"first_msg_daily":[0,1,0]},
         "desktop":{"active_1d":8,"people_1d":8,"active_1d_returning":7,"people_7d":15,"daily_active":[5,6,8],"platform_30d":{"darwin":11,"win32":6},"versions_30d":[["2.2.0",2]]},
         "ads":{"cap_rm":300,"spent_rm":208,"daily_rm":40,"ads":[{"name":"ad e","status":"ACTIVE","spend_rm":202.64},{"name":"ad f","status":"PAUSED"}]},
         "health":{"overall":"good","checks":[{"key":"signups","label":"sign-ups","status":"good","value":4,"detail":""},{"key":"site","label":"bosbot.my","status":"good","value":"up","detail":"163ms"}]},
         "free":{"signups":{"outside":14},"fleet":{"vms":1,"max":8},"funnel_30d":[{"step":"signup_started","n":15}]},
         "engine":{"month_usd":1.1076,"monthly_cap_usd":100,"people_used":10}}
        """#)
        XCTAssertEqual(s.views24h, 52)
        XCTAssertEqual(s.story, "4 downloaded, 4 signed up, 1 new install. 8 desktop users active today.")
        XCTAssertEqual(s.statusLine, "everything is running")
        XCTAssertEqual(s.checks.first?.value, "4")
        XCTAssertEqual(s.visits?.note, "680 this week")
        XCTAssertEqual(s.newPeople?.value, 26)
        XCTAssertEqual(s.newPeople?.note, "14 web · 12 desktop")
        XCTAssertEqual(s.newPeople?.spark, [1, 1, 2])
        XCTAssertEqual(s.firstMessage?.unit, "of 14")
        XCTAssertEqual(s.firstMessage?.note, "36% of web sign-ups")
        XCTAssertEqual(s.usingBos?.note, "7 returning · 15 this week")
        XCTAssertEqual(s.budget?.name, "ad e")
        XCTAssertEqual(s.budget?.daysLeft ?? 0, 2.3, accuracy: 0.01)
        XCTAssertEqual(s.funnel7d.map(\.count), [680, 15, 12, 3])
        XCTAssertEqual(s.platforms.map(\.label), ["mac", "windows"])
        XCTAssertEqual(s.freeFunnel.first?.label, "started sign-up")
        XCTAssertTrue(s.free.contains(SiteDataSummary.Pair(label: "free engine this month", value: "$1.11 of $100")))
        XCTAssertNotNil(s.generatedAt)
    }

    func testMissingFieldsDropTheirRowsAndProblemsShowInThePill() throws {
        let s = try summary(#"{"health":{"overall":"warning","checks":[{"key":"app","label":"app.bosbot.my","status":"serious","value":"down"},{"key":"ads","label":"meta ads","status":"off","value":"off"}]}}"#)
        XCTAssertNil(s.visits)
        XCTAssertNil(s.newPeople)
        XCTAssertNil(s.firstMessage)
        XCTAssertNil(s.usingBos)
        XCTAssertNil(s.budget)
        XCTAssertNil(s.story)
        XCTAssertEqual(s.statusLine, "app.bosbot.my needs a look")
    }
}
