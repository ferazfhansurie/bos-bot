// The expanded notification: a long press on a bot's notification shows the
// bot itself, in the mood of what it said, above the message.
//
// The face is the same glyph mark the app draws, painted here frame by frame
// so it can blink and breathe: it hops in when the notification opens, rests
// calmly, and does a happy hop when touched. Reduce motion keeps it still,
// with a fade in and the blink. A tap anywhere else opens the thread.
//
// The bot's look comes from the roster the app writes into the App Group;
// a sender the roster does not know shows the avatar the app cached for it.
import CompanionCore
import SwiftUI
import UIKit
import UserNotifications
import UserNotificationsUI

final class NotificationViewController: UIViewController, UNNotificationContentExtension {
    private var host: UIHostingController<NotificationFaceView>?

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .clear
    }

    func didReceive(_ notification: UNNotification) {
        let content = notification.request.content
        let info = content.userInfo
        let senderID = (info["senderId"] as? String) ?? (info["botId"] as? String).map { "bot:\($0)" }
        let botID = (info["botId"] as? String)
            ?? senderID.flatMap { $0.hasPrefix("bot:") ? String($0.dropFirst(4)) : nil }
        let mood = NotificationMood.glyph(kind: (info["type"] as? String) ?? (info["kind"] as? String),
                                          title: content.title, body: content.body)
        let glance = botID.flatMap(BotRosterStore.bot)
        let fallback = senderID.flatMap { NotificationAvatarCache.bestURL(for: $0, mood: mood) }
            .flatMap { try? Data(contentsOf: $0) }
            .flatMap(UIImage.init(data:))
        let face = NotificationFaceView(
            name: glance?.name ?? content.title,
            color: glance?.color,
            bodyId: glance?.body,
            eyes: glance?.eyes,
            mood: GlyphFaceState(rawValue: mood) ?? .happy,
            fallback: fallback,
            open: { [weak self] in self?.extensionContext?.performNotificationDefaultAction() }
        )
        if let host {
            host.rootView = face
        } else {
            let host = UIHostingController(rootView: face)
            host.view.backgroundColor = .clear
            host.view.translatesAutoresizingMaskIntoConstraints = false
            addChild(host)
            view.addSubview(host.view)
            NSLayoutConstraint.activate([
                host.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
                host.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
                host.view.topAnchor.constraint(equalTo: view.topAnchor),
                host.view.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            ])
            host.didMove(toParent: self)
            self.host = host
        }
        preferredContentSize = CGSize(width: view.bounds.width, height: 132)
    }
}

struct NotificationFaceView: View {
    let name: String
    let color: String?
    let bodyId: String?
    let eyes: String?
    let mood: GlyphFaceState
    let fallback: UIImage?
    let open: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorScheme) private var scheme
    @State private var arrived = false
    @State private var hopAt: Date?

    private let size: CGFloat = 76

    var body: some View {
        HStack(spacing: 16) {
            face
                .frame(width: size, height: size)
                .scaleEffect(arrived || reduceMotion ? 1 : 0.55)
                .opacity(arrived ? 1 : 0)
                .contentShape(Circle())
                .onTapGesture(perform: touch)
                .accessibilityLabel("\(name), \(NotificationMood.word(mood.rawValue))")
                .accessibilityAddTraits(.isButton)
            VStack(alignment: .leading, spacing: 3) {
                Text(name)
                    .font(.system(size: 17, weight: .semibold))
                    .lineLimit(1)
                Text(NotificationMood.word(mood.rawValue))
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(accent)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 18)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .contentShape(Rectangle())
        .onTapGesture(perform: open)
        .onAppear {
            withAnimation(reduceMotion ? .easeOut(duration: 0.35) : .spring(duration: 0.6, bounce: 0.5)) { arrived = true }
        }
    }

    private var accent: Color {
        GlyphMark.colors(color ?? "green", scheme: scheme).accent
    }

    @ViewBuilder private var face: some View {
        if let color {
            TimelineView(.animation(minimumInterval: 1.0 / 30, paused: !arrived)) { timeline in
                let now = timeline.date
                let motion = self.motion(at: now)
                // a touch turns any mood happy for a moment
                let state = touched(at: now) ? (mood == .failed || mood == .waiting ? GlyphFaceState.happy : .finished) : mood
                Canvas { context, canvas in
                    let slot = CGRect(x: canvas.width / 4, y: canvas.height / 4, width: canvas.width / 2, height: canvas.height / 2)
                    GlyphMark.draw(in: &context, slot: slot, color: color, bodyId: bodyId, state: state,
                                   scheme: scheme, now: now, changedAt: hopAt)
                }
                .frame(width: size * 2, height: size * 2)
                .frame(width: size, height: size)
                .scaleEffect(x: motion.stretch, y: 2 - motion.stretch, anchor: .bottom)
                .offset(y: motion.lift)
                .rotationEffect(.degrees(motion.tilt))
            }
        } else if let fallback {
            Image(uiImage: fallback)
                .resizable()
                .scaledToFit()
                .clipShape(Circle())
        } else {
            Circle().fill(.quaternary)
        }
    }

    private func touched(at now: Date) -> Bool {
        hopAt.map { now.timeIntervalSince($0) < 1.6 } ?? false
    }

    /// Calm breathing at rest; a springy hop after a touch. Reduce motion
    /// keeps the body still (the eyes still blink).
    private func motion(at now: Date) -> (lift: CGFloat, stretch: CGFloat, tilt: Double) {
        guard !reduceMotion else { return (0, 1, 0) }
        let t = now.timeIntervalSinceReferenceDate
        // a slow breath, slower still when it is waiting on you
        let breath = sin(t * (mood == .waiting ? 1.6 : 2.2))
        var lift = CGFloat(breath) * 1.5
        var stretch = 1 + CGFloat(breath) * 0.012
        var tilt = mood == .waiting ? sin(t * 0.9) * 3 : 0
        if let hopAt {
            let s = now.timeIntervalSince(hopAt)
            if s < 1.2 {
                // a damped spring: up, land, a small bounce, settle
                let spring = exp(-4.2 * s) * sin(s * 13)
                lift -= CGFloat(spring) * 16
                stretch += CGFloat(spring) * 0.08
                tilt += spring * 6
            }
        }
        return (lift, stretch, tilt)
    }

    private func touch() {
        hopAt = Date()
        UIImpactFeedbackGenerator(style: .soft).impactOccurred()
    }
}
