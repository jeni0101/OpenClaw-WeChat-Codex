# 备份与恢复

## 策略

- 每天 04:00 日备份，周日 04:30 周备份。
- age 客户端加密后再上传，并要求 COS AES256 服务端加密。
- 日备份 30 天、周备份 43 天（约 6 周）、审计 90 天、回滚包 30 天；未完成分片 3 天清除。
- 每个对象带 SHA-256 和大小元数据，配套 manifest 上传后 HEAD 校验。
- 明确排除 OAuth、微信 token、CAM 凭据、`.env`、SSH/age 私钥和业务密钥。

本地缓冲每类只保留最近两份。失败上传保留在 `data/backups/pending`，成功项移动到 `data/backups/uploaded`。

## 手工备份

```bash
sudo systemctl start wechat-clawbot-backup@daily.service
sudo journalctl -u wechat-clawbot-backup@daily.service -n 50 --no-pager
```

失败归档保留在 pending；修复网络或 COS 后只重试原密文，不重新生成重复归档：

```bash
cd '/opt/WeChat-Open in'
npm run build
sudo systemd-run --wait --pipe --collect \
  --unit=wechat-clawbot-backup-retry-manual \
  --slice=wechat-clawbot.slice \
  --uid=wechat-clawbot --gid=wechat-clawbot \
  --working-directory='/opt/WeChat-Open in' \
  --setenv='WECHAT_CLAWBOT_DATA=/opt/WeChat-Open in/data' \
  --setenv=COS_BUCKET=wechat-clawbot-REPLACE_WITH_APPID \
  --setenv=COS_REGION=REPLACE_WITH_COS_REGION \
  --property=LoadCredentialEncrypted=cos-secret-id:/etc/credstore.encrypted/wechat-clawbot-cos-secret-id.cred \
  --property=LoadCredentialEncrypted=cos-secret-key:/etc/credstore.encrypted/wechat-clawbot-cos-secret-key.cred \
  '/opt/WeChat-Open in/data/node/bin/node' \
  '/opt/WeChat-Open in/dist/scripts/backup.js' --retry-pending
```

大归档使用最多 8 个并行分片、单任务一个文件、每次尝试 15 分钟时限和最多三次
重试；仍受统一 cgroup 内存上限约束。

## COS 恢复 dry-run

先从私有桶列出明确的对象键，然后以临时 unit 传入键，避免 `%i` 对斜杠转义的问题：

```bash
sudo systemd-run --wait --pipe --collect \
  --unit=wechat-clawbot-restore-manual \
  --slice=wechat-clawbot.slice \
  -p User=root -p Group=wechat-clawbot \
  -p WorkingDirectory='/opt/WeChat-Open in' \
  -p Environment='WECHAT_CLAWBOT_DATA=/opt/WeChat-Open in/data' \
  -p Environment='COS_BUCKET=wechat-clawbot-REPLACE_WITH_APPID' \
  -p Environment='COS_REGION=REPLACE_WITH_COS_REGION' \
  -p LoadCredentialEncrypted='cos-secret-id:/etc/credstore.encrypted/wechat-clawbot-cos-secret-id.cred' \
  -p LoadCredentialEncrypted='cos-secret-key:/etc/credstore.encrypted/wechat-clawbot-cos-secret-key.cred' \
  -p LoadCredentialEncrypted='age-key:/etc/credstore.encrypted/wechat-clawbot-age-key.cred' \
  '/opt/WeChat-Open in/data/node/bin/node' \
  '/opt/WeChat-Open in/dist/scripts/restore.js' \
  --dry-run --key 'daily/REPLACE_WITH_OBJECT.tar.zst.age'
```

脚本会下载密文与 manifest、再次验证大小/SHA-256、解密并检查 tar 路径安全。正式恢复只能解压到一个显式、不存在、且位于实时项目外的新目录；检查完成后再人工决定如何迁移，绝不直接覆盖运行目录。

离线恢复私钥测试应在临时目录完成，测试明文完成后安全删除。COS 中不能存放恢复私钥。

迁移发布包不是状态备份。它只包含可复现安装所需的代码、lockfile、配置、测试
和手册，使用相同 age 公钥加密后存入 `rollback/migration/`。操作步骤见
[新加坡迁移手册](MIGRATION-SINGAPORE.md)。
