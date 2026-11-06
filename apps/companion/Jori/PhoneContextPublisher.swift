import Foundation

#if os(iOS)
import UIKit
import CoreMotion
import CoreLocation
import Supabase

/// Publishes the device's current motion + Wi-Fi snapshot to the Supabase
/// `phone_context` table (single-row-per-device upsert).
enum PhoneContextPublisher {

    enum Trigger: String { case foreground, visit }

    private static let foregroundMinIntervalSeconds: TimeInterval = 5 * 60
    private static let lastForegroundKey = Install.key("lastAudioPublishAt.foreground")

    /// Debounced foreground publisher; skips if the previous publish fired in
    /// the last 5 minutes.
    static func publishOnForeground() async {
        // First-of-day unlock signal runs independently of the 5-min debounce —
        // it's a cheap row insert that feeds daily-summary's wake-time field.
        await recordFirstUnlockIfNeeded()

        let last = UserDefaults.standard.double(forKey: lastForegroundKey)
        let now = Date().timeIntervalSince1970
        if last > 0, now - last < foregroundMinIntervalSeconds { return }
        UserDefaults.standard.set(now, forKey: lastForegroundKey)
        await publish(trigger: .foreground)
    }

    /// Writes one row to `phone_unlocks` the first time the user opens the app
    /// on a given local date. The (device_id, date) primary key makes repeat
    /// calls no-ops. Daily-summary reads the earliest row to compute wake-time.
    private static func recordFirstUnlockIfNeeded() async {
        let fmt = DateFormatter()
        fmt.dateFormat = "yyyy-MM-dd"
        fmt.timeZone = .current
        let today = fmt.string(from: Date())

        let lastKey = Install.key("firstUnlockDate")
        if UserDefaults.standard.string(forKey: lastKey) == today { return }

        guard let deviceId = await currentDeviceId() else { return }

        struct UnlockRow: Encodable {
            let device_id: String
            let date: String
            let first_unlock_at: String
            let tz: String
        }

        let row = UnlockRow(
            device_id: deviceId,
            date: today,
            first_unlock_at: ISO8601DateFormatter().string(from: Date()),
            tz: TimeZone.current.identifier
        )

        do {
            try await SupabaseManager.ensureAuthenticated()
            try await SupabaseManager.shared
                .from("phone_unlocks")
                .upsert(row, onConflict: "device_id,date", ignoreDuplicates: true)
                .execute()
            UserDefaults.standard.set(today, forKey: lastKey)
            print("[PhoneContext] first-unlock logged for \(today)")
        } catch {
            print("[PhoneContext] first-unlock insert failed: \(error.localizedDescription)")
        }
    }

    /// Upsert a motion + Wi-Fi snapshot for this device.
    static func publish(trigger: Trigger, latitude: Double? = nil, longitude: Double? = nil) async {
        let motionClass = await currentMotionClass() ?? "unknown"
        let wifi = await WiFiContext.fetchCurrent()

        guard let deviceId = await currentDeviceId() else {
            print("[PhoneContext] no device id available; skipping publish")
            return
        }

        let row = PhoneContextRow(
            device_id: deviceId,
            motion_class: motionClass,
            latitude: latitude,
            longitude: longitude,
            wifi_ssid: wifi.ssid,
            wifi_bssid: wifi.bssid,
            trigger: trigger.rawValue,
            ts: ISO8601DateFormatter().string(from: Date())
        )

        do {
            try await SupabaseManager.ensureAuthenticated()
            try await SupabaseManager.shared
                .from("phone_context")
                .upsert(row, onConflict: "device_id")
                .execute()
            print("[PhoneContext] published trigger=\(trigger.rawValue) motion=\(motionClass) wifi=\(wifi.ssid ?? "-")")
        } catch {
            print("[PhoneContext] upsert failed: \(error.localizedDescription)")
        }
    }

    /// Stable per-device identifier. Prefers the APNs token (also used by
    /// `device_tokens`) so all server-side keys agree. Falls back to
    /// `identifierForVendor` when APNs hasn't yet registered.
    private static func currentDeviceId() async -> String? {
        if let token = UserDefaults.standard.string(forKey: Install.key("apnsDeviceToken")),
           !token.isEmpty {
            return token
        }
        return await MainActor.run { UIDevice.current.identifierForVendor?.uuidString }
    }

    /// Single-shot motion read from CMMotionActivityManager's 2-second history.
    private static func currentMotionClass() async -> String? {
        guard CMMotionActivityManager.isActivityAvailable() else { return nil }
        let manager = CMMotionActivityManager()
        return await withCheckedContinuation { cont in
            manager.queryActivityStarting(
                from: Date().addingTimeInterval(-2),
                to: Date(),
                to: .main
            ) { activities, _ in
                guard let last = activities?.last else { cont.resume(returning: nil); return }
                cont.resume(returning: LocationTracker.motionType(from: last))
            }
        }
    }

    private struct PhoneContextRow: Encodable {
        let device_id: String
        let motion_class: String
        let latitude: Double?
        let longitude: Double?
        let wifi_ssid: String?
        let wifi_bssid: String?
        let trigger: String
        let ts: String
    }
}

/// Publishes the newest position to `live_position` (one row per device) while
/// the user is out of the house, so the server can react within seconds.
///
/// `location_history` waypoints are recorded at most every 2 minutes and
/// uploaded every 5, so a local-history ping built from them arrived after the
/// user had walked past the building. This is the fast lane beside that
/// record, not a replacement: bin/local-history-live listens to the row over
/// Realtime. Throttled here so a walk costs one small upsert every ~30 s.
@MainActor
enum LivePositionPublisher {
    /// Fixes coarser than this cannot say which building the user is next to.
    private static let maxAccuracyM: Double = 65
    /// Never more often than this…
    private static let minIntervalS: TimeInterval = 20
    /// …and, standing still, only this often.
    private static let idleIntervalS: TimeInterval = 90
    /// Movement that earns a publish before the idle interval.
    private static let minMoveM: Double = 25

    private static var lastAt: Date?
    private static var lastLat: Double?
    private static var lastLon: Double?
    private static var inFlight = false

    static func maybePublish(latitude: Double, longitude: Double, accuracy: Double,
                             timestamp: Date, motion: String?) {
        guard accuracy >= 0, accuracy <= maxAccuracyM else { return }
        // A cached fix iOS hands back late says nothing about now.
        guard Date().timeIntervalSince(timestamp) < 60 else { return }
        guard !inFlight else { return }
        if let at = lastAt {
            let elapsed = timestamp.timeIntervalSince(at)
            if elapsed < minIntervalS { return }
            let moved = (lastLat != nil && lastLon != nil)
                ? CLLocation(latitude: latitude, longitude: longitude)
                    .distance(from: CLLocation(latitude: lastLat!, longitude: lastLon!))
                : .infinity
            if moved < minMoveM && elapsed < idleIntervalS { return }
        }
        lastAt = timestamp
        lastLat = latitude
        lastLon = longitude
        inFlight = true
        Task {
            defer { inFlight = false }
            guard let deviceId = await deviceId() else { return }
            let row = LivePositionRow(
                device_id: deviceId, latitude: latitude, longitude: longitude,
                accuracy_m: accuracy, motion: motion,
                ts: ISO8601DateFormatter().string(from: timestamp)
            )
            do {
                try await SupabaseManager.ensureAuthenticated()
                try await SupabaseManager.shared
                    .from("live_position")
                    .upsert(row, onConflict: "device_id")
                    .execute()
            } catch {
                print("[LivePosition] upsert failed: \(error.localizedDescription)")
            }
        }
    }

    /// Same key as PhoneContextPublisher, so every per-device row agrees.
    private static func deviceId() async -> String? {
        if let token = UserDefaults.standard.string(forKey: Install.key("apnsDeviceToken")),
           !token.isEmpty {
            return token
        }
        return UIDevice.current.identifierForVendor?.uuidString
    }

    private struct LivePositionRow: Encodable {
        let device_id: String
        let latitude: Double
        let longitude: Double
        let accuracy_m: Double
        let motion: String?
        let ts: String
    }
}

#endif
