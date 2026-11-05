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
class IntentHandler: INExtension, INSendMessageIntentHandling, INSearchForMessagesIntentHandling, INSetMessageAttributeIntentHandling {

    override func handler(for intent: INIntent) -> Any {
        AnnounceCache.trace("intents handler for \(type(of: intent))")
        return self
    }

    // MARK: - INSearchForMessagesIntentHandling
    //
    // THIS IS WHAT SIRI READS ALOUD. For a messaging app Siri does not speak an
    // announced notification's text itself: it sends this intent with the
    // notification's request identifier in `notificationIdentifiers` and speaks
    // the INMessages returned. An empty answer, or no handler, is silence —
    // and for a messaging app that silences plain pushes too. Answered from
    // AnnounceCache (written by the
    // NotificationService extension), offline, so a locked phone or an expired
    // session token cannot silence it. Pattern: Telegram-iOS
    // Telegram/SiriIntents/MessageSearchScope.swift.
    func handle(
        intent: INSearchForMessagesIntent,
        completion: @escaping (INSearchForMessagesIntentResponse) -> Void
    ) {
        let cached = AnnounceCache.all()
        let picked = Self.messagesToRead(for: intent, from: cached)
        AnnounceCache.trace("intents search notif=\(intent.notificationIdentifiers ?? []) op=\(intent.notificationIdentifiersOperator.rawValue) ids=\(intent.identifiers ?? []) attrs=\(intent.attributes.rawValue) cached=\(cached.count) answer=\(picked.map { $0.body.prefix(30) })")
        NSLog("[JoriIntents] search: notificationIds=\(intent.notificationIdentifiers ?? []) op=\(intent.notificationIdentifiersOperator.rawValue) ids=\(intent.identifiers ?? []) cached=\(cached.count) → \(picked.count)")
        let response = INSearchForMessagesIntentResponse(code: .success, userActivity: nil)
        response.messages = picked.map { m in
            INMessage(
                identifier: m.messageId ?? m.requestId,
                conversationIdentifier: Self.conversationId,
                content: m.body,
                dateSent: m.date,
                sender: Self.joriPerson,
                recipients: nil,
                groupName: nil,
                messageType: .text)
        }
        completion(response)
    }

    /// Which cached messages answer this search. Announce asks for exactly the
    /// notifications named (operator .all/.any; .none means "everything but
    /// these", which for an announce is nothing new). A plain "read my
    /// messages" names none: read the newest few. Never the whole backlog for an
    /// announce: answering with the backlog makes Siri re-read every earlier
    /// message on each new one (Telegram-iOS hit this).
    static func messagesToRead(for intent: INSearchForMessagesIntent,
                               from cached: [AnnouncedMessage]) -> [AnnouncedMessage] {
        let notificationIds = intent.notificationIdentifiers ?? []
        if !notificationIds.isEmpty {
            if intent.notificationIdentifiersOperator == .none { return [] }
            let hit = notificationIds.compactMap { id in cached.last { $0.requestId == id } }
            if !hit.isEmpty { return hit }
            // The notification arrived but the extension's record is missing
            // (NSE timed out): the newest message from the last few minutes is
            // almost certainly it. Better read than silent.
            if let newest = cached.last, Date().timeIntervalSince(newest.date) < 300 { return [newest] }
            return []
        }
        let ids = intent.identifiers ?? []
        if !ids.isEmpty {
            return cached.filter { m in ids.contains(m.messageId ?? "") || ids.contains(m.requestId) }
        }
        return Array(cached.suffix(3))
    }

    // MARK: - INSetMessageAttributeIntentHandling
    //
    // Siri marks an announced message read (Apple's SiriKit Messaging page:
    // INSearchForMessagesIntent + INSetMessageAttributeIntent "allow Siri to
    // announce incoming messages on AirPods"). Mark the row read best-effort;
    // the answer is success either way, since a stale token must not make Siri
    // report a failure about a message it just read.
    func resolveAttribute(
        for intent: INSetMessageAttributeIntent,
        with completion: @escaping (INMessageAttributeResolutionResult) -> Void
    ) {
        switch intent.attribute {
        case .read, .unread, .played: completion(.success(with: intent.attribute))
        case .flagged, .unflagged: completion(.success(with: .unread))
        default: completion(.needsValue())
        }
    }

    func handle(
        intent: INSetMessageAttributeIntent,
        completion: @escaping (INSetMessageAttributeIntentResponse) -> Void
    ) {
        AnnounceCache.trace("intents setAttribute \(intent.attribute.rawValue) ids=\(intent.identifiers ?? [])")
        let ids = (intent.identifiers ?? []).filter { UUID(uuidString: $0) != nil }
        let read = intent.attribute == .read || intent.attribute == .played
        guard !ids.isEmpty, read || intent.attribute == .unread else {
            completion(INSetMessageAttributeIntentResponse(code: .success, userActivity: nil))
            return
        }
        Task {
            do { try await Self.setRead(read, ids: ids) }
            catch { NSLog("[JoriIntents] mark read failed: \(error.localizedDescription)") }
            completion(INSetMessageAttributeIntentResponse(code: .success, userActivity: nil))
        }
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
        AnnounceCache.trace("intents send handle len=\(intent.content?.count ?? 0) conv=\(intent.conversationIdentifier ?? "-")")
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

    /// The conversation the NotificationService extension donates into.
    static let conversationId = "jori-chat"

    /// The same person the NotificationService extension uses as the sender.
    private static let joriPerson = INPerson(
        personHandle: INPersonHandle(value: "jori-assistant", type: .unknown),
        nameComponents: nil,
        displayName: Install.displayName,
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
                          userInfo: [NSLocalizedDescriptionKey: "Open \(Install.displayName) and sign in first."])
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

    /// PATCH jori_messages.read for the given ids, as the signed-in user.
    private static func setRead(_ read: Bool, ids: [String]) async throws {
        guard let tokens = SharedSession.tokens() else { return }
        var comps = URLComponents(url: SupabaseConfig.url.appendingPathComponent("rest/v1/\(DBTables.messages)"),
                                  resolvingAgainstBaseURL: false)!
        comps.queryItems = [URLQueryItem(name: "id", value: "in.(\(ids.joined(separator: ",")))")]
        var req = URLRequest(url: comps.url!)
        req.httpMethod = "PATCH"
        req.setValue(SupabaseConfig.anonKey, forHTTPHeaderField: "apikey")
        req.setValue("Bearer \(tokens.access)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("return=minimal", forHTTPHeaderField: "Prefer")
        req.httpBody = try JSONSerialization.data(withJSONObject: ["read": read])
        let (_, resp) = try await URLSession.shared.data(for: req)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? -1
        if !(200..<300).contains(code) {
            throw NSError(domain: "JoriIntents", code: code,
                          userInfo: [NSLocalizedDescriptionKey: "mark read failed (\(code))"])
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
