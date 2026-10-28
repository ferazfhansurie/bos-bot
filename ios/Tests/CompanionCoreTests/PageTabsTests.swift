import XCTest
@testable import CompanionCore

final class PageTabsTests: XCTestCase {
    func testDisplayTitleFallsBackToAReadableFileName() {
        XCTAssertEqual(PageTab(path: "bos-pages/2026-10-28-sales-dashboard-k3f9.html", openedAt: 0).displayTitle, "sales dashboard")
        XCTAssertEqual(PageTab(path: "deck.HTML", openedAt: 0).displayTitle, "deck")
        XCTAssertEqual(PageTab(path: "bos-pages/x.html", title: "  Q4 deck ", openedAt: 0).displayTitle, "Q4 deck")
    }

    func testWorkspaceOpenFrameDecodes() throws {
        let json = #"{"kind":"workspace.open","botId":"b1","threadId":"t1","tab":"canvas","ref":"bos-pages/a.html","title":"A"}"#
        let frame = try JSONDecoder().decode(Frame.self, from: Data(json.utf8))
        guard case let .workspaceOpen(botId, threadId, tab) = frame else { return XCTFail("\(frame)") }
        XCTAssertEqual([botId, threadId, tab], ["b1", "t1", "canvas"])
        XCTAssertEqual(frame.threadId, "t1")
        // a frame missing its ids is ignored, not a broken stream
        let bad = try JSONDecoder().decode(Frame.self, from: Data(#"{"kind":"workspace.open"}"#.utf8))
        guard case .unknown = bad else { return XCTFail("\(bad)") }
    }

    func testPageListDecodes() throws {
        let json = #"{"pages":[{"path":"a.html","title":"A","appId":"a-1","openedAt":3,"mtime":5},{"path":"b.html","openedAt":2,"gone":true}]}"#
        let list = try JSONDecoder().decode(PageTabList.self, from: Data(json.utf8))
        XCTAssertEqual(list.pages.map(\.path), ["a.html", "b.html"])
        XCTAssertEqual(list.pages[0].appId, "a-1")
        XCTAssertEqual(list.pages[1].gone, true)
    }
}
