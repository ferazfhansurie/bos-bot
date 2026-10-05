import Foundation
import XCTest
@testable import CompanionCore

private final class JobInboxRequestStub: URLProtocol {
    static var captured: [URLRequest] = []
    static var status = 200
    static var body = Data(#"{"items":[]}"#.utf8)

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.captured.append(request)
        let response = HTTPURLResponse(
            url: request.url!, statusCode: Self.status, httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Self.body)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

final class JobInboxTests: XCTestCase {
    private let contractJSON = #"""
    {"items":[
      {"botId":"lead","threadId":"t-lead","revision":4,"outcome":"Ship the job inbox","state":"moving",
       "steps":[
         {"id":"api","ownerBotId":"api","action":"Scoped endpoint","status":"done","dependsOn":[],"evidence":"commit abc"},
         {"id":"ui","ownerBotId":"ui","action":"Desktop page","status":"ready","dependsOn":["api"]},
         {"id":"merge","ownerBotId":"lead","action":"Integrate","status":"waiting","dependsOn":["ui"]}
       ],
       "results":[{"stepId":"api","ownerBotId":"api","evidence":"commit abc, 12 checks","source":"owner-reported"}]},
      {"botId":"lead","threadId":"t-done","revision":1,"outcome":"Old job","state":"completed","steps":[],"results":[]},
      {"botId":"helper","threadId":"t-hold","revision":2,"outcome":"Approve spend","state":"needs-you","reason":"approval pending","steps":[],"results":[]}
    ]}
    """#

    func testDecodesSharedContractAndAttributesEvidenceToOwner() throws {
        let response = try JSONDecoder().decode(JobInboxResponse.self, from: Data(contractJSON.utf8))
        XCTAssertEqual(response.items.count, 3)
        let job = response.items[0]
        XCTAssertEqual(job.id, "lead:t-lead")
        XCTAssertEqual(job.state, .moving)
        XCTAssertEqual(job.helperBotIds, ["api", "ui"], "The lead is not listed as its own helper.")
        XCTAssertEqual(job.nextStep?.id, "ui")
        XCTAssertEqual(job.doneCount, 1)
        XCTAssertEqual(job.results.first?.ownerBotId, "api")
        XCTAssertEqual(job.results.first?.source, "owner-reported")
        XCTAssertEqual(response.items[2].reason, "approval pending")
    }

    func testOrderPutsNeedsYouFirstAndCompletedLast() throws {
        let items = try JSONDecoder().decode(JobInboxResponse.self, from: Data(contractJSON.utf8)).items
        XCTAssertEqual(orderedJobs(items).map(\.threadId), ["t-hold", "t-lead", "t-done"])
    }

    func testUnknownStateAndMalformedItemsDoNotBlankTheInbox() throws {
        let json = #"""
        {"items":[
          {"botId":"a","threadId":"t1","revision":1,"outcome":"Future","state":"escalated","steps":[{"id":"x"}],"results":[]},
          {"threadId":"no-bot"},
          {"botId":"b","threadId":"t2","revision":1,"outcome":"Fine","state":"blocked","steps":[],"results":[]}
        ]}
        """#
        let items = try JSONDecoder().decode(JobInboxResponse.self, from: Data(json.utf8)).items
        XCTAssertEqual(items.map(\.threadId), ["t1", "t2"])
        XCTAssertEqual(items[0].state, .unknown("escalated"))
        XCTAssertEqual(items[0].state.label, "Waiting", "An unknown state is never shown as more urgent than it is.")
        XCTAssertTrue(items[0].steps.isEmpty)
        XCTAssertNil(items[0].nextStep)
    }

    func testDestinationOpensExistingThreadsOnly() {
        var state = CompanionState()
        state.bots = [Bot(
            id: "lead", threadId: "t-current", name: "Bos", title: "Lead",
            description: "", notifications: true, color: "green", unread: false,
            modelSelection: ModelSelection(instanceId: "engine", model: "default"), createdAt: 1,
            tasks: [BotTask(threadId: "t-current", title: "now", createdAt: 1), BotTask(threadId: "t-lead", title: "job", createdAt: 1)]
        )]
        var room = Room(
            id: "room", threadId: "room-main", name: "Team", memberIds: ["lead"],
            defaultResponder: GroupResponder(kind: "all"), bulletin: "", unread: false, createdAt: 1
        )
        room.tasks = [BotTask(threadId: "room-side", title: "side", createdAt: 1)]
        state.rooms = [room]

        guard case let .bot(bot)? = state.destination(for: JobInboxItem(botId: "lead", threadId: "t-lead", outcome: "o", state: .moving)) else {
            return XCTFail("A direct job opens its bot thread.")
        }
        XCTAssertEqual(bot.threadId, "t-lead", "The bot is projected onto the job's thread, not its current one.")

        XCTAssertEqual(state.destination(for: JobInboxItem(botId: "lead", threadId: "room-main", outcome: "o", state: .moving)), .room(room, selected: true))
        XCTAssertEqual(state.destination(for: JobInboxItem(botId: "lead", threadId: "room-side", outcome: "o", state: .moving)), .room(room, selected: false))
        XCTAssertNil(state.destination(for: JobInboxItem(botId: "lead", threadId: "elsewhere", outcome: "o", state: .moving)))
        XCTAssertEqual(state.ownerName("lead"), "Bos")
        XCTAssertEqual(state.ownerName("gone"), "gone")
    }

    func testClientReadsJobsWithASingleGet() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [JobInboxRequestStub.self]
        JobInboxRequestStub.captured = []
        JobInboxRequestStub.status = 200
        JobInboxRequestStub.body = Data(contractJSON.utf8)
        let client = CompanionClient(
            connection: Connection(name: "Mac", host: "127.0.0.1", port: 8810),
            token: "token", session: URLSession(configuration: configuration)
        )

        let response = try await client.jobInbox()

        XCTAssertEqual(response.items.count, 3)
        XCTAssertEqual(JobInboxRequestStub.captured.count, 1)
        XCTAssertEqual(JobInboxRequestStub.captured.first?.httpMethod, "GET")
        XCTAssertEqual(JobInboxRequestStub.captured.first?.url?.path, "/api/jobs")
        XCTAssertNil(JobInboxRequestStub.captured.first?.httpBody)
    }

    func testClientSurfacesOlderComputerWithoutJobs() async {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [JobInboxRequestStub.self]
        JobInboxRequestStub.status = 404
        JobInboxRequestStub.body = Data(#"{"error":"Not found"}"#.utf8)
        let client = CompanionClient(
            connection: Connection(name: "Mac", host: "127.0.0.1", port: 8810),
            token: "token", session: URLSession(configuration: configuration)
        )
        do {
            _ = try await client.jobInbox()
            XCTFail("A 404 must not read as an empty inbox.")
        } catch let APIError.status(code, _) {
            XCTAssertEqual(code, 404)
        } catch {
            XCTFail("unexpected \(error)")
        }
    }
}
