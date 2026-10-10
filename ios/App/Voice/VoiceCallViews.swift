// Grok Bot's mobile voice UI, copied from the 2026-10-08 screen recording
// (plans/grok-voice/ui.md): a one-second black splash with the avatar, the
// full-screen call with its live transcript, a settings card behind the
// gear, and the floating pill the call shrinks into while you use the chat.
import CompanionCore
import SwiftUI

private enum CallColors {
    static let red = Color(hex: "#e5484d")
    static let secondary = Color(hex: "#8e8e93")
    static let card = Color(hex: "#1c1c1e")
    static let control = Color(hex: "#2c2c2e")
    static let grabber = Color(hex: "#48484a")
}

/// Drawn above the whole app; empty when there is no call.
struct VoiceCallOverlay: View {
    @ObservedObject private var center = VoiceCallCenter.shared
    @Namespace private var space

    var body: some View {
        ZStack(alignment: .top) {
            if let call = center.call {
                VoiceCallStage(call: call, center: center, space: space)
                    // answered from the ring: it is already in place under the ring's mascot
                    .transition(center.arrivedFromRing
                        ? .asymmetric(insertion: .identity, removal: .opacity)
                        : .scale(scale: 0.1, anchor: .bottomTrailing).combined(with: .opacity))
            }
            if let incoming = center.incoming {
                IncomingVoiceCallView(incoming: incoming, center: center)
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
        // Full size so the pill sits at the top, not the middle; empty
        // space takes no touches.
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .animation(.easeIn(duration: 0.25), value: center.call?.id)
        .animation(.spring(duration: 0.35), value: center.incoming?.id)
    }
}

private struct VoiceCallStage: View {
    @ObservedObject var call: RealtimeVoiceCall
    @ObservedObject var center: VoiceCallCenter
    let space: Namespace.ID

    var body: some View {
        switch center.presentation {
        case .splash:
            VoiceCallSplash(call: call, space: space)
                .transition(.opacity)
        case .full:
            VoiceCallFullScreen(call: call, center: center, space: space)
                .transition(.opacity)
        case .pill:
            VoiceCallPill(call: call, center: center, space: space)
                .transition(.opacity)
        }
    }
}

extension RealtimeVoiceCall.Activity {
    var face: MausState {
        switch self {
        case .idle: return .idle
        case .listening: return .listening
        case .thinking: return .thinking
        case .speaking: return .happy
        }
    }
}

private struct CallAvatar: View {
    @ObservedObject var call: RealtimeVoiceCall
    let size: CGFloat
    let space: Namespace.ID
    @State private var motion = CallMotionBox()

    /// A bot that wears its mascot comes alive on the call; a photo stays a
    /// photo.
    private var wearsMascot: Bool { (call.bot.avatarCrop ?? .mascot) == .mascot || call.bot.avatarUrl == nil }

    var body: some View {
        Group {
            if wearsMascot {
                LiveMascot(color: call.bot.color, bodyId: call.bot.mascotBody,
                           eyeStyle: MascotEyeStyle(stored: call.bot.mascotEyes),
                           face: liveFace, accent: call.activity == .thinking, size: size, fps: 120) { date in
                    let levels = call.levels
                    // the playback tap knows it is talking a beat before the turn says so
                    let mode = call.phase == .live && levels.assistantSpeaking ? .speaking : liveMode
                    return motion.motion.step(at: date.timeIntervalSinceReferenceDate, mode: mode,
                                              speaker: levels.speaker, mic: levels.mic)
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("\(call.bot.name) avatar")
            } else {
                BotAvatarView(bot: call.bot, size: size, state: call.activity.face, animated: true)
            }
        }
        .matchedGeometryEffect(id: "voice-avatar", in: space)
    }

    /// Before the line is live it just waits; once live it follows the turn.
    private var liveMode: CallMascotMotion.Mode {
        guard call.phase == .live else { return .idle }
        switch call.activity {
        case .idle: return .idle
        case .listening: return .listening
        case .thinking: return .thinking
        case .speaking: return .speaking
        }
    }

    /// Open ring eyes while it talks or listens (their squash with its voice
    /// and the nods do the rest), the question face between turns.
    private var liveFace: GlyphFaceState {
        guard call.phase == .live else { return .idle }
        return call.activity == .thinking ? .thinking : .waiting
    }
}

// MARK: - Splash

private struct VoiceCallSplash: View {
    @ObservedObject var call: RealtimeVoiceCall
    let space: Namespace.ID
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        ZStack {
            (scheme == .dark ? Color.black : Color.white).ignoresSafeArea()
            CallAvatar(call: call, size: 56, space: space)
        }
        .accessibilityLabel("Calling \(call.bot.name)")
    }
}

// MARK: - Full screen

private struct VoiceCallFullScreen: View {
    @ObservedObject var call: RealtimeVoiceCall
    @ObservedObject var center: VoiceCallCenter
    let space: Namespace.ID
    @Environment(\.colorScheme) private var scheme
    /// Answered from the ring: the mascot and name are already here, the rest
    /// fades in around them.
    @State private var settledIn = false

    private var dark: Bool { scheme == .dark }
    private var foreground: Color { dark ? .white : .black }
    private var arriving: Double { center.arrivedFromRing && !settledIn ? 0 : 1 }

    var body: some View {
        ZStack {
            (dark ? Color.black : Color.white).ignoresSafeArea()
            VStack(spacing: 0) {
                header
                Group {
                if case let .failed(message) = call.phase {
                    failure(message)
                } else if center.showingSettings {
                    Spacer(minLength: 0)
                    VoiceCallSettingsCard(call: call)
                        .padding(.horizontal, 16)
                        .padding(.bottom, 16)
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                } else {
                    VoiceCallTranscript(call: call)
                }
                }
                .opacity(arriving)
                controls
                    .opacity(arriving)
                    .offset(y: arriving == 0 ? 24 : 0)
            }
        }
        .onAppear {
            guard center.arrivedFromRing, !settledIn else { return }
            withAnimation(.spring(response: 0.5, dampingFraction: 0.9).delay(0.05)) { settledIn = true }
        }
        .gesture(DragGesture(minimumDistance: 30).onEnded { value in
            if value.translation.height < -80 { center.minimize() }
        })
    }

    private var header: some View {
        ZStack(alignment: .topLeading) {
            VStack(spacing: 6) {
                CallAvatar(call: call, size: 96, space: space)
                    .background { CallAura(call: call, size: 96) }
                    .padding(.vertical, 6)
                Text(call.bot.name)
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(foreground)
                    .lineLimit(1)
                Text(status)
                    .font(.system(size: 13).monospacedDigit())
                    .foregroundStyle(CallColors.secondary)
                    .contentTransition(.numericText())
                    .opacity(arriving)
            }
            .frame(maxWidth: .infinity)
            .padding(.top, 8)

            Button { center.minimize() } label: {
                Image(systemName: "chevron.up")
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(foreground)
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .padding(.leading, 8)
            .accessibilityLabel("Minimize call")
            .disabled(call.isOver)
            .opacity(call.isOver ? 0 : arriving)
        }
    }

    private var status: String {
        switch call.phase {
        case .connecting: return "Connecting…"
        case .reconnecting: return "Reconnecting…"
        case .failed: return "Call failed"
        case .ended: return "Call ended"
        case .live: return RealtimeVoice.formatDuration(call.elapsed)
        }
    }

    private func failure(_ message: String) -> some View {
        VStack(spacing: 16) {
            Spacer()
            Text(message)
                .font(.system(size: 17))
                .foregroundStyle(foreground)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)
            Button("Close") { center.dismiss() }
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(dark ? .black : .white)
                .padding(.horizontal, 28)
                .padding(.vertical, 12)
                .background(Capsule().fill(foreground))
            Spacer()
        }
    }

    private var controls: some View {
        HStack(spacing: 16) {
            Button { call.toggleMute() } label: {
                Image(systemName: call.muted ? "mic.slash" : "mic")
                    .font(.system(size: 18, weight: .medium))
                    .foregroundStyle(foreground)
                    .frame(width: 40, height: 40)
                    .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(call.muted ? "Unmute" : "Mute")

            Button {
                withAnimation(.spring(duration: 0.35)) { center.showingSettings.toggle() }
            } label: {
                Image(systemName: "gearshape")
                    .font(.system(size: 18, weight: .medium))
                    .foregroundStyle(foreground)
                    .frame(width: 40, height: 40)
                    .background(Circle().fill(center.showingSettings
                        ? (dark ? CallColors.control : Color(hex: "#e5e5ea")) : .clear))
                    .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Call settings")

            Spacer()

            Button {
                if call.isOver { center.dismiss() } else { call.hangUp() }
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 18, weight: .bold))
                    .foregroundStyle(.white)
                    .frame(width: 48, height: 48)
                    .background(Circle().fill(CallColors.red))
            }
            .buttonStyle(.plain)
            .accessibilityLabel("End call")
        }
        .disabled(call.phase == .ended)
        .padding(.horizontal, 20)
        .padding(.bottom, 12)
        .padding(.top, 8)
    }
}

/// The bot's colour around its mascot, breathing with the call: a faint
/// halo at rest that blooms and throws rings while it talks, and answers
/// your voice with a softer swell. Still under Reduce Motion.
private struct CallAura: View {
    @ObservedObject var call: RealtimeVoiceCall
    let size: CGFloat
    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var model = AuraModel()

    final class AuraModel {
        var own: CGFloat = 0
        var yours: CGFloat = 0
        var last: TimeInterval?
        /// When each thrown ring left, newest last.
        var rings: [TimeInterval] = []
        var lastRing: TimeInterval = 0
    }

    var body: some View {
        let accent = GlyphMark.colors(call.bot.color, scheme: scheme).accent
        let dark = scheme == .dark
        TimelineView(.animation(minimumInterval: 1.0 / 120, paused: reduceMotion)) { timeline in
            let t = timeline.date.timeIntervalSinceReferenceDate
            let (own, yours, rings) = step(at: t)
            Canvas { context, canvas in
                let centre = CGPoint(x: canvas.width / 2, y: canvas.height / 2)
                let base = size * 0.62
                let halo = base * (1.45 + 0.55 * own + 0.25 * yours)
                let strength = (dark ? 0.2 : 0.13) + 0.3 * own + 0.12 * yours
                context.fill(Path(ellipseIn: CGRect(x: centre.x - halo, y: centre.y - halo, width: halo * 2, height: halo * 2)),
                             with: .radialGradient(Gradient(colors: [accent.opacity(strength), accent.opacity(0)]),
                                                   center: centre, startRadius: 0, endRadius: halo))
                for left in rings {
                    let k = (t - left) / 1.2
                    guard k >= 0, k < 1 else { continue }
                    let r = base * (0.95 + 1.1 * (1 - pow(1 - k, 3)))
                    context.stroke(Path(ellipseIn: CGRect(x: centre.x - r, y: centre.y - r, width: r * 2, height: r * 2)),
                                   with: .color(accent.opacity(0.4 * (1 - k))), lineWidth: 2 * (1 - k) + 0.5)
                }
            }
        }
        .frame(width: size * 3.2, height: size * 3.2)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    private func step(at t: TimeInterval) -> (CGFloat, CGFloat, [TimeInterval]) {
        let levels = call.levels
        let live = call.phase == .live
        let dt = min(max(t - (model.last ?? t), 0), 0.1)
        model.last = t
        let ownTarget = live && levels.assistantSpeaking ? min(1, CGFloat(levels.speaker) * 7) : 0
        let yoursTarget = live && !levels.assistantSpeaking ? min(1, CGFloat(levels.mic) * 7) : 0
        // quick to rise, slow to fall, like a meter
        func ease(_ value: CGFloat, _ target: CGFloat) -> CGFloat {
            let rate: Double = target > value ? 22 : 5
            return value + (target - value) * CGFloat(1 - exp(-rate * dt))
        }
        let rising = ownTarget - model.own
        model.own = ease(model.own, ownTarget)
        model.yours = ease(model.yours, yoursTarget)
        // a syllable landing throws a ring, at most every 0.28 s
        if rising > 0.25, model.own > 0.35, t - model.lastRing > 0.28 {
            model.rings.append(t)
            model.lastRing = t
        }
        model.rings.removeAll { t - $0 > 1.2 }
        return (model.own, model.yours, model.rings)
    }
}

private struct VoiceCallTranscript: View {
    @ObservedObject var call: RealtimeVoiceCall
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    Spacer(minLength: 40)
                    ForEach(call.lines.filter { !$0.text.isEmpty }) { line in
                        Text(line.text)
                            .font(.system(size: 17))
                            .foregroundStyle(line.speaker == .assistant
                                ? (scheme == .dark ? Color.white : Color.black)
                                : CallColors.secondary)
                            .multilineTextAlignment(line.speaker == .assistant ? .leading : .trailing)
                            .frame(maxWidth: .infinity, alignment: line.speaker == .assistant ? .leading : .trailing)
                            .padding(line.speaker == .assistant ? .trailing : .leading, 40)
                            .id(line.id)
                    }
                    Color.clear.frame(height: 1).id("voice-bottom")
                }
                .padding(.horizontal, 20)
            }
            .scrollIndicators(.hidden)
            .defaultScrollAnchor(.bottom)
            // Older lines fade out under the header.
            .mask(LinearGradient(stops: [
                .init(color: .clear, location: 0),
                .init(color: .black, location: 0.18),
                .init(color: .black, location: 1),
            ], startPoint: .top, endPoint: .bottom))
            .onChange(of: call.lines) {
                withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo("voice-bottom", anchor: .bottom) }
            }
        }
    }
}

// MARK: - Settings card

struct VoiceCallSettingsCard: View {
    @ObservedObject var call: RealtimeVoiceCall
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        VStack(spacing: 0) {
            row("Voice", value: Self.voiceName(call.settings.voice)) {
                ForEach(call.options.voices, id: \.self) { voice in
                    Button { call.setVoice(voice) } label: { checked(Self.voiceName(voice), call.settings.voice == voice) }
                }
            }
            divider
            row("Speed", value: Self.speedName(call.settings.speed)) {
                ForEach(call.options.speeds, id: \.self) { speed in
                    Button { call.setSpeed(speed) } label: { checked(Self.speedName(speed), call.settings.speed == speed) }
                }
            }
            divider
            row("Language", value: Self.languageName(call.settings.language)) {
                ForEach(call.options.languages, id: \.self) { language in
                    Button { call.setLanguage(language) } label: {
                        checked(Self.languageName(language), call.settings.language == language)
                    }
                }
            }
        }
        .background(RoundedRectangle(cornerRadius: 14, style: .continuous)
            .fill(scheme == .dark ? CallColors.card : Color(hex: "#f2f2f7")))
    }

    private var divider: some View {
        Rectangle().fill(Color.primary.opacity(0.08)).frame(height: 0.5).padding(.leading, 16)
    }

    @ViewBuilder
    private func checked(_ title: String, _ on: Bool) -> some View {
        if on { Label(title, systemImage: "checkmark") } else { Text(title) }
    }

    private func row<Items: View>(_ title: String, value: String, @ViewBuilder items: () -> Items) -> some View {
        Menu {
            items()
        } label: {
            HStack {
                Text(title)
                    .font(.system(size: 17))
                    .foregroundStyle(scheme == .dark ? Color.white : Color.black)
                Spacer()
                Text(value)
                    .font(.system(size: 17))
                    .foregroundStyle(CallColors.secondary)
                Image(systemName: "chevron.up.chevron.down")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(CallColors.secondary)
            }
            .padding(.horizontal, 16)
            .frame(height: 48)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    static func voiceName(_ voice: String) -> String { voice.prefix(1).uppercased() + voice.dropFirst() }

    static func speedName(_ speed: Double) -> String {
        let text = speed == speed.rounded() ? String(Int(speed)) : String(format: "%g", speed)
        return "\(text)x"
    }

    static func languageName(_ code: String) -> String {
        if code == VoiceCallSettings.autoLanguage { return "Auto" }
        return Locale(identifier: "en").localizedString(forLanguageCode: code) ?? code
    }
}

// MARK: - Pill

private struct VoiceCallPill: View {
    @ObservedObject var call: RealtimeVoiceCall
    @ObservedObject var center: VoiceCallCenter
    let space: Namespace.ID
    @Environment(\.colorScheme) private var scheme
    @State private var drag: CGFloat = 0

    private var dark: Bool { scheme == .dark }
    private var foreground: Color { dark ? .white : .black }

    var body: some View {
        VStack(spacing: 6) {
            HStack(spacing: 10) {
                CallAvatar(call: call, size: 32, space: space)
                VoiceWaveform(levels: call.levels, live: call.phase == .live, tint: foreground)
                    .frame(width: 18 * 5, height: 30)
                Spacer(minLength: 4)
                Button { center.expand(settings: true) } label: {
                    Image(systemName: "gearshape")
                        .font(.system(size: 17, weight: .medium))
                        .foregroundStyle(foreground)
                        .frame(width: 36, height: 40)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Call settings")
                Button { call.toggleMute() } label: {
                    Image(systemName: call.muted ? "mic.slash" : "mic")
                        .font(.system(size: 17, weight: .medium))
                        .foregroundStyle(foreground)
                        .frame(width: 36, height: 40)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(call.muted ? "Unmute" : "Mute")
                Button { call.hangUp() } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 16, weight: .bold))
                        .foregroundStyle(.white)
                        .frame(width: 40, height: 40)
                        .background(Circle().fill(CallColors.red))
                }
                .buttonStyle(.plain)
                .accessibilityLabel("End call")
            }
            .padding(.leading, 16)
            .padding(.trailing, 15)
            .frame(height: 70)
            .frame(maxWidth: 345)
            .background {
                Capsule()
                    .fill(.ultraThinMaterial)
                    .overlay(Capsule().fill((dark ? CallColors.card : Color(hex: "#f2f2f7")).opacity(0.92)))
                    .overlay(Capsule().strokeBorder((dark ? Color.white : Color.black).opacity(0.06), lineWidth: 1))
                    .shadow(color: .black.opacity(0.25), radius: 18, y: 8)
            }
            .contentShape(Capsule())
            .onTapGesture { center.expand() }

            Capsule()
                .fill(CallColors.grabber)
                .frame(width: 36, height: 4)
                .padding(.vertical, 4)
                .contentShape(Rectangle().inset(by: -12))
                .onTapGesture { center.expand() }
        }
        .offset(y: max(0, drag) * 0.5)
        .gesture(DragGesture(minimumDistance: 8)
            .onChanged { drag = $0.translation.height }
            .onEnded { value in
                if value.translation.height > 40 { center.expand() }
                withAnimation(.spring(duration: 0.3)) { drag = 0 }
            })
        .padding(.horizontal, 16)
        .padding(.top, 52)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Call with \(call.bot.name)")
    }
}

/// ~18 bars, 2pt wide, 3pt gap, following whoever is talking. When nobody
/// is, the bars collapse to a gray dotted line.
struct VoiceWaveform: View {
    let levels: VoiceCallLevels
    let live: Bool
    var tint: Color = .white
    var bars = 18

    @State private var model = WaveModel()

    final class WaveModel {
        var heights: [CGFloat] = []
        var smoothed: CGFloat = 0
    }

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30)) { timeline in
            Canvas { context, size in
                let heights = step(size: size, at: timeline.date)
                let gap: CGFloat = 3, width: CGFloat = 2
                let idle = heights.allSatisfy { $0 <= width + 0.01 }
                let color = idle ? Color.gray : tint
                for (index, height) in heights.enumerated() {
                    let x = CGFloat(index) * (width + gap)
                    let rect = CGRect(x: x, y: (size.height - height) / 2, width: width, height: height)
                    context.fill(Path(roundedRect: rect, cornerRadius: width / 2), with: .color(color))
                }
            }
        }
        .accessibilityHidden(true)
    }

    private func step(size: CGSize, at date: Date) -> [CGFloat] {
        if model.heights.count != bars { model.heights = Array(repeating: 2, count: bars) }
        let level: Float
        if !live { level = 0 }
        else if levels.assistantSpeaking { level = levels.speaker }
        else if levels.callerSpeaking || levels.mic > 0.02 { level = levels.mic }
        else { level = 0 }
        // Smoothing 0.6 toward the new loudness; gain lifts quiet speech.
        let target = min(1, CGFloat(level) * 6)
        model.smoothed = model.smoothed * 0.6 + target * 0.4
        let maxHeight = size.height
        let phase = date.timeIntervalSinceReferenceDate * 9
        model.heights = (0..<bars).map { index in
            guard model.smoothed > 0.03 else { return 2 }
            // A centred hump with a little ripple so the bars read as a wave.
            let center = 1 - abs(CGFloat(index) - CGFloat(bars - 1) / 2) / (CGFloat(bars) / 2)
            let ripple = 0.65 + 0.35 * CGFloat(sin(phase + Double(index) * 0.9))
            return max(2, min(maxHeight, maxHeight * model.smoothed * (0.35 + 0.65 * center) * ripple))
        }
        return model.heights
    }
}

// MARK: - Chat rows

/// "<bot> is working", above the composer while work handed off on a call
/// is still running.
struct VoiceWorkingRow: View {
    let bot: Bot
    @State private var sweep = false

    var body: some View {
        HStack(spacing: 8) {
            BotAvatarView(bot: bot, size: 24, state: .working, animated: true)
            Text("\(bot.name) is working")
                .font(.system(size: 15))
                .foregroundStyle(CallColors.secondary)
                .overlay {
                    GeometryReader { geo in
                        LinearGradient(colors: [.clear, .white.opacity(0.55), .clear],
                                       startPoint: .leading, endPoint: .trailing)
                            .frame(width: geo.size.width * 0.5)
                            .offset(x: sweep ? geo.size.width : -geo.size.width * 0.5)
                    }
                    .mask(Text("\(bot.name) is working").font(.system(size: 15)))
                    .allowsHitTesting(false)
                }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 4)
        .onAppear {
            withAnimation(.linear(duration: 1.4).repeatForever(autoreverses: false)) { sweep = true }
        }
        .accessibilityElement(children: .combine)
    }
}

/// The local, centred row a finished call leaves in its chat. The voice
/// transcript is deliberately not dumped into the chat.
struct VoiceCallEndedRow: View {
    let record: VoiceCallRecord

    var body: some View {
        VStack(spacing: 4) {
            Text(RelativeStamp.separator(Date(timeIntervalSince1970: record.endedAt / 1000)))
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
            HStack(spacing: 5) {
                Image(systemName: "waveform")
                    .font(.system(size: 11, weight: .semibold))
                Text("Voice chat \(RealtimeVoice.formatDuration(record.seconds, padMinutes: true))")
                    .font(.system(size: 13))
            }
            .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 10)
        .accessibilityElement(children: .combine)
    }
}
