// Apps on the phone: the page's requests are re-checked with the desktop's
// rules, writes reach the app the phone opened, and the offline copy can't be
// steered outside its folder.
import Foundation
import XCTest
@testable import CompanionCore

private final class AppsRequestStub: URLProtocol {
    static var responseBody = Data()
    static var capturedRequest: URLRequest?
    static var capturedBody: Data?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.capturedRequest = request
        if let body = request.httpBody { Self.capturedBody = body }
        else if let stream = request.httpBodyStream {
            stream.open(); defer { stream.close() }
            var data = Data(); var buffer = [UInt8](repeating: 0, count: 1_024)
            while stream.hasBytesAvailable { let n = stream.read(&buffer, maxLength: buffer.count); if n <= 0 { break }; data.append(buffer, count: n) }
            Self.capturedBody = data
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Self.responseBody)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

final class MiniAppsTests: XCTestCase {
    private let frameId = "f-abc"

    private func call(_ app: [String: Any]) -> BridgeParse? {
        if case let .call(parse) = MiniAppBridge.message(["bosCanvas": frameId, "app": app], frameId: frameId) { return parse }
        return nil
    }

    // MARK: bridge

    func testParsesEachOpLikeTheDesktopTab() {
        XCTAssertEqual(call(["rid": 1, "op": "list", "collection": "contacts"]),
                       .request(BridgeRequest(rid: 1, op: .list, collection: "contacts")))
        XCTAssertEqual(call(["rid": 2, "op": "put", "collection": "contacts", "record": ["name": "Aina", "value": 4200, "hot": true]]),
                       .request(BridgeRequest(rid: 2, op: .put, collection: "contacts",
                                              record: ["name": .string("Aina"), "value": .number(4200), "hot": .bool(true)])))
        XCTAssertEqual(call(["rid": 3, "op": "patch", "collection": "contacts", "id": "c1", "fields": ["stage": "won"]]),
                       .request(BridgeRequest(rid: 3, op: .patch, collection: "contacts", id: "c1", fields: ["stage": .string("won")])))
        XCTAssertEqual(call(["rid": 4, "op": "remove", "collection": "contacts", "id": "c1"]),
                       .request(BridgeRequest(rid: 4, op: .remove, collection: "contacts", id: "c1")))
    }

    func testRefusesWhatTheDesktopRefuses() {
        XCTAssertEqual(call(["op": "list", "collection": "contacts"]), .invalid(rid: nil, error: "bad request id"))
        XCTAssertEqual(call(["rid": true, "op": "list", "collection": "contacts"]), .invalid(rid: nil, error: "bad request id"))
        XCTAssertEqual(call(["rid": 1.5, "op": "list", "collection": "contacts"]), .invalid(rid: nil, error: "bad request id"))
        XCTAssertEqual(call(["rid": 1, "op": "drop", "collection": "contacts"]), .invalid(rid: 1, error: "op must be one of list, get, put, patch, remove"))
        for bad in ["Contacts", "../x", "constructor", "", String(repeating: "a", count: 41)] {
            XCTAssertEqual(call(["rid": 1, "op": "list", "collection": bad]), .invalid(rid: 1, error: "collection must be a short lowercase name like contacts"), bad)
        }
        XCTAssertEqual(call(["rid": 1, "op": "get", "collection": "contacts"]), .invalid(rid: 1, error: "id must be 1-64 letters, digits, _ or -"))
        XCTAssertEqual(call(["rid": 1, "op": "get", "collection": "contacts", "id": "../../x"]), .invalid(rid: 1, error: "id must be 1-64 letters, digits, _ or -"))
        XCTAssertEqual(call(["rid": 1, "op": "put", "collection": "contacts", "record": [1, 2]]), .invalid(rid: 1, error: "put needs a record object"))
        XCTAssertEqual(call(["rid": 1, "op": "patch", "collection": "contacts", "id": "c1"]), .invalid(rid: 1, error: "patch needs a fields object"))
        let big = String(repeating: "x", count: 300 * 1024)
        XCTAssertEqual(call(["rid": 1, "op": "put", "collection": "notes", "record": ["text": big]]), .invalid(rid: 1, error: "a record can be at most 256 KB"))
    }

    func testDropsMessagesForAnotherFrame() {
        XCTAssertEqual(MiniAppBridge.message(["bosCanvas": "other", "app": ["rid": 1, "op": "list", "collection": "c"]], frameId: frameId), .ignore)
        XCTAssertEqual(MiniAppBridge.message(["app": ["rid": 1, "op": "list", "collection": "c"]], frameId: frameId), .ignore)
        XCTAssertEqual(MiniAppBridge.message("hello", frameId: frameId), .ignore)
        XCTAssertEqual(MiniAppBridge.message(["bosCanvas": frameId, "appHello": true], frameId: frameId), .hello)
    }

    func testWritesMapToTheDataRoute() {
        let put = BridgeRequest(rid: 1, op: .put, collection: "contacts", id: "c1", record: ["name": .string("Aina")])
        XCTAssertEqual(MiniAppBridge.writeOp(put), ["op": .string("put"), "collection": .string("contacts"), "id": .string("c1"), "record": .object(["name": .string("Aina")])])
        let remove = BridgeRequest(rid: 2, op: .remove, collection: "contacts", id: "c1")
        XCTAssertEqual(MiniAppBridge.writeOp(remove), ["op": .string("delete"), "collection": .string("contacts"), "id": .string("c1")])
        XCTAssertNil(MiniAppBridge.writeOp(BridgeRequest(rid: 3, op: .list, collection: "contacts")))
    }

    func testReplyScriptCannotBreakOutOfTheCall() {
        let script = MiniAppBridge.replyScript(frameId: frameId, rid: 7, result: .error("bad \"quote\"</script>\u{2028}"))
        XCTAssertTrue(script.hasPrefix("window.postMessage({"))
        XCTAssertTrue(script.hasSuffix("},\"*\");"))
        XCTAssertFalse(script.contains("\u{2028}"))
        XCTAssertTrue(script.contains(#""appReply":{"error":"bad \"quote\"</script>\u2028","ok":false,"rid":7}"#), script)
        XCTAssertTrue(script.contains(#""bosCanvas":"f-abc""#))
    }

    // MARK: links

    func testInstallLinks() {
        XCTAssertEqual(MiniApps.normalizeInstallURL("bosbot.my/a/crm"), "https://bosbot.my/a/crm")
        XCTAssertEqual(MiniApps.normalizeInstallURL("  https://bosbot.my/a/crm#x "), "https://bosbot.my/a/crm")
        XCTAssertNil(MiniApps.normalizeInstallURL("http://bosbot.my/a/crm"))
        XCTAssertNil(MiniApps.normalizeInstallURL("https://me:pw@bosbot.my/a/crm"))
        XCTAssertNil(MiniApps.normalizeInstallURL("javascript:alert(1)"))
        XCTAssertNil(MiniApps.normalizeInstallURL(""))
        XCTAssertEqual(MiniApps.installLink(in: "try this https://bosbot.my/a/crm it's good"), "https://bosbot.my/a/crm")
        XCTAssertEqual(MiniApps.installLink(in: "bosbot.my/a/tasks"), "https://bosbot.my/a/tasks")
        XCTAssertNil(MiniApps.installLink(in: "https://evil.example/a/crm"))
    }

    func testPermissionLineMatchesDesktop() {
        let line = MiniApps.permissionLine(collections: ["contacts": "", "deals": ""], botName: "cash")
        XCTAssertEqual(line.text, "keep its own contacts, deals")
        XCTAssertEqual(line.detail, "only this app's data. cash can read and change it too.")
        XCTAssertEqual(MiniApps.permissionLine(collections: [:], botName: "cash").text, "keep its own records")
    }

    // MARK: kit

    func testBundledKitPostsToTheNativeHandler() throws {
        let kit = try XCTUnwrap(MiniAppKit.bundled)
        XCTAssertTrue(kit.csp.hasPrefix("default-src 'none'"))
        XCTAssertTrue(kit.csp.contains("connect-src 'none'"))
        XCTAssertTrue(kit.bridge.contains("window.webkit.messageHandlers.bos.postMessage(m)"))
        XCTAssertFalse(kit.bridge.contains("parent.postMessage"))
        XCTAssertTrue(kit.bridgeScript(frameId: "f\"1").contains(#"var ID="f\"1""#))
        XCTAssertTrue(kit.noRtc.contains("RTCPeerConnection"))
    }

    func testDocumentPutsThePolicyFirst() {
        let kit = MiniAppKit(csp: "default-src 'none'", noRtc: "", kitCss: "body{}", bridge: "")
        let doc = kit.document(html: #"<!DOCTYPE html><head><meta http-equiv="Content-Security-Policy" content="default-src *"></head>"#)
        XCTAssertTrue(doc.hasPrefix(#"<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'">"#))
        XCTAssertEqual(doc.components(separatedBy: "<!doctype").count + doc.components(separatedBy: "<!DOCTYPE").count, 3)
    }

    // MARK: frames

    func testAppFrameDecodes() throws {
        let frame = try JSONDecoder().decode(StreamFrame.self, from: Data(#"{"kind":"app","seq":9,"appId":"a-3fzgbv2pw84z","botId":"b1","rev":4,"collections":["items"],"by":"cash"}"#.utf8))
        guard case let .app(change) = frame.frame else { return XCTFail("not an app frame") }
        XCTAssertEqual(change.appId, "a-3fzgbv2pw84z")
        XCTAssertEqual(change.collections, ["items"])
        XCTAssertNil(change.deleted)
        let bad = try JSONDecoder().decode(StreamFrame.self, from: Data(#"{"kind":"app","seq":10}"#.utf8))
        guard case .unknown = bad.frame else { return XCTFail("a broken app frame should be ignored") }
    }

    // MARK: offline copy

    func testCacheKeepsPagesAndRecordsInsideItsFolder() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("miniapps-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let cache = MiniAppCache(root: root)
        let app = AppSummary(id: "a-3fzgbv2pw84z", botId: "b1", name: "bos bot data", collections: ["items": 1])
        cache.savePage(AppPage(html: "<p>hi</p>", app: app))
        cache.saveRecords([.object(["id": .string("r1")])], appId: app.id, collection: "items")
        XCTAssertEqual(cache.page(app.id)?.html, "<p>hi</p>")
        XCTAssertEqual(cache.records(appId: app.id, collection: "items"), [.object(["id": .string("r1")])])

        cache.saveRecords([.null], appId: "../escape", collection: "items")
        cache.saveRecords([.null], appId: app.id, collection: "../../x")
        XCTAssertNil(cache.records(appId: "../escape", collection: "items"))
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.deletingLastPathComponent().appendingPathComponent("escape").path))
        cache.remove(app.id)
        XCTAssertNil(cache.page(app.id))
    }

    // MARK: client

    func testClientUsesTheOwnerRoutes() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [AppsRequestStub.self]
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        let client = CompanionClient(connection: Connection(name: "Test", host: "127.0.0.1", port: 8810), token: "t", session: session)

        AppsRequestStub.responseBody = Data(#"{"apps":[{"id":"a-3fzgbv2pw84z","botId":"b1","name":"bos bot data","updatedAt":1,"rev":2,"collections":{"items":3},"bytes":10},{"broken":true}]}"#.utf8)
        let apps = try await client.apps(botId: "b1")
        XCTAssertEqual(apps.map(\.name), ["bos bot data"])
        XCTAssertEqual(apps.first?.recordCount, 3)
        XCTAssertEqual(AppsRequestStub.capturedRequest?.url?.path, "/api/apps")
        XCTAssertEqual(AppsRequestStub.capturedRequest?.url?.query, "botId=b1")

        AppsRequestStub.responseBody = Data(#"{"records":[{"id":"r1","_at":1,"_by":"cash","title":"x"}],"rev":3}"#.utf8)
        let stored = try await client.appWrite(appId: "a-3fzgbv2pw84z", ops: [["op": .string("put"), "collection": .string("items"), "record": .object(["title": .string("x")])]])
        XCTAssertEqual(stored.first?["title"], .string("x"))
        XCTAssertEqual(AppsRequestStub.capturedRequest?.httpMethod, "POST")
        XCTAssertEqual(AppsRequestStub.capturedRequest?.url?.path, "/api/apps/a-3fzgbv2pw84z/data")
        let body = try JSONDecoder().decode(JSONValue.self, from: XCTUnwrap(AppsRequestStub.capturedBody))
        XCTAssertEqual(body["ops"]?.arrayValue?.first?["collection"], .string("items"))

        do { _ = try await client.appRecords(appId: "../../api/bots", collection: "items"); XCTFail("bad app id reached the network") }
        catch APIError.badURL {}
    }
}
