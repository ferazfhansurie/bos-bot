// A bot ringing its owner as a real phone call: a PushKit VoIP push wakes the
// app (even killed), it reports the ring to CallKit at once, and iOS draws
// the incoming call full screen over any app and on the lock screen.
//
// iOS kills an app that takes a VoIP push without reporting a call, and stops
// delivering them after a few, so every push is reported, even an unreadable
// one (it is ended straight away). Accept runs the same path as Accept on the
// ring notification; the answered CallKit call then lives as long as the
// realtime call and ends with it.
import AVFoundation
import CallKit
import CompanionCore
import PushKit

@MainActor
final class CallKitRinger: NSObject {
    static let shared = CallKitRinger()

    private struct PendingRing {
        let ring: VoiceRing
        let connectionId: String?
    }

    private let registry = PKPushRegistry(queue: .main)
    private let provider: CXProvider
    private var rings: [UUID: PendingRing] = [:]
    private var reportedRingIds = Set<String>()
    /// The CallKit call carrying the live realtime call, once answered.
    private var answered: UUID?
    /// An answer waiting for CallKit to hand over the audio session.
    private var pendingAnswer: (UUID, PendingRing)?

    static let tokenKey = "bos.voipToken"
    /// Sent next to the APNs token; nil until PushKit hands one over.
    var voipToken: String? { UserDefaults.standard.string(forKey: Self.tokenKey) }
    var tokenHandler: ((String) -> Void)?

    private override init() {
        let configuration = CXProviderConfiguration()
        configuration.supportsVideo = false
        configuration.maximumCallGroups = 1
        configuration.maximumCallsPerCallGroup = 1
        configuration.supportedHandleTypes = [.generic]
        configuration.includesCallsInRecents = false
        provider = CXProvider(configuration: configuration)
        super.init()
        provider.setDelegate(self, queue: .main)
    }

    /// At launch, before it ends: a VoIP push that launched the app is
    /// delivered as soon as the registry has a delegate.
    func start() {
        registry.delegate = self
        registry.desiredPushTypes = [.voIP]
    }

    /// The server rings this phone through CallKit, so an in-app ring for the
    /// same ringId should wait for it rather than ring twice.
    var ringsThroughCallKit: Bool { voipToken != nil }
    func reported(_ ringId: String) -> Bool { reportedRingIds.contains(ringId) }

    // MARK: Incoming

    private func report(_ payload: [AnyHashable: Any], completion: @escaping () -> Void) {
        let strings = payload.reduce(into: [String: String]()) { result, pair in
            if let key = pair.key as? String, let value = pair.value as? String { result[key] = value }
        }
        let uuid = UUID()
        let update = CXCallUpdate()
        update.hasVideo = false
        update.supportsHolding = false
        update.supportsGrouping = false
        update.supportsUngrouping = false
        update.supportsDTMF = false
        guard case let .ring(ring)? = VoicePush(payload: strings) else {
            update.localizedCallerName = "BOS Bot"
            provider.reportNewIncomingCall(with: uuid, update: update) { [provider] _ in
                provider.reportCall(with: uuid, endedAt: nil, reason: .failed)
                completion()
            }
            return
        }
        let name = strings["botName"].flatMap { $0.isEmpty ? nil : $0 } ?? "BOS Bot"
        update.remoteHandle = CXHandle(type: .generic, value: name)
        update.localizedCallerName = name
        let busy = VoiceCallCenter.shared.liveCallId != nil || reportedRingIds.contains(ring.ringId)
        reportedRingIds.insert(ring.ringId)
        if !busy { rings[uuid] = PendingRing(ring: ring, connectionId: strings["connectionId"]) }
        // An in-app ring for the same call stops; CallKit has it now.
        VoiceCallCenter.shared.markRingAnswered(ring.ringId)
        provider.reportNewIncomingCall(with: uuid, update: update) { [weak self] error in
            MainActor.assumeIsolated {
                guard let self else { return completion() }
                if error != nil || busy {
                    // Do Not Disturb, a blocked caller, or already on a call:
                    // the ring is a missed call, never a second call.
                    self.rings[uuid] = nil
                    if error == nil { self.provider.reportCall(with: uuid, endedAt: nil, reason: .unanswered) }
                } else {
                    self.expire(uuid)
                }
                completion()
            }
        }
    }

    /// Unanswered rings stop on their own, like the in-app ring.
    private func expire(_ uuid: UUID) {
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(30))
            guard let self, self.rings[uuid] != nil, self.answered != uuid else { return }
            self.rings[uuid] = nil
            self.provider.reportCall(with: uuid, endedAt: nil, reason: .unanswered)
        }
    }

    // MARK: Answered call

    private func answer(_ uuid: UUID, _ pending: PendingRing) {
        pendingAnswer = nil
        NotificationCoordinator.shared.acceptRing(pending.ring, connectionId: pending.connectionId)
        // The computer may be unreachable: never leave a silent call up.
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(25))
            guard let self, self.answered == uuid, VoiceCallCenter.shared.call == nil else { return }
            self.answered = nil
            self.provider.reportCall(with: uuid, endedAt: nil, reason: .failed)
        }
    }

    /// The realtime call ended in the app (hung up, bot ended, failed).
    func callEnded(failed: Bool) {
        guard let uuid = answered else { return }
        answered = nil
        provider.reportCall(with: uuid, endedAt: nil, reason: failed ? .failed : .remoteEnded)
    }
}

extension CallKitRinger: PKPushRegistryDelegate {
    nonisolated func pushRegistry(_ registry: PKPushRegistry, didUpdate pushCredentials: PKPushCredentials, for type: PKPushType) {
        let token = pushCredentials.token.map { String(format: "%02x", $0) }.joined()
        MainActor.assumeIsolated {
            UserDefaults.standard.set(token, forKey: Self.tokenKey)
            tokenHandler?(token)
        }
    }

    nonisolated func pushRegistry(_ registry: PKPushRegistry, didInvalidatePushTokenFor type: PKPushType) {
        MainActor.assumeIsolated { UserDefaults.standard.removeObject(forKey: Self.tokenKey) }
    }

    nonisolated func pushRegistry(_ registry: PKPushRegistry, didReceiveIncomingPushWith payload: PKPushPayload,
                                  for type: PKPushType, completion: @escaping () -> Void) {
        let dictionary = payload.dictionaryPayload
        MainActor.assumeIsolated { report(dictionary, completion: completion) }
    }
}

extension CallKitRinger: CXProviderDelegate {
    nonisolated func providerDidReset(_ provider: CXProvider) {
        MainActor.assumeIsolated {
            rings = [:]
            pendingAnswer = nil
            if answered != nil {
                answered = nil
                VoiceCallCenter.shared.call?.hangUp()
            }
        }
    }

    nonisolated func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
        MainActor.assumeIsolated {
            guard let pending = rings.removeValue(forKey: action.callUUID) else { return action.fail() }
            answered = action.callUUID
            // CallKit activates the session it is given; the realtime call's
            // audio engine starts once it has (didActivate), not before.
            try? AVAudioSession.sharedInstance().setCategory(.playAndRecord, mode: .voiceChat,
                                                             options: [.defaultToSpeaker, .allowBluetoothHFP])
            pendingAnswer = (action.callUUID, pending)
            action.fulfill()
            let uuid = action.callUUID
            Task { [weak self] in
                try? await Task.sleep(for: .seconds(2))
                guard let self, let waiting = self.pendingAnswer, waiting.0 == uuid else { return }
                self.answer(uuid, waiting.1)
            }
        }
    }

    nonisolated func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
        MainActor.assumeIsolated {
            guard let (uuid, pending) = pendingAnswer else { return }
            answer(uuid, pending)
        }
    }

    nonisolated func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
        MainActor.assumeIsolated {
            rings[action.callUUID] = nil
            if pendingAnswer?.0 == action.callUUID { pendingAnswer = nil }
            if answered == action.callUUID {
                answered = nil
                VoiceCallCenter.shared.call?.hangUp()
            }
            action.fulfill()
        }
    }

    nonisolated func provider(_ provider: CXProvider, perform action: CXSetMutedCallAction) {
        MainActor.assumeIsolated {
            if let call = VoiceCallCenter.shared.call, !call.isOver, call.muted != action.isMuted { call.toggleMute() }
            action.fulfill()
        }
    }
}
