import Foundation

/// What this build is. One source tree builds the public Jori app and any
/// installation's own app: every value that differs between them comes from
/// the build configuration — `Config/Jori.xcconfig` (the public defaults),
/// overridden by an installation's `Config/Installation.xcconfig` — and
/// reaches the code through Info.plist keys (`Jori*`, each set to a build
/// setting). Each bundle (the app and every extension) carries the same keys,
/// so `Bundle.main` answers in whichever process asks. Kept free of
/// UIKit/AppKit so it compiles under APPLICATION_EXTENSION_API_ONLY.
enum Install {
    /// One Info.plist value, trimmed; "" when absent or when the build setting
    /// behind it was never defined (the key then holds the raw "$(…)").
    static func string(_ key: String) -> String {
        let v = ((Bundle.main.object(forInfoDictionaryKey: key) as? String) ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return v.contains("$(") ? "" : v
    }

    private static func string(_ key: String, default fallback: String) -> String {
        let v = string(key)
        return v.isEmpty ? fallback : v
    }

    /// The name the user sees (CFBundleDisplayName ← JORI_DISPLAY_NAME).
    static let displayName = string("CFBundleDisplayName", default: "Jori")

    // MARK: Device-local names

    /// Prefix of every name this app stores on the device: UserDefaults keys,
    /// the local stores, keychain services, monitored regions, Screen Time
    /// activity names (JORI_STORAGE_PREFIX). An installation whose app already
    /// stored data under another prefix pins it, so an update keeps that data.
    static let storagePrefix = string("JoriStoragePrefix", default: "jori")
    static func key(_ name: String) -> String { "\(storagePrefix).\(name)" }

    /// Prefix of the Secure Enclave key tags (JORI_KEY_TAG_PREFIX). Changing it
    /// orphans the paired signing keys, so an installation pins its own.
    static let keyTagPrefix = string("JoriKeyTagPrefix",
                                     default: (Bundle.main.bundleIdentifier ?? "jori").lowercased())
    static func keyTag(_ name: String) -> Data { "\(keyTagPrefix).\(name)".data(using: .utf8)! }

    /// The OAuth callback URL scheme (JORI_URL_SCHEME); matches CFBundleURLSchemes
    /// and the backend's allowed redirect URLs.
    static let urlScheme = string("JoriURLScheme", default: "jori")

    /// The App Group shared with the Screen Time extension (JORI_APP_GROUP).
    static let appGroup = string("JoriAppGroup")

    /// Keychain access group shared with the extensions. MUST carry the team
    /// prefix: kSecAttrAccessGroup is matched verbatim against the
    /// `keychain-access-groups` entitlement, which Xcode expands to
    /// `<TEAM>.<bundle id>.shared`. Without it every SecItemAdd fails with
    /// errSecMissingEntitlement — silently, behind `try?` — and a share
    /// uploads its photo but loses its message.
    static let keychainGroup = string("JoriKeychainGroup")

    // MARK: Backend

    /// The backend (JORI_SUPABASE_URL / JORI_SUPABASE_ANON_KEY). Unset in the
    /// public defaults: such a build runs, but cannot sign in.
    static let supabaseURL = URL(string: string("JoriSupabaseURL"))
        .flatMap { $0.host == nil ? nil : $0 }
    static let supabaseAnonKey = string("JoriSupabaseAnonKey")
    static var isConfigured: Bool { supabaseURL != nil && !supabaseAnonKey.isEmpty }

    /// Storage bucket that holds chat attachments (JORI_ATTACHMENTS_BUCKET).
    static let attachmentsBucket = string("JoriAttachmentsBucket", default: "jori-attachments")

    /// The name the installation's backend used before it became Jori
    /// (JORI_LEGACY_NAME; empty for none): its chat tables may still be
    /// `<legacy>_messages` / `<legacy>_commands`, and its server may still send
    /// `<legacy>-…` push kinds.
    static let legacyName = string("JoriLegacyName")

    // MARK: Face ID signing contexts — never change once a device is paired

    /// Purchases sign this context (JORI_SIGNING_PURCHASE); must equal the
    /// server's purchase `signing_domain`.
    static let purchaseSigningDomain = string("JoriSigningPurchase", default: "jori-purchase.v1")
    /// Self-improvement approvals sign this one (JORI_SIGNING_APPROVE); must
    /// equal the server's `approval_domain`.
    static let approvalSigningDomain = string("JoriSigningApprove", default: "jori-approve.v1")

    /// The `device_id` the phone stamps on location_history and photos rows
    /// (JORI_LOCATION_DEVICE_ID); an installation keeps the id its rows have.
    static let locationDeviceId = string("JoriLocationDeviceId", default: "phone")

    // MARK: Optional surfaces

    /// The memory wiki the Memory tab browses (JORI_WIKI_URL); when unset the
    /// tab says so.
    static let wikiURL = URL(string: string("JoriWikiURL")).flatMap { $0.host == nil ? nil : $0 }

    /// Trade approval: on only when the build names the trading web app that
    /// verifies the signatures (JORI_TRADE_APPROVAL_URL).
    static let tradeApprovalURL = URL(string: string("JoriTradeApprovalURL")).flatMap { $0.host == nil ? nil : $0 }
    /// The trading app's namespace for its push kind, category and signing
    /// context (JORI_TRADE_APPROVAL_NAMESPACE).
    static let tradeApprovalNamespace = string("JoriTradeApprovalNamespace", default: "trade")
    /// How the pairing screen names the trading app (JORI_TRADE_APPROVAL_LABEL).
    static let tradeApprovalLabel = string("JoriTradeApprovalLabel", default: "your trading app")

    /// Features an installation turns on (JORI_FEATURES, space-separated) —
    /// each needs server support, and some an Apple entitlement, that the
    /// public app does not assume.
    enum Feature: String {
        /// Screen Time usage windows (Family Controls entitlement + the
        /// UsageMonitor extension + the `phone_usage_windows` table).
        case screenTime = "screen-time"
        /// Phone lock-state samples for wake/sleep (`phone_lock_events`).
        case phoneLock = "phone-lock"
        /// Answering the server's photo probes from the photo library
        /// (`photo_probes`, `photos`, the `daily-photos` bucket).
        case photoProbe = "photo-probe"
        /// Responsiveness telemetry (`app_perf_events`).
        case appPerf = "app-perf"
    }
    static let features: Set<String> = Set(string("JoriFeatures")
        .split(whereSeparator: { $0 == " " || $0 == "," }).map(String.init))
    static func has(_ f: Feature) -> Bool { features.contains(f.rawValue) }
}

/// The Supabase connection, shared by the app and its extensions.
///
/// The anon JWT is intentionally public — Row-Level Security enforces access,
/// not secrecy. Inserts into jori_messages still require an authenticated
/// session (auth.uid() IS NOT NULL), which both processes obtain from the
/// shared keychain group.
enum SupabaseConfig {
    /// A build with no backend configured still has to construct a client;
    /// it points at a reserved name that never resolves.
    static let url = Install.supabaseURL ?? URL(string: "https://unconfigured.supabase.invalid")!
    static let anonKey = Install.supabaseAnonKey.isEmpty ? "unconfigured" : Install.supabaseAnonKey
    static let keychainAccessGroup = Install.keychainGroup
}

/// Where an attachment goes in the attachments bucket: a fresh UUID folder
/// plus an ASCII spelling of the file's name. Storage refuses any object key
/// with a character outside ASCII (`400 InvalidKey`), so a file named in
/// another script could not be sent at all. Only the key is rewritten: the
/// name as shared stays with the caller for display. The app's attachment send
/// and the share extension both use this, so their keys look the same.
enum AttachmentKey {
    static func make(for filename: String) -> String {
        "\(UUID().uuidString)/\(asciiName(filename))"
    }

    /// `Résumé 2026.PDF` → `Resume-2026.pdf`. Letters from other scripts are
    /// transliterated where ICU can, so the key stays readable; a name with
    /// nothing left becomes `file`, and the extension is always kept.
    static func asciiName(_ filename: String) -> String {
        let name = filename.trimmingCharacters(in: .whitespacesAndNewlines) as NSString
        let ext = String(ascii(name.pathExtension).filter { $0.isLetter || $0.isNumber }.prefix(16)).lowercased()
        var base = ""
        for ch in ascii(name.deletingPathExtension) {
            if ch.isASCII && (ch.isLetter || ch.isNumber || ch == "_" || ch == ".") {
                base.append(ch)
            } else if let last = base.last, last != "-" {
                base.append("-")  // one dash per run of anything else
            }
        }
        let edges = CharacterSet(charactersIn: "-_.")
        base = String(base.trimmingCharacters(in: edges).prefix(80)).trimmingCharacters(in: edges)
        if base.isEmpty { base = "file" }
        return ext.isEmpty ? base : "\(base).\(ext)"
    }

    /// `é` → `e`, other scripts → Latin letters; whatever has no ASCII
    /// spelling (an emoji) becomes a space, so it still separates words.
    private static func ascii(_ text: String) -> String {
        let latin = text.applyingTransform(StringTransform(rawValue: "Any-Latin; Latin-ASCII"), reverse: false) ?? text
        return String(latin.map { (c: Character) -> Character in c.isASCII ? c : " " })
    }
}

/// The chat tables' names: `jori_messages` / `jori_commands`. An installation
/// whose backend predates Jori (`Install.legacyName` set) may still have
/// `<legacy>_*`; the app asks which exist (`resolve()`, before it subscribes)
/// and keeps the answer in the app group, so its extensions write to the same
/// table. Until the first answer such a build assumes the legacy names.
enum DBTables {
    private static let defaults = (Install.appGroup.isEmpty ? nil : UserDefaults(suiteName: Install.appGroup)) ?? .standard
    private static let key = "db_table_prefix"

    static var prefix: String {
        defaults.string(forKey: key) ?? (Install.legacyName.isEmpty ? "jori" : Install.legacyName)
    }
    static var messages: String { "\(prefix)_messages" }
    static var commands: String { "\(prefix)_commands" }

    /// One anonymous probe: 200 on jori_messages means the renamed tables,
    /// 404 (no such relation) means the legacy ones; anything else (offline, a
    /// server error) keeps the last answer. Nothing to ask without a legacy name.
    static func resolve() async {
        guard !Install.legacyName.isEmpty, Install.isConfigured else { return }
        var req = URLRequest(url: SupabaseConfig.url.appendingPathComponent("rest/v1/jori_messages"))
        req.url = URL(string: req.url!.absoluteString + "?select=id&limit=1")
        req.setValue(SupabaseConfig.anonKey, forHTTPHeaderField: "apikey")
        req.setValue("Bearer \(SupabaseConfig.anonKey)", forHTTPHeaderField: "Authorization")
        req.timeoutInterval = 8
        guard let (_, resp) = try? await URLSession.shared.data(for: req),
              let status = (resp as? HTTPURLResponse)?.statusCode else { return }
        if status == 200 { defaults.set("jori", forKey: key) }
        else if status == 404 { defaults.set(Install.legacyName, forKey: key) }
    }
}
