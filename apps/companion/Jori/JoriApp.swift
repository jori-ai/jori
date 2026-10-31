import SwiftUI
import UserNotifications
import Supabase

#if os(macOS)
import AppKit
#else
import UIKit
#endif

@main
struct JoriApp: App {
    #if os(macOS)
    @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate
    #else
    @UIApplicationDelegateAdaptor(AppDelegate.self) var appDelegate
    #endif

    @Environment(\.scenePhase) private var scenePhase

    #if os(macOS)
    @State private var isUnlocked = true
    #else
    @State private var isUnlocked = false
    #endif

    // nil = still checking Keychain for a persisted session; true/false once resolved.
    @State private var isSignedIn: Bool?

    var body: some Scene {
        WindowGroup {
            rootView
                .tint(JoriTheme.cobalt)
                .animation(.smooth(duration: 0.35), value: isSignedIn)
                .animation(.smooth(duration: 0.35), value: isUnlocked)
                // scenePhase starts out active, so its onChange never fires
                // for the first launch: start the watchdog here too.
                .onAppear { Responsiveness.shared.resume() }
                .task { isSignedIn = await SupabaseManager.hasSession() }
                .task { await SupabaseManager.mirrorOnTokenChanges() }
                #if os(macOS)
                // 480 = traffic lights + sidebar toggle + the channel tabs, with no title.
                .frame(minWidth: 480, minHeight: 480)
                #endif
        }
        #if os(macOS)
        .defaultSize(width: 1040, height: 780)
        .windowToolbarStyle(.unified)
        #endif
        .commands {
            SidebarCommands()   // View › Show/Hide Sidebar, ⌃⌘S
            JoriCommands()
        }
        .onChange(of: scenePhase) { _, newPhase in
            #if os(iOS)
            // macOS drives this from AppDelegate's activate/resign callbacks.
            if newPhase == .active {
                DeviceActivity.shared.becameActive()
            } else {
                DeviceActivity.shared.resignedActive()
            }
            if newPhase == .background {
                isUnlocked = false
                // Capture the freshest token right before suspension so the
                // JoriShare extension can post while the app is backgrounded.
                Task { await SupabaseManager.mirrorSessionForExtension() }
            }
            #endif
            if newPhase == .active {
                Responsiveness.shared.resume()
            } else {
                Responsiveness.shared.pause()
            }
            if newPhase == .active {
                UNUserNotificationCenter.current().setBadgeCount(0)
                LocationTracker.shared.onAppForeground()
                #if os(iOS)
                Task { await PhoneContextPublisher.publishOnForeground() }
                Task { @MainActor in
                    PhoneLockMonitor.shared.sample(source: "foreground")
                    await PhoneUsageMonitor.shared.uploadPending()
                }
                HealthKitManager.shared.syncOnForeground()
                Task { await PhotoProbeResponder.shared.run(reason: "foreground") }
                #endif
                Task { await SupabaseManager.mirrorSessionForExtension() }
            }
        }
    }

    @ViewBuilder
    private var rootView: some View {
        switch isSignedIn {
        case .none:
            // Brief splash while Supabase reads the Keychain session — the
            // same mark the sign-in and lock screens open on, so launch reads
            // as one continuous moment.
            SplashView()
                .transition(.opacity)
        case .some(false):
            SignInView {
                isSignedIn = true
                // Sign-in just happened via OS web auth → skip Face ID for this launch.
                isUnlocked = true
            }
        case .some(true):
            if isUnlocked {
                ContentView(onSignOut: {
                    Task {
                        await SupabaseManager.signOut()
                        await MainActor.run {
                            isSignedIn = false
                            #if os(iOS)
                            isUnlocked = false
                            #endif
                        }
                    }
                })
            } else {
                LockScreen(isUnlocked: $isUnlocked)
            }
        }
    }
}

extension Notification.Name {
    static let openJoriMessage = Notification.Name("openJoriMessage")
}

/// A message read on one device takes its banner off the others. The server
/// sends a silent push {kind: "clear_notifications", message_ids, badge} when a
/// pushed message flips to read (sendClearPush, lib/apns-push.mjs);
/// visible pushes carry `message_id`, so the matching delivered notifications
/// are removed and the icon badge is set to the server's count.
enum DeliveredNotifications {
    static func handle(_ userInfo: [AnyHashable: Any], completion: @escaping (Bool) -> Void) {
        guard userInfo["kind"] as? String == "clear_notifications",
              let ids = userInfo["message_ids"] as? [String] else {
            completion(false)
            return
        }
        let wanted = Set(ids.map { $0.lowercased() })
        let center = UNUserNotificationCenter.current()
        if let badge = userInfo["badge"] as? Int {
            center.setBadgeCount(badge) { _ in }
        }
        center.getDeliveredNotifications { delivered in
            let stale = delivered
                .filter { wanted.contains(($0.request.content.userInfo["message_id"] as? String ?? "").lowercased()) }
                .map(\.request.identifier)
            if !stale.isEmpty { center.removeDeliveredNotifications(withIdentifiers: stale) }
            completion(!stale.isEmpty)
        }
    }
}

#if os(macOS)

final class AppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    static var pendingMessageId: UUID?
    /// Set when a purchase-approval push arrives; ContentView consumes it.
    static var pendingPurchaseId: String?
    /// Set when a trade-approval push arrives (TradeApproval.swift).
    static var pendingApprovalRequest: TradeApproval.Request?

    private lazy var supabase = SupabaseManager.shared

    func applicationDidBecomeActive(_ notification: Notification) {
        NSApplication.shared.dockTile.badgeLabel = nil
        UNUserNotificationCenter.current().setBadgeCount(0) { _ in }
        DeviceActivity.shared.becameActive()
    }

    func applicationDidResignActive(_ notification: Notification) {
        DeviceActivity.shared.resignedActive()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        UNUserNotificationCenter.current().delegate = self
        PurchaseApproval.registerNotificationCategory()
        TradeApproval.registerNotificationCategory()
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound]) { granted, error in
            if let error = error {
                print("[APNs] Authorization error: \(error)")
                return
            }
            print("[APNs] Permission granted: \(granted)")
            if granted {
                DispatchQueue.main.async {
                    NSApplication.shared.registerForRemoteNotifications()
                }
            }
        }
    }

    /// Background pushes reach the Mac app only while it is running.
    func application(_ application: NSApplication, didReceiveRemoteNotification userInfo: [String: Any]) {
        DeliveredNotifications.handle(userInfo) { _ in }
    }

    func application(_ application: NSApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let token = deviceToken.map { String(format: "%02x", $0) }.joined()
        print("[APNs] Device token: \(token)")
        // TradeApproval.register() sends this token to the trading web app at pairing.
        UserDefaults.standard.set(token, forKey: Install.key("apnsDeviceToken"))
        saveDeviceToken(token)
    }

    func application(_ application: NSApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        print("[APNs] Failed to register: \(error)")
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        // Trade approval: straight to the blocking review sheet (Touch ID).
        if let request = TradeApproval.parse(notification.request.content.userInfo) {
            AppDelegate.pendingApprovalRequest = request
            NotificationCenter.default.post(name: .openTradeApproval, object: request)
            completionHandler([.banner, .sound])
            return
        }
        // Purchase approval: straight to the review sheet (Touch ID to approve).
        if let purchaseId = PurchaseApproval.purchaseId(from: notification.request.content.userInfo) {
            AppDelegate.pendingPurchaseId = purchaseId
            NotificationCenter.default.post(name: .openPurchaseApproval, object: purchaseId)
            completionHandler([.banner, .sound])
            return
        }
        if NSApplication.shared.isActive {
            completionHandler([])
        } else {
            completionHandler([.banner, .sound, .badge])
        }
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        // Opening a trade-approval push never approves; it shows the review.
        if let request = TradeApproval.parse(response.notification.request.content.userInfo) {
            AppDelegate.pendingApprovalRequest = request
            NotificationCenter.default.post(name: .openTradeApproval, object: request)
            NSApplication.shared.activate(ignoringOtherApps: true)
            completionHandler()
            return
        }
        // Opening a purchase-approval push never approves; it shows the review.
        if let purchaseId = PurchaseApproval.purchaseId(from: response.notification.request.content.userInfo) {
            AppDelegate.pendingPurchaseId = purchaseId
            NotificationCenter.default.post(name: .openPurchaseApproval, object: purchaseId)
            NSApplication.shared.activate(ignoringOtherApps: true)
            completionHandler()
            return
        }
        if let idString = response.notification.request.content.userInfo["message_id"] as? String,
           let uuid = UUID(uuidString: idString) {
            AppDelegate.pendingMessageId = uuid
            NotificationCenter.default.post(name: .openJoriMessage, object: uuid)
        }
        completionHandler()
    }

    private func saveDeviceToken(_ token: String) {
        Task {
            do {
                try await supabase
                    .from("device_tokens")
                    .upsert(
                        ["token": token, "platform": "macos", "updated_at": ISO8601DateFormatter().string(from: Date())],
                        onConflict: "token"
                    )
                    .execute()
                print("[APNs] Token saved to Supabase (platform: macos)")
            } catch {
                print("[APNs] Failed to save token: \(error)")
            }
        }
    }
}

#else

final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    static var pendingMessageId: UUID?
    /// Set when a trade-approval push arrives; consumed by ContentView once it's
    /// mounted. Needed because the push can fire while the Face-ID lock screen
    /// (not ContentView) is showing, so the in-app listener would otherwise miss it.
    static var pendingApprovalRequest: TradeApproval.Request?
    /// Same, for a purchase-approval push (PurchaseApproval.swift).
    static var pendingPurchaseId: String?

    private lazy var supabase = SupabaseManager.shared

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        TradeApproval.registerNotificationCategory()
        PurchaseApproval.registerNotificationCategory()

        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound]) { granted, error in
            if let error = error {
                print("[APNs] Authorization error: \(error)")
                return
            }
            print("[APNs] Permission granted: \(granted)")
            if granted {
                DispatchQueue.main.async {
                    UIApplication.shared.registerForRemoteNotifications()
                }
            }
        }

        // Start continuous location tracking (visits + activity detection)
        LocationTracker.shared.startTracking()

        // Request HealthKit authorization and start background delivery.
        // Clinical FHIR types were reverted (missing entitlement).
        // Kill-switch removed — the crash was from clinical types, not fitness sync.
        HealthKitManager.shared.start()

        // The photo roll, so a stop question can be answered from the photos
        // taken there before iCloud carries them to the host (PhotoProbeResponder;
        // only with the photo-probe feature).
        PhotoProbeResponder.requestAuthorizationIfNeeded()

        // Lock-state evidence for wake/sleep (PhoneLockMonitor) and, when the
        // Family Controls entitlement is present, Screen Time usage windows.
        Task { @MainActor in
            PhoneLockMonitor.shared.start()
            PhoneUsageMonitor.shared.startIfAuthorized()
        }

        return true
    }

    // Lock both iPhone and iPad to portrait at runtime. The iPad Info.plist
    // entry declares all four orientations because App Store Connect rejects
    // iPad apps with a narrower set ("must support iPad multitasking" — the
    // 2026-05-16 TestFlight upload was bounced for exactly this). Enforcing
    // the lock here keeps the iPad app portrait-only at runtime without
    // failing validation.
    func application(
        _ application: UIApplication,
        supportedInterfaceOrientationsFor window: UIWindow?
    ) -> UIInterfaceOrientationMask {
        .portrait
    }

    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        let token = deviceToken.map { String(format: "%02x", $0) }.joined()
        print("[APNs] Device token: \(token)")
        UserDefaults.standard.set(token, forKey: Install.key("apnsDeviceToken"))
        saveDeviceToken(token)
    }

    func application(
        _ application: UIApplication,
        didReceiveRemoteNotification userInfo: [AnyHashable: Any],
        fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void
    ) {
        // The server asking for the photos taken during a stop (PhotoProbeResponder):
        // answer before iOS's ~30 s background budget runs out.
        if userInfo["kind"] as? String == "photo_probe" {
            Task {
                let n = await PhotoProbeResponder.shared.run(reason: "push", budget: 24)
                completionHandler(n == nil ? .failed : (n! > 0 ? .newData : .noData))
            }
            return
        }
        if userInfo["kind"] as? String == "clear_notifications" {
            DeliveredNotifications.handle(userInfo) { cleared in completionHandler(cleared ? .newData : .noData) }
            return
        }
        completionHandler(.noData)
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        print("[APNs] Failed to register: \(error)")
    }

    // Suppress notifications when app is in foreground
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        // A trade-approval push that arrives while the app is open should surface
        // the blocking review screen immediately.
        if let request = TradeApproval.parse(notification.request.content.userInfo) {
            AppDelegate.pendingApprovalRequest = request
            NotificationCenter.default.post(name: .openTradeApproval, object: request)
            completionHandler([.sound])
            return
        }
        // Purchase approval: same — straight to the blocking review screen.
        if let purchaseId = PurchaseApproval.purchaseId(from: notification.request.content.userInfo) {
            AppDelegate.pendingPurchaseId = purchaseId
            NotificationCenter.default.post(name: .openPurchaseApproval, object: purchaseId)
            completionHandler([.sound])
            return
        }
        if UIApplication.shared.applicationState == .active {
            completionHandler([])  // silent — message already visible in chat
        } else {
            completionHandler([.banner, .sound, .badge])
        }
    }

    // User tapped a notification — deep-link to the related message
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let userInfo = response.notification.request.content.userInfo

        // Trade-approval push: opening it never approves. It surfaces the
        // blocking in-app review screen, where approval is an explicit,
        // Face-ID-gated action on the listed transactions.
        if let request = TradeApproval.parse(userInfo) {
            AppDelegate.pendingApprovalRequest = request
            NotificationCenter.default.post(name: .openTradeApproval, object: request)
            completionHandler()
            return
        }

        // Purchase-approval push: opening it never approves either.
        if let purchaseId = PurchaseApproval.purchaseId(from: userInfo) {
            AppDelegate.pendingPurchaseId = purchaseId
            NotificationCenter.default.post(name: .openPurchaseApproval, object: purchaseId)
            completionHandler()
            return
        }

        if let idString = userInfo["message_id"] as? String,
           let uuid = UUID(uuidString: idString) {
            AppDelegate.pendingMessageId = uuid
            NotificationCenter.default.post(name: .openJoriMessage, object: uuid)
        }
        completionHandler()
    }

    private func saveDeviceToken(_ token: String) {
        let platform = UIDevice.current.userInterfaceIdiom == .pad ? "ipados" : "ios"

        Task {
            do {
                try await supabase
                    .from("device_tokens")
                    .upsert(
                        ["token": token, "platform": platform, "updated_at": ISO8601DateFormatter().string(from: Date())],
                        onConflict: "token"
                    )
                    .execute()
                print("[APNs] Token saved to Supabase (platform: \(platform))")
            } catch {
                print("[APNs] Failed to save token: \(error)")
            }
        }
    }
}

#endif
