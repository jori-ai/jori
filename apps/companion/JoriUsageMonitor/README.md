# JoriUsageMonitor — Screen Time (DeviceActivity) monitor extension

Writes overnight phone-usage callbacks to the App Group; the app
(`Jori/PhoneUsageMonitor.swift`) uploads them to `phone_usage_windows`.
Feeds wake/sleep: first use of the morning, last use of the night.

## Optional: needs Apple's Family Controls grant

The extension is always built and embedded on iOS (a dependency of `Jori`
and in its Embed App Extensions phase, both with `platformFilter = ios`, so
the macOS build is untouched), but it only does anything in a build that
turns the feature on. An installation whose team Apple has granted
**Family Controls (Distribution)** sets, in `Config/Installation.xcconfig`:

```
JORI_FEATURES = screen-time …
JORI_APP_ENTITLEMENTS = Jori/Jori-ScreenTime.entitlements
JORI_USAGE_MONITOR_ENTITLEMENTS = JoriUsageMonitor/JoriUsageMonitor-ScreenTime.entitlements
```

The public default (`Jori.entitlements`, `JoriUsageMonitor.entitlements`)
claims only the App Group, so it signs without the grant.

A build that signs MANUALLY (named profiles passed as `JORI_PROFILE_*`)
needs the portal set up by hand on developer.apple.com: the App Group
(`JORI_APP_GROUP`); App Groups + Family Controls (Development and
Distribution) on the app's App ID and on `<bundle id>.UsageMonitor`; every
profile on those App IDs regenerated (a capability change invalidates them);
and a profile for the extension.

On the phone, once: menu → **Sleep & wake (Screen Time)** → Allow → select all
apps & categories.
