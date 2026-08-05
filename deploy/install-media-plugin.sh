#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="/opt/WeChat-Open in"
SOURCE_DIR="$PROJECT_ROOT/plugins/wechat-media-bridge"
RUNTIME_DIR="$PROJECT_ROOT/runtime-plugins/wechat-media-bridge"

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo "Run this installer as root after npm run check." >&2
  exit 1
fi

for required in \
  "$SOURCE_DIR/openclaw.plugin.json" \
  "$SOURCE_DIR/package.json" \
  "$SOURCE_DIR/dist/index.js" \
  "$SOURCE_DIR/dist/client.js" \
  "$SOURCE_DIR/dist/native-upload.js" \
  "$SOURCE_DIR/dist/socks-https.js" \
  "$SOURCE_DIR/dist/native-weixin.js"; do
  if [[ ! -f "$required" || -L "$required" ]]; then
    echo "Missing or unsafe build artifact: $required" >&2
    exit 1
  fi
done

install -d -o root -g root -m 0755 "$PROJECT_ROOT/runtime-plugins"
install -d -o root -g root -m 0755 "$RUNTIME_DIR" "$RUNTIME_DIR/dist"
install -o root -g root -m 0644 \
  "$SOURCE_DIR/openclaw.plugin.json" \
  "$SOURCE_DIR/package.json" \
  "$RUNTIME_DIR/"
install -o root -g root -m 0644 \
  "$SOURCE_DIR/dist/index.js" \
  "$SOURCE_DIR/dist/client.js" \
  "$SOURCE_DIR/dist/native-upload.js" \
  "$SOURCE_DIR/dist/socks-https.js" \
  "$SOURCE_DIR/dist/native-weixin.js" \
  "$RUNTIME_DIR/dist/"

echo "Installed trusted media plugin runtime at $RUNTIME_DIR"
sha256sum \
  "$RUNTIME_DIR/openclaw.plugin.json" \
  "$RUNTIME_DIR/package.json" \
  "$RUNTIME_DIR/dist/index.js" \
  "$RUNTIME_DIR/dist/client.js" \
  "$RUNTIME_DIR/dist/native-upload.js" \
  "$RUNTIME_DIR/dist/socks-https.js" \
  "$RUNTIME_DIR/dist/native-weixin.js"
