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

    /// Whether someone is typing in a composer. Each step of a streaming
    /// bubble re-measures the whole transcript above it on the main thread,
    /// and at the frame rate that crowds out keystrokes. While a draft is
    /// open the bubble steps a few times a second instead; the text it shows
    /// is the same, only coarser.
    var composing = false {
        didSet { if !composing, oldValue { publish() } }
    }
    private static let composingInterval: Duration = .milliseconds(250)
    private var lastPublish: ContinuousClock.Instant?
    private var pendingPublish: Task<Void, Never>?

    /// Copy the state's live text into the per-thread objects, touching only
    /// the ones whose text actually changed.
    func sync(from state: CompanionState) {
        guard state.streaming != latest.streaming || state.reasoning != latest.reasoning else { return }
        let endedAt = Date()
        for (key, text) in latest.streaming where !text.isEmpty && (state.streaming[key] ?? "").isEmpty {
            streamEnded[key] = endedAt
        }
        let finished = state.streaming.count < latest.streaming.count
            || state.reasoning.count < latest.reasoning.count
        latest = (state.streaming, state.reasoning)
        // A reply that ended (or a thread cleared) lands at once, so the
        // bubble never lingers behind the message that replaced it.
        guard composing, !finished else { publish(); return }
        guard pendingPublish == nil else { return }
        let now = ContinuousClock.now
        guard let last = lastPublish, now - last < Self.composingInterval else { publish(); return }
        pendingPublish = Task { [weak self] in
            try? await Task.sleep(until: last + Self.composingInterval, clock: .continuous)
            guard !Task.isCancelled else { return }
            self?.publish()
        }
    }

    private func publish() {
        pendingPublish?.cancel()
        pendingPublish = nil
        lastPublish = .now
        for (threadId, live) in entries {
            let text = latest.streaming[threadId] ?? ""
            let reasoning = latest.reasoning[threadId] ?? ""
            if live.text != text { live.text = text }
            if live.reasoning != reasoning { live.reasoning = reasoning }
        }
    }
}
