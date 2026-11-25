#!/usr/bin/env bash
# Builds Bookmark.app (universal: Apple Silicon + Intel) and Bookmark.dmg.
# Needs only Xcode or the Command Line Tools — no other dependencies.
#
#   ./macos/build.sh
#   open macos/build/Bookmark.app
set -euo pipefail
cd "$(dirname "$0")"

APP=build/Bookmark.app
rm -rf build
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

echo "• Compiling"
for arch in arm64 x86_64; do
  swiftc -O -swift-version 5 \
    -target "$arch-apple-macos12.0" \
    -framework Cocoa -framework WebKit \
    Sources/main.swift -o "build/Bookmark-$arch"
done
lipo -create -output "$APP/Contents/MacOS/Bookmark" build/Bookmark-arm64 build/Bookmark-x86_64
rm build/Bookmark-arm64 build/Bookmark-x86_64

echo "• Bundling"
cp Info.plist "$APP/Contents/Info.plist"
printf 'APPL????' > "$APP/Contents/PkgInfo"

ICONSET=build/AppIcon.iconset
mkdir -p "$ICONSET"
for size in 16 32 128 256 512; do
  sips -z $size $size AppIcon-1024.png --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  sips -z $((size * 2)) $((size * 2)) AppIcon-1024.png --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"
rm -rf "$ICONSET"

echo "• Signing (ad-hoc)"
codesign --force --deep --sign - "$APP"

echo "• Creating disk image"
STAGE=build/dmg
mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
hdiutil create -quiet -volname Bookmark -srcfolder "$STAGE" -ov -format UDZO build/Bookmark.dmg
rm -rf "$STAGE"

echo "✓ Built $(pwd)/$APP"
echo "✓ Built $(pwd)/build/Bookmark.dmg"
