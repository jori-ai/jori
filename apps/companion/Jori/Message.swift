import Foundation

enum Reaction: String, Codable, CaseIterable {
    case heart
    case thumbsUp = "thumbs_up"
    case thumbsDown = "thumbs_down"

    var emoji: String {
        switch self {
        case .heart: return "❤️"
        case .thumbsUp: return "👍"
        case .thumbsDown: return "👎"
        }
    }

    var label: String {
        switch self {
        case .heart: return "Great"
        case .thumbsUp: return "Useful"
        case .thumbsDown: return "Not Useful"
        }
    }
}

struct Message: Identifiable, Codable, Equatable {
    let id: UUID
    let role: String
    let content: String
    let read: Bool
    let createdAt: Date
    let reaction: Reaction?
    let channel: String
    /// iMessage-style threaded reply: the message this one answers. Set when
    /// the user replies to a specific bubble instead of the newest one — several
    /// Jori pings stack up while they're driving, and a bare reply would
    /// otherwise be read against the wrong message.
    let replyTo: UUID?
    /// Structured extras riding alongside the text — today a `ChoicePrompt`
    /// under `choices`. The read model never decoded this, so the client was
    /// blind to anything the server attached; the column has existed all along.
    /// Kept as `[String: String]` (values are JSON strings) so a new payload
    /// type needs no model change here.
    let metadata: [String: String]?

    enum CodingKeys: String, CodingKey {
        case id
        case role
        case content
        case read
        case createdAt = "created_at"
        case reaction
        case channel
        case replyTo = "reply_to"
        case metadata
    }

    init(id: UUID, role: String, content: String, read: Bool, createdAt: Date,
         reaction: Reaction?, channel: String = ChatChannel.chat.rawValue,
         replyTo: UUID? = nil, metadata: [String: String]? = nil) {
        self.id = id
        self.role = role
        self.content = content
        self.read = read
        self.createdAt = createdAt
        self.reaction = reaction
        self.channel = channel
        self.replyTo = replyTo
        self.metadata = metadata
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.id = try c.decode(UUID.self, forKey: .id)
        self.role = try c.decode(String.self, forKey: .role)
        self.content = try c.decode(String.self, forKey: .content)
        self.read = try c.decode(Bool.self, forKey: .read)
        self.createdAt = try c.decode(Date.self, forKey: .createdAt)
        self.reaction = try c.decodeIfPresent(Reaction.self, forKey: .reaction)
        // Server defaults this to 'chat'; tolerate older rows that omit it.
        self.channel = (try c.decodeIfPresent(String.self, forKey: .channel)) ?? ChatChannel.chat.rawValue
        self.replyTo = try c.decodeIfPresent(UUID.self, forKey: .replyTo)
        // LENIENT ON PURPOSE. `metadata` is jsonb and years of rows have put
        // numbers, booleans and nested objects in it; a strict
        // `[String: String]` decode would throw on the first of those and take
        // the ENTIRE message down with it — one odd historical row would blank
        // the chat. `try?` degrades to "no metadata", which costs at most a
        // choice prompt that fails to render as buttons while its text still
        // reads fine.
        self.metadata = (try? c.decodeIfPresent([String: String].self, forKey: .metadata)) ?? nil
    }

    var isUser: Bool { role == "user" }
    var isAssistant: Bool { role == "assistant" }

    func with(reaction: Reaction?) -> Message {
        Message(id: id, role: role, content: content, read: read, createdAt: createdAt,
                reaction: reaction, channel: channel, replyTo: replyTo,
                metadata: metadata)
    }
}

struct InsertMessage: Codable {
    let role: String
    let content: String
    let read: Bool
    let channel: String
    var metadata: [String: String]?
    var userId: UUID?
    var replyTo: UUID?

    enum CodingKeys: String, CodingKey {
        case role
        case content
        case read
        case channel
        case metadata
        case userId = "user_id"
        case replyTo = "reply_to"
    }
}

/// Channels the Jori app surfaces in the top-bar menu.
/// `chat` is the conversational stream the user reads day-to-day; `questions`
/// holds the non-urgent questions Jori asks (urgent ones stay in chat), written
/// without a push so they can be answered when convenient; `system` carries
/// Jori's own health/watchdog/supervisor alerts so they never pollute chat.
enum ChatChannel: String, CaseIterable, Identifiable {
    case chat
    case questions
    case system
    case improvements

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .chat: return "Chat"
        case .questions: return "Questions"
        case .system: return "System"
        case .improvements: return "Improvements"
        }
    }

    var symbol: String {
        switch self {
        case .chat: return "bubble.left.and.bubble.right"
        case .questions: return "questionmark.bubble"
        case .system: return "gearshape"
        case .improvements: return "wand.and.stars"
        }
    }
}
