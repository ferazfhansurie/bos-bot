import XCTest
@testable import CompanionCore

final class ApprovalPerformanceTests: XCTestCase {
    func testManyIdleThreadsDoNotRebuildEveryBranchForRosterApprovalBadges() throws {
        var state = CompanionState()
        for b in 0..<12 {
            var bot = Bot(id: "b\(b)", threadId: "t\(b)-0", name: "Bot", title: "Bot", description: "", notifications: true, color: "green", unread: false, modelSelection: ModelSelection(instanceId: "engine", model: "default"), createdAt: 0)
            bot.tasks = (0..<50).map { BotTask(threadId: "t\(b)-\($0)", title: "Thread", createdAt: 1) }
            for t in 0..<50 {
                let id = "t\(b)-\(t)"
                state.messages[id] = (0..<100).map { n in
                    var m = Message(id: "\(id)-\(n)", role: .bot, kind: .text, at: Double(n))
                    if n > 0 { m.parentId = "\(id)-\(n - 1)" }
                    return m
                }
                state.activeLeafIds[id] = "\(id)-99"
            }
            state.bots.append(bot)
        }
        let start = Date()
        for _ in 0..<3 { XCTAssertTrue(state.pendingApprovals.isEmpty) }
        let elapsed = Date().timeIntervalSince(start)
        print("approval roster benchmark: \(elapsed) seconds for 600 threads / 60000 messages, 3 passes")
        XCTAssertLessThan(elapsed, 0.15, "Approval badges must fit within the roster refresh budget.")
    }

    func testApprovalOnInactiveBranchIsExcludedAndBranchSwitchIsImmediate() throws {
        var state = CompanionState()
        let bot = Bot(id: "b", threadId: "t", name: "Bot", title: "Bot", description: "", notifications: true, color: "green", unread: false, modelSelection: ModelSelection(instanceId: "engine", model: "default"), createdAt: 0)
        state.bots = [bot]
        let root = Message(id: "root", role: .user, kind: .text, at: 1)
        var ask = Message(id: "ask", role: .bot, kind: .options, at: 2)
        ask.parentId = "root"
        ask.card = OptionCard(title: "Approve?", subtitle: "Read", options: ["Allow"], requestId: "r")
        var other = Message(id: "other", role: .bot, kind: .text, at: 3)
        other.parentId = "root"
        state.messages["t"] = [root, ask, other]
        state.activeLeafIds["t"] = "other"
        XCTAssertTrue(state.pendingApprovals.isEmpty)
        state.activeLeafIds["t"] = "ask"
        XCTAssertEqual(state.pendingApprovals.map(\.message.id), ["ask"])
        ask.card?.answered = "Allow"
        state.apply(.messagePatch(threadId: "t", message: ask))
        XCTAssertTrue(state.pendingApprovals.isEmpty)
    }
}
