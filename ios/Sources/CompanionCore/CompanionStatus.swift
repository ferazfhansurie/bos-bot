import Foundation

/// What the Mac reports about being reached from outside the house: whether
/// its hosted route is up, and whether it is holding itself awake for the
/// phone. Read-only and advisory. Dialing authority stays with
/// `/api/companion/endpoints`, whose hosted route appears only after the
/// tunnel passes its public health check; the URL here is for display and
/// is never dialed.
///
/// Every field is optional on purpose. The desktop gains states on its own
/// schedule, and one this build has never heard of must degrade to
/// "unknown" rather than fail the whole response.
public struct CompanionStatus: Decodable, Sendable, Equatable {
    public enum HostedState: Equatable, Sendable {
        case off
        case provisioning
        case ready
        case error
        /// Missing, or a state newer than this build.
        case unknown

        init(raw: String?) {
            switch raw {
            case "off": self = .off
            case "provisioning": self = .provisioning
            case "ready": self = .ready
            case "error": self = .error
            default: self = .unknown
            }
        }
    }

    public struct Hosted: Decodable, Sendable, Equatable {
        public var state: HostedState
        /// Normalized HTTPS origin, or nil when absent or not a valid hosted
        /// URL. Display only.
        public var url: String?

        public init(state: HostedState, url: String? = nil) {
            self.state = state
            self.url = url.flatMap { CompanionEndpoint(url: $0, kind: .hosted, priority: 0)?.url }
        }

        private enum CodingKeys: String, CodingKey { case status, url }

        public init(from decoder: Decoder) throws {
            let values = try decoder.container(keyedBy: CodingKeys.self)
            self.init(
                state: HostedState(raw: try? values.decodeIfPresent(String.self, forKey: .status)),
                url: try? values.decodeIfPresent(String.self, forKey: .url)
            )
        }
    }

    public var hosted: Hosted?
    public var keepAwake: Bool?

    public init(hosted: Hosted? = nil, keepAwake: Bool? = nil) {
        self.hosted = hosted
        self.keepAwake = keepAwake
    }

    private enum CodingKeys: String, CodingKey { case hosted, keepAwake }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        hosted = (try? values.decodeIfPresent(Hosted.self, forKey: .hosted)) ?? nil
        keepAwake = (try? values.decodeIfPresent(Bool.self, forKey: .keepAwake)) ?? nil
    }

    /// The host of the hosted URL, short enough for a Settings row.
    public var hostedDisplayHost: String? {
        hosted?.url.flatMap { URLComponents(string: $0)?.host }
    }
}
