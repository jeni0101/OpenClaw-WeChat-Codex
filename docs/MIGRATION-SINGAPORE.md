# 迁移到新加坡服务器

目标是让本项目最终只在新加坡服务器运行。迁移采用“新机重建 + 加密恢复 +
单次切换”，不复制当前机器绑定凭据，也不允许新旧 Gateway 同时在线。

## 新服务器要求

- Ubuntu 24.04、x86_64、systemd。
- 至少 2 GiB 内存，推荐 4 GiB；至少 20 GB 系统盘。
- 项目固定解压到 `/opt/WeChat-Open in`。
- TCP 18789 不开放安全组，只允许 SSH 隧道访问本机 Gateway。
- 如果继续使用指定 COS 桶，保持 `COS_REGION=REPLACE_WITH_COS_REGION`。跨地域加速必须由
  owner 单独决定，迁移脚本不会自动启用收费能力。

## 旧服务器准备

```bash
cd '/opt/WeChat-Open in'
npm run check
sudo systemctl start wechat-clawbot-backup@daily.service
npm run migration:verify
npm run migration:preflight
```

必须满足：

- 最新 daily 归档成功上传且恢复 dry-run 通过。
- `data/backups/pending/` 没有密文。
- `data/migration/releases/` 存在最新迁移包及 manifest。
- 离线保存的 `recovery/wechat-clawbot-recovery.agekey` 与
  `config/age-recipient.txt` 匹配。

迁移发布包只包含代码、锁文件、配置、systemd、测试和手册，并使用 age 加密。
明确排除 `data/`、`.storage/`、OAuth、微信 token、CAM、SSH/age 私钥、`.env`
和 `node_modules`。

## 新机基础安装

通过 SCP 或腾讯云控制台把“加密迁移发布包、manifest、离线 age 私钥”传到新机。
私钥只能进入 root 权限目录，不能放进项目、聊天或 COS。

先核验 manifest 中的归档 SHA-256，然后解密：

```bash
sudo apt-get update
sudo apt-get install -y age zstd
sudo install -d -o root -g root -m 0755 '/opt/WeChat-Open in'
sudo age --decrypt --identity /root/wechat-clawbot-recovery.agekey \
  --output /root/wechat-clawbot-release.tar.zst \
  /root/REPLACE_WITH_RELEASE.tar.zst.age
sudo tar --extract --zstd --file /root/wechat-clawbot-release.tar.zst \
  --directory '/opt/WeChat-Open in' --no-same-owner
cd '/opt/WeChat-Open in'
sudo ./deploy/preflight-singapore.sh --target
sudo ./deploy/install-singapore.sh
```

安装器会创建低权限账号和 6 GiB 数据卷，校验后安装项目本地 Node 24.15.0，
用 lockfile 安装依赖并构建插件，再生成新机器专属的 Gateway/Broker 加密凭据。
Gateway 会保持关闭，等待恢复和人工授权。

## 恢复状态

在新机本地无回显录入 COS 专用 CAM，并把离线 age 私钥重新加密为新机器凭据：

```bash
cd '/opt/WeChat-Open in'
./deploy/configure-cos-credentials.sh
sudo systemd-creds encrypt --name=age-key \
  /root/wechat-clawbot-recovery.agekey \
  /etc/credstore.encrypted/wechat-clawbot-age-key.cred
```

使用 [备份与恢复](BACKUP-RESTORE.md) 的命令把最新 daily 对象恢复到一个位于实时
项目外的新目录。先 dry-run，再正式解压，例如
`/var/lib/wechat-clawbot-restore-YYYYMMDD`。随后：

```bash
sudo '/opt/WeChat-Open in/deploy/import-restored-state.sh' --dry-run \
  /var/lib/wechat-clawbot-restore-YYYYMMDD
sudo '/opt/WeChat-Open in/deploy/import-restored-state.sh' \
  /var/lib/wechat-clawbot-restore-YYYYMMDD
```

导入脚本只接受记忆、agents/cron 状态、任务和 OpenClaw 配置；遇到软链接、特殊
文件或凭据文件会拒绝，不直接覆盖正在运行的实例。

## 重新授权与项目登记

备份按设计不含登录凭据，因此在新机重新完成：

1. OpenClaw ChatGPT 设备码登录。
2. Codex 设备码登录。
3. 微信扫码登录并运行 `configure-owner.js`。
4. 本地录入 COS CAM。
5. 核对 `config/projects.yaml`。旧项目没有迁移时先从注册表移除或保持禁用；
   `example-snapshot-service.service` 及 `/srv/wechat-clawbot/projects/example-snapshot-service` 必须另行迁移。

完成 [安装手册](INSTALL.md) 的验收，但暂不启动 Gateway。

## 单次切换

1. 在旧服务器停止并禁用 Gateway，确认微信连接断开。
2. 再执行一次最终 daily 备份，并在新机恢复增量状态。
3. 新机运行配置校验、项目测试、doctor 和安全审计。
4. 启动新机 Gateway，完成微信文字、记忆、提醒、项目只读查询和原生附件验收。
5. 连续观察日志和资源；确认正常后禁用旧机所有 ClawBot timers/services。

禁止新旧 Gateway 同时运行。旧服务器在验收完成前只保留为离线回滚源；验收后
删除其 OAuth、微信、CAM 和 systemd 加密凭据，再按云平台流程释放旧机。

## 回滚

新机验收失败时立即停止新机 Gateway，并在确认微信连接已断开后重新启用旧机
Gateway。不要把新机生成的 machine-bound `.cred` 文件复制回旧机。
