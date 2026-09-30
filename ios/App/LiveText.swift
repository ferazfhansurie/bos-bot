// The reply being typed, one observable per thread.
//
// Streamed tokens arrive far faster than anything else the app shows, and
// they only ever matter to the chat that is open. Publishing them on the
// session's root state redrew every screen once per token of every running
// thread; here each thread has its own object, so a token redraws exactly
// the bubble watching that thread and nothing else.
import Combine
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

    /// Copy the state's live text into the per-thread objects, touching only
    /// the ones whose text actually changed.
    func sync(from state: CompanionState) {
        guard state.streaming != latest.streaming || state.reasoning != latest.reasoning else { return }
        latest = (state.streaming, state.reasoning)
        for (threadId, live) in entries {
            let text = state.streaming[threadId] ?? ""
            let reasoning = state.reasoning[threadId] ?? ""
            if live.text != text { live.text = text }
            if live.reasoning != reasoning { live.reasoning = reasoning }
        }
    }
}
