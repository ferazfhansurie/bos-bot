import Foundation
import UserNotifications
import UIKit
import Intents

extension Notification.Name { static let sharedRoomPushTapped = Notification.Name("bos.sharedRoomPushTapped") }
import CompanionCore

/// The on-device notification surface. Delivery comes from live or replayed
/// companion frames; a future APNs relay can feed the same categories and
/// userInfo without changing the rest of the app.
final class NotificationCoordinator: NSObject, UNUserNotificationCenterDelegate {
    static let shared = NotificationCoordinator()
    private let center = UNUserNotificationCenter.current()
    /// Set by `Session`; kept as an id-only value so the notification layer
    /// does not know about SwiftUI navigation or mutable fleet state.
    var responseHandler: ((NotificationTarget) -> Void)?
    var pushTokenHandler: ((String) -> Void)?
    var sharedRoomHandler: ((String, String?) -> Void)?
    var foregroundPresentation: (@MainActor (NotificationTarget) -> NotificationPresentation)?
    var foregroundSharedPresentation: (@MainActor (String, String?) -> NotificationPresentation)?
    var foregroundVoicePresentation: (@MainActor (VoicePush) -> NotificationPresentation)?
    /// BOS 2.0 cloud rooms. A tap that launches the app arrives before any
    /// view sets the handler; it waits in `pendingCloudHint` until one does.
    var cloudHintHandler: (@MainActor (CloudPushHint) -> Void)? {
        didSet { if let hint = pendingCloudHint, let cloudHintHandler { pendingCloudHint = nil; Task { @MainActor in cloudHintHandler(hint) } } }
    }
    var foregroundCloudPresentation: (@MainActor (CloudPushHint) -> NotificationPresentation)?
    var cloudTokenHandler: ((Data) -> Void)?
    private(set) var pendingCloudHint: CloudPushHint?
    /// Voice pushes: "call back" or a tap on a done push, Accept on a ring.
    /// A launch-tap waits here like the cloud hint does.
    var voiceHandler: (@MainActor (VoiceNotificationAction) -> Void)? {
        didSet { if let action = pendingVoiceAction, let voiceHandler { pendingVoiceAction = nil; Task { @MainActor in voiceHandler(action) } } }
    }
    private var pendingVoiceAction: VoiceNotificationAction?
    /// The last APNs token this launch, for a handler set after it arrived.
    private(set) var deviceToken: Data?
    private var replay = NotificationReplayLedger(ids: UserDefaults.standard.stringArray(forKey: "bos.notificationReplayIDs") ?? [])

    private override init() {
        super.init()
        center.delegate = self
        center.setNotificationCategories([
            UNNotificationCategory(identifier: VoicePush.workDoneCategory, actions: [
                UNNotificationAction(identifier: VoicePush.callBackAction, title: "Call back",
                                     options: [.foreground], icon: UNNotificationActionIcon(systemImageName: "phone.fill")),
            ], intentIdentifiers: []),
            UNNotificationCategory(identifier: VoicePush.ringCategory, actions: [
                UNNotificationAction(identifier: VoicePush.acceptAction, title: "Accept",
                                     options: [.foreground], icon: UNNotificationActionIcon(systemImageName: "phone.fill")),
                UNNotificationAction(identifier: VoicePush.declineAction, title: "Decline",
                                     options: [.destructive], icon: UNNotificationActionIcon(systemImageName: "phone.down.fill")),
            ], intentIdentifiers: []),
            // no actions: these exist so the content extension's live face
            // answers to them (UNNotificationExtensionCategory)
            UNNotificationCategory(identifier: BotNotificationCategory.update, actions: [], intentIdentifiers: []),
            UNNotificationCategory(identifier: BotNotificationCategory.approval, actions: [], intentIdentifiers: []),
            UNNotificationCategory(identifier: BotNotificationCategory.bot, actions: [], intentIdentifiers: []),
        ])
    }

    func authorizationStatus() async -> UNAuthorizationStatus {
        await center.notificationSettings().authorizationStatus
    }

    func requestAuthorization() async -> Bool {
        let allowed = (try? await center.requestAuthorization(options: [.alert, .badge, .sound])) == true
        if allowed { await MainActor.run { UIApplication.shared.registerForRemoteNotifications() } }
        return allowed
    }

    func deliver(_ notification: NotificationFrame, sequence: Int?, connectionId: String,
                 requestId: String? = nil, messageId: String? = nil) {
        let voiceDone = notification.kind == "voice_work_done"
        let identifier = voiceDone
            ? "voice-done.\(connectionId).\(messageId ?? notification.callId ?? notification.threadId)"
            : "openmaus.\(connectionId).\(notification.threadId).\(sequence.map(String.init) ?? requestId ?? notification.title)"
        guard replay.insert(identifier) else { return }
        UserDefaults.standard.set(replay.ids, forKey: "bos.notificationReplayIDs")
        let content = UNMutableNotificationContent()
        content.title = notification.title
        content.body = notification.body
        content.sound = .default
        content.categoryIdentifier = voiceDone ? VoicePush.workDoneCategory
            : notification.isBlocking ? "OPENMAUS_APPROVAL" : "OPENMAUS_UPDATE"
        content.threadIdentifier = notification.threadId
        content.userInfo = [
            "threadId": notification.threadId,
            "botId": notification.botId,
            "kind": notification.kind,
            "connectionId": connectionId,
        ]
        if let requestId { content.userInfo["requestId"] = requestId }
        if let messageId { content.userInfo["messageId"] = messageId }
        if let callId = notification.callId { content.userInfo["callId"] = callId }
        if notification.isBlocking { content.interruptionLevel = .timeSensitive }

        // A replay after a short disconnect must reconcile a missed alert,
        // but a repeated frame must not draw it twice. The banner wears the
        // bot's face in the mood of what it said, like a push does.
        let mood = NotificationMood.glyph(kind: notification.kind, title: notification.title, body: notification.body)
        Self.withSenderFace(content, senderID: "bot:\(notification.botId)", name: notification.title, mood: mood) { [center] final in
            center.add(UNNotificationRequest(identifier: identifier, content: final, trigger: nil))
        }
    }

    /// The communication-style banner: the sender's face instead of the app
    /// icon. Falls back to the plain content when no face was drawn.
    private static func withSenderFace(_ content: UNMutableNotificationContent, senderID: String, name: String, mood: String,
                                       then deliver: @escaping (UNNotificationContent) -> Void) {
        guard let imageURL = NotificationAvatarCache.bestURL(for: senderID, mood: mood),
              FileManager.default.fileExists(atPath: imageURL.path) else { deliver(content); return }
        let sender = INPerson(personHandle: INPersonHandle(value: senderID, type: .unknown),
                              nameComponents: nil, displayName: name, image: INImage(url: imageURL),
                              contactIdentifier: nil, customIdentifier: senderID, isMe: false, suggestionType: .none)
        let intent = INSendMessageIntent(recipients: nil, outgoingMessageType: .outgoingMessageText,
                                         content: content.body, speakableGroupName: nil,
                                         conversationIdentifier: content.threadIdentifier,
                                         serviceName: "BOS", sender: sender, attachments: nil)
        intent.setImage(INImage(url: imageURL), forParameterNamed: \INSendMessageIntent.sender)
        let interaction = INInteraction(intent: intent, response: nil)
        interaction.direction = .incoming
        interaction.donate { _ in deliver((try? content.updating(from: intent)) ?? content) }
    }

    /// A done push for a call that is still live: the call already says it,
    /// so a banner that slipped through (screen locked mid-call) goes away.
    func removeVoiceDone(callId: String) {
        center.getDeliveredNotifications { [center] delivered in
            let ids = delivered.filter { ($0.request.content.userInfo["callId"] as? String) == callId }
                .map(\.request.identifier)
            if !ids.isEmpty { center.removeDeliveredNotifications(withIdentifiers: ids) }
        }
    }

    /// Accept on a CallKit ring: the same path as Accept on the ring push.
    @MainActor func acceptRing(_ ring: VoiceRing, connectionId: String?) {
        let action = VoiceNotificationAction.accept(ring, connectionId: connectionId)
        if let voiceHandler { voiceHandler(action) } else { pendingVoiceAction = action }
    }

    func receivedDeviceToken(_ token: Data) {
        deviceToken = token
        cloudTokenHandler?(token)
    }

    func setBadge(_ count: Int) {
        center.setBadgeCount(max(0, count))
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        let payload = Self.strings(notification.request.content.userInfo)
        Task { @MainActor in
            let presentation: NotificationPresentation
            if let push = VoicePush(payload: payload) {
                presentation = foregroundVoicePresentation?(push) ?? .alert
            } else if let hint = CloudPushHint(userInfo: notification.request.content.userInfo) {
                presentation = foregroundCloudPresentation?(hint) ?? .quiet
            } else if let roomID = payload["roomId"] {
                presentation = foregroundSharedPresentation?(roomID, payload["connectionId"]) ?? .quiet
            } else if let target = NotificationTarget(payload: payload) {
                presentation = foregroundPresentation?(target) ?? .quiet
            } else {
                presentation = .quiet
            }
            switch presentation {
            case .quiet: completionHandler([])
            case .list: completionHandler([.list])
            case .alert: completionHandler([.banner, .list, .sound])
            }
        }
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let strings = Self.strings(response.notification.request.content.userInfo)
        if let push = VoicePush(payload: strings),
           let action = VoiceNotificationAction(push: push, actionIdentifier: response.actionIdentifier,
                                                body: response.notification.request.content.body, payload: strings) {
            if let voiceHandler { Task { @MainActor in voiceHandler(action) } } else { pendingVoiceAction = action }
        } else if let hint = CloudPushHint(userInfo: response.notification.request.content.userInfo) {
            if let cloudHintHandler { Task { @MainActor in cloudHintHandler(hint) } } else { pendingCloudHint = hint }
        } else if let roomID = strings["roomId"] { sharedRoomHandler?(roomID, strings["connectionId"]) }
        else if let target = NotificationTarget(payload: strings) { responseHandler?(target) }
        completionHandler()
    }

    private static func strings(_ userInfo: [AnyHashable: Any]) -> [String: String] {
        userInfo.reduce(into: [String: String]()) { result, pair in
            guard let key = pair.key as? String, let value = pair.value as? String else { return }
            result[key] = value
        }
    }
}
// branding compatibility (electron/branding-compat.json): notification-identity: posted phone notification and service intents keep their identity; ios-notification-category: already delivered phone notifications retain their registered action categories

/// What a person did with a voice push.
enum VoiceNotificationAction {
    /// "Call back" on a done push: open the thread and call, opening with
    /// the result.
    case callBack(NotificationTarget, result: String)
    /// A plain tap on a done push: open the thread.
    case open(NotificationTarget)
    /// Accept on a ring, or a tap on it.
    case accept(VoiceRing, connectionId: String?)

    init?(push: VoicePush, actionIdentifier: String, body: String, payload: [String: String]) {
        switch push {
        case let .workDone(botId, threadId, _, messageId):
            guard let target = NotificationTarget(botId: botId, threadId: threadId, connectionId: payload["connectionId"],
                                                  messageId: messageId, kind: "voice_work_done") else { return nil }
            switch actionIdentifier {
            case VoicePush.callBackAction: self = .callBack(target, result: body)
            case UNNotificationDismissActionIdentifier: return nil
            default: self = .open(target)
            }
        case let .ring(ring):
            switch actionIdentifier {
            case VoicePush.declineAction, UNNotificationDismissActionIdentifier: return nil
            default: self = .accept(ring, connectionId: payload["connectionId"])
            }
        }
    }
}
