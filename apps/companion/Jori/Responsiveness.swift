//
//  Responsiveness.swift
//  Jori
//
//  Measures how responsive the app is on the user's devices, and uploads it to
//  `app_perf_events` (data/migrations/20261024_app_perf_events.sql) so Jori
//  can read it with `bin/app-perf` — a lag hunt then needs no local
//  Instruments session. Only with the app-perf feature (JORI_FEATURES).
//
//  Two sources:
//
//  1. HANG WATCHDOG. A background queue sends the main thread a ping every
//     100 ms. If a ping waits >= 250 ms to run, the main thread was blocked
//     that long — a stall the user felt. Recorded with the screen the user was on.
//     Paused while the app is not active: a suspended (iOS) or napping (macOS)
//     app answers late for reasons that are not hangs.
//
//  2. METRICKIT. Apple's daily report per device: hang-time histogram, launch
//     time, scroll hitch ratio (iOS), and hang diagnostics with call stacks.
//     Stored as Apple's own JSON, untouched.
//
//  Hangs are buffered and uploaded in batches (every minute, at 20, and when
//  the app leaves the foreground). A failed upload drops the batch — telemetry
//  must never pile up or retry its way into being the slow thing.
//

import Foundation
import MetricKit
import Supabase

#if os(macOS)
import AppKit
#else
import UIKit
#endif

final class Responsiveness: NSObject, MXMetricManagerSubscriber {
    static let shared = Responsiveness()

    private static let threshold: CFTimeInterval = 0.25
    /// Longer than this is the machine sleeping or the debugger, not a hang.
    private static let ceiling: CFTimeInterval = 30
    private static let flushEvery: CFTimeInterval = 60
    private static let flushAt = 20

    private let queue = DispatchQueue(label: Install.key("responsiveness"), qos: .utility)
    // Everything below is touched only on `queue`.
    private var timer: DispatchSourceTimer?
    private var pingInFlight = false
    private var buffer: [Row] = []
    private var lastFlush = CFAbsoluteTimeGetCurrent()
    private var subscribed = false

    // MARK: - Where the user is

    private static let contextLock = NSLock()
    private static var _context = "launch"

    /// The screen the app is showing ("chat", "memory", …), attached to hangs.
    static func setContext(_ value: String) {
        contextLock.lock(); _context = value; contextLock.unlock()
    }

    private static var context: String {
        contextLock.lock(); defer { contextLock.unlock() }
        return _context
    }

    // MARK: - Lifecycle

    /// App became active: (re)start the watchdog; subscribe to MetricKit once.
    func resume() {
        guard Install.has(.appPerf) else { return }
        queue.async {
            if !self.subscribed {
                self.subscribed = true
                MXMetricManager.shared.add(self)
            }
            guard self.timer == nil else { return }
            self.pingInFlight = false
            let t = DispatchSource.makeTimerSource(queue: self.queue)
            t.schedule(deadline: .now() + 1, repeating: .milliseconds(100), leeway: .milliseconds(20))
            t.setEventHandler { [weak self] in self?.tick() }
            t.resume()
            self.timer = t
        }
    }

    /// App left the foreground: stop pinging and send what we have.
    func pause() {
        queue.async {
            self.timer?.cancel()
            self.timer = nil
            self.flush()
        }
    }

    // MARK: - Watchdog

    private func tick() {
        // A ping still waiting means the main thread is busy; its own
        // measurement will cover this whole stretch when it finally runs.
        guard !pingInFlight else { return }
        pingInFlight = true
        let sent = CFAbsoluteTimeGetCurrent()
        DispatchQueue.main.async { [weak self] in
            let blocked = CFAbsoluteTimeGetCurrent() - sent
            let where_ = Responsiveness.context
            self?.queue.async { self?.answered(blocked: blocked, context: where_) }
        }
        if CFAbsoluteTimeGetCurrent() - lastFlush > Self.flushEvery { flush() }
    }

    private func answered(blocked: CFTimeInterval, context: String) {
        pingInFlight = false
        // Cancelled while the ping was queued: the gap is the app leaving the
        // foreground, not a hang.
        guard timer != nil, blocked >= Self.threshold, blocked < Self.ceiling else { return }
        buffer.append(Row.base(kind: "hang", at: Date().addingTimeInterval(-blocked))
            .with(duration: Int(blocked * 1000), context: context))
        if buffer.count >= Self.flushAt { flush() }
    }

    // MARK: - MetricKit

    func didReceive(_ payloads: [MXMetricPayload]) {
        let rows = payloads.compactMap { p -> Row? in
            guard let json = Self.json(p.jsonRepresentation()) else { return nil }
            return Row.base(kind: "metrics", at: p.timeStampEnd).with(payload: json)
        }
        queue.async { self.buffer += rows; self.flush() }
    }

    func didReceive(_ payloads: [MXDiagnosticPayload]) {
        let rows = payloads.compactMap { p -> Row? in
            guard let json = Self.json(p.jsonRepresentation()) else { return nil }
            return Row.base(kind: "diagnostic", at: p.timeStampEnd).with(payload: json)
        }
        queue.async { self.buffer += rows; self.flush() }
    }

    private static func json(_ data: Data) -> AnyJSON? {
        try? JSONDecoder().decode(AnyJSON.self, from: data)
    }

    // MARK: - Upload

    private func flush() {
        lastFlush = CFAbsoluteTimeGetCurrent()
        guard !buffer.isEmpty else { return }
        let rows = buffer
        buffer.removeAll()
        Task.detached(priority: .utility) {
            do {
                try await SupabaseManager.ensureAuthenticated()
                try await SupabaseManager.shared.from("app_perf_events").insert(rows).execute()
            } catch {
                print("[Responsiveness] upload of \(rows.count) event(s) failed: \(error.localizedDescription)")
            }
        }
    }

    // MARK: - Row

    private struct Row: Encodable {
        let occurred_at: String
        let kind: String
        let platform: String
        let device: String
        let os_version: String
        let app_version: String?
        let build: String?
        var duration_ms: Int?
        var context: String?
        var payload: AnyJSON?

        static func base(kind: String, at date: Date) -> Row {
            Row(occurred_at: ISO8601DateFormatter().string(from: date),
                kind: kind,
                platform: Device.platform,
                device: Device.model,
                os_version: ProcessInfo.processInfo.operatingSystemVersionString,
                app_version: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String,
                build: Bundle.main.infoDictionary?["CFBundleVersion"] as? String)
        }

        func with(duration: Int? = nil, context: String? = nil, payload: AnyJSON? = nil) -> Row {
            var r = self
            r.duration_ms = duration
            r.context = context
            r.payload = payload
            return r
        }
    }

    private enum Device {
        static let platform: String = {
            #if os(macOS)
            return "macos"
            #else
            return UIDevice.current.userInterfaceIdiom == .pad ? "ipados" : "ios"
            #endif
        }()

        /// "iPhone17,1", "Mac16,10" — the hardware model identifier.
        static let model: String = {
            #if os(macOS)
            let key = "hw.model"
            #else
            let key = "hw.machine"
            #endif
            var size = 0
            sysctlbyname(key, nil, &size, nil, 0)
            var chars = [CChar](repeating: 0, count: max(size, 1))
            sysctlbyname(key, &chars, &size, nil, 0)
            return String(cString: chars)
        }()
    }
}
