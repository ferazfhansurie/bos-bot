import XCTest
@testable import CompanionCore

final class ToolProgressTests: XCTestCase {
    func testRawToolNamesReadAsPlainWords() {
        XCTAssertEqual(toolProgress(for: "Bash").phrase, "running a command")
        XCTAssertEqual(toolProgress(for: "exec_command").phrase, "running a command")
        XCTAssertEqual(toolProgress(for: "Read").phrase, "reading files")
        XCTAssertEqual(toolProgress(for: "Edit").phrase, "editing code")
        XCTAssertEqual(toolProgress(for: "apply_patch").phrase, "editing code")
        XCTAssertEqual(toolProgress(for: "WebSearch").phrase, "searching the web")
        XCTAssertEqual(toolProgress(for: "Grep").phrase, "searching files")
        XCTAssertEqual(toolProgress(for: "mcp__computer__click").phrase, "on the computer")
        XCTAssertEqual(toolProgress(for: "mcp__browser__agent_browser_open").phrase, "browsing the web")
        XCTAssertEqual(toolProgress(for: "mcp__agents__memory_update").phrase, "updating its memory")
        XCTAssertEqual(toolProgress(for: "mcp__neon-postgres__run_sql").phrase, "querying the database")
        XCTAssertEqual(toolProgress(for: "mcp__linear__list_issues").phrase, "using linear")
        XCTAssertEqual(toolProgress(for: "SomethingNew").phrase, "working")
    }

    func testReplyFirstLineStripsMarkdownAndBounds() {
        XCTAssertEqual(replyFirstLine("\n## **Shipped** the fix\nmore"), "Shipped the fix")
        XCTAssertEqual(replyFirstLine("- `done`"), "done")
        XCTAssertEqual(replyFirstLine(String(repeating: "a", count: 200), limit: 10).count, 10)
        XCTAssertEqual(replyFirstLine(nil), "")
    }

    func testActivityContentDecodesWithoutNewFields() throws {
        let legacy = """
        {"face":"working","kind":"working","headline":"bos is working","line":"Bash",
        "options":[],"isPermission":false,"since":0}
        """
        let content = try JSONDecoder().decode(BotActivityContent.self, from: Data(legacy.utf8))
        XCTAssertNil(content.threadTitle)
        XCTAssertNil(content.otherThreads)
        XCTAssertTrue(content.isWorking)
    }
}
