import Foundation
import Security
import Supabase

/// AuthLocalStorage backed by the data-protection keychain in a shared access
/// group, so the main app and its extensions (JoriShare) read/write the SAME
/// items. Used on iOS and macOS — both declare the group in
/// `keychain-access-groups`.
///
/// The app mirrors its access token here (SharedSession); the share extension
/// reads it to insert into jori_messages as the authenticated user from its
/// own process, and parks unsendable shares here (ShareOutbox). Mirrors
/// MacKeychainStorage (macOS) but adds kSecAttrAccessGroup for cross-target
/// sharing.
struct SharedKeychainStorage: AuthLocalStorage {
    let service: String
    let accessGroup: String

    init(service: String = "supabase.gotrue.swift",
         accessGroup: String = SupabaseConfig.keychainAccessGroup) {
        self.service = service
        self.accessGroup = accessGroup
    }

    private func baseQuery(key: String? = nil) -> [String: Any] {
        var q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccessGroup as String: accessGroup,
            kSecUseDataProtectionKeychain as String: true,
        ]
        if let key {
            q[kSecAttrAccount as String] = key
        }
        return q
    }

    func store(key: String, value: Data) throws {
        var addQuery = baseQuery(key: key)
        addQuery[kSecValueData as String] = value
        // AfterFirstUnlock so the extension can read the session while the
        // phone is locked (announced reply while driving, screen off).
        addQuery[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock

        let status = SecItemAdd(addQuery as CFDictionary, nil)
        if status == errSecDuplicateItem {
            let updateStatus = SecItemUpdate(
                baseQuery(key: key) as CFDictionary,
                [kSecValueData as String: value] as CFDictionary
            )
            if updateStatus != errSecSuccess {
                throw KeychainError(status: updateStatus)
            }
        } else if status != errSecSuccess {
            throw KeychainError(status: status)
        }
    }

    func retrieve(key: String) throws -> Data? {
        var query = baseQuery(key: key)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)

        if status == errSecItemNotFound {
            return nil
        }
        if status != errSecSuccess {
            throw KeychainError(status: status)
        }
        return result as? Data
    }

    func remove(key: String) throws {
        let status = SecItemDelete(baseQuery(key: key) as CFDictionary)
        if status != errSecSuccess && status != errSecItemNotFound {
            throw KeychainError(status: status)
        }
    }

    struct KeychainError: LocalizedError {
        let status: OSStatus
        var errorDescription: String? { "Keychain error: \(status)" }
    }
}
