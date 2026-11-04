import Foundation

final class CloudBackup {
    static let shared = CloudBackup()

    private let store = NSUbiquitousKeyValueStore.default
    private let backupKey = "chat_backup"
    private let backupDateKey = "chat_backup_date"

    private init() {}

    func backup(messages: [Message]) {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        guard let data = try? encoder.encode(messages),
              let json = String(data: data, encoding: .utf8) else {
            print("CloudBackup: Failed to encode messages")
            return
        }
        store.set(json, forKey: backupKey)
        store.set(Date().timeIntervalSince1970, forKey: backupDateKey)
        store.synchronize()
    }

    func restore() -> [Message]? {
        guard let json = store.string(forKey: backupKey),
              let data = json.data(using: .utf8) else {
            return nil
        }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        // Chat rows only. Restores land in the Chat view, and a backup written
        // before 2026-10-06 can hold System rows (the backup used to snapshot
        // whichever channel was on screen).
        return (try? decoder.decode([Message].self, from: data))?
            .filter { $0.channel == ChatChannel.chat.rawValue }
    }

    func lastBackupDate() -> Date? {
        let timestamp = store.double(forKey: backupDateKey)
        guard timestamp > 0 else { return nil }
        return Date(timeIntervalSince1970: timestamp)
    }
}
