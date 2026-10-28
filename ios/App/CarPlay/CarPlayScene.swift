// BOS on the car screen: open it and you are on a call with bos.
//
// A CarPlay voice-based conversational app (iOS 26.4) on the voice control
// template. The call is the phone's own RealtimeVoiceCall through
// VoiceCallCenter; this file only shows it and gives it four controls:
// switch bot (keeps the call), "need me?", mute and end. It never touches
// the audio session, so the call's mic choice (the phone's own mic first)
// stands. What to show is decided in CompanionCore's CarVoice.
//
// The scene only connects in builds signed with the CarPlay entitlement
// (BOS_CARPLAY=1, see project.yml); without it CarPlay never launches the
// app and nothing here runs.
import AVFoundation
import CarPlay
import Combine
import CompanionCore
import UIKit

@objc(CarPlaySceneDelegate)
@MainActor
final class CarPlaySceneDelegate: UIResponder, CPTemplateApplicationSceneDelegate {
    private var screen: AnyObject?

    func templateApplicationScene(_ templateApplicationScene: CPTemplateApplicationScene,
                                  didConnect interfaceController: CPInterfaceController) {
        if #available(iOS 26.4, *) {
            let screen = CarCallScreen(interface: interfaceController, session: .main)
            self.screen = screen
            screen.open()
        } else {
            let note = CPInformationTemplate(title: "bos", layout: .leading,
                                             items: [CPInformationItem(title: "update your iphone", detail: "talking to bos in the car needs iOS 26.4.")],
                                             actions: [])
            interfaceController.setRootTemplate(note, animated: false, completion: nil)
        }
    }

    func templateApplicationScene(_ templateApplicationScene: CPTemplateApplicationScene,
                                  didDisconnectInterfaceController interfaceController: CPInterfaceController) {
        if #available(iOS 26.4, *) { (screen as? CarCallScreen)?.close() }
        screen = nil
    }

    // The car screen counts as the app being open: the phone window going
    // to the background doesn't put the homes down while it's up
    // (CompanionApp), and it brings them back itself.
    func sceneDidBecomeActive(_ scene: UIScene) {
        Session.main.connectHomes()
    }

    func sceneDidEnterBackground(_ scene: UIScene) {
        if !CarPlayPresence.phoneOnScreen { Session.main.lingerHomes() }
    }
}

enum CarPlayPresence {
    /// A car screen is up and in front.
    @MainActor static var carOnScreen: Bool {
        UIApplication.shared.connectedScenes.contains { $0 is CPTemplateApplicationScene && $0.activationState == .foregroundActive }
    }

    /// The phone's own window is up and in front.
    @MainActor static var phoneOnScreen: Bool {
        UIApplication.shared.connectedScenes.contains { $0 is UIWindowScene && $0.activationState == .foregroundActive }
    }
}

@available(iOS 26.4, *)
@MainActor
final class CarCallScreen {
    private let interface: CPInterfaceController
    private let session: Session
    private let center = VoiceCallCenter.shared

    private var sinks = Set<AnyCancellable>()
    private var callSinks = Set<AnyCancellable>()
    private var watched: RealtimeVoiceCall?
    /// Dialing: the bot being called before its call exists (nil face while
    /// the roster loads).
    private var dialing: CarFace??
    private var job: (event: CarJobEvent, at: Date)?
    private var holdTimer: Timer?
    private var closed = false

    private var voice: CPVoiceControlTemplate?
    private var voiceStates: [CPVoiceControlState] = []
    private var voiceFace: CarFace?
    private var voiceSet: [CarVoiceState]?
    private var voiceMuted: Bool?
    private var voiceNext: String?
    private var shown: CarVoiceState?
    private var presented = false
    private var idleShown = false
    private var chime: AVAudioPlayer?

    init(interface: CPInterfaceController, session: Session) {
        self.interface = interface
        self.session = session
    }

    private var scale: CGFloat { max(interface.carTraitCollection.displayScale, 1) }
    private var dark: Bool { interface.carTraitCollection.userInterfaceStyle != .light }

    // MARK: Lifecycle

    func open() {
        session.connectHomes()
        NotificationCenter.default.publisher(for: RealtimeVoiceCall.jobEvent)
            .sink { [weak self] note in self?.jobEvent(note) }
            .store(in: &sinks)
        center.$call
            .sink { [weak self] call in
                // $call fires before the property is set; read it after
                DispatchQueue.main.async { self?.watch(call) }
            }
            .store(in: &sinks)
        // straight into a call: the live one if there is one, else bos
        if let call = center.call, !call.isOver { watch(call) } else { dial(nil) }
    }

    /// The car went away. The call goes on if the phone is open in front of
    /// them; otherwise nothing is left on screen to end it, so it ends here.
    func close() {
        closed = true
        sinks = []
        callSinks = []
        holdTimer?.invalidate()
        if !CarPlayPresence.phoneOnScreen, let call = center.call, !call.isOver { call.hangUp() }
    }

    // MARK: Calls

    private var allBots: [Bot] {
        session.state.bots + session.satellites.flatMap(\.state.bots)
    }

    private func dial(_ bot: Bot?, swap: Bool = false) {
        let target = bot ?? CarVoice.firstBot(in: allBots)
        dialing = .some(target.map(CarFace.init))
        job = nil
        render()
        center.swapsNextCallTo = swap ? target?.id : nil
        Task { [weak self, session] in
            await session.callFromShortcut(botId: target?.id, name: target?.name ?? CarVoice.rotation[0])
            guard let self else { return }
            if swap, self.center.swapsNextCallTo == target?.id { self.center.swapsNextCallTo = nil }
            // no call came of it (bot missing, on another mac): back to the list
            if self.center.call == nil || self.center.call?.isOver == true {
                self.dialing = nil
                self.render()
            }
        }
    }

    private func watch(_ call: RealtimeVoiceCall?) {
        guard !closed else { return }
        if watched !== call {
            watched = call
            callSinks = []
            job = nil
            if let call {
                if case let .some(face) = dialing, face == nil || face?.id == call.bot.id { dialing = nil }
                call.objectWillChange
                    .receive(on: RunLoop.main)
                    .sink { [weak self] _ in self?.render() }
                    .store(in: &callSinks)
            }
        }
        render()
    }

    private func jobEvent(_ note: Notification) {
        guard let info = note.userInfo, let callId = info["callId"] as? String, callId == watched?.callId,
              let event = info["event"] as? String else { return }
        switch event {
        case "sending": job = (.sending, Date())
        case "saved": job = (.saved, Date()); playSaved()
        case "saved-offline": job = (.savedOffline, Date()); playSaved()
        case "failed": job = (.failed, Date())
        default: return
        }
        render()
    }

    // MARK: Buttons

    private func switchBot() {
        guard let call = watched, !call.isOver else { return }
        guard let next = CarVoice.nextBot(after: call.bot, in: allBots) else { return }
        dial(next, swap: true)
    }

    private func needMe() {
        guard let call = watched, !call.isOver else { return }
        call.ask(CarVoice.needMeInstructions(crossBotAttentionThreads(allBots)))
    }

    private func toggleMute() {
        watched?.toggleMute()
    }

    private func end() {
        dialing = nil
        watched?.hangUp()
        render()
    }

    // MARK: Drawing

    private func render() {
        guard !closed else { return }
        holdTimer?.invalidate()
        holdTimer = nil
        let now = Date()
        let face: CarFace
        let moment: CarVoiceMoment
        if case let .some(target) = dialing {
            face = target ?? watched.map { CarFace($0.bot) } ?? .placeholder
            moment = CarVoiceMoment(phase: .connecting, activity: .idle)
        } else if let call = watched, !call.isOver {
            face = CarFace(call.bot)
            moment = CarVoiceMoment(phase: Self.phase(call.phase), activity: Self.activity(call.activity),
                                    job: job?.event, jobAt: job?.at)
        } else {
            showIdle()
            return
        }
        guard let state = CarVoice.state(for: moment, now: now) else { showIdle(); return }
        show(state, face: face, muted: watched?.muted == true)
        if let next = CarVoice.nextCheck(for: moment), next > now {
            holdTimer = Timer.scheduledTimer(withTimeInterval: next.timeIntervalSince(now) + 0.05, repeats: false) { [weak self] _ in
                MainActor.assumeIsolated { self?.render() }
            }
        }
    }

    private func show(_ state: CarVoiceState, face: CarFace, muted: Bool) {
        let set = CarVoice.set(for: state, current: voiceFace == face ? voiceSet : nil)
        let nextName = (watched.flatMap { CarVoice.nextBot(after: $0.bot, in: allBots) })?.name.lowercased()
        if voice == nil || idleShown || voiceFace != face || voiceSet != set {
            build(set, face: face, muted: muted, nextName: nextName)
            let template = voice!
            presented = false
            idleShown = false
            shown = state
            interface.setRootTemplate(template, animated: false) { [weak self] _, _ in
                MainActor.assumeIsolated {
                    guard let self, self.voice === template else { return }
                    self.presented = true
                    if let shown = self.shown { template.activateVoiceControlState(withIdentifier: shown.rawValue) }
                }
            }
            return
        }
        if voiceMuted != muted { setActions(muted: muted) }
        if voiceNext != nextName { setNavigation(nextName: nextName) }
        if shown != state {
            shown = state
            if presented { voice?.activateVoiceControlState(withIdentifier: state.rawValue) }
        }
    }

    private func build(_ set: [CarVoiceState], face: CarFace, muted: Bool, nextName: String?) {
        voiceStates = set.map { state in
            CPVoiceControlState(identifier: state.rawValue, titleVariants: state.titles(botName: face.name),
                                image: CarMascotImages.image(face, state: state, scale: scale, dark: dark),
                                repeats: state.repeats)
        }
        voice = CPVoiceControlTemplate(voiceControlStates: voiceStates)
        voiceFace = face
        voiceSet = set
        setActions(muted: muted)
        setNavigation(nextName: nextName)
    }

    /// Mute and end: the two big targets.
    private func setActions(muted: Bool) {
        voiceMuted = muted
        let mute = CPButton(image: Self.symbol(muted ? "mic.slash.fill" : "mic.fill")) { [weak self] _ in
            MainActor.assumeIsolated { self?.toggleMute() }
        }
        mute.title = muted ? "unmute" : "mute"
        let end = CPButton(image: Self.symbol("phone.down.fill")) { [weak self] _ in
            MainActor.assumeIsolated { self?.end() }
        }
        end.title = "end"
        let buttons = Array([mute, end].prefix(max(0, CPVoiceControlState.maximumActionButtonCount)))
        for state in voiceStates { state.actionButtons = buttons }
    }

    /// Switch bot on the left (named for who you get), "need me?" on the right.
    private func setNavigation(nextName: String?) {
        voiceNext = nextName
        guard let voice else { return }
        let live = watched.map { !$0.isOver } ?? false
        let swap = CPBarButton(title: nextName.map { "→ \($0)" } ?? "switch") { [weak self] _ in
            MainActor.assumeIsolated { self?.switchBot() }
        }
        swap.isEnabled = live && nextName != nil
        let need = CPBarButton(title: "need me?") { [weak self] _ in
            MainActor.assumeIsolated { self?.needMe() }
        }
        need.isEnabled = live
        voice.leadingNavigationBarButtons = [swap]
        voice.trailingNavigationBarButtons = [need]
    }

    /// Between calls: one row per bot in the rotation; a tap calls it.
    private func showIdle() {
        guard !idleShown else { return }
        idleShown = true
        shown = nil
        let failed: Bool = { if case .failed = watched?.phase { return true }; return false }()
        let bots = CarVoice.rotation.compactMap { name in allBots.first { $0.hidden != true && $0.name.lowercased() == name } }
        let rows = (bots.isEmpty ? [nil] : bots.map { Optional($0) }).map { bot -> CPListItem in
            let face = bot.map(CarFace.init) ?? .placeholder
            let item = CPListItem(text: "talk to \(face.name.lowercased())", detailText: nil,
                                  image: CarMascotImages.still(face, scale: scale, dark: dark))
            item.handler = { [weak self] _, done in
                MainActor.assumeIsolated { self?.dial(bot) }
                done()
            }
            return item
        }
        let list = CPListTemplate(title: "bos", sections: [CPListSection(items: rows, header: failed ? "call dropped" : nil, sectionIndexTitle: nil)])
        interface.setRootTemplate(list, animated: false, completion: nil)
    }

    // MARK: Sound

    /// A short rising two-note chime: the job is saved, from across the car.
    private func playSaved() {
        guard let url = Bundle.main.url(forResource: "bos-job-saved", withExtension: "caf") else { return }
        chime = try? AVAudioPlayer(contentsOf: url)
        chime?.volume = 0.8
        chime?.play()
    }

    // MARK: Mapping

    private static func phase(_ phase: RealtimeVoiceCall.Phase) -> CarCallPhase {
        switch phase {
        case .connecting: return .connecting
        case .live: return .live
        case .reconnecting: return .reconnecting
        case .ended: return .ended
        case .failed: return .failed
        }
    }

    private static func activity(_ activity: RealtimeVoiceCall.Activity) -> CarCallActivity {
        switch activity {
        case .idle: return .idle
        case .listening: return .listening
        case .thinking: return .thinking
        case .speaking: return .speaking
        }
    }

    private static func symbol(_ name: String) -> UIImage {
        let config = UIImage.SymbolConfiguration(pointSize: 26, weight: .semibold)
        return UIImage(systemName: name, withConfiguration: config) ?? UIImage()
    }
}
