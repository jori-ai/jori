# Code signing and your own build — set this up before your first build

The companion app builds from one source tree for everyone. What makes a
build *yours* — bundle id, team, display name, backend, signing contexts,
optional features — is build configuration, not code:

- `Config/Jori.xcconfig` holds the public defaults (placeholders such as
  `TEAMID_PLACEHOLDER` and `com.example.Jori`).
- `Config/Installation.xcconfig`, when present, overrides any of them. It is
  git-ignored: keep it in your own private repo (or a CI secret) and copy it in
  before building.

## Minimal Installation.xcconfig

```
JORI_BUNDLE_ID = com.yourname.Jori
JORI_TEAM_ID = ABCDEFGHIJ
JORI_URL_SCHEME = com.yourname.jori
JORI_SUPABASE_URL = https:/$()/<project-ref>.supabase.co
JORI_SUPABASE_ANON_KEY = <the project's anon key>
```

(xcconfig reads `//` as a comment, hence `https:/$()/…`.) Find your Team ID at
https://developer.apple.com/account → Membership. Add the URL scheme's
`<scheme>://auth-callback` to the Supabase Auth redirect URLs.

Every setting, with its default and meaning, is documented in
`Config/Jori.xcconfig`. The ones to know:

| Setting | What it is |
|---|---|
| `JORI_BUNDLE_ID`, `JORI_TEAM_ID`, `JORI_DISPLAY_NAME`, `JORI_MARKETING_VERSION` | The app's identity; the extensions are `<bundle id>.NotificationService`, `.Share`, `.Intents`, `.UsageMonitor` |
| `JORI_APP_GROUP`, `JORI_KEYCHAIN_GROUP` | Shared with the extensions (defaults derive from the bundle id) |
| `JORI_SUPABASE_URL`, `JORI_SUPABASE_ANON_KEY`, `JORI_ATTACHMENTS_BUCKET` | The backend |
| `JORI_SIGNING_PURCHASE`, `JORI_SIGNING_APPROVE` | Face ID signing contexts; must equal the server's, never change once a device is paired |
| `JORI_STORAGE_PREFIX`, `JORI_KEY_TAG_PREFIX`, `JORI_LEGACY_NAME` | Only for an app that already shipped under other names (keeps its stored data and paired keys) |
| `JORI_WIKI_URL`, `JORI_TRADE_APPROVAL_*`, `JORI_FEATURES` | Optional surfaces, off until set |
| `JORI_APP_ENTITLEMENTS`, `JORI_USAGE_MONITOR_ENTITLEMENTS` | Point at the `-ScreenTime` variants once Apple has granted your team Family Controls |

Named places the location tracker should recognize go in
`Jori/Installation/NamedLocations.json` (git-ignored; an array of
`{"name", "lat", "lon", "address", "city"}`).

## CI

Both workflows (`ios-testflight.yml` / `macos-testflight.yml`) write
`Config/Installation.xcconfig` from the `JORI_INSTALLATION_XCCONFIG` secret when
it is set, read the team from it, and sign manually by passing
`JORI_CODE_SIGN_STYLE=Manual`, `JORI_CODE_SIGN_IDENTITY` and the profile names
(`JORI_PROFILE_*`) on the xcodebuild command line — nothing rewrites the
project file. Edit the profile names there, and the bundle ids in
`ExportOptions.plist`, to match your App Store Connect setup.

## GitHub Actions secrets you also need

| Secret | What |
|---|---|
| `JORI_INSTALLATION_XCCONFIG` | The contents of your `Installation.xcconfig` |
| `IOS_CERTIFICATE_P12` | Base64-encoded `.p12` of your Apple Distribution certificate |
| `IOS_CERTIFICATE_PASSWORD` | Password for the `.p12` |
| `MAC_CERTIFICATE_P12` | Same, but for the Mac Installer Distribution certificate |
| `MAC_CERTIFICATE_PASSWORD` | Password for the mac `.p12` |
| `MAC_PROVISIONING_PROFILE` | Base64-encoded mac app `.provisionprofile` |
| `MAC_NOTIFSERVICE_PROFILE` | Base64-encoded notification-service `.provisionprofile` |
| `MAC_SHARE_PROFILE` | Base64-encoded share-extension `.provisionprofile` |
| `MAC_INSTALLER_IDENTITY` | Full name of your "3rd Party Mac Developer Installer: …" identity |
| `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_PRIVATE_KEY` | App Store Connect API key (see [Apple docs](https://developer.apple.com/documentation/appstoreconnectapi/creating_api_keys_for_app_store_connect_api)) |

## What the workflows do

- **`ios-testflight.yml`** — iOS archive via xcodebuild, export, upload to TestFlight via `xcrun altool`. Runs on a self-hosted macOS runner (label `[self-hosted, macos, ios]`).
- **`macos-testflight.yml`** — native macOS archive, `productbuild` into a `.pkg`, upload to TestFlight. Same runner labels.

Trigger both manually via the Actions tab → workflow → "Run workflow".

If you're not running a self-hosted runner, change the `runs-on:` line to `macos-latest` — be aware GitHub-hosted macOS runners are slower and have less reliable signing-keychain behavior.
