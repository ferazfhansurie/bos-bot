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
