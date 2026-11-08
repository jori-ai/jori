import Foundation
import Security

/// What Siri reads aloud. Compiled into BOTH the NotificationService extension
/// (which records each message as it arrives) and the JoriIntents extension
/// (which answers Siri from it).
///
/// Why it exists: once the app is a messaging app (communication
/// notifications + SiriKit messaging), Siri does not speak an announced
/// notification's text itself. It sends the Intents extension an
/// INSearchForMessagesIntent carrying the notification's request identifier in
/// `notificationIdentifiers`, and speaks the INMessages the handler returns.
/// An empty answer, or no Intents extension, means silence. Telegram-iOS works
/// the same way (Telegram/SiriIntents/MessageSearchScope.swift).
///
/// Stored in the shared keychain group with AfterFirstUnlock, so the Intents
/// extension can read it on a locked phone, and with no network, so an
/// expired session token cannot silence an announcement.
struct AnnouncedMessage: Codable {
    let requestId: String   // UNNotificationRequest.identifier
    let messageId: String?  // jori_messages id (push payload `message_id`)
    let title: String
    let body: String
    let date: Date
}

enum AnnounceCache {
    private static let service = "jori.announce-cache"
    private static let account = "recent"
    static let maxEntries = 30

    /// The `.shared` keychain group (Info.plist JoriKeychainGroup ←
    /// JORI_KEYCHAIN_GROUP), the same group the entitlements name.
    private static var accessGroup: String? {
        let v = ((Bundle.main.object(forInfoDictionaryKey: "JoriKeychainGroup") as? String) ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return v.isEmpty || v.contains("$(") ? nil : v
    }

    private static func query() -> [String: Any] {
        var q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecUseDataProtectionKeychain as String: true,
        ]
        if let g = accessGroup { q[kSecAttrAccessGroup as String] = g }
        return q
    }

    /// Newest last.
    static func all() -> [AnnouncedMessage] {
        var q = query()
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess,
              let data = out as? Data,
              let list = try? JSONDecoder().decode([AnnouncedMessage].self, from: data) else { return [] }
        return list
    }

    static func record(_ message: AnnouncedMessage) {
        var list = all().filter { $0.requestId != message.requestId }
        list.append(message)
        if list.count > maxEntries { list.removeFirst(list.count - maxEntries) }
        guard let data = try? JSONEncoder().encode(list) else { return }
        let status = SecItemUpdate(query() as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecItemNotFound {
            var add = query()
            add[kSecValueData as String] = data
            add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
            let s = SecItemAdd(add as CFDictionary, nil)
            if s != errSecSuccess { NSLog("[AnnounceCache] add failed: \(s)") }
        } else if status != errSecSuccess {
            NSLog("[AnnounceCache] update failed: \(status)")
        }
    }

    // MARK: - Trace (diagnostics)
    //
    // What each process did with a message, so a silent announcement can be
    // explained without a cable to the phone: the extensions append events
    // here, and the app uploads them (AnnounceDiagnostics) when it next comes
    // to the foreground, then clears them.

    private static let traceAccount = "trace"
    static let maxTrace = 120

    private static func traceQuery() -> [String: Any] {
        var q = query()
        q[kSecAttrAccount as String] = traceAccount
        return q
    }

    static func traceAll() -> [[String: String]] {
        var q = traceQuery()
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess,
              let data = out as? Data,
              let list = try? JSONDecoder().decode([[String: String]].self, from: data) else { return [] }
        return list
    }

    static func trace(_ event: String) {
        NSLog("[AnnounceTrace] \(event)")
        let who = (Bundle.main.bundleIdentifier ?? "?").split(separator: ".").last.map(String.init) ?? "?"
        var list = traceAll()
        list.append(["t": ISO8601DateFormatter().string(from: Date()), "p": who, "e": event])
        if list.count > maxTrace { list.removeFirst(list.count - maxTrace) }
        guard let data = try? JSONEncoder().encode(list) else { return }
        let status = SecItemUpdate(traceQuery() as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecItemNotFound {
            var add = traceQuery()
            add[kSecValueData as String] = data
            add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
            _ = SecItemAdd(add as CFDictionary, nil)
        }
    }

    static func clearTrace() {
        SecItemDelete(traceQuery() as CFDictionary)
    }

    /// Whether the cache itself can be written and read back (keychain group
    /// reachable in this process).
    static var groupDescription: String { accessGroup ?? "(none)" }
}

