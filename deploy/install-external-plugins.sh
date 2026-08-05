#!/usr/bin/env bash
set -euo pipefail

project_root="/opt/WeChat-Open in"
openclaw=(
  "$project_root/data/node/bin/node"
  "$project_root/node_modules/openclaw/openclaw.mjs"
)

[[ $EUID -eq 0 ]] || { printf 'Run as root.\n' >&2; exit 1; }
[[ -x "${openclaw[0]}" && -f "${openclaw[1]}" ]] || {
  printf 'The pinned OpenClaw runtime is unavailable.\n' >&2
  exit 1
}
runuser -u wechat-clawbot -- test -w "$project_root/config"
runuser -u wechat-clawbot -- test -w "$project_root/config/openclaw.json"

plugin_loaded() {
  local plugin_id="$1"
  local output
  output=$(mktemp)
  if ! runuser -u wechat-clawbot -- env \
    HOME="$project_root/data/home" \
    OPENCLAW_STATE_DIR="$project_root/data/state" \
    OPENCLAW_CONFIG_PATH="$project_root/config/openclaw.json" \
    "${openclaw[@]}" plugins list --json >"$output" 2>/dev/null; then
    unlink "$output"
    return 1
  fi
  if python3 - "$output" "$plugin_id" <<'PY'
import json
import sys

value = json.load(open(sys.argv[1], encoding="utf-8"))
plugins = value if isinstance(value, list) else value.get("plugins", [])
raise SystemExit(0 if any(
    isinstance(plugin, dict)
    and plugin.get("id") == sys.argv[2]
    and plugin.get("status") == "loaded"
    for plugin in plugins
) else 1)
PY
  then
    unlink "$output"
    return 0
  fi
  unlink "$output"
  return 1
}

install_plugin() {
  local plugin_id="$1"
  local package_spec="$2"
  local output
  plugin_loaded "$plugin_id" && return
  output=$(mktemp)
  runuser -u wechat-clawbot -- env \
    HOME="$project_root/data/home" \
    OPENCLAW_STATE_DIR="$project_root/data/state" \
    OPENCLAW_CONFIG_PATH="$project_root/config/openclaw.json" \
    "${openclaw[@]}" plugins install "$package_spec" >"$output" 2>&1 || true
  if ! plugin_loaded "$plugin_id"; then
    printf 'External plugin did not load: %s\n' "$plugin_id" >&2
    unlink "$output"
    exit 1
  fi
  unlink "$output"
}

install_plugin openclaw-weixin '@tencent-weixin/openclaw-weixin@2.4.6'
install_plugin codex '@openclaw/codex@2026.7.1-1'

runuser -u wechat-clawbot -- env \
  HOME="$project_root/data/home" \
  OPENCLAW_STATE_DIR="$project_root/data/state" \
  OPENCLAW_CONFIG_PATH="$project_root/config/openclaw.json" \
  "${openclaw[@]}" plugins doctor >/dev/null
printf 'External OpenClaw plugins are loaded.\n'
