#!/usr/bin/env bash
set -euo pipefail

project_root="/opt/WeChat-Open in"
node_version="24.15.0"
node_archive="node-v${node_version}-linux-x64.tar.xz"
node_sha256="472655581fb851559730c48763e0c9d3bc25975c59d518003fc0849d3e4ba0f6"
dry_run=false

if [[ "${1:-}" == "--dry-run" ]]; then
  dry_run=true
elif [[ $# -ne 0 ]]; then
  printf 'Usage: %s [--dry-run]\n' "$0" >&2
  exit 2
fi

[[ "$EUID" -eq 0 ]] || { printf 'Run as root.\n' >&2; exit 1; }
[[ "$(uname -m)" == "x86_64" ]] || { printf 'x86_64 is required.\n' >&2; exit 1; }
[[ "$PWD" == "$project_root" ]] || { printf 'Run from %s.\n' "$project_root" >&2; exit 1; }

run() {
  if $dry_run; then
    printf 'DRY-RUN'
    printf ' %q' "$@"
    printf '\n'
  else
    "$@"
  fi
}

if ! $dry_run; then
  if systemctl is-active --quiet wechat-clawbot-gateway.service 2>/dev/null || findmnt -rn "$project_root/data" >/dev/null 2>&1; then
    printf 'Refusing to install over an active or mounted ClawBot instance.\n' >&2
    exit 1
  fi
fi

run apt-get update
run apt-get install -y acl age ca-certificates curl e2fsprogs git imagemagick jq openssl sqlite3 tar xz-utils zstd

if ! getent group wechat-clawbot >/dev/null; then
  run groupadd --system wechat-clawbot
fi
if ! getent passwd wechat-clawbot >/dev/null; then
  run useradd --system --gid wechat-clawbot --home-dir "$project_root/data/home" \
    --shell /usr/sbin/nologin --no-create-home wechat-clawbot
fi

# OpenClaw uses an adjacent lock while device authorization updates its
# root-owned configuration. Grant only the service identity the same bounded
# access used on the source host.
run chown root:root "$project_root/config/openclaw.json"
run chmod 0640 "$project_root/config/openclaw.json"
run setfacl -m u:wechat-clawbot:rwx "$project_root/config"
run setfacl -m u:wechat-clawbot:rw "$project_root/config/openclaw.json"
run install -o wechat-clawbot -g wechat-clawbot -m 0600 \
  "$project_root/config/openclaw.json" "$project_root/config/openclaw.json.last-good"

run install -d -o root -g root -m 0755 "$project_root/.storage"
run install -d -o root -g root -m 0755 "$project_root/data"
if [[ ! -e "$project_root/.storage/clawbot-data.img" ]] || $dry_run; then
  if $dry_run && [[ -e "$project_root/.storage/clawbot-data.img" ]]; then
    printf 'DRY-RUN simulating a fresh target; existing source data image is untouched\n'
  fi
  # Keep enough headroom for an atomic OpenClaw plugin generation alongside
  # the active generation and npm's download cache during upgrades.
  run truncate -s 12G "$project_root/.storage/clawbot-data.img"
  run mkfs.ext4 -F -L wechat-clawbot-data "$project_root/.storage/clawbot-data.img"
  run chmod 0600 "$project_root/.storage/clawbot-data.img"
else
  printf 'Refusing to reuse an existing data image.\n' >&2
  exit 1
fi

run install -o root -g root -m 0644 \
  "$project_root/deploy/systemd/opt-WeChat\\x2dOpen\\x20in-data.mount" \
  "/etc/systemd/system/opt-WeChat\\x2dOpen\\x20in-data.mount"
run systemctl daemon-reload
run systemctl enable --now "opt-WeChat\\x2dOpen\\x20in-data.mount"

for directory in home node runtime cache/npm state workspace logs tasks tmp reports backups \
  rollback staging approvals run quarantine migration/releases; do
  run install -d -o wechat-clawbot -g wechat-clawbot -m 0750 "$project_root/data/$directory"
done
run chmod 0700 "$project_root/data/home"
run install -d -o wechat-clawbot -g wechat-clawbot -m 0700 "$project_root/data/state/codex"

temporary_directory=""
if $dry_run; then
  temporary_directory="/tmp/wechat-clawbot-node.XXXXXX"
  printf 'DRY-RUN download and verify https://nodejs.org/dist/v%s/%s\n' "$node_version" "$node_archive"
else
  temporary_directory=$(mktemp -d)
  trap 'rm -rf -- "$temporary_directory"' EXIT
  curl -fsSL --proto '=https' --tlsv1.2 \
    "https://nodejs.org/dist/v${node_version}/${node_archive}" \
    -o "$temporary_directory/$node_archive"
  printf '%s  %s\n' "$node_sha256" "$temporary_directory/$node_archive" | sha256sum -c -
  rm -rf -- "$project_root/data/node"
  install -d -o root -g wechat-clawbot -m 0755 "$project_root/data/node"
  tar -xJf "$temporary_directory/$node_archive" --strip-components=1 -C "$project_root/data/node"
fi

run install -o root -g wechat-clawbot -m 0644 package.json package-lock.json "$project_root/data/runtime/"
if $dry_run; then
  printf 'DRY-RUN npm ci --prefix %q\n' "$project_root/data/runtime"
else
  env PATH="$project_root/data/node/bin:$PATH" \
    "$project_root/data/node/bin/npm" ci --prefix "$project_root/data/runtime" \
      --legacy-peer-deps --no-audit --no-fund
fi

if [[ -e node_modules && ! -L node_modules ]]; then
  printf 'Refusing to replace a non-symlink node_modules path.\n' >&2
  exit 1
fi
run ln -sfn data/runtime/node_modules node_modules
run env PATH="$project_root/data/node/bin:$PATH" "$project_root/data/node/bin/npm" run build
run env PATH="$project_root/data/node/bin:$PATH" "$project_root/data/node/bin/npm" run prune:platform
run install -d -o root -g root -m 0755 /usr/local/libexec/wechat-clawbot-codex

for unit in "$project_root"/deploy/systemd/*; do
  run install -o root -g root -m 0644 "$unit" "/etc/systemd/system/$(basename "$unit")"
done
run systemctl daemon-reload
run systemctl enable "opt-WeChat\\x2dOpen\\x20in-data.mount" \
  "usr-local-libexec-wechat\\x2dclawbot\\x2dcodex.mount" \
  wechat-clawbot-maintenance.timer \
  wechat-clawbot-cdn-tunnel-health.timer

run install -d -o root -g root -m 0700 /etc/credstore.encrypted
create_random_credential() {
  local name="$1"
  local destination="$2"
  [[ -e "$destination" ]] && return
  if $dry_run; then
    printf 'DRY-RUN generate machine-bound credential %s\n' "$destination"
  else
    umask 077
    openssl rand -base64 48 | systemd-creds encrypt --name="$name" - "$destination"
    chmod 0600 "$destination"
  fi
}
create_random_credential gateway-token /etc/credstore.encrypted/wechat-clawbot-gateway-token.cred
create_random_credential broker-token /etc/credstore.encrypted/wechat-clawbot-broker-token.cred

run "$project_root/deploy/install-external-plugins.sh"
run "$project_root/deploy/install-media-plugin.sh"

cat <<'EOF'
Base installation prepared. Gateway was intentionally not started.
Next: restore the encrypted state backup into a staging directory, install the
offline age key as a new machine-bound credential, repeat OpenAI/Codex device
authorization, log in to WeChat, bind the owner, enter the dedicated COS CAM
credential locally, validate projects.yaml, then run the acceptance checklist.
EOF
