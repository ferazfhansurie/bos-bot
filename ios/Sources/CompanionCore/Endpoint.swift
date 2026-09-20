import Foundation

/// Why an address exists. The kind is display and policy metadata; the URL
/// remains the complete dialing authority, so hosted HTTPS and local HTTP can
/// live in the same fallback list without guessing a scheme from a hostname.
public enum CompanionEndpointKind: String, Codable, CaseIterable, Sendable {
    case hosted
    case tailnet
    case lan
    case bonjour
}

/// The credential-handling boundary for a route.
///
/// Hosted HTTPS is authenticated by Web PKI. A Tailscale MagicDNS name is
/// authenticated and encrypted by the tailnet even though the local URL is
/// HTTP. LAN and Bonjour routes are deliberately cleartext and therefore
/// require an exact, explicit choice by the user; they are never generic
/// automatic fallbacks for a bearer token or a one-time pairing credential.
public enum CompanionEndpointSecurityClass: Sendable {
    case protected
    case explicitLocal
}

/// One validated route to the desktop companion.
public struct CompanionEndpoint: Codable, Hashable, Sendable {
    public let url: String
    public let kind: CompanionEndpointKind
    public let priority: Int

    public init?(url: String, kind: CompanionEndpointKind, priority: Int) {
        guard (0...1_000_000).contains(priority),
              let normalized = Self.normalizedURL(url, kind: kind)
        else { return nil }
        self.url = normalized
        self.kind = kind
        self.priority = priority
    }

    public var baseURL: URL? { URL(string: url) }

    public var host: String {
        guard let host = URLComponents(string: url)?.host else { return "" }
        return Connection.urlHost(host)
    }

    public var port: Int {
        guard let components = URLComponents(string: url) else { return 0 }
        return components.port ?? (components.scheme?.lowercased() == "https" ? 443 : 80)
    }

    public var isSecure: Bool {
        URLComponents(string: url)?.scheme?.lowercased() == "https"
    }

    public var securityClass: CompanionEndpointSecurityClass {
        switch kind {
        case .hosted, .tailnet: return .protected
        case .lan, .bonjour: return .explicitLocal
        }
    }

    public var protectsCredentials: Bool { securityClass == .protected }

    /// Host-only for the old direct routes, full HTTPS authority for hosted
    /// routes. Used in status copy, never for dialing.
    public var displayAddress: String {
        if kind == .hosted || isSecure { return url }
        return port == 8810 ? host : "\(host):\(port)"
    }

    /// Construct the legacy HTTP route represented by `host` + `port`.
    public static func direct(
        host: String,
        port: Int,
        kind: CompanionEndpointKind? = nil,
        priority: Int
    ) -> CompanionEndpoint? {
        let resolvedKind = kind ?? inferredDirectKind(host)
        var components = URLComponents()
        components.scheme = "http"
        components.host = Connection.urlHost(host)
        components.port = port
        guard let value = components.url?.absoluteString else { return nil }
        return CompanionEndpoint(url: value, kind: resolvedKind, priority: priority)
    }

    /// Older saved connections only carry host strings. Recover the security
    /// class from names whose ownership has a useful transport meaning rather
    /// than treating a protected Tailscale name as arbitrary LAN cleartext.
    public static func inferredDirectKind(_ host: String) -> CompanionEndpointKind {
        let canonical = canonicalDNSHost(host)
        if validTailnetHost(canonical) { return .tailnet }
        if canonical.hasSuffix(".local") { return .bonjour }
        return .lan
    }

    /// The candidates a credential may walk automatically, in caller order.
    ///
    /// When the preferred route is protected, every cleartext candidate is
    /// removed. When it is local, that *one exact route* is the user's explicit
    /// choice and may be tried, followed only by routes which strengthen the
    /// transport. Other LAN/Bonjour addresses remain stored for display and a
    /// future manual choice, but never receive a token speculatively.
    public static func automaticCandidates(
        from candidates: [CompanionEndpoint]
    ) -> [CompanionEndpoint] {
        guard let preferred = candidates.first else { return [] }
        var seen = Set<String>()
        return candidates.filter { candidate in
            guard seen.insert(candidate.url).inserted else { return false }
            if preferred.protectsCredentials { return candidate.protectsCredentials }
            return candidate.url == preferred.url || candidate.protectsCredentials
        }
    }

    private static func normalizedURL(_ raw: String, kind: CompanionEndpointKind) -> String? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.utf8.count <= 2_048,
              var components = URLComponents(string: trimmed),
              let scheme = components.scheme?.lowercased(),
              scheme == "http" || scheme == "https",
              let host = components.host,
              !host.isEmpty,
              components.user == nil,
              components.password == nil,
              components.query == nil,
              components.fragment == nil,
              components.path.isEmpty || components.path == "/"
        else { return nil }

        switch kind {
        case .hosted:
            guard scheme == "https" else { return nil }
        case .tailnet:
            guard scheme == "http", validTailnetHost(canonicalDNSHost(host)) else { return nil }
        case .lan, .bonjour:
            guard scheme == "http" else { return nil }
        }

        components.scheme = scheme
        components.host = host.lowercased()
        components.path = ""
        if let port = components.port, !(1...65_535).contains(port) { return nil }
        return components.url?.absoluteString
    }

    private static func canonicalDNSHost(_ host: String) -> String {
        var canonical = host.lowercased()
        if canonical.hasPrefix("[") && canonical.hasSuffix("]") {
            canonical = String(canonical.dropFirst().dropLast())
        }
        while canonical.hasSuffix(".") { canonical.removeLast() }
        return canonical
    }

    private static func validTailnetHost(_ host: String) -> Bool {
        host.count > ".ts.net".count && host.hasSuffix(".ts.net")
    }

    private enum CodingKeys: String, CodingKey { case url, kind, priority }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        let url = try values.decode(String.self, forKey: .url)
        let kind = try values.decode(CompanionEndpointKind.self, forKey: .kind)
        let priority = try values.decode(Int.self, forKey: .priority)
        guard let accepted = CompanionEndpoint(url: url, kind: kind, priority: priority) else {
            throw DecodingError.dataCorruptedError(
                forKey: .url,
                in: values,
                debugDescription: "Companion endpoints must be absolute authorities; hosted routes require HTTPS and tailnet routes require an HTTP .ts.net name."
            )
        }
        self = accepted
    }
}

extension Connection {
    public var displayAddress: String {
        activeEndpoint?.displayAddress ?? "\(host):\(port)"
    }

    /// The normalized network origin a person must consent to before pairing.
    /// It deliberately contains no path, query, pairing code, or credential.
    public var pairingConsentOrigin: String {
        if let activeEndpoint { return activeEndpoint.url }

        var components = URLComponents()
        components.scheme = "http"
        components.host = Self.urlHost(host.lowercased())
        components.port = port
        return components.url?.absoluteString ?? "\(host.lowercased()):\(port)"
    }
}
