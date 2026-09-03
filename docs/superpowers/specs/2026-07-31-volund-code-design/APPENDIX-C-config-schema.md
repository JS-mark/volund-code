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
| `[provider]` | `default` | string，必填（如 `"anthropic"`）；当前默认 provider 硬编码 anthropic；⚠️ 占位：schema 收录但实现未消费 | §8.3 | allowed |
| `[provider.<name>]` | `model` | string | §8.3 | allowed |
| `[provider.<name>]` | `baseUrl` / `endpoint` | string? | §8.3 | **forbidden**（§8.3.1） |
| `[router]` | `type` | `"single" \| "fallback" \| "role"`，默认 `"single"` | §3.7 | **forbidden**（§8.3.1） |
| `[router]` | `chain` | `[{ provider, model, priority }]`（§3.8.2 fallback 链，priority 高者优先） | §3.8.2 | **forbidden**（§8.3.1） |
| `[router]` | `cooldown_seconds` | number，默认 `60`（失败 provider 冷却） | §3.8.2 | **forbidden**（§8.3.1） |
| `[router]` | `allow_cross_provider_tool_use` | bool，默认 `false`；⚠️ 占位：schema 收录但实现未消费 | §3.7.1 | allowed |
| `[models.aliases]` | `<alias>` | `{ provider, model }`（preferences.model 可写别名；跨 provider 别名告警跳过） | §3.9 | allowed |
| `[runner]` | `maxToolLoopsPerTurn` | int，默认 25 | §2.4 B2 | allowed |
| `[runner]` | `top_level_budget` | bool，默认 `false`（r13-D1）；⚠️ 占位：schema 收录但实现未消费 | §2.7 | allowed |
| `[subagent]` | `max_depth` | int，默认 3（用户级 config 可覆盖） | §2.7 | allowed |
| `[subagent]` | `max_concurrent` | int，默认 4（r13-D1；用户级 config 可覆盖） | §2.7 | allowed |
| `[subagent]` | `default_budget` | `{ costUSDMax, tokenMax, timeMsMax }`（默认 $1 / 200k / 10min；用户级 config 可逐字段覆盖） | §2.7 | allowed |
| `[tools]` | `windows_shell` | string?（r13-I11） | §4.3.1 | allowed |
| `[tools]` | `pass_through_env` | string[]，默认 `[]`（r13-I11） | §4.3.1 | allowed |
| `[tools]` | `ignore_dirs` | string[]，默认 `[".git","node_modules","target","dist"]`（r13-D1）；⚠️ 占位：schema 收录但实现未消费 | §4.3.3 | allowed |
| `[env]` | `<NAME>` | string，默认无；启动时写入 `process.env` 的会话级环境变量（MCP / 插件宿主等子进程随之继承）。值在写入前做前置解析：开头 `~` → 主目录；`${VAR}` / `$VAR` → 启动时已有环境，**仅名字已设置才展开**（未设置保持字面，`${}` 形式额外 warn，值里的 `$` 不误伤）。进沙箱需配合 `[tools] pass_through_env` 白名单（env_clear 模型，r13-I11）；`*_api_key` 结尾的名字按 §8.3.1 通用模式禁止项目级覆盖 | §8.3 | allowed |
| `[context]` | `policy` | `"sliding" \；⚠️ 占位：schema 收录但实现未消费 | "summary" \| "semantic"`，L1 默认 `sliding`（实际策略来自 evolution tuning） | §8b | allowed |
| `[context]` | `max_tokens` | int，默认 180000；⚠️ 占位：schema 收录但实现未消费 | §8.3 / §8b | allowed |
| `[context]` | `keep` / `unkeep` 等 pinned 参数 | 见 §8b.13；⚠️ 占位：schema 收录但实现未消费 | §8b | allowed |
| `[memory]` | `enabled` | bool；⚠️ 占位：schema 收录但实现未消费 | §6.12 | allowed |
| `[memory]` | `max_body_lines` | int，默认 200；⚠️ 占位：schema 收录但实现未消费 | §6.12.4 | allowed |
| `[memory]` | `paths.global` / `paths.project` | string（缺省内置布局）；⚠️ 占位：schema 收录但实现未消费 | §6.12.1 | allowed |
| `[sandbox]` | 降级策略 / tier 相关 | 见 §5.5（实际由 env / flag 控制） | §5 | allowed |
| `[prompt]` | `@include` 参数（max_depth 32 / max_expansions 64） | 见 §6.5.6（@include 实为 PROJECT.md 指令语法，这两个上限未消费）；⚠️ 占位：schema 收录但实现未消费 | §6b | allowed |
| `[native]` | `ipc_max_line_bytes` | int，默认 4194304（r13-I6） | §5.6.2 | allowed |
| `[preferences]` | `language` | string（`system` 外的值注入回复语言强制） | §11 状态面板 | allowed |
| `[preferences]` | `outputStyle` | string（状态面板可读写但尚不影响行为） | §11 状态面板 | allowed |
| `[permissions]` | `mode` | `"ask" \| "auto" \| "full"`，§4.4 三档会话权限模式的用户级默认档（flag / `/mode` 可覆盖） | §4.4 | **forbidden**（仓库不得给自己提权） |
| `[ui]` | `theme` | `"auto" \；⚠️ 占位：schema 收录但实现未消费 | ...` | §8.3 | allowed |
| `[ui]` | `color` | bool，默认 true；⚠️ 占位：schema 收录但实现未消费 | §8.3 | allowed |
| `[telemetry]` | `sink` | `"local" \；⚠️ 占位：schema 收录但实现未消费 | "otel"`，默认 `local`（OTEL 未实现，local 硬编码） | §8.7 | **forbidden**（§8.3.1） |
| `[telemetry.otel]` | `endpoint` | string；⚠️ 占位：schema 收录但实现未消费 | §8.7 | **forbidden**（§8.3.1） |
| `[evolution]` | `enabled` | bool，默认 `false`；仅显式 `true` 应用已有 context tuning，不开启 observe/validate | §15 | allowed |
| `[reflection]` | `enabled` | bool，默认 `true` | §21.3 | allowed |
| `[reflection]` | `triggers.on_error` / `triggers.on_compact` | bool，默认 `true` / `false` | §21.3 | allowed |
| `[reflection]` | `triggers.every_n_turns` | int，默认 `0`（关；>0 如 `5` 开启定期反思） | §21.3 | allowed |
| `[reflection]` | `cooldown_seconds` | int，默认 `60`（自动 trigger 最小间隔） | §21.3 | allowed |
| `[reflection]` | `model_role` | string，默认 `"reflection"`；未配置该 role 时回落当前会话模型 | §21.4 | allowed |
| `[reflection]` | `run_budget` | `{ costUSDMax, tokenMax, timeMsMax }`，默认 `$0.05 / 16k / 60s`；K0 与 session 硬顶求交 | §21.4 | allowed |
| `[reflection]` | `session_token_budget` | int，默认 `50000`；K0 强制硬顶，插件请求只能收窄 | §21.3 | allowed |
| `[reflection]` | `persist` | `"manual" \| "auto" \| "off"`，默认 `"manual"` | §21.7 | allowed |
| `[reflection]` | `inject_max_lessons` / `inject_max_bytes` | int，默认 `3` / `2048` | §21.6 | allowed |
| `[auth]` | `skipAuth` | bool，默认 `false`；`true` 时完全跳过凭据解析、请求不带凭据头（企业网关/本地代理，配合 `provider.<name>.baseUrl`） | §8.4 | **forbidden**（§8.3.1） |
| `[auth]` | `anthropic_api_key` | string?（Layer 4 明文 key，显式 opt-in，建议文件权限 0600） | §8.4 | **forbidden**（§8.3.1） |
| `[auth]` | （全部） | — | §8.4 | **forbidden**（§8.3.1） |
| `[plugins]` | `market` | string?，市场索引 URL（PLUGIN-MANAGER-r1.2）：规范 HTTPS 可浏览索引；在发布者签名、吊销与可信 key root 接通前，**可执行安装仅允许回环 http 开发源**。安装逐文件 digest 校验后落盘 `~/.volund/plugins/<name>/`，但保持 disabled；显式 approve(hash) + enable 后才激活，激活期经 volund-market.json 重验 | PLUGIN-MANAGER-r1.2 | **forbidden**（信任配置，项目级不得指向第三方源） |
| `[skills]` | `disabled` | string[]，默认 `[]`；/skills 面板 Space 切换写这里，对 user+project scope 均生效；名单跨层合并（并集） | SKILLS-MCP-UI-r1 §S3.4 | allowed |
| `[skills]` | `index_budget` | int，默认 `4096`；skills index fragment 字符预算，超出时从尾部退化 name-only 行；⚠️ 占位：schema 收录但实现未消费 | SKILLS-MCP-UI-r1 §S3.4 | allowed |
| `[mcp]` | `disabled` | string[]，默认 `[]`；/mcp 面板 Space 切换写这里（断开连接并注销全部 `mcp__<server>__*` 工具） | SKILLS-MCP-UI-r1 §S3.4 | allowed |
| `[mcp]` | `enable_all_project_servers` | bool，默认 `false`；非交互场景对项目级 mcp.toml/.mcp.json 的总放行；⚠️ 占位：schema 收录但实现未消费 | SKILLS-MCP-UI-r1 §S3.4 | **forbidden**（项目级自我批准绕过用户信任门） |

## C.3 全量示例（节选拼合，键值以 C.2 为准）

```toml
[provider]
default = "anthropic"

[provider.anthropic]
model = "claude-sonnet-4-5"
# baseUrl 属 forbidden projectOverride：项目级设了忽略 + warning（§8.3.1）

[router]
type = "single"
# type = "fallback" 时按 chain 串行 fallback（§3.8.2）；chain/cooldown 属
# 数据流向门，项目级 forbidden。
# chain = [
#   { provider = "anthropic", model = "claude-sonnet-4-5", priority = 100 },
#   { provider = "openai",    model = "gpt-4o",            priority = 80  },
# ]
# cooldown_seconds = 60

[auth]
# skipAuth = true              # 完全跳过凭据解析（企业网关/本地代理，§8.4）
# anthropic_api_key = "..."    # Layer 4 明文 key（显式 opt-in，建议 0600）

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
pass_through_env = ["NO_PROXY"]  # r13-I11：env 继承白名单（PATH/HOME/LANG/TZ 之外）；
                                 # 白名单内的名字才注入沙箱，值可来自下方 [env] 段
ignore_dirs = [".git", "node_modules", "target", "dist"]

[env]
# 会话级环境变量：启动时写入 process.env，之后 spawn 的子进程（MCP stdio /
# 插件宿主 / native worker）随之继承；沙箱内 Bash 只额外接受白名单名字
NO_PROXY = "localhost,127.0.0.1"
# 值写入前做前置解析：开头 ~ → 主目录；${VAR} 与 $VAR → 启动时已有的环境变量
# （仅名字已设置才展开；未设置保持字面，${} 形式额外 warn，值里的 $ 不误伤）
VOLUND_NATIVE_SANDBOX_BINARY = "~/myself/code/volund-code/target/debug/volund-sandbox"

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
