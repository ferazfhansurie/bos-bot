// The ChatGPT fold: a settled turn's steps and narration sit behind one
// "Worked for …" row, the answer below it on its own.
import XCTest
@testable import CompanionCore

final class WorkedTurnsTests: XCTestCase {
    private func user(_ id: String, at: Double) -> Message {
        var message = Message(id: id, role: .user, kind: .text, at: at)
        message.text = "do it"
        return message
    }

    private func bot(_ id: String, at: Double, botId: String? = nil) -> Message {
        var message = Message(id: id, role: .bot, kind: .text, at: at)
        message.text = "done"
        if let botId { message.from = Sender(botId: botId, name: botId, color: "") }
        return message
    }

    private func step(_ id: String, at: Double, name: String = "Bash", input: String? = nil, botId: String? = nil) -> Message {
        var message = Message(id: id, role: .bot, kind: .activity, at: at)
        message.tool = ToolActivity(name: name, ok: true, input: input, itemId: id)
        if let botId { message.from = Sender(botId: botId, name: botId, color: "") }
        return message
    }

    private func fold(_ messages: [Message], holding: Bool = false) -> [TranscriptRow] {
        foldWorkedTurns(transcriptRows(messages, detail: .reduced, foldFailures: true), holdingLastTurn: holding)
    }

    func testStepsAndNarrationFoldAboveTheAnswer() {
        let rows = fold([
            user("u", at: 0), step("s1", at: 1_000), bot("n", at: 2_000), step("s2", at: 3_000),
            step("s3", at: 4_000), bot("a", at: 656_000),
        ])
        XCTAssertEqual(rows.map(\.id), ["u", "worked.a", "a"])
        guard case let .worked(turn) = rows[1] else { return XCTFail("expected a worked row") }
        XCTAssertEqual(turn.messages.map(\.id), ["s1", "n", "s2", "s3"])
        XCTAssertEqual(turn.title, "Worked for 10m 56s")
        XCTAssertEqual(turn.summary, "Ran commands")
    }

    func testATurnWithoutToolsIsLeftAlone() {
        let rows = fold([user("u", at: 0), bot("a", at: 1), bot("b", at: 2)])
        XCTAssertEqual(rows.map(\.id), ["u", "a", "b"])
    }

    func testCardsStayOutOfTheFold() {
        var card = Message(id: "c", role: .bot, kind: .options, at: 3)
        card.card = nil
        let rows = fold([user("u", at: 0), step("s1", at: 1), card, step("s2", at: 4), bot("a", at: 5)])
        XCTAssertEqual(rows.map(\.id), ["u", "worked.a", "c", "a"])
    }

    func testRunningLastTurnIsHeld() {
        let rows = fold([user("u", at: 0), step("s1", at: 1), bot("n", at: 2)], holding: true)
        XCTAssertEqual(rows.map(\.id), ["u", "s1", "n"])
    }

    func testRoomMembersFoldSeparately() {
        let rows = fold([
            user("u", at: 0),
            step("x1", at: 1, botId: "x"), bot("xa", at: 2, botId: "x"),
            step("y1", at: 3, botId: "y"), step("y2", at: 4, botId: "y"), bot("ya", at: 5, botId: "y"),
        ])
        XCTAssertEqual(rows.map(\.id), ["u", "worked.xa", "xa", "worked.ya", "ya"])
    }

    func testTitlesAndSummary() {
        XCTAssertEqual(workedTitle(seconds: 45), "Worked for 45s")
        XCTAssertEqual(workedTitle(seconds: 120), "Worked for 2m")
        XCTAssertEqual(workedTitle(seconds: 3_840), "Worked for 1h 4m")
        XCTAssertEqual(workedTitle(seconds: 5, running: true), "Working for 5s")
        let steps = [step("1", at: 1, name: "Read"), step("2", at: 2, name: "Bash"),
                     step("3", at: 3, name: "WebSearch"), step("4", at: 4, name: "Read")].map(toolStep(from:))
        XCTAssertEqual(workedSummary(steps), "Read files, ran commands, searched the web")
    }

    func testFileChangesCountLinesPerFile() {
        let edit = step("e", at: 1, name: "Edit", input: #"{"file_path": "/repo/src/app.ts", "old_string": "a\nb", "new_string": "a\nb\nc"}"#)
        let write = step("w", at: 2, name: "Write", input: #"{"file_path": "/repo/README.md", "content": "one\ntwo"}"#)
        let again = step("e2", at: 3, name: "Edit", input: #"{"file_path": "/repo/src/app.ts", "old_string": "x", "new_string": "y"}"#)
        let cut = step("c", at: 4, name: "Edit", input: "{\n  \"file_path\": \"/repo/long.swift\",\n  \"old_string\": \"…")
        let changes = changedFiles(in: [edit, write, again, cut])
        XCTAssertEqual(changes.map(\.path), ["/repo/src/app.ts", "/repo/README.md", "/repo/long.swift"])
        XCTAssertEqual(changes[0].added, 4)
        XCTAssertEqual(changes[0].removed, 3)
        XCTAssertEqual(changes[1].added, 2)
        XCTAssertTrue(changes[1].created)
        XCTAssertNil(changes[2].added)
        XCTAssertEqual(changes[0].directory, "/repo/src/")
        XCTAssertEqual(changes[0].name, "app.ts")
    }
}

final class MarkdownTableTests: XCTestCase {
    func testPipeTableBecomesATableBlock() {
        let source = "Before\n\n| Name | Lines |\n|:---|---:|\n| `app.ts` | 12 |\n| b \\| c | 3 |\n\nAfter"
        XCTAssertEqual(Markdown.blocks(source), [
            .paragraph("Before"),
            .table(headers: ["Name", "Lines"], rows: [["`app.ts`", "12"], ["b | c", "3"]]),
            .paragraph("After"),
        ])
    }

    func testAPipeLineWithoutSeparatorStaysProse() {
        XCTAssertEqual(Markdown.blocks("| not a table |\nreally"), [.paragraph("| not a table | really")])
    }
}
