import AppIntents

struct SendToJoriIntent: AppIntent {
    static var title: LocalizedStringResource = "Summon Jori"
    static var description = IntentDescription("Ask Jori something by voice — your spoken message is sent into the Jori chat, and the reply comes back as an announced notification.")
    // Run hands-free in the background (driving / AirPods) — never foreground the app.
    static var openAppWhenRun: Bool = false

    // Non-optional String + requestValueDialog: when the trigger phrase doesn't
    // supply the text (App Shortcut phrases can't capture arbitrary dictation in
    // one utterance — Apple prohibits it), Siri SPEAKS this prompt and captures
    // free-form dictation as the value, then runs perform(). This is the
    // documented two-turn hands-free pattern: "Ask Jori" → "What would you
    // like to ask?" → you dictate.
    @Parameter(title: "Message", requestValueDialog: "What would you like to ask Jori?")
    var message: String

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let supabase = SupabaseManager.shared
        try await SupabaseManager.ensureAuthenticated()

        let tz = TimeZone.current
        var metadata: [String: String] = [
            "timezone": tz.identifier,
            "utc_offset": "\(tz.secondsFromGMT() / 3600)",
            "source": "siri"
        ]

        if let location = await LocationManager.shared.lastKnownLocation {
            metadata.merge(location.metadataStrings) { _, new in new }
        }

        let currentUserId = try? await supabase.auth.session.user.id
        // Siri / shortcut entry point — always lands on the chat channel.
        // The system channel is reserved for Jori's own health alerts.
        let insert = InsertMessage(
            role: "user",
            content: message,
            read: false,
            channel: ChatChannel.chat.rawValue,
            metadata: metadata,
            userId: currentUserId
        )

        try await supabase
            .from(DBTables.messages)
            .insert(insert)
            .execute()

        return .result(dialog: "Sent to Jori.")
    }
}

struct JoriShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: SendToJoriIntent(),
            // "Summon" is the primary trigger: distinctive, not a Siri messaging
            // verb, and not a contact-action verb — so it can't be hijacked by a
            // contact named "Jori" or routed to iMessage the way Tell/Message/
            // Send do (observed: "tell Jori" sent an iMessage). "Ask" kept as
            // an alternate.
            phrases: [
                "Summon \(.applicationName)",
                "Ask \(.applicationName)",
                "Ask \(.applicationName) something"
            ],
            shortTitle: "Summon Jori",
            systemImageName: "bubble.left.and.bubble.right"
        )
    }
}
