#!/usr/bin/env bash
set -euo pipefail

proxy_url='socks5h://127.0.0.1:19080'
health_url='https://ilinkai.weixin.qq.com/'
failure_file='/run/wechat-clawbot-cdn-tunnel-health/consecutive-failures'
failure_threshold=2

active_proxy_clients() {
  /usr/bin/ss -Htn state established '( dport = :19080 )' | /usr/bin/grep -q .
}

reset_failures() {
  /usr/bin/printf '0\n' > "$failure_file"
}

record_failure() {
  local failures=0
  if [[ -r "$failure_file" ]]; then
    read -r failures < "$failure_file" || failures=0
  fi
  [[ "$failures" =~ ^[0-9]+$ ]] || failures=0
  failures=$((failures + 1))
  /usr/bin/printf '%s\n' "$failures" > "$failure_file"
  /usr/bin/printf '%s\n' "$failures"
}

check_tunnel() {
  /usr/bin/curl \
    --silent \
    --show-error \
    --connect-timeout 15 \
    --max-time 30 \
    --proxy "$proxy_url" \
    --output /dev/null \
    "$health_url"
}

# Never let the health probe compete with or terminate a live presign/upload
# request. The upload path has its own finite timeout and retry policy.
if active_proxy_clients; then
  exit 0
fi

if check_tunnel; then
  reset_failures
  exit 0
fi

# A client may have connected while the probe was running. Close the race
# before taking the disruptive action.
if active_proxy_clients; then
  exit 0
fi

failures="$(record_failure)"
if (( failures < failure_threshold )); then
  echo "Weixin CDN tunnel HTTPS probe failed (${failures}/${failure_threshold}); deferring restart." >&2
  exit 0
fi

echo "Weixin CDN tunnel HTTPS probe failed ${failures} consecutive times; restarting it." >&2
reset_failures
/usr/bin/systemctl restart wechat-clawbot-cdn-tunnel.service
/usr/bin/sleep 5
if check_tunnel; then
  reset_failures
  exit 0
fi

record_failure >/dev/null
exit 1
