//
//  SelfImproveApproval.swift
//  Jori
//
//  Owner approval + status feed for Jori's UNIFIED self-improvement flow (WP11
//  capabilities + the nightly executor's fixes). Every improvement is a row in
//  `self_improve_approvals` and surfaces as a card in the app's "Improvements"
//  channel:
//    - HIGH-risk changes start as `pending` — the user approves from the card,
//      which signs a canonical message with a P-256 key held in THIS device's
//      Secure Enclave (Face ID gated). The signature is written back to Supabase;
//      the host's poller (`bin/self-improve-approval-poll`) verifies it
//      deterministically (core/app-approval.mjs) against this device's registered
//      public key and only then applies the change.
//    - Low/moderate changes auto-apply on the host and appear here already done.
//
//  Card status drives the UI: pending → tap to approve; signed/approved →
//  in-progress; applied → green check; failed/apply_failed → error. Nothing on
//  the host — and no LLM — can produce the signature, so a compromise there
//  (or a hallucinated "approval") cannot load new capability or land a
//  high-risk fix.
//    - `apply_failed` (a failed improvement can be retried) is a MECHANICAL failure on an already-verified
//      item — the write/commit step threw after signature verification
//      passed, distinct from `failed` (signature/authorization itself didn't
//      check out). Retry on one of these flips it to
//      `retry_requested`; the poller re-runs the apply with NO new Face ID,
//      because the original signature already proved the user authorized this
//      exact item — a git-hook conflict or transient error isn't a fresh
//      authorization decision. `failed` cards have no retry action; that
//      requires a brand-new approval, signed again.
//    - SKIPPED (marks a card the user decided not to implement, reversible
//      by unskipping it) is a
//      BOOLEAN alongside the status, never a status of its own. Keeping the two
//      orthogonal is what makes unskip trivially correct: the lifecycle is never
//      overwritten, so a card skipped out of `apply_failed` comes back
//      retryable rather than back to square one. A skipped card is dropped by
//      the poller, excluded from the badge, sorted to the bottom of the feed,
//      and — the point of the whole feature — must not be re-proposed by the
//      weekly improvement-plan job.
//  Same trust model as TradeApproval.swift; a SEPARATE Enclave key so the two are
//  independent. Transport is Supabase directly (the app's authenticated session);
//  RLS restricts these tables to authenticated sessions, the host reads via service role.
//

import Foundation
import Security
import LocalAuthentication

enum SelfImproveApproval {

    // MARK: - Config

    private static let keyTag = Install.keyTag("selfImproveKey")
    private static let deviceIdKey = Install.key("selfImprove.deviceId")
    private static let registeredKey = Install.key("selfImprove.registered")

    /// Stable id for this install, minted once. Ties our registered public key
    /// (approval_device_keys.device_id) to the `signed_by` we stamp on each
    /// approval so the poller looks up the right key.
    static var deviceId: String {
        if let existing = UserDefaults.standard.string(forKey: deviceIdKey) { return existing }
        let id = UUID().uuidString
        UserDefaults.standard.set(id, forKey: deviceIdKey)
        return id
    }

    static var isRegistered: Bool { UserDefaults.standard.bool(forKey: registeredKey) }

    // MARK: - Model (a self_improve_approvals row)

    enum Phase { case needsApproval, inProgress, done, failed, skipped }

    struct Improvement: Identifiable, Codable, Equatable {
        let id: String
        let itemType: String
        let summary: String
        let rationale: String?
        let itemHash: String?
        let nonce: String?
        let status: String
        let risk: String?
        /// The user decided not to implement this. Deliberately separate from
        /// `status` (which is preserved underneath) — see the file header.
        let skipped: Bool
        /// The chat-channel message anchoring this card's conversation, created
        /// on demand by the card's Chat action. Non-nil once a thread exists,
        /// so re-opening Chat continues it instead of forking a new one.
        let chatMessageId: UUID?
        /// Epoch milliseconds — the EXACT integer bound into the signed message,
        /// read verbatim (never reconstructed from a timestamp) so the signed
        /// bytes match the host's to the millisecond. Optional so a malformed row
        /// can't fail-decode the whole feed; approve() requires it.
        let expiresAtMs: Int64?

        enum CodingKeys: String, CodingKey {
            case id
            case itemType = "item_type"
            case summary
            case rationale
            case itemHash = "item_hash"
            case nonce
            case status
            case risk
            case skipped
            case chatMessageId = "chat_message_id"
            case expiresAtMs = "expires_at_ms"
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = try c.decode(String.self, forKey: .id)
            itemType = try c.decode(String.self, forKey: .itemType)
            summary = try c.decode(String.self, forKey: .summary)
            rationale = try c.decodeIfPresent(String.self, forKey: .rationale)
            itemHash = try c.decodeIfPresent(String.self, forKey: .itemHash)
            nonce = try c.decodeIfPresent(String.self, forKey: .nonce)
            status = try c.decode(String.self, forKey: .status)
            risk = try c.decodeIfPresent(String.self, forKey: .risk)
            // Tolerate rows written before the skip columns existed.
            skipped = (try c.decodeIfPresent(Bool.self, forKey: .skipped)) ?? false
            chatMessageId = try c.decodeIfPresent(UUID.self, forKey: .chatMessageId)
            expiresAtMs = try c.decodeIfPresent(Int64.self, forKey: .expiresAtMs)
        }

        init(id: String, itemType: String, summary: String, rationale: String?,
             itemHash: String?, nonce: String?, status: String, risk: String?,
             skipped: Bool = false, chatMessageId: UUID? = nil, expiresAtMs: Int64?) {
            self.id = id
            self.itemType = itemType
            self.summary = summary
            self.rationale = rationale
            self.itemHash = itemHash
            self.nonce = nonce
            self.status = status
            self.risk = risk
            self.skipped = skipped
            self.chatMessageId = chatMessageId
            self.expiresAtMs = expiresAtMs
        }

        var isExpired: Bool {
            guard let ms = expiresAtMs else { return false }
            return ms <= Int64(Date().timeIntervalSince1970 * 1000)
        }

        /// Does this card need the user's Face ID? Only pending, high-risk,
        /// unexpired — and not skipped, since a skipped card is a decision
        /// already made (Implement on one un-skips it first; see the view).
        var needsApproval: Bool {
            guard !skipped, status == "pending", (risk ?? "high") == "high" else { return false }
            return !isExpired
        }

        var phase: Phase {
            if skipped { return .skipped }
            switch status {
            case "pending":                      return needsApproval ? .needsApproval : .inProgress
            case "signed", "approved":            return .inProgress
            case "retry_requested":               return .inProgress
            case "applied":                       return .done
            default:                              return .failed   // failed/apply_failed/denied/expired
            }
        }

        /// Can the Implement action sign this? True for a card that needs Face ID
        /// now, and for a SKIPPED pending card — choosing Implement on one of
        /// those is the user reversing that decision, so it un-skips (which
        /// re-arms the TTL) and then signs, rather than two menu trips.
        var isImplementable: Bool {
            needsApproval || (skipped && status == "pending")
        }

        /// Can it be marked "not doing this"? Anything not already applied and
        /// not mid-apply. Mirrors setSkipped()'s rails in
        /// agent/core/self-improve-unified.mjs — if these two disagree the
        /// menu offers an action the server will refuse.
        var isSkippable: Bool {
            !skipped && status != "applied" && !["approved", "retry_requested"].contains(status)
        }

        /// A mechanical apply failure on an item the user already Face-ID'd — the
        /// signature is still good, only the write/commit step threw. Retryable
        /// without a new signature. `failed` (a signature/authorization miss) is
        /// NOT retryable this way — see SelfImproveApproval.retry().
        var isRetryable: Bool { !skipped && status == "apply_failed" }
    }

    /// The exact byte string the host reconstructs and verifies. MUST match
    /// canonicalMessage() in agent/core/app-approval.mjs; the context is the
    /// server's `approval_domain` (JORI_SIGNING_APPROVE).
    private static func message(for it: Improvement) throws -> Data {
        guard let hash = it.itemHash, let nonce = it.nonce, let ms = it.expiresAtMs else {
            throw NSError(domain: "SelfImproveApproval", code: -2,
                          userInfo: [NSLocalizedDescriptionKey: "Approval is missing its signing fields."])
        }
        return "\(Install.approvalSigningDomain)\n\(it.id)\n\(hash)\n\(nonce)\n\(ms)".data(using: .utf8)!
    }

    // MARK: - Supabase I/O

    /// The channel feed: recent improvements worth showing (pending → applied),
    /// newest first, with pending items floated to the top so action is obvious.
    static func fetchFeed() async throws -> [Improvement] {
        try await SupabaseManager.ensureAuthenticated()
        let columns = "id,item_type,summary,rationale,item_hash,nonce,status,risk,skipped,chat_message_id,expires_at_ms"
        let recent: [Improvement] = try await SupabaseManager.shared
            .from("self_improve_approvals")
            .select(columns)
            .in("status", values: ["pending", "signed", "approved", "applied", "failed", "apply_failed", "retry_requested"])
            .order("created_at", ascending: false)
            .limit(40)
            .execute()
            .value
        // Every unskipped pending card, however old. The 40-row window above is
        // by filing date, so a card un-skipped (re-armed) weeks after it was
        // filed fell outside it: the badge counted it, the feed never showed it
        // (2026-10-22, two cards filed Oct 1 and Oct 6, 237+ rows back).
        let pending: [Improvement] = try await SupabaseManager.shared
            .from("self_improve_approvals")
            .select(columns)
            .eq("status", value: "pending")
            .eq("skipped", value: false)
            .order("created_at", ascending: false)
            .execute()
            .value
        let recentIds = Set(recent.map(\.id))
        let rows = recent + pending.filter { !recentIds.contains($0.id) }
        // Hide expired-but-still-pending rows — nothing can be done with one, the
        // signature would be refused. A SKIPPED pending row is exempt even when
        // expired: it must stay visible to be un-skippable, and unskip re-arms
        // the TTL (setSkipped in core/self-improve-unified.mjs does the same).
        // Order: needs-you first, skipped last, everything else in between.
        // Sort on (rank, original index) rather than a bare predicate: Swift's
        // sort is NOT stable, so comparing only the rank would let same-rank
        // cards scramble out of the created_at order the query just imposed —
        // and a feed that reshuffles itself every 8s poll is unreadable.
        func rank(_ i: Improvement) -> Int { i.needsApproval ? 0 : (i.skipped ? 2 : 1) }
        return rows
            .filter { !($0.status == "pending" && !$0.needsApproval && !$0.skipped) }
            .enumerated()
            .sorted { a, b in
                rank(a.element) != rank(b.element) ? rank(a.element) < rank(b.element) : a.offset < b.offset
            }
            .map(\.element)
    }

    /// How many cards are waiting on the user's Face ID — the number the channel
    /// badge shows. Deliberately a narrow query rather than `fetchFeed()`: the
    /// badge polls on a timer from every channel, and the feed pulls 40 rows of
    /// summary+rationale prose it would immediately throw away.
    ///
    /// The predicate below MUST stay in step with `Improvement.needsApproval`
    /// (pending + high-risk + unexpired + NOT skipped) — if the badge and the
    /// feed disagree about what is actionable, the badge is worse than no badge
    /// at all. Skipped is filtered server-side: a card the user has already
    /// decided against must never keep the badge lit.
    static func pendingApprovalCount() async throws -> Int {
        try await SupabaseManager.ensureAuthenticated()

        struct PendingRow: Decodable {
            let status: String
            let risk: String?
            let expiresAtMs: Int64?

            enum CodingKeys: String, CodingKey {
                case status
                case risk
                case expiresAtMs = "expires_at_ms"
            }
        }

        let rows: [PendingRow] = try await SupabaseManager.shared
            .from("self_improve_approvals")
            .select("status,risk,expires_at_ms")
            .eq("status", value: "pending")
            .eq("skipped", value: false)
            .execute()
            .value

        let nowMs = Int64(Date().timeIntervalSince1970 * 1000)
        return rows.filter { row in
            guard (row.risk ?? "high") == "high" else { return false }
            // A row with no expiry never goes stale, same as needsApproval.
            guard let ms = row.expiresAtMs else { return true }
            return ms > nowMs
        }.count
    }

    /// Register this device's Secure Enclave public key so the host can verify our
    /// signatures. Idempotent (upsert on device_id); safe to call on every launch.
    static func registerDeviceKey() async throws {
        try await SupabaseManager.ensureAuthenticated()
        let key = try ensureKey()
        let publicKey = try rawPublicKeyBase64(key)

        struct DeviceKeyRow: Encodable {
            let device_id: String
            let public_key_raw: String
            let device_name: String
        }
        try await SupabaseManager.shared
            .from("approval_device_keys")
            .upsert(
                DeviceKeyRow(device_id: deviceId, public_key_raw: publicKey, device_name: UIDeviceName()),
                onConflict: "device_id")
            .execute()
        UserDefaults.standard.set(true, forKey: registeredKey)
    }

    /// Approve a pending high-risk change: present Face ID, sign the canonical
    /// message, write the signature back. The poller applies it after verifying.
    /// Registers our key first if we haven't (so `signed_by` resolves).
    static func approve(_ it: Improvement) async throws {
        // Implementing a skipped card is the user reversing that decision:
        // un-skip FIRST, because unskip re-arms the approval window and we must
        // sign against the refreshed expiry, not the lapsed one we were handed.
        // Re-read the row afterwards so the signed bytes match what's stored.
        var it = it
        if it.skipped {
            try await setSkipped(it, false)
            if let fresh = try? await fetchOne(it.id) { it = fresh }
        }
        let signMessage = try message(for: it)   // validate signing fields before Face ID
        if !isRegistered { try await registerDeviceKey() }
        let signature = try sign(signMessage)

        struct SignedUpdate: Encodable {
            let signature: String
            let signed_by: String
            let status: String
            let decided_at: String
        }
        try await SupabaseManager.shared
            .from("self_improve_approvals")
            .update(SignedUpdate(
                signature: signature.base64EncodedString(),
                signed_by: deviceId,
                status: "signed",
                decided_at: ISO8601DateFormatter().string(from: Date())))
            .eq("id", value: it.id)
            .execute()
    }

    /// Ask the host to retry a failed apply. No Face ID — the item was already
    /// signed and verified once (that's how it reached `apply_failed` rather
    /// than `failed`); only the mechanical write/commit step threw. The `.eq`
    /// guard on status makes this a no-op if the card raced with a fix landing
    /// through another path, rather than replaying an apply that already
    /// succeeded or moved on.
    static func retry(_ it: Improvement) async throws {
        try await SupabaseManager.ensureAuthenticated()
        struct RetryUpdate: Encodable { let status: String }
        try await SupabaseManager.shared
            .from("self_improve_approvals")
            .update(RetryUpdate(status: "retry_requested"))
            .eq("id", value: it.id)
            .eq("status", value: "apply_failed")
            .execute()
    }

    /// Re-read one row (after a write that changes what we must sign against).
    static func fetchOne(_ id: String) async throws -> Improvement? {
        let rows: [Improvement] = try await SupabaseManager.shared
            .from("self_improve_approvals")
            .select("id,item_type,summary,rationale,item_hash,nonce,status,risk,skipped,chat_message_id,expires_at_ms")
            .eq("id", value: id)
            .limit(1)
            .execute()
            .value
        return rows.first
    }

    /// Skip ("we're not implementing this") or un-skip a card.
    ///
    /// `status` is deliberately left alone — skip rides its own boolean so the
    /// lifecycle survives and un-skipping restores it exactly. Un-skipping a
    /// PENDING card also re-arms `expires_at`/`expires_at_ms`: its TTL kept
    /// running while it sat skipped, and an expired pending row is doubly dead
    /// (the feed hides it, and the host's verifier refuses it). This mirrors
    /// setSkipped() in agent/core/self-improve-unified.mjs — the two must
    /// stay in step, since either can act on the same row.
    static func setSkipped(_ it: Improvement, _ skipped: Bool) async throws {
        try await SupabaseManager.ensureAuthenticated()

        struct SkipUpdate: Encodable {
            let skipped: Bool
            let skipped_at: String?
            var expires_at: String?
            var expires_at_ms: Int64?
        }
        var patch = SkipUpdate(
            skipped: skipped,
            skipped_at: skipped ? ISO8601DateFormatter().string(from: Date()) : nil)
        if !skipped, it.status == "pending" {
            let exp = Date().addingTimeInterval(24 * 3600)
            patch.expires_at = ISO8601DateFormatter().string(from: exp)
            patch.expires_at_ms = Int64(exp.timeIntervalSince1970 * 1000)
        }
        try await SupabaseManager.shared
            .from("self_improve_approvals")
            .update(patch)
            .eq("id", value: it.id)
            .execute()
    }

    /// Find (or create) the chat-channel message this card's conversation hangs
    /// off, and return it so the caller can open the reply composer on it.
    ///
    /// "Chat" switches to the chat channel and starts a threaded reply around
    /// the improvement's message, for questions and feedback on it.
    ///
    /// The Improvements channel is a card feed with no input bar, so the
    /// conversation has to happen where conversations happen. An anchor message
    /// gives that thread something real to hang off: `reply_to` needs a message
    /// row, phone-channel quotes the parent into the agent's prompt, and the
    /// thread stays readable in chat history afterwards.
    ///
    /// Find-or-create via `chat_message_id`, so re-opening Chat on the same card
    /// continues one conversation instead of scattering questions across a new
    /// anchor every time. Written as `read: true` and `role: assistant` on
    /// purpose: the user is looking at it right now, so it must not light up the
    /// chat badge, and phone-channel's realtime subscription filters on
    /// `role=eq.user` — an assistant row can't trigger a spurious agent turn.
    static func chatAnchor(for it: Improvement) async throws -> Message {
        try await SupabaseManager.ensureAuthenticated()

        let columns = "id,role,content,read,created_at,reaction,channel,reply_to"

        if let existing = it.chatMessageId {
            let rows: [Message] = try await SupabaseManager.shared
                .from(DBTables.messages)
                .select(columns)
                .eq("id", value: existing)
                .limit(1)
                .execute()
                .value
            // Two ways this can come back unusable, both fall through to minting
            // a fresh anchor rather than dead-ending the action:
            //  - No row: a deleted anchor nulls chat_message_id via ON DELETE SET
            //    NULL, so an empty result means it's gone or mid-flight.
            //  - A row on the WRONG CHANNEL: this column is writable by anything
            //    server-side, and the obvious thing to point it at is the
            //    Improvements-channel notification posted when the card was
            //    filed. Threading a chat reply to that would put the quoted
            //    parent in a channel the chat scroll never shows — the quote
            //    bubble would jump nowhere. The thread has to live in chat.
            if let anchor = rows.first, anchor.channel == ChatChannel.chat.rawValue {
                return anchor
            }
        }

        let inserted: Message = try await SupabaseManager.shared
            .from(DBTables.messages)
            .insert(InsertMessage(
                role: "assistant",
                content: anchorText(for: it),
                read: true,
                channel: ChatChannel.chat.rawValue,
                metadata: ["source": "improvement-card", "improvement_id": it.id]))
            .select(columns)
            .single()
            .execute()
            .value

        try await SupabaseManager.shared
            .from("self_improve_approvals")
            .update(["chat_message_id": inserted.id.uuidString])
            .eq("id", value: it.id)
            .execute()

        return inserted
    }

    /// The anchor's visible text. It carries the improvement id verbatim because
    /// that string is the agent's handle on the thread: phone-channel resolves
    /// the card from `chat_message_id`, but the id in the quoted body is what
    /// survives into the conversation tail on every later turn.
    private static func anchorText(for it: Improvement) -> String {
        let kind = it.itemType == "new-capability" ? "New capability" : "Code fix"
        let state: String
        if it.skipped { state = "skipped" }
        else {
            switch it.phase {
            case .needsApproval: state = "waiting on your approval"
            case .inProgress:    state = "being applied"
            case .done:          state = "applied"
            case .failed:        state = "failed"
            case .skipped:       state = "skipped"
            }
        }
        var lines = ["🔧 **\(kind)** — \(state)", "", it.summary]
        if let rationale = it.rationale, !rationale.isEmpty { lines += ["", rationale] }
        lines += ["", "_Improvement \(it.id) — reply here with questions or feedback._"]
        return lines.joined(separator: "\n")
    }

    /// Decline a pending change — marks it denied so the poller skips it and the
    /// card clears.
    static func deny(_ it: Improvement) async throws {
        try await SupabaseManager.ensureAuthenticated()
        struct DenyUpdate: Encodable {
            let status: String
            let decided_at: String
        }
        try await SupabaseManager.shared
            .from("self_improve_approvals")
            .update(DenyUpdate(
                status: "denied",
                decided_at: ISO8601DateFormatter().string(from: Date())))
            .eq("id", value: it.id)
            .execute()
    }

    // MARK: - Secure Enclave key (same shape as TradeApproval, separate tag)

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

        var genError: Unmanaged<CFError>?
        guard let key = SecKeyCreateRandomKey(attrs as CFDictionary, &genError) else {
            throw error("key generation", genError)
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
            throw NSError(domain: "SelfImproveApproval", code: Int(status),
                          userInfo: [NSLocalizedDescriptionKey: "Keychain load failed (\(status))"])
        }
        return (item as! SecKey)
    }

    private static func rawPublicKeyBase64(_ privateKey: SecKey) throws -> String {
        guard let pub = SecKeyCopyPublicKey(privateKey) else {
            throw NSError(domain: "SelfImproveApproval", code: -1,
                          userInfo: [NSLocalizedDescriptionKey: "No public key"])
        }
        var err: Unmanaged<CFError>?
        guard let data = SecKeyCopyExternalRepresentation(pub, &err) as Data? else {
            throw error("export public key", err)
        }
        return data.base64EncodedString()
    }

    private static func sign(_ data: Data) throws -> Data {
        let key = try ensureKey()
        var err: Unmanaged<CFError>?
        guard let sig = SecKeyCreateSignature(
            key, .ecdsaSignatureMessageX962SHA256, data as CFData, &err
        ) as Data? else {
            throw error("sign", err)
        }
        return sig
    }

    private static func error(_ what: String, _ e: Unmanaged<CFError>?) -> Error {
        let underlying = e?.takeRetainedValue()
        return NSError(domain: "SelfImproveApproval", code: -1, userInfo: [
            NSLocalizedDescriptionKey: "\(what) failed: \(underlying.map(String.init(describing:)) ?? "unknown")"
        ])
    }
}
