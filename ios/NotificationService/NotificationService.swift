import Foundation
import Intents
import UserNotifications

final class NotificationService: UNNotificationServiceExtension {
    private var completion: ((UNNotificationContent) -> Void)?
    private var fallback: UNNotificationContent?

    override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        completion = contentHandler
        fallback = request.content
        guard let senderID = request.content.userInfo["senderId"] as? String,
              let senderName = request.content.userInfo["senderName"] as? String,
              let imageURL = NotificationAvatarCache.url(for: senderID),
              FileManager.default.fileExists(atPath: imageURL.path) else {
            contentHandler(request.content)
            return
        }
        let sender = INPerson(personHandle: INPersonHandle(value: senderID, type: .unknown),
                              nameComponents: nil, displayName: senderName,
                              image: INImage(url: imageURL), contactIdentifier: nil,
                              customIdentifier: senderID, isMe: false, suggestionType: .none)
        let intent = INSendMessageIntent(recipients: nil, outgoingMessageType: .outgoingMessageText,
                                         content: request.content.body, speakableGroupName: nil,
                                         conversationIdentifier: request.content.threadIdentifier,
                                         serviceName: "BOS", sender: sender, attachments: nil)
        intent.setImage(INImage(url: imageURL), forParameterNamed: \INSendMessageIntent.sender)
        let interaction = INInteraction(intent: intent, response: nil)
        interaction.direction = .incoming
        interaction.donate { [weak self] _ in
            guard let self else { return }
            let updated = try? request.content.updating(from: intent)
            contentHandler(updated ?? request.content)
            self.completion = nil
        }
    }

    override func serviceExtensionTimeWillExpire() {
        if let completion, let fallback { completion(fallback) }
        completion = nil
    }
}
