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

    // Apple's JSON is kept as bytes and spliced into the upload untouched
    // (RawJSONUpload). It used to be decoded into `AnyJSON` and re-encoded:
    // both walk the tree recursively, and a diagnostic's call-stack tree nests
    // one level per frame, so a deep stack could overflow the thread and
    // crash the app while reporting a crash.

    func didReceive(_ payloads: [MXMetricPayload]) {
        let rows = payloads.map { p in
            Row.base(kind: "metrics", at: p.timeStampEnd).with(payload: p.jsonRepresentation())
        }
        queue.async { self.buffer += rows; self.flush() }
    }

    func didReceive(_ payloads: [MXDiagnosticPayload]) {
        let rows = payloads.map { p in
            Row.base(kind: "diagnostic", at: p.timeStampEnd).with(payload: p.jsonRepresentation())
        }
        queue.async { self.buffer += rows; self.flush() }
    }

    // MARK: - Upload

    private func flush() {
        lastFlush = CFAbsoluteTimeGetCurrent()
        guard !buffer.isEmpty else { return }
        let rows = buffer
        buffer.removeAll()
        Task.detached(priority: .utility) {
            do {
                try await RawJSONUpload.send(table: "app_perf_events", rawKey: "payload",
                                             rows: rows.map { ($0, $0.payload) })
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
        /// Apple's JSON as bytes; sent as the jsonb `payload` column by
        /// RawJSONUpload, never through the encoder.
        var payload: Data?

        enum CodingKeys: String, CodingKey {
            case occurred_at, kind, platform, device, os_version, app_version, build, duration_ms, context
        }

        static func base(kind: String, at date: Date) -> Row {
            Row(occurred_at: ISO8601DateFormatter().string(from: date),
                kind: kind,
                platform: Device.platform,
                device: Device.model,
                os_version: ProcessInfo.processInfo.operatingSystemVersionString,
                app_version: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String,
                build: Bundle.main.infoDictionary?["CFBundleVersion"] as? String)
        }

        func with(duration: Int? = nil, context: String? = nil, payload: Data? = nil) -> Row {
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

/// Inserts rows into a Supabase table where one jsonb column arrives as JSON
/// bytes that are spliced into the request body as they are.
///
/// The usual route, decoding the bytes into `AnyJSON` and letting the client
/// encode it again, recurses once per nesting level on both legs. A deeply
/// nested document (a MetricKit call-stack tree, a FHIR record) then overflows
/// the 512 KB stack of a background thread: EXC_BAD_ACCESS in the stack guard,
/// as in the iPhone crash of 2026-11-10 (build 264). Splicing never walks the
/// tree.
enum RawJSONUpload {
    /// - Parameters:
    ///   - rawKey: the column the raw bytes fill. Leave it out of `Row`'s
    ///     CodingKeys; rows whose bytes are nil or not JSON go without it.
    ///   - onConflict: set to upsert on that column instead of inserting.
    static func send<Row: Encodable>(table: String, rawKey: String, rows: [(Row, Data?)],
                                     onConflict: String? = nil) async throws {
        guard !rows.isEmpty else { return }
        try await SupabaseManager.ensureAuthenticated()
        let token = try await SupabaseManager.shared.auth.session.accessToken

        let encoder = JSONEncoder()
        var body = Data("[".utf8)
        // Rows may leave out different nil columns; naming the union lets
        // PostgREST take them in one batch (as the Supabase client does).
        var columns = Set<String>()
        for (i, (row, raw)) in rows.enumerated() {
            if i > 0 { body.append(Data(",".utf8)) }
            var object = try encoder.encode(row)
            if let keys = (try? JSONSerialization.jsonObject(with: object)) as? [String: Any] {
                columns.formUnion(keys.keys)
            }
            if let raw, isJSON(raw) {
                columns.insert(rawKey)
                // `{...}` → `{...,"key":<raw>}`; `{}` → `{"key":<raw>}`.
                guard object.last == UInt8(ascii: "}") else { throw URLError(.cannotParseResponse) }
                object.removeLast()
                if object.count > 1 { object.append(Data(",".utf8)) }
                object.append(try encoder.encode(rawKey))
                object.append(Data(":".utf8))
                object.append(raw)
                object.append(Data("}".utf8))
            }
            body.append(object)
        }
        body.append(Data("]".utf8))

        var components = URLComponents(url: SupabaseManager.url.appendingPathComponent("rest/v1/\(table)"),
                                       resolvingAgainstBaseURL: false)!
        var query = [URLQueryItem(name: "columns", value: columns.sorted().joined(separator: ","))]
        if let onConflict { query.append(URLQueryItem(name: "on_conflict", value: onConflict)) }
        components.queryItems = query
        var request = URLRequest(url: components.url!)
        request.httpMethod = "POST"
        request.httpBody = body
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(SupabaseManager.anonKey, forHTTPHeaderField: "apikey")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue(onConflict == nil ? "return=minimal" : "return=minimal,resolution=merge-duplicates",
                         forHTTPHeaderField: "Prefer")
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            let detail = String(data: data.prefix(300), encoding: .utf8) ?? ""
            throw NSError(domain: "RawJSONUpload", code: (response as? HTTPURLResponse)?.statusCode ?? -1,
                          userInfo: [NSLocalizedDescriptionKey: "\(table): \(detail)"])
        }
    }

    /// A cheap shape check: the bytes start with an object or array. Apple's
    /// and HealthKit's JSON is well formed; this only keeps an empty or
    /// non-JSON blob from breaking the whole batch.
    private static func isJSON(_ data: Data) -> Bool {
        guard let first = data.first(where: { !($0 == 0x20 || $0 == 0x0A || $0 == 0x0D || $0 == 0x09) }) else { return false }
        return first == UInt8(ascii: "{") || first == UInt8(ascii: "[")
    }
}
