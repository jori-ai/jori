//
//  PickupWatch.swift
//  Jori
//
//  Notices, on the phone itself, when a message the user sent has not been
//  picked up: after 10 minutes with no sign of it, the bubble gets a calm
//  status line and, if the app is not in front, a local notification says so.
//  The rules (what counts as a sign) are in PickupRules.swift; this file is
//  the timers, the storage and the notification.
//
//  Battery: no polling. One sleeping Task wakes at the soonest deadline, and
//  the check runs again when the app comes to the front and a few seconds
//  after it goes to the back (long enough for the host's "working"
//  placeholder to land). Each check is at most two small REST reads, and only
//  while something is waiting.
//
//  The notification is scheduled with the OS at send time, because a
//  suspended app cannot wake itself at the deadline. It is cancelled the
//  moment a sign arrives while the app is running, or by the check that runs
//  just after the app is backgrounded.
//

import Foundation
import Supabase
import UserNotifications

#if os(macOS)
import AppKit
#else
import UIKit
#endif

@MainActor
final class PickupWatch {
    /// The messages that should show the status line right now.
    private(set) var flagged: Set<UUID> = []
    /// Told whenever `flagged` changes.
    var onChange: ((Set<UUID>) -> Void)?

    private var entries: [PickupEntry] = []
    /// The table has the picked-up stamp column (seen on a row), so a plain
    /// later assistant row stops counting as proof (PickupRules § 4).
    private var stampSupported: Bool
    private var wakeTask: Task<Void, Never>?
    private var checking = false

    private let supabase: SupabaseClient
    private static let entriesKey = Install.key("pickupWatch.entries")
    private static let stampKey = Install.key("pickupWatch.stampSupported")
    private static let notificationPrefix = "pickup-watch-"

    init(supabase: SupabaseClient) {
        self.supabase = supabase
        self.stampSupported = UserDefaults.standard.bool(forKey: Self.stampKey)
        if let data = UserDefaults.standard.data(forKey: Self.entriesKey),
           let saved = try? JSONDecoder().decode([PickupEntry].self, from: data) {
            self.entries = saved
        }
        refresh()
    }

    // MARK: - Inputs

    /// A message the user just sent from this device.
    func track(_ message: Message) {
        guard message.isUser, !entries.contains(where: { $0.id == message.id }) else { return }
        let entry = PickupEntry(id: message.id, channel: message.channel, sentAt: message.createdAt)
        // One notification per burst: the newest message speaks for the ones
        // before it in the same channel.
        let superseded = entries.filter { $0.channel == entry.channel }.map(\.id)
        removeNotifications(for: superseded, delivered: false)
        entries.append(entry)
        scheduleNotification(for: entry)
        refresh()
    }

    /// Rows the app already decoded (a fetch or a realtime event).
    func observe(_ messages: [Message]) {
        guard !entries.isEmpty else { return }
        apply(messages.map(Self.row(from:)))
    }

    /// A raw realtime record: the only place the stamp column can be seen
    /// before the typed select list knows about it.
    func observe(record: JSONObject, columns: [String]) {
        guard !entries.isEmpty || !stampSupported else { return }
        guard let row = Self.row(from: record, columns: columns) else { return }
        apply([row])
    }

    /// Re-check with the server. Called on foreground, at each deadline, and
    /// shortly after the app is backgrounded.
    func check() async {
        expire()
        guard !entries.isEmpty, !checking else { refresh(); return }
        checking = true
        defer { checking = false }
        do {
            try await SupabaseManager.ensureAuthenticated()
            var rows: [PickupRow] = []
            // The user's own rows, every column: the stamp column may or may
            // not exist yet, and naming it in a select would fail the whole
            // read while it doesn't. Only the few rows still waiting.
            let ids = entries.map { $0.id.uuidString }
            let own: [JSONObject] = try await supabase
                .from(DBTables.messages)
                .select("*")
                .in("id", values: ids)
                .execute()
                .value
            rows += own.compactMap { Self.row(from: $0, columns: Array($0.keys)) }
            // Assistant rows after the oldest waiting message, in each channel.
            for channel in Set(entries.map(\.channel)) {
                guard let oldest = entries.filter({ $0.channel == channel }).map(\.sentAt).min() else { continue }
                let after: [Message] = try await supabase
                    .from(DBTables.messages)
                    .select(Message.columns)
                    .eq("channel", value: channel)
                    .eq("role", value: "assistant")
                    .gt("created_at", value: ISO8601DateFormatter().string(from: oldest.addingTimeInterval(-1)))
                    .order("created_at", ascending: true)
                    .limit(20)
                    .execute()
                    .value
                rows += after.map(Self.row(from:))
            }
            apply(rows)
        } catch {
            // Offline or signed out: say nothing new. The deadline still
            // decides on its own, which is the point — no answer from the
            // server is not a sign that the message was picked up.
            print("[PickupWatch] check failed: \(error.localizedDescription)")
            refresh()
        }
    }

    /// The app went to the back: give the host's placeholder a moment to
    /// land, then check, so a message that was picked up does not leave its
    /// OS notification armed.
    func appDidEnterBackground() {
        guard !entries.isEmpty else { return }
        #if os(iOS)
        endBackgroundTask()
        backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "pickup-watch") { [weak self] in
            self?.endBackgroundTask()
        }
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(4))
            await self?.check()
            self?.endBackgroundTask()
        }
        #else
        Task { await check() }
        #endif
    }

    #if os(iOS)
    private var backgroundTask = UIBackgroundTaskIdentifier.invalid

    private func endBackgroundTask() {
        guard backgroundTask != .invalid else { return }
        UIApplication.shared.endBackgroundTask(backgroundTask)
        backgroundTask = .invalid
    }
    #endif

    // MARK: - State

    private func apply(_ rows: [PickupRow]) {
        if !stampSupported, rows.contains(where: \.stampColumnPresent) {
            stampSupported = true
            UserDefaults.standard.set(true, forKey: Self.stampKey)
        }
        let done = PickupRules.cleared(entries, by: rows, stampSupported: stampSupported)
        if !done.isEmpty {
            entries.removeAll { done.contains($0.id) }
            removeNotifications(for: Array(done), delivered: true)
        }
        refresh()
    }

    private func expire() {
        let now = Date()
        let old = entries.filter { PickupRules.isExpired($0, now: now) }.map(\.id)
        guard !old.isEmpty else { return }
        entries.removeAll { old.contains($0.id) }
        removeNotifications(for: old, delivered: false)
    }

    /// Persist, recompute what is flagged, and re-arm the wake-up.
    private func refresh() {
        expire()
        if let data = try? JSONEncoder().encode(entries) {
            UserDefaults.standard.set(data, forKey: Self.entriesKey)
        }
        let now = Date()
        let next = PickupRules.flagged(entries, now: now)
        if next != flagged {
            flagged = next
            onChange?(next)
        }
        // On screen, the status line says it; an OS banner on top would be
        // the same news twice.
        if !next.isEmpty, Self.appIsActive {
            removeNotifications(for: Array(next), delivered: false)
        }
        wakeTask?.cancel()
        wakeTask = nil
        if let wake = PickupRules.nextWake(entries, now: now) {
            wakeTask = Task { [weak self] in
                try? await Task.sleep(for: .seconds(max(1, wake.timeIntervalSinceNow + 1)))
                guard !Task.isCancelled else { return }
                await self?.check()
            }
        }
    }

    // MARK: - Notification

    private func scheduleNotification(for entry: PickupEntry) {
        let content = UNMutableNotificationContent()
        content.title = "Not picked up yet"
        content.body = "Your message hasn't been picked up in 10 minutes. \(Install.displayName) may be down."
        // message_id deep-links to the bubble, like any Jori notification.
        content.userInfo = ["message_id": entry.id.uuidString, "kind": "pickup_watch"]
        content.sound = .default
        let fireIn = entry.sentAt.addingTimeInterval(PickupRules.deadline + PickupRules.notificationGrace)
            .timeIntervalSinceNow
        guard fireIn > 1 else { return }
        let trigger = UNTimeIntervalNotificationTrigger(timeInterval: fireIn, repeats: false)
        let request = UNNotificationRequest(identifier: Self.notificationPrefix + entry.id.uuidString,
                                            content: content, trigger: trigger)
        UNUserNotificationCenter.current().add(request) { error in
            if let error { print("[PickupWatch] schedule failed: \(error.localizedDescription)") }
        }
    }

    private func removeNotifications(for ids: [UUID], delivered: Bool) {
        guard !ids.isEmpty else { return }
        let names = ids.map { Self.notificationPrefix + $0.uuidString }
        let center = UNUserNotificationCenter.current()
        center.removePendingNotificationRequests(withIdentifiers: names)
        // A delivered "may be down" banner is wrong once the message has been
        // picked up, so it goes too.
        if delivered { center.removeDeliveredNotifications(withIdentifiers: names) }
    }

    private static var appIsActive: Bool {
        #if os(macOS)
        return NSApplication.shared.isActive
        #else
        return UIApplication.shared.applicationState == .active
        #endif
    }

    // MARK: - Rows

    private static func row(from m: Message) -> PickupRow {
        PickupRow(id: m.id, role: m.role, channel: m.channel, createdAt: m.createdAt,
                  replyTo: m.replyTo,
                  isAck: PickupRules.isAckMetadata(m.metadata),
                  stamped: PickupRules.hasStamp(m.metadata))
    }

    private static func row(from record: JSONObject, columns: [String]) -> PickupRow? {
        guard let id = record["id"]?.stringValue.flatMap(UUID.init(uuidString:)),
              let role = record["role"]?.stringValue,
              let created = record["created_at"]?.stringValue.flatMap(parseDate) else { return nil }
        var meta: [String: String] = [:]
        for (k, v) in record["metadata"]?.objectValue ?? [:] {
            if let s = v.stringValue { meta[k] = s }
        }
        let columnStamped = PickupRules.stampKeys.contains { key in
            guard let v = record[key] else { return false }
            return !v.isNil
        }
        return PickupRow(
            id: id, role: role,
            channel: record["channel"]?.stringValue ?? ChatChannel.chat.rawValue,
            createdAt: created,
            replyTo: record["reply_to"]?.stringValue.flatMap(UUID.init(uuidString:)),
            isAck: PickupRules.isAckMetadata(meta),
            stamped: columnStamped || PickupRules.hasStamp(meta),
            stampColumnPresent: PickupRules.stampKeys.contains { columns.contains($0) })
    }

    private static func parseDate(_ s: String) -> Date? {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: s) { return d }
        f.formatOptions = [.withInternetDateTime]
        if let d = f.date(from: s) { return d }
        // Realtime sends Postgres's own form: "2026-11-04 13:05:01.123456+00".
        let pg = DateFormatter()
        pg.locale = Locale(identifier: "en_US_POSIX")
        for format in ["yyyy-MM-dd HH:mm:ss.SSSSSSXXXXX", "yyyy-MM-dd HH:mm:ssXXXXX", "yyyy-MM-dd HH:mm:ss.SSSSSSX", "yyyy-MM-dd HH:mm:ssX"] {
            pg.dateFormat = format
            if let d = pg.date(from: s) { return d }
        }
        return nil
    }
}
