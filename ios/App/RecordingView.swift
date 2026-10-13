import SwiftUI
import AVKit
import CompanionCore

struct RecordingView: View {
    @ObservedObject var recorder: SpeechDictation
    @Environment(\.dismiss) private var dismiss
    @State private var showLibrary = false
    @State private var closing = false

    private var live: Bool { recorder.isListening || recorder.isStarting }
    private var title: String { recorder.meetingMode ? "Meeting recording" : "Voice draft" }
    private var status: String {
        if recorder.isStarting { return "Preparing microphone…" }
        if recorder.isFinishing { return "Finishing transcript…" }
        if recorder.isListening { return "Recording" }
        return recorder.recordingURL == nil ? "Paused" : "Saved on this iPhone"
    }
    private var spoken: String { Dictation.draft(base: recorder.base, transcript: recorder.transcript) }

    var body: some View {
        VStack(spacing: 0) {
            header
            transcript
            controls
        }
        .background(Color(.systemBackground).ignoresSafeArea())
        .background {
            // Capture watchdog only; kept off the drawing path.
            TimelineView(.periodic(from: .now, by: 0.2)) { context in
                Color.clear.onChange(of: context.date) { _, _ in recorder.checkCaptureHealth() }
            }
        }
        .onChange(of: recorder.isFinishing) { _, finishing in
            if closing && !finishing { recorder.meetingMode = false; dismiss() }
        }
        .sensoryFeedback(.impact(weight: .medium), trigger: recorder.isListening)
        .sensoryFeedback(.selection, trigger: recorder.meetingMode)
        .sheet(isPresented: $showLibrary) { RecordingLibraryView() }
        .interactiveDismissDisabled(live)
    }

    private var header: some View {
        ZStack {
            VStack(spacing: 3) {
                Text(title).font(.headline)
                HStack(spacing: 6) {
                    if recorder.isListening { RecordingDot() }
                    Text(status)
                        .font(.footnote.weight(.medium))
                        .foregroundStyle(recorder.isListening ? Color.red : Color.secondary)
                        .contentTransition(.opacity)
                }
            }
            HStack {
                Button { showLibrary = true } label: {
                    Image(systemName: "list.bullet")
                        .font(.body.weight(.semibold))
                        .frame(width: 36, height: 36)
                        .background(Color(.tertiarySystemFill), in: Circle())
                }
                .foregroundStyle(.primary)
                .accessibilityLabel("Recordings")
                .disabled(live || recorder.isFinishing)
                Spacer()
                Button("Done") {
                    closing = true
                    recorder.stop()
                    if !recorder.isFinishing { recorder.meetingMode = false; dismiss() }
                }
                .font(.body.weight(.semibold))
                .disabled(recorder.isFinishing)
            }
        }
        .padding(.horizontal, 20)
        .padding(.top, 8)
        .padding(.bottom, 12)
        .animation(.snappy, value: status)
    }

    private var transcript: some View {
        ScrollView {
            Group {
                if spoken.isEmpty {
                    Text(recorder.meetingMode ? "Listening to the room…" : "Start talking. Take your time.")
                        .foregroundStyle(.tertiary)
                } else {
                    Text(spoken).textSelection(.enabled)
                }
            }
            .font(.system(.title2, design: .rounded).weight(.medium))
            .lineSpacing(5)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 24)
            .padding(.vertical, 28)
        }
        // Native bottom anchoring follows new words without yanking you down
        // while you read back.
        .defaultScrollAnchor(.bottom)
        .scrollIndicators(.hidden)
        .mask {
            LinearGradient(stops: [.init(color: .clear, location: 0), .init(color: .black, location: 0.08),
                                   .init(color: .black, location: 0.94), .init(color: .clear, location: 1)],
                           startPoint: .top, endPoint: .bottom)
        }
        .accessibilityIdentifier("recording-transcript")
    }

    private var controls: some View {
        VStack(spacing: 18) {
            LevelWaveform(active: recorder.isListening)
                .frame(height: 56)
                .padding(.horizontal, 4)
            VStack(spacing: 4) {
                Group {
                    if let start = recorder.startedAt, recorder.isListening {
                        Text(start, style: .timer)
                    } else {
                        Text(recorder.isFinishing ? "…" : "–:––")
                    }
                }
                .font(.system(size: 44, weight: .light))
                .monospacedDigit()
                Text(recorder.inputName).font(.caption).foregroundStyle(.secondary)
            }
            if let error = recorder.error {
                Text(error).font(.footnote).foregroundStyle(.orange).multilineTextAlignment(.center)
            }
            ZStack {
                RecordButton(live: live) {
                    if live { recorder.stop() } else { recorder.resume() }
                }
                .disabled(recorder.isFinishing)
                HStack {
                    MeetingPill(on: $recorder.meetingMode)
                    Spacer()
                }
            }
            if recorder.meetingMode {
                Text("Keeps recording when your phone locks. Let everyone know you’re recording.")
                    .font(.caption).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .transition(.opacity.combined(with: .move(edge: .bottom)))
            }
        }
        .padding(.horizontal, 24)
        .padding(.top, 22)
        .padding(.bottom, 12)
        .background {
            UnevenRoundedRectangle(topLeadingRadius: 32, topTrailingRadius: 32)
                .fill(Color(.secondarySystemBackground))
                .ignoresSafeArea(edges: .bottom)
        }
        .animation(.snappy, value: recorder.meetingMode)
    }
}

/// Compact meeting toggle so the record button can own the centre.
private struct MeetingPill: View {
    @Binding var on: Bool
    var body: some View {
        Button { on.toggle() } label: {
            Image(systemName: on ? "person.2.wave.2.fill" : "person.2.wave.2")
                .font(.body.weight(.semibold))
                .frame(width: 48, height: 48)
                .foregroundStyle(on ? Color.white : Color.primary)
                .background(on ? Color.red : Color(.tertiarySystemFill), in: Circle())
        }
        .buttonStyle(PressScaleStyle())
        .accessibilityLabel("Meeting mode")
        .accessibilityValue(on ? "1" : "0")
        .accessibilityAddTraits(on ? [.isSelected] : [])
        .accessibilityHint("Keeps recording when the phone locks. Start each meeting yourself.")
        .animation(.snappy, value: on)
    }
}

/// Voice Memos-style control: white ring, red core that morphs between a
/// circle (tap to record) and a rounded square (tap to pause).
private struct RecordButton: View {
    let live: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            ZStack {
                Circle().strokeBorder(Color.primary.opacity(0.85), lineWidth: 4)
                RoundedRectangle(cornerRadius: live ? 8 : 30, style: .continuous)
                    .fill(Color.red)
                    .frame(width: live ? 30 : 58, height: live ? 30 : 58)
            }
            .frame(width: 72, height: 72)
            .contentShape(Circle())
            .animation(.spring(response: 0.3, dampingFraction: 0.75), value: live)
        }
        .buttonStyle(PressScaleStyle())
        .accessibilityLabel(live ? "Pause" : "Resume")
        .accessibilityIdentifier("recording-pause")
    }
}

private struct PressScaleStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.92 : 1)
            .animation(.spring(response: 0.2, dampingFraction: 0.7), value: configuration.isPressed)
    }
}

private struct RecordingDot: View {
    @State private var on = false
    var body: some View {
        Circle().fill(Color.red).frame(width: 7, height: 7)
            .opacity(on ? 1 : 0.35)
            .onAppear { withAnimation(.easeInOut(duration: 0.8).repeatForever()) { on = true } }
            .accessibilityHidden(true)
    }
}

/// Scrolling bar waveform fed by MicLevel. The sample ring lives in a
/// reference box so drawing never invalidates SwiftUI state, and the
/// timeline stops entirely while paused.
private struct LevelWaveform: View {
    let active: Bool
    @State private var samples = WaveSamples()

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30, paused: !active)) { context in
            Canvas { gc, size in
                let bar: CGFloat = 3, gap: CGFloat = 3
                let count = Int(size.width / (bar + gap))
                let levels = samples.tick(context.date, active: active, count: count)
                let mid = size.height / 2
                for (i, level) in levels.enumerated() {
                    let h = max(3, CGFloat(level) * size.height)
                    let x = size.width - CGFloat(levels.count - i) * (bar + gap)
                    let rect = CGRect(x: x, y: mid - h / 2, width: bar, height: h)
                    let fade = Double(i) / Double(max(1, levels.count))
                    gc.fill(Path(roundedRect: rect, cornerRadius: bar / 2),
                            with: .color(.red.opacity(active ? 0.35 + 0.65 * fade : 0.25)))
                }
            }
        }
        .accessibilityLabel("Microphone level")
    }
}

private final class WaveSamples {
    private var levels: [Float] = []
    private var last = Date.distantPast

    func tick(_ now: Date, active: Bool, count: Int) -> [Float] {
        if active, now.timeIntervalSince(last) >= 1.0 / 20 {
            last = now
            // Lift quiet speech so slow, soft talking still reads as motion.
            levels.append(min(1, powf(max(0, MicLevel.current), 0.6)))
        }
        if levels.count > count { levels.removeFirst(levels.count - count) }
        return levels
    }
}

struct RecordingLibraryView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var recordings: [URL] = []
    @State private var player: AVAudioPlayer?
    @State private var error: String?
    @State private var playbackStatus = ""

    var body: some View {
        NavigationStack {
            List {
                if recordings.isEmpty { Text("Your recordings will appear here.").foregroundStyle(.secondary) }
                if let error { Text(error).foregroundStyle(.orange) }
                if !playbackStatus.isEmpty { Text(playbackStatus).accessibilityIdentifier("recording-playback-status") }
                ForEach(recordings, id: \.self) { url in
                    VStack(alignment: .leading, spacing: 12) {
                        let date = (try? url.resourceValues(forKeys: [.creationDateKey]))?.creationDate ?? .distantPast
                        Text(date, format: .dateTime.month().day().hour().minute()).font(.headline)
                        let textURL = url.deletingPathExtension().appendingPathExtension("txt")
                        if let text = try? String(contentsOf: textURL, encoding: .utf8), !text.isEmpty {
                            Text(text).lineLimit(4).textSelection(.enabled)
                            ShareLink("Share transcript", item: textURL)
                        }
                        HStack {
                            Button("Play audio") {
                                do {
                                    try AVAudioSession.sharedInstance().setCategory(.playback)
                                    try AVAudioSession.sharedInstance().setActive(true)
                                    player = try AVAudioPlayer(contentsOf: url)
                                    guard player?.play() == true else { throw CocoaError(.fileReadCorruptFile) }
                                    playbackStatus = "Playing recording"
                                } catch { self.error = "Couldn't play this recording." }
                            }.buttonStyle(.borderless)
                            Button("Stop playback") { player?.stop(); playbackStatus = "" }.buttonStyle(.borderless)
                            ShareLink("Share audio", item: url)
                        }
                    }.padding(.vertical, 8)
                }
                .onDelete { offsets in
                    player?.stop()
                    for index in offsets {
                        let url = recordings[index]
                        do {
                            try FileManager.default.removeItem(at: url)
                            let text = url.deletingPathExtension().appendingPathExtension("txt")
                            if FileManager.default.fileExists(atPath: text.path) { try FileManager.default.removeItem(at: text) }
                        } catch { self.error = "Couldn't delete this recording." }
                    }
                    reload()
                }
            }
            .navigationTitle("Recordings")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .onAppear { reload() }
            .onDisappear {
                player?.stop()
                try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            }
        }
    }

    private func reload() {
        guard let directory = try? RecordingFeed.directory() else { return }
        recordings = ((try? FileManager.default.contentsOfDirectory(at: directory,
            includingPropertiesForKeys: [.creationDateKey])) ?? [])
            .filter { ["caf", "m4a"].contains($0.pathExtension) }
            .sorted {
                let a = (try? $0.resourceValues(forKeys: [.creationDateKey]))?.creationDate ?? .distantPast
                let b = (try? $1.resourceValues(forKeys: [.creationDateKey]))?.creationDate ?? .distantPast
                return a > b
            }
    }
}
