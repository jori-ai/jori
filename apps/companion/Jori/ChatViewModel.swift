import Foundation
#if os(macOS)
import AppKit
#else
import UIKit
#endif
import AVFoundation
import Supabase
import Realtime

@MainActor
private var isAppActive: Bool {
    #if os(macOS)
    return NSApplication.shared.isActive
    #else
    return UIApplication.shared.applicationState == .active
    #endif
}

@MainActor
final class ChatViewModel: ObservableObject {
    @Published var messages: [Message] = [] {
        didSet { _threadIndex = nil }
    }
    @Published var currentChannel: ChatChannel

    /// Replies, ids and question re-asks, indexed once per change to
    /// `messages`. Every bubble asks "who answered me?" on each redraw; a scan
    /// of the whole list per question made a redraw cost messages × messages.
    private var _threadIndex: ThreadIndex?
    private var threadIndex: ThreadIndex {
        if let index = _threadIndex { return index }
        let index = ThreadIndex(messages)
        _threadIndex = index
        return index
    }

    private struct ThreadIndex {
        var byId: [UUID: Message] = [:]
        /// Replies to each message, in list order.
        var replies: [UUID: [Message]] = [:]
        /// The newest `createdAt` carrying each hum `question_id`.
        var latestAsk: [String: Date] = [:]

        init(_ messages: [Message]) {
            byId.reserveCapacity(messages.count)
            for m in messages {
                byId[m.id] = m
                if let parent = m.replyTo { replies[parent, default: []].append(m) }
                if let qid = m.metadata?["question_id"] {
                    if let seen = latestAsk[qid], seen >= m.createdAt { continue }
                    latestAsk[qid] = m.createdAt
                }
            }
        }
    }

    /// Draft persistence — called from the view's @State inputText onChange.
    /// NOT @Published: typing should not trigger ViewModel re-renders of the
    /// entire message list (expensive with hundreds of messages + reaction UI).
    static func loadDraft() -> String {
        UserDefaults.standard.string(forKey: draftKey) ?? ""
    }
    static func saveDraft(_ text: String) {
        if text.isEmpty {
            UserDefaults.standard.removeObject(forKey: draftKey)
        } else {
            UserDefaults.standard.set(text, forKey: draftKey)
        }
    }
    @Published var isWaitingForResponse: Bool = false
    @Published var error: String?
    @Published var isOffline: Bool = false
    @Published var isLoadingOlder: Bool = false
    @Published var hasOlderMessages: Bool = true
    /// Set by the Improvements card menu's "Chat" action right after
    /// `switchChannel(to: .chat)`: the message the reply composer should open on.
    /// ContentView observes it at the TOP level rather than inside the
    /// channel-conditional chat subview, so the request survives the channel
    /// switch — opening the composer synchronously would race the chat view's
    /// own mount, and the focus request would land on an input bar that doesn't
    /// exist yet. Cleared once consumed.
    @Published var pendingReplyMessage: Message?

    private static let draftKey = Install.key("messageDraft")
    private static let channelKey = Install.key("currentChannel")

    private let supabase: SupabaseClient
    private let cloudBackup = CloudBackup.shared
    private let store = MessageStore.shared
    private var realtimeChannel: RealtimeChannelV2?
    private var commandsChannel: RealtimeChannelV2?
    private var reconnectTask: Task<Void, Never>?
    private var catchUpTimer: Task<Void, Never>?
    private var staleRetryTask: Task<Void, Never>?
    private var isLoadingMessages = false
    private let locationManager = LocationManager.shared

    init() {
        self.supabase = SupabaseManager.shared
        let savedChannel = UserDefaults.standard.string(forKey: Self.channelKey)
            .flatMap(ChatChannel.init(rawValue:)) ?? .chat
        self.currentChannel = savedChannel
        self.messages = store.loadAll(channel: savedChannel.rawValue)
    }

    /// Switch the active channel — persists the selection, swaps the visible
    /// message list from cache, then re-subscribes realtime + re-fetches.
    func switchChannel(to channel: ChatChannel) {
        guard channel != currentChannel else { return }
        currentChannel = channel
        UserDefaults.standard.set(channel.rawValue, forKey: Self.channelKey)
        messages = store.loadAll(channel: channel.rawValue)
        hasOlderMessages = true
        isWaitingForResponse = false
        reconnectIfNeeded()
        Task { await loadMessages() }
    }

    func loadMessages() async {
        // Guard: deduplicate concurrent calls. @MainActor ensures the check+set is
        // atomic before the first suspension, so only one fetch runs at a time.
        guard !isLoadingMessages else { return }
        isLoadingMessages = true
        defer { isLoadingMessages = false }

        // Ensure authenticated before any Supabase operations — bail if auth fails
        do {
            try await SupabaseManager.ensureAuthenticated()
        } catch {
            print("[Auth] Failed to authenticate: \(error) — skipping server load, using cache")
            return
        }

        let channel = currentChannel.rawValue
        do {
            // On fresh install (empty cache), load last 3 days.
            // With cache, load all (incremental sync via realtime handles new messages).
            let query = supabase
                .from(DBTables.messages)
                .select("id,role,content,read,created_at,reaction,channel,reply_to,metadata")
                .eq("channel", value: channel)

            // Always cap the initial fetch — a multi-thousand message array
                                                                                                             // in a LazyVStack blows up scroll performance (each bubble runs
                                                                                                             // MarkdownUI), and cache eviction already bounds persistent storage.
                                                                                                             // Older history still reachable via the "Load older" button.
            let hasCache = !store.loadAll(channel: channel).isEmpty
            let response: [Message]
            if hasCache {
                let newestFirst: [Message] = try await query
                    .order("created_at", ascending: false)
                    .limit(500)
                    .execute()
                    .value
                response = Array(newestFirst.reversed())
            } else {
                let threeDaysAgo = Calendar.current.date(byAdding: .day, value: -3, to: Date())!
                let cutoff = ISO8601DateFormatter().string(from: threeDaysAgo)
                response = try await query
                    .gte("created_at", value: cutoff)
                    .order("created_at", ascending: true)
                    .execute()
                    .value
            }

            // The channel can change while this fetch is in flight: open the
            // app on System, tap back to Chat before System's rows arrive. On
            // 2026-10-06 that landed System rows (Jev disagreement notes) in
            // the Chat thread, where the user could swipe-reply to them, and the
            // merge below then kept them there, since it preserves every
            // in-memory row the next Chat response doesn't contain. So cache
            // them under their own channel and stop. The switch's own load was
            // swallowed by the in-flight guard above, so run it now; the Task
            // starts after this return has cleared `isLoadingMessages`.
            guard channel == currentChannel.rawValue else {
                if !response.isEmpty {
                    store.sync(with: response, channel: channel)
                }
                Task { [weak self] in await self?.loadMessages() }
                return
            }

            // An empty response must not wipe the cache-hydrated state: a
            // stale read or transient server wobble would silently erase the
            // conversation from the screen. Server-side deletions come in
            // through the realtime delete channel.
            if !response.isEmpty {
                // Merge by ID rather than wholesale-replace. A concurrent
                // sendMessage() may have appended a just-inserted user
                // message AFTER this fetch was issued but BEFORE the
                // response arrived — wholesale-replacing would erase it
                // from the UI even though the server has it. Same risk for
                // any realtime-arrived message that landed mid-fetch.
                // Also defends bug #1: when loadMessages fires on
                // scenePhase=.active and the response equals the existing
                // array by content, the assignment still forces the
                // LazyVStack to re-realize all cells, briefly blanking the
                // viewport. Merging preserves array identity when content
                // didn't actually change.
                // Only rows of THIS channel survive the merge, so a row from
                // another channel can never be carried forward fetch after fetch.
                let responseIds = Set(response.map(\.id))
                let inMemoryNewer = self.messages.filter {
                    !responseIds.contains($0.id) && $0.channel == channel
                }
                if inMemoryNewer.isEmpty {
                    // Only reassign if content actually differs — avoids
                    // forcing a LazyVStack rebuild on a no-op refresh.
                    if self.messages != response {
                        self.messages = response
                    }
                } else {
                    // Preserve in-memory-only messages (just-sent, just-
                    // received-via-realtime). Re-sort to keep created_at
                    // ordering correct across the merge.
                    let merged = (response + inMemoryNewer)
                        .sorted { $0.createdAt < $1.createdAt }
                    self.messages = merged
                }
            } else if self.messages.isEmpty, channel == ChatChannel.chat.rawValue,
                      let restored = cloudBackup.restore(), !restored.isEmpty {
                // CloudBackup only ever held chat-channel messages, so only
                // restore it when we're viewing chat.
                self.messages = restored
                store.sync(with: restored, channel: channel)
            }

            self.isWaitingForResponse = (messages.last?.isUser == true)

            // Fresh install (no cache): the 3-day backfill is historical —
            // mark ALL as read immediately so they don't trigger push
            // notifications. Existing install: only mark read when app is active.
            let shouldMarkRead = !hasCache || isAppActive
            if shouldMarkRead {
                for msg in response where msg.isAssistant && !msg.read {
                    await markAsRead(messageId: msg.id)
                }
            }

            // Always reconcile the cache with a successful server response,
            // even if the in-memory array hasn't visibly changed — guarantees
            // the persistent store can never silently drift out of sync.
            if !response.isEmpty {
                store.sync(with: response, channel: channel)
                backupToCloud()
            }

            // Refresh succeeded — clear any stale-state error, drop offline
            // indicator, and stop the self-healing retry loop if running.
            self.error = nil
            self.isOffline = false
            staleRetryTask?.cancel()
            staleRetryTask = nil

            // A switch during the markAsRead awaits above also had its load
            // swallowed; the rows shown are already right, so just fetch.
            if channel != currentChannel.rawValue {
                Task { [weak self] in await self?.loadMessages() }
            }
        } catch {
            // Log the full error type, not just the localized description,
            // so we can actually diagnose what's failing if it recurs.
            print("[loadMessages] error: \(String(describing: error))")
            // Same mid-flight switch as the success path: the error belongs to
            // the channel the user left, so retry for the one on screen instead.
            guard channel == currentChannel.rawValue else {
                Task { [weak self] in await self?.loadMessages() }
                return
            }
            // Do NOT surface a modal alert here: the cache-hydrated UI is
            // still usable, the retry loop will recover silently, and the
            // offline banner gives the user a non-intrusive hint.
            self.isOffline = true
            if self.messages.isEmpty, channel == ChatChannel.chat.rawValue,
               let restored = cloudBackup.restore(), !restored.isEmpty {
                self.messages = restored
            }
            // The on-screen state may be stale (cache-hydrated) and the user
            // can't tell. Kick off a fast retry loop instead of waiting for
            // the 30s catchUpTimer to come around again.
            startStaleRetryLoop()
        }
    }

    /// Load messages older than the earliest currently displayed message.
    /// Called when the user scrolls to the top of the conversation.
    func loadOlderMessages() async {
        guard !isLoadingOlder, hasOlderMessages else { return }
        guard let earliest = messages.first?.createdAt else { return }

        isLoadingOlder = true
        defer { isLoadingOlder = false }

        let channel = currentChannel.rawValue
        do {
            try await SupabaseManager.ensureAuthenticated()
            let cutoff = ISO8601DateFormatter().string(from: earliest)
            let older: [Message] = try await supabase
                .from(DBTables.messages)
                .select("id,role,content,read,created_at,reaction,channel,reply_to,metadata")
                .eq("channel", value: channel)
                .lt("created_at", value: cutoff)
                .order("created_at", ascending: false)
                .limit(50)
                .execute()
                .value

            // The user switched channels while this page loaded: it belongs to the
            // channel the user left, so it must not be prepended to this one.
            guard channel == currentChannel.rawValue else { return }

            if older.isEmpty {
                hasOlderMessages = false
                return
            }

            let reversed = older.reversed()
            messages.insert(contentsOf: reversed, at: 0)
            store.sync(with: messages, channel: channel)
        } catch {
            print("[loadOlderMessages] error: \(error)")
        }
    }

    /// Fast self-healing retry after a failed loadMessages: 12 attempts at
    /// 5s intervals (~1 minute total), then we fall back to the existing
    /// catchUpTimer cadence. Succeeding cancels the loop from inside
    /// loadMessages.
    private func startStaleRetryLoop() {
        staleRetryTask?.cancel()
        staleRetryTask = Task { [weak self] in
            for _ in 0..<12 {
                try? await Task.sleep(for: .seconds(5))
                if Task.isCancelled { return }
                await self?.loadMessages()
                if Task.isCancelled { return }
            }
        }
    }

    func subscribeToNewMessages() async {
        await DBTables.resolve()
        // Auth must be established before subscribing — realtime uses the auth token for RLS
        do {
            try await SupabaseManager.ensureAuthenticated()
        } catch {
            print("[Auth] Failed to authenticate for realtime — subscription may not receive updates")
        }

        // Per-channel realtime topic — switching channels tears this down
        // and re-subscribes via `reconnectIfNeeded()`.
        let activeChannel = currentChannel.rawValue
        let filter = "channel=eq.\(activeChannel)"
        let channel = supabase.realtimeV2.channel("\(DBTables.messages)_changes_\(activeChannel)")

        let insertions = channel.postgresChange(
            InsertAction.self,
            schema: "public",
            table: DBTables.messages,
            filter: filter
        )

        let deletions = channel.postgresChange(
            DeleteAction.self,
            schema: "public",
            table: DBTables.messages
        )

        let updates = channel.postgresChange(
            UpdateAction.self,
            schema: "public",
            table: DBTables.messages,
            filter: filter
        )

        await channel.subscribe()
        self.realtimeChannel = channel

        // Listen for inserts, deletes, and updates concurrently
        await withTaskGroup(of: Void.self) { group in
            group.addTask { @MainActor in
                for await insertion in insertions {
                    do {
                        let message = try insertion.decodeRecord(as: Message.self, decoder: JSONDecoder.supabaseDecoder)
                        // Guard: if the user switched channels mid-subscribe,
                        // drop messages that don't belong to the new view.
                        guard message.channel == self.currentChannel.rawValue else { continue }
                        if !self.messages.contains(where: { $0.id == message.id }) {
                            self.messages.append(message)
                            if message.isAssistant {
                                self.isWaitingForResponse = false
                            }
                            self.store.upsert(message)
                            self.backupToCloud()
                            if isAppActive {
                                await self.markAsRead(messageId: message.id)
                            }
                        }
                    } catch {
                        print("Decode error: \(error)")
                    }
                }
            }
            group.addTask { @MainActor in
                for await deletion in deletions {
                    if let idString = deletion.oldRecord["id"]?.stringValue,
                       let id = UUID(uuidString: idString) {
                        self.messages.removeAll { $0.id == id }
                        self.store.delete(id: id)
                    }
                }
            }
            group.addTask { @MainActor in
                for await update in updates {
                    do {
                        let message = try update.decodeRecord(as: Message.self, decoder: JSONDecoder.supabaseDecoder)
                        guard message.channel == self.currentChannel.rawValue else { continue }
                        if let idx = self.messages.firstIndex(where: { $0.id == message.id }) {
                            self.messages[idx] = message
                            self.backupToCloud()
                        }
                    } catch {
                        print("Update decode error: \(error)")
                    }
                }
            }
        }
    }

    /// - Parameter replyTo: when non-nil, threads this message to a specific
    ///   earlier bubble (iMessage-style). The agent side quotes that parent
    ///   into the prompt, so an out-of-order reply is read against the message
    ///   the user actually meant.
    // MARK: - Choice prompts

    /// The label the user tapped for a choice prompt, if any.
    ///
    /// Derived from the reply rather than stored: a user message whose
    /// `reply_to` is the question IS the answer, which is exactly what the tap
    /// inserts. Nothing to migrate, nothing to keep in sync, and two devices
    /// cannot disagree.
    func tappedAnswer(for messageID: UUID) -> String? {
        threadIndex.replies[messageID]?.last { $0.role == "user" && !Self.isDismissal($0) }?.content
    }

    // MARK: - Dismissing a question

    /// Metadata key on the silent reply that dismisses a question. The server
    /// (lib/question-dismiss.mjs via lib/choice-reply.mjs) closes the question
    /// in code — no agent turn, no reply — and stamps question_state on every
    /// copy; the reply itself closes it here at once, on every device.
    static let dismissKey = "question_dismiss"

    static func isDismissal(_ m: Message) -> Bool {
        m.role == "user" && m.metadata?[dismissKey] != nil
    }

    /// A dismissal reply, which the thread hides (the question just stops being open).
    func isQuestionDismissal(_ message: Message) -> Bool { Self.isDismissal(message) }

    func wasDismissed(_ messageID: UUID) -> Bool {
        threadIndex.replies[messageID]?.contains(where: Self.isDismissal) ?? false
    }

    func dismissQuestion(_ message: Message) {
        Task { await sendMessage("Dismissed", replyTo: message.id, quiet: true, extraMetadata: [Self.dismissKey: "1"]) }
    }

    /// The open questions in the current channel, oldest first, one per
    /// question (a re-ask replaces the earlier copy). Drawn in a tray at the
    /// bottom of the stream so what is still open is always in view.
    var openQuestions: [Message] {
        messages.filter { isOpenQuestion($0) }
    }

    /// A default the server applied because the user never answered.
    ///
    /// Kept separate from `tappedAnswer` on purpose. A default is provisional —
    /// the user can come back to a missed question later and tap a different option,
    /// and that tap wins. So this only ever draws a lighter, still-overridable
    /// mark; it never closes the question.
    func defaultApplied(for messageID: UUID) -> String? {
        guard tappedAnswer(for: messageID) == nil else { return nil }
        return threadIndex.replies[messageID]?.last {
            $0.metadata?["choice_default"] != nil
        }?.metadata?["choice_default"]
    }

    // MARK: - Checklists

    /// The items ticked on a checklist message: the latest ✓/↩ reply per label wins.
    /// Derived from replies, like `tappedAnswer`, so devices cannot disagree.
    func checkedLabels(for messageID: UUID) -> Set<String> {
        var on = Set<String>()
        for m in threadIndex.replies[messageID] ?? [] where m.role == "user" {
            guard let t = Checklist.toggle(in: m.content) else { continue }
            if t.checked { on.insert(t.label) } else { on.remove(t.label) }
        }
        return on
    }

    func toggleChecklistItem(_ label: String, checked: Bool, on messageID: UUID) {
        Task { await sendMessage((checked ? Checklist.check : Checklist.uncheck) + label, replyTo: messageID, quiet: true) }
    }

    /// A tick reply, which the thread hides (the box shows it).
    func isChecklistTick(_ message: Message) -> Bool {
        guard message.role == "user", let parentID = message.replyTo,
              Checklist.toggle(in: message.content) != nil,
              let parent = threadIndex.byId[parentID] else { return false }
        return Checklist.from(metadata: parent.metadata) != nil
    }

    // MARK: - Open questions

    /// Whether this message is a Jori question still waiting for their answer,
    /// which the bubble draws in the question colour, so questions are hard
    /// to miss. A hum question carries `question_id` in its metadata; the server
    /// stamps `question_state` once it is answered or retired, and a time-bound
    /// one carries `question_until`. A choice card counts until tapped,
    /// defaulted or expired. A threaded reply to it closes it at once, and a
    /// later re-ask of the same question takes over the colour.
    func isOpenQuestion(_ message: Message) -> Bool {
        let qid = message.metadata?["question_id"]
        return Self.isOpenQuestion(message,
                                   replies: threadIndex.replies[message.id] ?? [],
                                   latestAsk: qid.flatMap { threadIndex.latestAsk[$0] })
    }

    /// The one rule for "still open", shared by the bubble colour, the tray and
    /// the Questions badge (ChannelBadges), so they can never disagree.
    /// - Parameters:
    ///   - replies: the replies to `message`, in list order.
    ///   - latestAsk: the newest createdAt carrying the same question_id.
    nonisolated static func isOpenQuestion(_ message: Message, replies: [Message], latestAsk: Date?) -> Bool {
        guard message.isAssistant, let meta = message.metadata else { return false }
        if replies.contains(where: { $0.role == "user" }) { return false }   // answered or dismissed
        if let state = meta["question_state"], !state.isEmpty { return false }
        if let qid = meta["question_id"], !qid.isEmpty {
            if let until = meta["question_until"].flatMap(parseISO), until < Date() { return false }
            return (latestAsk ?? .distantPast) <= message.createdAt
        }
        if let prompt = ChoicePrompt.from(metadata: meta) {
            if replies.contains(where: { $0.metadata?["choice_default"] != nil }) { return false }
            if let exp = prompt.expiresAt.flatMap(parseISO), exp < Date() { return false }
            return true
        }
        return false
    }

    /// Open questions among a channel's messages, oldest first.
    nonisolated static func openQuestions(in messages: [Message]) -> [Message] {
        var replies: [UUID: [Message]] = [:]
        var latestAsk: [String: Date] = [:]
        for m in messages {
            if let parent = m.replyTo { replies[parent, default: []].append(m) }
            if let qid = m.metadata?["question_id"], (latestAsk[qid] ?? .distantPast) < m.createdAt { latestAsk[qid] = m.createdAt }
        }
        return messages.filter { m in
            isOpenQuestion(m, replies: replies[m.id] ?? [], latestAsk: m.metadata?["question_id"].flatMap { latestAsk[$0] })
        }
    }

    nonisolated(unsafe) private static let isoFractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    nonisolated(unsafe) private static let isoPlain: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    /// Shared formatters: building one per call (per bubble, per redraw) was
    /// a measurable share of a redraw.
    nonisolated private static func parseISO(_ s: String) -> Date? {
        isoFractional.date(from: s) ?? isoPlain.date(from: s)
    }

    /// - Parameter quiet: a checklist tick — no reply is coming, so no "working"
    ///   indicator, and the typed draft is left alone.
    func sendMessage(_ rawText: String, replyTo: UUID? = nil, quiet: Bool = false, extraMetadata: [String: String] = [:]) async {
        let text = rawText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }

        if !quiet {
            Self.saveDraft("") // clear persisted draft
            isWaitingForResponse = true
        }

        let tz = TimeZone.current
        var metadata: [String: String] = [
            "timezone": tz.identifier,
            "utc_offset": "\(tz.secondsFromGMT() / 3600)"
        ]

        metadata.merge(extraMetadata) { _, new in new }

        if let location = locationManager.lastKnownLocation {
            metadata.merge(location.metadataStrings) { _, new in new }
        }

        // Add current place/activity context from LocationTracker
        if let ctx = LocationTracker.shared.currentContext {
            if let place = ctx.placeName {
                metadata["current_place"] = place
            }
            if let activity = ctx.activity {
                metadata["current_activity"] = activity
            }
            metadata["at_place_since"] = ctx.arrivedAt.ISO8601Format()
        }

        // Ensure auth before sending. If this fails, the SDK would silently fall
        // back to the anon key and the insert would hit the RLS guard — surface
        // the auth error directly instead.
        let currentUserId: UUID
        do {
            try await SupabaseManager.ensureAuthenticated()
            currentUserId = try await supabase.auth.session.user.id
        } catch {
            self.error = "Sign-in expired. Please sign in again."
            self.isWaitingForResponse = false
            print("Send auth error: \(error)")
            return
        }
        let newMessage = InsertMessage(
            role: "user",
            content: text,
            read: false,
            channel: currentChannel.rawValue,
            metadata: metadata,
            userId: currentUserId,
            replyTo: replyTo
        )

        do {
            let inserted: Message = try await supabase
                .from(DBTables.messages)
                .insert(newMessage)
                .select("id,role,content,read,created_at,reaction,channel,reply_to,metadata")
                .single()
                .execute()
                .value
            if inserted.channel == currentChannel.rawValue,
               !self.messages.contains(where: { $0.id == inserted.id }) {
                self.messages.append(inserted)
            }
            store.upsert(inserted)
            backupToCloud()
        } catch {
            self.error = "Failed to send message: \(error.localizedDescription)"
            self.isWaitingForResponse = false
            print("Send error: \(error)")
        }
    }

    func setReaction(for message: Message, to newValue: Reaction?) async {
        guard message.isAssistant else { return }

        let resolved: Reaction? = (message.reaction == newValue) ? nil : newValue

        if let idx = messages.firstIndex(where: { $0.id == message.id }) {
            messages[idx] = messages[idx].with(reaction: resolved)
            backupToCloud()
        }

        struct ReactionUpdate: Encodable {
            let reaction: String?
        }

        do {
            try await supabase
                .from(DBTables.messages)
                .update(ReactionUpdate(reaction: resolved?.rawValue))
                .eq("id", value: message.id.uuidString)
                .execute()
        } catch {
            print("Reaction update error: \(error)")
            if let idx = messages.firstIndex(where: { $0.id == message.id }) {
                messages[idx] = messages[idx].with(reaction: message.reaction)
            }
            self.error = "Failed to save reaction: \(error.localizedDescription)"
        }
    }

    // MARK: - Threaded replies

    /// Parents of threaded replies that are no longer in the loaded window,
    /// resolved on demand so their quote bubble can still render text. The
    /// loaded window is checked first; this only holds the overflow.
    @Published private(set) var quotedParents: [UUID: Message] = [:]
    private var quoteFetchesInFlight: Set<UUID> = []

    func quotedParent(_ id: UUID) -> Message? {
        threadIndex.byId[id] ?? quotedParents[id]
    }

    /// Fire-and-forget resolve: loaded window → local SwiftData cache → server.
    /// Safe to call repeatedly from a view's `.task` — it no-ops once resolved
    /// and dedupes concurrent fetches for the same id.
    func resolveQuotedParent(_ id: UUID) {
        guard quotedParent(id) == nil, !quoteFetchesInFlight.contains(id) else { return }
        if let cached = store.message(id: id) {
            quotedParents[id] = cached
            return
        }
        quoteFetchesInFlight.insert(id)
        Task { [weak self] in
            guard let self else { return }
            defer { self.quoteFetchesInFlight.remove(id) }
            do {
                let parent: Message = try await supabase
                    .from(DBTables.messages)
                    .select("id,role,content,read,created_at,reaction,channel,reply_to,metadata")
                    .eq("id", value: id.uuidString)
                    .single()
                    .execute()
                    .value
                self.quotedParents[id] = parent
            } catch {
                // Parent deleted or unreachable — the quote falls back to a
                // neutral placeholder rather than blocking the reply.
                print("Quoted parent fetch error: \(error)")
            }
        }
    }

    private func markAsRead(messageId: UUID) async {
        try? await supabase
            .from(DBTables.messages)
            .update(["read": true])
            .eq("id", value: messageId.uuidString)
            .execute()
    }

    /// CloudBackup is the Chat thread's fallback copy (both restore paths put
    /// it straight into the Chat view), so only chat rows may go into it. It
    /// used to snapshot whatever channel was on screen, so a System session
    /// overwrote it with System rows.
    private func backupToCloud() {
        guard currentChannel == .chat else { return }
        let snapshot = self.messages.filter { $0.channel == ChatChannel.chat.rawValue }
        Task.detached(priority: .utility) {
            CloudBackup.shared.backup(messages: snapshot)
        }
    }

    func subscribeToCommands() async {
        await DBTables.resolve()
        let channel = supabase.realtimeV2.channel("\(DBTables.commands)_changes")

        let insertions = channel.postgresChange(
            InsertAction.self,
            schema: "public",
            table: DBTables.commands,
            filter: "status=eq.pending"
        )

        await channel.subscribe()
        self.commandsChannel = channel

        for await insertion in insertions {
            do {
                let record = try insertion.decodeRecord(as: CommandRow.self, decoder: JSONDecoder.supabaseDecoder)
                switch record.command {
                case "get_location":
                    await handleLocationCommand(id: record.id)
                case "flush_location":
                    await handleFlushLocationCommand(id: record.id)
                case "reset_health_anchors":
                    await handleResetHealthAnchors(id: record.id, payload: record.payload)
                case "refresh_health_sync":
                    await handleRefreshHealthSync(id: record.id)
                case "health_diagnose":
                    await handleHealthDiagnose(id: record.id)
                case "speak":
                    if self.commandTargetsThisDevice(record.payload) { await handleSpeak(id: record.id, payload: record.payload) }
                    // else: targeted at another device — leave pending for it.
                case "haptic":
                    if self.commandTargetsThisDevice(record.payload) { await handleHaptic(id: record.id, payload: record.payload) }
                    // else: targeted at another device — leave pending for it.
                default:
                    // Unknown command — LEAVE IT PENDING (do NOT mark failed). A
                    // client on an OLDER build must never consume + kill a command
                    // it doesn't understand, or it starves a newer/capable client
                    // on the shared `jori_commands` queue. That was the
                    // Mac-app-v52 bug (2026-07-18): v52 lacked speak/haptic, grabbed
                    // the rows first, and answered "unknown command". A capable
                    // client will handle it; if none is running, the sender times
                    // out on its own — no harm, and the row can still be handled
                    // when the right client next sees this insert.
                    continue
                }
            } catch {
                print("Command decode error: \(error)")
            }
        }
    }

    // MARK: - WP13 live-telemetry client tools (speak / haptic)
    // Conway's notify/speak/haptic primitives, driven from the server via a
    // jori_commands row (same mechanism as get_location etc.). speak uses the
    // cross-platform AVSpeechSynthesizer; haptic is iOS-only (no-op on macOS).
    private let speechSynth = AVSpeechSynthesizer()

    // A device-specific command (speak/haptic) may carry payload.target ("ios"|
    // "macos"). Only the matching device acts; a non-target client leaves it
    // pending so the intended device handles it — prevents e.g. the Mac speaking
    // a message meant for the phone.
    private func commandTargetsThisDevice(_ payload: [String: String]?) -> Bool {
        guard let target = payload?["target"], !target.isEmpty else { return true }
        #if os(iOS)
        return target == "ios"
        #else
        return target == "macos"
        #endif
    }

    private func markCommand(_ id: UUID, status: String, response: [String: String]) async {
        let _ = try? await supabase
            .from(DBTables.commands)
            .update(CommandUpdate(
                status: status,
                response: response,
                completed_at: ISO8601DateFormatter().string(from: Date())
            ))
            .eq("id", value: id.uuidString)
            .execute()
    }

    private func handleSpeak(id: UUID, payload: [String: String]?) async {
        let text = (payload?["text"] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else {
            await markCommand(id, status: "failed", response: ["error": "speak: text required"])
            return
        }
        #if os(iOS)
        // Route through playback so speech is audible even with the ringer off.
        try? AVAudioSession.sharedInstance().setCategory(.playback, options: [.duckOthers])
        try? AVAudioSession.sharedInstance().setActive(true)
        #endif
        let utterance = AVSpeechUtterance(string: text)
        utterance.rate = AVSpeechUtteranceDefaultSpeechRate
        speechSynth.speak(utterance)
        await markCommand(id, status: "completed", response: ["spoken": "true"])
    }

    private func handleHaptic(id: UUID, payload: [String: String]?) async {
        #if os(iOS)
        let style = payload?["style"] ?? "medium"
        switch style {
        case "success", "warning", "error":
            let gen = UINotificationFeedbackGenerator()
            gen.notificationOccurred(style == "success" ? .success : style == "warning" ? .warning : .error)
        case "light", "heavy", "medium":
            let map: [String: UIImpactFeedbackGenerator.FeedbackStyle] = ["light": .light, "heavy": .heavy, "medium": .medium]
            let gen = UIImpactFeedbackGenerator(style: map[style] ?? .medium)
            gen.impactOccurred()
        default:
            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        }
        await markCommand(id, status: "completed", response: ["haptic": "true"])
        #else
        // macOS has no haptic engine — acknowledge so the sender doesn't hang.
        await markCommand(id, status: "completed", response: ["haptic": "unsupported-on-macos"])
        #endif
    }

    #if os(iOS)
    private func handleResetHealthAnchors(id: UUID, payload: [String: String]?) async {
        let types = payload?["types"]?.split(separator: ",").map { String($0).trimmingCharacters(in: .whitespaces) }
        let cleared = HealthKitManager.shared.resetAnchors(onlyTypes: types)
        // Kick a fresh sync immediately so new data flows.
        HealthKitManager.shared.syncOnForeground()
        let update = CommandUpdate(
            status: "completed",
            response: ["cleared_anchors": "\(cleared)", "types_filter": types?.joined(separator: ",") ?? "all"],
            completed_at: ISO8601DateFormatter().string(from: Date())
        )
        let _ = try? await supabase
            .from(DBTables.commands)
            .update(update)
            .eq("id", value: id.uuidString)
            .execute()
    }

    private func handleRefreshHealthSync(id: UUID) async {
        HealthKitManager.shared.syncOnForeground()
        let update = CommandUpdate(
            status: "completed",
            response: ["triggered": "true"],
            completed_at: ISO8601DateFormatter().string(from: Date())
        )
        let _ = try? await supabase
            .from(DBTables.commands)
            .update(update)
            .eq("id", value: id.uuidString)
            .execute()
    }

    /// What the phone itself sees of HealthKit (2026-10-08: sleep stopped
    /// reaching Supabase after 2026-09-20 while the Watch's overnight vitals
    /// kept arriving — the server cannot tell "no samples" from "no permission").
    private func handleHealthDiagnose(id: UUID) async {
        let diag = await HealthKitManager.shared.diagnose()
        let update = CommandUpdate(
            status: "completed",
            response: diag,
            completed_at: ISO8601DateFormatter().string(from: Date())
        )
        let _ = try? await supabase
            .from(DBTables.commands)
            .update(update)
            .eq("id", value: id.uuidString)
            .execute()
    }
    #else
    // macOS: silently ignore iOS-only health commands — do NOT mark as failed,
    // so iOS can still pick them up via the same realtime subscription.
    private func handleResetHealthAnchors(id: UUID, payload: [String: String]?) async {}
    private func handleRefreshHealthSync(id: UUID) async {}
    private func handleHealthDiagnose(id: UUID) async {}
    #endif

    private func handleLocationCommand(id: UUID) async {
        let result = await locationManager.getCurrentLocation()

        switch result {
        case .success(let loc):
            if loc.accuracy < 0 {
                let update = CommandUpdate(
                    status: "failed",
                    response: ["error": "Location request failed"],
                    completed_at: ISO8601DateFormatter().string(from: Date())
                )
                let _ = try? await supabase
                    .from(DBTables.commands)
                    .update(update)
                    .eq("id", value: id.uuidString)
                    .execute()
                return
            }
            let update = CommandUpdate(
                status: "completed",
                response: [
                    "latitude": "\(loc.latitude)",
                    "longitude": "\(loc.longitude)",
                    "accuracy": "\(loc.accuracy)",
                    "timestamp": ISO8601DateFormatter().string(from: loc.timestamp),
                ],
                completed_at: ISO8601DateFormatter().string(from: Date())
            )
            let _ = try? await supabase
                .from(DBTables.commands)
                .update(update)
                .eq("id", value: id.uuidString)
                .execute()

        case .failure(let error):
            let errorMsg: String
            switch error {
            case .denied:
                errorMsg = "Location permission denied"
            case .failed(let msg):
                errorMsg = msg
            }
            let update = CommandUpdate(
                status: "failed",
                response: ["error": errorMsg],
                completed_at: ISO8601DateFormatter().string(from: Date())
            )
            let _ = try? await supabase
                .from(DBTables.commands)
                .update(update)
                .eq("id", value: id.uuidString)
                .execute()
        }
    }

    private func handleFlushLocationCommand(id: UUID) async {
        #if os(iOS)
        await LocationTracker.shared.flushUnsynced()
        #endif
        let update = CommandUpdate(
            status: "completed",
            response: ["ok": "flushed"],
            completed_at: ISO8601DateFormatter().string(from: Date())
        )
        let _ = try? await supabase
            .from(DBTables.commands)
            .update(update)
            .eq("id", value: id.uuidString)
            .execute()
    }

    func sendAttachment(data: Data, filename: String, contentType: String) async {
        isWaitingForResponse = true

        let path = AttachmentKey.make(for: filename)  // Storage keys take ASCII only
        do {
            try await supabase.storage
                .from(Install.attachmentsBucket)
                .upload(path, data: data, options: .init(contentType: contentType))

            let publicURL = try supabase.storage
                .from(Install.attachmentsBucket)
                .getPublicURL(path: path)

            let newMessage = InsertMessage(
                role: "user",
                content: publicURL.absoluteString,
                read: false,
                channel: currentChannel.rawValue
            )
            let inserted: Message = try await supabase
                .from(DBTables.messages)
                .insert(newMessage)
                .select("id,role,content,read,created_at,reaction,channel,reply_to,metadata")
                .single()
                .execute()
                .value
            if inserted.channel == currentChannel.rawValue,
               !self.messages.contains(where: { $0.id == inserted.id }) {
                self.messages.append(inserted)
            }
            store.upsert(inserted)
            backupToCloud()
        } catch {
            self.error = "Failed to send attachment: \(error.localizedDescription)"
            self.isWaitingForResponse = false
            print("Attachment error: \(error)")
        }
    }

    /// Focus-driven reconnect: only tears the socket down when it is actually
    /// down. Clicking into the window used to run the full teardown
    /// (`removeChannel` -> `disconnect()` -> `messageTask.cancel()`) on every
    /// `didBecomeActiveNotification`, which is both pure churn and the thing
    /// that raced the WebSocket's own close callback into a deadlock
    /// (fixed upstream in supabase-swift 2.54.1, but not worth re-provoking).
    func reconnectIfDisconnected() {
        var healthy = false
        if case .connected = supabase.realtimeV2.status,
           let messages = realtimeChannel, let commands = commandsChannel,
           case .subscribed = messages.status,
           case .subscribed = commands.status {
            healthy = true
        }
        guard !healthy else { return }
        reconnectIfNeeded()
    }

    /// Unconditional teardown + re-subscribe. Correct for channel switches,
    /// where the realtime topic itself changes; use `reconnectIfDisconnected()`
    /// for lifecycle/focus events.
    func reconnectIfNeeded() {
        // Cancel previous reconnect loops and start fresh
        reconnectTask?.cancel()
        reconnectTask = Task {
            await unsubscribe()
            async let msgs: Void = subscribeToNewMessages()
            async let cmds: Void = subscribeToCommands()
            _ = await (msgs, cmds)
        }
    }

    /// Periodic catch-up: re-fetch messages every 30s.
    /// Guards against silent Realtime drops that scenePhase doesn't detect.
    /// On macOS, runs unconditionally since isActive is unreliable when
    /// the window is open but another app has focus.
    func startCatchUpTimer() {
        catchUpTimer?.cancel()
        catchUpTimer = Task {
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(30))
                guard !Task.isCancelled else { continue }
                #if os(iOS)
                guard isAppActive else { continue }
                #endif
                await loadMessages()
            }
        }
    }

    func stopCatchUpTimer() {
        catchUpTimer?.cancel()
        catchUpTimer = nil
    }

    func unsubscribe() async {
        if let channel = realtimeChannel {
            await supabase.realtimeV2.removeChannel(channel)
        }
        if let channel = commandsChannel {
            await supabase.realtimeV2.removeChannel(channel)
        }
    }
}

struct CommandRow: Decodable {
    let id: UUID
    let command: String
    let status: String
    let payload: [String: String]?
}

struct CommandUpdate: Encodable {
    let status: String
    let response: [String: String]
    let completed_at: String
}

// Helper to get a proper Supabase-compatible JSON decoder
extension JSONDecoder {
    static var supabaseDecoder: JSONDecoder {
        let decoder = JSONDecoder()
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let string = try container.decode(String.self)
            if let date = formatter.date(from: string) {
                return date
            }
            // Try without fractional seconds
            formatter.formatOptions = [.withInternetDateTime]
            if let date = formatter.date(from: string) {
                return date
            }
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "Cannot decode date: \(string)"
            )
        }
        return decoder
    }
}
