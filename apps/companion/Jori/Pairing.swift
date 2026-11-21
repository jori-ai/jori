import Foundation
import CryptoKit
#if os(macOS)
import AppKit
#else
import UIKit
#endif

/// Pairing the shared app with a Jori (docs/per-user-onboarding-spec.md,
/// Phase 2): store what the scanned code says, then sign in as usual; and the
/// reverse, "Use another Jori". The model and its storage are in
/// SupabaseConfig.swift (`Pairing`, `PairingStore`) because the extensions
/// read them too.
enum PairingCoordinator {

    /// Store a scanned or typed code. Throws `Pairing.ParseError` (shown to the
    /// user as is) or a keychain failure. The Supabase client follows on its
    /// next use (`SupabaseManager.shared` is keyed by the backend).
    @MainActor
    static func pair(with code: String) throws {
        let (pairing, token) = try Pairing.parse(code)
        // What the app was bound to before, captured before anything changes:
        // a failed save below leaves the old pairing fully intact.
        let previousBackend = Install.isConfigured ? Install.supabaseURL : nil
        let previousRelay = PushRelay.currentRegistration()
        try PairingStore.save(pairing, pairingToken: token)
        // A new pairing never inherits a relay registration or device key.
        PushRelay.unregister(previousRelay)
        PushKey.delete()
        DBTables.reset()
        if let previousBackend, previousBackend != pairing.supabaseURL {
            forgetBackendData()
        }
        if pairing.usesRelay {
            Task { await PushRelay.shared.sync() }
        }
    }

    /// Sign out of the paired Jori and forget it, so the app asks for a code
    /// again (or, in a build with its own backend, signs in to that).
    @MainActor
    static func unpair() async {
        await SupabaseManager.signOut()   // on the old backend's client
        PushRelay.unregister(PushRelay.currentRegistration())
        PushKey.delete()
        PairingStore.clear()
        DBTables.reset()
        forgetBackendData()
    }

    /// What belongs to one backend and must not carry over to another.
    @MainActor
    private static func forgetBackendData() {
        MessageStore.shared.deleteAll()   // another Jori's chat must not show
        TeamSnapshot.delete()             // nor its conversation list
        // Signing devices registered with the old backend.
        UserDefaults.standard.removeObject(forKey: Install.key("purchase.registered"))
        UserDefaults.standard.removeObject(forKey: Install.key("selfImprove.registered"))
    }
}

/// Registers this device with the shared push relay, for a pairing that names
/// one (`r`, `i`, and at first `t`). Installations with their own app and
/// Apple key never get here: they push directly to the token the app saves
/// in `device_tokens`, which the app keeps doing in every mode.
///
///   first time:   POST   {r}/v1/devices       (spends the one-time pairing token)
///   token change: PUT    {r}/v1/devices/{id}  (signed as the device)
///   unpair:       DELETE {r}/v1/devices/{id}  (signed as the device)
///
/// Protocol: docs/push-relay.md. Device auth headers: `X-Jori-Device`,
/// `X-Jori-Timestamp` (ms), `X-Jori-Signature` (`RelayAuth`, PushCrypto.swift).
actor PushRelay {
    static let shared = PushRelay()

    private static let deviceIdKey = Install.key("relay.deviceId")
    private static let registeredTokenKey = Install.key("relay.apnsToken")
    private static let lastErrorKey = Install.key("relay.lastError")
    private static var secretService: String { Install.key("push-relay") }
    private static let secretAccount = "device-secret"

    static var deviceId: String? { UserDefaults.standard.string(forKey: deviceIdKey) }
    /// Why the last registration failed, for diagnostics; nil once it works.
    static var lastError: String? { UserDefaults.standard.string(forKey: lastErrorKey) }

    private static var deviceSecret: String? {
        guard case .found(let data) = SharedKeychain.read(service: secretService, account: secretAccount) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    struct Registration {
        let relay: URL
        let deviceId: String
        let secret: String
    }

    /// This device's relay registration under the current pairing, if any.
    static func currentRegistration() -> Registration? {
        guard let relay = PairingStore.current?.relayURL, let deviceId, let secret = deviceSecret else { return nil }
        return Registration(relay: relay, deviceId: deviceId, secret: secret)
    }

    /// Unpair from the relay: forget the registration here at once, and ask
    /// the relay to delete the device (best effort, in the background — if it
    /// fails the relay can still only push ciphertext this phone can no
    /// longer open, since the device key is deleted too).
    static func unregister(_ registration: Registration?) {
        if let r = registration {
            Task.detached {
                var req = URLRequest(url: endpoint(r.relay, "v1/devices/\(r.deviceId)"))
                req.httpMethod = "DELETE"
                req.timeoutInterval = 10
                sign(&req, deviceId: r.deviceId, secret: r.secret, body: Data())
                let status = ((try? await URLSession.shared.data(for: req))?.1 as? HTTPURLResponse)?.statusCode
                print("[Relay] unregister \(r.deviceId): \(status.map(String.init) ?? "failed")")
            }
        }
        forgetRegistration()
    }

    /// Drop the registration locally (new pairing, or unpaired).
    static func forgetRegistration() {
        UserDefaults.standard.removeObject(forKey: deviceIdKey)
        UserDefaults.standard.removeObject(forKey: registeredTokenKey)
        UserDefaults.standard.removeObject(forKey: lastErrorKey)
        SharedKeychain.delete(service: secretService, account: secretAccount)
    }

    /// The previous sync, which the next one waits for: an actor alone
    /// interleaves at each `await`, and two overlapping first registrations
    /// would both try to spend the one-time pairing token.
    private var tail: Task<Void, Never>?

    /// Bring the relay up to date with the APNs token: register on first use,
    /// update when the token changed, nothing otherwise. Called when the token
    /// arrives (every launch) and right after pairing, whichever comes second
    /// finding the other already there. Runs one at a time, in call order.
    func sync(apnsToken given: String? = nil) async {
        let previous = tail
        let next = Task {
            await previous?.value
            await self.syncNow(apnsToken: given)
        }
        tail = next
        await next.value
    }

    private func syncNow(apnsToken given: String?) async {
        guard let pairing = PairingStore.current, pairing.usesRelay,
              let relay = pairing.relayURL, let instance = pairing.instanceId else { return }
        let stored = UserDefaults.standard.string(forKey: Install.key("apnsDeviceToken"))
        guard let token = given ?? stored, !token.isEmpty else { return }

        if let deviceId = Self.deviceId, let secret = Self.deviceSecret {
            guard UserDefaults.standard.string(forKey: Self.registeredTokenKey) != token else { return }
            await update(relay: relay, deviceId: deviceId, secret: secret, token: token)
        } else {
            await register(relay: relay, instance: instance, token: token)
        }
    }

    private func register(relay: URL, instance: String, token: String) async {
        guard let pairingToken = PairingStore.pairingToken else {
            Self.fail("This phone isn't registered for notifications and the pairing code was already used. Scan a new code (Use another Jori).")
            return
        }
        do {
            let key = try PushKey.loadOrCreate()
            let name = await Self.deviceName()
            let body = try JSONSerialization.data(withJSONObject: [
                "instance_id": instance,
                "pairing_token": pairingToken,
                "apns_token": token,
                "environment": Self.environment,
                "device_name": name,
                "public_key": key.publicKey.x963Representation.base64EncodedString(),
            ])
            var req = URLRequest(url: Self.endpoint(relay, "v1/devices"))
            req.httpMethod = "POST"
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = body
            req.timeoutInterval = 20
            let (data, resp) = try await URLSession.shared.data(for: req)
            let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
            guard (200..<300).contains(status) else {
                // The token is spent, expired or unknown: retrying can't help.
                if [400, 401, 403, 404, 409, 410].contains(status) { PairingStore.forgetPairingToken() }
                Self.fail("Relay registration failed (\(status)): \(String(data: data.prefix(300), encoding: .utf8) ?? "")")
                return
            }
            guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let deviceId = json["device_id"] as? String, !deviceId.isEmpty,
                  let secret = json["device_secret"] as? String, !secret.isEmpty else {
                Self.fail("Relay registration answered without device_id / device_secret.")
                return
            }
            try SharedKeychain.write(Data(secret.utf8), service: Self.secretService, account: Self.secretAccount)
            UserDefaults.standard.set(deviceId, forKey: Self.deviceIdKey)
            UserDefaults.standard.set(token, forKey: Self.registeredTokenKey)
            UserDefaults.standard.removeObject(forKey: Self.lastErrorKey)
            PairingStore.forgetPairingToken()
            print("[Relay] registered device \(deviceId)")
        } catch {
            Self.fail("Relay registration failed: \(error.localizedDescription)")
        }
    }

    private func update(relay: URL, deviceId: String, secret: String, token: String) async {
        do {
            // Exactly the fields the relay's PUT takes (docs/push-relay.md).
            let body = try JSONSerialization.data(withJSONObject: [
                "apns_token": token,
                "environment": Self.environment,
            ])
            var req = URLRequest(url: Self.endpoint(relay, "v1/devices/\(deviceId)"))
            req.httpMethod = "PUT"
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = body
            req.timeoutInterval = 20
            Self.sign(&req, deviceId: deviceId, secret: secret, body: body)
            let (data, resp) = try await URLSession.shared.data(for: req)
            let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
            guard (200..<300).contains(status) else {
                Self.fail("Relay token update failed (\(status)): \(String(data: data.prefix(300), encoding: .utf8) ?? "")")
                return
            }
            UserDefaults.standard.set(token, forKey: Self.registeredTokenKey)
            UserDefaults.standard.removeObject(forKey: Self.lastErrorKey)
            print("[Relay] updated token for \(deviceId)")
        } catch {
            Self.fail("Relay token update failed: \(error.localizedDescription)")
        }
    }

    // MARK: Helpers

    /// `{r}/<path>`, tolerating a trailing slash on `r`.
    static func endpoint(_ relay: URL, _ path: String) -> URL {
        var base = relay.absoluteString
        while base.hasSuffix("/") { base.removeLast() }
        return URL(string: "\(base)/\(path)")!
    }

    static func sign(_ req: inout URLRequest, deviceId: String, secret: String, body: Data,
                     now: Date = Date()) {
        let timestamp = String(Int64((now.timeIntervalSince1970 * 1000).rounded(.down)))
        // PATH is the URL path only (no host, no query), as the relay sees it.
        let path = req.url.flatMap { URLComponents(url: $0, resolvingAgainstBaseURL: false)?.percentEncodedPath } ?? "/"
        let signature = RelayAuth.signature(secret: secret, method: req.httpMethod ?? "GET", path: path,
                                            timestamp: timestamp, body: body)
        req.setValue(deviceId, forHTTPHeaderField: "X-Jori-Device")
        req.setValue(timestamp, forHTTPHeaderField: "X-Jori-Timestamp")
        req.setValue(signature, forHTTPHeaderField: "X-Jori-Signature")
    }

    /// Which APNs gateway the relay must use for this build's token.
    static var environment: String {
        #if DEBUG
        return "sandbox"
        #else
        return "production"
        #endif
    }

    @MainActor
    private static func deviceName() -> String {
        #if os(macOS)
        return Host.current().localizedName ?? "Mac"
        #else
        return UIDevice.current.name
        #endif
    }

    private static func fail(_ message: String) {
        print("[Relay] \(message)")
        UserDefaults.standard.set(message, forKey: lastErrorKey)
    }
}
