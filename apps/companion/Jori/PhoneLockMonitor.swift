import Foundation

#if os(iOS)
import UIKit
import Supabase

/// Phone lock-state evidence for wake/sleep (2026-10-08): the last use of the
/// phone (not the app) at night and the first in the morning. Only with the
/// phone-lock feature (JORI_FEATURES).
///
/// iOS gives an app no global "unlocked" event, but it does say whether the
/// device's protected data is available — true from unlock until ~10 s after
/// lock (with a passcode). Two sources, both only while the app is running:
///   - transitions: `protectedDataDidBecomeAvailable` (unlocked) /
///     `protectedDataWillBecomeUnavailable` (locked);
///   - samples: every background wake the app already gets (CLVisit, location
///     fixes) reads `isProtectedDataAvailable`.
/// The app is suspended overnight when the user is still, so this is PARTIAL
/// evidence; the Screen Time monitor (`PhoneUsageMonitor`) is the complete one
/// once Apple grants the Family Controls entitlement.
///
/// Rows go to `phone_lock_events`. They are queued on disk first so a fix
/// taken while offline (or before Supabase auth is ready) is not lost.
@MainActor
final class PhoneLockMonitor {
    static let shared = PhoneLockMonitor()
    private init() {}

    private struct Event: Codable {
        let ts: Date
        let state: String   // unlocked | locked | sample_unlocked | sample_locked
        let source: String
        let tz: String
    }

    private let queueKey = Install.key("phoneLock.queue")
    private let lastKey = Install.key("phoneLock.last")         // "<state>|<epoch>"
    private let maxQueue = 2000
    /// A sample that repeats the last recorded state is skipped unless this
    /// long has passed — enough to bracket a night, cheap on rows.
    private let sampleRepeatInterval: TimeInterval = 15 * 60
    private var started = false
    private var flushing = false

    func start() {
        guard Install.has(.phoneLock), !started else { return }
        started = true
        let nc = NotificationCenter.default
        nc.addObserver(forName: UIApplication.protectedDataDidBecomeAvailableNotification,
                       object: nil, queue: .main) { _ in
            Task { @MainActor in PhoneLockMonitor.shared.record(state: "unlocked", source: "transition") }
        }
        nc.addObserver(forName: UIApplication.protectedDataWillBecomeUnavailableNotification,
                       object: nil, queue: .main) { _ in
            Task { @MainActor in PhoneLockMonitor.shared.record(state: "locked", source: "transition") }
        }
        sample(source: "launch")
    }

    /// Read the current lock state on a wake the app already got.
    func sample(source: String) {
        guard Install.has(.phoneLock) else { return }
        let unlocked = UIApplication.shared.isProtectedDataAvailable
        let state = unlocked ? "sample_unlocked" : "sample_locked"
        if let last = UserDefaults.standard.string(forKey: lastKey) {
            let parts = last.split(separator: "|")
            if parts.count == 2, let at = Double(parts[1]) {
                let sameState = parts[0].hasSuffix(unlocked ? "unlocked" : "locked")
                if sameState && Date().timeIntervalSince1970 - at < sampleRepeatInterval { return }
            }
        }
        record(state: state, source: source)
    }

    private func record(state: String, source: String) {
        let now = Date()
        var q = loadQueue()
        q.append(Event(ts: now, state: state, source: source, tz: TimeZone.current.identifier))
        if q.count > maxQueue { q.removeFirst(q.count - maxQueue) }
        saveQueue(q)
        UserDefaults.standard.set("\(state)|\(now.timeIntervalSince1970)", forKey: lastKey)
        Task { await flush() }
    }

    private struct Row: Encodable {
        let device_id: String
        let ts: String
        let state: String
        let source: String
        let tz: String
    }

    func flush() async {
        guard !flushing else { return }
        let q = loadQueue()
        guard !q.isEmpty else { return }
        flushing = true
        defer { flushing = false }
        let deviceId = UserDefaults.standard.string(forKey: Install.key("apnsDeviceToken")).flatMap { $0.isEmpty ? nil : $0 }
            ?? UIDevice.current.identifierForVendor?.uuidString ?? "unknown"
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let rows = q.map { Row(device_id: deviceId, ts: iso.string(from: $0.ts), state: $0.state, source: $0.source, tz: $0.tz) }
        do {
            try await SupabaseManager.ensureAuthenticated()
            for chunk in stride(from: 0, to: rows.count, by: 200).map({ Array(rows[$0..<min($0 + 200, rows.count)]) }) {
                try await SupabaseManager.shared
                    .from("phone_lock_events")
                    .upsert(chunk, onConflict: "device_id,ts,state", ignoreDuplicates: true)
                    .execute()
            }
            // Drop exactly what was sent; anything recorded meanwhile stays.
            let sent = Set(q.map { "\($0.ts.timeIntervalSince1970)|\($0.state)" })
            saveQueue(loadQueue().filter { !sent.contains("\($0.ts.timeIntervalSince1970)|\($0.state)") })
        } catch {
            print("[PhoneLock] upload failed (kept \(q.count) queued): \(error.localizedDescription)")
        }
    }

    private func loadQueue() -> [Event] {
        guard let data = UserDefaults.standard.data(forKey: queueKey) else { return [] }
        return (try? JSONDecoder().decode([Event].self, from: data)) ?? []
    }

    private func saveQueue(_ q: [Event]) {
        if let data = try? JSONEncoder().encode(q) { UserDefaults.standard.set(data, forKey: queueKey) }
    }
}
#endif
