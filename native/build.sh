#!/usr/bin/env bash
set -euo pipefail
SRC="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SRC/.." && pwd)"
APP="$ROOT/forma.app"
mkdir -p "$APP/Contents/MacOS"
swiftc -O -framework Cocoa -framework WebKit -o "$APP/Contents/MacOS/forma" "$SRC/main.swift"
cp "$SRC/Info.plist" "$APP/Contents/Info.plist"
codesign --force --sign - "$APP"
echo "Built $APP"
