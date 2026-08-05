# OpenClaw WeChat Codex

一个面向单一微信 owner 私聊场景的安全型 OpenClaw 部署模板。它将 OpenClaw、
Codex CLI、微信 ClawBot、受限项目操作代理、原生附件桥接和加密备份组合在一起，
并通过 systemd 沙箱、显式白名单和一次性审批控制高风险操作。

> 这是经过脱敏的公开版本。仓库不包含任何微信账号、OAuth 状态、Token、CAM
> 密钥、age 私钥、公网地址、真实项目清单、聊天记录、备份或运行日志。

## 安全边界

- Gateway 只监听 `127.0.0.1:18789`，不应通过安全组或反向代理暴露到公网。
- 仅允许一个微信 owner；群聊、WebChat、任意 shell、Docker Socket 和 sudo
  不向模型开放。
- Codex 在固定身份、固定目录和受限代理下运行；项目变更通过明确配方和短时审批。
- 微信原生附件通过独立媒体桥接服务发送，账号 ID 必须在本机显式配置。
- COS 只保存 age 加密备份，访问凭据通过 systemd encrypted credentials 注入。
- 运行状态位于独立数据卷；Git 永不跟踪状态、缓存、授权材料或密文包。

## 组成

- OpenClaw 与腾讯微信插件
- Codex CLI 与 OpenClaw Codex 插件
- `project-ops` 白名单项目操作代理
- `wechat-media-bridge` 原生附件服务
- 腾讯 COS 加密备份和恢复工具
- systemd 服务、定时器、资源限制和安全加固配置

依赖版本锁定在 [`package.json`](package.json) 和
[`package-lock.json`](package-lock.json) 中。第三方依赖仍受各自许可证约束。

## 快速开始

要求 Ubuntu 24.04、x86_64、systemd、至少 2 GiB 内存和 12 GiB 可用磁盘；
生产环境建议 4 GiB 内存。

```bash
git clone https://github.com/jeni0101/OpenClaw-WeChat-Codex.git "/opt/WeChat-Open in"
cd "/opt/WeChat-Open in"
npm ci --legacy-peer-deps
npm run check
```

上线前必须完成以下本机配置：

1. 将 `.env.example` 复制到 `/etc/wechat-clawbot/runtime.env`，替换所有
   `REPLACE_WITH_*`，设置为 `root:root 0600`。
2. 从 `config/*.example.*` 复制出不带 `.example` 的本机配置；这些实际配置已被
   `.gitignore` 排除。
3. 把 `config/age-recipient.txt` 替换为你自己的 age 公钥；私钥只保存在离线介质。
4. 将三个 CAM 策略中的 APPID、桶名和地域替换为自己的私有 COS 资源。
5. 用自己的项目重写 `config/projects.yaml`，同时收紧 systemd 的
   `ReadWritePaths`。
6. 按 [`docs/INSTALL.md`](docs/INSTALL.md) 分别完成 OpenClaw 和 Codex 设备码登录，
   再完成微信扫码和单 owner 固定。
7. 为微信预签名与 CDN 上传配置可信且一致的出口；没有需要时不要启用 SSH
   SOCKS 隧道单元。

任何 `REPLACE_WITH_*` 未替换时都不应启动生产服务。

## 验证

```bash
npm run secret:scan
npm run build
npm test
```

测试覆盖文件边界、审批、审计、项目配方、systemd 安全配置、COS、备份恢复和
微信原生附件路径。需要 root 或真实运行环境的集成测试默认跳过。

## 文档

- [安装、登录与上线](docs/INSTALL.md)
- [安全边界](docs/SECURITY.md)
- [日常运维](docs/OPERATIONS.md)
- [备份与恢复](docs/BACKUP-RESTORE.md)
- [升级与回退](docs/UPGRADE.md)
- [服务器迁移](docs/MIGRATION-SINGAPORE.md)

## 许可证

本项目自有代码使用 [MIT License](LICENSE)。使用微信、OpenClaw、Codex、腾讯云
或其他第三方服务时，还需遵守对应产品条款和第三方许可证。
