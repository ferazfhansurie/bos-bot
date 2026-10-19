import XCTest
@testable import CompanionCore
final class RequestContinuationTests: XCTestCase {
    func testExactRequestIdentifiersAndNoCredentials() throws {
        let link = try XCTUnwrap(RequestContinuation(url: URL(string: "bosbot://request?home=home-a&bot=bot-a&thread=thread-b&message=message-c&request=request-d")!))
        XCTAssertEqual(link.home, "home-a")
        XCTAssertEqual(link.threadId, "thread-b")
        XCTAssertEqual(link.requestId, "request-d")
        for raw in [
            "bosbot://request?home=a&bot=b&thread=c&message=d&request=e&token=secret",
            "bosbot://request?home=a&bot=b&thread=c&message=d&request=e&request=f",
            "bosbot://request?home=a&bot=b&thread=c&message=d",
            "bosbot://request?home=a&bot=b&thread=c&message=d&request=..%2Fprivate",
            "https://request?home=a&bot=b&thread=c&message=d&request=e"
        ] { XCTAssertNil(RequestContinuation(url: URL(string: raw)!)) }
    }
}
