#if os(iOS)
import Foundation
import Intents
import UserNotifications

/// The category every assistant message arrives in (the NotificationService
/// extension sets it; apns-push.mjs sends it too). INSearchForMessagesIntent as
/// the category's intent ties the notification to SiriKit messaging, so Siri
/// asks the JoriIntents extension what to read aloud and where a spoken reply
/// goes; `.allowInCarPlay` shows it in CarPlay. Same shape as Telegram-iOS's
/// repliable categories. (`.allowAnnouncement` is deprecated and ignored since
/// iOS 15.) The text-input Reply action handles a typed reply in-app.
enum MessageReply {
    static let category = "JORI_MESSAGE"
    static let replyAction = "JORI_REPLY"

    /// Register the message category (merging with any existing categories, e.g.
    /// trade-approval). Call once at launch after setting the UNUC delegate.
    static func registerNotificationCategory() {
        let reply = UNTextInputNotificationAction(
            identifier: replyAction,
            title: "Reply",
            options: [],
            textInputButtonTitle: "Send",
            textInputPlaceholder: "Message \(Install.displayName)")
        let cat = UNNotificationCategory(
            identifier: category,
            actions: [reply],
            intentIdentifiers: [INSearchForMessagesIntentIdentifier],
            options: [.allowInCarPlay])
        let center = UNUserNotificationCenter.current()
        center.getNotificationCategories { existing in
            var merged = existing.filter { $0.identifier != category }
            merged.insert(cat)
            center.setNotificationCategories(merged)
        }
    }

    /// Insert a dictated reply as a user message on the chat channel.
    static func handle(_ text: String) async {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        do {
            try await SupabaseManager.ensureAuthenticated()
            let userId = try? await SupabaseManager.shared.auth.session.user.id
            let tz = TimeZone.current
            let insert = InsertMessage(
                role: "user",
                content: trimmed,
                read: false,
                channel: ChatChannel.chat.rawValue,
                metadata: [
                    "timezone": tz.identifier,
                    "utc_offset": "\(tz.secondsFromGMT() / 3600)",
                    "source": "siri-reply",
                ],
                userId: userId)
            try await SupabaseManager.shared
                .from(DBTables.messages)
                .insert(insert)
                .execute()
        } catch {
            print("[MessageReply] insert failed: \(error)")
        }
    }
}
#endif
