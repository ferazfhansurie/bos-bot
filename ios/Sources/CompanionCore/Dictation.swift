// Composer dictation, the half that has no microphone.
//
// The Speech session lives in the app target — it needs AVFoundation and a
// device. What lives here is the contract between that session and the text
// field, because that is where the decisions are and where they can be
// tested without a phone:
//
// - Partials *replace* each other after the text that was already in the
//   composer. They never stack. The desktop helper works the same way
//   (`src/components/Composer.tsx`): the base is frozen when the mic goes
//   on, and every transcript line is `base + " " + spoken`.
// - The recognizer's locale is the user's language, not a hardcoded
//   English. A French speaker talking to an en-US recognizer gets
//   nonsense, which is how this went wrong on the desktop the first time
//   (`electron/resources/speech-helper.swift`). Same candidate list here.
import Foundation

public enum Dictation {
    private static let maximumPreferredLanguages = 3

    /// Combine already-typed composer text with the current transcript.
    ///
    /// `base` is whatever was in the field when listening started, frozen
    /// for the session. Pass that every time, not the live draft — passing
    /// the live draft would append each partial onto the last one.
    public static func draft(base: String, transcript: String) -> String {
        let typed = base.trimmingCharacters(in: .whitespacesAndNewlines)
        let spoken = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        if spoken.isEmpty { return typed }
        if typed.isEmpty { return spoken }
        return "\(typed) \(spoken)"
    }

    /// Merge a new formatted partial into the accumulated transcript.
    ///
    /// One-shot form of `Transcript` for callers holding only a string: the
    /// whole of `current` is treated as the live segment.
    public static func updateTranscript(_ current: String, new: String) -> String {
        var transcript = Transcript(live: current)
        transcript.apply(new)
        return transcript.text
    }

    /// The spoken text for one dictation session: finished utterances plus
    /// the one still being recognized.
    ///
    /// A partial is only ever compared with the live utterance, never with
    /// everything said so far. Comparing with the whole transcript is what
    /// made the composer repeat itself: once one partial was appended (a
    /// recognizer turning "can you" into "can you?" was enough), every later
    /// partial shared no prefix with the accumulated text and was appended
    /// again, so the field filled with "can you can you? can you list ...".
    public struct Transcript: Equatable, Sendable {
        public private(set) var committed: [String] = []
        public private(set) var live = ""

        public init(live: String = "") {
            self.live = live.trimmingCharacters(in: .whitespacesAndNewlines)
        }

        public var text: String {
            (committed + [live]).filter { !$0.isEmpty }.joined(separator: " ")
        }

        /// Take the recognizer's latest reading of the live utterance.
        /// `endsUtterance` is the recognizer saying this utterance is done
        /// (on iOS, a result carrying `speechRecognitionMetadata`); the next
        /// partial then starts a new one.
        public mutating func apply(_ partial: String, endsUtterance: Bool = false) {
            let new = partial.trimmingCharacters(in: .whitespacesAndNewlines)
            if !new.isEmpty {
                if live.isEmpty, let last = committed.last, Dictation.startsWith(new, last) {
                    // The recognizer kept reporting from the start of the
                    // utterance we already committed: reopen it, don't repeat it.
                    committed.removeLast()
                    live = new
                } else if live.isEmpty || Dictation.revises(live, with: new) {
                    // A partial that is a shorter prefix of the live text is a
                    // momentary backtrack; keep the longer reading.
                    if !(Dictation.startsWith(live, new) && Dictation.words(new).count < Dictation.words(live).count) {
                        live = new
                    }
                } else {
                    committed.append(live)
                    live = new
                }
            }
            if endsUtterance, !live.isEmpty {
                committed.append(live)
                live = ""
            }
        }
    }

    /// Lowercased words with punctuation stripped, so "you?" and "You" match.
    static func words(_ text: String) -> [String] {
        text.split(whereSeparator: \.isWhitespace)
            .map { $0.lowercased().filter { $0.isLetter || $0.isNumber } }
            .filter { !$0.isEmpty }
    }

    static func startsWith(_ text: String, _ prefix: String) -> Bool {
        let t = words(text), p = words(prefix)
        return !p.isEmpty && t.count >= p.count && Array(t.prefix(p.count)) == p
    }

    /// Whether `new` is another reading of the same utterance as `current`:
    /// it extends it, backtracks within it, or revises some of its words.
    static func revises(_ current: String, with new: String) -> Bool {
        let a = words(current), b = words(new)
        if a.isEmpty || b.isEmpty { return true }
        let common = zip(a, b).prefix(while: { $0 == $1 }).count
        if common == min(a.count, b.count) { return true }
        if common * 2 >= a.count { return true }
        return common >= 1 && b.count >= a.count
    }

    /// Locales to try, in order. First available recognizer wins.
    ///
    /// Preferred languages, then the current locale, then en-US as a last
    /// resort so a device with no speech support for the user's language
    /// still has something to attempt rather than failing closed with no
    /// explanation.
    public static func localeCandidates(
        preferredLanguages: [String] = Locale.preferredLanguages,
        current: Locale = .current
    ) -> [Locale] {
        var seen = Set<String>()
        var result: [Locale] = []
        func add(_ locale: Locale) {
            // "en-US" and "en_US" are the same recognizer. Canonicalize so
            // the fallback does not add a duplicate of a locale we already
            // tried under a different identifier spelling.
            let key = canonicalIdentifier(locale)
            guard seen.insert(key).inserted else { return }
            result.append(locale)
        }
        for language in preferredLanguages.prefix(maximumPreferredLanguages) {
            add(Locale(identifier: language))
        }
        add(current)
        add(Locale(identifier: "en-US"))
        return result
    }

    /// Lowercased BCP-47 with underscores, so `en-US` and `en_US` collide.
    public static func canonicalIdentifier(_ locale: Locale) -> String {
        locale.identifier.lowercased().replacingOccurrences(of: "-", with: "_")
    }
}

extension Dictation {
    /// Recognition tasks have a duration limit. Late final words from the old
    /// task still belong before the new task, never after its first partial.
    public struct RecordingTranscript: Sendable {
        private var segments: [Int: Transcript] = [:]
        public init() {}
        public mutating func apply(segment: Int, text: String, endsUtterance: Bool = false) {
            var value = segments[segment] ?? Transcript()
            value.apply(text, endsUtterance: endsUtterance)
            segments[segment] = value
        }
        public var text: String {
            segments.keys.sorted().compactMap { segments[$0]?.text }.filter { !$0.isEmpty }.joined(separator: " ")
        }
    }
}
