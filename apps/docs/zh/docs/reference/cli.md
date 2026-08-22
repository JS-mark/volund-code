# CLI 参考

## 自适应运行时调优（L2）

`apollo evolution show [--namespace context] [--since <date>]` 查看经过脱敏、仅追加的本地调优审计；`apollo evolution rollback [--namespace context] [--to <timestamp>]` 将 context 参数恢复到上一次或指定时间点。新会话缺省使用内置 context 默认值；只有 `~/.apollo/config.toml` 中精确的 boolean `[evolution] enabled = true` 才进入已有 context tuning 读取路径。配置缺失或 false 时保持关闭；语法错误、不可读或错类型配置会在读取 tuning 前阻止 Runner 启动。这个兼容开关不会启动自动 observation/validation；关闭时 `show` 与 `rollback` 仍可使用。

| 命令                           | 用途                                         |
| ------------------------------ | -------------------------------------------- |
| `apollo` / `apollo chat`       | 启动交互式或单次编程会话。                   |
| `apollo login <provider>`      | 验证并安全保存 provider 凭据。               |
| `apollo logout <provider>`     | 删除已保存的 provider 凭据。                 |
| `apollo config`                | 查看配置。                                   |
| `apollo history list` / `show` | 查看本地会话历史。                           |
| `apollo resume <session-id>`   | 从最后一个持久化 turn 边界恢复。             |
| `apollo restore <session-id>`  | 回滚该会话修改过的文件。                     |
| `apollo doctor [--strict]`     | 检查配置、凭据、原生包和沙箱状态。           |
| `apollo memory <action>`       | 管理长期记忆、pinned 上下文和本地搜索索引。  |
| `apollo plugin <action>`       | 检查或清理本地插件；旧版安装与启用暂不可用。 |
| `apollo hook list`             | 列出内置 hooks。                             |

旧版 v1 插件的安装、启用和激活目前在生产环境中暂不可用，并以 `plugin_legacy_activation_unavailable` 失败；只有 Catalog v2、经验证的 capability ABI 和显式安全复审完成后才可重新开放。启动时会把可解析的旧 `enabled:true` 记录解释为 disabled，且不会加载插件。`plugin list [--json]`、`plugin doctor <name>`、`plugin disable <name>` 和 `plugin uninstall <name>` 仍可用于安全检查与清理。插件命令在 `--json` 失败时只向 stdout 依次写入 `error`、`final` 两条 NDJSON 事件，stderr 为空。
| `apollo version` | 输出版本。 |
| `apollo help` | 显示帮助。 |

常用模式包括 `--no-tui`、`--json` 和 `--no-color`。非交互运行不会加载项目配置，除非显式传入 `--trust-project-config`。危险沙箱绕过参数会被审计，并要求显式确认。

## Memory

```sh
apollo memory list [--scope workspace|project|both] [--tag <tag>] [--source user|agent|evolution|import] [--pinned] [--limit <n>] [--cursor <cursor>]
apollo memory get <id> [--scope workspace|project|both]
apollo memory add [content] [--id <id>] [--scope workspace|project] [--tag <tag>] [--source user|import] [--pinned]
apollo memory update <id> [content] [--tag <tag>] [--pinned] [--expected-updated-at <time>]
apollo memory delete <id> [--yes]
apollo memory pin <id>
apollo memory unpin <id>
apollo memory export [--scope workspace|project|both] > memory.json
apollo memory import memory.json [--scope workspace|project] [--strategy skip|overwrite|rename] [--dry-run]
```

`global` 是 `workspace` 的别名；管道输入使用 `--body-stdin`，多个 tag 可用逗号分隔。列表按稳定的 `pinned 降序、updatedAt 降序、id 升序` cursor 分页；`--json` 始终输出单个带 schema 版本且无 ANSI 的 JSON 文档。Memory 返回码固定为：`0` 成功、`2` 校验失败或缺少确认、`3` 未找到、`13` scope/授权拒绝。

删除在交互终端中必须确认；非 TTY、`--json` 或 `--no-tui` 场景必须显式传入 `--yes`。所有输出都会先脱敏。

Pinned memory 以固定行数/token 预算进入每次 provider 请求。优先级为 session > project > workspace；重复正文只保留更窄 scope 的版本，再做确定性排序。正文转义后放进 `<untrusted source="memory:pinned">`，只作为建议数据，不能覆盖当前用户或 system 指令。pin 会立即刷新 prompt cache，unpin 或 delete 后下一次组合不再包含该正文。

### Chat 内 `/memory` 面板

在已启动的 TTY Chat 中输入 `/memory`，会打开与上述命令共用 `MemoryService` 和 `MemoryRecallService` 的 project scope 面板。面板支持 cursor 分页、debounce 本地搜索、详情、正文/tag 编辑、删除确认和 pin/unpin。方向键、Page Up/Down、Home/End、Enter、`/`、`E`、`P`、`D` 和 Esc 用于导航；编辑时用 `Ctrl+S` 保存。删除默认选中 Cancel，dirty 草稿必须显式确认后才丢弃。

面板打开时 Chat 输入被禁用，Esc 关闭后恢复；面板键盘事件不会进入 Chat history。失败或并发冲突会保留当前记录和草稿；搜索结果在详情与 mutation 前重新通过事实服务回读。`--json`、`--no-tui`、stdin/stdout 任一非 TTY 时都不会打开 Ink 或等待按键。窄终端和 no-color 仍保留 `>`、`[P]`、`Error:`、`Modified` 等文字标识。

使用 `apollo restore <session-id> --dry-run` 可预览回滚。每次 `Write`、`Edit` 和 `MultiEdit` 修改文件前都会生成会话级备份；如果文件在 Apollo 编辑后又被修改，restore 会拒绝覆盖。备份默认保留七天，总量限制为 500 MB。

Resume 会把未完成的 turn 标记为 aborted，并从新 turn 继续；不会重新执行中断的 provider 或工具调用。

## 本地 Memory 搜索与恢复

```sh
apollo memory search <query> [--scope workspace|project|session] [--limit 10] [--tag tag] [--json]
apollo memory doctor [--strict] [--json]
apollo memory reindex [--check] [--force] [--batch-size 250] [--json]
```

搜索仅使用本地关键词，不会调用 embedding 或网络。索引候选始终通过带 scope 策略的事实服务回读，因此不会返回过期、已删除、幽灵或越权条目。`memory doctor` 只读；`memory reindex --check` 仅报告是否需要重建。实际重建使用跨进程锁，全部批次成功后才原子发布新 generation。`--force` 会重建健康索引并可清理陈旧锁，但不会抢占仍存活进程持有的锁。

Memory 归档使用版本化的 `apollo.memory.export.v1` JSON 格式。Export 通过 ACL 读取指定
scope，只导出 attachment 引用而不复制二进制。Import 默认 `skip`，会报告全部冲突，
支持无写入的 `--dry-run`，并用 journal 在失败或中断后回滚。导入记录的 provenance 固定为
`source: import`；原始 provenance 仅作为不可信 `importedFrom` 信息保留，不能提升权限。
整个流程仅处理本地数据，不执行上传、分享、远端同步或 embedding。

## Role 路由

Role 路由在受信任的全局 `~/.apollo/config.toml` 中配置。Role 只负责选择显式 provider/model 候选链；失败分类、冷却、重试上限、时间/费用预算以及工具调用 turn sticky 仍统一由 `FallbackRouter` 执行。

```toml
[router]
type = "role"

[router.default]
provider = "anthropic"
model = "claude-sonnet-4-5"

[router.roles.planner]
provider = "openai"
model = "gpt-4o-mini"
priority = 100

[router.roles.coder]
provider = "anthropic"
model = "claude-sonnet-4-5"
priority = 100

[router.roles.reviewer]
provider = "anthropic"
model = "claude-opus-4"
priority = 100
```

`planner`、`coder`、`reviewer` hint 可来自显式输入、hook 元数据或内置 subagent 类型；显式 `provider/model` hint 对当前 turn 优先。一旦 provider 发出首个 tool-use chunk，该 provider 会保持 sticky 直到 turn 结束，重试不得跨 provider。

Provider plugin 注册后不会自动进入 role/fallback 候选池。必须在 role/fallback 配置中点名 opt-in，或仅为当前 turn 显式选择。v1 禁止把 plugin provider 设为 default。
