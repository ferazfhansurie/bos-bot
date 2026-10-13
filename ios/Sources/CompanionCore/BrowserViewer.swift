import Foundation

public struct BrowserViewerTab: Codable, Equatable, Identifiable, Sendable {
    public var tabId: String
    public var title: String
    public var url: String
    public var active: Bool
    public var id: String { tabId }
}

public struct BrowserViewerPayload: Decodable, Sendable {
    public struct Metadata: Decodable, Sendable {
        public var deviceWidth: Int
        public var deviceHeight: Int
    }
    public var viewerId: String?
    public var seq: Int?
    public var data: String?
    public var metadata: Metadata?
    public var tabs: [BrowserViewerTab]?
    public var url: String?
    public var connected: Bool?
    public var held: Bool?
    public var controlling: Bool?
    public var owned: Bool?
    public var message: String?
    public var retryable: Bool?
}

public struct BrowserViewerEvent: Sendable {
    public let name: String
    public let payload: BrowserViewerPayload
    public static func decode(_ event: SSEEvent) throws -> BrowserViewerEvent {
        let supported = ["ready", "frame", "tabs", "url", "status", "control", "heartbeat", "error"]
        guard let name = event.name, supported.contains(name), let data = event.data.data(using: .utf8), data.count <= 4 * 1024 * 1024 else {
            throw APIError.transport("The browser sent an invalid update.")
        }
        let payload = try JSONDecoder().decode(BrowserViewerPayload.self, from: data)
        if name == "frame" {
            guard let seq = payload.seq, seq > 0, let image = payload.data, image.utf8.count <= 3 * 1024 * 1024,
                  let size = payload.metadata, (1...8192).contains(size.deviceWidth), (1...8192).contains(size.deviceHeight),
                  size.deviceWidth * size.deviceHeight <= 16_777_216 else { throw APIError.transport("The browser sent an invalid frame.") }
        }
        return BrowserViewerEvent(name: name, payload: payload)
    }
}

public enum BrowserViewerAction: Sendable {
    case take, release, back, forward, reload, restart
    case acknowledge(Int), selectTab(String), closeTab(String), newTab
    case navigate(String), text(String), enter
    case tap(seq: Int, x: Double, y: Double)
    case scroll(seq: Int, x: Double, y: Double, deltaX: Double, deltaY: Double)
    var body: [String: Any] {
        switch self {
        case .take: ["type": "take"]
        case .release: ["type": "release"]
        case .back: ["type": "back"]
        case .forward: ["type": "forward"]
        case .reload: ["type": "reload"]
        case .restart: ["type": "restart"]
        case let .acknowledge(seq): ["type": "ack", "seq": seq]
        case let .selectTab(id): ["type": "tab-select", "tabId": id]
        case let .closeTab(id): ["type": "tab-close", "tabId": id]
        case .newTab: ["type": "tab-new"]
        case let .navigate(url): ["type": "navigate", "url": url]
        case let .text(text): ["type": "input_keyboard", "eventType": "char", "text": text]
        case let .tap(seq, x, y): ["type": "tap", "seq": seq, "x": x, "y": y]
        case let .scroll(seq, x, y, dx, dy): ["type": "input_mouse", "eventType": "mouseWheel", "frameSeq": seq, "x": x, "y": y, "deltaX": dx, "deltaY": dy]
        case .enter: ["type": "input_keyboard", "eventType": "keyDown", "key": "Enter"]
        }
    }
}

/// ACK-paced frames keep the wire bounded. Cancel tears down observation and
/// its server-owned lease; neither reconnection nor this client replays actions.
public func browserViewerStream(request: URLRequest, session: URLSession) -> AsyncThrowingStream<BrowserViewerEvent, Error> {
    AsyncThrowingStream { continuation in
        let task = Task.detached(priority: .userInitiated) {
            do {
                let (bytes, response) = try await session.bytes(for: request)
                if let http = response as? HTTPURLResponse, http.statusCode != 200 {
                    throw APIError.status(code: http.statusCode, message: http.statusCode == 403 ? "Enable computer access for this device in BOS settings." : nil)
                }
                var parser = SSEParser()
                var bufferedBytes = 0
                var line = [UInt8]()
                // AsyncBytes.lines drops blank lines. SSE requires every one.
                for try await byte in bytes {
                    if byte == 10 {
                        try Task.checkCancellation()
                        let text = String(decoding: line, as: UTF8.self)
                        bufferedBytes += line.count
                        if let event = parser.line(text) { continuation.yield(try BrowserViewerEvent.decode(event)) }
                        if text.isEmpty || text == "\r" { bufferedBytes = 0 }
                        line.removeAll(keepingCapacity: true)
                    } else {
                        line.append(byte)
                        guard line.count + bufferedBytes <= 4 * 1024 * 1024 else { throw APIError.transport("Browser update exceeded its size limit.") }
                    }
                }
                continuation.finish(throwing: APIError.transport("The browser connection ended."))
            } catch { continuation.finish(throwing: error) }
        }
        continuation.onTermination = { @Sendable _ in task.cancel() }
    }
}
