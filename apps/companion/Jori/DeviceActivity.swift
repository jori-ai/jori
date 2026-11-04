import Foundation
import Supabase

#if os(macOS)
import AppKit
#else
import UIKit
#endif

/// Tells the server which device the user is actively using, so pushes go only
/// there: while the Mac app is in use the phone stays quiet, and vice versa.
///
/// While in active use the app holds a short lease, `device_tokens.active_until`
/// on its own APNs token row, renewed every `renewEvery` seconds; leaving
/// active use sets it to now. lib/apns-push.mjs (selectPushTargets) sends
/// only to the active device class while a lease is live, and to every device
/// otherwise, so a crash, sleep or dead network just lets the lease lapse.
///
/// "Active use": iOS — the scene is active (screen on, app in front).
/// macOS — the app's window is frontmost; no input-idle check, so a focused window on
/// an unattended Mac does keep the phone silent until focus moves or the Mac
/// sleeps (the lease then lapses).
@MainActor
final class DeviceActivity {
    static let shared = DeviceActivity()

    private let lease: TimeInterval = 120
    private let renewEvery: TimeInterval = 45

    private var timer: Timer?
    private var leaseHeld = false

    /// App came to the foreground (iOS scene active / macOS app activated).
    func becameActive() {
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: renewEvery, repeats: true) { _ in
            Task { @MainActor in DeviceActivity.shared.tick() }
        }
        tick()
    }

    /// App left the foreground: stop renewing and give the lease back now.
    func resignedActive() {
        timer?.invalidate()
        timer = nil
        release()
    }

    private func tick() {
        #if os(macOS)
        guard NSApplication.shared.isActive else {
            release()
            return
        }
        #endif
        leaseHeld = true
        write(until: Date().addingTimeInterval(lease))
    }

    private func release() {
        guard leaseHeld else { return }
        leaseHeld = false
        #if os(iOS)
        // The app is about to suspend; ask for a few seconds so the release
        // lands instead of the phone staying "active" for the rest of the lease.
        var bg = UIBackgroundTaskIdentifier.invalid
        bg = UIApplication.shared.beginBackgroundTask { UIApplication.shared.endBackgroundTask(bg) }
        write(until: Date()) { UIApplication.shared.endBackgroundTask(bg) }
        #else
        write(until: Date())
        #endif
    }

    private func write(until: Date, completion: (@MainActor () -> Void)? = nil) {
        guard let token = UserDefaults.standard.string(forKey: Install.key("apnsDeviceToken")), !token.isEmpty else {
            completion?()
            return
        }
        let iso = ISO8601DateFormatter().string(from: until)
        Task {
            do {
                try await SupabaseManager.shared
                    .from("device_tokens")
                    .update(["active_until": iso])
                    .eq("token", value: token)
                    .execute()
            } catch {
                print("[DeviceActivity] lease write failed: \(error.localizedDescription)")
            }
            completion?()
        }
    }
}
