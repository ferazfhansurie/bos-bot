import SwiftUI

/// Native sheets and navigation keep their system transitions. Controls use
/// a small, reversible press response without animating streamed text.
struct BosPressStyle: ButtonStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .opacity(configuration.isPressed ? 0.72 : 1)
            .scaleEffect(!reduceMotion && configuration.isPressed ? 0.97 : 1)
            .animation(reduceMotion ? nil : .easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

private struct SkeletonBlock: View {
    var width: CGFloat? = nil
    var height: CGFloat
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var pulse = false
    var body: some View {
        RoundedRectangle(cornerRadius: min(14, height / 2))
            .fill(Color.secondary.opacity(pulse ? 0.10 : 0.18))
            .frame(width: width, height: height)
            .onAppear {
                guard !reduceMotion else { return }
                withAnimation(.easeInOut(duration: 0.85).repeatForever(autoreverses: true)) { pulse = true }
            }
            .accessibilityHidden(true)
    }
}

struct ConversationSkeleton: View {
    var label = "Loading conversation…"
    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            Text(label).font(.caption).foregroundStyle(.secondary)
                .accessibilityIdentifier("conversation-loading-label")
            HStack { Spacer(minLength: 40); SkeletonBlock(width: 190, height: 46) }
            VStack(alignment: .leading, spacing: 8) {
                SkeletonBlock(height: 16)
                SkeletonBlock(height: 16)
                SkeletonBlock(width: 170, height: 16)
            }.padding(16).background(Color.secondary.opacity(0.04), in: RoundedRectangle(cornerRadius: 22))
            HStack { Spacer(minLength: 80); SkeletonBlock(width: 150, height: 44) }
        }
        .padding(.horizontal, 20).padding(.vertical, 28)
        .accessibilityElement(children: .ignore).accessibilityLabel(label)
        .accessibilityIdentifier("conversation-skeleton")
    }
}

struct NewThreadSkeleton: View {
    let name: String
    var body: some View {
        VStack(spacing: 0) {
            Text("New thread with \(name)").font(.headline).padding(.top, 28)
            ConversationSkeleton(label: "Creating new thread…")
            Spacer()
            RoundedRectangle(cornerRadius: 24).fill(Color.secondary.opacity(0.08))
                .frame(height: 52).padding(20)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(uiColor: .systemBackground))
        .accessibilityIdentifier("new-thread-skeleton")
    }
}

struct RosterSkeleton: View {
    var body: some View {
        VStack(spacing: 20) {
            ForEach(0..<4) { _ in
                HStack(spacing: 16) {
                    SkeletonBlock(width: 46, height: 46)
                    VStack(alignment: .leading, spacing: 9) {
                        SkeletonBlock(width: 120, height: 16)
                        SkeletonBlock(height: 12)
                    }
                }
            }
        }.padding(.vertical, 24)
            .accessibilityElement(children: .ignore).accessibilityLabel("Loading conversations")
    }
}

struct PendingThreadComposer: View {
    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "plus")
            Text("Setting up your thread…").font(.body)
            Spacer()
            ProgressView().controlSize(.small)
        }
        .foregroundStyle(.secondary)
        .padding(16)
        .glassCapsule(interactive: false)
        .padding(.horizontal, 16).padding(.bottom, 12)
        .accessibilityLabel("Composer available when the new thread is ready")
    }
}
