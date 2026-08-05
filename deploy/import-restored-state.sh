#!/usr/bin/env bash
set -euo pipefail

project_root="/opt/WeChat-Open in"
dry_run=false
if [[ "${1:-}" == "--dry-run" ]]; then
  dry_run=true
  shift
fi
restore_root="${1:-}"

[[ "$EUID" -eq 0 ]] || { printf 'Run as root.\n' >&2; exit 1; }
[[ -n "$restore_root" && -d "$restore_root" ]] || {
  printf 'Usage: %s [--dry-run] /absolute/restored-directory\n' "$0" >&2
  exit 2
}
restore_root=$(realpath -e -- "$restore_root")
[[ "$restore_root" = /* && "$restore_root" != "$project_root"* && "$restore_root" != "/" ]] || {
  printf 'Restore source must be outside the live project.\n' >&2
  exit 1
}
findmnt -rn -T "$project_root/data" -o FSTYPE | grep -qx ext4 || {
  printf 'The bounded target data volume is not mounted.\n' >&2
  exit 1
}
for unit in wechat-clawbot-cdn-tunnel.service wechat-clawbot-gateway.service wechat-clawbot-ops.service wechat-clawbot-media.service; do
  if systemctl is-active --quiet "$unit" 2>/dev/null; then
    printf 'Refusing import while %s is active.\n' "$unit" >&2
    exit 1
  fi
done
if find "$restore_root" \( -type l -o -type b -o -type c -o -type p -o -type s \) -print -quit | grep -q .; then
  printf 'Restore source contains a symlink or special file.\n' >&2
  exit 1
fi
if find "$restore_root" -type f \( -iname '.env' -o -iname '.env.*' -o -iname '*token*' \
  -o -iname 'auth.json' -o -iname 'auth-profiles.json' -o -iname '*.pem' -o -iname '*.key' \) \
  -print -quit | grep -q .; then
  printf 'Restore source contains a credential-like file.\n' >&2
  exit 1
fi

copy_tree() {
  local relative="$1"
  local source="$restore_root/$relative"
  local destination="$project_root/$relative"
  [[ -e "$source" ]] || return 0
  if $dry_run; then
    printf 'DRY-RUN import %s\n' "$relative"
    return
  fi
  install -d -o wechat-clawbot -g wechat-clawbot -m 0700 "$destination"
  cp -a --no-preserve=ownership -- "$source/." "$destination/"
  chown -R wechat-clawbot:wechat-clawbot "$destination"
}

copy_file() {
  local relative="$1"
  local source="$restore_root/$relative"
  local destination="$project_root/$relative"
  [[ -f "$source" ]] || return 0
  if $dry_run; then
    printf 'DRY-RUN import %s\n' "$relative"
    return
  fi
  install -o wechat-clawbot -g wechat-clawbot -m 0600 "$source" "$destination"
}

copy_config() {
  local relative="$1"
  local source="$restore_root/$relative"
  local destination="$project_root/$relative"
  [[ -f "$source" ]] || return 0
  if $dry_run; then
    printf 'DRY-RUN import %s\n' "$relative"
    return
  fi
  install -o root -g root -m 0640 "$source" "$destination"
  setfacl -m u:wechat-clawbot:rw "$destination"
}

backup_dir="$project_root/data/migration/import-backup-$(date -u +%Y%m%dT%H%M%SZ)"
if ! $dry_run; then
  install -d -o root -g root -m 0700 "$backup_dir"
  if [[ -f "$project_root/config/openclaw.json" ]]; then
    install -o root -g root -m 0600 "$project_root/config/openclaw.json" "$backup_dir/openclaw.json.before-import"
  fi
fi

copy_file "data/workspace/MEMORY.md"
copy_tree "data/workspace/memory"
copy_tree "data/state/agents"
copy_tree "data/state/cron"
copy_tree "data/tasks"
copy_config "config/openclaw.json"

if $dry_run; then
  printf 'DRY-RUN refresh config/openclaw.json.last-good\n'
  printf 'DRY-RUN completed; no files changed.\n'
else
  install -o wechat-clawbot -g wechat-clawbot -m 0600 \
    "$project_root/config/openclaw.json" "$project_root/config/openclaw.json.last-good"
  printf 'Restore state imported. Previous config backup: %s\n' "$backup_dir"
fi
