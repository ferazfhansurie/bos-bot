import Foundation
import Intents
import UserNotifications

final class NotificationService: UNNotificationServiceExtension {
    private var completion: ((UNNotificationContent) -> Void)?
    private var fallback: UNNotificationContent?

    override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        completion = contentHandler
        let content = Self.withVoiceCategory(request.content)
        fallback = content
        guard let senderID = content.userInfo["senderId"] as? String,
              let senderName = content.userInfo["senderName"] as? String,
              let imageURL = NotificationAvatarCache.url(for: senderID),
              FileManager.default.fileExists(atPath: imageURL.path) else {
            contentHandler(content)
            return
        }
        let sender = INPerson(personHandle: INPersonHandle(value: senderID, type: .unknown),
                              nameComponents: nil, displayName: senderName,
                              image: INImage(url: imageURL), contactIdentifier: nil,
                              customIdentifier: senderID, isMe: false, suggestionType: .none)
        let intent = INSendMessageIntent(recipients: nil, outgoingMessageType: .outgoingMessageText,
                                         content: content.body, speakableGroupName: nil,
                                         conversationIdentifier: content.threadIdentifier,
                                         serviceName: "BOS", sender: sender, attachments: nil)
        intent.setImage(INImage(url: imageURL), forParameterNamed: \INSendMessageIntent.sender)
        let interaction = INInteraction(intent: intent, response: nil)
        interaction.direction = .incoming
        interaction.donate { [weak self] _ in
            guard let self else { return }
            let updated = try? content.updating(from: intent)
            contentHandler(updated ?? content)
            self.completion = nil
        }
    }

    /// The server's done push for work asked on a voice call carries no
    /// category, and "Call back" needs one; a ring gets Accept/Decline even
    /// from a server that forgot it.
    private static func withVoiceCategory(_ content: UNNotificationContent) -> UNNotificationContent {
        let category: String
        switch content.userInfo["type"] as? String {
        case "voice_work_done": category = "VOICE_WORK_DONE"
        case "voice_ring": category = "VOICE_RING"
        default: return content
        }
        guard content.categoryIdentifier != category,
              let mutable = content.mutableCopy() as? UNMutableNotificationContent else { return content }
        mutable.categoryIdentifier = category
        return mutable
    }

    override func serviceExtensionTimeWillExpire() {
        if let completion, let fallback { completion(fallback) }
        completion = nil
    }
}
