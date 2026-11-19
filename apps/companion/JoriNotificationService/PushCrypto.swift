import Foundation
import CryptoKit

/// End-to-end encryption for pushes that travel through the shared push relay
/// (docs/per-user-onboarding-spec.md, Phase 2 "Push relay"). Compiled into the
/// app (which makes the key and registers its public half with the relay) and
/// into the NotificationService extension (which opens each push).
///
/// The host seals the full APNs payload to this device's P-256 key; the relay
/// only ever sees ciphertext and a placeholder alert. The push carries
/// `enc` = base64( ephemeralPub(65, X9.63) ‖ nonce(12) ‖ ciphertext ‖ tag(16) ):
///
///     shared = ECDH(devicePriv, ephemeralPub)
///     key    = HKDF-SHA256(ikm: shared, salt: ephemeralPub (65 bytes),
///                          info: "jori-push-v1", 32 bytes)
///     plain  = AES-256-GCM open(nonce, ciphertext, tag), no AAD
///
/// `plain` is the UTF-8 JSON of the original APNs payload (`aps` + custom keys).
enum PushCrypto {
    static let info = Data("jori-push-v1".utf8)
    static let publicKeyLength = 65
    static let nonceLength = 12
    static let tagLength = 16

    enum Failure: Error {
        case notBase64
        case tooShort
        case notJSON
        case noDeviceKey
    }

    /// Open one sealed blob (base64 or base64url).
    static func open(_ encoded: String, with key: P256.KeyAgreement.PrivateKey) throws -> Data {
        guard let blob = base64Decode(encoded) else { throw Failure.notBase64 }
        return try open(blob: blob, with: key)
    }

    static func open(blob: Data, with key: P256.KeyAgreement.PrivateKey) throws -> Data {
        let bytes = [UInt8](blob)
        guard bytes.count >= publicKeyLength + nonceLength + tagLength else { throw Failure.tooShort }
        let ephemeralRaw = Data(bytes[0..<publicKeyLength])
        let ephemeral = try P256.KeyAgreement.PublicKey(x963Representation: ephemeralRaw)
        let shared = try key.sharedSecretFromKeyAgreement(with: ephemeral)
        let symmetric = shared.hkdfDerivedSymmetricKey(using: SHA256.self,
                                                       salt: ephemeralRaw,
                                                       sharedInfo: info,
                                                       outputByteCount: 32)
        // nonce ‖ ciphertext ‖ tag is exactly AES.GCM.SealedBox's combined form.
        let box = try AES.GCM.SealedBox(combined: Data(bytes[publicKeyLength...]))
        return try AES.GCM.open(box, using: symmetric)
    }

    /// The decrypted APNs payload of a push, or nil when it carries no `enc`.
    /// Throws when it does but can't be opened (no key, tampered, wrong key).
    static func payload(of userInfo: [AnyHashable: Any]) throws -> [String: Any]? {
        guard let enc = userInfo["enc"] as? String else { return nil }
        guard let key = PushKey.load() else { throw Failure.noDeviceKey }
        let plain = try open(enc, with: key)
        guard let json = try JSONSerialization.jsonObject(with: plain) as? [String: Any] else {
            throw Failure.notJSON
        }
        return json
    }

    /// `userInfo` with a sealed payload opened and merged in (its `aps` and
    /// custom keys replace the placeholder's; `enc` is dropped), so code that
    /// reads `kind`, `message_id`… works the same for relayed pushes. Returns
    /// the input unchanged when there is nothing to open or opening fails.
    static func unwrapped(_ userInfo: [AnyHashable: Any]) -> [AnyHashable: Any] {
        guard userInfo["enc"] != nil else { return userInfo }
        do {
            guard let payload = try payload(of: userInfo) else { return userInfo }
            return merged(userInfo, with: payload)
        } catch {
            NSLog("[PushCrypto] could not open push: \(error)")
            return userInfo
        }
    }

    static func merged(_ userInfo: [AnyHashable: Any], with payload: [String: Any]) -> [AnyHashable: Any] {
        var out = userInfo
        out.removeValue(forKey: "enc")
        for (k, v) in payload { out[k] = v }
        return out
    }

    /// base64url or standard base64, padded or not.
    static func base64Decode(_ s: String) -> Data? {
        var b = s.trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        b = b.trimmingCharacters(in: CharacterSet(charactersIn: "="))
        while b.count % 4 != 0 { b += "=" }
        return Data(base64Encoded: b)
    }

    #if DEBUG
    /// The sender's side (what the host does), for the self-check only.
    static func seal(_ plaintext: Data, to recipient: P256.KeyAgreement.PublicKey) throws -> Data {
        let ephemeral = P256.KeyAgreement.PrivateKey()
        let ephemeralRaw = ephemeral.publicKey.x963Representation
        let shared = try ephemeral.sharedSecretFromKeyAgreement(with: recipient)
        let symmetric = shared.hkdfDerivedSymmetricKey(using: SHA256.self,
                                                       salt: ephemeralRaw,
                                                       sharedInfo: info,
                                                       outputByteCount: 32)
        let box = try AES.GCM.seal(plaintext, using: symmetric)
        guard let combined = box.combined else { throw Failure.tooShort }
        return ephemeralRaw + combined
    }

    /// The fixed vectors in docs/push-relay.md ("Test vector", "Signature
    /// test vector"), which tests/push-relay.test.mjs pins on the host side.
    enum Vector {
        static let devicePrivateKeyHex = "eb0d6b0bf7f9b0ccab93db17a79d3086924558805faba532046598df906a8cb2"
        static let devicePublicKey = "BJYzW4B8Yfyw9IHFUdTavWneL7FVw2iMf36E/rZ4nr6g6qqScDVJf/UjuwmQcyjhym1WD7U4ln1YOMGIGvTmbUY="
        static let blob = "BNhBwRxLS1UPpKhPiqQrkOBrKLI8Qismds4dhBiMDW3o1HMIBvq45nHmEUNFSI/8bQzeZOe4CAflsolvkS/Kl0UAAQIDBAUGBwgJCguvGQ/EsE9TBjcnluiksrkgrh4TRQskSexT7Bv2Ce95aZ2jSbKCnas/xFz9a1dfCwiWgAJTrx5KbE+I4gXBFwFNgznnWoRhI1ZuMcYK6vf0dG19js0p58gAL4UxMfYVruQpNEIkE0FvbhBV9EPs1t7udVtiZaAyB7UQFddnNaKyOKj2UHIHMSDwk5ZqApG4sQ=="
        static let plaintext = #"{"aps":{"alert":{"title":"Jori","body":"Test vector"},"mutable-content":1},"message_id":"00000000-0000-0000-0000-000000000001"}"#
        static let deviceSecret = "ZGV2aWNlLXNlY3JldC1mb3ItdGVzdHMtMDEyMzQ1Njc"
        static let deviceBody = #"{"apns_token":""# + String(repeating: "ab", count: 32) + #""}"#
        static let deviceSignature = "eb4b1e705a185dfb933a6e44d40ce4cbfdd7242c4182971a464b9da8c575fcd0"
    }

    /// Debug builds run this at launch and log the result (the project has no
    /// test target): the docs/push-relay.md vectors (the host's sealer and
    /// the device request signature), a round trip through `seal`/`open` with
    /// a throwaway key, and a tamper check.
    @discardableResult
    static func selfCheck() -> Bool {
        do {
            var raw = Data()
            var hex = Vector.devicePrivateKeyHex[...]
            while !hex.isEmpty { raw.append(UInt8(hex.prefix(2), radix: 16)!); hex = hex.dropFirst(2) }
            let fixed = try P256.KeyAgreement.PrivateKey(rawRepresentation: raw)
            guard fixed.publicKey.x963Representation.base64EncodedString() == Vector.devicePublicKey,
                  try open(Vector.blob, with: fixed) == Data(Vector.plaintext.utf8) else {
                NSLog("[PushCrypto] self-check FAILED: docs/push-relay.md test vector")
                return false
            }
            guard RelayAuth.signature(secret: Vector.deviceSecret, method: "PUT", path: "/v1/devices/dv_test",
                                      timestamp: "1767225600000", body: Data(Vector.deviceBody.utf8))
                    == Vector.deviceSignature else {
                NSLog("[PushCrypto] self-check FAILED: docs/push-relay.md signature vector")
                return false
            }

            let device = P256.KeyAgreement.PrivateKey()
            let message = Data(#"{"aps":{"alert":{"title":"t","body":"b"}},"message_id":"x"}"#.utf8)
            var blob = try seal(message, to: device.publicKey)
            guard try open(blob: blob, with: device) == message else {
                NSLog("[PushCrypto] self-check FAILED: round trip mismatch")
                return false
            }
            blob[blob.count - 1] ^= 0x01
            if (try? open(blob: blob, with: device)) != nil {
                NSLog("[PushCrypto] self-check FAILED: tampered blob opened")
                return false
            }
            NSLog("[PushCrypto] self-check ok")
            return true
        } catch {
            NSLog("[PushCrypto] self-check FAILED: \(error)")
            return false
        }
    }
    #endif
}

/// Device auth for the push relay (docs/push-relay.md, "Request signatures"):
/// lowercase hex HMAC-SHA256 over METHOD, PATH (no host, no query),
/// TIMESTAMP (ms, as sent) and hex(SHA-256(body)), joined by "\n". The key is
/// the secret's UTF-8 text exactly as issued (not base64-decoded).
enum RelayAuth {
    static func signature(secret: String, method: String, path: String, timestamp: String, body: Data) -> String {
        let canonical = "\(method.uppercased())\n\(path)\n\(timestamp)\n\(hex(SHA256.hash(data: body)))"
        let mac = HMAC<SHA256>.authenticationCode(for: Data(canonical.utf8),
                                                  using: SymmetricKey(data: Data(secret.utf8)))
        return hex(mac)
    }

    static func hex<D: Sequence>(_ bytes: D) -> String where D.Element == UInt8 {
        bytes.map { String(format: "%02x", $0) }.joined()
    }
}

/// This device's push key: a P-256 key-agreement key made when the app pairs
/// with a relay-backed Jori. The private half stays in the `.shared` keychain
/// group (after first unlock, this device only) so the NotificationService
/// extension can open pushes on a locked phone; the public half (X9.63, 65
/// bytes) is registered with the relay.
enum PushKey {
    private static var service: String { Install.key("push-relay") }
    private static let account = "device-key"

    static func load() -> P256.KeyAgreement.PrivateKey? {
        guard case .found(let raw) = SharedKeychain.read(service: service, account: account) else { return nil }
        return try? P256.KeyAgreement.PrivateKey(rawRepresentation: raw)
    }

    static func loadOrCreate() throws -> P256.KeyAgreement.PrivateKey {
        if let key = load() { return key }
        let key = P256.KeyAgreement.PrivateKey()
        try SharedKeychain.write(key.rawRepresentation, service: service, account: account)
        return key
    }

    static func delete() {
        SharedKeychain.delete(service: service, account: account)
    }
}
