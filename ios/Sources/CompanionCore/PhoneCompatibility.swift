import Foundation

/// Read this tiny envelope before decoding the rest of a newer server's API.
/// Keep missing/invalid floors compatible with servers predating the contract.
public struct PhoneUpdateRequired: LocalizedError, Equatable, Sendable {
    public let minimumVersion: String
    public let url: URL

    public var errorDescription: String? {
        "Update the app. This server needs BOS \(minimumVersion) or later on your phone."
    }

    public static func check(data: Data, phoneVersion: String?) -> PhoneUpdateRequired? {
        guard let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let minimum = body["minPhoneVersion"] as? String,
              let floor = versionParts(minimum),
              let phoneVersion, let current = versionParts(phoneVersion),
              current.lexicographicallyPrecedes(floor)
        else { return nil }
        let links = body["phoneUpdateUrls"] as? [String: Any]
        let candidate = (links?["ios"] as? String).flatMap(URL.init(string:))
        let safeURL = candidate.flatMap { url -> URL? in
            guard url.scheme?.lowercased() == "https", let host = url.host, !host.isEmpty,
                  url.user == nil, url.password == nil else { return nil }
            return url
        }
        return PhoneUpdateRequired(minimumVersion: minimum, url: safeURL ?? URL(string: "https://bosbot.my/get")!)
    }

    private static func versionParts(_ version: String) -> [Int]? {
        let parts = version.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 3 else { return nil }
        let numbers = parts.compactMap { part -> Int? in
            guard !part.isEmpty, part.utf8.allSatisfy({ (48...57).contains($0) }) else { return nil }
            return Int(part)
        }
        return numbers.count == 3 ? numbers : nil
    }
}
