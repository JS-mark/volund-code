> ↩ [返回索引 (README)](./README.md)

---

# 附录 C · config.toml 全量 schema 与示例（r13-I4 新增）

config key 分散于 §2 / §3 / §4 / §5 / §8 / §8b / §14 各章——**本附录是唯一真相源**，各章片段一律"以附录 C 为准"。zod schema 位于 `packages/shared/config-schema.ts`，CI 校验 schema 与本表一致。

## C.1 未知 key 策略（§8.3）

- 未知 key（顶层未知 section 与已知 section 内未知 key）→ **warn + 忽略**（向前兼容）；警告含 key 全名与所在文件。
- 已知 key 类型错 → **启动 fail**（友好报错：文件 + key + 期望类型）。
- 每个 key 标注 `projectOverride: 'allowed' | 'forbidden'`（§8.3.1 数据流向门）。

## C.2 全量表

| Section | Key | 类型 / 默认 | 来源 | projectOverride |
|---|---|---|---|---|
| `[provider]` | `default` | string，必填（如 `"anthropic"`） | §8.3 | allowed |
| `[provider.<name>]` | `model` | string | §8.3 | allowed |
| `[provider.<name>]` | `baseUrl` / `endpoint` | string? | §8.3 | **forbidden**（§8.3.1） |
| `[router]` | `type` | `"single" \| "fallback" \| "role"`，默认 `"single"` | §3.7 | **forbidden**（§8.3.1） |
| `[router]` | `allow_cross_provider_tool_use` | bool，默认 `false` | §3.7.1 | allowed |
| `[models.aliases]` | `<alias>` | `{ provider, model }` | §3.9 | allowed |
| `[runner]` | `maxToolLoopsPerTurn` | int，默认 25 | §2.4 B2 | allowed |
| `[runner]` | `top_level_budget` | bool，默认 `false`（r13-D1） | §2.7 | allowed |
| `[subagent]` | `max_depth` | int，默认 3 | §2.7 | allowed |
| `[subagent]` | `max_concurrent` | int，默认 4（r13-D1） | §2.7 | allowed |
| `[subagent]` | `default_budget` | `{ costUSDMax, tokenMax, timeMsMax }`（默认 $1 / 200k / 10min） | §2.7 | allowed |
| `[tools]` | `windows_shell` | string?（r13-I11） | §4.3.1 | allowed |
| `[tools]` | `pass_through_env` | string[]，默认 `[]`（r13-I11） | §4.3.1 | allowed |
| `[tools]` | `ignore_dirs` | string[]，默认 `[".git","node_modules","target","dist"]`（r13-D1） | §4.3.3 | allowed |
| `[context]` | `policy` | `"sliding" \| "summary" \| "semantic"`，L1 默认 `sliding` | §8b | allowed |
| `[context]` | `max_tokens` | int，默认 180000 | §8.3 / §8b | allowed |
| `[context]` | `keep` / `unkeep` 等 pinned 参数 | 见 §8b.13 | §8b | allowed |
| `[memory]` | `enabled` | bool | §6.12 | allowed |
| `[memory]` | `max_body_lines` | int，默认 200 | §6.12.4 | allowed |
| `[memory]` | `paths.global` / `paths.project` | string（缺省内置布局） | §6.12.1 | allowed |
| `[sandbox]` | 降级策略 / tier 相关 | 见 §5.5 | §5 | allowed |
| `[prompt]` | `@include` 参数（max_depth 32 / max_expansions 64） | 见 §6.5.6 | §6b | allowed |
| `[native]` | `ipc_max_line_bytes` | int，默认 4194304（r13-I6） | §5.6.2 | allowed |
| `[preferences]` | `outputStyle` / `language` | string（状态面板读写；REM-61 发现的实现侧 key，补录） | §11 状态面板 | allowed |
| `[ui]` | `theme` | `"auto" \| ...` | §8.3 | allowed |
| `[ui]` | `color` | bool，默认 true | §8.3 | allowed |
| `[telemetry]` | `sink` | `"local" \| "otel"`，默认 `local` | §8.7 | **forbidden**（§8.3.1） |
| `[telemetry.otel]` | `endpoint` | string | §8.7 | **forbidden**（§8.3.1） |
| `[evolution]` | `enabled` | bool，默认 `false`；仅显式 `true` 应用已有 context tuning，不开启 observe/validate | §15 | allowed |
| `[auth]` | （全部） | — | §8.4 | **forbidden**（§8.3.1） |

## C.3 全量示例（节选拼合，键值以 C.2 为准）

```toml
[provider]
default = "anthropic"

[provider.anthropic]
model = "claude-sonnet-4-5"
# baseUrl 属 forbidden projectOverride：项目级设了忽略 + warning（§8.3.1）

[router]
type = "single"

[models.aliases]
sonnet = { provider = "anthropic", model = "claude-sonnet-4-5" }

[runner]
maxToolLoopsPerTurn = 25
top_level_budget = false          # r13-D1

[subagent]
max_depth = 3
max_concurrent = 4                # r13-D1
[subagent.default_budget]
costUSDMax = 1.0
tokenMax = 200000
timeMsMax = 600000

[tools]
pass_through_env = []            # r13-I11：env 继承白名单（PATH/HOME/LANG/TZ 之外）
ignore_dirs = [".git", "node_modules", "target", "dist"]

[context]
policy = "sliding"
max_tokens = 180000

[memory]
enabled = true
max_body_lines = 200

[evolution]
enabled = false                  # T0：缺省关闭；show/rollback 仍可用

[native]
ipc_max_line_bytes = 4194304     # r13-I6

[ui]
theme = "auto"
color = true

[telemetry]
sink = "local"                   # otel 需显式 opt-in + endpoint
```

## C.4 维护规则

- 新增 key 的 PR 必须同时改：zod schema（config-schema.ts，含 `projectOverride` 标注）+ 本表 + （若有）章节内片段标注"以附录 C 为准"。
- CI（`pnpm verify:config-docs`）比对 schema 导出的 key 清单与 C.2 表格，diff 非空 → fail。
