#!/usr/bin/env bash
set -euo pipefail

credential_root=/etc/credstore.encrypted
sudo install -d -m 0700 "$credential_root"

secret_id="$(systemd-ask-password --timeout=0 "Tencent COS CAM SecretId")"
if [[ ! "$secret_id" =~ ^AKID[A-Za-z0-9]{32}$ ]]; then
  unset secret_id
  echo "Invalid Tencent Cloud SecretId: expected AKID followed by 32 letters/digits." >&2
  exit 1
fi

secret_key="$(systemd-ask-password --timeout=0 "Tencent COS CAM SecretKey")"
if [[ ${#secret_key} -ne 32 ]]; then
  unset secret_id secret_key
  echo "Invalid Tencent Cloud SecretKey: expected 32 characters." >&2
  exit 1
fi

printf '%s' "$secret_id" |
  sudo systemd-creds encrypt --name=cos-secret-id - "$credential_root/wechat-clawbot-cos-secret-id.cred"
printf '%s' "$secret_key" |
  sudo systemd-creds encrypt --name=cos-secret-key - "$credential_root/wechat-clawbot-cos-secret-key.cred"
unset secret_id secret_key

sudo chmod 0600 \
  "$credential_root/wechat-clawbot-cos-secret-id.cred" \
  "$credential_root/wechat-clawbot-cos-secret-key.cred"

echo "COS credentials stored as machine-bound systemd encrypted credentials."
echo "Run the documented one-time bucket provisioning command, then enable backup timers."
