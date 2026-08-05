# 安全边界

- 仅腾讯微信插件产生的单一 owner 私聊上下文可调用项目工具；陌生用户、群聊、WebChat 被拒绝。
- OpenClaw 宿主机原始 `exec`/`process`、浏览器、节点和任意消息发送保持禁用。Codex
  可以在工作区内免重复审批执行构建、测试、格式化、Git 和依赖安装命令，但仍受
  `workspace-write` 文件系统沙箱约束，没有 sudo、root 或 Docker Socket。
- Codex 可访问公开网络；云元数据、回环地址、RFC1918 私网、`.local` 和
  `.internal` 地址保持拒绝。
- Unix Socket 代理从 root 只读注册表加载项目与完整 argv；不启动 shell，不接受任意命令或任意路径。
- 数据库迁移、永久数据删除、SSH、防火墙、系统账号、sudo、密钥、破坏性 Git、任意 Docker 命令和未登记部署默认拒绝。
- clean Git 使用 worktree；脏 Git/非 Git 使用排除依赖、数据和密钥的快照，且默认不可自动应用。
- 自动应用必须同时满足：clean Git、固定测试配方、两阶段审批、现场哈希未变化、补丁不超过 8 MiB。
- systemd 加固包含只读系统目录、私有临时目录、最小 capability、空 capability 的 Gateway，以及统一 cgroup 资源上限。
- 内置 Skills 以 root 只读镜像提供在工作区
  `.openclaw/skills/`，助手可读取但不能修改原件或镜像。
- 通用 `message` 工具保持禁用；`weixin_send_current_attachment` 没有目标参数，只能使用运行时提供的当前 owner 私聊路由。
- 媒体服务负责路径、MIME、文件头、大小、哈希、压缩预算和凭据扫描；附件交付保持
  `native-only`，Gateway 不接触 COS Secret。
- 办公源文件保持逐字节原样发送。仅当 ImageGen 原图超过实测微信图片通道上限时，
  媒体服务使用固定 ImageMagick 参数生成不超过 220 KiB 的微信展示图；原图不删除、
  不覆盖，聊天中明确标注展示图，转换命令不接受模型提供的参数。

`config/projects.yaml` 和 systemd 服务是信任根。修改它们等同于扩大权限，必须人工审查、重新构建、重新运行测试和安全审计，不能交给微信模型修改。

备份 CAM 凭据只允许新桶和 `daily/`、`weekly/`、`audit/`、`rollback/` 前缀。媒体 CAM 使用独立密钥和 `config/cam-media-policy.json`，仅允许 `delivery/`；建桶临时策略使用完必须撤销。任何曾在截图、聊天、表格或日志中展示的 SecretId/SecretKey 都必须先撤销，不能继续用于媒体服务。

## 已知上游依赖告警

2026-07-22 对锁定依赖执行 `npm audit` 时，结果为 0 critical、1 high、9 moderate。告警来自上游 OpenClaw 依赖树，主要涉及 `fast-uri`、`hono`、`@hono/node-server` 和 `protobufjs`，其余条目是依赖影响链。当前 npm 给出的整树自动修复方案会把 OpenClaw 降级到旧版本，不能安全采用；直接覆盖 OpenClaw 自带 shrinkwrap 依赖也没有得到可复现、可验证的安装结果，因此项目没有伪造“已修复”状态。

在上游发布兼容修复版本前：

- Gateway 默认保持未启用，只有完成人工授权并明确接受该已知风险后才上线。
- Gateway 只监听回环地址，控制台仅允许 SSH 隧道访问；微信限定 owner 私聊。
- 容器式能力、任意命令执行、公网控制台和群聊入口均关闭，降低相关包的可达攻击面。
- 每次升级先在独立暂存目录运行安装校验、`npm audit`、测试和 OpenClaw 安全审计；告警清除后再切换运行时。

告警属于锁定版本的审计快照，不代表所有条目都能从本项目配置到达，也不能被当作无风险。升级流程见 `docs/UPGRADE.md`。
