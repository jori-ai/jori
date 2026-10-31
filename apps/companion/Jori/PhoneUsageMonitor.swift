import Foundation

#if os(iOS) && !targetEnvironment(macCatalyst) && canImport(DeviceActivity) && canImport(FamilyControls)
import SwiftUI
import UIKit
import FamilyControls
import DeviceActivity
import Supabase

/// Whole-phone usage windows overnight, via Screen Time (2026-10-08). The one
/// supported way for an app to learn when the PHONE (not this app) was used:
/// a DeviceActivityMonitor extension (`JoriUsageMonitor`) is called back
/// when usage inside a monitored window crosses a threshold.
///
/// Shape, bounded by Apple's limit of 20 monitored activities: 16 hourly
/// activities covering 20:00–12:00 local, repeating daily, each with events at
/// 1/3/5/10/15/30/45 minutes of cumulative usage. The first 1-minute crossing
/// of the morning ≈ first use; the last crossing of the night ≈ last use.
/// "All usage" has no API of its own — the user selects every category once in
/// the FamilyActivityPicker and that selection drives every event.
///
/// Needs Family Controls (Distribution) granted by Apple: a build with the
/// screen-time feature claims family-controls + the App Group (JORI_APP_GROUP,
/// Jori-ScreenTime.entitlements) and embeds the extension (iOS only). Still defensive: authorization errors are caught and
/// shown, and no App Group container → no-op.
@MainActor
final class PhoneUsageMonitor: ObservableObject {
    static let shared = PhoneUsageMonitor()
    private init() {}

    static let appGroup = Install.appGroup
    static let logFile = "usage-events.jsonl"
    private let selectionKey = Install.key("usage.selection")
    private let uploadedKey = Install.key("usage.uploadedThrough")
    private let thresholds = [1, 3, 5, 10, 15, 30, 45]
    /// 20:00 → 12:00 next day, one activity per hour.
    private let startHours = Array(20...23) + Array(0...11)

    @Published var selection = FamilyActivitySelection()
    @Published var status: String = ""

    private var defaults: UserDefaults? { UserDefaults(suiteName: Self.appGroup) }
    private var container: URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: Self.appGroup)
    }

    var isAuthorized: Bool { AuthorizationCenter.shared.authorizationStatus == .approved }
    var hasSelection: Bool { !selection.categoryTokens.isEmpty || !selection.applicationTokens.isEmpty }

    // MARK: - Setup

    func startIfAuthorized() {
        guard Install.has(.screenTime) else { return }
        loadSelection()
        guard isAuthorized, hasSelection, container != nil else { return }
        schedule()
    }

    func requestAuthorization() async {
        do {
            try await AuthorizationCenter.shared.requestAuthorization(for: .individual)
            status = isAuthorized ? "Allowed" : "Not allowed"
        } catch {
            // A build without the family-controls entitlement lands here as
            // NSCocoaErrorDomain 4099 "Couldn't communicate with a helper
            // application" — say what it means instead.
            print("[Usage] requestAuthorization failed: \(error)")
            let ns = error as NSError
            status = ns.domain == NSCocoaErrorDomain && ns.code == 4099
                ? "This build can't use Screen Time — it was built without the Family Controls entitlement. Update Jori from TestFlight."
                : "Couldn't get Screen Time access: \(error.localizedDescription)"
        }
    }

    func saveSelection(_ s: FamilyActivitySelection) {
        selection = s
        if let data = try? JSONEncoder().encode(s) { defaults?.set(data, forKey: selectionKey) }
        startIfAuthorized()
    }

    private func loadSelection() {
        guard let data = defaults?.data(forKey: selectionKey),
              let s = try? JSONDecoder().decode(FamilyActivitySelection.self, from: data) else { return }
        selection = s
    }

    private func schedule() {
        let center = DeviceActivityCenter()
        center.stopMonitoring()
        for h in startHours {
            let name = DeviceActivityName(Install.key("usage.h\(h)"))
            let sched = DeviceActivitySchedule(
                intervalStart: DateComponents(hour: h, minute: 0),
                intervalEnd: DateComponents(hour: h, minute: 59, second: 59),
                repeats: true
            )
            var events: [DeviceActivityEvent.Name: DeviceActivityEvent] = [:]
            for t in thresholds {
                events[DeviceActivityEvent.Name("t\(t)")] = DeviceActivityEvent(
                    applications: selection.applicationTokens,
                    categories: selection.categoryTokens,
                    webDomains: selection.webDomainTokens,
                    threshold: DateComponents(minute: t)
                )
            }
            do { try center.startMonitoring(name, during: sched, events: events) }
            catch { print("[Usage] startMonitoring h\(h) failed: \(error.localizedDescription)"); status = "Schedule failed: \(error.localizedDescription)"; return }
        }
        status = "Monitoring 20:00–12:00"
        print("[Usage] monitoring \(startHours.count) hourly windows")
    }

    // MARK: - Upload

    /// One line per extension callback, written by JoriUsageMonitor:
    /// {"activity":"<storage prefix>.usage.h7","event":"t1","kind":"threshold","at":<epoch>}
    /// {"activity":"<storage prefix>.usage.h7","kind":"start"|"end","at":<epoch>}
    private struct LogLine: Decodable {
        let activity: String
        let event: String?
        let kind: String
        let at: Double
    }

    private struct Row: Encodable {
        let device_id: String
        let window_start: String
        let window_end: String
        let used: Bool
        let reached_at: String?
        let last_reached_at: String?
        let max_threshold_min: Int?
        let tz: String
    }

    /// Turn the extension's log into one row per (hour window) and upsert.
    func uploadPending() async {
        guard Install.has(.screenTime),
              let url = container?.appendingPathComponent(Self.logFile),
              let text = try? String(contentsOf: url, encoding: .utf8) else { return }
        let lines = text.split(separator: "\n").compactMap { try? JSONDecoder().decode(LogLine.self, from: Data($0.utf8)) }
        let through = defaults?.double(forKey: uploadedKey) ?? 0
        let fresh = lines.filter { $0.at > through }
        guard !fresh.isEmpty else { return }

        var cal = Calendar.current
        cal.timeZone = .current
        struct W { var start: Date; var end: Date; var first: Date?; var last: Date?; var maxT = 0; var ended = false }
        var windows: [Date: W] = [:]
        for l in fresh {
            let at = Date(timeIntervalSince1970: l.at)
            let hourStart = cal.dateInterval(of: .hour, for: l.kind == "end" ? at.addingTimeInterval(-1) : at)?.start ?? at
            var w = windows[hourStart] ?? W(start: hourStart, end: hourStart.addingTimeInterval(3600))
            switch l.kind {
            case "threshold":
                w.first = min(w.first ?? at, at)
                w.last = max(w.last ?? at, at)
                if let e = l.event, let t = Int(e.dropFirst()) { w.maxT = max(w.maxT, t) }
            case "end": w.ended = true
            default: break
            }
            windows[hourStart] = w
        }
        // Only finished windows (or ones with use) are final enough to send.
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let deviceId = UserDefaults.standard.string(forKey: Install.key("apnsDeviceToken")).flatMap { $0.isEmpty ? nil : $0 }
            ?? UIDevice.current.identifierForVendor?.uuidString ?? "unknown"
        let rows = windows.values.filter { $0.ended || $0.first != nil }.map {
            Row(device_id: deviceId, window_start: iso.string(from: $0.start), window_end: iso.string(from: $0.end),
                used: $0.first != nil, reached_at: $0.first.map(iso.string), last_reached_at: $0.last.map(iso.string),
                max_threshold_min: $0.maxT > 0 ? $0.maxT : nil, tz: TimeZone.current.identifier)
        }
        guard !rows.isEmpty else { return }
        do {
            try await SupabaseManager.ensureAuthenticated()
            try await SupabaseManager.shared.from("phone_usage_windows")
                .upsert(rows, onConflict: "device_id,window_start", ignoreDuplicates: false)
                .execute()
            // Windows still open are re-sent next time (upsert), so only
            // advance past lines that belong to ended windows.
            let endedLast = fresh.filter { $0.kind == "end" }.map(\.at).max() ?? through
            defaults?.set(endedLast, forKey: uploadedKey)
        } catch {
            print("[Usage] upload failed: \(error.localizedDescription)")
        }
    }
}

/// Opt-in sheet: authorize Screen Time, then pick "All Apps & Categories".
struct PhoneUsageSetupView: View {
    @ObservedObject var monitor = PhoneUsageMonitor.shared
    @State private var picking = false
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("Lets Jori see WHEN the phone is used overnight (20:00–12:00, in hourly windows) — not which apps — so the daily summary knows when you went to sleep and woke up.")
                        .font(.callout)
                }
                Section {
                    Button(monitor.isAuthorized ? "Screen Time access ✓" : "Allow Screen Time access") {
                        Task { await monitor.requestAuthorization() }
                    }
                    Button(monitor.hasSelection ? "Usage selection ✓ (change)" : "Select all apps & categories") {
                        picking = true
                    }
                    .disabled(!monitor.isAuthorized)
                }
                if !monitor.status.isEmpty {
                    Section { Text(monitor.status).font(.footnote).foregroundStyle(.secondary) }
                }
            }
            .navigationTitle("Sleep & wake")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .familyActivityPicker(isPresented: $picking, selection: Binding(
                get: { monitor.selection },
                set: { monitor.saveSelection($0) }
            ))
        }
    }
}
#elseif os(iOS)
import SwiftUI
/// No Screen Time on this platform: the same surface, inert.
@MainActor
final class PhoneUsageMonitor: ObservableObject {
    static let shared = PhoneUsageMonitor()
    func startIfAuthorized() {}
    func uploadPending() async {}
}
struct PhoneUsageSetupView: View {
    var body: some View { Text("Screen Time isn't available on this device.").padding() }
}
#endif
