// What a reader ends up seeing for a tool call: a verb, the thing it acted
// on, and — for a run — one line standing in for several steps.
import XCTest
@testable import CompanionCore

final class ToolStepsTests: XCTestCase {
    private func activity(
        _ id: String, name: String, ok: Bool? = true, summary: String? = nil,
        input: String? = nil, output: String? = nil, itemId: String? = "item", at: Double = 0
    ) -> Message {
        var message = Message(id: id, role: .bot, kind: .activity, at: at)
        message.tool = ToolActivity(name: name, ok: ok, summary: summary, input: input, output: output, itemId: itemId)
        return message
    }

    func testFileToolsReadAsAVerbAndABasename() {
        let step = toolStep(from: activity("a", name: "Read", summary: "/Users/f/repo/server/retry.ts"))
        XCTAssertEqual(step.verb, "Read")
        XCTAssertEqual(step.target, "retry.ts")
        XCTAssertEqual(step.label, "Read retry.ts")
        XCTAssertEqual(step.status, .ok)
    }

    func testACommandKeepsItsFirstLine() {
        let step = toolStep(from: activity("a", name: "Bash", summary: "pnpm test --run\n(second line)"))
        XCTAssertEqual(step.verb, "Ran")
        XCTAssertEqual(step.target, "pnpm test --run")
    }

    func testAnMcpToolNamesItsServerRatherThanItsWireName() {
        let step = toolStep(from: activity("a", name: "mcp__composio__GMAIL_SEND_EMAIL"))
        XCTAssertEqual(step.verb, "Called composio")
        XCTAssertEqual(step.symbol, "puzzlepiece.extension")
    }

    func testAnUnknownToolKeepsItsOwnName() {
        XCTAssertEqual(toolStep(from: activity("a", name: "DesignSync")).verb, "DesignSync")
        XCTAssertEqual(toolStep(from: activity("a", name: "DesignSync")).label, "Used DesignSync")
    }

    // MARK: - Plain words

    /// What firaz saw on 1.9.3 (76): "Ran cd /Users/firazfhansurie/aios-firaz/
    /// workspaces/..." on every row. A shell step reads as what it was for.
    func testAShellStepReadsAsWhatItWasFor() {
        let cases: [(String, String)] = [
            ("cd /Users/f/aios-firaz/workspaces/repo && pnpm test --run", "Ran tests"),
            ("cd ios && swift test --filter ToolSteps 2>&1 | tail -5", "Ran tests"),
            ("cd /x && git status --short && git log --oneline -5", "Checked git"),
            ("git add -A && git commit -m 'x'", "Saved a commit"),
            ("ls -la /tmp", "Looked through files"),
            ("cat ~/.bos-bot/workspaces/59d5f871/plans/queue.md", "Read a file"),
            ("grep -rn foo src | head", "Searched files"),
            ("sleep 160; date", "Waited a moment"),
            ("W=~/.bos-bot/workspaces/59d5f871 && python3 $W/bin/bos-restart-guard.py", "Ran a script"),
            ("~/.bos-bot/workspaces/59d5f871/bin/bos-restart-guard.py", "Checked it was safe to restart"),
            ("xcrun devicectl device install app --device CC45 /x/BosBot.app", "Installed it on the phone"),
            ("xcodebuild -project BosBot.xcodeproj -scheme BosBot build", "Built the app"),
            ("ssh bos-laptop 'uptime'", "Worked on another machine"),
            ("curl -s https://example.com/api", "Checked a website"),
            ("echo hi", "Ran a command"),
            ("", "Ran a command"),
            ("frobnicate --all", "Ran a command"),
        ]
        for (command, expected) in cases {
            XCTAssertEqual(commandPhrase(command), expected, command)
        }
    }

    func testTheRawCommandIsNotTheLabelButStaysForTheExpandedRow() {
        let raw = "cd /Users/firazfhansurie/aios-firaz/workspaces/repo && pnpm vitest run"
        let step = toolStep(from: activity("a", name: "Bash", summary: raw, input: #"{"command":"\#(raw)","description":"x"}"#))
        XCTAssertEqual(step.label, "Ran tests")
        XCTAssertEqual(step.summary, raw)
        XCTAssertTrue(step.input?.contains("pnpm vitest run") == true)
    }

    func testFileAndWebStepsSayWhatTheyTouched() {
        XCTAssertEqual(toolStep(from: activity("a", name: "Edit", input: #"{"file_path":"/x/ios/App/ChatView.swift","old_string":"a"}"#)).label, "Edited ChatView.swift")
        XCTAssertEqual(toolStep(from: activity("a", name: "Write", summary: "/x/notes.md")).label, "Wrote notes.md")
        XCTAssertEqual(toolStep(from: activity("a", name: "Read")).label, "Read a file")
        XCTAssertEqual(toolStep(from: activity("a", name: "WebSearch", summary: "swiftui shimmer")).label, "Searched the web")
        XCTAssertEqual(toolStep(from: activity("a", name: "WebFetch", summary: "https://www.apple.com/iphone")).label, "Read apple.com")
        XCTAssertEqual(toolStep(from: activity("a", name: "Grep", summary: "toolLabel")).label, "Searched files")
        XCTAssertEqual(toolStep(from: activity("a", name: "mcp__browser__agent_browser_snapshot")).label, "Checked the browser")
        XCTAssertEqual(toolStep(from: activity("a", name: "mcp__computer__click")).label, "Used the computer")
        XCTAssertEqual(toolStep(from: activity("a", name: "mcp__agents__memory_update")).label, "Updated its notes")
        XCTAssertEqual(toolStep(from: activity("a", name: "Agent")).label, "Got a helper on it")
    }

    func testARunOfTheSamePlainStepSaysItOnce() {
        let steps = ["a", "b"].map { toolStep(from: activity($0, name: "Bash", summary: "pnpm test")) }
        XCTAssertEqual(activitySummary(steps), "ran tests ×2")
        let mixed = [
            toolStep(from: activity("a", name: "Bash", summary: "pnpm test")),
            toolStep(from: activity("b", name: "Bash", summary: "git status")),
        ]
        XCTAssertEqual(activitySummary(mixed), "ran 2 commands")
    }

    /// The harness's own receipts have no provider item behind them and are
    /// already sentences — re-wording those into a verb would invent a step
    /// that never ran.
    func testAHarnessReceiptIsShownVerbatim() {
        let step = toolStep(from: activity("a", name: "Messaged @Helper", itemId: nil))
        XCTAssertFalse(step.isTool)
        XCTAssertEqual(step.name, "Messaged @Helper")
        XCTAssertEqual(activitySummary([step]), "Messaged @Helper")
    }

    func testAPendingCallIsRunningAndAFailedOneIsFailed() {
        XCTAssertEqual(toolStep(from: activity("a", name: "Read", ok: nil)).status, .running)
        XCTAssertEqual(toolStep(from: activity("b", name: "Read", ok: false)).status, .failed)
    }

    // MARK: - The folded line

    func testARunOfOneVerbCountsItsNoun() {
        let steps = ["a", "b", "c"].map { toolStep(from: activity($0, name: "Read", summary: "/x/\($0).ts")) }
        XCTAssertEqual(activitySummary(steps), "read 3 files")
    }

    func testASingleCallWithNoTargetReadsAsAnArticle() {
        XCTAssertEqual(activitySummary([toolStep(from: activity("a", name: "Bash"))]), "ran a command")
        XCTAssertEqual(activitySummary([toolStep(from: activity("a", name: "Read", summary: "/x/Retry.ts"))]), "read Retry.ts")
    }

    func testAMixedRunJustCountsSteps() {
        let steps = [
            toolStep(from: activity("a", name: "Read", summary: "/x/a.ts")),
            toolStep(from: activity("b", name: "Bash", summary: "ls")),
        ]
        XCTAssertEqual(activitySummary(steps), "2 steps")
    }

    /// One failure is the thing worth seeing, and a run with anything still
    /// in flight has not finished — neither may be rounded up to "done".
    func testARunReadsAsItsWorstOutcome() {
        let ok = toolStep(from: activity("a", name: "Read"))
        let running = toolStep(from: activity("b", name: "Read", ok: nil))
        let failed = toolStep(from: activity("c", name: "Read", ok: false))
        XCTAssertEqual(activityStatus([ok, ok]), .ok)
        XCTAssertEqual(activityStatus([ok, running]), .running)
        XCTAssertEqual(activityStatus([ok, running, failed]), .failed)
    }

    func testElapsedReadsAsMinutesPastAMinute() {
        XCTAssertEqual(elapsedLabel(0), "0s")
        XCTAssertEqual(elapsedLabel(59), "59s")
        XCTAssertEqual(elapsedLabel(64), "1m 04s")
        XCTAssertEqual(elapsedLabel(-3), "0s")
        XCTAssertEqual(elapsedLabel(3_599), "59m 59s")
        XCTAssertEqual(elapsedLabel(3_600), "1h 00m")
        XCTAssertEqual(elapsedLabel(7_530), "2h 05m")
    }

    /// The fields the row is built from are on the wire already; the phone
    /// used to drop them, which is why steps had nothing to say.
    func testTheWireFieldsSurviveDecoding() throws {
        let json = """
        {"id":"m1","role":"bot","kind":"activity","at":1,
         "tool":{"name":"Read","ok":true,"summary":"/x/a.ts","input":"{\\"path\\":\\"/x/a.ts\\"}","output":"ok","itemId":"i1"}}
        """
        let message = try JSONDecoder().decode(Message.self, from: Data(json.utf8))
        XCTAssertEqual(message.tool?.summary, "/x/a.ts")
        XCTAssertEqual(message.tool?.output, "ok")
        XCTAssertEqual(message.tool?.itemId, "i1")
    }
}
