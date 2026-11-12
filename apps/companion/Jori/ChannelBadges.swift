//
//  ChannelBadges.swift
//  Jori
//
//  The team and its conversations (migration 0180, system/org.md). The file
//  keeps its old name so the Xcode project needs no change; it used to hold the
//  per-channel badges, which are now per conversation.
//
//  The app talks to a team, like a messaging app talks to people. Each team
//  role (a CFO, a historian, the chief of staff who coordinates them) is a
//  "person" with a name and a role title, both of which the user can rename.
//  A conversation is `role:<id>` with one role or `group:<uuid>` with several.
//  A fresh install shows only the coordinator; a role's conversation appears
//  when the role has something to say (the server creates it on its first
//  message) or when the user starts one. The old channels are roles'
//  conversations: System and Improvements are Product's (all the tech), and
//  a question lives with the role that asked it.
//
//  Counts per conversation, and what they mean:
//    - unread    → assistant messages not marked read yet (zero for the one on
//                  screen; ChatViewModel marks them read a beat later).
//    - questions → questions still WAITING FOR AN ANSWER, judged by the same
//                  rule as the bubble colour and the tray
//                  (ChatViewModel.isOpenQuestion). Reading is not answering, so
//                  it stays lit while you look.
//    - the software engineer's conversation also counts improvement cards
//      WAITING ON FACE ID — the one thing in the app that blocks on the user.
//  Counts are best-effort: a failed refresh keeps the last known value rather
//  than flashing zero.
//

import Foundation
import SwiftUI
import PhotosUI
import ImageIO
import Supabase
import Realtime

// MARK: - Models

/// A team role (jori_team): its id is the role plugin's (`cfo`), its name and
/// title are what the user sees and can rename.
struct TeamMember: Identifiable, Codable, Equatable, Hashable {
    let id: String
    var name: String
    var title: String
    var responsibility: String?
    var chiefOfStaff: Bool
    var enabled: Bool
    var sort: Int
    /// A photo the user picked for this role; nil = its initials.
    var avatarURL: String? = nil

    enum CodingKeys: String, CodingKey {
        case id, name, title, responsibility, enabled, sort
        case chiefOfStaff = "chief_of_staff"
        case avatarURL = "avatar_url"
    }

    /// "Ada · CFO": a name always travels with its role.
    var label: String { title.isEmpty || title == name ? name : "\(name) · \(title)" }

    var initials: String {
        let parts = name.split(separator: " ")
        return String(parts.prefix(2).compactMap(\.first)).uppercased()
    }

    /// A stable tint per role, from the palette's neighbourhood.
    var tint: Color {
        let palette: [Color] = [JoriTheme.cobalt, .teal, .indigo, .orange, .pink, .green, .purple, .brown, .mint, .cyan]
        let h = id.unicodeScalars.reduce(0) { ($0 &* 31 &+ Int($1.value)) & 0x7fffffff }
        return chiefOfStaff ? JoriTheme.cobalt : palette[h % palette.count]
    }
}

/// A conversation (jori_conversations).
struct Conversation: Identifiable, Codable, Equatable, Hashable {
    let id: String
    var kind: String
    var title: String?
    var members: [String]
    var lastMessageAt: Date?
    var archived: Bool
    /// When it was pinned to the top of the list; nil = not pinned.
    var pinnedAt: Date?

    enum CodingKeys: String, CodingKey {
        case id, kind, title, members, archived
        case lastMessageAt = "last_message_at"
        case pinnedAt = "pinned_at"
    }

    var isGroup: Bool { kind == "group" }
    var isPinned: Bool { pinnedAt != nil }
}

/// What a conversation's row shows besides its people.
struct ConversationSummary: Equatable {
    var preview: String?
    var previewAt: Date?
    var previewFromUser = false
    var unread = 0
    var openQuestions = 0
}

// MARK: - Store

@MainActor
final class TeamStore: ObservableObject {
    @Published private(set) var team: [TeamMember] = []
    /// Roles installed but not on the team yet (jori_team.enabled = false): the
    /// user can add one, and it joins the team (system/org.md § Growing the
    /// team). A personal assistant becomes the chief of staff when one does.
    @Published private(set) var available: [TeamMember] = []
    @Published private(set) var conversations: [Conversation] = []
    @Published private(set) var summaries: [String: ConversationSummary] = [:]
    /// Improvement cards waiting on Face ID: counted on the software engineer's conversation.
    @Published private(set) var pendingImprovements = 0

    /// The conversation on screen: its unread count reads zero.
    var activeConversation: String = ConversationID.coordinator

    private static let teamTable = "jori_team"
    private static let conversationsTable = "jori_conversations"
    /// The role whose conversation the improvement cards belong to (the old
    /// Improvements channel; jori_channel_roles' default).
    static let improvementsRole = "software-engineer"

    private var loop: Task<Void, Never>?
    private var realtime: Task<Void, Never>?
    private var realtimeChannel: RealtimeChannelV2?
    private static let activePollInterval: Duration = .seconds(15)
    private static let backgroundPollInterval: Duration = .seconds(120)
    private var pollInterval: Duration = TeamStore.activePollInterval

    // MARK: Lookup

    func member(_ id: String?) -> TeamMember? {
        guard let id else { return nil }
        return team.first { $0.id == id } ?? available.first { $0.id == id }
    }

    /// The coordinator's conversation: the chief of staff's, once the team has
    /// loaded.
    var coordinatorConversation: String {
        team.first(where: \.chiefOfStaff).map { ConversationID.role($0.id) } ?? ConversationID.coordinator
    }

    /// The role ids in a conversation.
    func memberIds(of conversationId: String) -> [String] {
        if let c = conversations.first(where: { $0.id == conversationId }), !c.members.isEmpty { return c.members }
        return ConversationID.roleId(conversationId).map { [$0] } ?? []
    }

    func members(of conversationId: String) -> [TeamMember] {
        memberIds(of: conversationId).map { id in
            member(id) ?? TeamMember(id: id, name: Self.fallbackName(id), title: "", responsibility: nil,
                                     chiefOfStaff: false, enabled: true, sort: 999)
        }
    }

    /// "Ada" for one role, "Ada, Ben" (or the group's own name) for a group.
    func title(of conversationId: String) -> String {
        if let c = conversations.first(where: { $0.id == conversationId }), let t = c.title, !t.isEmpty { return t }
        let names = members(of: conversationId).map(\.name)
        return names.isEmpty ? Install.displayName : names.joined(separator: ", ")
    }

    /// "CFO" for one role, "CFO · Historian" for a group.
    func subtitle(of conversationId: String) -> String {
        members(of: conversationId).map(\.title).filter { !$0.isEmpty }.joined(separator: " · ")
    }

    /// The bubble label for an assistant message: "Ada · CFO".
    func senderLabel(_ sender: String?) -> String? {
        member(sender)?.label
    }

    private static func fallbackName(_ id: String) -> String {
        id.split(separator: "-").map { $0.prefix(1).uppercased() + $0.dropFirst() }.joined(separator: " ")
    }

    /// The conversations the list shows: pinned ones first (in the order they
    /// were pinned, like iMessage), then the rest newest first. The coordinator
    /// is always there, even before its first row exists.
    var visibleConversations: [Conversation] {
        var list = conversations.filter { !$0.archived }
        let coord = coordinatorConversation
        if !list.contains(where: { $0.id == coord }) {
            list.append(Conversation(id: coord, kind: "role", title: nil,
                                     members: [ConversationID.roleId(coord) ?? "chief-of-staff"],
                                     lastMessageAt: nil, archived: false))
        }
        return list.sorted { a, b in
            switch (a.pinnedAt, b.pinnedAt) {
            case let (pa?, pb?): return pa < pb
            case (.some, nil): return true
            case (nil, .some): return false
            case (nil, nil): break
            }
            let da = summaries[a.id]?.previewAt ?? a.lastMessageAt ?? .distantPast
            let db = summaries[b.id]?.previewAt ?? b.lastMessageAt ?? .distantPast
            return da > db
        }
    }

    /// The pinned conversations, in pin order: the grid of circles on top.
    var pinnedConversations: [Conversation] { visibleConversations.filter(\.isPinned) }
    /// Everything else, newest first: the rows under the grid.
    var unpinnedConversations: [Conversation] { visibleConversations.filter { !$0.isPinned } }

    // MARK: Counts

    func unread(_ conversationId: String) -> Int {
        conversationId == activeConversation ? 0 : (summaries[conversationId]?.unread ?? 0)
    }

    func openQuestions(_ conversationId: String) -> Int { summaries[conversationId]?.openQuestions ?? 0 }

    func waiting(_ conversationId: String) -> Int {
        ConversationID.roleId(conversationId) == Self.improvementsRole ? pendingImprovements : 0
    }

    /// What one conversation's red badge counts: unread messages, unanswered
    /// questions, and approvals waiting for Face ID — one number, no icons.
    func badgeCount(_ conversationId: String) -> Int {
        unread(conversationId) + openQuestions(conversationId) + waiting(conversationId)
    }

    /// Everything waiting on the user, for the badge on the way back to the list.
    var total: Int {
        visibleConversations.reduce(0) { $0 + badgeCount($1.id) }
    }

    /// Badge text, capped so a runaway count can't blow out the toolbar.
    static func label(_ n: Int) -> String { n > 99 ? "99+" : "\(n)" }

    /// The open view's own count is fresher than a poll (a dismissal or an
    /// answer shows at once), so the conversation reports it on every change.
    func setOpenQuestions(_ n: Int, in conversationId: String) {
        var s = summaries[conversationId] ?? ConversationSummary()
        guard s.openQuestions != n else { return }
        s.openQuestions = n
        summaries[conversationId] = s
    }

    // MARK: Lifecycle

    /// Start polling and listening. Idempotent.
    func start() {
        if loop == nil {
            loop = Task { [weak self] in
                while !Task.isCancelled {
                    await self?.refresh()
                    let interval = self?.pollInterval ?? Self.activePollInterval
                    try? await Task.sleep(for: interval)
                }
            }
        }
        if realtime == nil {
            realtime = Task { [weak self] in await self?.listen() }
        }
    }

    func stop() {
        loop?.cancel()
        loop = nil
        pollInterval = Self.activePollInterval
    }

    /// macOS: slow (not stop) polling while the window is open but unfocused.
    func setBackgroundPolling(_ slow: Bool) {
        pollInterval = slow ? Self.backgroundPollInterval : Self.activePollInterval
    }

    /// A rename or a new conversation from another device shows at once.
    private func listen() async {
        do { try await SupabaseManager.ensureAuthenticated() } catch {}
        let channel = SupabaseManager.shared.realtimeV2.channel("team_and_conversations")
        let team = channel.postgresChange(AnyAction.self, schema: "public", table: Self.teamTable)
        let conversations = channel.postgresChange(AnyAction.self, schema: "public", table: Self.conversationsTable)
        let reviews = channel.postgresChange(AnyAction.self, schema: "public", table: Self.gateReviewsTable)
        await channel.subscribe()
        realtimeChannel = channel
        await withTaskGroup(of: Void.self) { group in
            group.addTask { @MainActor [weak self] in
                for await _ in team { await self?.loadTeam() }
            }
            group.addTask { @MainActor [weak self] in
                for await _ in conversations { await self?.loadConversations() }
            }
            // A speak-gate verdict (live: written seconds after its message;
            // or a held message) shows at once.
            group.addTask { @MainActor [weak self] in
                for await _ in reviews {
                    guard let self else { return }
                    await self.loadGateReviews(self.activeConversation)
                }
            }
        }
    }

    // MARK: Refresh

    func refresh() async {
        await loadTeam()
        await loadConversations()
        await loadSummaries()
        await loadGateReviews(activeConversation)
        if let n = try? await SelfImproveApproval.pendingApprovalCount(), n != pendingImprovements {
            pendingImprovements = n
        }
    }

    func loadTeam() async {
        do {
            try await SupabaseManager.ensureAuthenticated()
            let rows: [TeamMember] = try await SupabaseManager.shared
                .from(Self.teamTable)
                .select("id,name,title,responsibility,chief_of_staff,enabled,sort,avatar_url")
                .order("sort", ascending: true)
                .execute()
                .value
            // A role the user just added stays on the team here until the
            // server has turned it on (and the next load says enabled).
            let on = rows.filter { $0.enabled || joining.contains($0.id) }
            for r in rows where r.enabled { joining.remove(r.id) }
            let off = rows.filter { !$0.enabled && !joining.contains($0.id) }
            if on != team { team = on }
            if off != available { available = off }
        } catch {
            print("[Team] team load failed: \(error)")
        }
    }

    func loadConversations() async {
        do {
            try await SupabaseManager.ensureAuthenticated()
            let rows: [Conversation]
            do {
                rows = try await SupabaseManager.shared
                    .from(Self.conversationsTable)
                    .select("id,kind,title,members,last_message_at,archived,pinned_at")
                    .execute()
                    .value
            } catch {
                // A database without migration 0183 has no pinned_at: list
                // the conversations unpinned rather than not at all.
                rows = try await SupabaseManager.shared
                    .from(Self.conversationsTable)
                    .select("id,kind,title,members,last_message_at,archived")
                    .execute()
                    .value
            }
            if rows != conversations { conversations = rows }
        } catch {
            print("[Team] conversations load failed: \(error)")
        }
    }

    // MARK: Gate reviews (system/speak-gate.md)

    /// The think-before-you-speak gate's verdict on each delivered message,
    /// shown folded under it for the user to grade. Since the gate went live
    /// (2026-11-11) it judges before delivery and acts: a rewritten message
    /// carries its original, folded until opened.
    @Published var gateReviews: [UUID: GateReview] = [:]
    /// Reviews with no message row: messages the gate held (drop / digest /
    /// resolve), and emails to the user (sent or held). Shown as a folded line
    /// in their conversation.
    @Published var heldReviews: [String: [GateReview]] = [:]
    /// Every open question the badges count, by conversation (loadSummaries).
    @Published var openQuestionMessages: [String: [Message]] = [:]
    static let gateReviewsTable = "jori_gate_reviews"

    func loadGateReviews(_ conversationId: String) async {
        guard !conversationId.isEmpty else { return }
        do {
            try await SupabaseManager.ensureAuthenticated()
            let rows: [GateReview] = try await SupabaseManager.shared
                .from(Self.gateReviewsTable)
                .select("id,message_id,channel,verdict,reason,suggestion,grade,note,original,live,held,judged_at,digested_on,handed_back_at")
                .eq("conversation_id", value: conversationId)
                .order("judged_at", ascending: false)
                .limit(300)
                .execute()
                .value
            var next = gateReviews
            for r in rows { if let mid = r.message_id { next[mid] = r } }
            if next != gateReviews { gateReviews = next }
            // Reviews with no message row: held messages, and emails (checked before sending).
            let held = rows.filter { $0.message_id == nil && ($0.held == true || $0.channel == "email") }.sorted { ($0.judged_at ?? .distantPast) < ($1.judged_at ?? .distantPast) }
            if heldReviews[conversationId] != held { heldReviews[conversationId] = held }
        } catch {
            print("[Team] gate reviews load failed: \(error)")
        }
    }

    /// The user's grade on one verdict: "right" or "wrong", with an optional
    /// note. Keyed by the review's own id (a held message has no message row).
    func gradeGate(_ reviewId: UUID, grade: String, note: String) async {
        for (k, r) in gateReviews where r.id == reviewId { gateReviews[k] = r.graded(grade, note: note) }
        for (c, list) in heldReviews where list.contains(where: { $0.id == reviewId }) {
            heldReviews[c] = list.map { $0.id == reviewId ? $0.graded(grade, note: note) : $0 }
        }
        struct Patch: Encodable { let grade: String; let note: String?; let graded_at: String }
        do {
            try await SupabaseManager.ensureAuthenticated()
            try await SupabaseManager.shared
                .from(Self.gateReviewsTable)
                .update(Patch(grade: grade, note: note.isEmpty ? nil : note, graded_at: Date().ISO8601Format()))
                .eq("id", value: reviewId.uuidString)
                .execute()
        } catch {
            print("[Team] gate grade failed: \(error)")
        }
    }

    /// Everything in a conversation the user has opened is read: clear its
    /// count here at once, and mark every unread assistant row in it read on
    /// the server in ONE update, awaited, so the next summary load cannot bring
    /// the badge back. (The thread view marks rows one at a time and only the
    /// rows it loaded, so older unread rows, or a summary load that raced those
    /// writes, made a badge clear on open and return on the way back.)
    func markRead(_ conversationId: String) async {
        guard !conversationId.isEmpty else { return }
        if var s = summaries[conversationId], s.unread != 0 { s.unread = 0; summaries[conversationId] = s }
        do {
            try await SupabaseManager.ensureAuthenticated()
            try await SupabaseManager.shared
                .from(DBTables.messages)
                .update(["read": true])
                .eq("conversation_id", value: conversationId)
                .eq("role", value: "assistant")
                .eq("read", value: false)
                .execute()
        } catch {
            print("[Team] mark read failed: \(error)")
        }
    }

    /// Previews, unread counts and open questions for every conversation, in
    /// three queries rather than three per conversation.
    func loadSummaries() async {
        var next = summaries
        do {
            try await SupabaseManager.ensureAuthenticated()
            let client = SupabaseManager.shared

            // Previews: the newest message of each conversation.
            let recent: [Message] = try await client
                .from(DBTables.messages)
                .select(Message.columns)
                .order("created_at", ascending: false)
                .limit(400)
                .execute()
                .value
            var seen = Set<String>()
            for m in recent where !seen.contains(m.conversationId) && !ChatViewModel.isDismissal(m) {
                seen.insert(m.conversationId)
                var s = next[m.conversationId] ?? ConversationSummary()
                s.preview = Self.preview(of: m)
                s.previewAt = m.createdAt
                s.previewFromUser = m.isUser
                next[m.conversationId] = s
            }
            // A conversation quiet for longer than that window: ask for its newest.
            for c in conversations where !seen.contains(c.id) && c.lastMessageAt != nil {
                let last: [Message] = (try? await client
                    .from(DBTables.messages)
                    .select(Message.columns)
                    .eq("conversation_id", value: c.id)
                    .order("created_at", ascending: false)
                    .limit(1)
                    .execute()
                    .value) ?? []
                if let m = last.first {
                    var s = next[c.id] ?? ConversationSummary()
                    s.preview = Self.preview(of: m)
                    s.previewAt = m.createdAt
                    s.previewFromUser = m.isUser
                    next[c.id] = s
                }
            }

            // Unread: assistant messages not yet marked read, counted per conversation.
            struct UnreadRow: Decodable { let conversation_id: String? }
            let unread: [UnreadRow] = try await client
                .from(DBTables.messages)
                .select("conversation_id")
                .eq("role", value: "assistant")
                .eq("read", value: false)
                .limit(2000)
                .execute()
                .value
            var unreadBy: [String: Int] = [:]
            for r in unread { if let c = r.conversation_id { unreadBy[c, default: 0] += 1 } }
            for key in Set(next.keys).union(unreadBy.keys) {
                var s = next[key] ?? ConversationSummary()
                s.unread = unreadBy[key] ?? 0
                next[key] = s
            }

            // Open questions: questions and choice cards inside the open window
            // (ChatViewModel.questionStaleAfter, the same cutoff the thread uses)
            // that carry no recorded state, with the replies that would close
            // them, judged by the shared rule. Only rows without a state are
            // fetched: with every answered question in the window too, a
            // 300-row cap cut off the older open ones, and a badge went missing
            // while the thread still showed them open.
            let since = Date().addingTimeInterval(-ChatViewModel.questionStaleAfter).ISO8601Format()
            let asked: [Message] = try await client
                .from(DBTables.messages)
                .select(Message.columns)
                .eq("role", value: "assistant")
                .gte("created_at", value: since)
                .or("metadata->>question_id.not.is.null,metadata->>\(ChoicePrompt.metadataKey).not.is.null")
                .is("metadata->>question_state", value: nil)
                .order("created_at", ascending: false)
                .limit(1000)
                .execute()
                .value
            var replies: [Message] = []
            if !asked.isEmpty {
                replies = try await client
                    .from(DBTables.messages)
                    .select(Message.columns)
                    .in("reply_to", values: asked.map { $0.id.uuidString })
                    .execute()
                    .value
            }
            let open = ChatViewModel.openQuestions(in: (asked + replies).sorted { $0.createdAt < $1.createdAt })
            var openBy: [String: Int] = [:]
            for q in open { openBy[q.conversationId, default: 0] += 1 }
            // The questions themselves, so the conversation's tray can list
            // every one the badge counts, including any too old to have been
            // loaded into the thread (one sat 24 days back, counted and unfindable).
            let byConversation = Dictionary(grouping: open, by: \.conversationId)
            if byConversation != openQuestionMessages { openQuestionMessages = byConversation }
            for key in Set(next.keys).union(openBy.keys) {
                var s = next[key] ?? ConversationSummary()
                s.openQuestions = openBy[key] ?? 0
                next[key] = s
            }
        } catch {
            // Keep the last known counts — see the note at the top of the file.
            print("[Team] summaries failed: \(error)")
        }
        // Publishing an unchanged dictionary still redraws every observer.
        if next != summaries { summaries = next }
    }

    private static func preview(of m: Message) -> String {
        if m.content.contains(Install.attachmentsBucket) { return m.isUser ? "You sent an attachment" : "Attachment" }
        let flat = m.content.replacingOccurrences(of: "\n", with: " ")
        return m.isUser ? "You: \(flat)" : flat
    }

    // MARK: Writes

    /// Delete a conversation from the list. It is hidden (archived), not
    /// erased: its messages stay in Jori's memory. A role's own conversation
    /// comes back by itself the next time that role writes (the database
    /// trigger un-archives it); a deleted group stays gone. The coordinator's
    /// conversation can't be deleted.
    func deleteConversation(_ id: String) async {
        guard id != coordinatorConversation else { return }
        struct Patch: Encodable { let archived: Bool }
        if let i = conversations.firstIndex(where: { $0.id == id }) { conversations[i].archived = true }
        do {
            try await SupabaseManager.ensureAuthenticated()
            try await SupabaseManager.shared
                .from(Self.conversationsTable)
                .update(Patch(archived: true))
                .eq("id", value: id)
                .execute()
            await loadConversations()
        } catch {
            print("[Team] delete conversation failed: \(error)")
        }
    }

    /// Pin a conversation to the top of the list, or unpin it. Stored on the
    /// row (pinned_at, migration 0183) so every device shows the same pins.
    func setPinned(_ id: String, _ pinned: Bool) async {
        let now = Date()
        if let i = conversations.firstIndex(where: { $0.id == id }) {
            conversations[i].pinnedAt = pinned ? now : nil
        }
        struct Patch: Encodable {
            let id: String
            let pinned_at: String?
            // Encode a null explicitly: unpinning must clear the column.
            func encode(to e: Encoder) throws {
                var c = e.container(keyedBy: CodingKeys.self)
                try c.encode(pinned_at, forKey: .pinned_at)
            }
            enum CodingKeys: String, CodingKey { case pinned_at }
        }
        let stamp = pinned ? ISO8601DateFormatter().string(from: now) : nil
        do {
            try await SupabaseManager.ensureAuthenticated()
            if conversations.contains(where: { $0.id == id }) {
                try await SupabaseManager.shared
                    .from(Self.conversationsTable)
                    .update(Patch(id: id, pinned_at: stamp))
                    .eq("id", value: id)
                    .execute()
            } else if let roleId = ConversationID.roleId(id) {
                // The coordinator before its first row exists.
                await write(ConversationRow(id: id, kind: "role", title: nil, members: [roleId], created_by: "user"))
                try await SupabaseManager.shared
                    .from(Self.conversationsTable)
                    .update(Patch(id: id, pinned_at: stamp))
                    .eq("id", value: id)
                    .execute()
            }
            await loadConversations()
        } catch {
            print("[Team] pin conversation failed: \(error)")
            await loadConversations()
        }
    }

    private struct ConversationRow: Encodable {
        let id: String
        let kind: String
        let title: String?
        let members: [String]
        let created_by: String
    }

    /// Roles the user added that the server has not turned on yet.
    private var joining: Set<String> = []

    /// Bring roles that are not on the team yet onto it: flag them in
    /// jori_team (requested_at) for the server to turn on, and show them as
    /// teammates right away.
    func join(_ roleIds: [String]) async {
        let newcomers = roleIds.filter { id in available.contains { $0.id == id } }
        guard !newcomers.isEmpty else { return }
        struct Patch: Encodable { let requested_at: String }
        let stamp = ISO8601DateFormatter().string(from: Date())
        for id in newcomers {
            joining.insert(id)
            if let i = available.firstIndex(where: { $0.id == id }) {
                var m = available.remove(at: i)
                m.enabled = true
                team.append(m)
            }
        }
        do {
            try await SupabaseManager.ensureAuthenticated()
            try await SupabaseManager.shared
                .from(Self.teamTable)
                .update(Patch(requested_at: stamp))
                .in("id", values: newcomers)
                .execute()
        } catch {
            print("[Team] adding \(newcomers) failed: \(error)")
            joining.subtract(newcomers)
            await loadTeam()
        }
    }

    /// The conversation with exactly these roles: the role's own for one, a new
    /// group for several (an existing group with the same people is reused).
    func conversation(with roleIds: [String]) async -> String? {
        let ids = Array(Set(roleIds)).sorted()
        guard !ids.isEmpty else { return nil }
        await join(ids)
        if ids.count == 1 {
            let id = ConversationID.role(ids[0])
            if !conversations.contains(where: { $0.id == id }) {
                await write(ConversationRow(id: id, kind: "role", title: nil, members: ids, created_by: "user"))
            }
            return id
        }
        if let existing = conversations.first(where: { $0.isGroup && !$0.archived && Set($0.members) == Set(ids) }) {
            return existing.id
        }
        let id = ConversationID.newGroup()
        await write(ConversationRow(id: id, kind: "group", title: nil, members: ids, created_by: "user"))
        return id
    }

    /// Bring roles into the conversation on screen (an @mention, or "Add
    /// someone"). They join THIS conversation — a role's own conversation
    /// included — and read its recent messages before they answer; no new
    /// group is started (the user's call, 2026-11-10). Returns the conversation
    /// to continue in, which is always the same one.
    func add(_ roleIds: [String], to conversationId: String) async -> String {
        let current = memberIds(of: conversationId)
        let missing = roleIds.filter { !current.contains($0) }
        guard !missing.isEmpty else { return conversationId }
        await join(missing)
        let c = conversations.first(where: { $0.id == conversationId })
        let kind = c?.kind ?? (ConversationID.isGroup(conversationId) ? "group" : "role")
        await write(ConversationRow(id: conversationId, kind: kind, title: c?.title,
                                    members: current + missing, created_by: "user"))
        return conversationId
    }

    func renameConversation(_ conversationId: String, to title: String) async {
        guard let c = conversations.first(where: { $0.id == conversationId }), c.isGroup else { return }
        let t = title.trimmingCharacters(in: .whitespacesAndNewlines)
        await write(ConversationRow(id: c.id, kind: c.kind, title: t.isEmpty ? nil : t, members: c.members, created_by: "user"))
    }

    private func write(_ row: ConversationRow) async {
        do {
            try await SupabaseManager.ensureAuthenticated()
            try await SupabaseManager.shared
                .from(Self.conversationsTable)
                .upsert(row, onConflict: "id")
                .execute()
            await loadConversations()
        } catch {
            print("[Team] conversation write failed: \(error)")
        }
    }

    /// Rename a role: its name, its title, or both. The roster sync keeps the
    /// user's choice from now on (renamed_by_user).
    /// Give a role a photo: shrink what the user picked to a 512 px JPEG,
    /// upload it next to the chat attachments, and point the role at it.
    /// Its initials stay the default (removePhoto goes back to them).
    func setPhoto(_ id: String, imageData: Data) async {
        guard let jpeg = Self.avatarJPEG(from: imageData) else { print("[Team] photo: unreadable image"); return }
        let path = "team/\(id)-\(UUID().uuidString.prefix(8)).jpg"
        do {
            try await SupabaseManager.ensureAuthenticated()
            let client = SupabaseManager.shared
            try await client.storage.from(Install.attachmentsBucket)
                .upload(path, data: jpeg, options: .init(contentType: "image/jpeg"))
            let url = try client.storage.from(Install.attachmentsBucket).getPublicURL(path: path).absoluteString
            await writeAvatar(id, url)
        } catch {
            print("[Team] photo upload failed: \(error)")
        }
    }

    func removePhoto(_ id: String) async { await writeAvatar(id, nil) }

    private func writeAvatar(_ id: String, _ url: String?) async {
        struct Patch: Encodable { let avatar_url: String?; let updated_at: String
            func encode(to e: Encoder) throws { var c = e.container(keyedBy: K.self); try c.encode(avatar_url, forKey: .avatar_url); try c.encode(updated_at, forKey: .updated_at) }
            enum K: String, CodingKey { case avatar_url, updated_at } }
        if let i = team.firstIndex(where: { $0.id == id }) { team[i].avatarURL = url }
        do {
            try await SupabaseManager.ensureAuthenticated()
            try await SupabaseManager.shared
                .from(Self.teamTable)
                .update(Patch(avatar_url: url, updated_at: Date().ISO8601Format()))
                .eq("id", value: id)
                .execute()
        } catch {
            print("[Team] photo save failed: \(error)")
        }
    }

    /// Any image the system can read (HEIC included) as a square-ish 512 px JPEG.
    static func avatarJPEG(from data: Data) -> Data? {
        guard let src = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        let opts: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: 512,
        ]
        guard let img = CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary) else { return nil }
        let out = NSMutableData()
        guard let dst = CGImageDestinationCreateWithData(out, "public.jpeg" as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(dst, img, [kCGImageDestinationLossyCompressionQuality: 0.85] as CFDictionary)
        return CGImageDestinationFinalize(dst) ? out as Data : nil
    }

    func rename(_ id: String, name: String, title: String) async {
        let n = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let t = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !n.isEmpty, !t.isEmpty else { return }
        struct Rename: Encodable {
            let name: String
            let title: String
            let renamed_by_user: Bool
            let updated_at: String
        }
        // Optimistic: the list and the bubbles change now.
        if let i = team.firstIndex(where: { $0.id == id }) {
            team[i].name = n
            team[i].title = t
        }
        do {
            try await SupabaseManager.ensureAuthenticated()
            try await SupabaseManager.shared
                .from(Self.teamTable)
                .update(Rename(name: n, title: t, renamed_by_user: true, updated_at: Date().ISO8601Format()))
                .eq("id", value: id)
                .execute()
        } catch {
            print("[Team] rename failed: \(error)")
            await loadTeam()
        }
    }

    // MARK: Mentions

    /// The team members an @-handle in `text` names ("@Ada"). A handle is
    /// the member's name with its spaces removed, matched without case.
    func mentioned(in text: String) -> [TeamMember] {
        let lowered = text.lowercased()
        return team.filter { m in
            let handle = "@" + m.name.replacingOccurrences(of: " ", with: "").lowercased()
            guard let r = lowered.range(of: handle) else { return false }
            // A handle ends at the end of the text or at a non-letter.
            if r.upperBound == lowered.endIndex { return true }
            return !(lowered[r.upperBound].isLetter || lowered[r.upperBound].isNumber)
        }
    }
}

/// The red count bubble drawn over a button.
struct ChannelBadgeBubble: View {
    let count: Int

    var body: some View {
        Text(TeamStore.label(count))
            .font(.system(size: 10, weight: .bold))
            .monospacedDigit()
            .contentTransition(.numericText())
            .foregroundStyle(.white)
            .padding(.horizontal, 4)
            .frame(minWidth: 16, minHeight: 16)
            .background(Color.red, in: Capsule())
            .animation(.snappy, value: count)
            // Purely decorative — must never eat the button's taps.
            .allowsHitTesting(false)
    }
}

// MARK: - Avatars

/// A role's initials in its tint; a group stacks its first two.
struct TeamAvatar: View {
    let members: [TeamMember]
    var size: CGFloat = 40

    var body: some View {
        if members.count > 1 {
            ZStack {
                circle(members[1], size: size * 0.7).offset(x: size * 0.16, y: size * 0.16)
                circle(members[0], size: size * 0.7).offset(x: -size * 0.16, y: -size * 0.16)
            }
            .frame(width: size, height: size)
        } else if let m = members.first {
            circle(m, size: size)
        } else {
            Circle().fill(JoriTheme.slate).frame(width: size, height: size)
        }
    }

    /// The role's photo when the user picked one, its initials otherwise
    /// (and while the photo loads, or if it can't).
    private func circle(_ m: TeamMember, size: CGFloat) -> some View {
        initials(m, size: size)
            .overlay {
                if let s = m.avatarURL, let url = URL(string: s) {
                    AsyncImage(url: url) { phase in
                        if let image = phase.image { image.resizable().scaledToFill() } else { Color.clear }
                    }
                    .frame(width: size, height: size)
                    .clipShape(Circle())
                }
            }
            .overlay(Circle().strokeBorder(.white.opacity(0.6), lineWidth: members.count > 1 ? 1.5 : 0))
    }

    private func initials(_ m: TeamMember, size: CGFloat) -> some View {
        Text(m.initials)
            .font(.system(size: size * 0.38, weight: .semibold, design: .rounded))
            .foregroundStyle(.white)
            .frame(width: size, height: size)
            .background(Circle().fill(m.tint.gradient))
    }
}

// MARK: - Conversation list

/// The conversations, iMessage-style: who (name with role), the last message,
/// when, and what is waiting.
struct ConversationRowView: View {
    let conversation: Conversation
    @ObservedObject var team: TeamStore

    var body: some View {
        let members = team.members(of: conversation.id)
        let summary = team.summaries[conversation.id]
        let unread = team.unread(conversation.id)
        let questions = team.openQuestions(conversation.id)
        let waiting = team.waiting(conversation.id)
        let badge = team.badgeCount(conversation.id)
        HStack(alignment: .top, spacing: 12) {
            TeamAvatar(members: members, size: 42)
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    nameLine(members)
                        .lineLimit(1)
                    Spacer(minLength: 4)
                    if let at = summary?.previewAt ?? conversation.lastMessageAt {
                        Text(Self.when(at))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                HStack(alignment: .top, spacing: 6) {
                    Text(summary?.preview ?? (members.first?.responsibility ?? ""))
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                    Spacer(minLength: 4)
                    // One red badge, only when something is waiting.
                    if badge > 0 { ChannelBadgeBubble(count: badge) }
                }
            }
        }
        .padding(.vertical, 4)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityValue([unread > 0 ? "\(unread) unread" : nil,
                             questions > 0 ? "\(questions) unanswered questions" : nil,
                             waiting > 0 ? "\(waiting) waiting for Face ID" : nil]
                            .compactMap { $0 }.joined(separator: ", "))
    }

    @ViewBuilder
    private func nameLine(_ members: [TeamMember]) -> some View {
        if conversation.isGroup {
            VStack(alignment: .leading, spacing: 0) {
                Text(team.title(of: conversation.id)).font(.headline)
                Text(members.map(\.label).joined(separator: ", "))
                    .font(.caption).foregroundStyle(.secondary)
            }
        } else if let m = members.first {
            (Text(m.name).font(.headline)
             + Text(m.title.isEmpty ? "" : "  \(m.title)").font(.subheadline).foregroundColor(.secondary))
        }
    }

    static func when(_ date: Date) -> String {
        let cal = Calendar.current
        if cal.isDateInToday(date) { return date.formatted(date: .omitted, time: .shortened) }
        if cal.isDateInYesterday(date) { return "Yesterday" }
        if let days = cal.dateComponents([.day], from: date, to: .now).day, days < 6 {
            return date.formatted(.dateTime.weekday(.wide))
        }
        return date.formatted(.dateTime.month(.abbreviated).day())
    }
}

// MARK: - Pinned conversations

/// The pinned conversations as iMessage shows them: circles, three across,
/// the name under each, above the list. A red badge sits on a circle when
/// something is waiting; right-click / long-press unpins or deletes.
struct PinnedConversationsGrid: View {
    @ObservedObject var team: TeamStore
    var selected: String?
    let open: (String) -> Void
    var onDeleted: (String) -> Void = { _ in }

    private let columns = Array(repeating: GridItem(.flexible(), spacing: 18, alignment: .top), count: 3)

    var body: some View {
        LazyVGrid(columns: columns, spacing: 18) {
            ForEach(team.pinnedConversations) { conversation in
                tile(conversation)
                    .modifier(ConversationDeleteActions(conversation: conversation, team: team, onDeleted: onDeleted, swipes: false))
            }
        }
        .padding(.vertical, 8)
    }

    private func tile(_ conversation: Conversation) -> some View {
        let badge = team.badgeCount(conversation.id)
        let isSelected = selected == conversation.id
        let name = team.title(of: conversation.id)
        let role = team.subtitle(of: conversation.id)
        return Button { open(conversation.id) } label: {
            VStack(spacing: 6) {
                TeamAvatar(members: team.members(of: conversation.id), size: 54)
                    .padding(3)
                    .overlay {
                        if isSelected { Circle().strokeBorder(JoriTheme.cobalt, lineWidth: 2.5) }
                    }
                    .overlay(alignment: .topTrailing) {
                        if badge > 0 { ChannelBadgeBubble(count: badge).offset(x: 2, y: -2) }
                    }
                VStack(spacing: 1) {
                    Text(Self.short(name))
                        .font(.system(size: 10, weight: .medium))
                        .foregroundStyle(.primary)
                    if !role.isEmpty {
                        Text(Self.short(role))
                            .font(.system(size: 9))
                            .foregroundStyle(.secondary)
                    }
                }
                .lineLimit(1)
                .minimumScaleFactor(0.85)
            }
            .frame(maxWidth: .infinity)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(name + (role.isEmpty ? "" : ", \(role)") + (badge > 0 ? ", \(badge) waiting" : "") + ", pinned")
    }

    /// At most 16 characters under a circle, with an ellipsis when cut.
    static func short(_ s: String) -> String {
        s.count > 16 ? s.prefix(16).trimmingCharacters(in: .whitespaces) + "…" : s
    }
}

// MARK: - Collapsed sidebar (Mac)

/// The sidebar folded to a rail, the way Messages on the Mac does it: one
/// avatar per conversation with its name under it, pinned ones first, a short
/// rule, then the rest. The open one sits on a blue tile; a red badge marks
/// what is waiting. Right-click pins, unpins or deletes.
struct ConversationRail: View {
    @ObservedObject var team: TeamStore
    /// The conversation on screen is read from here by each tile itself.
    @ObservedObject var chat: ChatViewModel
    /// Memory is on screen: no conversation is highlighted.
    var inMemory = false
    let open: (String) -> Void
    var onDeleted: (String) -> Void = { _ in }

    static let width: CGFloat = 84

    var body: some View {
        ScrollView(.vertical) {
            // Not lazy: a lazy stack kept a stale tile, and the conversation
            // just left stayed blue. A dozen tiles cost nothing to keep.
            VStack(spacing: 4) {
                ForEach(team.pinnedConversations) { item($0) }
                if !team.pinnedConversations.isEmpty, !team.unpinnedConversations.isEmpty {
                    Capsule()
                        .fill(.secondary.opacity(0.35))
                        .frame(width: 44, height: 2)
                        .padding(.vertical, 6)
                }
                ForEach(team.unpinnedConversations) { item($0) }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 8)
        }
        .scrollIndicators(.never)
        .frame(width: Self.width)
        .frame(maxHeight: .infinity)
        .background(.bar)
    }

    private func item(_ conversation: Conversation) -> some View {
        RailItem(conversation: conversation, team: team, chat: chat, inMemory: inMemory,
                 open: open, onDeleted: onDeleted)
    }
}

/// One avatar in the rail. It watches the conversation on screen itself
/// (not a value handed down), and draws the blue tile only while selected:
/// handed down, the conversation just left could stay blue.
private struct RailItem: View {
    let conversation: Conversation
    @ObservedObject var team: TeamStore
    @ObservedObject var chat: ChatViewModel
    let inMemory: Bool
    let open: (String) -> Void
    let onDeleted: (String) -> Void

    var body: some View {
        let isSelected = !inMemory && chat.currentConversation == conversation.id
        let badge = team.badgeCount(conversation.id)
        let name = team.title(of: conversation.id)
        let role = team.subtitle(of: conversation.id)
        Button { open(conversation.id) } label: {
            VStack(spacing: 4) {
                TeamAvatar(members: team.members(of: conversation.id), size: 44)
                    .overlay(alignment: .topTrailing) {
                        if badge > 0 { ChannelBadgeBubble(count: badge).offset(x: 4, y: -2) }
                    }
                Text(name)
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(isSelected ? Color.white : Color.secondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            .padding(.vertical, 8)
            .padding(.horizontal, 4)
            .frame(maxWidth: .infinity)
            .background {
                if isSelected {
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .fill(JoriTheme.cobalt)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .focusEffectDisabled()
        .transaction { $0.animation = nil }
        .help(role.isEmpty ? name : "\(name) — \(role)")
        .accessibilityLabel(name + (badge > 0 ? ", \(badge) waiting" : "") + (conversation.isPinned ? ", pinned" : ""))
        .accessibilityAddTraits(isSelected ? .isSelected : [])
        .modifier(ConversationDeleteActions(conversation: conversation, team: team, onDeleted: onDeleted, swipes: false))
    }
}

// MARK: - New conversation

/// Start a conversation with one role or a group of several.
struct NewConversationSheet: View {
    @ObservedObject var team: TeamStore
    let onStart: ([String]) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var picked: Set<String> = []

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(team.team) { row($0) }
                }
                if !team.available.isEmpty {
                    Section {
                        ForEach(team.available) { row($0) }
                    } header: {
                        Text("Add to your team")
                    } footer: {
                        Text("Each one takes over its own area.")
                    }
                }
            }
            .navigationTitle(picked.count > 1 ? "New group" : "New conversation")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Start") {
                        onStart(Array(picked))
                        dismiss()
                    }
                    .disabled(picked.isEmpty)
                }
            }
        }
    }

    private func row(_ m: TeamMember) -> some View {
        Button {
            if picked.contains(m.id) { picked.remove(m.id) } else { picked.insert(m.id) }
        } label: {
            HStack(spacing: 12) {
                TeamAvatar(members: [m], size: 34)
                VStack(alignment: .leading, spacing: 1) {
                    Text(m.label).foregroundStyle(.primary)
                    if let r = m.responsibility {
                        Text(r).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                    }
                }
                Spacer()
                Image(systemName: picked.contains(m.id) ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(picked.contains(m.id) ? JoriTheme.cobalt : .secondary)
                    .font(.title3)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Conversation info (people, renames, adding someone)

/// Who is in a conversation. Every role can be renamed here — its name and its
/// role title — and more people can be added.
struct ConversationInfoSheet: View {
    @ObservedObject var team: TeamStore
    let conversationId: String
    let onAdd: ([String]) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var adding = false
    @State private var groupTitle = ""

    var body: some View {
        NavigationStack {
            Form {
                if ConversationID.isGroup(conversationId) {
                    Section("Group name") {
                        TextField("Name this group", text: $groupTitle)
                            .onSubmit { Task { await team.renameConversation(conversationId, to: groupTitle) } }
                    }
                }
                Section {
                    ForEach(team.members(of: conversationId)) { m in
                        RenameRoleRow(member: m, team: team)
                    }
                } header: {
                    Text("People")
                } footer: {
                    Text("Rename anyone, and their role. The new name shows everywhere, including on what they send you.")
                }
                Section {
                    Button { adding = true } label: { Label("Add someone", systemImage: "person.badge.plus") }
                }
            }
            .formStyle(.grouped)
            .navigationTitle(team.title(of: conversationId))
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") {
                        if ConversationID.isGroup(conversationId) {
                            Task { await team.renameConversation(conversationId, to: groupTitle) }
                        }
                        dismiss()
                    }
                }
            }
            .onAppear {
                groupTitle = team.conversations.first(where: { $0.id == conversationId })?.title ?? ""
            }
            .sheet(isPresented: $adding) {
                NewConversationSheet(team: team) { ids in
                    onAdd(ids)
                    dismiss()
                }
            }
        }
    }
}

/// One role, renamable in place: its name and its role title.
struct RenameRoleRow: View {
    let member: TeamMember
    @ObservedObject var team: TeamStore
    @State private var name = ""
    @State private var title = ""

    private var changed: Bool {
        let n = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let t = title.trimmingCharacters(in: .whitespacesAndNewlines)
        return !n.isEmpty && !t.isEmpty && (n != member.name || t != member.title)
    }

    @State private var pick: PhotosPickerItem?

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            // Tap the avatar to give the role a photo; its initials are the default.
            PhotosPicker(selection: $pick, matching: .images) {
                TeamAvatar(members: [member], size: 40)
                    .overlay(alignment: .bottomTrailing) {
                        Image(systemName: "camera.fill")
                            .font(.system(size: 9, weight: .bold))
                            .foregroundStyle(.white)
                            .padding(4)
                            .background(Circle().fill(.black.opacity(0.55)))
                    }
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Change \(member.name)'s photo")
            .contextMenu {
                if member.avatarURL != nil {
                    Button("Use initials instead", role: .destructive) { Task { await team.removePhoto(member.id) } }
                }
            }
            .onChange(of: pick) { _, item in
                guard let item else { return }
                Task {
                    if let data = try? await item.loadTransferable(type: Data.self) { await team.setPhoto(member.id, imageData: data) }
                    pick = nil
                }
            }
            VStack(alignment: .leading, spacing: 4) {
                TextField("Name", text: $name)
                    .font(.headline)
                TextField("Role", text: $title)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            if changed {
                Button("Save") { Task { await team.rename(member.id, name: name, title: title) } }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
            }
        }
        .onAppear { name = member.name; title = member.title }
        .onChange(of: member) { _, m in name = m.name; title = m.title }
    }
}

// MARK: - @mentions

/// The team, filtered by what follows the "@" being typed; tapping one
/// completes the handle.
struct MentionSuggestions: View {
    let members: [TeamMember]
    let onPick: (TeamMember) -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(members) { m in
                    Button { onPick(m) } label: {
                        HStack(spacing: 6) {
                            TeamAvatar(members: [m], size: 22)
                            Text(m.name).font(.subheadline.weight(.semibold))
                            Text(m.title).font(.caption).foregroundStyle(.secondary)
                        }
                        .padding(.horizontal, 10)
                        .padding(.vertical, 6)
                        .glassSurface(in: Capsule(), interactive: true)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 14)
        }
    }

    /// The handle being typed: the text after the last "@" when nothing but
    /// letters follow it. nil when not typing one.
    static func query(in text: String) -> String? {
        guard let at = text.lastIndex(of: "@") else { return nil }
        if at > text.startIndex {
            let before = text[text.index(before: at)]
            guard before == " " || before == "\n" else { return nil }
        }
        let rest = text[text.index(after: at)...]
        guard rest.allSatisfy({ $0.isLetter || $0.isNumber }) else { return nil }
        return String(rest)
    }

    static func matches(_ team: [TeamMember], query: String) -> [TeamMember] {
        let q = query.lowercased()
        return team.filter {
            q.isEmpty || $0.name.lowercased().hasPrefix(q) || $0.title.lowercased().hasPrefix(q)
        }
    }

    /// `text` with the handle being typed replaced by the member's.
    static func complete(_ text: String, with m: TeamMember) -> String {
        guard let at = text.lastIndex(of: "@") else { return text }
        return String(text[..<at]) + "@" + m.name.replacingOccurrences(of: " ", with: "") + " "
    }
}

#if os(macOS)
/// Drops the window title from the toolbar (macOS 15+) so the conversation
/// header stands alone and the window can go narrower. On 14 the title stays.
struct HiddenToolbarTitle: ViewModifier {
    func body(content: Content) -> some View {
        if #available(macOS 15.0, *) {
            content.toolbar(removing: .title)
        } else {
            content
        }
    }
}
#endif


// MARK: - Gate review

struct GateReview: Codable, Equatable, Identifiable {
    let id: UUID
    let message_id: UUID?
    /// "email" for mail to the user (bin/email-send); otherwise the app channel.
    let channel: String?
    let verdict: String
    let reason: String?
    let suggestion: String?
    var grade: String?
    var note: String?
    /// What the role wrote, when the gate judged it live (before delivery).
    let original: String?
    let live: Bool?
    /// Held by the gate: never delivered.
    let held: Bool?
    let judged_at: Date?
    /// The day whose daily summary printed this held message (YYYY-MM-DD).
    let digested_on: String?
    /// When the answer the gate found went back to the role that asked.
    let handed_back_at: Date?

    func graded(_ g: String, note n: String) -> GateReview {
        var c = self; c.grade = g; c.note = n.isEmpty ? nil : n; return c
    }

    var isLive: Bool { live == true }

    /// "Nov 11" from "2026-11-11".
    static func dayLabel(_ ymd: String) -> String? {
        let p = DateFormatter(); p.dateFormat = "yyyy-MM-dd"; p.timeZone = TimeZone(identifier: "UTC")
        guard let d = p.date(from: ymd) else { return nil }
        let f = DateFormatter(); f.dateFormat = "MMM d"; f.timeZone = TimeZone(identifier: "UTC")
        return f.string(from: d)
    }
    var isHeld: Bool { held == true }

    var isEmail: Bool { channel == "email" }

    var verdictText: String {
        if isLive && isEmail {
            switch verdict {
            case "send": return "Email checked, sent as written"
            case "rewrite": return suggestion != nil ? "Email sent; a fix suggested" : "Email rewritten before sending"
            case "resolve": return "Email held: it could answer this itself"
            case "digest":
                if let d = digested_on, let shown = Self.dayLabel(d) { return "Email held, in the daily summary for \(shown)" }
                return "Email held for the daily summary"
            case "drop": return "Email held: not worth sending"
            case "error": return "Email check failed, sent as written"
            default: return "Email checked"
            }
        }
        if isLive {
            switch verdict {
            case "send": return "Checked, sent as written"
            case "rewrite": return "Rewritten before sending"
            case "resolve": return handed_back_at != nil ? "Held: answered itself, passed to the role" : "Held: it could answer this itself"
            case "digest":
                if let d = digested_on, let shown = Self.dayLabel(d) { return "In the daily summary for \(shown)" }
                return "Held for the daily summary"
            case "drop": return "Held: not worth sending"
            case "error": return "Check failed, sent as written"
            default: return "Checked"
            }
        }
        switch verdict {
        case "send": return "Would send as is"
        case "rewrite": return "Would rewrite"
        case "resolve": return "Would answer it itself"
        case "digest": return "Would hold for the daily summary"
        case "drop": return "Would not send"
        default: return "Would send"
        }
    }

    var suggestionLabel: String { verdict == "resolve" ? "What it found" : (isEmail ? "Suggested fix" : "Would have sent instead") }

    /// The original, shown folded: for a rewrite (what was written before the
    /// gate changed it) and for a held message (what was not sent).
    var originalToShow: String? {
        guard isLive, let o = original, !o.isEmpty else { return nil }
        if isEmail { return o }
        return (verdict == "rewrite" || isHeld) ? o : nil
    }
    var originalLabel: String {
        if isEmail { return isHeld ? "The email it held" : (verdict == "rewrite" && suggestion == nil ? "Original email, before the rewrite" : "The email") }
        return isHeld ? "The message it held" : "Original, before the rewrite"
    }
}

/// Under a message: what the gate did (or, in shadow, would have done), why,
/// and two buttons. Tap the line to see the reason, the original (folded until
/// then) and any suggestion. A held message has no bubble: this line stands
/// alone in the conversation.
struct GateReviewLine: View {
    let review: GateReview
    let onGrade: (String, String) -> Void
    @State private var open = false
    @State private var note = ""
    @State private var askingNote = false

    private var tint: Color {
        switch review.verdict {
        case "send": return .green
        case "rewrite": return .orange
        case "resolve": return .blue
        case "digest": return .purple
        case "error": return .gray
        default: return .red
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button { withAnimation(.snappy(duration: 0.2)) { open.toggle() } } label: {
                HStack(spacing: 6) {
                    Circle().fill(tint).frame(width: 7, height: 7)
                    Text("Gate: \(review.verdictText)").font(.caption.weight(.medium))
                    if let g = review.grade {
                        Text(g == "right" ? "· you: right" : "· you: wrong").font(.caption).foregroundStyle(.secondary)
                    }
                    Image(systemName: open ? "chevron.up" : "chevron.down").font(.system(size: 9, weight: .semibold))
                }
                .foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
            if open {
                if let r = review.reason, !r.isEmpty {
                    Text(r).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
                if let o = review.originalToShow {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(review.originalLabel).font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
                        Text(o).font(.caption).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(8)
                    .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 8))
                }
                if let s = review.suggestion, !s.isEmpty {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(review.suggestionLabel).font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
                        Text(s).font(.caption).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(8)
                    .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 8))
                }
                HStack(spacing: 8) {
                    Button("Right call") { onGrade("right", note) }
                        .buttonStyle(.bordered).tint(review.grade == "right" ? .green : nil)
                    Button("Wrong call") { askingNote = true; onGrade("wrong", note) }
                        .buttonStyle(.bordered).tint(review.grade == "wrong" ? .red : nil)
                }
                .controlSize(.small)
                if askingNote || review.grade == "wrong" {
                    TextField("What should it have done?", text: $note)
                        .textFieldStyle(.roundedBorder)
                        .font(.caption)
                        .onSubmit { onGrade(review.grade ?? "wrong", note) }
                }
            }
        }
        .padding(.horizontal, 8)
        .padding(.top, 2)
        .onAppear { note = review.note ?? "" }
    }
}


// MARK: - Pinning and deleting a conversation

/// Swipe (iPhone, iPad) or right-click / long-press: pin a conversation to the
/// top of the list or unpin it (any conversation, the coordinator's too), and
/// delete one, after a confirmation that says what deleting means.
struct ConversationDeleteActions: ViewModifier {
    let conversation: Conversation
    @ObservedObject var team: TeamStore
    var onDeleted: (String) -> Void = { _ in }
    /// Off for a pinned circle: it sits inside the grid's one list row, where
    /// swipe actions would belong to the whole row, not to it.
    var swipes = true
    @State private var confirming = false

    private var deletable: Bool { conversation.id != team.coordinatorConversation }

    private var pinButton: some View {
        let pinned = conversation.isPinned
        return Button {
            Task { await team.setPinned(conversation.id, !pinned) }
        } label: {
            Label(pinned ? "Unpin" : "Pin", systemImage: pinned ? "pin.slash" : "pin")
        }
    }

    func body(content: Content) -> some View {
        content
            #if os(iOS)
            .swipeActions(edge: .leading, allowsFullSwipe: true) {
                if swipes { pinButton.tint(.orange) }
            }
            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                if swipes && deletable {
                    Button(role: .destructive) { confirming = true } label: { Label("Delete", systemImage: "trash") }
                }
            }
            #endif
            .contextMenu {
                pinButton
                if deletable {
                    Divider()
                    Button(role: .destructive) { confirming = true } label: { Label("Delete conversation", systemImage: "trash") }
                }
            }
            .confirmationDialog(conversation.isGroup ? "Delete this group?" : "Delete this conversation?",
                                isPresented: $confirming, titleVisibility: .visible) {
                Button("Delete", role: .destructive) {
                    Task { await team.deleteConversation(conversation.id); onDeleted(conversation.id) }
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text(conversation.isGroup
                     ? "The group leaves your list. Jori keeps its messages in its memory."
                     : "It leaves your list until \(team.title(of: conversation.id)) next writes to you. Jori keeps the messages in its memory.")
            }
    }
}
