// The "voice chat" card a v3 computer writes after a call: how long it ran,
// what it was about, the jobs it started (each opens its thread), the
// transcript folded away, and good / bad (event `rating`).
import CompanionCore
import SwiftUI

struct VoiceChatCardView: View {
    let card: VoiceCallCard
    var openThread: ((ThreadRef) -> Void)? = nil
    @Environment(\.sessionActions) private var sessionActions
    @State private var rating: VoiceCallCard.Rating?
    @State private var showingTranscript = false

    init(card: VoiceCallCard, openThread: ((ThreadRef) -> Void)? = nil) {
        self.card = card
        self.openThread = openThread
        _rating = State(initialValue: card.rating)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("voice chat · \(RealtimeVoice.formatDuration(card.seconds))", systemImage: "phone.fill")
                .font(.subheadline.weight(.semibold))
            if let summary = card.summary?.trimmingCharacters(in: .whitespacesAndNewlines), !summary.isEmpty {
                Text(summary)
                    .font(.subheadline)
                    .lineLimit(2)
            }
            if !card.jobs.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(card.jobs) { job in jobRow(job) }
                }
            }
            if !card.transcript.isEmpty {
                Button {
                    withAnimation(.easeOut(duration: 0.2)) { showingTranscript.toggle() }
                } label: {
                    Label("transcript", systemImage: showingTranscript ? "chevron.down" : "chevron.right")
                        .font(.footnote.weight(.medium))
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
                if showingTranscript {
                    VStack(alignment: .leading, spacing: 4) {
                        ForEach(Array(card.transcript.enumerated()), id: \.offset) { _, line in
                            Text("\(line.role == .user ? "you" : "bot"): \(line.text)")
                                .font(.footnote)
                                .foregroundStyle(line.role == .user ? .primary : .secondary)
                                .textSelection(.enabled)
                        }
                    }
                }
            }
            HStack(spacing: 8) {
                rateButton(.good, "hand.thumbsup")
                rateButton(.bad, "hand.thumbsdown")
            }
        }
        .padding(12)
        .frame(maxWidth: 320, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(Color.primary.opacity(0.06)))
    }

    @ViewBuilder
    private func jobRow(_ job: VoiceCallCard.Job) -> some View {
        let label = HStack(alignment: .firstTextBaseline, spacing: 6) {
            Image(systemName: Self.symbol(job.status))
                .font(.caption)
                .foregroundStyle(job.status == .failed ? .red : .secondary)
            VStack(alignment: .leading, spacing: 1) {
                Text(job.text).font(.footnote).lineLimit(2)
                if let bot = job.botName, !bot.isEmpty {
                    Text(bot).font(.caption2).foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 0)
            if job.threadId != nil, openThread != nil {
                Image(systemName: "chevron.right").font(.caption2).foregroundStyle(.tertiary)
            }
        }
        if let threadId = job.threadId, let openThread {
            Button { openThread(ThreadRef(botId: job.botId ?? card.botId, threadId: threadId, title: job.text)) } label: { label }
                .buttonStyle(.plain)
        } else {
            label
        }
    }

    private static func symbol(_ status: VoiceJobStatus) -> String {
        switch status {
        case .sent: return "checkmark.circle"
        case .failed: return "exclamationmark.circle"
        case .cancelled: return "xmark.circle"
        default: return "clock"
        }
    }

    private func rateButton(_ value: VoiceCallCard.Rating, _ symbol: String) -> some View {
        let chosen = rating == value
        return Button {
            guard rating != value, let session = sessionActions else { return }
            let previous = rating
            rating = value
            Task {
                if !(await session.rateVoiceCall(card, good: value == .good)) { rating = previous }
            }
        } label: {
            Label(value == .good ? "good" : "bad", systemImage: chosen ? symbol + ".fill" : symbol)
                .font(.footnote.weight(chosen ? .semibold : .regular))
                .padding(.horizontal, 10)
                .padding(.vertical, 5)
                .background(Capsule().fill(Color.primary.opacity(chosen ? 0.14 : 0.05)))
        }
        .buttonStyle(.plain)
        .opacity(rating != nil && !chosen ? 0.5 : 1)
        .accessibilityAddTraits(chosen ? .isSelected : [])
    }
}
