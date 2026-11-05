#if os(iOS)
import Foundation
import Intents
import UIKit
import UserNotifications
import Supabase

/// Uploads what the extensions recorded about recent messages (AnnounceCache
/// trace) plus the settings that decide whether Siri reads a notification
/// aloud, to `app_diagnostics`, each time the app comes to the foreground.
/// The phone's own log is not reachable without a cable; this is.
enum AnnounceDiagnostics {
    private static var uploading = false

    static func upload() async {
        guard !uploading else { return }
        uploading = true
        defer { uploading = false }

        let s = await UNUserNotificationCenter.current().notificationSettings()
        let delivered = await UNUserNotificationCenter.current().deliveredNotifications()
        let categories = await UNUserNotificationCenter.current().notificationCategories()
        let msgCat = categories.first { $0.identifier == MessageReply.category }

        func setting(_ v: UNNotificationSetting) -> String {
            switch v {
            case .enabled: return "enabled"
            case .disabled: return "disabled"
            case .notSupported: return "notSupported"
            @unknown default: return "unknown(\(v.rawValue))"
            }
        }
        let siri: String = {
            switch INPreferences.siriAuthorizationStatus() {
            case .authorized: return "authorized"
            case .denied: return "denied"
            case .restricted: return "restricted"
            case .notDetermined: return "notDetermined"
            @unknown default: return "unknown"
            }
        }()

        var settings: [String: Any] = [
            "authorization": s.authorizationStatus.rawValue,
            "alert": setting(s.alertSetting),
            "announcement": setting(s.announcementSetting),
            "carPlay": setting(s.carPlaySetting),
            "lockScreen": setting(s.lockScreenSetting),
            "showPreviews": s.showPreviewsSetting.rawValue,   // 0 always, 1 whenAuthenticated, 2 never
            "timeSensitive": setting(s.timeSensitiveSetting),
            "scheduledDelivery": setting(s.scheduledDeliverySetting),
            "directMessages": setting(s.directMessagesSetting),
        ]
        settings["siri"] = siri
        settings["category_registered"] = msgCat != nil
        settings["category_intents"] = msgCat?.intentIdentifiers ?? []
        settings["category_options"] = msgCat?.options.rawValue ?? -1

        let recent = delivered.suffix(5).map { n -> [String: Any] in
            [
                "id": n.request.identifier,
                "category": n.request.content.categoryIdentifier,
                "title": n.request.content.title,
                "comm": n.request.content.targetContentIdentifier ?? "",
                "level": n.request.content.interruptionLevel.rawValue,
            ]
        }

        let trace = AnnounceCache.traceAll()
        let payload: [String: Any] = [
            "build": Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "?",
            "ios": UIDevice.current.systemVersion,
            "settings": settings,
            "delivered": recent,
            "cached": AnnounceCache.all().count,
            "trace": trace,
        ]

        do {
            try await SupabaseManager.ensureAuthenticated()
            let token = try await SupabaseManager.shared.auth.session.accessToken
            var req = URLRequest(url: SupabaseConfig.url.appendingPathComponent("rest/v1/app_diagnostics"))
            req.httpMethod = "POST"
            req.setValue(SupabaseConfig.anonKey, forHTTPHeaderField: "apikey")
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.setValue("return=minimal", forHTTPHeaderField: "Prefer")
            req.httpBody = try JSONSerialization.data(withJSONObject: ["kind": "announce", "payload": payload])
            let (data, resp) = try await URLSession.shared.data(for: req)
            let code = (resp as? HTTPURLResponse)?.statusCode ?? -1
            if (200..<300).contains(code) {
                AnnounceCache.clearTrace()
            } else {
                print("[AnnounceDiagnostics] upload \(code): \(String(data: data, encoding: .utf8) ?? "")")
            }
        } catch {
            print("[AnnounceDiagnostics] upload failed: \(error)")
        }
    }
}
#endif
