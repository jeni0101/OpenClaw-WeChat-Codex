# 安装、登录与上线

以下命令均在服务器本地终端执行；不要把设备码、二维码链接、OAuth 文件或 CAM 密钥粘贴到聊天中。

公开仓库仅跟踪脱敏模板。首次安装先在本机创建实际配置：

```bash
install -m 0640 config/openclaw.example.json config/openclaw.json
install -m 0640 config/projects.example.yaml config/projects.yaml
install -m 0644 config/age-recipient.example.txt config/age-recipient.txt
install -m 0600 config/cam-provision-policy.example.json config/cam-provision-policy.json
install -m 0600 config/cam-runtime-policy.example.json config/cam-runtime-policy.json
install -m 0600 config/cam-media-policy.example.json config/cam-media-policy.json
sudo install -d -o root -g root -m 0700 /etc/wechat-clawbot
sudo install -o root -g root -m 0600 .env.example /etc/wechat-clawbot/runtime.env
```

替换所有 `REPLACE_WITH_*` 后再继续。实际配置受 `.gitignore` 保护，但仍应在提交前
执行 `npm run secret:scan`。

全新新加坡服务器先执行 [迁移手册](MIGRATION-SINGAPORE.md) 中的预检和
`deploy/install-singapore.sh`。systemd `.cred` 文件与原服务器机器绑定，不能
直接复制。

## 1. 保存离线恢复私钥

服务器私钥位于 `recovery/wechat-clawbot-recovery.agekey`，权限为 root 只读。把它复制到你控制的加密离线介质，然后核对公钥：

```bash
sudo age-keygen -y recovery/wechat-clawbot-recovery.agekey
cat config/age-recipient.txt
```

两行应一致。离线副本验证完成前不要删除服务器副本；COS 中不会保存明文私钥。

## 2. ChatGPT 订阅 OAuth

OpenClaw Gateway 和受控 Codex 子进程分别维护凭据目录，因此需要各做一次设备码登录：

```bash
sudo -u wechat-clawbot env \
  HOME='/opt/WeChat-Open in/data/home' \
  OPENCLAW_STATE_DIR='/opt/WeChat-Open in/data/state' \
  OPENCLAW_CONFIG_PATH='/opt/WeChat-Open in/config/openclaw.json' \
  '/opt/WeChat-Open in/data/node/bin/node' \
  '/opt/WeChat-Open in/node_modules/openclaw/openclaw.mjs' \
  models auth login --provider openai --device-code

sudo -u wechat-clawbot env \
  PATH='/opt/WeChat-Open in/data/node/bin:/usr/sbin:/usr/bin:/sbin:/bin' \
  HOME='/opt/WeChat-Open in/data/state/codex' \
  CODEX_HOME='/opt/WeChat-Open in/data/state/codex' \
  '/opt/WeChat-Open in/node_modules/.bin/codex' login --device-auth
```

登录后探测模型：

```bash
sudo -u wechat-clawbot env \
  HOME='/opt/WeChat-Open in/data/home' \
  OPENCLAW_STATE_DIR='/opt/WeChat-Open in/data/state' \
  OPENCLAW_CONFIG_PATH='/opt/WeChat-Open in/config/openclaw.json' \
  '/opt/WeChat-Open in/data/node/bin/node' \
  '/opt/WeChat-Open in/node_modules/openclaw/openclaw.mjs' \
  models status --probe --probe-provider openai
```

配置先探测 `openai/gpt-5.6-sol`，回退项为 `openai/gpt-5.5`。若账号明确不提供主模型，先留存探测输出，再把 `agents.defaults.model.primary` 明确改为 `openai/gpt-5.5` 并运行配置校验；不得静默换模型。

## 3. 微信扫码和 owner 固定

```bash
sudo -u wechat-clawbot env \
  HOME='/opt/WeChat-Open in/data/home' \
  OPENCLAW_STATE_DIR='/opt/WeChat-Open in/data/state' \
  OPENCLAW_CONFIG_PATH='/opt/WeChat-Open in/config/openclaw.json' \
  '/opt/WeChat-Open in/data/node/bin/node' \
  '/opt/WeChat-Open in/node_modules/openclaw/openclaw.mjs' \
  channels login --channel openclaw-weixin

sudo '/opt/WeChat-Open in/data/node/bin/node' \
  '/opt/WeChat-Open in/dist/scripts/configure-owner.js'
```

脚本只接受恰好一个配对 owner，并把 ID 保存为 systemd 加密凭据。

## 4. COS 专用 CAM 和私有桶

先给专用 CAM 子账号临时附加 `config/cam-provision-policy.json`，本地隐藏录入：

```bash
./deploy/configure-cos-credentials.sh
sudo systemctl start wechat-clawbot-cos-provision.service
sudo journalctl -u wechat-clawbot-cos-provision.service -n 50 --no-pager
```

确认桶、AES256 服务端加密和生命周期规则成功后，立即撤销 provision policy，只保留 `config/cam-runtime-policy.json`。不要使用主账号密钥。

COS 仅用于加密备份和审计归档，不参与微信附件交付。媒体服务必须保持
`deliveryMode:"native-only"`；不得为办公附件自动压缩、拆分、改名或生成 COS
下载链接。较大的 ImageGen 原图可生成明确标注的微信展示图，完整原图必须保留。
历史 `configure-media-cos-credentials.sh` 只作回滚材料保留，不应执行。
原生附件失败时只报告结构化失败并保留原文件，不得自动改发任何下载链接。

## 5. 启动

微信 iLink 的预签名和 CDN 上传必须经过同一个可信中国大陆出口。启动前先为
`ubuntu` 用户配置可批处理登录的 `wechat-cdn-egress` SSH 别名及已验证的
`known_hosts`；不得关闭主机密钥校验。确认下面命令无需交互且返回成功：

```bash
sudo -u ubuntu ssh -o BatchMode=yes wechat-cdn-egress true
```

没有完成可信出口配置时不得启动 Gateway；不要删除
`WEIXIN_CDN_SOCKS_PROXY` 后退回不一致的直连路径。

```bash
npm run check
sudo ./deploy/install-media-plugin.sh
sudo systemctl enable --now wechat-clawbot-cdn-tunnel.service
sudo systemctl enable --now wechat-clawbot-cdn-tunnel-health.timer
sudo systemctl enable --now wechat-clawbot-ops.service wechat-clawbot-media.service wechat-clawbot-gateway.service
sudo systemctl enable --now wechat-clawbot-backup-daily.timer wechat-clawbot-backup-weekly.timer
sudo systemctl restart wechat-clawbot-maintenance.timer
```

最后按 [日常运维](OPERATIONS.md) 的验收命令检查。未完成 OAuth、微信 owner 或 COS 凭据时，对应服务会安全失败，不应反复重启尝试。
