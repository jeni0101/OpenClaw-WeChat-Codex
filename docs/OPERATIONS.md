# 日常运维与验收

## 服务与资源

```bash
systemctl status wechat-clawbot-cdn-tunnel.service wechat-clawbot-gateway.service wechat-clawbot-ops.service wechat-clawbot-media.service
systemctl list-timers 'wechat-clawbot-*'
systemctl show wechat-clawbot.slice -p MemoryCurrent -p MemoryPeak -p MemoryHigh -p MemoryMax -p MemorySwapMax
df -h '/opt/WeChat-Open in/data'
du -sx --block-size=1 '/opt/WeChat-Open in'
cat '/opt/WeChat-Open in/data/reports/disk-budget.json'
```

迁移准备状态：

```bash
cd '/opt/WeChat-Open in'
npm run migration:preflight
```

出现 pending 备份、缺少迁移发布包或恢复私钥时不得切换服务器。

总系统盘预算闸门为 8.5 GiB，绝对目标小于 10 GB；数据卷固定为 6 GiB。70% 会清空可再生成缓存并删除超过 24 小时的临时项，85% 禁止新暂存，95% 仅保留聊天和只读状态。每日维护最后对稀疏镜像执行 `fstrim`，把已释放的数据卷块归还宿主系统盘。

## 日志与清理

```bash
sudo journalctl -u wechat-clawbot-cdn-tunnel.service -u wechat-clawbot-gateway.service -u wechat-clawbot-ops.service -u wechat-clawbot-media.service --since today
sudo systemctl start wechat-clawbot-maintenance.service
sudo journalctl -u wechat-clawbot-maintenance.service -n 50 --no-pager
```

Gateway JSONL 单文件上限 25 MiB、本地 7 天；运维审计 30 天；所有日志合计预算 512 MiB。审计只记录 owner 哈希、请求哈希、源哈希、结果哈希、动作和状态，不记录完整聊天、任务正文或密钥。

## 图片与办公文件

单文件上限为 50 MiB，本地媒体预算为 768 MiB。媒体服务仅监听 Unix Socket，内存硬上限 256 MiB：

```bash
sudo systemctl status wechat-clawbot-media.service
sudo -u wechat-clawbot curl --silent --unix-socket \
  '/opt/WeChat-Open in/data/run/media-bridge.sock' http://localhost/health
```

健康检查必须返回 `deliveryMode:"native-only"`。COS 媒体兜底已停用；不要恢复
`wechat-clawbot-media.service.d/credentials.conf`，也不要执行历史媒体 COS
凭据脚本。

微信验收依次发送 PNG/JPEG、PDF、DOCX、XLSX、PPTX、ZIP、MP3、MP4；再要求
助手生成图片并发回。办公文件必须保持源文件大小和 SHA-256 一致。实测腾讯
iLink CDN 对约 1.45 MiB 的生成 PNG 持续返回 500，而 220 KiB 以下 IMAGE
消息可成功；因此较大的 ImageGen 图片会在保留服务器完整原图的同时生成不超过
220 KiB 的 JPEG 微信展示图，并在聊天中明确标注。该例外只适用于生成图片，
不适用于 PPTX、PDF 或其他办公源文件，也不会改发下载链接。

### iLink CDN 大文件协议验收

原生上传使用固定 `Content-Length` 的流式 AES-128-ECB 请求，不会把完整明文和
密文同时留在 Gateway 内存。生产使用 `POST + upload_full_url`，且
`getuploadurl` 与 CDN 上传必须同时经过
`socks5h://127.0.0.1:19080` 的可信出口。若预签名直连、仅 CDN 走代理，腾讯
仍可能返回 500；不得配置直连兜底。

```bash
systemctl status wechat-clawbot-cdn-tunnel.service wechat-clawbot-gateway.service
ss -ltn '( sport = :19080 )'
sudo -u wechat-clawbot curl --socks5-hostname 127.0.0.1:19080 \
  --connect-timeout 15 --max-time 30 --output /dev/null \
  --write-out 'HTTP %{http_code}\n' https://ilinkai.weixin.qq.com/
```

最后一条返回可达的 HTTP 状态（当前根路径为 404）即表示 TLS 代理链路正常。
隧道不可用时上传必须失败，不允许静默退回服务器直连。
`wechat-clawbot-cdn-tunnel-health.timer` 每分钟执行一次真实 SOCKS5h HTTPS
请求。探针发现 19080 存在活跃客户端连接时会跳过，避免在预签名或长上传期间
重启隧道；空闲状态下必须连续两次真实 HTTPS 检查失败才会自动重启。单次瞬时
超时不会再中断媒体传输。健康服务的 `RuntimeDirectoryPreserve=yes` 必须保留，
否则 oneshot 结束时会删除连续失败计数，导致退化隧道永远停留在 1/2。

遇到 CDN 5xx、网络错误或 200 但缺少 `x-encrypted-param` 时，每次重试都会
重新校验源 inode、大小和 SHA-256，并申请全新的 filekey、AES key 和 taskid。
小于 512 KiB 的文件退避为 5、15、45 秒；512 KiB–16 MiB 的文件退避为
60、120、240 秒；至少 16 MiB 的文件最多使用 6 个全新任务，退避为
60、120、180、240、300 秒，避免密集请求触发腾讯限流。CDN 4xx 立即失败。
上传超时按 32 KiB/s 加 120 秒计算，最短 120 秒、最长 1800 秒。只有取得 CDN
回执且后续 `sendmessage` 成功才会确认发送完成。

生产工作文件由 `wechat-clawbot-media.service` 的 SQLite 持久队列发送，不再
把长上传任务寄生在 Gateway/Codex 回合中。队列全局单并发；大于等于 512 KiB 的
文件每个 worker 周期只申请一个新任务，遇到可重试错误后依次冷却
15、30、60、120、240、480 分钟。媒体服务或 Gateway 重启后保留原 transferId、
SHA-256、尝试次数和下次执行时间并自动恢复。同一账号和 SHA 存在 pending 任务
时，重复调用只返回原 transferId。附件和 caption 的腾讯 `client_id` 由
transferId 固定派生，用于覆盖“发送成功后、落库前重启”的幂等窗口。
冷却是账号级的：任一受限文件打开熔断后，其他至少 512 KiB 的文件也等待同一
时间；小于 512 KiB 的附件不受影响。`WEIXIN_SEND_FAILED` 也使用固定 client_id
持久重试，避免
CDN 已成功但消息确认网络抖动时永久丢失。
持久队列只发送原生附件，不再追加独立 caption 或成功/重试状态通知；这些冗余
消息会消耗同一 iLink `sendmessage` 配额，并可能反过来阻塞附件。文件说明保留在
文件内容或 owner 主动发起的状态查询中，不在入队后另发；对外工具参数保持兼容。
`weixin_send_current_attachment` 成功入队后，调用方必须只输出 `NO_REPLY`；
插件不得发送入队、开始、成功或失败状态文本，也不得把本地媒体 payload 中的
说明文本单独下发。状态保留在 SQLite，需要时由 owner 发起查询。这样每个文件
只占用附件本身的一次腾讯下行额度。
CDN/预签名失败与消息失败使用独立账户熔断。`sendmessage ret=-2` 时，当前 worker
保留已成功的 CDN 回执和固定 client_id，按 1、5、15 分钟重试；仍失败才释放回执，
并冻结整个附件队列 15 分钟。消息熔断期间不得启动下一个文件上传。
每次 `sendmessage` 都重新读取最新 `context_token`；上传或同回执退避期间收到
真实微信入站时，token 变化会提前唤醒发送。媒体服务在没有在途 worker 时也会
检测 context 文件更新，只解除消息熔断并提前消息失败任务，不解除 CDN 5xx 熔断。
消息失败还会持久设置 `message_refresh_after_context_mtime_ms`；没有新入站时，
时间冷却到期也不得重新上传。该门禁跨媒体服务重启保留，只有 context 文件 mtime
严格前进才解除。
灰度期间 owner 可单独发送“继续灰度（无需回复）”；工作区规则要求机器人返回
`NO_REPLY`，只刷新 context 而不消耗新的下行消息额度。
每个 ≥512 KiB 附件成功后，账户队列静默 15 分钟再启动下一笔；积压任务按文件
大小从小到大处理。`large_circuit_until` 管理 512 KiB–40 MiB 普通档，并可阻挡
所有更大任务；`boundary_circuit_until` 只管理 ≥40 MiB 边界档。边界失败退避
最多 60 分钟，避免无依据的 8 小时冻结，同时不会放松普通档失败的账户级保护。
Gateway 对媒体桥使用 `Wants+After` 而非停止传播依赖；媒体 worker 独立重启时
聊天 Gateway 保持原 PID，上传队列则从 SQLite 恢复。

```bash
sudo sqlite3 -header -column \
  '/opt/WeChat-Open in/data/state/media-bridge.sqlite' \
  "SELECT transfer_id,state,queued,attempt_count,error_code,
          datetime(next_attempt_at/1000,'unixepoch') AS next_utc
   FROM deliveries WHERE queued=1 OR state='pending'
   ORDER BY created_at;"
```

systemd 环境由 `launch-gateway` 经过严格白名单传入真正的
`openclaw-gateway` 子进程；缺少受管 `WEIXIN_CDN_SOCKS_PROXY` 时 Gateway
必须拒绝启动，不得在子进程中静默降级为直连。

构建 64 KiB、约 1.56 MiB 和 16 MiB 的固定 PPTX 样本后，运行只上传、不发消息
的协议矩阵：

```bash
sudo -u wechat-clawbot python3 scripts/build-pptx-matrix.py \
  '/opt/WeChat-Open in/data/tmp/weixin-media-acceptance-production' \
  --targets-kib 64,16384

npm run build
sudo -u wechat-clawbot env \
  WEIXIN_DIAG_VARIANTS='curl-post-full' \
  WEIXIN_DIAG_CURL_PROXY='socks5h://127.0.0.1:19080' \
  '/opt/WeChat-Open in/data/node/bin/node' \
  dist/scripts/diagnose-weixin-media.js \
  '/opt/WeChat-Open in/data/tmp/weixin-media-acceptance-production' \
  '/opt/WeChat-Open in/data/reports/weixin-media-protocol-acceptance-production.jsonl'
```

1.3–2 MiB 档必须使用锁定的真实业务 PPTX 原件，不使用随机图片填充的合成
1.54 MiB 文件；后者会触发腾讯内容相关 500，不能用于判断传输协议。
脚本自动要求 64 KiB 连续 3 次、1.3–2 MiB 连续 5 次、至少 15 MiB 连续 3 次。
大文件连续测试之间保留至少 45 秒冷却，避免腾讯短时限流污染协议判断。

2026-07-24 最终验收：64 KiB 3/3、真实 1.56 MiB 5/5、16 MiB 3/3 均成功，
全部为 `POST + upload_full_url`、同一可信出口、HTTP 200 且存在
`x-encrypted-param`。16 MiB 三次分别约 50.0、125.3、53.8 秒。生产原生发送
4 MiB 和 16 MiB 均一次上传、一次 `sendmessage` 成功；16 MiB 源 SHA-256 为
`40e339336156a17ddf3728138de8a091286cf9574517b4eff0b1c3cb712f271d`。
服务端未下发 `upload_param`，PUT 返回 404，因此不配置备用方法。

48.97 MiB 边界文件（51,353,906 字节，SHA-256
`299a5f18d4b8b7a167837c5fac39bff7d391c8590a01a39dea56964804328e5f`）
前两次新任务返回 500，均未调用 `sendmessage`；第 3 次在约 793.2 秒后取得
HTTP 200 和上传回执，随后只调用一次 `sendmessage` 并成功。这验证了接近
50 MiB 上限时不会因本地写完、5xx 或慢速传输而假报成功。

结构化失败码包括 `WEIXIN_PRESIGN_FAILED`、`WEIXIN_CDN_4XX`、
`WEIXIN_CDN_5XX`、`WEIXIN_CDN_PROTOCOL`、`WEIXIN_CDN_NETWORK`、
`WEIXIN_CDN_TIMEOUT`、`SOURCE_HASH_CHANGED` 和 `WEIXIN_SEND_FAILED`。
日志只保留 taskid、方法、URL 来源、大小、哈希和有限的脱敏响应，不保存 token、
AES key 或完整上传参数。所有组合均不合格时，应生成腾讯支持材料按 taskid
排查 CDN/账号权限，不得把本地 50 MiB 安全上限当作根因。

## 本地管理界面

Gateway 只监听回环地址。客户端建立隧道：

```bash
ssh -L 18789:127.0.0.1:18789 your-user@your-server
```

然后只在本机访问 `http://127.0.0.1:18789`。不要把 18789 端口加入安全组或反向代理。

## 微信审批

只读 `project_list`、`project_status` 不需要批准。修改、依赖安装、服务启停、应用和回滚先产生审批 ID；owner 必须直接发送：

```text
/approve <id> allow
/approve <id> deny
```

批准不经过模型，10 分钟过期且只能使用一次。开发会先进入隔离暂存；查看差异与测试后，应用需要第二次批准。现场源哈希变化会立即中止。

## 上线验收

```bash
sudo -u wechat-clawbot env \
  HOME='/opt/WeChat-Open in/data/home' \
  OPENCLAW_STATE_DIR='/opt/WeChat-Open in/data/state' \
  OPENCLAW_CONFIG_PATH='/opt/WeChat-Open in/config/openclaw.json' \
  '/opt/WeChat-Open in/data/node/bin/node' \
  '/opt/WeChat-Open in/node_modules/openclaw/openclaw.mjs' config validate --json

sudo -u wechat-clawbot env \
  HOME='/opt/WeChat-Open in/data/home' \
  OPENCLAW_STATE_DIR='/opt/WeChat-Open in/data/state' \
  OPENCLAW_CONFIG_PATH='/opt/WeChat-Open in/config/openclaw.json' \
  '/opt/WeChat-Open in/data/node/bin/node' \
  '/opt/WeChat-Open in/node_modules/openclaw/openclaw.mjs' doctor --lint --all --json
```

安全审计从 systemd credential 读取 Gateway token，不会把 token 放进 shell 历史：

```bash
sudo systemctl start wechat-clawbot-security-audit@static.service
sudo systemctl start wechat-clawbot-security-audit@deep.service
sudo journalctl -u 'wechat-clawbot-security-audit@*.service' -n 100 --no-pager
```

深度审计应在 Gateway 启动后运行。完成后依次验证微信文字/文件收发、图片 OCR、PDF 和 Office 提取、跨会话记忆、两分钟提醒、真实项目只读状态；现有生产服务不得作为启停测试对象。
