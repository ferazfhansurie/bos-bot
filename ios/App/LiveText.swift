// The reply being typed, one observable per thread.
//
// Streamed tokens arrive far faster than anything else the app shows, and
// they only ever matter to the chat that is open. Publishing them on the
// session's root state redrew every screen once per token of every running
// thread; here each thread has its own object, so a token redraws exactly
// the bubble watching that thread and nothing else.
import Combine
import Foundation
import CompanionCore

@MainActor
final class LiveText: ObservableObject {
    @Published fileprivate(set) var text = ""
    @Published fileprivate(set) var reasoning = ""
}

@MainActor
final class LiveTextStore {
    private var entries: [String: LiveText] = [:]

    func entry(_ threadId: String) -> LiveText {
        if let existing = entries[threadId] { return existing }
        let created = LiveText()
        created.text = latest.streaming[threadId] ?? ""
        created.reasoning = latest.reasoning[threadId] ?? ""
        entries[threadId] = created
        return created
    }

    private var latest = (streaming: [String: String](), reasoning: [String: String]())
    private var streamEnded: [String: Date] = [:]

    /// The reply typed under `key` just became a saved message. That message
    /// is already on screen as the stream was, so it should not arrive again.
    func streamEndedRecently(_ key: String, within seconds: TimeInterval = 2) -> Bool {
        streamEnded[key].map { Date().timeIntervalSince($0) < seconds } ?? false
    }

    /// Copy the state's live text into the per-thread objects, touching only
    /// the ones whose text actually changed.
    func sync(from state: CompanionState) {
        guard state.streaming != latest.streaming || state.reasoning != latest.reasoning else { return }
        let now = Date()
        for (key, text) in latest.streaming where !text.isEmpty && (state.streaming[key] ?? "").isEmpty {
            streamEnded[key] = now
        }
        latest = (state.streaming, state.reasoning)
        for (threadId, live) in entries {
            let text = state.streaming[threadId] ?? ""
            let reasoning = state.reasoning[threadId] ?? ""
            if live.text != text { live.text = text }
            if live.reasoning != reasoning { live.reasoning = reasoning }
        }
    }
}
