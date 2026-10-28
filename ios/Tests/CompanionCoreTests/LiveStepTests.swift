import XCTest
@testable import CompanionCore

final class LiveStepTests: XCTestCase {
    private func tool(_ name: String, input: String? = nil, summary: String? = nil, at: Double = 10_000, item: String? = "item") -> Message {
        var message = Message(id: UUID().uuidString, role: .bot, kind: .activity, at: at)
        message.tool = ToolActivity(name: name, summary: summary, input: input, itemId: item)
        return message
    }

    func testStepsReadAsPlainWords() {
        XCTAssertEqual(liveToolStep(name: "Read", summary: nil, input: #"{"file_path":"/a/b/retry.ts"}"#).line, "reading retry.ts")
        XCTAssertEqual(liveToolStep(name: "Read", summary: nil, input: #"{"file_path":"/a/LiveActivityCoordinatorTests.swift"}"#).line, "reading a file")
        XCTAssertEqual(liveToolStep(name: "Bash", summary: nil, input: #"{"command":"cd /x && npx vitest run"}"#).line, "running tests")
        XCTAssertEqual(liveToolStep(name: "Bash", summary: "git add -A && git commit -m x", input: nil).line, "saving the work")
        XCTAssertEqual(liveToolStep(name: "WebFetch", summary: nil, input: #"{"url":"https://www.apple.com/x"}"#).line, "reading apple.com")
        XCTAssertEqual(liveToolStep(name: "mcp__agents__coordinate_bots", summary: nil, input: nil).line, "talking to the team")
        XCTAssertEqual(liveToolStep(name: "mystery", summary: nil, input: nil).line, "working on it")
        for name in ["Read", "Bash", "WebSearch", "mcp__browser__agent_browser_open", "mystery"] {
            let line = liveToolStep(name: name, summary: "cat /etc/passwd", input: nil).line
            XCTAssertLessThanOrEqual(line.count, 32)
            XCTAssertFalse(line.contains("/"), line)
            XCTAssertEqual(line, line.lowercased())
        }
    }

    func testPlanGivesStepOfAndNeverThinking() {
        let plan = tool("TodoWrite", input: #"{"todos":[{"content":"a","status":"completed"},{"content":"b","status":"completed"},{"content":"Edit `ios/App/LiveActivities.swift`","activeForm":"Editing ios/App/LiveActivities.swift","status":"in_progress"},{"content":"d","status":"pending"},{"content":"e","status":"pending"}]}"#, at: 9_000)
        let step = liveStep([plan, tool("Grep", at: 9_500)], since: Date(timeIntervalSince1970: 9))
        XCTAssertEqual(step?.line, "searching files")
        XCTAssertEqual(step?.stepIndex, 3)
        XCTAssertEqual(step?.stepCount, 5)
        XCTAssertEqual(step?.planStep, "editing liveactivities.swift")
    }

    func testOnlyThisJobAndRealToolsCount() {
        let old = tool("Read", input: #"{"file_path":"old.ts"}"#, at: 1_000)
        XCTAssertNil(liveStep([old], since: Date(timeIntervalSince1970: 60)))
        let receipt = tool("Messaged @Helper", at: 70_000, item: nil)
        XCTAssertNil(liveStep([receipt], since: Date(timeIntervalSince1970: 60)))
    }

    func testJobTitleFallsBackToTheCleanedMessage() {
        XCTAssertEqual(liveJobTitle(threadTitle: "fix the login", message: "x"), "fix the login")
        XCTAssertEqual(liveJobTitle(threadTitle: "Make voice v3 call me back when…", message: "[Thread you opened yourself from #voice · x] Make voice v3 call me back when a job completes. More."), "make voice v3 call me…")
        XCTAssertEqual(liveJobTitle(threadTitle: nil, message: "sent from a live voice call: lead with the outcome. Check the ads now please"), "check the ads now please")
        XCTAssertNil(liveJobTitle(threadTitle: nil, message: "   "))
    }
}
