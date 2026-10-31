#if os(iOS)
import Foundation
import UserNotifications

/// Lets Siri offer "reply" after announcing a Jori message on AirPods, and
/// routes the dictated reply back into the chat.
///
/// Plain push notifications get announced on AirPods; the communication-
/// notification upcast in the NSE actually SUPPRESSED the announcement. The
/// piece that makes Siri say "…you can reply" is a text-input action on the
/// notification's category — not the comm-notification machinery. Pushes for the
/// chat channel carry `category = JORI_MESSAGE` (set in apns-push.mjs); this
/// registers that category and handles the reply as a `role:user` insert, which
/// the phone-channel then acks and answers — same round-trip as the app/Siri.
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
            textInputPlaceholder: "Message Jori")
        let cat = UNNotificationCategory(
            identifier: category,
            actions: [reply],
            intentIdentifiers: [],
            options: [])
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
