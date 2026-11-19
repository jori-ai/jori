# Push relay

The push relay is a small service we run (`push-relay/`, a Cloudflare Worker with D1). It holds the shared Jori app's Apple Push key and forwards pushes for every Jori host that uses that app. The host encrypts each push to the phone, so the relay sees only ciphertext.

- Worker: `push-relay/src/index.js` (routes, D1, APNs). Pure logic: `push-relay/src/core.js`. Schema: `push-relay/schema.sql`.
- Host client: `lib/push-relay.mjs`. `lib/apns-push.mjs` uses it whenever the host is set up for the relay.
- App side: `apps/companion/JoriNotificationService/PushCrypto.swift` (decrypt) and the pairing flow (`lib/onboarding/pairing.mjs` puts the relay URL, instance id and a pairing token in the pairing code).
- Tests: `tests/push-relay.test.mjs`.
- Spec: `docs/per-user-onboarding-spec.md`, Phase 2 item 4.

## Why

Before the relay, each host signed APNs pushes with its own `.p8` key (`agent/local/config/apns.json`, `credentials/jori-apns.p8`). That only works when each installation has its own app and its own Apple key.

With one shared Jori app there is one Apple key, and it cannot sit on customer hosts. A customer's host runs an agent with a shell, so any file on it can be printed. A leaked key could push to every Jori user.

The relay design:

- **The key stays with the relay.** It lives only in the relay's Worker secrets. Hosts authenticate with a per-instance secret that is worthless outside the relay.
- **The relay pushes only within an instance.** It sends only to devices paired to the instance making the request, and it rate-limits and size-caps every push.
- **The relay can't read pushes.** Each payload is encrypted to a key that never leaves the phone, and the app's notification service extension decrypts it.
- **Direct hosts are unaffected.** A host with its own app and key keeps pushing directly. Nothing changes until `relayConfig()` is non-null.

## Protocol v1

The base URL is the relay's origin, for example `https://push.example.com`. It is an origin only, because the signature covers the URL path. All bodies are JSON and all times are integer milliseconds since the epoch. Errors have the form `{"error": "<code>", "message"?: "…"}`.

### Request signatures

A signed request carries three headers:

| Header | Value |
|---|---|
| `X-Jori-Instance` (host) or `X-Jori-Device` (phone) | the instance id or device id |
| `X-Jori-Timestamp` | ms since epoch, as a decimal string |
| `X-Jori-Signature` | lowercase hex `HMAC-SHA256(key, canonical)` |

```
canonical = METHOD + "\n" + PATH + "\n" + TIMESTAMP + "\n" + hex(SHA-256(body))
```

- **METHOD** is upper-case.
- **PATH** is the URL path only (`/v1/devices/dv_x`), with no host and no query.
- **TIMESTAMP** is the header value verbatim.
- **body** is the exact bytes sent. An empty body (GET, DELETE) hashes as zero bytes.
- **key** is the UTF-8 bytes of the secret exactly as issued, meaning the 43-character base64url text, not its decoded bytes.

The relay rejects a timestamp more than 5 minutes from its own clock (`401 stale_timestamp`). It verifies in constant time (WebCrypto `verify`). An unknown id and a bad signature both get `401 unauthorized`.

If a request carries `X-Jori-Device`, it is a device request. Otherwise `X-Jori-Instance` makes it a host request.

### Endpoints

| Method and path | Auth | Body | Success |
|---|---|---|---|
| `POST /v1/instances` | none, 5 per IP per hour | none | `201 {instance_id, instance_secret}` |
| `POST /v1/pairings` | host | `{token_hash, expires_at}` | `201 {expires_at}` |
| `POST /v1/devices` | none, 20 per IP per hour | `{instance_id, pairing_token, apns_token, environment, device_name, public_key}` | `201 {device_id, device_secret}` |
| `PUT /v1/devices/:id` | device (its own id) | `{apns_token?, environment?}` | `200 {ok: true}` |
| `DELETE /v1/devices/:id` | device (its own id), or host (a device of its instance) | none | `200 {ok: true}` |
| `GET /v1/devices` | host | none | `200 {devices: [{device_id, public_key, device_name, created_at, last_seen_at}]}` |
| `POST /v1/push` | host | `{device_id, ciphertext, push_type, priority?, collapse_id?, thread_id?, badge?}` | `200 {ok: true, apns_id}` |

**Ids and secrets.** Instance ids look like `in_<22 base64url chars>` and device ids like `dv_…`. Secrets are 32 random bytes, base64url without padding.

**`POST /v1/pairings`:**

- `token_hash` is `hex(SHA-256(token))` in lowercase, where `token` is the pairing token's UTF-8 text.
- An `expires_at` in the past is rejected. One more than 15 minutes ahead is clamped to now + 15 minutes.
- An instance can have at most 10 unexpired pairings (`429 too_many_pairings`).
- The relay stores only the hash.

**`POST /v1/devices`:**

| Field | Format |
|---|---|
| `pairing_token` | the token itself (the host's token is 24 random bytes, base64url) |
| `apns_token` | hex, 64–200 characters |
| `environment` | `"production"` or `"sandbox"` |
| `device_name` | non-empty after trimming |
| `public_key` | base64 of the raw uncompressed P-256 point: 65 bytes starting `0x04`, checked to be on the curve |

- The relay deletes the pairing in the same statement that checks it, so a token works once (`403 invalid_pairing`).
- An instance can have at most 20 live devices (`409 too_many_devices`).
- Registering an APNs token that the instance already has replaces the old device row, so a reinstall doesn't push twice.

**`PUT /v1/devices/:id`** updates the token or environment and `last_seen_at`. It also clears `dead_at`, so a new token revives a device that APNs had retired. The app calls it whenever iOS hands it a new token.

**`GET /v1/devices`** lists only live devices. Dead ones are left out.

**`POST /v1/push`:**

| Field | Rules |
|---|---|
| `ciphertext` | the base64 blob below, at most 3500 characters (`413 payload_too_large` otherwise) |
| `push_type` | `"alert"` or `"background"` |
| `priority` | `10` or `5`. Defaults to 10 for alerts and 5 for background, and a background push must be 5. |
| `collapse_id` | 1–64 bytes, sent as `apns-collapse-id` |
| `thread_id` | 1–64 characters |
| `badge` | integer, 0–99999 |

The device must belong to the instance (`404 unknown_device`). Each instance can make 600 push calls per hour (`429 rate_limited`).

The relay sends this to APNs:

```json
alert:      {"aps":{"alert":{"title":"Jori","body":"New message"},"mutable-content":1,"sound":"default","thread-id"?:"…","badge"?:N},"enc":"<ciphertext>"}
background: {"aps":{"content-available":1},"enc":"<ciphertext>"}
```

APNs headers:

- `apns-push-type`: `alert` or `background`
- `apns-priority`
- `apns-topic`: `APNS_TOPIC`
- `apns-collapse-id`: when one was given

The host is `api.push.apple.com`, or `api.sandbox.push.apple.com` for a `sandbox` device.

**APNs outcomes:**

| APNs response | Relay action | Relay response |
|---|---|---|
| 200 | none | `200` |
| 410, or reason `BadDeviceToken` / `Unregistered` | marks the device dead | `410 device_gone` |
| 403 `ExpiredProviderToken` / `InvalidProviderToken` | re-signs the JWT and retries once | the retry's outcome |
| 429 | none | `429 apns_rate_limited` |
| anything else | none | `502 {error: "apns_error", apns_status, reason}` |

**Provider token.** An ES256 JWT `{alg, kid}.{iss: team, iat}`, signed with WebCrypto and reused for 50 minutes. Apple wants it refreshed every 20–60 minutes and throttles re-signing.

**Request bodies** are capped at 8 KB.

**Logging.** The relay never logs ciphertext, APNs tokens, secrets or pairing tokens. Logs carry the route, the status and a 10-character id prefix.

### Storage (D1)

`push-relay/schema.sql` has four tables:

- **`instances`:** `id`, `secret`, `created_at`.
- **`pairings`:** `token_hash`, `instance_id`, `expires_at`.
- **`devices`:** `id`, `instance_id`, `secret`, `apns_token`, `environment`, `device_name`, `public_key`, `created_at`, `last_seen_at`, `dead_at`.
- **`rate_limits`:** `key`, `window_start`, `count`, as fixed hourly windows. IPs are stored as a truncated SHA-256, never raw.

Instance and device **secrets are stored as issued.** Verifying an HMAC needs the key itself, so storing only a hash isn't possible. Anyone with read access to the D1 database could therefore sign as any host. That would let them push ciphertext they can't produce meaningfully, and list or delete devices.

- The protection is Cloudflare account access, the same trust boundary as the Apple key in Worker secrets.
- **Possible later hardening:** encrypt the secret column under a Worker secret.

An hourly cron (`17 * * * *`) deletes expired pairings, rate windows older than 2 hours, and devices dead for 30 days.

## Encryption (jori-push-v1)

The host encrypts the full APNs payload it would otherwise have sent directly, meaning the `aps` dict plus custom keys like `message_id`. It encrypts once per device, to that device's P-256 key:

```
eph       = fresh P-256 key pair (one per push per device)
z         = ECDH(eph.private, devicePublic)                    32 bytes (the x coordinate)
key       = HKDF-SHA256(ikm = z,
                        salt = eph.public raw uncompressed (65 bytes, 0x04‖X‖Y),
                        info = UTF-8 "jori-push-v1",
                        L = 32)
nonce     = 12 random bytes
ct ‖ tag  = AES-256-GCM(key, nonce, plaintext), no AAD, 16-byte tag
blob      = base64( eph.public(65) ‖ nonce(12) ‖ ct ‖ tag(16) )   standard base64 with padding
plaintext = UTF-8 JSON of the payload
```

**Size.** The relay caps `ciphertext` at 3500 base64 characters. That allows a plaintext of up to `floor(3500/4)*3 − 93 = 2532` bytes. The host shortens `aps.alert.body` (ending it with "…") until the payload fits, rather than dropping the push (`fitPayload`). The resulting APNs payload stays under Apple's 4 KB limit.

**CryptoKit mapping (device side):**

```swift
let raw   = Data(base64Encoded: enc)!
let ephPub = raw[0..<65]
let eph   = try P256.KeyAgreement.PublicKey(x963Representation: ephPub)
let z     = try devicePrivateKey.sharedSecretFromKeyAgreement(with: eph)
let key   = z.hkdfDerivedSymmetricKey(using: SHA256.self, salt: ephPub,
                                      sharedInfo: Data("jori-push-v1".utf8), outputByteCount: 32)
let box   = try AES.GCM.SealedBox(combined: raw[65...])   // nonce ‖ ct ‖ tag
let plain = try AES.GCM.open(box, using: key)
```

The device's `public_key` sent at registration is `devicePrivateKey.publicKey.x963Representation.base64EncodedString()`, which is 65 bytes. A Secure Enclave key (`SecureEnclave.P256.KeyAgreement.PrivateKey`) gives the same representation. The private key has to be readable by the notification service extension, which means a shared keychain access group.

### Test vector

Both sides test against this vector. `tests/push-relay.test.mjs` pins it; the Swift side should decrypt it.

| | value |
|---|---|
| device private key (raw scalar, hex) | `eb0d6b0bf7f9b0ccab93db17a79d3086924558805faba532046598df906a8cb2` |
| device public key (base64, the registered `public_key`) | `BJYzW4B8Yfyw9IHFUdTavWneL7FVw2iMf36E/rZ4nr6g6qqScDVJf/UjuwmQcyjhym1WD7U4ln1YOMGIGvTmbUY=` |
| ephemeral private key (hex) | `eb0fbfc69ad54040e850d4540543bbb2e164ffc918317022172a2afe56561596` |
| ephemeral public key (hex, 65 bytes) | `04d841c11c4b4b550fa4a84f8aa42b90e06b28b23c422b2676ce1d84188c0d6de8d4730806fab8e671e6114345488ffc6d0cde64e7b80807e5b2896f912fca9745` |
| nonce (hex) | `000102030405060708090a0b` | <!-- kernel-guard-ok: a crypto test vector, not a commit -->
| ECDH shared secret z (hex) | `66081ea6fd9afd60423eb6770910267685ccebd43de567c41ffbd8570eeed3c6` |
| HKDF output key (hex) | `4de50aa9373518f43074567b90755f8e636cd4a3fe977005c57066410f49f167` |
| plaintext (UTF-8, exact bytes, 127 bytes) | `{"aps":{"alert":{"title":"Jori","body":"Test vector"},"mutable-content":1},"message_id":"00000000-0000-0000-0000-000000000001"}` |
| blob (base64, 220 bytes decoded) | see below |

```
BNhBwRxLS1UPpKhPiqQrkOBrKLI8Qismds4dhBiMDW3o1HMIBvq45nHmEUNFSI/8bQzeZOe4CAflsolvkS/Kl0UAAQIDBAUGBwgJCguvGQ/EsE9TBjcnluiksrkgrh4TRQskSexT7Bv2Ce95aZ2jSbKCnas/xFz9a1dfCwiWgAJTrx5KbE+I4gXBFwFNgznnWoRhI1ZuMcYK6vf0dG19js0p58gAL4UxMfYVruQpNEIkE0FvbhBV9EPs1t7udVtiZaAyB7UQFddnNaKyOKj2UHIHMSDwk5ZqApG4sQ==
```

In Swift, load the device key with `P256.KeyAgreement.PrivateKey(rawRepresentation: <32 bytes>)`. Decrypting the blob must yield the plaintext exactly. If it doesn't, compare z and the derived key against the table to find the step that diverges.

The two private keys are `SHA-256("jori-push-v1 test device key")` and `SHA-256("jori-push-v1 test ephemeral key")`. They are test-only.

### Signature test vector

| | host request | device request |
|---|---|---|
| secret | `c2VjcmV0LWZvci10ZXN0cy1vbmx5LTAxMjM0NTY3ODk` | `ZGV2aWNlLXNlY3JldC1mb3ItdGVzdHMtMDEyMzQ1Njc` |
| id header | `X-Jori-Instance: in_test` | `X-Jori-Device: dv_test` |
| method, path | `POST /v1/push` | `PUT /v1/devices/dv_test` |
| timestamp | `1767225600000` | `1767225600000` |
| body (exact) | `{"device_id":"dv_test"}` | `{"apns_token":"abab…ab"}` (64 hex chars: `ab` × 32) |
| SHA-256(body) | `95a6a4e68a01aa27d527588dd7771b5c96321f5cdd47570a122e133f7412bcdf` | |
| X-Jori-Signature | `d5abcb96044b4f9bea0f36c47068f5f2b32d248bc33457374a076646ec103981` | `eb4b1e705a185dfb933a6e44d40ce4cbfdd7242c4182971a464b9da8c575fcd0` |

## What the app does

1. **Pair.** The pairing code (`lib/onboarding/pairing.mjs`) carries `r` (the relay URL), `i` (the instance id) and `t` (a one-time pairing token, valid for 10 minutes).
   - The app creates its P-256 key and gets an APNs token.
   - It calls `POST /v1/devices` with `{instance_id: i, pairing_token: t, apns_token, environment, device_name, public_key}`.
   - It keeps `device_id` and `device_secret` in the shared keychain.
2. **Keep the token current.** On every new APNs token, the app calls `PUT /v1/devices/:id`, signed as the device.
3. **Unpair.** The app calls `DELETE /v1/devices/:id`, signed as the device.
4. **Decrypt each push in the notification service extension.** The outer alert is a placeholder ("Jori / New message") that always has `mutable-content: 1`.
   - The extension decrypts `enc` and replaces the content with the inner payload's title, body and custom keys.
   - It also re-applies the inner `aps` keys that live only in the ciphertext: `interruption-level` (time-sensitive), `category` (`JORI_MESSAGE`, the approval categories), `badge`, `sound`, `thread-id`.
   - If decryption fails, the placeholder shows.
   - Background pushes carry `enc` too. The app decrypts them in its background handler.

## Turning it on for a host

The host needs `agent/local/config/push-relay.json` `{relay_url, instance_id}` and `JORI_PUSH_RELAY_SECRET` in `.env`. The `JORI_PUSH_RELAY_URL` env var overrides `relay_url`. `registerInstance` writes all of it:

```bash
cd ~/Dev/jori   # the install root
node --input-type=module -e '
  const r = await import("./lib/push-relay.mjs");
  console.log(await r.registerInstance({ relayUrl: "https://push.example.com" }));'
```

- It refuses when the host is already registered, because a new instance orphans every paired device. Pass `force: true` only on purpose.
- From then on, `relayConfig()` is non-null, and every sender in `lib/apns-push.mjs` goes through the relay: `sendApnsPush`, the purchase and action approval pushes, `sendSilentPush` and `sendClearPush`. This is decided per call, so no restart is needed.
- Pair the phone again from the setup page so it registers with the relay.
- To go back to direct pushes, delete `push-relay.json` or the `.env` key.

**Host API** (`lib/push-relay.mjs`):

| Function | What it does |
|---|---|
| `relayConfig()` | the host's relay settings, or null when it isn't set up |
| `registerInstance({relayUrl})` | registers the host with a relay and writes the config and the secret |
| `createPairing({ttlMs})` | returns `{token, expiresAt}` |
| `listDevices()` | lists the paired devices |
| `deleteDevice(id)` | unpairs one device |
| `encryptForDevice(publicKeyB64, payload)` | encrypts a payload to one device |
| `pushToAll(payload, {pushType, priority, collapseId, threadId, badge})` | sends to every device, returning one result per device |

In a test run (`node --test`), every network call refuses unless the test passes its own `fetch`. `apns-push` never picks the relay on its own in a test run.

**Differences from the direct path:**

- **No active-device routing.** The relay knows devices, not `device_tokens` rows, so it has no platform and no `active_until` lease. A push goes to every paired device. `selectPushTargets`, `isIosToken` and the clear-push class filter don't apply.
- **Clear pushes go to every device.** Push recipients are recorded under the class `relay`, so `sendClearPush` still fires, and it goes to every device.
- **No token-failure log.** `data/apns-token-failures.json` isn't written in relay mode. The relay retires dead tokens itself, and they drop out of `GET /v1/devices`.

## Deploy

These are instructions only. Run them from `push-relay/` with a Cloudflare account that will own the relay.

1. Create the database with `wrangler d1 create jori-push-relay`, then put its id in `wrangler.toml` (`database_id`).
2. Apply the schema with `wrangler d1 execute jori-push-relay --remote --file=schema.sql`.
3. Set the Worker secrets with `wrangler secret put <NAME>`:

   | Secret | Value |
   |---|---|
   | `APNS_KEY_P8` | the full PEM text of the shared app's `.p8` key |
   | `APNS_KEY_ID` | the key's id |
   | `APNS_TEAM_ID` | the Apple team id |
   | `APNS_TOPIC` | the shared app's bundle id |

   The canonical copies belong in the 1Password Dev vault.
4. Set the route in `wrangler.toml` to the relay's hostname (custom domain), then run `wrangler deploy`.
5. Smoke test:
   1. Register a throwaway instance (`POST /v1/instances`).
   2. Pair a sandbox build.
   3. Push one alert and one background push.
   4. Check that the app decrypts both.

**Unverified until the first deploy: HTTP/2 to APNs.** APNs accepts only HTTP/2. This relay calls it with the Worker's `fetch`, and whether Workers negotiate HTTP/2 to `api.push.apple.com` has to be confirmed by the smoke test. If they don't, the same `core.js` runs behind a Node HTTP/2 client, for example a Vercel function, which the spec allows.

## Known limits

- **Replays.** A captured signed request can be replayed within its 5-minute window. The worst cases are re-sending the same ciphertext to the same device (rate-limited) or repeating an idempotent call. The relay keeps no nonce table.
- **One provider token per isolate.** The 50-minute JWT cache is per Worker isolate. Many isolates each signing their own could trip APNs `TooManyProviderTokenUpdates`. If that shows up, keep the token in D1 or KV.
- **Metadata the relay sees.** It sees which instance pushes to which device, when, the push type, the badge number and the ciphertext size. It never sees content.
