import Foundation

#if os(iOS)
import CoreLocation
import MapKit
import Photos
import Supabase
import UIKit
import Vision
#if canImport(FoundationModels)
import FoundationModels
#endif

/// Answers the server's "what did you photograph during this stop?" probes
/// straight from the photo roll (2026-10-08).
///
/// Why: iCloud can take an hour or more to carry a photo to the host's
/// library — long after a question asked which nearby place the user was at.
/// So the app checks its own photo roll for the question's time window instead
/// of waiting for the sync. Only with the photo-probe feature (JORI_FEATURES).
///
/// Contract (server side: lib/photo-probe.mjs, migration
/// data/migrations/20261008_photo_probes.sql):
///   - the server inserts a `photo_probes` row {window_start, window_end,
///     status: pending} and sends a silent push {kind: "photo_probe", probe_id};
///   - for each image taken in window ± 10 min (newest first, at most 8) we
///     write a `photos` row under the SAME uuid the host's osxphotos sync uses
///     (the PHAsset localIdentifier before its first "/"), so the later sync
///     merges into it instead of duplicating it;
///   - then PATCH the probe to done / error.
///
/// What the phone adds that the host can't: `ocr_lines` (Vision text as ordered
/// lines — the host's detected_text is an alphabetical bag, word order gone) and
/// `device_venue` (nearby points of interest from MapKit, plus an on-device
/// Foundation Models guess when the OS has it), to confirm a location the GPS
/// leaves unclear.
///
/// Triggered three ways, because a silent push is a hint iOS may throttle:
/// the push itself, the app coming to the foreground, and the location
/// tracker's background wake-ups (throttled to once per 2 minutes).
/// Never throws: a failure is written to the probe's `error` field.
private let ocrMinConfidence: Float = 0.5
/// Ceiling on the on-device model's confidence when it only picked from the
/// nearby-places list rather than reading the name off the photo.
private let poiOnlyMaxConfidence = 0.5

actor PhotoProbeResponder {
    static let shared = PhotoProbeResponder()

    /// A probe older than this is the server's to expire, not ours to answer.
    private let probeMaxAge: TimeInterval = 6 * 3600
    private let windowPad: TimeInterval = 10 * 60
    private let maxPhotosPerProbe = 8
    private let poiRadiusM: CLLocationDistance = 75
    private let ambientMinInterval: TimeInterval = 120
    private let deviceId = Install.locationDeviceId   // the device guard on photos / location_history

    private var running = false
    private var lastAmbientRun = Date.distantPast
    private var serviced = Set<UUID>()

    // MARK: - Entry points

    /// Service every pending probe. Returns how many were answered, or nil when
    /// nothing could be checked (no session, query failed, already running).
    @discardableResult
    func run(reason: String, budget: TimeInterval = 24) async -> Int? {
        guard Install.has(.photoProbe), !running else { return nil }
        running = true
        defer { running = false }
        let deadline = Date().addingTimeInterval(budget)

        do { try await SupabaseManager.ensureAuthenticated() } catch { return nil }
        let probes: [Probe]
        do {
            probes = try await SupabaseManager.shared.from("photo_probes")
                .select("id,window_start,window_end,status,requested_at")
                .eq("status", value: "pending")
                .gte("requested_at", value: Self.iso(Date().addingTimeInterval(-probeMaxAge)))
                .order("requested_at", ascending: true)
                .limit(10)
                .execute()
                .value
        } catch {
            print("[PhotoProbe] fetch failed (\(reason)): \(error)")
            return nil
        }
        var answered = 0
        for p in probes where !serviced.contains(p.id) {
            if Date() > deadline { break }
            guard await service(p, deadline: deadline) else { continue }
            serviced.insert(p.id)
            answered += 1
        }
        if answered > 0 { print("[PhotoProbe] answered \(answered) probe(s) (\(reason))") }
        return answered
    }

    /// From the location tracker: the app is awake in the background far more
    /// often for location than iOS will deliver silent pushes.
    func runIfDue() async {
        guard Date().timeIntervalSince(lastAmbientRun) >= ambientMinInterval else { return }
        lastAmbientRun = Date()
        await run(reason: "location")
    }

    /// Ask once, after sign-in at launch. Without full access the roll is
    /// invisible (limited access only shows what the user hand-picked).
    nonisolated static func requestAuthorizationIfNeeded() {
        guard Install.has(.photoProbe),
              PHPhotoLibrary.authorizationStatus(for: .readWrite) == .notDetermined else { return }
        PHPhotoLibrary.requestAuthorization(for: .readWrite) { status in
            print("[PhotoProbe] Photos authorization: \(status.rawValue)")
            // Probes that arrived while the prompt was up were left pending.
            if status == .authorized || status == .limited {
                Task { await PhotoProbeResponder.shared.run(reason: "authorized") }
            }
        }
    }

    // MARK: - One probe

    /// False when the probe was left pending for a later run.
    private func service(_ probe: Probe, deadline: Date) async -> Bool {
        let status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        // Not asked yet (or the prompt is still on screen): leave it pending.
        // 2026-10-08, first launch of the build: the foreground run reached
        // the lunch probe before the user tapped Allow, and failed it for good.
        if status == .notDetermined { return false }
        guard status == .authorized || status == .limited else {
            await finish(probe, status: "error", count: 0, uuids: [], error: "no-photos-access (\(status.rawValue))")
            return true
        }
        guard let start = Self.parse(probe.window_start), let end = Self.parse(probe.window_end) else {
            await finish(probe, status: "error", count: 0, uuids: [], error: "bad-window")
            return true
        }
        let opts = PHFetchOptions()
        opts.predicate = NSPredicate(format: "creationDate >= %@ AND creationDate <= %@ AND mediaType == %d",
                                     start.addingTimeInterval(-windowPad) as NSDate,
                                     end.addingTimeInterval(windowPad) as NSDate,
                                     PHAssetMediaType.image.rawValue)
        opts.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
        opts.fetchLimit = maxPhotosPerProbe
        let fetched = PHAsset.fetchAssets(with: opts)
        var assets: [PHAsset] = []
        fetched.enumerateObjects { a, _, _ in assets.append(a) }

        // Rows the host already synced keep ITS labels and text (Photos' own
        // models); we only add the columns the host never writes. The phone's
        // localIdentifier is NOT the host's uuid — each device's library numbers
        // its own assets (2026-10-08: IMG_7527 was DA44122A on the host and
        // 23492A13 here, so the first probe wrote every photo twice). Match on
        // capture time + original filename instead.
        var mini: [(uuid: String, t: Date, file: String?)] = []
        if let first = assets.last?.creationDate, let last = assets.first?.creationDate {
            struct Seen: Decodable { let uuid: String; let taken_at: String; let original_filename: String? }
            if let rows: [Seen] = try? await SupabaseManager.shared.from("photos")
                .select("uuid,taken_at,original_filename")
                .gte("taken_at", value: Self.iso(first.addingTimeInterval(-2)))
                .lte("taken_at", value: Self.iso(last.addingTimeInterval(2)))
                .execute().value {
                mini = rows.compactMap { r in Self.parse(r.taken_at).map { (r.uuid, $0, r.original_filename) } }
            }
        }

        var written: [String] = []
        var failures: [String] = []
        for asset in assets {
            if Date() > deadline { failures.append("deadline"); break }
            let file = PHAssetResource.assetResources(for: asset).first?.originalFilename
            let match = mini.first { m in
                abs(m.t.timeIntervalSince(asset.creationDate ?? .distantPast)) < 1
                    && (m.file == nil || file == nil || m.file == file)
            }
            let id = match?.uuid ?? Self.uuid(of: asset)
            do {
                try await analyzeAndWrite(asset, uuid: id, exists: match != nil, deadline: deadline)
                written.append(id)
            } catch {
                failures.append("\(id.prefix(8)): \(String(describing: error).prefix(80))")
            }
        }
        var note: [String] = []
        if status == .limited { note.append("limited-access") }
        note.append(contentsOf: failures.prefix(3))
        let allFailed = !assets.isEmpty && written.isEmpty
        await finish(probe, status: allFailed ? "error" : "done", count: written.count, uuids: written,
                     error: note.isEmpty ? nil : note.joined(separator: "; "))
        return true
    }

    private func analyzeAndWrite(_ asset: PHAsset, uuid: String, exists: Bool, deadline: Date) async throws {
        let taken = asset.creationDate ?? Date()
        let image = await Self.loadImage(asset, maxSide: 1600, timeout: max(2, min(8, deadline.timeIntervalSinceNow - 4)))
        let cg = image?.cgImage
        let lines = cg.map(Self.ocrLines) ?? []
        let labels = cg.map(Self.classify) ?? []
        let loc = asset.location

        var venue: DeviceVenue?
        if let loc, deadline.timeIntervalSinceNow > 3 {
            let pois = await Self.pointsOfInterest(near: loc, radius: poiRadiusM)
            var guess: (name: String?, confidence: Double, basis: String, model: String?) = (nil, 0, "", nil)
            if deadline.timeIntervalSinceNow > 5 {
                guess = await Self.onDeviceGuess(lines: lines, labels: labels, pois: pois, taken: taken)
            }
            venue = DeviceVenue(name: guess.name, confidence: guess.name == nil ? nil : guess.confidence,
                                basis: guess.name == nil ? nil : guess.basis, model: guess.model,
                                pois: Array(pois.prefix(5)))
        }

        var thumbURL: String?
        if let image, let jpeg = Self.jpeg(image, maxSide: 1024) {
            let path = "thumbs/\(uuid).jpg"
            let bucket = SupabaseManager.shared.storage.from("daily-photos")
            if (try? await bucket.upload(path, data: jpeg, options: FileOptions(contentType: "image/jpeg", upsert: true))) != nil {
                thumbURL = try? bucket.getPublicURL(path: path).absoluteString
            }
        }

        if exists {
            try await SupabaseManager.shared.from("photos")
                .update(PhoneOnly(ocr_lines: lines, device_venue: venue, thumb_url: thumbURL))
                .eq("uuid", value: uuid)
                .execute()
            return
        }
        let resources = PHAssetResource.assetResources(for: asset)
        let isScreenshot = asset.mediaSubtypes.contains(.photoScreenshot)
        let row = PhotoRow(
            uuid: uuid,
            taken_at: Self.iso(taken),
            tz_offset_seconds: TimeZone.current.secondsFromGMT(for: taken),
            latitude: loc?.coordinate.latitude,
            longitude: loc?.coordinate.longitude,
            media_type: "photo",
            original_filename: resources.first?.originalFilename,
            width: asset.pixelWidth, height: asset.pixelHeight,
            favorite: asset.isFavorite, hidden: asset.isHidden,
            // A camera photo carries GPS; screenshots and images saved from
            // other apps don't. Same meaning as the host's self_captured.
            self_captured: !isScreenshot && loc != nil,
            labels: labels,
            detected_text: Self.tokens(lines),
            ocr_lines: lines,
            device_venue: venue,
            thumb_url: thumbURL,
            device_id: deviceId,
            synced_at: Self.iso(Date()))
        try await SupabaseManager.shared.from("photos")
            .upsert(row, onConflict: "uuid", ignoreDuplicates: false)
            .execute()
    }

    private func finish(_ probe: Probe, status: String, count: Int, uuids: [String], error: String?) async {
        let patch = ProbePatch(status: status, answered_at: Self.iso(Date()), photo_count: count,
                               uuids: uuids, error: error, device: "iphone")
        do {
            try await SupabaseManager.shared.from("photo_probes")
                .update(patch).eq("id", value: probe.id.uuidString).execute()
        } catch {
            print("[PhotoProbe] could not mark probe \(probe.id): \(error)")
        }
    }

    // MARK: - Photo analysis

    /// The osxphotos uuid: the localIdentifier is "<UUID>/L0/001".
    private static func uuid(of asset: PHAsset) -> String {
        String(asset.localIdentifier.split(separator: "/").first ?? Substring(asset.localIdentifier))
    }

    private static func loadImage(_ asset: PHAsset, maxSide: CGFloat, timeout: TimeInterval) async -> UIImage? {
        let opts = PHImageRequestOptions()
        opts.isNetworkAccessAllowed = true          // the original may live only in iCloud
        opts.deliveryMode = .highQualityFormat      // one callback, not a degraded preview first
        opts.resizeMode = .fast
        let once = Once<UIImage?>()
        return await withCheckedContinuation { cont in
            let reqId = PHImageManager.default().requestImage(
                for: asset, targetSize: CGSize(width: maxSide, height: maxSide),
                contentMode: .aspectFit, options: opts) { image, _ in
                    if once.claim() { cont.resume(returning: image) }
                }
            DispatchQueue.global().asyncAfter(deadline: .now() + timeout) {
                if once.claim() {
                    PHImageManager.default().cancelImageRequest(reqId)
                    cont.resume(returning: nil)
                }
            }
        }
    }

    /// Recognized text as LINES, top to bottom then left to right — the order
    /// a sign reads in. Vision's origin is bottom-left, hence maxY descending.
    private static func ocrLines(_ cg: CGImage) -> [String] {
        let req = VNRecognizeTextRequest()
        req.recognitionLevel = .accurate
        req.usesLanguageCorrection = true
        req.automaticallyDetectsLanguage = true
        // Only languages this OS supports, or the request throws.
        if let supported = try? req.supportedRecognitionLanguages() {
            let wanted = ["he-IL", "en-US", "fr-FR"].filter { supported.contains($0) }
            if !wanted.isEmpty { req.recognitionLanguages = wanted }
        }
        try? VNImageRequestHandler(cgImage: cg).perform([req])
        let obs = (req.results ?? []).sorted {
            abs($0.boundingBox.midY - $1.boundingBox.midY) > 0.02
                ? $0.boundingBox.midY > $1.boundingBox.midY
                : $0.boundingBox.minX < $1.boundingBox.minX
        }
        // A script Vision can't read comes back as confident-looking Latin junk
        // (a Hebrew menu read as "DIPON", "abnon!"), mostly at low confidence.
        return obs.compactMap { $0.topCandidates(1).first }
            .filter { $0.confidence >= ocrMinConfidence }
            .map { $0.string.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
    }

    /// The host's detected_text shape: distinct word tokens, sorted.
    private static func tokens(_ lines: [String]) -> [String] {
        Array(Set(lines.flatMap { $0.split(whereSeparator: \.isWhitespace).map(String.init) })).sorted()
    }

    private static func classify(_ cg: CGImage) -> [String] {
        let req = VNClassifyImageRequest()
        try? VNImageRequestHandler(cgImage: cg).perform([req])
        let top = (req.results ?? []).filter { $0.confidence >= 0.3 }
            .sorted { $0.confidence > $1.confidence }.prefix(15)
        return top.map { $0.identifier.replacingOccurrences(of: "_", with: " ").lowercased() }.sorted()
    }

    private static func jpeg(_ image: UIImage, maxSide: CGFloat) -> Data? {
        let s = image.size
        let scale = min(1, maxSide / max(s.width, s.height))
        let size = CGSize(width: (s.width * scale).rounded(), height: (s.height * scale).rounded())
        let fmt = UIGraphicsImageRendererFormat.default()
        fmt.scale = 1
        return UIGraphicsImageRenderer(size: size, format: fmt).image { _ in
            image.draw(in: CGRect(origin: .zero, size: size))
        }.jpegData(compressionQuality: 0.8)
    }

    // MARK: - Where was the photo taken

    private static func pointsOfInterest(near loc: CLLocation, radius: CLLocationDistance) async -> [POI] {
        let req = MKLocalPointsOfInterestRequest(center: loc.coordinate, radius: radius)
        guard let resp = try? await MKLocalSearch(request: req).start() else { return [] }
        return resp.mapItems.compactMap { item -> POI? in
            guard let name = item.name, !name.isEmpty else { return nil }
            let c = item.placemark.coordinate
            let d = loc.distance(from: CLLocation(latitude: c.latitude, longitude: c.longitude))
            let cat = item.pointOfInterestCategory?.rawValue.replacingOccurrences(of: "MKPOICategory", with: "")
            return POI(name: name, category: cat, distance_m: Int(d.rounded()))
        }
        .sorted { $0.distance_m < $1.distance_m }
    }

    /// The on-device model picks which venue the photo was taken at. Its answer
    /// is only kept if it names a listed point of interest or a name spelled out
    /// in the photo's own OCR lines — it can choose, it cannot invent.
    private static func onDeviceGuess(lines: [String], labels: [String], pois: [POI], taken: Date)
        async -> (name: String?, confidence: Double, basis: String, model: String?) {
        #if canImport(FoundationModels)
        if #available(iOS 26.0, *) {
            guard case .available = SystemLanguageModel.default.availability else { return (nil, 0, "", nil) }
            if pois.isEmpty && lines.isEmpty { return (nil, 0, "", "apple-fm") }
            let poiText = pois.prefix(12).map { "- \($0.name) (\($0.category ?? "place"), \($0.distance_m) m)" }
                .joined(separator: "\n")
            let local = DateFormatter()
            local.dateFormat = "EEEE HH:mm"
            let prompt = """
            A photo was taken at \(local.string(from: taken)) local time.
            Text read from the photo, top to bottom:
            \(lines.isEmpty ? "(none)" : lines.prefix(30).joined(separator: "\n"))
            What the photo shows: \(labels.isEmpty ? "(unknown)" : labels.joined(separator: ", "))
            Places near where it was taken (name, category, distance):
            \(poiText.isEmpty ? "(none)" : poiText)
            Which venue was the photo taken at or in? Answer with a name from the places list or a venue name written in the photo's text. Leave the name empty if the evidence does not point to one venue.
            """
            do {
                let session = LanguageModelSession(instructions: "You identify the venue a phone photo was taken at, from the photo's text, its contents, and nearby places. Never guess a venue that is not in the evidence.")
                let out = try await session.respond(to: prompt, generating: VenueGuess.self).content
                let name = out.name.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !name.isEmpty else { return (nil, 0, "", "apple-fm") }
                let low = name.lowercased()
                let listed = pois.first { $0.name.lowercased() == low }?.name
                let inText = lines.contains { $0.lowercased().contains(low) }
                guard listed != nil || inText else { return (nil, 0, "", "apple-fm") }
                // The model's own confidence and basis aren't evidence: it has
                // claimed "sign text" at confidence 1 for a photo with no such
                // text. Only a name read off the
                // photo stays confident; a pick from the list is a hint.
                if inText { return (listed ?? name, min(1, max(0, out.confidence)), "sign text", "apple-fm") }
                return (listed ?? name, min(poiOnlyMaxConfidence, max(0, out.confidence)), "nearby place", "apple-fm")
            } catch {
                print("[PhotoProbe] on-device model failed: \(error)")
                return (nil, 0, "", "apple-fm")
            }
        }
        #endif
        return (nil, 0, "", nil)
    }

    // MARK: - Helpers

    private static func iso(_ d: Date) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.string(from: d)
    }

    private static func parse(_ s: String) -> Date? {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: s) { return d }
        f.formatOptions = [.withInternetDateTime]
        return f.date(from: s)
    }
}

#if canImport(FoundationModels)
@available(iOS 26.0, *)
@Generable
private struct VenueGuess {
    @Guide(description: "The venue's name, copied exactly from the places list or the photo's text; empty if unclear")
    var name: String
    @Guide(description: "How sure, from 0 to 1")
    var confidence: Double
    @Guide(description: "What decided it, e.g. 'sign text', 'poi+labels', 'nearest poi'")
    var basis: String
}
#endif

/// One-shot latch for a continuation raced against a timeout.
private final class Once<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var done = false
    func claim() -> Bool {
        lock.lock(); defer { lock.unlock() }
        if done { return false }
        done = true
        return true
    }
}

private struct Probe: Decodable {
    let id: UUID
    let window_start: String
    let window_end: String
    let status: String
    let requested_at: String
}

private struct ProbePatch: Encodable {
    let status: String
    let answered_at: String
    let photo_count: Int
    let uuids: [String]
    let error: String?
    let device: String
}

struct POI: Codable, Sendable {
    let name: String
    let category: String?
    let distance_m: Int
}

private struct DeviceVenue: Encodable {
    let name: String?
    let confidence: Double?
    let basis: String?
    let model: String?
    let pois: [POI]

    // name/model are written as explicit nulls: "the phone looked and found
    // nothing" is different from "the phone never looked".
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(name, forKey: .name)
        try c.encodeIfPresent(confidence, forKey: .confidence)
        try c.encodeIfPresent(basis, forKey: .basis)
        try c.encode(model, forKey: .model)
        try c.encode(pois, forKey: .pois)
    }
    enum CodingKeys: String, CodingKey { case name, confidence, basis, model, pois }
}

/// Only the columns the host never writes — sent for rows it already synced.
private struct PhoneOnly: Encodable {
    let ocr_lines: [String]
    let device_venue: DeviceVenue?
    let thumb_url: String?
}

private struct PhotoRow: Encodable {
    let uuid: String
    let taken_at: String
    let tz_offset_seconds: Int
    let latitude: Double?
    let longitude: Double?
    let media_type: String
    let original_filename: String?
    let width: Int
    let height: Int
    let favorite: Bool
    let hidden: Bool
    let self_captured: Bool
    let labels: [String]
    let detected_text: [String]
    let ocr_lines: [String]
    let device_venue: DeviceVenue?
    let thumb_url: String?
    let device_id: String
    let synced_at: String
}

#else

/// Photos probes are answered by the iPhone; the Mac build has no camera roll
/// worth asking.
actor PhotoProbeResponder {
    static let shared = PhotoProbeResponder()
    @discardableResult func run(reason: String, budget: TimeInterval = 24) async -> Int? { nil }
    func runIfDue() async {}
    nonisolated static func requestAuthorizationIfNeeded() {}
}

#endif
