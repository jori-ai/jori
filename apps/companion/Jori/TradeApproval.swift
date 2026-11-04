//
//  TradeApproval.swift
//  Jori
//
//  Second-factor approval for trades placed by an installation's trading web
//  app (optional: on only when the build sets JORI_TRADE_APPROVAL_URL).
//
//  The trading web app sends an interactive push when a trade is pending. Tapping "Approve" makes this code sign a message with a
//  P-256 key held in this device's Secure Enclave — the private key never leaves
//  the enclave and signing is gated by Face ID. The signature is POSTed back to
//  the web app, which verifies it against the public key registered during
//  pairing and only then places the orders.
//
//  Nothing on the host (where Jori's server and any read-only brokerage key
//  live) can produce this signature, so a compromise there cannot move money.
//
//  Integration (see hooks at the bottom of this file):
//    1. Add this file to the Jori app target.
//    2. Register the notification category at launch.
//    3. Route the approve / deny actions in didReceive.
//

import Foundation
import Security
import LocalAuthentication
import UserNotifications

enum TradeApproval {

    // MARK: - Config

    /// Whether this build has trade approval at all (JORI_TRADE_APPROVAL_URL set).
    static var isEnabled: Bool { Install.tradeApprovalURL != nil }

    /// Base URL of the trading web app (the approval verifier).
    static var baseURL: URL { Install.tradeApprovalURL ?? URL(string: "https://trade-approval.invalid")! }

    /// The trading app's own name for its push kind, category and signing
    /// context (JORI_TRADE_APPROVAL_NAMESPACE; "trade" by default): kind
    /// `<ns>-trade-approval`, category `<NS>_TRADE_APPROVAL`, signed context
    /// `<ns>-approve.v1`. All three must match the trading app.
    private static var namespace: String { Install.tradeApprovalNamespace }

    /// APNs category that marks a trade-approval push (must match the trading
    /// app's approval category). The category has NO action buttons — approval
    /// only happens on the in-app review screen.
    static var category: String { "\(namespace.uppercased())_TRADE_APPROVAL" }

    /// Secure Enclave key tag + where we cache the server-assigned device id.
    private static let keyTag = Install.keyTag("tradeApprovalKey")
    private static let deviceIdKey = Install.key("tradeApproval.deviceId")
    private static let apnsTokenKey = Install.key("apnsDeviceToken") // already set by JoriApp

    // MARK: - Notification category

    /// Register the approval category WITHOUT action buttons. Tapping the
    /// notification (even with incidental Face ID) must never place trades — it
    /// only opens the in-app review screen, where the user sees the itemized
    /// transactions and approves with an explicit, Face-ID-gated button.
    /// Call once at launch, after setting the UNUserNotificationCenter delegate.
    static func registerNotificationCategory() {
        guard isEnabled else { return }
        let cat = UNNotificationCategory(
            identifier: category, actions: [],
            intentIdentifiers: [], options: [])
        let center = UNUserNotificationCenter.current()
        center.getNotificationCategories { existing in
            var merged = existing.filter { $0.identifier != category }
            merged.insert(cat)
            center.setNotificationCategories(merged)
        }
    }

    // MARK: - Parsed push

    struct OrderLine: Identifiable {
        let id = UUID()
        let side: String   // "BUY" | "SELL"
        let ticker: String
        let shares: Int
        let amount: Int
    }

    struct Request: Identifiable {
        var id: String { executionId }
        let executionId: String
        let orderHash: String
        let nonce: String
        let expiresAt: Int
        let summary: String
        let orders: [OrderLine]
        let moreCount: Int
    }

    private static func intify(_ v: Any?) -> Int {
        if let n = v as? Int { return n }
        if let d = v as? Double { return Int(d) }
        if let s = v as? String, let n = Int(s) { return n }
        return 0
    }

    /// Extract a trade-approval request from a push payload, or nil if it isn't one.
    static func parse(_ userInfo: [AnyHashable: Any]) -> Request? {
        guard isEnabled,
              (userInfo["kind"] as? String) == "\(namespace)-trade-approval",
              let executionId = userInfo["executionId"] as? String,
              let orderHash = userInfo["orderHash"] as? String,
              let nonce = userInfo["nonce"] as? String,
              let summary = userInfo["summary"] as? String
        else { return nil }
        // expiresAt may arrive as Int or String depending on APNs encoding.
        let expiresAt: Int
        if let n = userInfo["expiresAt"] as? Int { expiresAt = n }
        else if let s = userInfo["expiresAt"] as? String, let n = Int(s) { expiresAt = n }
        else { return nil }

        var lines: [OrderLine] = []
        if let arr = userInfo["orders"] as? [[String: Any]] {
            for o in arr {
                lines.append(OrderLine(
                    side: (o["side"] as? String) ?? "?",
                    ticker: (o["ticker"] as? String) ?? "?",
                    shares: intify(o["shares"]),
                    amount: intify(o["amount"])))
            }
        }

        return Request(executionId: executionId, orderHash: orderHash, nonce: nonce,
                       expiresAt: expiresAt, summary: summary,
                       orders: lines, moreCount: intify(userInfo["moreCount"]))
    }

    /// The exact byte string the trading app reconstructs and verifies.
    private static func message(for r: Request) -> Data {
        "\(namespace)-approve.v1\n\(r.executionId)\n\(r.orderHash)\n\(r.nonce)\n\(r.expiresAt)"
            .data(using: .utf8)!
    }

    // MARK: - Secure Enclave key

    /// Generate the enclave key if absent. Private-key use requires biometrics
    /// (Face ID) and the key is bound to this device. Returns the private key ref.
    @discardableResult
    private static func ensureKey() throws -> SecKey {
        if let existing = try loadKey() { return existing }

        var acError: Unmanaged<CFError>?
        guard let access = SecAccessControlCreateWithFlags(
            kCFAllocatorDefault,
            kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
            [.privateKeyUsage, .biometryCurrentSet],
            &acError
        ) else {
            throw error("access control", acError)
        }

        let attrs: [String: Any] = [
            kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
            kSecAttrKeySizeInBits as String: 256,
            kSecAttrTokenID as String: kSecAttrTokenIDSecureEnclave,
            kSecPrivateKeyAttrs as String: [
                kSecAttrIsPermanent as String: true,
                kSecAttrApplicationTag as String: keyTag,
                kSecAttrAccessControl as String: access,
            ],
        ]

        var error: Unmanaged<CFError>?
        guard let key = SecKeyCreateRandomKey(attrs as CFDictionary, &error) else {
            throw self.error("key generation", error)
        }
        return key
    }

    private static func loadKey() throws -> SecKey? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassKey,
            kSecAttrApplicationTag as String: keyTag,
            kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
            kSecReturnRef as String: true,
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else {
            throw NSError(domain: "TradeApproval", code: Int(status),
                          userInfo: [NSLocalizedDescriptionKey: "Keychain load failed (\(status))"])
        }
        return (item as! SecKey)
    }

    /// Raw uncompressed P-256 public point (0x04||X||Y), base64 — the format the
    /// server's publicKeyFromRawP256() expects.
    private static func rawPublicKeyBase64(_ privateKey: SecKey) throws -> String {
        guard let pub = SecKeyCopyPublicKey(privateKey) else {
            throw NSError(domain: "TradeApproval", code: -1,
                          userInfo: [NSLocalizedDescriptionKey: "No public key"])
        }
        var error: Unmanaged<CFError>?
        guard let data = SecKeyCopyExternalRepresentation(pub, &error) as Data? else {
            throw self.error("export public key", error)
        }
        return data.base64EncodedString()
    }

    /// Sign with the enclave key. This call presents Face ID (uses the app's
    /// NSFaceIDUsageDescription). Returns an X9.62 DER ECDSA signature, which
    /// matches the server's default dsaEncoding.
    private static func sign(_ data: Data) throws -> Data {
        let key = try ensureKey()
        var error: Unmanaged<CFError>?
        guard let sig = SecKeyCreateSignature(
            key, .ecdsaSignatureMessageX962SHA256, data as CFData, &error
        ) as Data? else {
            throw self.error("sign", error)
        }
        return sig
    }

    private static func error(_ what: String, _ e: Unmanaged<CFError>?) -> Error {
        let underlying = e?.takeRetainedValue()
        return NSError(domain: "TradeApproval", code: -1, userInfo: [
            NSLocalizedDescriptionKey: "\(what) failed: \(underlying.map(String.init(describing:)) ?? "unknown")"
        ])
    }

    // MARK: - Pairing / registration

    static var isRegistered: Bool { UserDefaults.standard.string(forKey: deviceIdKey) != nil }

    /// Enroll this device: generate the enclave key and register its public key
    /// + APNs token with the web app, authorized by a one-time pairing code that
    /// the user copies from the dashboard.
    static func register(pairingCode: String, deviceName: String = UIDeviceName()) async throws {
        let key = try ensureKey()
        let publicKey = try rawPublicKeyBase64(key)
        guard let apnsToken = UserDefaults.standard.string(forKey: apnsTokenKey) else {
            throw NSError(domain: "TradeApproval", code: -1, userInfo: [
                NSLocalizedDescriptionKey: "No APNs token yet — open the app once with notifications enabled."
            ])
        }

        let body: [String: Any] = [
            "pairingCode": pairingCode.trimmingCharacters(in: .whitespacesAndNewlines).uppercased(),
            "name": deviceName,
            "publicKey": publicKey,
            "apnsToken": apnsToken,
        ]
        let json = try await post("/api/approval-devices/register", body: body)
        guard let deviceId = json["deviceId"] as? String else {
            throw NSError(domain: "TradeApproval", code: -1,
                          userInfo: [NSLocalizedDescriptionKey: "Registration returned no deviceId"])
        }
        UserDefaults.standard.set(deviceId, forKey: deviceIdKey)
    }

    // MARK: - Approve / deny

    /// Approve a pending execution: present Face ID, sign, POST. Throws on any
    /// failure (caller should surface to the user).
    static func approve(_ r: Request) async throws {
        let signature = try sign(message(for: r))
        _ = try await post("/api/orders/approve", body: [
            "executionId": r.executionId,
            "decision": "approve",
            "signature": signature.base64EncodedString(),
        ])
    }

    /// Deny a pending execution (no signature needed; knowledge of the random
    /// executionId is the capability).
    static func deny(_ r: Request) async throws {
        _ = try await post("/api/orders/approve", body: [
            "executionId": r.executionId,
            "decision": "deny",
        ])
    }

    /// Non-throwing wrappers for the notification-action handlers: run the call,
    /// then broadcast a result so the UI can confirm or show the error.
    static func handleApprove(_ r: Request) async {
        do {
            try await approve(r)
            postResult(success: true, message: "Trade approved · \(r.summary)")
        } catch {
            postResult(success: false, message: "Approval failed: \(error.localizedDescription)")
        }
    }

    static func handleDeny(_ r: Request) async {
        do {
            try await deny(r)
            postResult(success: true, message: "Trade denied")
        } catch {
            postResult(success: false, message: "Deny failed: \(error.localizedDescription)")
        }
    }

    private static func postResult(success: Bool, message: String) {
        NotificationCenter.default.post(
            name: .tradeApprovalResult, object: nil,
            userInfo: ["success": success, "message": message])
    }

    // MARK: - Networking

    @discardableResult
    private static func post(_ path: String, body: [String: Any]) async throws -> [String: Any] {
        var req = URLRequest(url: baseURL.appendingPathComponent(path))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, resp) = try await URLSession.shared.data(for: req)
        let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            let msg = (json["error"] as? String) ?? "HTTP error"
            throw NSError(domain: "TradeApproval", code: -1, userInfo: [NSLocalizedDescriptionKey: msg])
        }
        return json
    }
}

extension Notification.Name {
    /// Posted when an approval push is tapped without choosing an action — the
    /// app should surface the pending approval (object is a TradeApproval.Request).
    static let openTradeApproval = Notification.Name("openTradeApproval")
    /// Posted after an approve/deny completes; userInfo: ["success": Bool, "message": String].
    static let tradeApprovalResult = Notification.Name("tradeApprovalResult")
}

#if canImport(UIKit)
import UIKit
func UIDeviceName() -> String { UIDevice.current.name }
#else
func UIDeviceName() -> String { Host.current().localizedName ?? "Mac" }
#endif

// Wiring (already applied):
//   - JoriApp.swift (iOS AppDelegate): registerNotificationCategory() at launch;
//     approve/deny routed in userNotificationCenter(_:didReceive:).
//   - ContentView.swift: "Pair Trade Approval" menu item → TradeApprovalPairingView;
//     observer on .tradeApprovalResult shows the outcome.
// No new Info.plist URL scheme is required; reuses the existing push entitlement.
