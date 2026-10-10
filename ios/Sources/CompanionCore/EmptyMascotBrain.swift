// The empty thread's mascot: what it feels and what it says.
//
// The creature itself (springs, gestures, drawing) lives in the app
// (`EmptyThreadMascot`). This is the part with no frames in it — which face a
// mood wears, how a draft being typed reads, when an idle mascot gets drowsy,
// the hour's mood, and the one line under it — so it can be tested without a
// simulator.
//
// Faces extend the glyph table (`GlyphFaces`) rather than replace it: the
// eight shared states keep their desktop faces, and the moods only the empty
// thread needs (dizzy, purr, pose, asleep...) add their own glyphs here, in the
// same 24 box and the same M/L/C/Z path language.
import CoreGraphics
import Foundation

public enum MascotMood: String, CaseIterable, Sendable {
    case idle, listening, thinking, scared, alert, happy, nodding, suspicious
    case drowsy, asleep, surprised, dizzy, purr, pose, yawn, excited, late
}

/// A mood's face: two eyes and an accent beside the body. There is no mouth,
/// ever: the eyes, the lids and the body say all of it. Glyph ids resolve
/// through `EmptyMascotBrain.path`.
public struct MascotMoodFace: Equatable, Sendable {
    public let left: String
    public let right: String
    public let accent: String?
    public let anchor: GlyphAccentAnchor?
}

/// How the draft being typed reads to the mascot.
public enum DraftReaction: Equatable, Sendable {
    case none, listening, scared, alert, happy, nodding
}

/// Awake, drowsy at 30s with nothing happening, asleep at 90s.
public enum MascotRest: Equatable, Sendable {
    case awake, drowsy, asleep
}

/// The hour's mood, read once when the mascot arrives.
public struct MascotDayMood: Equatable, Sendable {
    public var morning = false
    public var late = false
    public var friday = false
    public init(morning: Bool = false, late: Bool = false, friday: Bool = false) {
        self.morning = morning
        self.late = late
        self.friday = friday
    }
}

public enum EmptyMascotBrain {
    // MARK: - Faces

    /// The glyphs the shared table does not have. 24 box, absolute M/L/C/Z.
    static let extraPaths: [String: String] = [
        // open eye, a touch smaller than `ring` so the idle face reads soft
        "open": "M12 7C14.76 7 17 9.24 17 12C17 14.76 14.76 17 12 17C9.24 17 7 14.76 7 12C7 9.24 9.24 7 12 7Z",
        // scared: wide ring with a pin pupil
        "wide": "M12 4C16.42 4 20 7.58 20 12C20 16.42 16.42 20 12 20C7.58 20 4 16.42 4 12C4 7.58 7.58 4 12 4ZM11.9 12L12.1 12",
        // closed happy eye, ^
        "arc": "M5 15C7.2 8.5 16.8 8.5 19 15",
        // closed sleeping eye, u
        "lid": "M5 10C7.2 16.5 16.8 16.5 19 10",
        // heavy lid: flat top, half an eye below
        "half": "M4.5 11L19.5 11M6.5 11C6.5 14.8 9 17 12 17C15 17 17.5 14.8 17.5 11",
        // suspicious squint, each eye sloping in
        "squintL": "M5 10.5L19 13.5",
        "squintR": "M5 13.5L19 10.5",
        // dizzy spiral
        "spiral": "M12 12C12 11 13.1 10.6 13.8 11.3C14.7 12.2 14.1 13.9 12.7 14.3C10.9 14.8 9.3 13.4 9.3 11.6C9.3 9.4 11.3 7.9 13.4 8.2C16.1 8.6 17.6 11.1 17.1 13.6C16.5 16.6 13.4 18.3 10.5 17.6C7.2 16.8 5.4 13.4 6.2 10.2",
        // accents
        "zz": "M3 4.5L9 4.5L3 10.5L9 10.5M13 12.5L19 12.5L13 18.5L19 18.5",
        "moon": "M15.5 3.8C11.4 4.6 8.4 8 8.4 12C8.4 16 11.4 19.4 15.5 20.2C10.6 21.6 4.5 18 4.5 12C4.5 6 10.6 2.4 15.5 3.8Z",
        "sweat": "M12 4C12 4 7.5 10 7.5 13.5C7.5 16 9.5 18 12 18C14.5 18 16.5 16 16.5 13.5C16.5 10 12 4 12 4Z",
    ]

    private static let parsedExtras: [String: CGPath] = extraPaths.mapValues(GlyphFaces.parsePath)

    /// A glyph from this file or the shared table; unknown is an empty path.
    public static func path(_ id: String) -> CGPath {
        parsedExtras[id] ?? GlyphFaces.path(id)
    }

    public static func face(_ mood: MascotMood) -> MascotMoodFace {
        switch mood {
        case .idle: MascotMoodFace(left: "dash", right: "dash", accent: nil, anchor: nil)
        case .listening: MascotMoodFace(left: "dash", right: "dash", accent: nil, anchor: nil)
        case .thinking: shared(.thinking)
        case .scared: MascotMoodFace(left: "wide", right: "wide", accent: "sweat", anchor: .topRight)
        case .alert: shared(.waiting)
        case .happy: MascotMoodFace(left: "arc", right: "arc", accent: "heart", anchor: .topRight)
        case .nodding: MascotMoodFace(left: "arc", right: "arc", accent: nil, anchor: nil)
        case .suspicious: MascotMoodFace(left: "squintL", right: "squintR", accent: "query", anchor: .left)
        case .drowsy: MascotMoodFace(left: "half", right: "half", accent: nil, anchor: nil)
        case .asleep: MascotMoodFace(left: "lid", right: "lid", accent: "zz", anchor: .topRight)
        case .surprised: MascotMoodFace(left: "wide", right: "wide", accent: "bang", anchor: .left)
        case .dizzy: MascotMoodFace(left: "spiral", right: "spiral", accent: "star", anchor: .topRight)
        case .purr: MascotMoodFace(left: "arc", right: "arc", accent: "heart", anchor: .topRight)
        case .pose: MascotMoodFace(left: "arc", right: "star", accent: "spark", anchor: .split)
        case .yawn: MascotMoodFace(left: "lid", right: "lid", accent: nil, anchor: nil)
        case .excited: MascotMoodFace(left: "star", right: "star", accent: "spark", anchor: .split)
        case .late: MascotMoodFace(left: "half", right: "half", accent: "moon", anchor: .topRight)
        }
    }

    private static func shared(_ state: GlyphFaceState) -> MascotMoodFace {
        let face = GlyphFaces.face(state)
        return MascotMoodFace(left: face.left, right: face.right, accent: face.accent, anchor: face.anchor)
    }

    // MARK: - The draft

    private static let scaredWords: Set<String> = [
        "bug", "bugs", "buggy", "broken", "broke", "breaks", "error", "errors", "crash", "crashed", "crashes",
        "crashing", "fail", "failed", "failing", "fails", "failure", "outage", "rosak",
    ]
    private static let alertWords: Set<String> = ["urgent", "urgently", "asap", "emergency", "hurry"]
    private static let thanksWords: Set<String> = ["thanks", "thank", "thx", "ty", "tysm", "appreciate", "appreciated", "terima", "tq"]

    /// How a draft reads. Scared beats alert beats thanks beats a long rant;
    /// an empty draft in a focused composer is the mascot listening.
    public static func reaction(to draft: String, focused: Bool) -> DraftReaction {
        let lowered = draft.lowercased()
        let words = Set(lowered.split(whereSeparator: { !$0.isLetter }).map(String.init))
        if !words.isDisjoint(with: scaredWords) || lowered.contains("not working") { return .scared }
        if !words.isDisjoint(with: alertWords) { return .alert }
        if !words.isDisjoint(with: thanksWords) { return .happy }
        if draft.count > 180 { return .nodding }
        if focused || !draft.isEmpty { return .listening }
        return .none
    }

    /// A big cut in one go — select-all-delete, or a held backspace through
    /// most of a sentence. The mascot gets suspicious.
    public static func isHeavyDelete(from previous: String, to current: String) -> Bool {
        previous.count >= 16 && previous.count - current.count >= max(12, previous.count / 2)
    }

    // MARK: - Rest

    public static let drowsyAfter: TimeInterval = 30
    public static let asleepAfter: TimeInterval = 90

    public static func rest(idleFor seconds: TimeInterval) -> MascotRest {
        seconds >= asleepAfter ? .asleep : seconds >= drowsyAfter ? .drowsy : .awake
    }

    /// The next idle glance, 5 to 8 seconds out. `unit` is a 0...1 roll.
    public static func nextGlance(after time: TimeInterval, unit: Double) -> TimeInterval {
        time + 5 + 3 * min(max(unit, 0), 1)
    }

    // MARK: - The hour

    public static func dayMood(at date: Date, calendar: Calendar = .current) -> MascotDayMood {
        let hour = calendar.component(.hour, from: date)
        let weekday = calendar.component(.weekday, from: date)
        return MascotDayMood(morning: (5..<10).contains(hour), late: (0..<5).contains(hour), friday: weekday == 6)
    }

    // MARK: - Lines

    public enum Moment: Equatable, Sendable {
        case arrive(MascotDayMood)
        case listening, scared, alert, thanks, nodding, suspicious
        case drowsy, asleep, woke, tapped, dizzy, purr, pose, shaken, voice
        case unread(Int)
        case cameo(String)
    }

    /// The line under the mascot. `seed` picks among a moment's variants so
    /// a thread keeps its line instead of reshuffling on every redraw.
    public static func line(_ moment: Moment, seed: Int) -> String {
        let options: [String]
        switch moment {
        case let .arrive(day):
            if day.late { options = ["still up? me too", "late one. what do you need", "quiet hours. what's up"] }
            else if day.friday { options = ["it's friday. what's left", "friday. let's close something", "last push of the week. go"] }
            else if day.morning { options = ["morning. what are we doing today", "coffee first, then tell me", "morning. i'm up"] }
            else { options = ["what's on your mind", "fresh thread. go", "i'm here. what are we doing", "new page. what's first"] }
        case .listening: options = ["listening", "go on", "i'm all ears"]
        case .scared: options = ["uh oh. what broke", "okay. show me the damage", "oh no. tell me"]
        case .alert: options = ["on it. go", "say the word", "ready"]
        case .thanks: options = ["anytime", "always", "that's what i'm here for"]
        case .nodding: options = ["mhm. keep going", "yep. i'm with you", "go on, i'm reading"]
        case .suspicious: options = ["changed your mind?", "hm. that got deleted fast", "having second thoughts?"]
        case .drowsy: options = ["still here", "take your time"]
        case .asleep: options = ["zz. tap me", "napping. poke me"]
        case .woke: options = ["huh. i'm up", "oh hi. i'm up"]
        case .tapped: options = ["hi", "that tickles", "yes?", "boop"]
        case .dizzy: options = ["whoa. room's spinning", "ow. okay. okay", "which way is up"]
        case .purr: options = ["oh that's nice", "don't stop", "more of that"]
        case .pose: options = ["got my good side?", "send me that one", "framed it?"]
        case .shaken: options = ["hey. easy", "whoa whoa whoa", "i'm awake i'm awake"]
        case .voice: options = ["i'm listening", "go ahead, talking works"]
        case let .unread(count): options = [count == 1 ? "one waiting for you back there" : "\(count) waiting for you back there"]
        case let .cameo(name): options = ["oh hi \(name.lowercased())", "\(name.lowercased()) is checking on us", "hey \(name.lowercased())"]
        }
        return options[((seed % options.count) + options.count) % options.count]
    }

    /// A stable seed for a thread: the same thread gets the same lines.
    public static func seed(_ text: String) -> Int {
        text.unicodeScalars.reduce(5381) { ($0 &* 33 &+ Int($1.value)) & 0x7fff_ffff }
    }
}
