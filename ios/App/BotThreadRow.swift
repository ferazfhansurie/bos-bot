import CompanionCore
import SwiftUI

/// The compact thread label shared by the roster and the thread picker.
struct BotThreadRow: View {
    let task: BotTask
    var selected = false
    /// The thread is holding a queued send, from the client's queue state.
    /// The harness reports this out-of-band; the activity string never says
    /// it, so the row derives it here rather than parsing activity.
    var queued = false

    private var runtime: (title: String, icon: String, color: Color)? {
        // Ordered as the desktop orders its row: the person first, then a
        // teammate wait as a quiet clock (never a spinner), then work.
        if task.activity == "waiting-on-you" { return ("Waiting on you", "hand.raised.fill", .orange) }
        if task.isWaitingOnTeammate { return ("Waiting on teammate", "clock", .secondary) }
        if task.isWorking { return ("Working", "arrow.triangle.2.circlepath", .accentColor) }
        // The queued flag is client state the harness reports out-of-band.
        if task.activity == "queued" || queued { return ("Queued", "clock", .secondary) }
        return nil
    }

    /// A thread working in the background fades back, like the desktop's
    /// running row; waiting on you, unread or the open thread never fade.
    private var dimmed: Bool {
        task.isWorking && task.activity != "waiting-on-you" && task.unread != true && !selected
    }

    /// A closed or archived thread with nothing live in it reads quieter,
    /// as its title does on the desktop.
    private var quiet: Bool {
        (task.isClosed || task.isArchived) && runtime == nil && task.unread != true && !selected
    }

    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 5) {
                Text(verbatim: task.displayTitle)
                    .font(.body.weight(task.unread == true ? .semibold : .regular))
                    .foregroundStyle(quiet ? Color.secondary : Color.primary)
                    .lineLimit(2)

                if runtime != nil || task.unread == true {
                    HStack(spacing: 10) {
                        if let runtime {
                            HStack(spacing: 4) {
                                Image(systemName: runtime.icon)
                                    .font(.caption2.weight(.semibold))
                                Text(runtime.title)
                            }
                            .foregroundStyle(runtime.color)
                        }
                        if task.unread == true {
                            HStack(spacing: 4) {
                                Circle().frame(width: 7, height: 7)
                                Text("Unread")
                            }
                            .foregroundStyle(Color.accentColor)
                        }
                    }
                    .font(.caption.weight(.medium))
                }

                HStack(spacing: 5) {
                    if task.createdAt > 0 {
                        Text(RelativeStamp.list(task.createdAt))
                    }
                    if let byline = task.bylineLabel {
                        if task.createdAt > 0 { Text("·") }
                        Text(verbatim: byline)
                    }
                }
                .font(.caption)
                .foregroundStyle(Color.secondary)
                .lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            if selected {
                Image(systemName: "checkmark.circle.fill")
                    .foregroundStyle(Color.accentColor)
                    .accessibilityHidden(true)
            }
        }
        .padding(.vertical, 3)
        .opacity(dimmed ? 0.5 : 1)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityValue(task.isArchived ? "Archived" : task.isClosed ? "Closed" : dimmed ? "Running" : "")
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}
