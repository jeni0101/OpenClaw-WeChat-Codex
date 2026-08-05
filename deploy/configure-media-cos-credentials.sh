#!/usr/bin/env bash
set -euo pipefail

credential_root=/etc/credstore.encrypted
dropin_root=/etc/systemd/system/wechat-clawbot-media.service.d
project_root='/opt/WeChat-Open in'

sudo install -d -m 0700 "$credential_root"

secret_id="$(systemd-ask-password --timeout=0 "NEW dedicated WeChat delivery CAM SecretId")"
if [[ ! "$secret_id" =~ ^AKID[A-Za-z0-9]{32}$ ]]; then
  unset secret_id
  echo "Invalid Tencent Cloud SecretId." >&2
  exit 1
fi

secret_key="$(systemd-ask-password --timeout=0 "NEW dedicated WeChat delivery CAM SecretKey")"
if [[ ${#secret_key} -ne 32 ]]; then
  unset secret_id secret_key
  echo "Invalid Tencent Cloud SecretKey." >&2
  exit 1
fi

printf '%s' "$secret_id" |
  sudo systemd-creds encrypt --name=cos-secret-id - "$credential_root/wechat-clawbot-media-cos-secret-id.cred"
printf '%s' "$secret_key" |
  sudo systemd-creds encrypt --name=cos-secret-key - "$credential_root/wechat-clawbot-media-cos-secret-key.cred"
unset secret_id secret_key

sudo chmod 0600 \
  "$credential_root/wechat-clawbot-media-cos-secret-id.cred" \
  "$credential_root/wechat-clawbot-media-cos-secret-key.cred"
sudo install -d -m 0755 "$dropin_root"
sudo install -o root -g root -m 0644 \
  "$project_root/deploy/systemd/wechat-clawbot-media-credentials.conf" \
  "$dropin_root/credentials.conf"
sudo systemctl daemon-reload
sudo systemctl restart wechat-clawbot-media.service

echo "Dedicated media COS credentials installed. The SecretId/SecretKey were not echoed or stored in project files."
