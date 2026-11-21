#!/bin/sh
# Makes the app icon files in src-tauri/icons from icon.mjs (the drawing). Needs Node and cargo-tauri.
set -e
cd "$(dirname "$0")"
node icon.mjs
cargo tauri icon icon-1024.png
rm icon-1024.png
# Only the desktop sizes are kept: this app has no phone version.
rm -rf icons/ios icons/android
