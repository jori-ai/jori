//
//  ActionApproval.swift
//  Jori
//
//  Face-ID approval for actions a plugin declares as needing it
//  (lib/action-approval.mjs, docs/writing-a-plugin.md).
//
//  One generic card for every plugin: a title, labelled fields, and every
//  param the action will run with. The host files an `action_approvals` row
//  (bin/approval); a time-sensitive push opens ActionApprovalReviewView, which
//  loads the row by id, never trusting the push payload.
//
//  What makes the signature mean "the user saw THIS": the app rebuilds the
//  canonical JSON from the typed values it displays and hashes it itself
//  (canonicalJSON below mirrors canonicalStringify in agent/core/app-approval.mjs;
//  parity is pinned by tests/action-approval.test.mjs). A mismatch, or any
//  value the card can't show, means no signature.
//
//  Signing: the paired purchase key (PurchaseApproval.signWithPairedKey), over
//  the fixed domain `jori-action.v1`. The domain is a constant here, not read
//  from the row or from config, so an action signature can never be a
//  purchase or self-improvement signature, and the reverse.
//

import Foundation
import CryptoKit
import UserNotifications

enum ActionApproval {

    static let category = "JORI_ACTION_APPROVAL"
    static let pushKind = "jori-action-approval"
    static let domain = "jori-action.v1"

    /// Pairing is shared with purchases.
    static var isRegistered: Bool { PurchaseApproval.isRegistered }

    static func registerNotificationCategory() {
        let cat = UNNotificationCategory(identifier: category, actions: [], intentIdentifiers: [], options: [])
        let center = UNUserNotificationCenter.current()
        center.getNotificationCategories { existing in
            var merged = existing.filter { $0.identifier != category }
            merged.insert(cat)
            center.setNotificationCategories(merged)
        }
    }

    /// The approval id from an action-approval push, or nil if it isn't one.
    static func approvalId(from userInfo: [AnyHashable: Any]) -> String? {
        guard let kind = userInfo["kind"] as? String, kind == pushKind else { return nil }
        return userInfo["approval_id"] as? String
    }

    // MARK: - Model

    /// A param value: only what hashes the same in Swift and JS. A float or a
    /// nested value fails to decode, so the card never shows and nothing signs.
    enum Scalar: Decodable, Equatable {
        case string(String), int(Int), bool(Bool), null

        init(from decoder: Decoder) throws {
            let c = try decoder.singleValueContainer()
            if c.decodeNil() { self = .null; return }
            if let b = try? c.decode(Bool.self) { self = .bool(b); return }
            if let i = try? c.decode(Int.self) { self = .int(i); return }
            self = .string(try c.decode(String.self))
        }

        var display: String {
            switch self {
            case .string(let s): return s
            case .int(let i): return String(i)
            case .bool(let b): return b ? "yes" : "no"
            case .null: return "—"
            }
        }
    }

    struct Field: Decodable, Equatable {
        let label: String
        let value: String
    }

    /// Exactly the keys of normalizeActionItem(). Anything else the server put
    /// in item_json is not displayed, so not hashed, so the hash check fails.
    struct Item: Decodable, Equatable {
        let v: Int
        let plugin: String
        let action: String
        let title: String
        let fields: [Field]
        let params: [String: Scalar]

        var sortedParams: [(key: String, value: Scalar)] {
            params.sorted { Array($0.key.utf16).lexicographicallyPrecedes(Array($1.key.utf16)) }
                .map { (key: $0.key, value: $0.value) }
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

        enum CodingKeys: String, CodingKey {
            case id, status, nonce
            case item = "item_json"
            case itemHash = "item_hash"
            case expiresAtMs = "expires_at_ms"
            case requestText = "request_text"
        }

        var expiresAt: Date { Date(timeIntervalSince1970: Double(expiresAtMs) / 1000) }
        var isActionable: Bool { status == "pending" && expiresAt > Date() }
    }

    struct Ref: Identifiable, Equatable { let id: String }

    // MARK: - Canonical JSON (mirror of canonicalStringify in app-approval.mjs)

    private indirect enum JSON {
        case string(String), int(Int), bool(Bool), null, array([JSON]), object([String: JSON])
    }

    private static func json(_ it: Item) -> JSON {
        func scalar(_ s: Scalar) -> JSON {
            switch s {
            case .string(let x): return .string(x)
            case .int(let x): return .int(x)
            case .bool(let x): return .bool(x)
            case .null: return .null
            }
        }
        return .object([
            "v": .int(it.v),
            "plugin": .string(it.plugin),
            "action": .string(it.action),
            "title": .string(it.title),
            "fields": .array(it.fields.map { .object(["label": .string($0.label), "value": .string($0.value)]) }),
            "params": .object(it.params.mapValues(scalar)),
        ])
    }

    private static func encode(_ v: JSON) -> String {
        switch v {
        case .string(let s): return PurchaseApproval.quote(s)
        case .int(let i): return String(i)
        case .bool(let b): return b ? "true" : "false"
        case .null: return "null"
        case .array(let a): return "[" + a.map(encode).joined(separator: ",") + "]"
        case .object(let o):
            // JS sorts keys by UTF-16 code unit.
            let keys = o.keys.sorted { Array($0.utf16).lexicographicallyPrecedes(Array($1.utf16)) }
            return "{" + keys.map { PurchaseApproval.quote($0) + ":" + encode(o[$0]!) }.joined(separator: ",") + "}"
        }
    }

    static func canonicalJSON(_ it: Item) -> String { encode(json(it)) }

    static func hash(_ it: Item) -> String {
        SHA256.hash(data: Data(canonicalJSON(it).utf8)).map { String(format: "%02x", $0) }.joined()
    }

    // MARK: - Supabase I/O

    private static let columns = "id,status,item_json,item_hash,nonce,expires_at_ms,request_text"

    static func fetch(_ id: String) async throws -> Request? {
        try await SupabaseManager.ensureAuthenticated()
        let rows: [Request] = try await SupabaseManager.shared
            .from("action_approvals").select(columns)
            .eq("id", value: id).limit(1).execute().value
        return rows.first
    }

    /// The newest still-actionable request, so a missed push still surfaces.
    static func fetchPendingId() async throws -> String? {
        try await SupabaseManager.ensureAuthenticated()
        let nowMs = Int64(Date().timeIntervalSince1970 * 1000)
        struct Row: Decodable { let id: String }
        let rows: [Row] = try await SupabaseManager.shared
            .from("action_approvals").select("id")
            .eq("status", value: "pending")
            .gt("expires_at_ms", value: String(nowMs))
            .order("created_at", ascending: false).limit(1).execute().value
        return rows.first?.id
    }

    struct Waiting: Identifiable {
        let id: String
        let title: String
        let expiresAt: Date
    }

    /// Every still-actionable request, newest first (Pending approvals list).
    static func fetchWaiting() async throws -> [Waiting] {
        try await SupabaseManager.ensureAuthenticated()
        let nowMs = Int64(Date().timeIntervalSince1970 * 1000)
        struct Row: Decodable {
            let id: String
            let plugin: String
            let item_json: TitleOnly
            let expires_at_ms: Int64
            struct TitleOnly: Decodable { let title: String }
        }
        let rows: [Row] = try await SupabaseManager.shared
            .from("action_approvals").select("id,plugin,item_json,expires_at_ms")
            .eq("status", value: "pending")
            .gt("expires_at_ms", value: String(nowMs))
            .order("created_at", ascending: false).execute().value
        return rows.map {
            Waiting(id: $0.id, title: $0.item_json.title,
                    expiresAt: Date(timeIntervalSince1970: Double($0.expires_at_ms) / 1000))
        }
    }

    enum ApprovalError: LocalizedError {
        case mismatch, notPaired, expired
        var errorDescription: String? {
            switch self {
            case .mismatch: return "This request doesn't match what's shown, so it can't be approved. Deny it and ask \(Install.displayName) again."
            case .notPaired: return "This \(PurchaseApproval.deviceNoun) isn't paired for approvals yet (menu → Pair Purchase Approval)."
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
        let signature = try PurchaseApproval.signWithPairedKey(Data(message.utf8), reason: "Approve: \(r.item.title)")

        struct Signed: Encodable { let signature, signed_by, status, decided_at: String }
        try await SupabaseManager.shared
            .from("action_approvals")
            .update(Signed(signature: signature.base64EncodedString(), signed_by: PurchaseApproval.deviceId,
                           status: "signed", decided_at: ISO8601DateFormatter().string(from: Date())))
            .eq("id", value: r.id).eq("status", value: "pending")
            .execute()
    }

    static func deny(_ r: Request) async throws {
        try await SupabaseManager.ensureAuthenticated()
        struct Denied: Encodable { let status, decided_at: String }
        try await SupabaseManager.shared
            .from("action_approvals")
            .update(Denied(status: "denied", decided_at: ISO8601DateFormatter().string(from: Date())))
            .eq("id", value: r.id).eq("status", value: "pending")
            .execute()
    }
}

extension Notification.Name {
    static let openActionApproval = Notification.Name("openActionApproval")
}
