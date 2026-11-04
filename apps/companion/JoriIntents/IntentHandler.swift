import Intents

#if os(iOS)
import Foundation

// SiriKit messaging-domain handler for Jori.
//
// Two jobs, both landing as a `role:user` row in jori_messages (which the
// phone-channel already picks up, acks, dispatches to the chat-agent, and
// answers via APNs — so this extension needs ZERO backend changes):
//
//   1. Reply to an announced message — AirPods read "Jori says: …", you say
//      "reply, ask if I should take the FDR", Siri routes the reply here.
//   2. One-shot send — "Hey Siri, tell Jori I'm leaving now" / "ask Jori
//      if there are good restaurants nearby". The messaging domain captures the
//      free-form spoken text reliably (more so than an App Intent string param).
//
// The donation in JoriNotificationService sets conversationIdentifier
// "jori-chat" so Siri knows replies belong to this conversation and reaches
// this handler.
class IntentHandler: INExtension, INSendMessageIntentHandling, INSearchForMessagesIntentHandling {

    override func handler(for intent: INIntent) -> Any {
        return self
    }

    // MARK: - INSearchForMessagesIntentHandling
    //
    // Apple requires BOTH INSendMessageIntentHandling and
    // INSearchForMessagesIntentHandling for the AirPods listen-and-reply loop.
    // With only the send handler, Siri announces the message but rejects the
    // spoken reply with "Jori hasn't added support for that with Siri." We
    // don't expose a searchable history to Siri — an empty success satisfies the
    // messaging-provider contract so the reply path binds.
    func handle(
        intent: INSearchForMessagesIntent,
        completion: @escaping (INSearchForMessagesIntentResponse) -> Void
    ) {
        let activity = NSUserActivity(activityType: NSStringFromClass(INSearchForMessagesIntent.self))
        let response = INSearchForMessagesIntentResponse(code: .success, userActivity: activity)
        response.messages = []
        completion(response)
    }

    // MARK: - INSendMessageIntentHandling

    /// Jori is the only recipient — resolve it unconditionally so Siri never
    /// asks "who do you want to message?" while driving.
    func resolveRecipients(
        for intent: INSendMessageIntent,
        with completion: @escaping ([INSendMessageRecipientResolutionResult]) -> Void
    ) {
        completion([.success(with: Self.joriPerson)])
    }

    func resolveContent(
        for intent: INSendMessageIntent,
        with completion: @escaping (INStringResolutionResult) -> Void
    ) {
        if let text = intent.content, !text.isEmpty {
            completion(.success(with: text))
        } else {
            completion(.needsValue())
        }
    }

    func confirm(
        intent: INSendMessageIntent,
        completion: @escaping (INSendMessageIntentResponse) -> Void
    ) {
        let activity = NSUserActivity(activityType: NSStringFromClass(INSendMessageIntent.self))
        completion(INSendMessageIntentResponse(code: .ready, userActivity: activity))
    }

    func handle(
        intent: INSendMessageIntent,
        completion: @escaping (INSendMessageIntentResponse) -> Void
    ) {
        guard let text = intent.content, !text.isEmpty else {
            completion(INSendMessageIntentResponse(code: .failure, userActivity: nil))
            return
        }

        Task {
            do {
                try await Self.insertUserMessage(text)
                completion(INSendMessageIntentResponse(code: .success, userActivity: nil))
            } catch {
                NSLog("[JoriIntents] insert failed: \(error.localizedDescription)")
                completion(INSendMessageIntentResponse(code: .failure, userActivity: nil))
            }
        }
    }

    // MARK: - Supabase

    private static let joriPerson = INPerson(
        personHandle: INPersonHandle(value: "jori@assistant", type: .unknown),
        nameComponents: nil,
        displayName: "Jori",
        image: nil,
        contactIdentifier: nil,
        customIdentifier: "jori-assistant"
    )

    /// Insert as the signed-in user via a direct PostgREST call, authenticated
    /// with the access token the app mirrored into the shared keychain. We
    /// deliberately do NOT run a Supabase auth client here: refreshing in this
    /// separate process would rotate the refresh token out from under the app
    /// and sign the user out. The app keeps the mirror fresh on foreground /
    /// background, so the access token is normally valid when Siri fires.
    private static func insertUserMessage(_ content: String) async throws {
        guard let tokens = SharedSession.tokens() else {
            throw NSError(domain: "JoriIntents", code: 401,
                          userInfo: [NSLocalizedDescriptionKey: "Open Jori and sign in first."])
        }

        let tz = TimeZone.current
        var row: [String: Any] = [
            "role": "user",
            "content": content,
            "read": false,
            "channel": "chat",
            "metadata": [
                "timezone": tz.identifier,
                "utc_offset": "\(tz.secondsFromGMT() / 3600)",
                "source": "siri",
            ],
        ]
        // RLS expects user_id = auth.uid(); take it from the JWT subject.
        if let sub = jwtSubject(tokens.access) { row["user_id"] = sub }

        var req = URLRequest(url: SupabaseConfig.url.appendingPathComponent("rest/v1/\(DBTables.messages)"))
        req.httpMethod = "POST"
        req.setValue(SupabaseConfig.anonKey, forHTTPHeaderField: "apikey")
        req.setValue("Bearer \(tokens.access)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("return=minimal", forHTTPHeaderField: "Prefer")
        req.httpBody = try JSONSerialization.data(withJSONObject: row)

        let (data, resp) = try await URLSession.shared.data(for: req)
        guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            let code = (resp as? HTTPURLResponse)?.statusCode ?? -1
            let body = String(data: data, encoding: .utf8) ?? ""
            throw NSError(domain: "JoriIntents", code: code,
                          userInfo: [NSLocalizedDescriptionKey: "Insert failed (\(code)): \(body)"])
        }
    }

    /// Decode the `sub` (user id) claim from a JWT without verifying it — used
    /// only to populate user_id; the server still enforces RLS on the token.
    private static func jwtSubject(_ token: String) -> String? {
        let parts = token.split(separator: ".")
        guard parts.count >= 2 else { return nil }
        var b64 = String(parts[1])
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        while b64.count % 4 != 0 { b64 += "=" }
        guard let data = Data(base64Encoded: b64),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let sub = obj["sub"] as? String else { return nil }
        return sub
    }
}
#else
// The messaging-via-Siri car/AirPods flow is iOS-only. A stub keeps the
// principal class present so the extension still builds and embeds in the
// macOS app (which never invokes it).
class IntentHandler: INExtension {}
#endif
