//
//  PickupRules.swift
//  Jori
//
//  The rules for "did my message get through?", kept free of SwiftUI and
//  Supabase so they can be checked on their own (tests/companion-pickup-rules
//  compiles this file with a small driver; no Xcode needed).
//
//  Why this exists: on 2026-10-28/29 the phone link on the host crashed on
//  start and chat could not receive app messages for 17 hours. Nothing on the
//  host noticed, because the thing that would have noticed was the thing that
//  was down. So the app watches for itself: once the user sends a message, it
//  expects a sign that the message was picked up within 10 minutes, and says
//  so calmly when none arrives. It never needs the host to send anything.
//
//  Every signal is structure the host writes, never the text of a message:
//   1. a picked-up stamp on the user's own row (a `picked_up_at` or
//      `handled_at` column, or the same key in its metadata), once the phone
//      link writes one;
//   2. an assistant row that replies to it (`reply_to` = its id: the
//      choice-tap fast path answers that way);
//   3. the phone link's "working" placeholder (`metadata.is_ack = "1"`) in the
//      same channel after it;
//   4. until the stamp column exists, any assistant row in the same channel
//      after it. That is weaker (a scheduled ping posted while the link is
//      down would count), which is why it stops counting once the app has
//      seen the stamp column on a row: from then on, 1–3 decide.
//

import Foundation

/// A message this device sent and is waiting to see picked up.
struct PickupEntry: Codable, Equatable {
    let id: UUID
    let channel: String
    /// The row's server `created_at`, so it compares on the same clock as
    /// every row that might answer it.
    let sentAt: Date
}

/// The fields of a message row the rules read. Built from a decoded `Message`
/// or a raw realtime/REST record; `stampColumnPresent` is only knowable from a
/// raw record (the typed select list cannot name a column that may not exist).
struct PickupRow: Equatable {
    let id: UUID
    let role: String
    let channel: String
    let createdAt: Date
    var replyTo: UUID? = nil
    var isAck: Bool = false
    /// The row carries a non-null picked-up stamp.
    var stamped: Bool = false
    /// The stamp column exists on the table (present in the record, even null).
    var stampColumnPresent: Bool = false
}

enum PickupRules {
    /// How long a message may wait for a sign of life before the app says so.
    static let deadline: TimeInterval = 10 * 60
    /// Stop watching a message after this long: by then the user knows, and a
    /// days-old "not picked up" line is noise.
    static let forgetAfter: TimeInterval = 48 * 3600
    /// Extra time the OS-scheduled notification waits past the deadline, so
    /// the in-app check (which can cancel it) always runs first while the app
    /// is alive.
    static let notificationGrace: TimeInterval = 20

    /// Names the host may use for the picked-up stamp, as a column or as a
    /// metadata key. Structure, not language.
    static let stampKeys = ["picked_up_at", "handled_at"]

    static func isAckMetadata(_ metadata: [String: String]?) -> Bool {
        metadata?["is_ack"] == "1"
    }

    static func hasStamp(_ metadata: [String: String]?) -> Bool {
        guard let metadata else { return false }
        return stampKeys.contains { !(metadata[$0] ?? "").isEmpty }
    }

    /// Whether `row` shows that `entry` was picked up.
    /// - Parameter stampSupported: the app has seen the stamp column on a row,
    ///   so a plain later assistant row no longer counts on its own.
    static func pickedUp(_ entry: PickupEntry, by row: PickupRow, stampSupported: Bool) -> Bool {
        if row.role == "user" {
            guard row.stamped else { return false }
            if row.id == entry.id { return true }
            // The phone link takes messages in created_at order, so a later
            // message picked up in the same channel means this one was too.
            return row.channel == entry.channel && row.createdAt >= entry.sentAt
        }
        guard row.role == "assistant", row.channel == entry.channel else { return false }
        if row.replyTo == entry.id { return true }
        guard row.createdAt > entry.sentAt else { return false }
        if row.isAck { return true }
        return !stampSupported
    }

    static func isOverdue(_ entry: PickupEntry, now: Date) -> Bool {
        let age = now.timeIntervalSince(entry.sentAt)
        return age >= deadline && age < forgetAfter
    }

    static func isExpired(_ entry: PickupEntry, now: Date) -> Bool {
        now.timeIntervalSince(entry.sentAt) >= forgetAfter
    }

    /// The messages that show the status line: in each channel, only the
    /// newest overdue one. Several unanswered messages in a row are one
    /// problem, and one calm line says it.
    static func flagged(_ entries: [PickupEntry], now: Date) -> Set<UUID> {
        var newest: [String: PickupEntry] = [:]
        for e in entries where isOverdue(e, now: now) {
            if let seen = newest[e.channel], seen.sentAt >= e.sentAt { continue }
            newest[e.channel] = e
        }
        return Set(newest.values.map(\.id))
    }

    /// When the in-app check should next wake up: the soonest deadline still
    /// ahead, or nil when nothing is waiting.
    static func nextWake(_ entries: [PickupEntry], now: Date) -> Date? {
        entries.map { $0.sentAt.addingTimeInterval(deadline) }
            .filter { $0 > now }
            .min()
    }

    /// The entries `rows` answer, given the rules above.
    static func cleared(_ entries: [PickupEntry], by rows: [PickupRow], stampSupported: Bool) -> Set<UUID> {
        var out = Set<UUID>()
        for e in entries where rows.contains(where: { pickedUp(e, by: $0, stampSupported: stampSupported) }) {
            out.insert(e.id)
        }
        return out
    }
}
