#!/usr/bin/env bash
set -u

project_root="/opt/WeChat-Open in"
mode="${1:---source}"
failures=0
warnings=0

ok() { printf 'OK    %s\n' "$*"; }
warn() { printf 'WARN  %s\n' "$*"; warnings=$((warnings + 1)); }
fail() { printf 'FAIL  %s\n' "$*"; failures=$((failures + 1)); }

check_command() {
  if command -v "$1" >/dev/null 2>&1; then
    ok "command available: $1"
  else
    fail "missing command: $1"
  fi
}

if [[ "$mode" != "--source" && "$mode" != "--target" ]]; then
  printf 'Usage: %s --source|--target\n' "$0" >&2
  exit 2
fi

[[ "$EUID" -eq 0 ]] || {
  printf 'Run the migration preflight as root so protected backup metadata can be verified.\n' >&2
  exit 1
}

if [[ "$(uname -m)" == "x86_64" ]]; then
  ok "architecture x86_64"
else
  fail "this release requires x86_64"
fi
if [[ -r /etc/os-release ]]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  if [[ "${ID:-}" == "ubuntu" && "${VERSION_ID:-}" == "24.04" ]]; then
    ok "Ubuntu 24.04"
  else
    fail "target OS must be Ubuntu 24.04"
  fi
else
  fail "/etc/os-release is unavailable"
fi
if [[ -d /run/systemd/system ]]; then
  ok "systemd is PID 1"
else
  fail "systemd is required"
fi
if [[ -d "$project_root" ]]; then
  ok "fixed project path exists"
else
  fail "missing $project_root"
fi

memory_bytes=$(awk '/MemTotal:/ {print $2 * 1024}' /proc/meminfo)
if (( memory_bytes >= 2 * 1024 * 1024 * 1024 )); then
  ok "physical memory is at least 2 GiB"
else
  fail "at least 2 GiB physical memory is required; 4 GiB is recommended"
fi
free_bytes=$(df -B1 --output=avail "$project_root" 2>/dev/null | tail -1 | tr -d ' ')
if [[ "$free_bytes" =~ ^[0-9]+$ ]] && (( free_bytes >= 12 * 1024 * 1024 * 1024 )); then
  ok "at least 12 GiB free disk is available"
else
  fail "at least 12 GiB free disk is required before installation"
fi

for command_name in age bash curl findmnt jq openssl sha256sum systemctl tar xz zstd; do
  check_command "$command_name"
done

for file in package.json package-lock.json config/openclaw.json config/projects.yaml \
  config/age-recipient.txt deploy/install-singapore.sh deploy/systemd/wechat-clawbot.slice; do
  if [[ -s "$project_root/$file" ]]; then
    ok "required file: $file"
  else
    fail "missing required file: $file"
  fi
done

if [[ "$mode" == "--source" ]]; then
  if findmnt -rn -T "$project_root/data" -o FSTYPE | grep -qx ext4; then
    ok "bounded ext4 data volume is mounted"
  else
    fail "bounded data volume is not mounted"
  fi
  for unit in wechat-clawbot-cdn-tunnel.service wechat-clawbot-gateway.service wechat-clawbot-ops.service wechat-clawbot-media.service; do
    if systemctl is-active --quiet "$unit"; then
      ok "active service: $unit"
    else
      fail "inactive service: $unit"
    fi
  done
  if [[ -s "$project_root/recovery/wechat-clawbot-recovery.agekey" ]]; then
    ok "offline recovery key source is present"
  else
    fail "recovery key is missing"
  fi
  pending=$(find "$project_root/data/backups/pending" -type f -name '*.tar.zst.age' 2>/dev/null | wc -l)
  if (( pending == 0 )); then
    ok "no pending encrypted backups"
  else
    fail "$pending encrypted backup(s) remain pending"
  fi
  latest_manifest=$(find "$project_root/data/backups/uploaded/daily" -type f -name '*.manifest.json' \
    -printf '%T@ %p\n' 2>/dev/null | sort -nr | head -1 | cut -d' ' -f2-)
  if [[ -n "$latest_manifest" ]]; then
    ok "uploaded daily backup manifest exists"
  else
    fail "no uploaded daily backup manifest"
  fi
  release_manifest=$(find "$project_root/data/migration/releases" -type f -name '*.manifest.json' \
    -printf '%T@ %p\n' 2>/dev/null | sort -nr | head -1 | cut -d' ' -f2-)
  if [[ -n "$release_manifest" ]]; then
    ok "migration release manifest exists"
  else
    fail "migration release bundle has not been built"
  fi
  while IFS= read -r project_path; do
    [[ -d "$project_path" ]] || warn "registered project is absent and must be migrated or disabled: $project_path"
  done < <(awk '$1 == "path:" { print $2 }' "$project_root/config/projects.yaml")
else
  if systemctl is-active --quiet wechat-clawbot-gateway.service 2>/dev/null; then
    fail "target already has an active ClawBot Gateway"
  else
    ok "no active target Gateway"
  fi
  if findmnt -rn "$project_root/data" >/dev/null 2>&1; then
    fail "target data mount already exists; installer will not overwrite it"
  else
    ok "target data mount is unused"
  fi
  if ss -ltn 2>/dev/null | awk '{print $4}' | grep -Eq '(^|:)18789$'; then
    fail "TCP port 18789 is already in use"
  else
    ok "TCP port 18789 is available"
  fi
fi

printf 'SUMMARY failures=%d warnings=%d mode=%s\n' "$failures" "$warnings" "$mode"
(( failures == 0 ))
