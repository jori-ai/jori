import Foundation
import CoreLocation
import SwiftData

#if os(iOS)
import CoreMotion
#endif

// MARK: - Named locations (same as server-side findme)
//
// Places the user wants recognized by name: within 150 m of one, the published
// `place_name` is the entry's name, not a reverse-geocode result. They are the
// installation's, not the app's: `Installation/NamedLocations.json` in the app
// bundle (the build copies the installation's file into Jori/Installation/), an
// array of {"name", "lat", "lon", "address", "city"}. Mirror them in the
// server's findme named-location config so app and CLI agree on labels. No
// file: no named locations.

private struct NamedLocation: Decodable {
    let name: String
    let lat: Double
    let lon: Double
    let address: String
    let city: String
}

private let namedLocations: [NamedLocation] = {
    guard let url = Bundle.main.url(forResource: "NamedLocations", withExtension: "json", subdirectory: "Installation"),
          let data = try? Data(contentsOf: url) else { return [] }
    return (try? JSONDecoder().decode([NamedLocation].self, from: data)) ?? []
}()

private func haversineKm(_ lat1: Double, _ lon1: Double, _ lat2: Double, _ lon2: Double) -> Double {
    let R = 6371.0
    let dLat = (lat2 - lat1) * .pi / 180
    let dLon = (lon2 - lon1) * .pi / 180
    let a = sin(dLat / 2) * sin(dLat / 2) +
        cos(lat1 * .pi / 180) * cos(lat2 * .pi / 180) *
        sin(dLon / 2) * sin(dLon / 2)
    return R * 2 * asin(sqrt(a))
}

private func matchNamedLocation(lat: Double, lon: Double) -> (name: String, address: String, city: String)? {
    for loc in namedLocations {
        if haversineKm(lat, lon, loc.lat, loc.lon) <= 0.15 {
            return (loc.name, loc.address, loc.city)
        }
    }
    return nil
}

// MARK: - Current context (exposed for message metadata)

struct LocationContext {
    let placeName: String?
    let activity: String?
    let arrivedAt: Date
}

// MARK: - SwiftData model for local buffer

@Model
final class CachedLocationSegment {
    @Attribute(.unique) var localId: UUID
    var segmentType: String
    var latitude: Double
    var longitude: Double
    var accuracyM: Double?
    var arrivedAt: Date
    var departedAt: Date?
    var activity: String?
    var confidence: String?
    var placeName: String?
    var placeType: String?
    var address: String?
    var neighborhood: String?
    var city: String?
    var synced: Bool
    var remoteId: String?
    var needsDepartureUpdate: Bool

    init(
        segmentType: String, latitude: Double, longitude: Double, accuracyM: Double?,
        arrivedAt: Date, departedAt: Date?, activity: String?, confidence: String?,
        placeName: String?, placeType: String?, address: String?,
        neighborhood: String?, city: String?
    ) {
        self.localId = UUID()
        self.segmentType = segmentType
        self.latitude = latitude
        self.longitude = longitude
        self.accuracyM = accuracyM
        self.arrivedAt = arrivedAt
        self.departedAt = departedAt
        self.activity = activity
        self.confidence = confidence
        self.placeName = placeName
        self.placeType = placeType
        self.address = address
        self.neighborhood = neighborhood
        self.city = city
        self.synced = false
        self.remoteId = nil
        self.needsDepartureUpdate = false
    }

    fileprivate func toRow() -> LocationHistoryRow {
        LocationHistoryRow(
            segment_type: segmentType,
            latitude: latitude,
            longitude: longitude,
            accuracy_m: accuracyM,
            arrived_at: arrivedAt.ISO8601Format(),
            departed_at: departedAt?.ISO8601Format(),
            activity: activity,
            confidence: confidence,
            place_name: placeName,
            place_type: placeType,
            address: address,
            neighborhood: neighborhood,
            city: city,
            device_id: Install.locationDeviceId
        )
    }
}

// MARK: - Supabase row types

private struct LocationHistoryRow: Encodable {
    let segment_type: String
    let latitude: Double
    let longitude: Double
    let accuracy_m: Double?
    let arrived_at: String
    let departed_at: String?
    let activity: String?
    let confidence: String?
    let place_name: String?
    let place_type: String?
    let address: String?
    let neighborhood: String?
    let city: String?
    let device_id: String
}

private struct SupabaseReturnRow: Decodable {
    let id: String
    let arrived_at: String
}

// MARK: - LocationTracker (iOS only — tracking runs on the user's iPhone)

#if os(iOS)

final class LocationTracker: NSObject, CLLocationManagerDelegate {
    static let shared = LocationTracker()

    private let manager = CLLocationManager()
    private let geocoder = CLGeocoder()
    private let motionManager = CMMotionActivityManager()

    private var modelContainer: ModelContainer?
    private var modelContext: ModelContext?

    private let supabase = SupabaseManager.shared

    /// Current context for message metadata enrichment.
    private(set) var currentContext: LocationContext?

    /// Last recorded activity type (to coalesce changes).
    private var lastActivityType: String?

    /// Most recent open visit segment (for departure updates).
    private var currentVisitLocalId: UUID?

    /// Consecutive waypoints in a row that have landed outside the open
    /// visit's departure radius. See closeOpenVisitIfMovedAway — a single
    /// stray fix (GPS multipath, one bad reading) must not close a visit by
    /// itself; only sustained displacement across more than one fix should.
    private var awayFixStreak = 0

    /// Last 30 visit coordinates, for deduping audio-context sampling. We only
    /// fire the ambient sampler at the start of visits to *new* places — Home,
    /// office, and regular spots don't need re-sampling on every arrival.
    private var recentVisitFingerprints: [(lat: Double, lon: Double)] = []
    private let recentVisitFingerprintLimit = 30
    /// Two visits within ~150m are treated as the same place.
    private let visitDedupeKm: Double = 0.15

    /// Minimum interval between transit waypoints (even when moving).
    private let transitMinInterval: TimeInterval = 120 // 2 minutes
    /// Max silence before recording a heartbeat at the same location.
    private let heartbeatInterval: TimeInterval = 3600 // 1 hour
    /// Distance threshold for "same place" dedup.
    private let sameLocationKm: Double = 0.005 // 5m
    private var lastTransitTimestamp: Date?
    private var lastRecordedLat: Double?
    private var lastRecordedLon: Double?

    private var syncTimer: Timer?
    private var accuracyPingTimer: Timer?
    private var isTracking = false

    // MARK: - Out-and-about mode
    //
    // The tracker's whole power profile assumes the interesting thing is
    // "arriving somewhere", so it sits on cell-radio accuracy and pings
    // occasionally. That is right when the user is home and wrong the moment the user is
    // out: a ~370m walk each way, there and back, and the *entire round trip* produced no location rows —
    // 370m is far below the noise floor of a 3km-accuracy request, the user had been
    // classified `stationary`, so the stationary skip held GPS off for up to 20
    // minutes at a stretch, and nothing ever contradicted the classification
    // because there were no fixes to contradict it with. Jori had nothing to
    // say about the walk because it did not know it happened.
    //
    // So the base gets a geofence. iOS wakes the app on region exit reliably —
    // even after termination — which makes "the user left the rental" a hard trigger
    // rather than something inferred from fixes we are not collecting. While
    // out, accuracy goes fine, pings go frequent, and the stationary skip is
    // disabled. Coming back re-enters the cheap profile, so the battery cost is
    // bounded to time actually spent out of the house.
    private var isOutAndAbout = false
    private static let baseRegionId = Install.key("base")
    /// Comfortably larger than GPS jitter at rest, comfortably smaller than the
    /// 250m the server-side `excursion` sensor treats as "out".
    private let baseRegionRadiusM: CLLocationDistance = 120
    private var baseRegionCenter: CLLocationCoordinate2D?

    override init() {
        super.init()
        setupSwiftData()
    }

    // MARK: - Setup

    private func setupSwiftData() {
        do {
            let schema = Schema([CachedLocationSegment.self])
            let config = ModelConfiguration(
                "\(Install.storagePrefix)_location",
                schema: schema,
                url: URL.applicationSupportDirectory.appending(path: "\(Install.storagePrefix)_location.store")
            )
            modelContainer = try ModelContainer(for: schema, configurations: [config])
            modelContext = ModelContext(modelContainer!)
            modelContext?.autosaveEnabled = true
        } catch {
            print("[LocationTracker] SwiftData setup failed: \(error)")
        }
    }

    func startTracking() {
        guard !isTracking else { return }
        isTracking = true

        manager.delegate = self

        // Request permission first, then configure background modes after authorization
        let status = manager.authorizationStatus
        print("[LocationTracker] Current auth status: \(status.rawValue)")

        switch status {
        case .notDetermined:
            // Must request WhenInUse first, then Always in the delegate callback
            print("[LocationTracker] Requesting WhenInUse (step 1 of 2)")
            manager.requestWhenInUseAuthorization()
            return // Will continue in didChangeAuthorization
        case .authorizedWhenInUse:
            // Upgrade to Always — this SHOULD show the system prompt
            print("[LocationTracker] Requesting Always upgrade from WhenInUse")
            manager.requestAlwaysAuthorization()
            // Continue to start monitoring even with WhenInUse (works in foreground)
        case .authorizedAlways:
            print("[LocationTracker] Already authorized Always")
        default:
            print("[LocationTracker] Authorization denied or restricted: \(status.rawValue)")
        }

        beginMonitoring()
    }

    private var isMonitoring = false

    private func beginMonitoring() {
        guard !isMonitoring else { return }
        isMonitoring = true

        let status = manager.authorizationStatus
        let bgModes = Bundle.main.infoDictionary?["UIBackgroundModes"] as? [String] ?? []
        if status == .authorizedAlways && bgModes.contains("location") {
            manager.allowsBackgroundLocationUpdates = true
            manager.pausesLocationUpdatesAutomatically = false
            manager.showsBackgroundLocationIndicator = false
        }

        manager.startMonitoringVisits()
        manager.startMonitoringSignificantLocationChanges()

        // Baseline accuracy depends on whether the user is home or out — see
        // `isOutAndAbout`. At base this is cell-radio only, near-zero battery.
        manager.desiredAccuracy = baselineAccuracy
        manager.distanceFilter = kCLDistanceFilterNone
        manager.startUpdatingLocation()

        // Re-arm the base geofence across app launches: region monitoring
        // survives termination, but our in-memory notion of where base is does
        // not, and a stale region would report exits from a city the user has left.
        Task { @MainActor in self.restoreBaseRegion() }

        startAccuracyPingTimer()
        startActivityMonitoring()
        startSyncTimer()
        restoreCurrentContext()

        print("[LocationTracker] Monitoring started (always=\(status == .authorizedAlways))")
    }

    // MARK: - CLLocationManagerDelegate

    nonisolated func locationManager(_ manager: CLLocationManager, didVisit visit: CLVisit) {
        let lat = visit.coordinate.latitude
        let lon = visit.coordinate.longitude
        let accuracy = visit.horizontalAccuracy
        let arrival = visit.arrivalDate == .distantPast ? Date() : visit.arrivalDate
        let departure = visit.departureDate == .distantFuture ? nil : visit.departureDate

        Task { @MainActor in
            #if os(iOS)
            PhoneLockMonitor.shared.sample(source: "visit")
            #endif
            await self.handleVisit(lat: lat, lon: lon, accuracy: accuracy, arrival: arrival, departure: departure)
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let location = locations.last else { return }
        let lat = location.coordinate.latitude
        let lon = location.coordinate.longitude
        let accuracy = location.horizontalAccuracy
        let timestamp = location.timestamp

        Task { @MainActor in
            #if os(iOS)
            PhoneLockMonitor.shared.sample(source: "location")
            // Awake for location far more often than iOS delivers silent pushes;
            // pick up any pending photo probe here (throttled to 2 min inside).
            Task { await PhotoProbeResponder.shared.runIfDue() }
            #endif
            await self.handleTransitWaypoint(lat: lat, lon: lon, accuracy: accuracy, timestamp: timestamp)
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didChangeAuthorization status: CLAuthorizationStatus) {
        print("[LocationTracker] Auth changed to: \(status.rawValue)")
        Task { @MainActor in
            switch status {
            case .authorizedWhenInUse:
                // Step 2: now upgrade to Always
                print("[LocationTracker] Got WhenInUse — requesting Always upgrade")
                self.manager.requestAlwaysAuthorization()
                self.beginMonitoring()
            case .authorizedAlways:
                print("[LocationTracker] Got Always — starting full background monitoring")
                self.beginMonitoring()
            default:
                break
            }
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        print("[LocationTracker] Location error: \(error.localizedDescription)")
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didExitRegion region: CLRegion) {
        guard region.identifier == Self.baseRegionId else { return }
        Task { @MainActor in self.enterOutAndAboutMode() }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didEnterRegion region: CLRegion) {
        guard region.identifier == Self.baseRegionId else { return }
        Task { @MainActor in self.leaveOutAndAboutMode() }
    }

    nonisolated func locationManager(_ manager: CLLocationManager,
                                     monitoringDidFailFor region: CLRegion?, withError error: Error) {
        print("[LocationTracker] Region monitoring failed for \(region?.identifier ?? "nil"): \(error.localizedDescription)")
    }

    // MARK: - Base geofence

    /// Anchor the base on a place the user actually settled at. CLVisit is iOS's own
    /// notion of "stayed a while", which is exactly the right signal and costs
    /// nothing extra — we are already handling these.
    @MainActor
    private func setBaseRegion(lat: Double, lon: Double) {
        guard CLLocationManager.isMonitoringAvailable(for: CLCircularRegion.self) else { return }
        let center = CLLocationCoordinate2D(latitude: lat, longitude: lon)
        // Don't churn the region for jitter around the same spot — re-registering
        // resets iOS's state machine and can drop an exit event.
        if let existing = baseRegionCenter,
           haversineKm(existing.latitude, existing.longitude, lat, lon) * 1000 < baseRegionRadiusM / 2 {
            return
        }
        for region in manager.monitoredRegions where region.identifier == Self.baseRegionId {
            manager.stopMonitoring(for: region)
        }
        let region = CLCircularRegion(center: center, radius: baseRegionRadiusM, identifier: Self.baseRegionId)
        region.notifyOnEntry = true
        region.notifyOnExit = true
        manager.startMonitoring(for: region)
        baseRegionCenter = center
        UserDefaults.standard.set([lat, lon], forKey: Install.key("baseRegion"))
        // Settling somewhere ends the outing, even if the exit/enter pair got
        // lost (region events are reliable but not guaranteed).
        leaveOutAndAboutMode()
        print("[LocationTracker] Base region set at \(lat), \(lon)")
    }

    @MainActor
    private func restoreBaseRegion() {
        guard let stored = UserDefaults.standard.array(forKey: Install.key("baseRegion")) as? [Double],
              stored.count == 2 else { return }
        baseRegionCenter = nil // force a real registration
        setBaseRegion(lat: stored[0], lon: stored[1])
    }

    // MARK: - Mode switching

    /// Accuracy floor for the current mode. Fine while out, cell-radio at base.
    /// Baseline accuracy by mode.
    ///
    /// AT BASE THIS USED TO BE `kCLLocationAccuracyThreeKilometers`, and that
    /// was not a cheap setting — it was a setting that produced nothing. Three
    /// kilometres cannot identify a building, a street or a block, and the
    /// server pipeline discards any fix over 60m accuracy, so every fix coarse
    /// mode generated was thrown away on arrival: battery spent, zero
    /// information. On 2026-08-10 it emitted one fix at **1414m** and that was
    /// the entire record of an hour outdoors.
    ///
    /// `HundredMeters` still resolves from wifi/cell rather than waking GPS, so
    /// the power story is nearly unchanged, but the fixes are usable.
    private var baselineAccuracy: CLLocationAccuracy {
        kCLLocationAccuracyHundredMeters
    }

    /// How long fine mode survives after re-entering base.
    ///
    /// Crossing the geofence is not the same as being home: a shop 100m from
    /// the door sits inside the 120m base region, so the stop AND the walk home
    /// after re-entering both happened in the blind spot that opened the
    /// instant the boundary was crossed. Holding fine mode briefly
    /// keeps the tail of an outing instead of truncating it.
    private static let baseGraceSeconds: TimeInterval = 600
    private var baseGraceTimer: Timer?

    @MainActor
    private func enterOutAndAboutMode() {
        // Leaving again cancels a pending downgrade — otherwise a quick dip
        // into the base region arms the timer and it fires mid-outing, dropping
        // to low power while the user is still out.
        if baseGraceTimer != nil {
            baseGraceTimer?.invalidate()
            baseGraceTimer = nil
            print("[LocationTracker] Left base again — cancelled pending downgrade")
        }
        guard !isOutAndAbout else { return }
        isOutAndAbout = true
        manager.desiredAccuracy = baselineAccuracy
        restartAccuracyPingTimer()
        print("[LocationTracker] Left base — out-and-about mode (fine accuracy, 60s pings, no stationary skip)")
        // Push what we have immediately. Leaving is the moment Jori most
        // wants a current position, and waiting up to 5 minutes for the sync
        // timer would spend the freshness this mode exists to buy.
        Task { @MainActor in await self.flushUnsynced() }
    }

    @MainActor
    private func leaveOutAndAboutMode() {
        guard isOutAndAbout else { return }
        // GRACE, not an immediate downgrade. Crossing back into the base region
        // is a claim about geometry, not about whether the outing is over — the
        // walk home from a shop 100m away happens entirely inside it.
        guard baseGraceTimer == nil else { return }
        print("[LocationTracker] Entered base — holding fine mode for \(Int(Self.baseGraceSeconds))s")
        baseGraceTimer = Timer.scheduledTimer(withTimeInterval: Self.baseGraceSeconds,
                                              repeats: false) { [weak self] _ in
            Task { @MainActor in self?.commitLeaveOutAndAboutMode() }
        }
    }

    @MainActor
    private func commitLeaveOutAndAboutMode() {
        baseGraceTimer?.invalidate()
        baseGraceTimer = nil
        guard isOutAndAbout else { return }
        isOutAndAbout = false
        manager.desiredAccuracy = baselineAccuracy
        restartAccuracyPingTimer()
        print("[LocationTracker] Back at base — low-power mode")
        Task { @MainActor in await self.flushUnsynced() }
    }

    // MARK: - Visit handling

    @MainActor
    private func handleVisit(lat: Double, lon: Double, accuracy: Double, arrival: Date, departure: Date?) async {
        guard let ctx = modelContext else { return }
        expireStaleOpenSegment()

        if let departure = departure {
            // Visit departure — update existing open segment or update/create one
            if let openId = currentVisitLocalId {
                let descriptor = FetchDescriptor<CachedLocationSegment>(
                    predicate: #Predicate { $0.localId == openId }
                )
                // Only if THIS CLVisit is the open segment's visit (2026-10-08).
                // A stale pointer used to take any later departure: a stop
                // once got its departed_at from a different visit a day later.
                if let open = try? ctx.fetch(descriptor).first,
                   isSameVisit(open, lat: lat, lon: lon, arrival: arrival),
                   departure > open.arrivedAt {
                    open.departedAt = departure
                    if open.synced {
                        open.needsDepartureUpdate = true
                        open.synced = false
                    }
                    try? ctx.save()
                    currentVisitLocalId = nil
                    currentContext = nil
                    return
                }
                // A different visit: the open pointer is stale. Drop it and treat
                // this departure as its own visit below.
                print("[LocationTracker] departure is not the open segment's visit — clearing stale pointer")
                currentVisitLocalId = nil
                currentContext = nil
            }
            // No tracked open segment. Before creating a fresh "completed" row,
            // dedupe against an existing visit at this place + minute — iOS
            // sometimes fires the visit lifecycle as both an arrival/departure
            // pair AND a single "completed" CLVisit, which used to produce two
            // rows per stop in location_history (~25% duplication rate prior
            // to this fix). Find any visit at this place arrived within ±60s
            // of `arrival` and update its departure instead.
            if let existing = findRecentVisit(lat: lat, lon: lon, near: arrival, in: ctx) {
                let prevDep = existing.departedAt ?? .distantPast
                if departure > prevDep && departure > existing.arrivedAt {
                    existing.departedAt = departure
                    if existing.synced {
                        existing.needsDepartureUpdate = true
                        existing.synced = false
                    }
                    try? ctx.save()
                }
                currentVisitLocalId = nil
                currentContext = nil
                return
            }
            let geo = await reverseGeocode(lat: lat, lon: lon)
            let segment = CachedLocationSegment(
                segmentType: "visit", latitude: lat, longitude: lon, accuracyM: accuracy,
                arrivedAt: arrival, departedAt: departure,
                activity: "stationary", confidence: "high",
                placeName: geo.placeName, placeType: geo.placeType,
                address: geo.address, neighborhood: geo.neighborhood, city: geo.city
            )
            ctx.insert(segment)
            try? ctx.save()
            currentVisitLocalId = nil
            currentContext = nil
        } else {
            // Visit arrival — the user has settled somewhere, so this is the new base.
            // CLVisit is iOS's own "stayed a while" judgement, which is exactly
            // the anchor the server-side `excursion` sensor reasons about, and
            // re-anchoring here means the geofence follows them across cities
            // without anything needing to know what "home" means on this trip.
            setBaseRegion(lat: lat, lon: lon)

            // Open a new segment, but dedupe first against any existing visit
            // at this place arrived within ±60s.
            if let existing = findRecentVisit(lat: lat, lon: lon, near: arrival, in: ctx) {
                currentVisitLocalId = existing.localId
                awayFixStreak = 0
                currentContext = LocationContext(
                    placeName: existing.placeName,
                    activity: existing.activity ?? "stationary",
                    arrivedAt: existing.arrivedAt
                )
                return
            }
            let geo = await reverseGeocode(lat: lat, lon: lon)
            let segment = CachedLocationSegment(
                segmentType: "visit", latitude: lat, longitude: lon, accuracyM: accuracy,
                arrivedAt: arrival, departedAt: nil,
                activity: "stationary", confidence: "high",
                placeName: geo.placeName, placeType: geo.placeType,
                address: geo.address, neighborhood: geo.neighborhood, city: geo.city
            )
            ctx.insert(segment)
            try? ctx.save()
            currentVisitLocalId = segment.localId
            awayFixStreak = 0
            currentContext = LocationContext(
                placeName: geo.placeName,
                activity: "stationary",
                arrivedAt: arrival
            )

            #if os(iOS)
            if isNewPlace(lat: lat, lon: lon) {
                rememberVisit(lat: lat, lon: lon)
                Task {
                    await PhoneContextPublisher.publish(
                        trigger: .visit, latitude: lat, longitude: lon
                    )
                }
            }
            #endif
        }
    }

    /// Same CLVisit as an open segment: arrival within `sameVisitArrivalTolerance`
    /// and position within the visit radius. iOS re-delivers a visit with its
    /// departure filled in; anything else is another visit.
    private let sameVisitArrivalTolerance: TimeInterval = 15 * 60
    private let sameVisitMaxKm = 0.2
    /// An open segment older than this is never the visit a departure belongs
    /// to — iOS has long since moved on (or the departure was lost).
    private let openSegmentMaxAge: TimeInterval = 18 * 3600

    private func isSameVisit(_ open: CachedLocationSegment, lat: Double, lon: Double, arrival: Date) -> Bool {
        abs(open.arrivedAt.timeIntervalSince(arrival)) <= sameVisitArrivalTolerance
            && haversineKm(open.latitude, open.longitude, lat, lon) <= sameVisitMaxKm
    }

    /// Clears `currentVisitLocalId` when it points at a segment opened more than
    /// `openSegmentMaxAge` ago, so it can never absorb a later departure.
    private func expireStaleOpenSegment(now: Date = Date()) {
        guard let openId = currentVisitLocalId, let ctx = modelContext else { return }
        let descriptor = FetchDescriptor<CachedLocationSegment>(predicate: #Predicate { $0.localId == openId })
        guard let open = try? ctx.fetch(descriptor).first else { currentVisitLocalId = nil; return }
        if now.timeIntervalSince(open.arrivedAt) > openSegmentMaxAge {
            print("[LocationTracker] open segment from \(open.arrivedAt) is over 18h old — no longer the current visit")
            currentVisitLocalId = nil
            currentContext = nil
        }
    }

    /// Find an existing visit segment at the same place (lat/lon within
    /// ~150m) whose arrival is within ±60s of `arrival`. Used to dedupe
    /// duplicate CLVisit callbacks before they hit Supabase.
    @MainActor
    private func findRecentVisit(lat: Double, lon: Double, near arrival: Date,
                                 in ctx: ModelContext) -> CachedLocationSegment? {
        let descriptor = FetchDescriptor<CachedLocationSegment>(
            predicate: #Predicate { $0.segmentType == "visit" },
            sortBy: [SortDescriptor(\.arrivedAt, order: .reverse)]
        )
        guard let recent = try? ctx.fetch(descriptor) else { return nil }
        for seg in recent.prefix(20) {
            if abs(seg.arrivedAt.timeIntervalSince(arrival)) > 60 { continue }
            if haversineKm(seg.latitude, seg.longitude, lat, lon) <= visitDedupeKm {
                return seg
            }
        }
        return nil
    }

    private func isNewPlace(lat: Double, lon: Double) -> Bool {
        for fp in recentVisitFingerprints {
            if haversineKm(lat, lon, fp.lat, fp.lon) <= visitDedupeKm {
                return false
            }
        }
        // Named locations (Home, …) are by definition not new.
        if matchNamedLocation(lat: lat, lon: lon) != nil {
            return false
        }
        return true
    }

    private func rememberVisit(lat: Double, lon: Double) {
        recentVisitFingerprints.append((lat, lon))
        if recentVisitFingerprints.count > recentVisitFingerprintLimit {
            recentVisitFingerprints.removeFirst(
                recentVisitFingerprints.count - recentVisitFingerprintLimit
            )
        }
    }

    // MARK: - Transit waypoint handling

    /// If the user has wandered well away from an open visit's center,
    /// close the visit ourselves. iOS's CLVisit sometimes fails to fire a
    /// departure when the user steps out for a short trip and returns —
    /// without this, the home/work visit can swallow the entire side trip
    /// (e.g. a 1h coffee outing showed up as overlapping the home stay).
    private let openVisitDepartureRadiusKm: Double = 0.2  // 200m
    private let openVisitDepartureGraceS: TimeInterval = 300 // 5 min away
    // A single fix landing outside the radius is a claim about geometry, not
    // confirmed movement — the same reasoning leaveOutAndAboutMode() already
    // applies on the way back IN (grace timer, not an immediate downgrade).
    // One bad GPS reading (multipath, a momentary jump of 1000m+ that
    // corrects itself on the very next fix) must not close a visit outright;
    // require the away reading to repeat before accepting it.
    private let awayFixConfirmCount = 2

    @MainActor
    private func closeOpenVisitIfMovedAway(lat: Double, lon: Double, timestamp: Date) {
        guard let openId = currentVisitLocalId, let ctx = modelContext else { return }
        let descriptor = FetchDescriptor<CachedLocationSegment>(
            predicate: #Predicate { $0.localId == openId }
        )
        guard let open = try? ctx.fetch(descriptor).first, open.departedAt == nil else { return }
        let dist = haversineKm(lat, lon, open.latitude, open.longitude)
        guard dist > openVisitDepartureRadiusKm else {
            // Back within radius — whatever pushed us outside it (real dip
            // outside, or a stray fix) is over. Don't let a bad fix from
            // minutes ago count toward closing a visit after the user is already
            // back.
            awayFixStreak = 0
            return
        }
        awayFixStreak += 1
        guard awayFixStreak >= awayFixConfirmCount else { return }
        awayFixStreak = 0
        // Backdate the departure so this transit waypoint sits AFTER the
        // visit, not within it. The grace window approximates how long it
        // took us to notice we'd left (since significant-location changes
        // don't fire instantly).
        let synthDep = timestamp.addingTimeInterval(-openVisitDepartureGraceS)
        let safeDep = max(synthDep, open.arrivedAt.addingTimeInterval(60))
        open.departedAt = safeDep
        if open.synced {
            open.needsDepartureUpdate = true
            open.synced = false
        }
        try? ctx.save()
        currentVisitLocalId = nil
        currentContext = nil
    }

    @MainActor
    private func handleTransitWaypoint(lat: Double, lon: Double, accuracy: Double, timestamp: Date) async {
        // Close any open visit that this waypoint is far from. Must run on
        // every waypoint, not just recorded ones, so the visit closes
        // promptly even if dedupe later short-circuits the record.
        closeOpenVisitIfMovedAway(lat: lat, lon: lon, timestamp: timestamp)

        // App-open confirmed-location capture (see requestForegroundConfirmFix).
        // The user is present, so force-record the first accurate fix of the
        // foreground window even when the transit dedup would skip it, and stamp
        // it to phone_context as a GPS-anchored present-here signal. Then drop
        // back to whatever the current mode's baseline is — coarse at base,
        // still fine while the user is out.
        if pendingForegroundConfirm && accuracy >= 0 && accuracy <= foregroundConfirmMaxAccuracyM {
            pendingForegroundConfirm = false
            manager.desiredAccuracy = baselineAccuracy
            recordTransit(lat: lat, lon: lon, accuracy: accuracy, timestamp: timestamp)
            Task { await PhoneContextPublisher.publish(trigger: .foreground, latitude: lat, longitude: lon) }
            return
        }

        guard let last = lastTransitTimestamp else {
            // First sample ever — always record
            recordTransit(lat: lat, lon: lon, accuracy: accuracy, timestamp: timestamp)
            return
        }

        let elapsed = timestamp.timeIntervalSince(last)
        if elapsed < transitMinInterval { return }

        let moved = lastRecordedLat == nil ||
            haversineKm(lat, lon, lastRecordedLat!, lastRecordedLon!) > sameLocationKm

        if moved {
            recordTransit(lat: lat, lon: lon, accuracy: accuracy, timestamp: timestamp)
        } else if elapsed >= heartbeatInterval {
            recordTransit(lat: lat, lon: lon, accuracy: accuracy, timestamp: timestamp)
        }
        // Same place, within heartbeat window → skip
    }

    @MainActor
    private func recordTransit(lat: Double, lon: Double, accuracy: Double, timestamp: Date) {
        lastTransitTimestamp = timestamp
        let moved = lastRecordedLat != nil &&
            haversineKm(lat, lon, lastRecordedLat!, lastRecordedLon!) > sameLocationKm
        lastRecordedLat = lat
        lastRecordedLon = lon
        if moved { stationarySkipCount = 0 }

        guard let ctx = modelContext else { return }

        let segment = CachedLocationSegment(
            segmentType: "transit", latitude: lat, longitude: lon, accuracyM: accuracy,
            arrivedAt: timestamp, departedAt: nil,
            activity: lastActivityType, confidence: nil,
            placeName: nil, placeType: "transit",
            address: nil, neighborhood: nil, city: nil
        )
        ctx.insert(segment)
        try? ctx.save()

        if currentVisitLocalId == nil {
            currentContext = LocationContext(
                placeName: nil,
                activity: lastActivityType ?? "unknown",
                arrivedAt: timestamp
            )
        }

        // Update LocationManager's lastKnownLocation for message metadata
        LocationManager.shared.lastKnownLocation = LocationManager.LocationResult(
            latitude: lat, longitude: lon, accuracy: accuracy, timestamp: timestamp
        )
    }

    // MARK: - Activity monitoring

    /// Shared CMMotionActivity → string mapping. Used here and by
    /// PhoneContextPublisher's one-shot motion read.
    static func motionType(from activity: CMMotionActivity) -> String {
        if activity.automotive { return "driving" }
        if activity.cycling { return "cycling" }
        if activity.running { return "running" }
        if activity.walking { return "walking" }
        if activity.stationary { return "stationary" }
        return "unknown"
    }

    private func startActivityMonitoring() {
        guard CMMotionActivityManager.isActivityAvailable() else {
            print("[LocationTracker] Motion activity not available")
            return
        }

        motionManager.startActivityUpdates(to: .main) { [weak self] activity in
            guard let self = self, let activity = activity else { return }

            let type = LocationTracker.motionType(from: activity)
            guard type != self.lastActivityType else { return }
            let wasStill = (self.lastActivityType == "stationary" || self.lastActivityType == nil)
            self.lastActivityType = type
            self.startAccuracyPingTimer()

            // STARTING TO MOVE IS THE EVENT, so take a fix NOW rather than
            // waiting out the interval. Re-arming the timer only schedules the
            // next ping — up to five minutes away at base — which is why the
            // five-minute walk home from the supermarket on 2026-08-10 left no
            // trace at all: the stationary→walking transition happened, and the
            // first fix after it would have arrived long after the user was indoors.
            let movingNow = ["walking", "running", "cycling", "driving"].contains(type)
            if wasStill && movingNow {
                self.stationarySkipCount = 0
                let baseline = self.baselineAccuracy
                // Accuracy bump ONLY — deliberately not `requestLocation()`,
                // which delivers a single fix and then STOPS, and is documented
                // as not to be mixed with active continuous updates. Killing
                // `startUpdatingLocation` would be a far worse regression than
                // the gap this fixes. Raising desiredAccuracy is the same lever
                // the ping timer already uses to force a fresh callback.
                self.manager.desiredAccuracy = kCLLocationAccuracyNearestTenMeters
                DispatchQueue.main.asyncAfter(deadline: .now() + 8) { [weak self] in
                    self?.manager.desiredAccuracy = baseline
                }
                print("[LocationTracker] Motion resumed (\(type)) — forcing a fix")
            }

            if let ctx = self.currentContext {
                self.currentContext = LocationContext(
                    placeName: ctx.placeName,
                    activity: type,
                    arrivedAt: ctx.arrivedAt
                )
            }
        }
    }

    // MARK: - Reverse geocoding

    private struct GeoResult {
        let placeName: String?
        let placeType: String?
        let address: String?
        let neighborhood: String?
        let city: String?
    }

    private func reverseGeocode(lat: Double, lon: Double) async -> GeoResult {
        // Tier 1: Named locations
        if let named = matchNamedLocation(lat: lat, lon: lon) {
            return GeoResult(
                placeName: named.name, placeType: "named",
                address: named.address, neighborhood: nil, city: named.city
            )
        }

        // Tier 2: Apple CLGeocoder
        let location = CLLocation(latitude: lat, longitude: lon)
        do {
            let placemarks = try await geocoder.reverseGeocodeLocation(location)
            guard let pm = placemarks.first else {
                return GeoResult(placeName: nil, placeType: nil, address: nil, neighborhood: nil, city: nil)
            }

            let street = [pm.subThoroughfare, pm.thoroughfare]
                .compactMap { $0 }
                .joined(separator: " ")

            // Deliberately ignore pm.areasOfInterest — CLGeocoder returns
            // low-confidence labels there (e.g. bare borough names like
            // "Manhattan" for an arbitrary West Village address). Only Tier 1
            // (named locations) and the server-side enrich flow are allowed
            // to set POI-level place_type. Client writes "address" at most.
            return GeoResult(
                placeName: street.isEmpty ? nil : street,
                placeType: street.isEmpty ? nil : "address",
                address: street.isEmpty ? nil : street,
                neighborhood: pm.subLocality,
                city: pm.locality
            )
        } catch {
            print("[LocationTracker] Geocoding failed: \(error.localizedDescription)")
            return GeoResult(placeName: nil, placeType: nil, address: nil, neighborhood: nil, city: nil)
        }
    }

    // MARK: - Sync engine

    private let syncBatchSize = 50

    @MainActor
    func flushUnsynced() async {
        guard let ctx = modelContext else { return }

        do {
            try await SupabaseManager.ensureAuthenticated()
        } catch {
            print("[LocationTracker] Auth failed, skipping sync: \(error)")
            return
        }

        let descriptor = FetchDescriptor<CachedLocationSegment>(
            predicate: #Predicate { $0.synced == false }
        )
        guard let unsynced = try? ctx.fetch(descriptor), !unsynced.isEmpty else { return }

        let newInserts = unsynced.filter { !$0.needsDepartureUpdate }
        let departureUpdates = unsynced.filter { $0.needsDepartureUpdate && $0.remoteId != nil }

        // Batch insert in chunks to avoid large payloads on reconnect
        for batchStart in stride(from: 0, to: newInserts.count, by: syncBatchSize) {
            let batchEnd = min(batchStart + syncBatchSize, newInserts.count)
            let batch = Array(newInserts[batchStart..<batchEnd])
            let rows = batch.map { $0.toRow() }
            do {
                let inserted: [SupabaseReturnRow] = try await supabase
                    .from("location_history")
                    .insert(rows)
                    .select("id, arrived_at")
                    .execute()
                    .value

                for (local, remote) in zip(batch, inserted) {
                    local.synced = true
                    local.remoteId = remote.id
                }
                try? ctx.save()
                print("[LocationTracker] Synced batch of \(batch.count) segment(s)")
            } catch {
                print("[LocationTracker] Insert sync failed: \(error)")
                break
            }
        }

        // Update departures
        for segment in departureUpdates {
            guard let departedAt = segment.departedAt else { continue }
            do {
                try await supabase
                    .from("location_history")
                    .update(["departed_at": departedAt.ISO8601Format()])
                    .eq("id", value: segment.remoteId!)
                    .execute()
                segment.needsDepartureUpdate = false
                segment.synced = true
                try? ctx.save()
            } catch {
                print("[LocationTracker] Departure update failed: \(error)")
            }
        }

        pruneOldSegmentsIfNeeded()
    }

    private var lastPruneDate: Date?

    @MainActor
    private func pruneOldSegmentsIfNeeded() {
        if let last = lastPruneDate, Date().timeIntervalSince(last) < 86400 { return }
        guard let ctx = modelContext else { return }
        let cutoff = Date().addingTimeInterval(-7 * 24 * 3600)
        let descriptor = FetchDescriptor<CachedLocationSegment>(
            predicate: #Predicate { $0.synced == true && $0.arrivedAt < cutoff }
        )
        guard let old = try? ctx.fetch(descriptor), !old.isEmpty else {
            lastPruneDate = Date()
            return
        }
        for segment in old {
            ctx.delete(segment)
        }
        try? ctx.save()
        lastPruneDate = Date()
        print("[LocationTracker] Pruned \(old.count) old segment(s)")
    }

    // MARK: - Teardown

    func stopTracking() {
        manager.stopUpdatingLocation()
        manager.stopMonitoringVisits()
        manager.stopMonitoringSignificantLocationChanges()
        for region in manager.monitoredRegions where region.identifier == Self.baseRegionId {
            manager.stopMonitoring(for: region)
        }
        baseRegionCenter = nil
        isOutAndAbout = false
        baseGraceTimer?.invalidate()
        baseGraceTimer = nil
        #if os(iOS)
        motionManager.stopActivityUpdates()
        #endif
        syncTimer?.invalidate()
        syncTimer = nil
        accuracyPingTimer?.invalidate()
        accuracyPingTimer = nil
        isMonitoring = false
    }

    deinit {
        #if os(iOS)
        motionManager.stopActivityUpdates()
        #endif
        syncTimer?.invalidate()
        accuracyPingTimer?.invalidate()
    }

    // MARK: - Accuracy ping (sleep/wake cycle)

    private var currentPingInterval: TimeInterval = 0
    private var stationarySkipCount = 0
    private let maxStationarySkips = 3

    private func pingIntervalForActivity(_ activity: String?) -> TimeInterval {
        // Out of the house, cadence is not a function of what the motion
        // classifier believes — it is 60s regardless. Being out IS the signal;
        // whether the user is walking or standing in a shop at that moment is
        // exactly what we are trying to find out.
        if isOutAndAbout { return 60 }
        switch activity {
        case "walking", "running", "cycling", "driving":
            return 120
        case "stationary":
            return 300
        default:
            // `unknown` is treated as possibly-moving, not as a slow default.
            // Nearly every row from the 2026-08-03 vet walk carried `unknown`,
            // because the classifier needs fixes to see motion and the slow
            // cadence was not producing them — the classification and the
            // sampling rate were starving each other.
            return 120
        }
    }

    /// Briefly bump to high accuracy to force a fresh location callback,
    /// then drop back to cell-radio-only. Skips GPS wake when stationary
    /// and recent pings produced no movement (saves battery).
    private func startAccuracyPingTimer() {
        let interval = pingIntervalForActivity(lastActivityType)
        guard interval != currentPingInterval else { return }
        currentPingInterval = interval
        stationarySkipCount = 0
        accuracyPingTimer?.invalidate()
        accuracyPingTimer = Timer.scheduledTimer(withTimeInterval: interval, repeats: true) { [weak self] _ in
            guard let self else { return }
            // The stationary skip is a battery win at home and a blind spot on
            // a wander: 300s x 4 skips is up to 20 minutes without a fix, which
            // is how a 370m walk to the vet went entirely unrecorded. It only
            // applies at base now.
            if !self.isOutAndAbout
                && self.lastActivityType == "stationary"
                && self.stationarySkipCount < self.maxStationarySkips {
                self.stationarySkipCount += 1
                return
            }
            self.stationarySkipCount = 0
            let baseline = self.baselineAccuracy
            self.manager.desiredAccuracy = self.isOutAndAbout
                ? kCLLocationAccuracyNearestTenMeters
                : kCLLocationAccuracyHundredMeters
            DispatchQueue.main.asyncAfter(deadline: .now() + 6) { [weak self] in
                self?.manager.desiredAccuracy = baseline
            }
        }
    }

    /// Force the ping timer to re-arm at the current mode's cadence.
    /// `startAccuracyPingTimer` no-ops when the interval is unchanged, which is
    /// right for activity flips and wrong for a mode flip that must take effect
    /// now — without this, leaving base would keep the old 300s timer.
    @MainActor
    private func restartAccuracyPingTimer() {
        currentPingInterval = 0
        stationarySkipCount = 0
        startAccuracyPingTimer()
    }

    // MARK: - Periodic sync timer

    private func startSyncTimer() {
        syncTimer?.invalidate()
        syncTimer = Timer.scheduledTimer(withTimeInterval: 300, repeats: true) { [weak self] _ in
            Task { @MainActor in
                await self?.flushUnsynced()
            }
        }
    }

    // MARK: - Restore context on launch

    private func restoreCurrentContext() {
        guard let ctx = modelContext else { return }
        let descriptor = FetchDescriptor<CachedLocationSegment>(
            predicate: #Predicate { $0.segmentType == "visit" && $0.departedAt == nil },
            sortBy: [SortDescriptor(\.arrivedAt, order: .reverse)]
        )
        if let open = try? ctx.fetch(descriptor).first,
           Date().timeIntervalSince(open.arrivedAt) <= openSegmentMaxAge {
            currentVisitLocalId = open.localId
            currentContext = LocationContext(
                placeName: open.placeName,
                activity: open.activity ?? "stationary",
                arrivedAt: open.arrivedAt
            )
        }
    }

    // MARK: - App lifecycle

    /// Confirmed-location capture on app open (2026-06-28). When the app
    /// comes to the foreground the user is *present* and looking at the phone, so
    /// we force a fresh high-accuracy fix instead of relying on the coarse 3km
    /// background point. The first accurate fix inside the window is force-recorded
    /// (bypassing the transit dedup) and stamped to phone_context, giving
    /// daily-summary an accurate, user-present anchor for that moment — the thin
    /// 2-sample stops that made venue resolution a guess (e.g. the 2026-06-27
    /// Chinatown lunch) get a precise centroid. Accuracy drops back to cell-radio
    /// after the window to preserve battery.
    private var pendingForegroundConfirm = false
    private let foregroundConfirmWindowS: TimeInterval = 12
    private let foregroundConfirmMaxAccuracyM: Double = 100

    func onAppForeground() {
        Task { @MainActor in
            await flushUnsynced()
            requestForegroundConfirmFix()
        }
    }

    @MainActor
    private func requestForegroundConfirmFix() {
        guard isMonitoring else { return }
        pendingForegroundConfirm = true
        manager.desiredAccuracy = kCLLocationAccuracyBest
        // Failsafe: if no fix accurate enough lands within the window, restore
        // the CURRENT mode's baseline and clear the flag so we never sit on GPS.
        // (Hardcoding 3km here would have silently dropped out-and-about mode
        // back to cell-radio every time the user opened the app while walking.)
        DispatchQueue.main.asyncAfter(deadline: .now() + foregroundConfirmWindowS) { [weak self] in
            guard let self, self.pendingForegroundConfirm else { return }
            self.pendingForegroundConfirm = false
            self.manager.desiredAccuracy = self.baselineAccuracy
        }
    }
}

#else

// macOS stub — tracking only runs on the user's iPhone
final class LocationTracker {
    static let shared = LocationTracker()
    var currentContext: LocationContext? { nil }
    func startTracking() {}
    func onAppForeground() {}
}

#endif
