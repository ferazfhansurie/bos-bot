import Foundation
import Intents
import UserNotifications

final class NotificationService: UNNotificationServiceExtension {
    private var completion: ((UNNotificationContent) -> Void)?
    private var fallback: UNNotificationContent?

    override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        completion = contentHandler
        let content = Self.withBotCategory(Self.withAnswerCategory(Self.withVoiceCategory(request.content)))
        fallback = content
        // the sender's face in the mood of what it said, when the app drew it
        let mood = NotificationMood.glyph(kind: (content.userInfo["type"] as? String) ?? (content.userInfo["kind"] as? String),
                                          title: content.title, body: content.body)
        guard let senderID = content.userInfo["senderId"] as? String,
              let senderName = content.userInfo["senderName"] as? String,
              let data = NotificationAvatarCache.faceData(for: senderID, mood: mood) else {
            contentHandler(content)
            return
        }
        let image = INImage(imageData: data)
        let sender = INPerson(personHandle: INPersonHandle(value: senderID, type: .unknown),
                              nameComponents: nil, displayName: senderName,
                              image: image, contactIdentifier: nil,
                              customIdentifier: senderID, isMe: false, suggestionType: .none)
        let intent = INSendMessageIntent(recipients: nil, outgoingMessageType: .outgoingMessageText,
                                         content: content.body, speakableGroupName: nil,
                                         conversationIdentifier: content.threadIdentifier,
                                         serviceName: "BOS", sender: sender, attachments: nil)
        intent.setImage(image, forParameterNamed: \INSendMessageIntent.sender)
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

    /// bos bot 3.0: a Mac with the labs switch on marks a tool approval the
    /// phone may answer, and it gets Allow (behind Face ID) and Deny on the
    /// banner. A push without the mark stays a plain bot push.
    private static func withAnswerCategory(_ content: UNNotificationContent) -> UNNotificationContent {
        guard content.categoryIdentifier.isEmpty,
              content.userInfo["answer"] as? String == "permission",
              content.userInfo["requestId"] is String, content.userInfo["threadId"] is String,
              let mutable = content.mutableCopy() as? UNMutableNotificationContent else { return content }
        mutable.categoryIdentifier = BotNotificationCategory.answerPermission
        return mutable
    }

    /// A bot's push without a category of its own gets the one the content
    /// extension answers to, so a long-press shows the bot's live face.
    private static func withBotCategory(_ content: UNNotificationContent) -> UNNotificationContent {
        guard content.categoryIdentifier.isEmpty,
              content.userInfo["botId"] is String || content.userInfo["senderId"] is String,
              let mutable = content.mutableCopy() as? UNMutableNotificationContent else { return content }
        mutable.categoryIdentifier = BotNotificationCategory.bot
        return mutable
    }

    override func serviceExtensionTimeWillExpire() {
        if let completion, let fallback { completion(fallback) }
        completion = nil
    }
}
