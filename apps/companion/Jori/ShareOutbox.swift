import Foundation

/// Delivery for things shared INTO Jori from the system share sheet.
///
/// Compiled into both the app and the JoriShare extension. The extension
/// posts `role:user` rows into jori_messages with the access token the app
/// mirrored (SharedSession) — the phone-channel picks them up like any typed
/// message, so sharing needs no backend changes.
///
/// The extension never refreshes the session itself: a refresh in another
/// process rotates the refresh token out from under the app and signs it out.
/// So when the mirrored token is stale (app hasn't run for an hour) or the post
/// fails, the rows are parked in the shared keychain and the app sends them the
/// next time it mirrors a fresh session (launch, foreground, token refresh).
/// Attachments are uploaded before parking — the jori-attachments bucket
/// accepts anon uploads — so a parked row is only text.
enum ShareOutbox {
    /// One jori_messages row minus user_id, which is stamped from whichever
    /// token finally sends it.
    struct Row: Codable {
        let content: String
        let metadata: [String: String]
    }

    /// `failed` = couldn't send AND couldn't park it — the caller must say so
    /// rather than dismiss as if it worked.
    enum Outcome { case sent, queued, failed }

    private static let store = SharedKeychainStorage(service: "ai.\(Install.storagePrefix).share-outbox")
    private static let key = "pending"

    /// Extension side — send now if the mirrored token is usable, else park.
    static func send(_ rows: [Row]) async -> Outcome {
        guard let token = usableAccessToken() else {
            return enqueue(rows) ? .queued : .failed
        }
        let unsent = await post(rows, token: token)
        if unsent.isEmpty { return .sent }
        return enqueue(unsent) ? .queued : .failed
    }

    /// App side — flush anything the extension parked. Called right after the
    /// app mirrors a fresh session, so `accessToken` is valid.
    static func drain(accessToken: String) async {
        let pending = load()
        guard !pending.isEmpty else { return }
        _ = save([])
        let unsent = await post(pending, token: accessToken)
        if !unsent.isEmpty { _ = enqueue(unsent) }
    }

    /// The mirrored access token, if it has at least a minute left. nil when
    /// signed out or stale.
    static func usableAccessToken() -> String? {
        guard let access = SharedSession.tokens()?.access,
              let exp = jwtClaims(access)?["exp"] as? Double,
              exp > Date().timeIntervalSince1970 + 60 else { return nil }
        return access
    }

    /// Auth header for a Storage upload: the user's token when usable, else the
    /// anon key (the bucket's insert policy admits anon).
    static func storageBearer() -> String {
        usableAccessToken() ?? SupabaseConfig.anonKey
    }

    // MARK: - Private

    /// Posts rows in order; returns the ones that didn't land (the first
    /// failure and everything after it, so order is preserved on retry).
    private static func post(_ rows: [Row], token: String) async -> [Row] {
        let userId = jwtClaims(token)?["sub"] as? String
        for (i, row) in rows.enumerated() {
            var body: [String: Any] = [
                "role": "user",
                "content": row.content,
                "read": false,
                "channel": "chat",
                "metadata": row.metadata,
            ]
            // RLS expects user_id = auth.uid(); take it from the JWT subject.
            if let userId { body["user_id"] = userId }

            var req = URLRequest(url: SupabaseConfig.url.appendingPathComponent("rest/v1/\(DBTables.messages)"))
            req.httpMethod = "POST"
            req.setValue(SupabaseConfig.anonKey, forHTTPHeaderField: "apikey")
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.setValue("return=minimal", forHTTPHeaderField: "Prefer")
            req.httpBody = try? JSONSerialization.data(withJSONObject: body)

            do {
                let (data, resp) = try await URLSession.shared.data(for: req)
                let code = (resp as? HTTPURLResponse)?.statusCode ?? -1
                guard (200..<300).contains(code) else {
                    NSLog("[ShareOutbox] insert failed (\(code)): \(String(data: data, encoding: .utf8) ?? "")")
                    return Array(rows[i...])
                }
            } catch {
                NSLog("[ShareOutbox] insert failed: \(error.localizedDescription)")
                return Array(rows[i...])
            }
        }
        return []
    }

    private static func load() -> [Row] {
        guard let data = try? store.retrieve(key: key),
              let rows = try? JSONDecoder().decode([Row].self, from: data) else { return [] }
        return rows
    }

    @discardableResult
    private static func save(_ rows: [Row]) -> Bool {
        do {
            if rows.isEmpty {
                try store.remove(key: key)
            } else {
                try store.store(key: key, value: JSONEncoder().encode(rows))
            }
            return true
        } catch {
            NSLog("[ShareOutbox] keychain write failed: \(error.localizedDescription)")
            return false
        }
    }

    private static func enqueue(_ rows: [Row]) -> Bool {
        save(load() + rows)
    }

    /// Decode a JWT's claims without verifying it — used only for expiry and
    /// user_id; the server still enforces RLS on the token.
    private static func jwtClaims(_ token: String) -> [String: Any]? {
        let parts = token.split(separator: ".")
        guard parts.count >= 2 else { return nil }
        var b64 = String(parts[1])
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        while b64.count % 4 != 0 { b64 += "=" }
        guard let data = Data(base64Encoded: b64) else { return nil }
        return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    }
}
