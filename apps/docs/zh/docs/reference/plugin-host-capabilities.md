# 插件宿主能力矩阵

> **兼容 ABI**：`VolundBridge` 与 `VOLUND_BRIDGE_CAPABILITIES` 是冻结的 v1 公开标识符。
> Volund CLI 是当前产品名。这些标识符保持不变，直到一次版本化的插件 ABI 迁移能够
> 保住既有集成。

> **生产遏制**：本页是被隔离的 v1 兼容/测试矩阵，不是当前生产可用性声明。在
> Catalog v2 + 已验证 ABI 通过显式的安全重开评审之前，legacy 安装、启用、激活与
> Memory 策略宿主一律 fail closed（`plugin_legacy_activation_unavailable`）。测试只
> 锻炼数据契约与 `VolundBridge` 本身；不发布可执行的 legacy 宿主或测试权威。

可执行的真相源是 `packages/plugin-runtime/src/index.ts` 里的
`VOLUND_BRIDGE_CAPABILITIES`。CI 校验它包含 `VolundBridge` 的每个叶子方法、每行都有
测试入口、每个不支持的方法都解释了原因。

| 命名空间        | 方法                                                            | 状态        | 测试入口                                                                                  |
| --------------- | --------------------------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------- |
| tools           | `register`, `unregister`                                        | supported   | `index.test.ts#VolundBridge capability matrix`                                            |
| hooks           | `on`, `off`, `kv.get`, `kv.set`, `kv.delete`, `kv.clear`        | supported   | `index.test.ts#VolundBridge capability matrix`                                            |
| commands        | `register`                                                      | supported   | `index.test.ts#VolundBridge capability matrix`                                            |
| prompt          | `contribute`, `revoke`                                          | supported   | `index.test.ts#VolundBridge capability matrix`                                            |
| session         | `getMessages`, `getUsage`, `on`                                 | supported   | `index.test.ts#VolundBridge capability matrix`                                            |
| fs              | `readFile`, `writeFile`, `exists`, `glob`, `stat`               | supported   | `index.test.ts#VolundBridge capability matrix`                                            |
| process         | `exec`                                                          | supported   | `index.test.ts#VolundBridge capability matrix`                                            |
| http            | `fetch`                                                         | supported   | `index.test.ts#VolundBridge capability matrix`                                            |
| ui              | `confirm`, `prompt`, `pick`, `notify`                           | supported   | `index.test.ts#VolundBridge capability matrix`                                            |
| storage         | `get`, `set`, `delete`                                          | supported   | `index.test.ts#VolundBridge capability matrix`                                            |
| memory          | `get`, `list`, `search`, `create`, `update`, `delete`, `export` | supported   | `index.test.ts#VolundBridge capability matrix`；生产写入走 Memory ACL/preWrite 与本地审计 |
| config          | `get`                                                           | supported   | `index.test.ts#VolundBridge capability matrix`                                            |
| log             | `debug`, `info`, `warn`, `error`                                | supported   | `index.test.ts#VolundBridge capability matrix`                                            |
| 低层传输        | `call`                                                          | unsupported | 进程内直接派发被 `index.test.ts#VolundBridge capability matrix` 刻意拒绝                  |
| provider/router | `provider.register`                                             | unsupported | provider 插件设计已声明，但 `VolundBridge` 尚未暴露；策略测试覆盖该边界                   |
| provider 认证   | `auth.getAuthHeaders`, `auth.getSigningEnvKeys`                 | unsupported | provider 插件设计已声明，但 `VolundBridge` 尚未暴露；策略测试覆盖该边界                   |

## 本地 v2 管线（当前生产 — 2026-09 内核）

上表描述被隔离的 legacy `BridgeRuntime`。**当前**生产管线是本地沙箱装载器
（`activateLocalPlugin` → `volund-sandbox --run-plugin` + fd3 桥 → 内核贡献注册表），
其中这些桥方法今天就是活的：

| 活跃方法                                        | 效果                                                                                                                                              |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `commands.register`                             | 斜杠命令进会话命令注册表                                                                                                                          |
| `ui.status.registerTab` / `registerSection`     | /status 数据页签与分区                                                                                                                            |
| `tools.register` / `tools.unregister`           | 模型可调用工具（自动命名空间 `plugin:<名>:`）进内核 `tools` 服务；permissionSpec `{custom:{pluginTool}}` 走统一权限链；输出按不可信内容包裹       |
| `hooks.on`                                      | 生命周期订阅；`preToolUse`/`postToolUse` 经 ToolExecutor 派发 hook（首个 HookResult 生效，fail-open），`sessionStart`/`sessionEnd` 从会话事件广播 |
| `session.on`                                    | 会话生命周期事件的 `hooks.on` 别名                                                                                                                |
| `prompt.contribute` / `prompt.revoke`           | 静态 fragment 进每会话组装器（`plugin:<名>:` id 命名空间，priority 缺省 600）                                                                     |
| `plugins.list` 扩展                             | `domains` 组：第一方工具域（/plugins 与 `volund plugins builtin` 可见可切换）                                                                     |
| `env.getEffective`, `session.getUsage`, `log.*` | 宿主数据/诊断，同以前                                                                                                                             |

本地管线仍然拒绝的：`fs.*`、`exec`、`http.fetch`、`storage.*`、`memory.*`、
`session.getMessages`、非会话事件的 `session.on` 式推送、`call`，以及
`provider.register` / `auth.*`（已声明面；等待 provider 插件宿主）。
交付/待办映射与 TCB 边界（沙箱与会话存储永远不可被插件替换）见设计 spec §19.0。

一个完整且被测试覆盖的示例在 `examples/plugins/volund-plugin-demo/`（JS）与
`examples/plugins/volund-plugin-ts-demo/`（TypeScript 入口）。

当前 CI 门验证的是遏制本身而非宿主生命周期 E2E：生产组装零 legacy 装载/启动引用、
deny-only 的 manager/runtime 测试保持全绿、并经一次真实的 `pnpm pack --dry-run --json`
证明不发布测试、内部权威或 test-only 文件。任何生产重开之前，ABI-R1 必须引入新的
已验证执行 E2E。

Memory 访问在 `manifest.permissions.memory` 与 Volund RPC allowlist 里单独声明。读
scope 显式（`workspace`、`project` 和/或 `session`）；search 与 export 同时需要能力
位和对目标 scope 的读权限。写入需要 `write: true` 加目标 scope 读权限，由宿主重新
收敛到当前本地 workspace/project/session，且不能提供可信 provenance。
宿主记录仅元数据的审计事件。Memory export 只含附件引用、绝不含附件字节；任何
Memory 桥方法都不上传、不分享、不做网络访问。

## 被隔离的 legacy Memory hook 契约

以下是保留的 v1 兼容契约。P0-00 移除了它的生产组装：不再启动进程级 Memory 策略
运行时、过期批准按禁用解释、普通 Memory 写入不派发第三方 hook。Catalog/ABI 迁移
必须在任何生产重开前逐条重验或退役这些规则。

- `memory.preWrite` 对每次 create、update、delete、pin、unpin 与附件状态变更运行。
  内置校验与秘密检测先跑；策略在 fact、index 或 import journal 变更之前运行。
  Import 预检用 `phase: "validation"`；提交调用用 `phase: "commit"`。
- 只有声明的 Memory 读 scope 包含确切事件 scope 的 hook 会被调用。候选内容仅在
  `memory.preWrite` 上、且秘密 guard 接受之后可用。`memory.postWrite` 与
  `memory.deleted` 仅含元数据。
- Hook priority 是 -100 到 100 的安全整数。按 priority 降序、再按注册顺序运行。
  首个 veto 短路整条链，其净化并截断到 240 字符的 reason 以 `memory_hook_veto`
  返回。
- pre-write 异常、激活失败或 10 秒 hook 超时以 `memory_hook_failed` fail closed。
  尝试嵌套 Memory 写入的 hook 立即失败；绝不进入递归策略求值。
- `memory.postWrite` 在 fact 与搜索索引提交之后运行。`memory.deleted` 仅在首次成功
  转入记录墓碑时跟随触发。观察者失败被审计，但不能把已落盘的写入变成上报失败。
- 直接桥与策略单元测试在不启动宿主的情况下验证保留的数据契约。遏制生效期间，
  生产不创建 `memory/hook-audit.jsonl`。
