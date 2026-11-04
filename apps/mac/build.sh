#!/bin/bash
# build.sh — build Jori.app (the menu bar app) and Jori.dmg, no Xcode project.
#
#   apps/mac/build.sh [--version X.Y.Z] [--build N] [--out DIR]
#
# Signing and notarization happen only when the environment has them:
#   MAC_DEVID_IDENTITY   "Developer ID Application: <name> (<team>)" in the keychain
#   NOTARY_KEY_ID, NOTARY_ISSUER_ID, NOTARY_KEY_PATH   an App Store Connect API key
# Without them the app is ad-hoc signed: it runs on the Mac that built it, and
# elsewhere only after right-click → Open. CI: .github/workflows/mac-app.yml.
#
# Env: JORI_MAC_BUNDLE_ID (default ai.jori.mac).

set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
VERSION=0.1.0; BUILD=1; OUT="$HERE/build"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --version) VERSION="$2"; shift 2 ;;
    --build) BUILD="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    *) echo "unknown: $1" >&2; exit 2 ;;
  esac
done
BUNDLE_ID="${JORI_MAC_BUNDLE_ID:-ai.jori.mac}"
APP="$OUT/Jori.app"
rm -rf "$APP" "$OUT/Jori.dmg" "$OUT/obj"; mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" "$OUT/obj"

echo "▸ compiling (arm64 + x86_64)"
for arch in arm64 x86_64; do
  swiftc -O -parse-as-library -target "$arch-apple-macos15.0" \
    -o "$OUT/obj/Jori-$arch" "$HERE"/Sources/*.swift
done
lipo -create "$OUT"/obj/Jori-arm64 "$OUT"/obj/Jori-x86_64 -output "$APP/Contents/MacOS/Jori"

echo "▸ bundling"
sed -e "s/__BUNDLE_ID__/$BUNDLE_ID/" -e "s/__VERSION__/$VERSION/" -e "s/__BUILD__/$BUILD/" \
  "$HERE/Resources/Info.plist" > "$APP/Contents/Info.plist"
cp "$REPO/site/install.sh" "$APP/Contents/Resources/install.sh"
# App icon from the companion app's 1024px master.
ICON_SRC="$REPO/apps/companion/Jori/Assets.xcassets/AppIcon.appiconset/icon.png"
ICONSET="$OUT/obj/AppIcon.iconset"; mkdir -p "$ICONSET"
for s in 16 32 128 256 512; do
  sips -z $s $s "$ICON_SRC" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  sips -z $((s*2)) $((s*2)) "$ICON_SRC" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"
plutil -lint "$APP/Contents/Info.plist" >/dev/null

echo "▸ signing"
if [[ -n ${MAC_DEVID_IDENTITY:-} ]]; then
  codesign --force --options runtime --timestamp --sign "$MAC_DEVID_IDENTITY" "$APP"
else
  codesign --force --sign - "$APP"
  echo "  ad-hoc (no MAC_DEVID_IDENTITY): runs here; elsewhere right-click → Open"
fi
codesign --verify --strict "$APP"

echo "▸ disk image"
STAGE="$OUT/obj/dmg"; mkdir -p "$STAGE"; cp -R "$APP" "$STAGE/"; ln -s /Applications "$STAGE/Applications"
hdiutil create -quiet -volname "Jori" -srcfolder "$STAGE" -format UDZO "$OUT/Jori.dmg"
[[ -n ${MAC_DEVID_IDENTITY:-} ]] && codesign --force --timestamp --sign "$MAC_DEVID_IDENTITY" "$OUT/Jori.dmg"

if [[ -n ${MAC_DEVID_IDENTITY:-} && -n ${NOTARY_KEY_ID:-} ]]; then
  echo "▸ notarizing"
  xcrun notarytool submit "$OUT/Jori.dmg" --key "$NOTARY_KEY_PATH" --key-id "$NOTARY_KEY_ID" --issuer "$NOTARY_ISSUER_ID" --wait
  xcrun stapler staple "$OUT/Jori.dmg"
fi
rm -rf "$OUT/obj"
echo "✓ $APP"
echo "✓ $OUT/Jori.dmg"
