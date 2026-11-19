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

        // A push through the shared relay arrives sealed (`enc`) behind a
        // placeholder alert. Open it first, so everything below — the urgent
        // flag, what Siri reads, the tap's message_id — sees the real message.
        // Any failure leaves the placeholder.
        if request.content.userInfo["enc"] != nil {
            do {
                if let payload = try PushCrypto.payload(of: request.content.userInfo) {
                    Self.apply(payload, to: bestAttemptContent)
                }
            } catch {
                NSLog("[JoriNSE] could not open sealed push: \(error)")
                AnnounceCache.trace("nse open failed: \(error)")
            }
        }
        let userInfo = bestAttemptContent.userInfo

        // Urgent pings (apns-push --urgent) carry an `urgent` flag. Promote them
        // to time-sensitive so they pierce Driving/Reduce-Interruptions Focus.
        let urgent = userInfo["urgent"]
        if (urgent as? Bool) == true || (urgent as? Int) == 1 {
            bestAttemptContent.interruptionLevel = .timeSensitive
        }

        // What Siri reads aloud for this notification: the Intents extension
        // answers Siri's INSearchForMessagesIntent (keyed by this request id)
        // from this cache. See AnnounceCache.swift.
        AnnounceCache.trace("nse received req=\(request.identifier) msg=\(userInfo["message_id"] as? String ?? "-") cat=\(bestAttemptContent.categoryIdentifier) group=\(AnnounceCache.groupDescription)")
        AnnounceCache.record(AnnouncedMessage(
            requestId: request.identifier,
            messageId: userInfo["message_id"] as? String,
            title: bestAttemptContent.title,
            body: bestAttemptContent.body,
            date: Date()))
        AnnounceCache.trace("nse cached=\(AnnounceCache.all().count)")

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

        // setImage(_:forParameterNamed:) is unavailable on macOS (it broke the
        // macOS archive on 2026-11-05); the avatar only matters for iOS announcements.
        #if os(iOS)
        if #available(iOS 15.0, *), let avatar {
            intent.setImage(avatar, forParameterNamed: \.sender)
        }
        #endif

        // Donate FIRST, then update inside the completion (Apple's order).
        let interaction = INInteraction(intent: intent, response: nil)
        interaction.direction = .incoming
        interaction.donate { [weak self] error in
            guard let self = self else { return }
            if let error = error {
                NSLog("[JoriNSE] donate failed: \(error.localizedDescription)")
                AnnounceCache.trace("nse donate failed: \(error.localizedDescription)")
            }
            do {
                let updated = try bestAttemptContent.updating(from: intent)
                AnnounceCache.trace("nse upcast ok cat=\(updated.categoryIdentifier) level=\(updated.interruptionLevel.rawValue)")
                self.deliver(updated)
            } catch {
                // If this fires, the comm-notification upcast failed — almost
                // always missing IntentsSupported or an unprovisioned entitlement.
                NSLog("[JoriNSE] updating(from:) threw: \(error.localizedDescription)")
                AnnounceCache.trace("nse upcast threw: \(error.localizedDescription)")
                self.deliver(bestAttemptContent)
            }
        }
    }

    /// Jori's face as the sender photo (without one iOS draws a grey "J"). The
    /// image is the containing app's `JoriAvatar` asset, so this extension needs
    /// no resources of its own: the .appex sits in the app's PlugIns folder
    /// (Jori.app/PlugIns on iOS, Jori.app/Contents/PlugIns on macOS).
    /// What the assistant is called: the pairing's name, else this
    /// extension's own Info.plist key (JoriDisplayName ← JORI_DISPLAY_NAME).
    private static var assistantName: String { Install.displayName }

    /// Put a relayed push's real content on the notification: the decrypted
    /// payload's `aps` (alert, sound, badge, thread, category, interruption
    /// level) and its custom keys merged into userInfo, so the app's tap
    /// handling reads them as if the push had come direct.
    static func apply(_ payload: [String: Any], to content: UNMutableNotificationContent) {
        if let aps = payload["aps"] as? [String: Any] {
            switch aps["alert"] {
            case let body as String:
                content.title = ""
                content.subtitle = ""
                content.body = body
            case let alert as [String: Any]:
                content.title = alert["title"] as? String ?? ""
                content.subtitle = alert["subtitle"] as? String ?? ""
                content.body = alert["body"] as? String ?? ""
            default:
                break
            }
            if let name = (aps["sound"] as? String) ?? ((aps["sound"] as? [String: Any])?["name"] as? String) {
                content.sound = name == "default" ? .default : UNNotificationSound(named: UNNotificationSoundName(name))
            }
            if let badge = aps["badge"] as? NSNumber { content.badge = badge }
            if let thread = aps["thread-id"] as? String { content.threadIdentifier = thread }
            if let category = aps["category"] as? String { content.categoryIdentifier = category }
            if let target = aps["target-content-id"] as? String { content.targetContentIdentifier = target }
            if let score = aps["relevance-score"] as? NSNumber { content.relevanceScore = score.doubleValue }
            switch aps["interruption-level"] as? String {
            case "passive": content.interruptionLevel = .passive
            case "active": content.interruptionLevel = .active
            case "time-sensitive": content.interruptionLevel = .timeSensitive
            default: break   // "critical" needs an entitlement this app doesn't have
            }
        }
        content.userInfo = PushCrypto.merged(content.userInfo, with: payload)
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
        AnnounceCache.trace("nse time expired")
        if let bestAttemptContent = bestAttemptContent {
            deliver(bestAttemptContent)
        }
    }
}
