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
//  conversations: System is IT & Security's, Improvements the software
//  engineer's, and a question lives with the role that asked it.
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

    enum CodingKeys: String, CodingKey {
        case id, name, title, responsibility, enabled, sort
        case chiefOfStaff = "chief_of_staff"
    }

    /// "Ada · CFO": a name always travels with its role.
    var label: String { "\(name) · \(title)" }

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

    enum CodingKeys: String, CodingKey {
        case id, kind, title, members, archived
        case lastMessageAt = "last_message_at"
    }

    var isGroup: Bool { kind == "group" }
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
        return team.first { $0.id == id }
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

    /// The conversations the list shows, newest first. The coordinator is
    /// always there, even before its first row exists.
    var visibleConversations: [Conversation] {
        var list = conversations.filter { !$0.archived }
        let coord = coordinatorConversation
        if !list.contains(where: { $0.id == coord }) {
            list.append(Conversation(id: coord, kind: "role", title: nil,
                                     members: [ConversationID.roleId(coord) ?? "chief-of-staff"],
                                     lastMessageAt: nil, archived: false))
        }
        return list.sorted { a, b in
            let da = summaries[a.id]?.previewAt ?? a.lastMessageAt ?? .distantPast
            let db = summaries[b.id]?.previewAt ?? b.lastMessageAt ?? .distantPast
            return da > db
        }
    }

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
        await channel.subscribe()
        realtimeChannel = channel
        await withTaskGroup(of: Void.self) { group in
            group.addTask { @MainActor [weak self] in
                for await _ in team { await self?.loadTeam() }
            }
            group.addTask { @MainActor [weak self] in
                for await _ in conversations { await self?.loadConversations() }
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
                .select("id,name,title,responsibility,chief_of_staff,enabled,sort")
                .eq("enabled", value: true)
                .order("sort", ascending: true)
                .execute()
                .value
            if rows != team { team = rows }
        } catch {
            print("[Team] team load failed: \(error)")
        }
    }

    func loadConversations() async {
        do {
            try await SupabaseManager.ensureAuthenticated()
            let rows: [Conversation] = try await SupabaseManager.shared
                .from(Self.conversationsTable)
                .select("id,kind,title,members,last_message_at,archived")
                .execute()
                .value
            if rows != conversations { conversations = rows }
        } catch {
            print("[Team] conversations load failed: \(error)")
        }
    }

    // MARK: Gate reviews (shadow week, system/speak-gate.md)

    /// The think-before-you-speak gate's verdict on each message, judged in
    /// shadow (nothing is held), shown under the message for the user to grade.
    @Published var gateReviews: [UUID: GateReview] = [:]
    static let gateReviewsTable = "jori_gate_reviews"

    func loadGateReviews(_ conversationId: String) async {
        guard !conversationId.isEmpty else { return }
        do {
            try await SupabaseManager.ensureAuthenticated()
            let rows: [GateReview] = try await SupabaseManager.shared
                .from(Self.gateReviewsTable)
                .select("message_id,verdict,reason,suggestion,grade,note")
                .eq("conversation_id", value: conversationId)
                .order("judged_at", ascending: false)
                .limit(300)
                .execute()
                .value
            var next = gateReviews
            for r in rows { next[r.message_id] = r }
            if next != gateReviews { gateReviews = next }
        } catch {
            print("[Team] gate reviews load failed: \(error)")
        }
    }

    /// The user's grade on one verdict: "right" or "wrong", with an optional note.
    func gradeGate(_ messageId: UUID, grade: String, note: String) async {
        if let r = gateReviews[messageId] { gateReviews[messageId] = r.graded(grade, note: note) }
        struct Patch: Encodable { let grade: String; let note: String?; let graded_at: String }
        do {
            try await SupabaseManager.ensureAuthenticated()
            try await SupabaseManager.shared
                .from(Self.gateReviewsTable)
                .update(Patch(grade: grade, note: note.isEmpty ? nil : note, graded_at: Date().ISO8601Format()))
                .eq("message_id", value: messageId.uuidString)
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

    private struct ConversationRow: Encodable {
        let id: String
        let kind: String
        let title: String?
        let members: [String]
        let created_by: String
    }

    /// The conversation with exactly these roles: the role's own for one, a new
    /// group for several (an existing group with the same people is reused).
    func conversation(with roleIds: [String]) async -> String? {
        let ids = Array(Set(roleIds)).sorted()
        guard !ids.isEmpty else { return nil }
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

    private func circle(_ m: TeamMember, size: CGFloat) -> some View {
        Text(m.initials)
            .font(.system(size: size * 0.38, weight: .semibold, design: .rounded))
            .foregroundStyle(.white)
            .frame(width: size, height: size)
            .background(Circle().fill(m.tint.gradient))
            .overlay(Circle().strokeBorder(.white.opacity(0.6), lineWidth: members.count > 1 ? 1.5 : 0))
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

// MARK: - New conversation

/// Start a conversation with one role or a group of several.
struct NewConversationSheet: View {
    @ObservedObject var team: TeamStore
    let onStart: ([String]) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var picked: Set<String> = []

    var body: some View {
        NavigationStack {
            List(team.team) { m in
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

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            TeamAvatar(members: [member], size: 34)
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


// MARK: - Gate review (shadow week)

struct GateReview: Codable, Equatable {
    let message_id: UUID
    let verdict: String
    let reason: String?
    let suggestion: String?
    var grade: String?
    var note: String?

    func graded(_ g: String, note n: String) -> GateReview {
        var c = self; c.grade = g; c.note = n.isEmpty ? nil : n; return c
    }

    var verdictText: String {
        switch verdict {
        case "send": return "Would send as is"
        case "rewrite": return "Would rewrite"
        case "resolve": return "Would answer it itself"
        case "digest": return "Would hold for the daily summary"
        case "drop": return "Would not send"
        default: return "Would send"
        }
    }

    var suggestionLabel: String { verdict == "resolve" ? "What it found / would do" : "Would have sent instead" }
}

/// Under a message: what the gate would have done, why, and two buttons. Tap
/// the line to see the reason and its suggested text.
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
