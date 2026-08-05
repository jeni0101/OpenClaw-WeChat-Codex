# 升级与回退

版本升级不自动进行。先确认数据卷低于 70%、项目实际分配低于 8.5 GiB，并完成加密备份。

1. 记录 `package.json`、`package-lock.json`、Node 与 COSCLI SHA-256。
2. 在独立分支只修改精确版本号，使用项目本地 Node/npm 生成 lockfile。
3. 执行 `npm ci` 前检查预计空间；依赖仍必须安装到 6 GiB 数据卷，不能使用全局 npm。安装 `@openclaw/codex` 后运行 `npm run build && sudo npm run prune:platform`，删除非当前 CPU/系统的约 1.6 GiB 二进制包。
4. 运行 `npm run check`、OpenClaw `config validate`、`doctor --lint --all`、`security audit --deep` 和插件检查。
5. 验证微信插件登录、owner allowFrom、模型探测、审批拒绝/批准/回滚与备份 dry-run。
6. 只重启 `wechat-clawbot-ops.service`、`wechat-clawbot-gateway.service`；观察资源和日志。

失败时恢复旧的 `package.json`/lockfile 与对应依赖快照，再重启 ClawBot 服务。不得用破坏性 Git 命令，也不得重启无关生产服务。
