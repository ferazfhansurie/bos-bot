import Foundation

// The owner's bosbot.my dashboard, read through their own computer. The
// computer holds the data token and strips people's contact details; the
// phone gets numbers only. The site's json grows often, so it arrives as
// plain JSON and `SiteDataSummary` picks out what the screen shows. A field
// the site doesn't send stays nil and its row is left out, never zeroed.

public struct SiteDataAvailability: Decodable, Sendable, Equatable {
    public let available: Bool
}

public struct SiteDataResponse: Decodable, Sendable, Equatable {
    public let fetchedAt: Double?
    public let data: JSONValue
}

public struct SiteDataSummary: Sendable, Equatable {
    public struct Check: Sendable, Equatable, Identifiable {
        public let key: String
        public let label: String
        public let status: String
        public let value: String
        public let detail: String
        public var id: String { key }
        public var good: Bool { status == "good" || status == "off" }
    }

    public struct Tile: Sendable, Equatable {
        public let value: Double
        public let unit: String
        public let note: String
        public let spark: [Double]
    }

    public struct Ad: Sendable, Equatable, Identifiable {
        public let name: String
        public let status: String
        public let spendRM: Double?
        public let impressions: Double?
        public let clicks: Double?
        public let ctrPercent: Double?
        public let landingViews: Double?
        public let registrations: Double?
        public let signups: Double?
        public var id: String { name }
        public var live: Bool { status == "ACTIVE" }
    }

    public struct Budget: Sendable, Equatable {
        public let name: String?
        public let spentRM: Double
        public let capRM: Double
        public let dailyRM: Double?
        public var fraction: Double { capRM > 0 ? min(max(spentRM / capRM, 0), 1) : 0 }
        public var daysLeft: Double? {
            guard let dailyRM, dailyRM > 0 else { return nil }
            return max(capRM - spentRM, 0) / dailyRM
        }
    }

    public struct Step: Sendable, Equatable, Identifiable {
        public let label: String
        public let count: Double
        public var id: String { label }
    }

    public struct Source: Sendable, Equatable, Identifiable {
        public let name: String
        public let views: Double
        public let downloads: Double
        public let installs: Double
        public var id: String { name }
    }

    public struct Pair: Sendable, Equatable, Identifiable {
        public let label: String
        public let value: String
        public var id: String { label }
        public init(label: String, value: String) {
            self.label = label
            self.value = value
        }
    }

    public let generatedAt: Date?
    public let overall: String?
    public let checks: [Check]

    public let views24h: Double?
    public let story: String?

    public let visits: Tile?
    public let newPeople: Tile?
    public let firstMessage: Tile?
    public let usingBos: Tile?
    public let budget: Budget?

    public let funnel7d: [Step]
    public let funnel30d: [Step]
    public let sources7d: [Source]
    public let activation: [Step]

    public let ads: [Ad]

    public let desktop: [Pair]
    public let platforms: [Step]
    public let versions: [Step]

    public let free: [Pair]
    public let freeFunnel: [Step]

    public var healthy: Bool { overall == "good" }
    public var needsLook: [Check] { checks.filter { !$0.good } }

    public init(_ data: JSONValue) {
        func num(_ value: JSONValue?) -> Double? { value?.numberValue }
        func series(_ value: JSONValue?, last count: Int = 14) -> [Double] {
            Array((value?.arrayValue ?? []).compactMap(\.numberValue).suffix(count))
        }

        generatedAt = data["generated_at"]?.stringValue.flatMap(SiteDataSummary.date)
        let health = data["health"]
        overall = health?["overall"]?.stringValue
        checks = (health?["checks"]?.arrayValue ?? []).compactMap { check in
            guard let key = check["key"]?.stringValue else { return nil }
            let value: String
            switch check["value"] {
            case let .string(text)?: value = text
            case let .number(number)?: value = SiteDataSummary.count(number)
            default: value = ""
            }
            return Check(key: key, label: check["label"]?.stringValue ?? key,
                         status: check["status"]?.stringValue ?? "", value: value,
                         detail: check["detail"]?.stringValue ?? "")
        }

        let recent = data["acquisition"]?["recent"]
        let pulse = data["pulse"]
        let desktopData = data["desktop"]
        views24h = num(recent?["views_24h"])

        let signupCheck = health?["checks"]?.arrayValue?.first(where: { $0["key"]?.stringValue == "signups" })
        let signups24h = num(signupCheck?["value"]) ?? num(data["leads"]?["signups_24h"])
        var parts: [String] = []
        if let n = num(recent?["downloads_24h"]) { parts.append("\(SiteDataSummary.count(n)) downloaded") }
        if let n = signups24h { parts.append("\(SiteDataSummary.count(n)) signed up") }
        if let n = num(recent?["installs_24h"]) { parts.append("\(SiteDataSummary.count(n)) new install\(n == 1 ? "" : "s")") }
        var sentences: [String] = []
        if !parts.isEmpty { sentences.append(parts.joined(separator: ", ") + ".") }
        if let n = num(desktopData?["active_1d"]) {
            sentences.append("\(SiteDataSummary.count(n)) desktop user\(n == 1 ? "" : "s") active today.")
        }
        story = sentences.isEmpty ? nil : sentences.joined(separator: " ")

        if let views = views24h {
            let week = num(pulse?["views_7d"]).map { "\(SiteDataSummary.count($0)) this week" } ?? "last 24 hours"
            visits = Tile(value: views, unit: "", note: week, spark: series(data["acquisition"]?["daily"]?["views"]))
        } else { visits = nil }

        let webSignups = num(pulse?["web_signups_7d"])
        let installs7d = num(pulse?["installs_7d"])
        if webSignups != nil || installs7d != nil {
            let web = webSignups ?? 0, desk = installs7d ?? 0
            let webDaily = series(pulse?["web_signups_daily"]), deskDaily = series(data["acquisition"]?["daily"]?["installs"])
            let spark = webDaily.count == deskDaily.count ? zip(webDaily, deskDaily).map(+) : webDaily
            newPeople = Tile(value: web + desk, unit: "",
                             note: "\(SiteDataSummary.count(web)) web · \(SiteDataSummary.count(desk)) desktop", spark: spark)
        } else { newPeople = nil }

        if let messaged = num(pulse?["web_messaged_7d"]), let signups = webSignups {
            let share = signups > 0 ? Int((messaged / signups * 100).rounded()) : 0
            firstMessage = Tile(value: messaged, unit: "of \(SiteDataSummary.count(signups))",
                                note: "\(share)% of web sign-ups", spark: series(pulse?["first_msg_daily"]))
        } else { firstMessage = nil }

        if let people = num(desktopData?["people_1d"]) ?? num(desktopData?["active_1d"]) {
            var notes: [String] = []
            if let back = num(desktopData?["active_1d_returning"]) { notes.append("\(SiteDataSummary.count(back)) returning") }
            if let week = num(desktopData?["people_7d"]) { notes.append("\(SiteDataSummary.count(week)) this week") }
            usingBos = Tile(value: people, unit: "", note: notes.joined(separator: " · "), spark: series(desktopData?["daily_active"]))
        } else { usingBos = nil }

        let adsData = data["ads"]
        ads = (adsData?["ads"]?.arrayValue ?? []).compactMap { ad in
            guard let name = ad["name"]?.stringValue else { return nil }
            return Ad(name: name, status: ad["status"]?.stringValue ?? "", spendRM: num(ad["spend_rm"]),
                      impressions: num(ad["impressions"]), clicks: num(ad["link_clicks"]), ctrPercent: num(ad["ctr_pct"]),
                      landingViews: num(ad["landing_views"]), registrations: num(ad["registrations"]), signups: num(ad["our_signups"]))
        }
        if let spent = num(adsData?["spent_rm"]), let cap = num(adsData?["cap_rm"]) {
            budget = Budget(name: ads.first(where: \.live)?.name, spentRM: spent, capRM: cap, dailyRM: num(adsData?["daily_rm"]))
        } else { budget = nil }

        func funnel(_ value: JSONValue?) -> [Step] {
            let labels = [("views", "visits"), ("human_downloads", "downloads"), ("real_new_installs", "new installs"), ("returning", "came back")]
            return labels.compactMap { key, label in num(value?[key]).map { Step(label: label, count: $0) } }
        }
        funnel7d = funnel(data["acquisition"]?["7d"]?["funnel"])
        funnel30d = funnel(data["acquisition"]?["30d"]?["funnel"])
        sources7d = (data["acquisition"]?["7d"]?["sources"]?.arrayValue ?? []).compactMap { source in
            guard let name = source["source"]?.stringValue else { return nil }
            return Source(name: name, views: num(source["views"]) ?? 0, downloads: num(source["downloads"]) ?? 0, installs: num(source["installs"]) ?? 0)
        }
        let stages = data["activation"]?["stages"]
        activation = [("install", "installed"), ("engine_connected", "engine connected"), ("first_message", "first message"), ("first_job_done", "first job done")]
            .compactMap { key, label in num(stages?[key]).map { Step(label: label, count: $0) } }

        var desk: [Pair] = []
        for (key, label) in [("active_1d", "active today"), ("active_7d", "active this week"), ("active_30d", "active this month"),
                             ("returning_total", "came back"), ("people_total", "people, all time")] {
            if let n = num(desktopData?[key]) { desk.append(Pair(label: label, value: SiteDataSummary.count(n))) }
        }
        if let latest = desktopData?["latest"]?["darwin"]?.stringValue ?? desktopData?["latest"]?.stringValue {
            desk.append(Pair(label: "latest mac build", value: latest))
        }
        desktop = desk
        platforms = [("darwin", "mac"), ("win32", "windows"), ("linux", "linux")].compactMap { key, label in
            num(desktopData?["platform_30d"]?[key]).map { Step(label: label, count: $0) }
        }
        versions = (desktopData?["versions_30d"]?.arrayValue ?? []).compactMap { row in
            guard let pair = row.arrayValue, pair.count == 2, let name = pair[0].stringValue, let n = pair[1].numberValue else { return nil }
            return Step(label: name, count: n)
        }

        let freeData = data["free"]
        let engine = data["engine"]
        var freeRows: [Pair] = []
        for (key, label) in [("signups", "signed up"), ("workspaces_ready", "workspace ready"), ("active_7d", "active this week")] {
            if let n = num(freeData?[key]?["outside"]) { freeRows.append(Pair(label: label, value: SiteDataSummary.count(n))) }
        }
        if let vms = num(freeData?["fleet"]?["vms"]), let max = num(freeData?["fleet"]?["max"]) {
            freeRows.append(Pair(label: "free vms", value: "\(SiteDataSummary.count(vms)) of \(SiteDataSummary.count(max))"))
        }
        if let used = num(engine?["month_usd"]), let cap = num(engine?["monthly_cap_usd"]) {
            freeRows.append(Pair(label: "free engine this month", value: "$\(SiteDataSummary.money(used)) of $\(SiteDataSummary.count(cap))"))
        }
        if let people = num(engine?["people_used"]) ?? num(engine?["people"]) {
            freeRows.append(Pair(label: "people on the free engine", value: SiteDataSummary.count(people)))
        }
        free = freeRows
        let stepNames = ["free_landing": "landed", "signup_started": "started sign-up", "code_sent": "code sent",
                         "first_message": "first message", "first_job_done": "first job done"]
        freeFunnel = (freeData?["funnel_30d"]?.arrayValue ?? []).compactMap { row in
            guard let step = row["step"]?.stringValue, let n = row["n"]?.numberValue else { return nil }
            return Step(label: stepNames[step] ?? step.replacingOccurrences(of: "_", with: " "), count: n)
        }
    }

    /// The pill at the top: one plain line about what needs a look.
    public var statusLine: String {
        guard overall != nil else { return "no health check" }
        if healthy || needsLook.isEmpty { return "everything is running" }
        if needsLook.count == 1 { return "\(needsLook[0].label) needs a look" }
        return "\(needsLook.count) things need a look"
    }

    public static func count(_ value: Double) -> String {
        if value.rounded() == value, abs(value) < 1e15 {
            let formatter = NumberFormatter()
            formatter.numberStyle = .decimal
            formatter.locale = Locale(identifier: "en_US")
            return formatter.string(from: NSNumber(value: Int64(value))) ?? String(Int64(value))
        }
        return String(format: "%.1f", value)
    }

    public static func money(_ value: Double) -> String {
        String(format: "%.2f", value)
    }

    static func date(_ text: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        if let date = formatter.date(from: text) { return date }
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: text)
    }
}
