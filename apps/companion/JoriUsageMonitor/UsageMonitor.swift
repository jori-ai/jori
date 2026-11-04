#if os(iOS) && !targetEnvironment(macCatalyst) && canImport(DeviceActivity)
import DeviceActivity
import Foundation

/// Screen Time callback extension (2026-10-08). The system calls this when an
/// hourly overnight window starts/ends and when usage inside it crosses a
/// threshold (PhoneUsageMonitor schedules them). It only appends one JSON line
/// per callback to the App Group; the app turns the log into
/// `phone_usage_windows` rows. No network here — extensions get seconds.
final class UsageMonitor: DeviceActivityMonitor {
    private func append(_ obj: [String: Any]) {
        guard !Install.appGroup.isEmpty,
              let dir = FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: Install.appGroup) else { return }
        let url = dir.appendingPathComponent("usage-events.jsonl")
        guard var data = try? JSONSerialization.data(withJSONObject: obj) else { return }
        data.append(0x0A)
        if let h = try? FileHandle(forWritingTo: url) {
            defer { try? h.close() }
            _ = try? h.seekToEnd()
            try? h.write(contentsOf: data)
        } else {
            try? data.write(to: url)
        }
    }

    override func intervalDidStart(for activity: DeviceActivityName) {
        super.intervalDidStart(for: activity)
        append(["activity": activity.rawValue, "kind": "start", "at": Date().timeIntervalSince1970])
    }

    override func intervalDidEnd(for activity: DeviceActivityName) {
        super.intervalDidEnd(for: activity)
        append(["activity": activity.rawValue, "kind": "end", "at": Date().timeIntervalSince1970])
    }

    override func eventDidReachThreshold(_ event: DeviceActivityEvent.Name, activity: DeviceActivityName) {
        super.eventDidReachThreshold(event, activity: activity)
        append(["activity": activity.rawValue, "event": event.rawValue, "kind": "threshold",
                "at": Date().timeIntervalSince1970])
    }
}
#endif
