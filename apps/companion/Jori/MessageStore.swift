import Foundation
import SwiftData

@Model
final class CachedMessage {
    @Attribute(.unique) var id: UUID
    var role: String
    var content: String
    var read: Bool
    var createdAt: Date
    var reaction: String?
    // Optional so SwiftData can lightweight-migrate existing stores. nil rows
    // were inserted before channels existed; treat them as 'chat' on read.
    var channel: String?
    // Also optional for lightweight migration — rows cached before threaded
    // replies existed simply have no parent.
    var replyTo: UUID?
    // Optional for lightweight migration. The row's metadata as a JSON object
    // string, so a cached question keeps its colour and a cached choice card
    // keeps its buttons before the network fetch lands (2026-10-17).
    var metadataJSON: String?
    // Optional for lightweight migration (2026-11-10): the row's conversation and
    // the team role that wrote it. Rows cached before then derive the
    // conversation from their channel.
    var conversationId: String?
    var sender: String?

    init(id: UUID, role: String, content: String, read: Bool, createdAt: Date,
         reaction: String? = nil, channel: String? = ChatChannel.chat.rawValue,
         replyTo: UUID? = nil, metadataJSON: String? = nil,
         conversationId: String? = nil, sender: String? = nil) {
        self.id = id
        self.role = role
        self.content = content
        self.read = read
        self.createdAt = createdAt
        self.reaction = reaction
        self.channel = channel
        self.replyTo = replyTo
        self.metadataJSON = metadataJSON
        self.conversationId = conversationId
        self.sender = sender
    }

    /// The conversation this row belongs to, for rows cached before conversations.
    var conversation: String {
        conversationId ?? ConversationID.legacy(channel: channel ?? ChatChannel.chat.rawValue)
    }

    static func encode(_ metadata: [String: String]?) -> String? {
        guard let metadata, !metadata.isEmpty,
              let data = try? JSONEncoder().encode(metadata) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func decode(_ json: String?) -> [String: String]? {
        guard let data = json?.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode([String: String].self, from: data)
    }

    convenience init(from message: Message) {
        self.init(id: message.id,
                  role: message.role,
                  content: message.content,
                  read: message.read,
                  createdAt: message.createdAt,
                  reaction: message.reaction?.rawValue,
                  channel: message.channel,
                  replyTo: message.replyTo,
                  metadataJSON: Self.encode(message.metadata),
                  conversationId: message.conversationId,
                  sender: message.sender)
    }

    /// Copy the message's fields onto this row. Writes only the fields that
    /// differ and returns whether any did: assigning an unchanged value still
    /// dirties a SwiftData row, and the 30 s catch-up used to rewrite all 500
    /// cached rows to disk every time (MetricKit disk-write reports, and a
    /// ~0.5 s main-thread hang every ~35 s on the Mac, 2026-11-21).
    @discardableResult
    func apply(_ message: Message) -> Bool {
        var changed = false
        func set<T: Equatable>(_ path: ReferenceWritableKeyPath<CachedMessage, T>, _ value: T) {
            if self[keyPath: path] != value { self[keyPath: path] = value; changed = true }
        }
        set(\.role, message.role)
        set(\.content, message.content)
        set(\.read, message.read)
        set(\.createdAt, message.createdAt)
        set(\.reaction, message.reaction?.rawValue)
        set(\.channel, Optional(message.channel))
        set(\.replyTo, message.replyTo)
        // Compare decoded, not encoded: dictionary key order makes the JSON
        // text of equal metadata differ from encode to encode.
        if Self.decode(metadataJSON) != message.metadata {
            metadataJSON = Self.encode(message.metadata); changed = true
        }
        set(\.conversationId, Optional(message.conversationId))
        set(\.sender, message.sender)
        return changed
    }

    var asMessage: Message {
        Message(id: id, role: role, content: content, read: read, createdAt: createdAt,
                reaction: reaction.flatMap { Reaction(rawValue: $0) },
                channel: channel ?? ChatChannel.chat.rawValue,
                replyTo: replyTo,
                metadata: Self.decode(metadataJSON),
                conversationId: conversation,
                sender: sender)
    }
}

@MainActor
final class MessageStore {
    static let shared = MessageStore()

    private static let perRowOverheadBytes = 200
    private static let budgetBytes = 5 * 1024 * 1024

    private let container: ModelContainer
    private var context: ModelContext { container.mainContext }
    private var runningBytes: Int = 0
    private var runningBytesSeeded = false

    private init() {
        let schema = Schema([CachedMessage.self])
        let fm = FileManager.default
        let dir = (try? fm.url(for: .applicationSupportDirectory,
                               in: .userDomainMask,
                               appropriateFor: nil,
                               create: true)) ?? fm.temporaryDirectory
        let storeURL = dir.appendingPathComponent("\(Install.storagePrefix)_messages.store")
        let config = ModelConfiguration(schema: schema, url: storeURL)
        if let c = try? ModelContainer(for: schema, configurations: config) {
            self.container = c
        } else {
            let fallback = ModelConfiguration(schema: schema, isStoredInMemoryOnly: true)
            self.container = try! ModelContainer(for: schema, configurations: fallback)
        }
        // runningBytes is seeded by the first loadAll() — ChatViewModel.init
        // always calls it during cold start, so we avoid a duplicate fetch.
    }

    /// Synchronous load, oldest → newest, scoped to a single conversation.
    /// Also seeds `runningBytes` from the full table so cold start only hits
    /// SwiftData once.
    func loadAll(conversation: String = ConversationID.coordinator) -> [Message] {
        let descriptor = FetchDescriptor<CachedMessage>(
            sortBy: [SortDescriptor(\.createdAt, order: .forward)]
        )
        guard let rows = try? context.fetch(descriptor) else {
            runningBytes = 0
            return []
        }
        if !runningBytesSeeded {
            runningBytes = rows.reduce(0) { $0 + cost(for: $1.content) }
            runningBytesSeeded = true
        }
        return rows
            .filter { $0.conversation == conversation }
            .map(\.asMessage)
    }

    /// Whether anything is cached for this conversation. A count query with
    /// limit 1 — `loadAll` would fault in and decode every cached row, and
    /// the catch-up timer asked this every 30 s on the main thread.
    /// Rows cached before conversation ids existed (2026-11-10) don't count;
    /// for those the next fetch is just the fresh-install one.
    func hasRows(conversation: String) -> Bool {
        let target = conversation
        var descriptor = FetchDescriptor<CachedMessage>(
            predicate: #Predicate { $0.conversationId == target }
        )
        descriptor.fetchLimit = 1
        return ((try? context.fetchCount(descriptor)) ?? 0) > 0
    }

    /// Full reconciliation against a fresh server response, scoped to one
    /// conversation. Rows in other conversations are left untouched so
    /// switching back doesn't re-fetch from scratch.
    func sync(with freshMessages: [Message], conversation: String) {
        let freshIds = Set(freshMessages.map(\.id))
        if !runningBytesSeeded {
            let all = (try? context.fetch(FetchDescriptor<CachedMessage>())) ?? []
            runningBytes = all.reduce(0) { $0 + cost(for: $1.content) }
            runningBytesSeeded = true
        }
        // Only this conversation's rows (and pre-conversation rows, which may
        // belong to it), not the whole cache: this runs every 30 s on the
        // main thread, and faulting in every cached row was most of its cost.
        let target = conversation
        let descriptor = FetchDescriptor<CachedMessage>(
            predicate: #Predicate { $0.conversationId == target || $0.conversationId == nil }
        )
        guard let cached = try? context.fetch(descriptor) else { return }

        var existingById: [UUID: CachedMessage] = [:]
        var changed = false
        for row in cached {
            if row.conversation != conversation { continue }   // out of scope
            if freshIds.contains(row.id) {
                existingById[row.id] = row
            } else {
                runningBytes -= cost(for: row.content)
                context.delete(row)
                changed = true
            }
        }

        for msg in freshMessages {
            if let existing = existingById[msg.id] {
                let before = cost(for: existing.content)
                if existing.apply(msg) {
                    runningBytes += cost(for: existing.content) - before
                    changed = true
                }
            } else {
                context.insert(CachedMessage(from: msg))
                runningBytes += cost(for: msg.content)
                changed = true
            }
        }

        // Nothing new (the usual catch-up): no save, no disk write.
        guard changed else { return }
        try? context.save()
        if runningBytes > Self.budgetBytes {
            evictOverBudget()
        }
    }

    /// Insert or update a single message (realtime + optimistic send).
    func upsert(_ message: Message) {
        if let existing = row(id: message.id) {
            runningBytes -= cost(for: existing.content)
            existing.apply(message)
            runningBytes += cost(for: existing.content)
        } else {
            context.insert(CachedMessage(from: message))
            runningBytes += cost(for: message.content)
        }
        try? context.save()
        if runningBytes > Self.budgetBytes {
            evictOverBudget()
        }
    }

    /// Single-row lookup — used to resolve a quoted reply parent that has
    /// already scrolled out of the loaded window.
    func message(id: UUID) -> Message? {
        row(id: id)?.asMessage
    }

    /// Drop every cached message (the app was unpaired from its Jori).
    func deleteAll() {
        try? context.delete(model: CachedMessage.self)
        try? context.save()
        runningBytes = 0
    }

    func delete(id: UUID) {
        guard let target = row(id: id) else { return }
        runningBytes -= cost(for: target.content)
        context.delete(target)
        try? context.save()
    }

    private func row(id: UUID) -> CachedMessage? {
        let targetId = id
        var descriptor = FetchDescriptor<CachedMessage>(
            predicate: #Predicate { $0.id == targetId }
        )
        descriptor.fetchLimit = 1
        return try? context.fetch(descriptor).first
    }

    private func cost(for content: String) -> Int {
        Self.perRowOverheadBytes + content.utf8.count
    }

    /// Walk newest → oldest and evict anything past the budget.
    /// Only invoked when `runningBytes` has already crossed the limit.
    private func evictOverBudget() {
        let descriptor = FetchDescriptor<CachedMessage>(
            sortBy: [SortDescriptor(\.createdAt, order: .reverse)]
        )
        guard let rows = try? context.fetch(descriptor) else { return }

        var keep = 0
        for row in rows {
            let c = cost(for: row.content)
            if keep + c > Self.budgetBytes {
                runningBytes -= c
                context.delete(row)
            } else {
                keep += c
            }
        }
        try? context.save()
    }
}
