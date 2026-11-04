import UserNotifications
import Intents

/// Upcasts Jori pushes into communication notifications so iOS shows a sender
/// avatar, Siri announces them on AirPods, and the user can reply by voice.
///
/// Three things must line up or the upcast silently fails and we fall back to a
/// plain (non-announced) notification:
///   1. `IntentsSupported = [INSendMessageIntent]` in THIS extension's Info.plist.
///   2. The communication entitlement provisioned on this extension's App ID.
///   3. `contentHandler` called exactly once, AFTER the interaction is donated.
/// The NSLog in the catch makes a future regression visible in the device log.
class NotificationService: UNNotificationServiceExtension {
    private var contentHandler: ((UNNotificationContent) -> Void)?
    private var bestAttemptContent: UNMutableNotificationContent?

    /// Deliver the final content exactly once. Nils the handler so a later
    /// timeout (serviceExtensionTimeWillExpire) can't double-call it — calling
    /// the handler twice blocks the comm-notification upcast entirely.
    private func deliver(_ content: UNNotificationContent) {
        guard let handler = contentHandler else { return }
        contentHandler = nil
        handler(content)
    }

    override func didReceive(_ request: UNNotificationRequest,
                             withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        self.contentHandler = contentHandler
        bestAttemptContent = request.content.mutableCopy() as? UNMutableNotificationContent

        guard let bestAttemptContent = bestAttemptContent else {
            deliver(request.content)
            return
        }

        // Urgent pings (apns-push --urgent) carry an `urgent` flag. Promote them
        // to time-sensitive so they pierce Driving/Reduce-Interruptions Focus.
        let urgent = request.content.userInfo["urgent"]
        if (urgent as? Bool) == true || (urgent as? Int) == 1 {
            bestAttemptContent.interruptionLevel = .timeSensitive
        }

        // Synthetic sender — no real contact needed (confirmed by Apple's sample).
        let sender = INPerson(
            personHandle: INPersonHandle(value: "jori-assistant", type: .unknown),
            nameComponents: nil,
            displayName: "Jori",
            image: nil,
            contactIdentifier: nil,
            customIdentifier: nil
        )

        let intent = INSendMessageIntent(
            recipients: nil,                       // 1:1 incoming → recipients nil
            outgoingMessageType: .outgoingMessageText,
            content: bestAttemptContent.body,
            speakableGroupName: nil,
            conversationIdentifier: "jori-chat",
            serviceName: nil,
            sender: sender,
            attachments: nil
        )

        // Donate FIRST, then update inside the completion (Apple's order).
        let interaction = INInteraction(intent: intent, response: nil)
        interaction.direction = .incoming
        interaction.donate { [weak self] error in
            guard let self = self else { return }
            if let error = error {
                NSLog("[JoriNSE] donate failed: \(error.localizedDescription)")
            }
            do {
                let updated = try bestAttemptContent.updating(from: intent)
                self.deliver(updated)
            } catch {
                // If this fires, the comm-notification upcast failed — almost
                // always missing IntentsSupported or an unprovisioned entitlement.
                NSLog("[JoriNSE] updating(from:) threw: \(error.localizedDescription)")
                self.deliver(bestAttemptContent)
            }
        }
    }

    override func serviceExtensionTimeWillExpire() {
        if let bestAttemptContent = bestAttemptContent {
            deliver(bestAttemptContent)
        }
    }
}
