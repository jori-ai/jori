#!/bin/bash
# build.sh — build JoriSetup.exe on Linux or macOS with NSIS (makensis).
#
#   apps/windows/build.sh [--version X.Y.Z] [--out DIR]
#
# Needs makensis (apt-get install nsis / brew install makensis) and python3
# with Pillow for the icon. CI: .github/workflows/installers.yml.
# Unsigned: Windows SmartScreen shows "Windows protected your PC" until the
# file has a reputation or a code-signing certificate; More info → Run anyway.

set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
VERSION=0.1.0; OUT="$HERE/build"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --version) VERSION="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    *) echo "unknown: $1" >&2; exit 2 ;;
  esac
done
[[ $VERSION =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || VERSION=0.0.0
mkdir -p "$OUT"
ICON="$OUT/jori.ico"
python3 - "$REPO/site/icon.png" "$ICON" <<'PY'
import sys
from PIL import Image
Image.open(sys.argv[1]).convert("RGBA").save(sys.argv[2], sizes=[(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)])
PY
makensis -V2 -DVERSION="$VERSION" -DOUT="$OUT/JoriSetup.exe" -DICON="$ICON" -DPS1="$REPO/site/install.ps1" "$HERE/JoriSetup.nsi"
rm -f "$ICON"
echo "✓ $OUT/JoriSetup.exe"
