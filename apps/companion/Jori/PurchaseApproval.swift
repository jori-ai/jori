//
//  PurchaseApproval.swift
//  Jori
//
//  Face-ID approval for purchases Jori makes on the user's behalf.
//
//  Requirement: any purchase, at any amount, needs Face ID approval in the app,
//  and the approval screen shows what is being bought, for how much, the card
//  that pays and the delivery address.
//
//  The host drives a checkout to its final review page and files a
//  `purchase_approvals` row (bin/purchase). A time-sensitive push opens
//  PurchaseApprovalReviewView, which loads the row by id — never trusting the
//  push payload — and shows items, total, card, ship-to and a screenshot of the
//  actual review page.
//
//  What makes the signature mean "the user saw THIS": the app rebuilds the
//  canonical JSON from the typed fields it displays and hashes it itself
//  (canonicalJSON below mirrors canonicalStringify in
//  agent/core/app-approval.mjs byte for byte; parity is pinned by
//  tests/purchase-approval.test.mjs). If that hash differs from the row's,
//  or the screenshot's hash differs from the one inside the item, it refuses to
//  sign. The signed message carries its own domain (`jori-purchase.v1`, or the
//  installation's JORI_SIGNING_PURCHASE), and
//  uses its own Secure Enclave key, so no self-improvement or trade approval can
//  be replayed as a purchase. The host's poller verifies and only then clicks
//  Place Order (bin/purchase-approval-poll).
//
//  Pairing: the purchase key is registered only through the
//  pair_purchase_device RPC, which burns a one-time code minted on the host
//  (`purchase pair`) — a stolen app session alone cannot add a signing device.
//

import Foundation
import Security
import LocalAuthentication
import CryptoKit
import UserNotifications
#if os(macOS)
import AppKit
#else
import UIKit
#endif

enum PurchaseApproval {

    // MARK: - Config

    static let category = "JORI_PURCHASE_APPROVAL"
    static let pushKind = "jori-purchase-approval"
    /// What a server that predates Jori still sends (JORI_LEGACY_NAME).
    private static var legacyPushKind: String? {
        Install.legacyName.isEmpty ? nil : "\(Install.legacyName)-purchase-approval"
    }
    private static let domain = Install.purchaseSigningDomain
    private static let keyTag = Install.keyTag("purchaseKey")
    private static let deviceIdKey = Install.key("purchase.deviceId")
    private static let registeredKey = Install.key("purchase.registered")

    static var deviceId: String {
        if let existing = UserDefaults.standard.string(forKey: deviceIdKey) { return existing }
        let id = UUID().uuidString
        UserDefaults.standard.set(id, forKey: deviceIdKey)
        return id
    }

    static var isRegistered: Bool { UserDefaults.standard.bool(forKey: registeredKey) }

    /// "Face ID" on iPhone, "Touch ID" on a Mac — whatever this device's sensor is.
    static var biometryName: String {
        let ctx = LAContext()
        _ = ctx.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil)
        switch ctx.biometryType {
        case .faceID: return "Face ID"
        case .touchID: return "Touch ID"
        default:
            #if os(macOS)
            return "Touch ID"
            #else
            return "Face ID"
            #endif
        }
    }

    static var deviceNoun: String {
        #if os(macOS)
        return "Mac"
        #else
        return "iPhone"
        #endif
    }

    /// App-came-forward notification, per platform (re-check for a pending purchase).
    static var didBecomeActive: Notification.Name {
        #if os(macOS)
        return NSApplication.didBecomeActiveNotification
        #else
        return UIApplication.didBecomeActiveNotification
        #endif
    }

    /// No action buttons: tapping the push only opens the review screen.
    static func registerNotificationCategory() {
        let cat = UNNotificationCategory(identifier: category, actions: [], intentIdentifiers: [], options: [])
        let center = UNUserNotificationCenter.current()
        center.getNotificationCategories { existing in
            var merged = existing.filter { $0.identifier != category }
            merged.insert(cat)
            center.setNotificationCategories(merged)
        }
    }

    /// The purchase id from a purchase-approval push, or nil if it isn't one.
    static func purchaseId(from userInfo: [AnyHashable: Any]) -> String? {
        guard let kind = userInfo["kind"] as? String,
              kind == pushKind || kind == legacyPushKind else { return nil }
        return userInfo["purchase_id"] as? String
    }

    // MARK: - Model

    struct Line: Codable, Equatable {
        let title: String
        let qty: Int
        let lineCents: Int?
        enum CodingKeys: String, CodingKey { case title, qty, lineCents = "line_cents" }
    }

    struct Card: Codable, Equatable {
        let label: String
        let last4: String
    }

    struct ShipTo: Codable, Equatable {
        let name: String
        let address: String
    }

    /// Exactly the fields of normalizePurchaseItem() — nothing more. Anything
    /// the server put in item_json that isn't here is not displayed, and so is
    /// not hashed; the hash check then fails and the app refuses to sign.
    struct Item: Codable, Equatable {
        let v: Int
        let merchant: String
        let site: String
        let items: [Line]
        let subtotalCents: Int?
        let shippingCents: Int?
        let taxCents: Int?
        let discountCents: Int?
        let totalCents: Int
        let currency: String
        let card: Card
        let shipTo: ShipTo?
        let screenshotSha256: String

        enum CodingKeys: String, CodingKey {
            case v, merchant, site, items, currency, card
            case subtotalCents = "subtotal_cents"
            case shippingCents = "shipping_cents"
            case taxCents = "tax_cents"
            case discountCents = "discount_cents"
            case totalCents = "total_cents"
            case shipTo = "ship_to"
            case screenshotSha256 = "screenshot_sha256"
        }
    }

    struct Request: Identifiable, Decodable {
        let id: String
        let status: String
        let item: Item
        let itemHash: String
        let nonce: String
        let expiresAtMs: Int64
        let requestText: String?
        /// The agent's recommendation (why this pick + e.g. a marked seat map).
        /// Advisory: not part of `item`, so not hashed or signed.
        let context: Context?

        struct Context: Decodable {
            let note: String?
            let imageUrl: String?
            enum CodingKeys: String, CodingKey { case note, imageUrl = "image_url" }

            /// Only pictures from Jori's own Storage bucket are shown.
            var image: URL? {
                let ownStorage = SupabaseConfig.url.appendingPathComponent("storage/v1/object/public").absoluteString + "/"
                guard let s = imageUrl, s.hasPrefix(ownStorage) else { return nil }
                return URL(string: s)
            }
        }

        enum CodingKeys: String, CodingKey {
            case id, status, nonce
            case item = "item_json"
            case itemHash = "item_hash"
            case expiresAtMs = "expires_at_ms"
            case requestText = "request_text"
            case context = "context_json"
        }

        var expiresAt: Date { Date(timeIntervalSince1970: Double(expiresAtMs) / 1000) }
        var isActionable: Bool { status == "pending" && expiresAt > Date() }
    }

    /// Lightweight handle for presenting the review screen.
    struct Ref: Identifiable, Equatable { let id: String }

    // MARK: - Canonical JSON (mirror of canonicalStringify in app-approval.mjs)

    private indirect enum JSON {
        case string(String), int(Int), null, array([JSON]), object([String: JSON])
    }

    private static func json(_ it: Item) -> JSON {
        func opt(_ i: Int?) -> JSON { i.map { .int($0) } ?? .null }
        return .object([
            "v": .int(it.v),
            "merchant": .string(it.merchant),
            "site": .string(it.site),
            "items": .array(it.items.map { .object([
                "title": .string($0.title), "qty": .int($0.qty), "line_cents": opt($0.lineCents),
            ]) }),
            "subtotal_cents": opt(it.subtotalCents),
            "shipping_cents": opt(it.shippingCents),
            "tax_cents": opt(it.taxCents),
            "discount_cents": opt(it.discountCents),
            "total_cents": .int(it.totalCents),
            "currency": .string(it.currency),
            "card": .object(["label": .string(it.card.label), "last4": .string(it.card.last4)]),
            "ship_to": it.shipTo.map { .object(["name": .string($0.name), "address": .string($0.address)]) } ?? .null,
            "screenshot_sha256": .string(it.screenshotSha256),
        ])
    }

    /// JSON.stringify's string escaping, exactly: \" \\ \b \f \n \r \t, other
    /// controls as lowercase \u00xx, everything else (incl. "/" and non-ASCII)
    /// literal. Foundation's JSONSerialization escapes "/" — hence hand-rolled.
    private static func quote(_ s: String) -> String {
        // Work in UTF-16 code units (as JS does) and decode once at the end, so
        // surrogate pairs (emoji) pass through intact.
        var out: [UInt16] = [0x22]
        func ascii(_ s: String) { out.append(contentsOf: s.utf16) }
        for u in s.utf16 {
            switch u {
            case 0x22: ascii("\\\"")
            case 0x5C: ascii("\\\\")
            case 0x08: ascii("\\b")
            case 0x0C: ascii("\\f")
            case 0x0A: ascii("\\n")
            case 0x0D: ascii("\\r")
            case 0x09: ascii("\\t")
            case 0..<0x20: ascii(String(format: "\\u%04x", u))
            default: out.append(u)
            }
        }
        out.append(0x22)
        return String(decoding: out, as: UTF16.self)
    }

    private static func encode(_ v: JSON) -> String {
        switch v {
        case .string(let s): return quote(s)
        case .int(let i): return String(i)
        case .null: return "null"
        case .array(let a): return "[" + a.map(encode).joined(separator: ",") + "]"
        case .object(let o):
            // JS sorts keys by UTF-16 code unit; every key here is ASCII.
            let keys = o.keys.sorted { Array($0.utf16).lexicographicallyPrecedes(Array($1.utf16)) }
            return "{" + keys.map { quote($0) + ":" + encode(o[$0]!) }.joined(separator: ",") + "}"
        }
    }

    static func canonicalJSON(_ it: Item) -> String { encode(json(it)) }

    static func hash(_ it: Item) -> String {
        SHA256.hash(data: Data(canonicalJSON(it).utf8)).map { String(format: "%02x", $0) }.joined()
    }

    // MARK: - Supabase I/O

    private static let columns = "id,status,item_json,item_hash,nonce,expires_at_ms,request_text,context_json"

    static func fetch(_ id: String) async throws -> Request? {
        try await SupabaseManager.ensureAuthenticated()
        let rows: [Request] = try await SupabaseManager.shared
            .from("purchase_approvals").select(columns)
            .eq("id", value: id).limit(1).execute().value
        return rows.first
    }

    /// The newest still-actionable request, if any — so a missed push still
    /// surfaces the review screen the next time the app comes forward.
    static func fetchPendingId() async throws -> String? {
        try await SupabaseManager.ensureAuthenticated()
        let nowMs = Int64(Date().timeIntervalSince1970 * 1000)
        struct Row: Decodable { let id: String }
        let rows: [Row] = try await SupabaseManager.shared
            .from("purchase_approvals").select("id")
            .eq("status", value: "pending")
            .gt("expires_at_ms", value: String(nowMs))
            .order("created_at", ascending: false).limit(1).execute().value
        return rows.first?.id
    }

    /// The review-page screenshot, verified against the hash inside the item —
    /// so the picture the user approves is the one the signature covers.
    static func screenshot(for r: Request) async throws -> Data? {
        struct Row: Decodable { let screenshot_b64: String? }
        let rows: [Row] = try await SupabaseManager.shared
            .from("purchase_approvals").select("screenshot_b64")
            .eq("id", value: r.id).limit(1).execute().value
        guard let b64 = rows.first?.screenshot_b64, let data = Data(base64Encoded: b64) else { return nil }
        let h = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        return h == r.item.screenshotSha256 ? data : nil
    }

    enum ApprovalError: LocalizedError {
        case mismatch, notPaired, expired
        var errorDescription: String? {
            switch self {
            case .mismatch: return "This request doesn't match what's shown, so it can't be approved. Deny it and ask Jori again."
            case .notPaired: return "This \(PurchaseApproval.deviceNoun) isn't paired for purchases yet (menu → Pair Purchase Approval)."
            case .expired: return "This request has expired."
            }
        }
    }

    /// Face ID → sign → write the decision. Signs only what is on screen.
    static func approve(_ r: Request) async throws {
        guard isRegistered else { throw ApprovalError.notPaired }
        guard r.isActionable else { throw ApprovalError.expired }
        let h = hash(r.item)
        guard h == r.itemHash else { throw ApprovalError.mismatch }
        let message = "\(domain)\n\(r.id)\n\(h)\n\(r.nonce)\n\(r.expiresAtMs)"
        let reason = "Approve \(money(r.item.totalCents, r.item.currency)) at \(r.item.merchant)"
        let signature = try sign(Data(message.utf8), reason: reason)

        struct Signed: Encodable { let signature, signed_by, status, decided_at: String }
        try await SupabaseManager.shared
            .from("purchase_approvals")
            .update(Signed(signature: signature.base64EncodedString(), signed_by: deviceId,
                           status: "signed", decided_at: ISO8601DateFormatter().string(from: Date())))
            .eq("id", value: r.id).eq("status", value: "pending")
            .execute()
    }

    static func deny(_ r: Request) async throws {
        try await SupabaseManager.ensureAuthenticated()
        struct Denied: Encodable { let status, decided_at: String }
        try await SupabaseManager.shared
            .from("purchase_approvals")
            .update(Denied(status: "denied", decided_at: ISO8601DateFormatter().string(from: Date())))
            .eq("id", value: r.id).eq("status", value: "pending")
            .execute()
    }

    /// Pair this device's purchase key using a code from `purchase pair` on the host.
    static func pair(code: String) async throws {
        try await SupabaseManager.ensureAuthenticated()
        let key = try ensureKey()
        struct Params: Encodable { let p_code, p_device_id, p_public_key_raw, p_device_name: String }
        try await SupabaseManager.shared
            .rpc("pair_purchase_device", params: Params(
                p_code: code, p_device_id: deviceId,
                p_public_key_raw: try rawPublicKeyBase64(key), p_device_name: UIDeviceName()))
            .execute()
        UserDefaults.standard.set(true, forKey: registeredKey)
    }

    static func money(_ cents: Int, _ currency: String) -> String {
        let f = NumberFormatter()
        f.numberStyle = .currency
        f.currencyCode = currency
        return f.string(from: NSNumber(value: Double(cents) / 100)) ?? "\(cents / 100) \(currency)"
    }

    // MARK: - Secure Enclave key (separate tag from trade + self-improve keys)

    @discardableResult
    private static func ensureKey() throws -> SecKey {
        if let existing = try loadKey() { return existing }
        var acError: Unmanaged<CFError>?
        guard let access = SecAccessControlCreateWithFlags(
            kCFAllocatorDefault, kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
            [.privateKeyUsage, .biometryCurrentSet], &acError
        ) else { throw error("access control", acError) }
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
        var genError: Unmanaged<CFError>?
        guard let key = SecKeyCreateRandomKey(attrs as CFDictionary, &genError) else {
            throw error("key generation", genError)
        }
        return key
    }

    private static func loadKey(context: LAContext? = nil) throws -> SecKey? {
        var query: [String: Any] = [
            kSecClass as String: kSecClassKey,
            kSecAttrApplicationTag as String: keyTag,
            kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
            kSecReturnRef as String: true,
        ]
        if let context { query[kSecUseAuthenticationContext as String] = context }
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else {
            throw NSError(domain: "PurchaseApproval", code: Int(status),
                          userInfo: [NSLocalizedDescriptionKey: "Keychain load failed (\(status))"])
        }
        return (item as! SecKey)
    }

    private static func rawPublicKeyBase64(_ privateKey: SecKey) throws -> String {
        guard let pub = SecKeyCopyPublicKey(privateKey) else {
            throw NSError(domain: "PurchaseApproval", code: -1, userInfo: [NSLocalizedDescriptionKey: "No public key"])
        }
        var err: Unmanaged<CFError>?
        guard let data = SecKeyCopyExternalRepresentation(pub, &err) as Data? else { throw error("export public key", err) }
        return data.base64EncodedString()
    }

    /// Face ID prompt names the amount and merchant being approved.
    private static func sign(_ data: Data, reason: String) throws -> Data {
        let context = LAContext()
        context.localizedReason = reason
        guard let key = try loadKey(context: context) else { throw ApprovalError.notPaired }
        var err: Unmanaged<CFError>?
        guard let sig = SecKeyCreateSignature(key, .ecdsaSignatureMessageX962SHA256, data as CFData, &err) as Data? else {
            throw error("sign", err)
        }
        return sig
    }

    private static func error(_ what: String, _ e: Unmanaged<CFError>?) -> Error {
        let underlying = e?.takeRetainedValue()
        return NSError(domain: "PurchaseApproval", code: -1, userInfo: [
            NSLocalizedDescriptionKey: "\(what) failed: \(underlying.map(String.init(describing:)) ?? "unknown")"
        ])
    }
}

extension Notification.Name {
    static let openPurchaseApproval = Notification.Name("openPurchaseApproval")
}
