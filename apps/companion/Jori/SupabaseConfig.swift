import Foundation
import Security

/// What this build is. One source tree builds the public Jori app and any
/// installation's own app: every value that differs between them comes from
/// the build configuration — `Config/Jori.xcconfig` (the public defaults),
/// overridden by an installation's `Config/Installation.xcconfig` — and
/// reaches the code through Info.plist keys (`Jori*`, each set to a build
/// setting). Each bundle (the app and every extension) carries the same keys,
/// so `Bundle.main` answers in whichever process asks. Kept free of
/// UIKit/AppKit so it compiles under APPLICATION_EXTENSION_API_ONLY.
///
/// The shared public app learns its backend at runtime instead: a stored
/// `Pairing` (scanned from the host's setup page) overrides the backend, the
/// Face ID signing contexts and the display name. With no pairing stored every
/// value is the build's, exactly as before.
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

    /// The name the user sees: what the assistant is called (JoriDisplayName ←
    /// JORI_DISPLAY_NAME, which an installation's build sets from its
    /// `assistant_name`). Every bundle carries the key, so an extension answers
    /// with the app's name rather than its own target name.
    static var displayName: String { PairingStore.current?.displayName ?? builtDisplayName }
    private static let builtDisplayName = string("JoriDisplayName", default: string("CFBundleDisplayName", default: "Jori")) // control-scan-ok: the setting's default

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

    /// The backend: a stored pairing's, else the build's (JORI_SUPABASE_URL /
    /// JORI_SUPABASE_ANON_KEY). Both unset in the public defaults: until it is
    /// paired such a build runs, but cannot sign in. URL and key always come
    /// from the same source.
    static var supabaseURL: URL? { PairingStore.current.map(\.supabaseURL) ?? builtSupabaseURL }
    static var supabaseAnonKey: String { PairingStore.current?.anonKey ?? builtSupabaseAnonKey }
    static var isConfigured: Bool { supabaseURL != nil && !supabaseAnonKey.isEmpty }
    private static let builtSupabaseURL = URL(string: string("JoriSupabaseURL"))
        .flatMap { $0.host == nil ? nil : $0 }
    private static let builtSupabaseAnonKey = string("JoriSupabaseAnonKey")

    /// Storage bucket that holds chat attachments (JORI_ATTACHMENTS_BUCKET).
    static let attachmentsBucket = string("JoriAttachmentsBucket", default: "jori-attachments")

    /// The name the installation's backend used before it became Jori
    /// (JORI_LEGACY_NAME; empty for none): its chat tables may still be
    /// `<legacy>_messages` / `<legacy>_commands`, and its server may still send
    /// `<legacy>-…` push kinds.
    static let legacyName = string("JoriLegacyName")

    // MARK: Face ID signing contexts — never change once a device is paired

    /// Purchases sign this context (a pairing's `sp`, else JORI_SIGNING_PURCHASE);
    /// must equal the server's purchase `signing_domain`.
    static var purchaseSigningDomain: String {
        PairingStore.current?.purchaseSigningDomain ?? builtPurchaseSigningDomain
    }
    /// Self-improvement approvals sign this one (a pairing's `sa`, else
    /// JORI_SIGNING_APPROVE); must equal the server's `approval_domain`.
    static var approvalSigningDomain: String {
        PairingStore.current?.approvalSigningDomain ?? builtApprovalSigningDomain
    }
    private static let builtPurchaseSigningDomain = string("JoriSigningPurchase", default: "jori-purchase.v1")
    private static let builtApprovalSigningDomain = string("JoriSigningApprove", default: "jori-approve.v1")

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
    /// Computed: a pairing can change them while the app runs.
    static var url: URL { Install.supabaseURL ?? URL(string: "https://unconfigured.supabase.invalid")! }
    static var anonKey: String {
        let key = Install.supabaseAnonKey
        return key.isEmpty ? "unconfigured" : key
    }
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

    /// Forget the answer: the backend changed (a new pairing, or unpaired).
    static func reset() { defaults.removeObject(forKey: key) }

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

// MARK: - Runtime pairing

/// The backend a shared (public) app was paired with, decoded from the code the
/// host's setup page shows (QR or typed):
///
///     jori-pair:1:<base64url(UTF-8 JSON)>
///
/// JSON keys: `u` Supabase URL, `k` anon key, `i` push-relay instance id,
/// `t` one-time pairing token (~10 min), `r` push relay base URL, `sp` / `sa`
/// the purchase / approve Face ID signing domains, `n` the assistant's name,
/// `e` the owner's email (a sign-in hint only). `t` is a secret and is kept
/// apart from this record (`PairingStore.pairingToken`) until the relay
/// registration spends it.
struct Pairing: Codable, Equatable {
    var supabaseURL: URL
    var anonKey: String
    var instanceId: String?
    var relayURL: URL?
    var purchaseSigningDomain: String?
    var approvalSigningDomain: String?
    var displayName: String?
    var ownerEmail: String?

    static let scheme = "jori-pair:"
    static let prefix = "jori-pair:1:"

    /// Whether the push relay applies: it needs both the relay and the instance.
    var usesRelay: Bool { relayURL != nil && !(instanceId ?? "").isEmpty }

    enum ParseError: LocalizedError, Equatable {
        case notAPairingCode
        case unsupportedVersion
        case unreadable
        case badBackendURL
        case missingKey
        case badRelayURL

        var errorDescription: String? {
            switch self {
            case .notAPairingCode: return "That isn't a Jori pairing code."
            case .unsupportedVersion: return "This code is from a newer Jori. Update the app and try again."
            case .unreadable: return "The code is incomplete. Copy the whole code and try again."
            case .badBackendURL: return "The code's server address isn't a secure (https) address."
            case .missingKey: return "The code has no server key."
            case .badRelayURL: return "The code's notification relay isn't a secure (https) address."
            }
        }
    }

    private struct Wire: Decodable {
        let u: String?
        let k: String?
        let i: String?
        let t: String?
        let r: String?
        let sp: String?
        let sa: String?
        let n: String?
        let e: String?
    }

    /// Parse and validate a pairing code. Tolerates surrounding text (a code
    /// pasted inside a sentence or a link), whitespace and line breaks, and
    /// both base64url and standard base64. Returns the pairing and its
    /// one-time token, if any.
    static func parse(_ text: String) throws -> (pairing: Pairing, token: String?) {
        let compact = text.filter { !$0.isWhitespace }
        guard let start = compact.range(of: scheme, options: .caseInsensitive) else {
            throw ParseError.notAPairingCode
        }
        let rest = compact[start.upperBound...]
        guard rest.hasPrefix("1:") else { throw ParseError.unsupportedVersion }
        let encoded = rest.dropFirst(2).prefix { $0.isLetter || $0.isNumber || "-_+/=".contains($0) }
        guard let data = base64Decode(String(encoded)),
              let wire = try? JSONDecoder().decode(Wire.self, from: data) else {
            throw ParseError.unreadable
        }
        guard let url = httpsURL(wire.u) else { throw ParseError.badBackendURL }
        guard let key = nonEmpty(wire.k) else { throw ParseError.missingKey }
        var relay: URL?
        if let r = nonEmpty(wire.r) {
            guard let u = httpsURL(r) else { throw ParseError.badRelayURL }
            relay = u
        }
        let pairing = Pairing(supabaseURL: url,
                              anonKey: key,
                              instanceId: nonEmpty(wire.i),
                              relayURL: relay,
                              purchaseSigningDomain: nonEmpty(wire.sp),
                              approvalSigningDomain: nonEmpty(wire.sa),
                              displayName: nonEmpty(wire.n),
                              ownerEmail: nonEmpty(wire.e))
        return (pairing, nonEmpty(wire.t))
    }

    /// base64url or standard base64, padded or not.
    static func base64Decode(_ s: String) -> Data? {
        var b = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        b = b.trimmingCharacters(in: CharacterSet(charactersIn: "="))
        while b.count % 4 != 0 { b += "=" }
        return Data(base64Encoded: b)
    }

    private static func nonEmpty(_ s: String?) -> String? {
        guard let v = s?.trimmingCharacters(in: .whitespacesAndNewlines), !v.isEmpty else { return nil }
        return v
    }

    private static func httpsURL(_ s: String?) -> URL? {
        guard let v = nonEmpty(s), let url = URL(string: v),
              url.scheme?.lowercased() == "https", let host = url.host, !host.isEmpty else { return nil }
        return url
    }
}

extension Notification.Name {
    /// Posted (in this process) when the stored pairing is saved or cleared:
    /// the Supabase client and anything bound to it must be rebuilt.
    static let joriBackendChanged = Notification.Name("joriBackendChanged")
}

/// Where the pairing lives: the `.shared` keychain group, because the app's
/// extensions (share, Siri intents, notification service) each read the
/// backend in their own process and share no UserDefaults or App Group with
/// the app — the keychain group is the one store every target is entitled to.
/// One JSON record, `ThisDeviceOnly` (a restored backup re-pairs rather than
/// carry a relay registration whose device key stayed behind). Read once per
/// process and cached; a read that fails because the phone has not been
/// unlocked since boot is not cached, so the next access retries.
enum PairingStore {
    private static var service: String { Install.key("pairing") }
    private static let recordAccount = "backend"
    private static let tokenAccount = "pairing-token"

    private static let lock = NSLock()
    private static var loaded = false
    private static var cached: Pairing?

    static var current: Pairing? {
        lock.lock(); defer { lock.unlock() }
        if loaded { return cached }
        switch SharedKeychain.read(service: service, account: recordAccount) {
        case .found(let data):
            cached = try? JSONDecoder().decode(Pairing.self, from: data)
            loaded = true
        case .notFound:
            cached = nil
            loaded = true
        case .unavailable:
            return nil   // locked since boot: retry on the next access
        case .failed:
            cached = nil  // e.g. no keychain entitlement: no pairing, ask no more
            loaded = true
        }
        return cached
    }

    /// Store a pairing (replacing any other) and its one-time token.
    static func save(_ pairing: Pairing, pairingToken: String?) throws {
        let data = try JSONEncoder().encode(pairing)
        try SharedKeychain.write(data, service: service, account: recordAccount)
        if let pairingToken {
            try SharedKeychain.write(Data(pairingToken.utf8), service: service, account: tokenAccount)
        } else {
            SharedKeychain.delete(service: service, account: tokenAccount)
        }
        lock.lock(); cached = pairing; loaded = true; lock.unlock()
        NotificationCenter.default.post(name: .joriBackendChanged, object: nil)
    }

    /// Forget the pairing: the build's own backend (or none) applies again.
    static func clear() {
        SharedKeychain.delete(service: service, account: recordAccount)
        SharedKeychain.delete(service: service, account: tokenAccount)
        lock.lock(); cached = nil; loaded = true; lock.unlock()
        NotificationCenter.default.post(name: .joriBackendChanged, object: nil)
    }

    /// The one-time pairing token, until the relay registration spends it.
    static var pairingToken: String? {
        guard case .found(let data) = SharedKeychain.read(service: service, account: tokenAccount) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func forgetPairingToken() {
        SharedKeychain.delete(service: service, account: tokenAccount)
    }
}

/// Generic-password items in the `.shared` keychain group (data-protection
/// keychain on macOS too), readable after first unlock so the notification
/// service extension can use them on a locked phone. Never synced or backed
/// up to another device.
enum SharedKeychain {
    enum ReadResult {
        case found(Data)
        case notFound
        /// Locked since boot (errSecInteractionNotAllowed): try again later.
        case unavailable
        /// Any other failure (a missing entitlement…): retrying won't help.
        case failed(OSStatus)
    }

    private static func query(service: String, account: String) -> [String: Any] {
        var q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecUseDataProtectionKeychain as String: true,
        ]
        if !Install.keychainGroup.isEmpty { q[kSecAttrAccessGroup as String] = Install.keychainGroup }
        return q
    }

    static func read(service: String, account: String) -> ReadResult {
        var q = query(service: service, account: account)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &out)
        switch status {
        case errSecSuccess:
            guard let data = out as? Data else { return .unavailable }
            return .found(data)
        case errSecItemNotFound:
            return .notFound
        case errSecInteractionNotAllowed:
            return .unavailable
        default:
            NSLog("[SharedKeychain] read \(account) failed: \(status)")
            return .failed(status)
        }
    }

    static func write(_ data: Data, service: String, account: String) throws {
        let q = query(service: service, account: account)
        let status = SecItemUpdate(q as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecSuccess { return }
        guard status == errSecItemNotFound else { throw KeychainFailure(status: status) }
        var add = q
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let added = SecItemAdd(add as CFDictionary, nil)
        guard added == errSecSuccess else { throw KeychainFailure(status: added) }
    }

    static func delete(service: String, account: String) {
        let status = SecItemDelete(query(service: service, account: account) as CFDictionary)
        if status != errSecSuccess && status != errSecItemNotFound {
            NSLog("[SharedKeychain] delete \(account) failed: \(status)")
        }
    }

    struct KeychainFailure: LocalizedError {
        let status: OSStatus
        var errorDescription: String? { "Couldn't save to the keychain (\(status))." }
    }
}
