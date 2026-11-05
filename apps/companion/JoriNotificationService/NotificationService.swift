import UserNotifications
import Intents
#if canImport(UIKit)
import UIKit
#else
import AppKit
#endif

/// Upcasts Jori pushes into communication notifications so iOS shows a sender
/// avatar and treats them as messages, and records each one in AnnounceCache
/// so the Intents extension can tell Siri what to read aloud.
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

        // What Siri reads aloud for this notification: the Intents extension
        // answers Siri's INSearchForMessagesIntent (keyed by this request id)
        // from this cache. See AnnounceCache.swift.
        AnnounceCache.record(AnnouncedMessage(
            requestId: request.identifier,
            messageId: request.content.userInfo["message_id"] as? String,
            title: bestAttemptContent.title,
            body: bestAttemptContent.body,
            date: Date()))

        #if os(iOS)
        // The message category: Reply action, CarPlay, and
        // INSearchForMessagesIntent as its intent (MessageReply.swift).
        if bestAttemptContent.categoryIdentifier.isEmpty {
            bestAttemptContent.categoryIdentifier = "JORI_MESSAGE"
        }
        #endif

        // Synthetic sender — no real contact needed (confirmed by Apple's sample).
        let avatar = Self.senderAvatar()
        let sender = INPerson(
            personHandle: INPersonHandle(value: "jori-assistant", type: .unknown),
            nameComponents: nil,
            displayName: Self.assistantName,
            image: avatar,
            contactIdentifier: nil,
            customIdentifier: "jori-assistant"   // same person as JoriIntents' IntentHandler
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

        if #available(iOS 15.0, macOS 12.0, *), let avatar {
            intent.setImage(avatar, forParameterNamed: \.sender)
        }

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

    /// Jori's face as the sender photo (without one iOS draws a grey "J"). The
    /// image is the containing app's `JoriAvatar` asset, so this extension needs
    /// no resources of its own: the .appex sits in the app's PlugIns folder
    /// (Jori.app/PlugIns on iOS, Jori.app/Contents/PlugIns on macOS).
    /// What the assistant is called: this extension's own Info.plist key
    /// (JoriDisplayName ← JORI_DISPLAY_NAME), the same one `Install.displayName`
    /// reads in the targets that compile SupabaseConfig.swift.
    private static var assistantName: String {
        let v = ((Bundle.main.object(forInfoDictionaryKey: "JoriDisplayName") as? String) ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return v.isEmpty || v.contains("$(") ? "Jori" : v // control-scan-ok: the setting's default
    }

    private static func senderAvatar() -> INImage? {
        var url = Bundle.main.bundleURL
        while url.pathExtension != "app" && url.pathComponents.count > 1 {
            url.deleteLastPathComponent()
        }
        guard url.pathExtension == "app", let app = Bundle(url: url) else { return nil }
        #if canImport(UIKit)
        guard let data = UIImage(named: "JoriAvatar", in: app, compatibleWith: nil)?.pngData() else { return nil }
        #else
        guard let image = app.image(forResource: "JoriAvatar"),
              let tiff = image.tiffRepresentation,
              let data = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) else { return nil }
        #endif
        return INImage(imageData: data)
    }

    override func serviceExtensionTimeWillExpire() {
        if let bestAttemptContent = bestAttemptContent {
            deliver(bestAttemptContent)
        }
    }
}
