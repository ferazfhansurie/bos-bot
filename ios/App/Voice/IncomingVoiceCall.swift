// A bot ringing its owner (`ring_owner`), while the app is open: a full-screen
// incoming call that rings and buzzes until it is answered, declined or 30 s
// pass. Accept starts the realtime call, opening with why the bot called.
// No CallKit: in the background the same ring is a time-sensitive
// notification with Accept.
import AudioToolbox
import CompanionCore
import SwiftUI

struct IncomingVoiceRing: Identifiable {
    let ring: VoiceRing
    let bot: Bot
    let session: Session
    var id: String { ring.ringId }
}

/// The ring itself: a tone and a buzz every two seconds.
@MainActor
final class VoiceRinger {
    private var timer: Timer?

    func start() {
        pulse()
        let timer = Timer(timeInterval: 2, repeats: true) { _ in
            MainActor.assumeIsolated { VoiceRinger.pulseOnce() }
        }
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
    }

    func stop() {
        timer?.invalidate()
        timer = nil
    }

    private func pulse() { Self.pulseOnce() }

    private static func pulseOnce() {
        AudioServicesPlayAlertSound(SystemSoundID(1151))
        Haptics.notification(.warning)
    }

    deinit { timer?.invalidate() }
}

struct IncomingVoiceCallView: View {
    let incoming: IncomingVoiceRing
    @ObservedObject var center: VoiceCallCenter
    @State private var pulsing = false

    var body: some View {
        ZStack {
            LinearGradient(colors: [Color(hex: "#1c1c1e"), .black], startPoint: .top, endPoint: .bottom)
                .ignoresSafeArea()
            VStack(spacing: 0) {
                Spacer().frame(height: 72)
                Text("BOS voice call")
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(Color(hex: "#8e8e93"))
                Text(incoming.bot.name)
                    .font(.system(size: 34, weight: .semibold))
                    .foregroundStyle(.white)
                    .lineLimit(1)
                    .padding(.top, 6)
                if !incoming.ring.reason.isEmpty {
                    Text(incoming.ring.reason)
                        .font(.system(size: 17))
                        .foregroundStyle(.white.opacity(0.75))
                        .multilineTextAlignment(.center)
                        .lineLimit(4)
                        .padding(.horizontal, 32)
                        .padding(.top, 12)
                }
                Spacer()
                ZStack {
                    Circle()
                        .fill(Color.white.opacity(0.08))
                        .frame(width: 176, height: 176)
                        .scaleEffect(pulsing ? 1.12 : 0.92)
                    BotAvatarView(bot: incoming.bot, size: 120, state: .happy, animated: true)
                }
                Spacer()
                HStack {
                    button(title: "Decline", symbol: "phone.down.fill", color: Color(hex: "#e5484d")) { center.decline() }
                    Spacer()
                    button(title: "Accept", symbol: "phone.fill", color: Color(hex: "#30d158")) { center.accept() }
                }
                .padding(.horizontal, 56)
                .padding(.bottom, 64)
            }
        }
        .onAppear {
            withAnimation(.easeInOut(duration: 1).repeatForever(autoreverses: true)) { pulsing = true }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(incoming.bot.name) is calling")
    }

    private func button(title: String, symbol: String, color: Color, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(spacing: 10) {
                Image(systemName: symbol)
                    .font(.system(size: 30, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: 76, height: 76)
                    .background(Circle().fill(color))
                Text(title)
                    .font(.system(size: 15))
                    .foregroundStyle(.white)
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(title)
    }
}
