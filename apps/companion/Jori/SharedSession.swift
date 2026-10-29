import Foundation
import Supabase

/// Bridges the signed-in session to the app extensions (JoriShare on iOS and
/// macOS; formerly JoriIntents) WITHOUT routing the app's primary auth client
/// through the shared keychain group.
///
/// Routing the app's Supabase auth storage through the shared-access-group
/// keychain broke Google sign-in: the PKCE code-verifier written during
/// `getOAuthSignInURL` couldn't be read back at the callback exchange, yielding
/// "both auth code and code verifier should be non-empty". So the app keeps the
/// SDK's default keychain storage (sign-in works), and we mirror only the
/// resulting access/refresh tokens into a small shared item the extension reads.
enum SharedSession {
    private static let store = SharedKeychainStorage(service: "ai.\(Install.storagePrefix).shared-session")
    private static let key = "session-tokens"

    /// App side — mirror the current session whenever it's fresh (sign-in,
    /// foreground, background). Cheap; safe to call often.
    static func mirror(_ session: Session) {
        let payload = ["access_token": session.accessToken,
                       "refresh_token": session.refreshToken]
        guard let data = try? JSONSerialization.data(withJSONObject: payload) else { return }
        do {
            try store.store(key: key, value: data)
        } catch {
            NSLog("[SharedSession] mirror failed: \(error.localizedDescription)")
        }
    }

    /// App side — drop the mirror on sign-out so the extension can't post as a
    /// signed-out user.
    static func clear() {
        try? store.remove(key: key)
    }

    /// Extension side — the mirrored tokens, if the user is signed in.
    static func tokens() -> (access: String, refresh: String)? {
        guard let data = try? store.retrieve(key: key),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: String],
              let access = obj["access_token"],
              let refresh = obj["refresh_token"] else { return nil }
        return (access, refresh)
    }
}
