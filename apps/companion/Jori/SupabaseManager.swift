import Foundation
import Supabase
import AuthenticationServices

#if os(macOS)
import AppKit
#else
import UIKit
#endif

enum SupabaseManager {
    // Connection constants live in SupabaseConfig (from the build
    // configuration, or a runtime pairing) so the extensions can share them.
    // Aliased here to keep existing call sites (SupabaseManager.url / .anonKey)
    // working. Computed: pairing can change them while the app runs.
    static var url: URL { SupabaseConfig.url }
    // Supabase anon JWT — intentionally public (RLS enforces access, not secrecy).
    static var anonKey: String { SupabaseConfig.anonKey }

    // OAuth redirect — must match a CFBundleURLScheme in Info.plist and the
    // Supabase Auth "Redirect URLs" allowlist (Dashboard → Auth → URL Configuration).
    static let callbackScheme = Install.urlScheme
    static let redirectURL = URL(string: "\(callbackScheme)://auth-callback")!

    /// Which backend the client talks to; changes when the app is paired or
    /// unpaired. Views restart backend-bound work with `.task(id:)` on it.
    static var backendID: String { "\(url.absoluteString)|\(anonKey)" }

    private static let clientLock = NSLock()
    private static var client: (backend: String, client: SupabaseClient)?

    /// The client for the current backend. Built on first use and rebuilt
    /// when the backend changes (pairing), so a pairing takes effect without a
    /// relaunch. Callers must not keep it in a stored property: read it here
    /// each time. The session store is per backend (the SDK keys it by the
    /// project host), so a rebuilt client never inherits another's session.
    static var shared: SupabaseClient {
        let backend = backendID
        clientLock.lock(); defer { clientLock.unlock() }
        if let client, client.backend == backend { return client.client }
        let made = makeClient()
        client = (backend, made)
        return made
    }

    private static func makeClient() -> SupabaseClient {
        #if os(macOS)
        // Sandboxed macOS apps need the data-protection keychain; the SDK's
        // default keychain backend reads return errSecMissingEntitlement /
        // session-missing, the SDK falls back to the anon key, and inserts
        // hit the jori_messages RLS guard (auth.uid() IS NOT NULL).
        let options = SupabaseClientOptions(
            auth: SupabaseClientOptions.AuthOptions(storage: MacKeychainStorage())
        )
        return SupabaseClient(supabaseURL: url, supabaseKey: anonKey, options: options)
        #else
        // iOS: keep the SDK's default keychain storage. Routing this client
        // through the shared-access-group keychain broke the PKCE sign-in
        // (code-verifier round-trip). The JoriIntents extension gets the
        // session via SharedSession (token mirror), not by sharing this store.
        return SupabaseClient(supabaseURL: url, supabaseKey: anonKey)
        #endif
    }

    enum AuthError: LocalizedError {
        case noSession
        case webAuthFailed(String)
        var errorDescription: String? {
            switch self {
            case .noSession: return "Not signed in."
            case .webAuthFailed(let msg): return msg
            }
        }
    }

    /// A session is saved on this device, without checking it is still
    /// valid: no network, so launch can open on the cached app at once.
    /// `hasSession()` is the checked answer (it refreshes an expired token).
    static var hasStoredSession: Bool {
        shared.auth.currentSession != nil
    }

    /// Whether the saved session is still good, telling a session the server
    /// turned down (refresh token revoked or expired: sign in again) apart
    /// from a network that didn't answer (keep the user in, on the cache).
    /// The client never drops a session whose refresh failed, so the stored
    /// one alone can't tell.
    static func sessionIsGone() async -> Bool {
        do {
            _ = try await shared.auth.session
            return false
        } catch Auth.AuthError.sessionMissing {
            return true
        } catch Auth.AuthError.api(_, _, _, let response) where (400..<500).contains(response.statusCode) && response.statusCode != 429 {
            return true
        } catch {
            return false
        }
    }

    /// Does the Keychain hold a usable session? Refreshes an expired token
    /// over the network first, so it can take a round trip.
    static func hasSession() async -> Bool {
        (try? await shared.auth.session) != nil
    }

    /// Clear the current session (Keychain + in-memory). Safe to call when no
    /// session exists. Caller is responsible for flipping the UI back to the
    /// SignInView; the auth state listener does NOT re-render this app.
    @MainActor
    static func signOut() async {
        do {
            try await shared.auth.signOut()
            SharedSession.clear()
        } catch {
            print("[Auth] signOut error: \(error)")
        }
    }

    /// Refresh the existing session if close to expiry. Throws if no session exists
    /// or refresh fails. Callers must route the user back to SignInView on error.
    static func ensureAuthenticated() async throws {
        guard let session = try? await shared.auth.session else {
            throw AuthError.noSession
        }
        let safetyMargin: TimeInterval = 60
        let expiresAt = Date(timeIntervalSince1970: session.expiresAt)
        if expiresAt.timeIntervalSinceNow > safetyMargin {
            return
        }
        _ = try await shared.auth.refreshSession()
    }

    /// Email sign-in, step 1: Supabase emails a one-time code to `email`.
    /// The installation's setup turns this on for the project
    /// (lib/onboarding/services.mjs configureSupabaseEmailCode); who may then
    /// read anything is still the allowlist (`jori_allowed_users`).
    static func sendEmailCode(to email: String) async throws {
        try await shared.auth.signInWithOTP(email: email, shouldCreateUser: true)
    }

    /// Email sign-in, step 2: the code from the email signs this device in.
    @MainActor
    static func verifyEmailCode(email: String, code: String) async throws {
        try await shared.auth.verifyOTP(email: email, token: code, type: .email)
        await mirrorSessionForExtension()
    }

    /// Launch Google OAuth via a system web view, hand the callback to Supabase,
    /// and persist the resulting session to Keychain. Returns on success; throws on cancel/error.
    @MainActor
    static func signInWithGoogle() async throws {
        // A pairing may name the owner's account: preselect it in Google's
        // picker (a hint only; any allowed account can still sign in).
        let hint = PairingStore.current?.ownerEmail.map { [(name: "login_hint", value: Optional($0))] } ?? []
        let authURL = try shared.auth.getOAuthSignInURL(
            provider: .google,
            redirectTo: redirectURL,
            queryParams: hint
        )
        let callbackURL = try await presentWebAuth(url: authURL, scheme: callbackScheme)
        try await shared.auth.session(from: callbackURL)
        await mirrorSessionForExtension()
    }

    /// Mirror the current session into the shared keychain for the
    /// JoriShare extension, then send anything it parked while the mirror
    /// was stale. Accessing `.session` refreshes a near-expiry token first, so
    /// the extension gets a usable access token. Safe to call on sign-in and on
    /// app foreground/background.
    static func mirrorSessionForExtension() async {
        guard let session = try? await shared.auth.session else { return }
        SharedSession.mirror(session)
        await ShareOutbox.drain(accessToken: session.accessToken)
    }

    /// Keep the mirror current for as long as the app process lives: the SDK
    /// auto-refreshes hourly, and without this the share extension would see a
    /// stale token whenever the app had merely stayed open (the usual macOS
    /// case) rather than been re-foregrounded.
    static func mirrorOnTokenChanges() async {
        for await (event, session) in shared.auth.authStateChanges {
            switch event {
            case .initialSession, .signedIn, .tokenRefreshed:
                guard let session else { continue }
                SharedSession.mirror(session)
                await ShareOutbox.drain(accessToken: session.accessToken)
            case .signedOut:
                SharedSession.clear()
            default:
                break
            }
        }
    }

    @MainActor
    private static func presentWebAuth(url: URL, scheme: String) async throws -> URL {
        try await withCheckedThrowingContinuation { continuation in
            let session = ASWebAuthenticationSession(
                url: url,
                callbackURLScheme: scheme
            ) { callbackURL, error in
                if let callbackURL {
                    continuation.resume(returning: callbackURL)
                } else if let error {
                    continuation.resume(throwing: AuthError.webAuthFailed(error.localizedDescription))
                } else {
                    continuation.resume(throwing: AuthError.webAuthFailed("Sign-in was cancelled."))
                }
            }
            session.presentationContextProvider = WebAuthPresenter.shared
            // Keep cookies so subsequent sign-ins skip the Google account picker if appropriate.
            session.prefersEphemeralWebBrowserSession = false
            if !session.start() {
                continuation.resume(throwing: AuthError.webAuthFailed("Could not start web auth session."))
            }
        }
    }
}

private final class WebAuthPresenter: NSObject, ASWebAuthenticationPresentationContextProviding {
    static let shared = WebAuthPresenter()
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        #if os(macOS)
        return NSApplication.shared.keyWindow ?? NSApplication.shared.windows.first ?? ASPresentationAnchor()
        #else
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let window = scenes.flatMap(\.windows).first(where: { $0.isKeyWindow })
            ?? scenes.first?.windows.first
        return window ?? ASPresentationAnchor()
        #endif
    }
}
