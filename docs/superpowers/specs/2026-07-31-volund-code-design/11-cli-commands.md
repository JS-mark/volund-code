> ↩ [返回索引 (README)](./README.md) · ← [上一章: §10 里程碑 L1 → L4](./10-milestones.md) · [下一章: §12 开源治理](./12-open-governance.md) →

---

## §11 CLI 命令树设计

本节定义 `apps/cli` 的顶层命令 / 子命令 / flag 完整清单。

### 11.1 技术选型

- **Parser**：**citty**（unjs 出品，TypeScript-first，嵌套子命令 + 自动 help + 声明式定义）
- **交互**：TTY 检测 → 决定进 Ink（交互）还是走 flag/pipe 模式
- **补全**：citty 内置 shell completion 生成（bash/zsh/fish）
- **输出**：默认人类可读；chat/session 流式路径的 `--json` 走 NDJSON；普通查询类子命令的 `--json` 输出单个 JSON payload

### 11.2 顶层命令

```
volund                       # 默认：进交互 REPL（无子命令时）
volund chat [prompt]          # 无 prompt 进交互 REPL；有 prompt 走一次性对话
volund login [provider]       # 认证
volund logout [provider]
volund config <get|set|list|edit>
volund history <list|show|search|export|import>
volund resume <session-id>    # 继续某会话
volund restore <session-id>   # 回滚该 session 内的文件变更
volund model <list|use|alias>
volund plugin <install|uninstall|list|enable|disable|upgrade|doctor|dev>
volund skill <install|uninstall|list|enable|disable|activate|deactivate>
volund mcp <add|remove|list|test>
volund hook <list|test>
volund memory <list|show|add|edit|rm|search|pin|unpin|export|import>   # v4 新增，详见 §6.12.7
volund context <show|diff|keep|unkeep|compact|policy>   # r10 新增，详见 §11.3.12 + §8b.13
volund evolution <show|rollback|enable|disable>         # r10 新增，详见 §11.3.13 + §15
volund review [--base <ref>|--staged|--pr <n>|--range <a>..<b>]  # r13 新增，详见 §17
volund doctor                 # 全局诊断（native / auth / permission / 各 provider 连通性）
volund status [--json]        # 会话/用量/缓存状态总览（2026-08-23 新增，详见 §11.3.14）
volund web [--cwd <path>]     # 本地 loopback Web 控制台（proposed，详见 §11.3.15 / §22）
volund telemetry <status|export|clear>
volund completion <bash|zsh|fish>   # 生成 shell 补全脚本
volund version
volund help [command]

# v2 保留（不进 L1-L4）：
# volund update                # 自升级
```

**顶层命令数**：MVP (L1-L4) 保持 **22 个**顶层入口；另新增 **1 个 proposed 可选入口** `web`，故完整设计树为 23 个（不据此声称已实现）。r10：+ `context` + `evolution`；r13：+ `review`；2026-08-23：+ `status`。`update` 留 v2。`memory` 子命令树在 §6.12.7、`context` 在 §11.3.12、`evolution` 在 §11.3.13、`review` 在 §17、`web` 在 §22 完整定义，此处仅作交叉索引。

### 11.3 命令详细定义

#### 11.3.1 顶层与 chat

```
volund [prompt...]
  # 无参数进交互 REPL
  # 有 prompt 参数 → 走 chat 单轮：volund "帮我改这个 bug"
volund chat [prompt...]
  # 无 prompt 且 stdin/stdout 是 TTY → 进同一个 Ink 交互 REPL
  # 有 prompt 参数 → 走 chat 单轮：volund chat "帮我改这个 bug"
  Flags (global):
    --cwd <path>                 # 覆盖 cwd
    --model <name|alias>          # 单次指定
    --provider <name>             # 覆盖 default provider
    --config <path>               # 加载额外 config
    --no-tui                      # 关 Ink，走行输出
    --json                        # NDJSON 输出
    --no-color / -q               # 关色
    -v / --verbose                # 打详细日志到 stderr
    --dangerously-skip-permissions
    --dangerous-no-sandbox
    --trust-project-config         # 非交互模式下允许加载 <cwd>/.volund/config.toml + mcp.toml（交互模式走信任门，见 §8.3.1）
    --yolo                        # = --dangerously-skip-permissions
    -h / --help
    --version
```

**TTY / TUI 分流（强制）**：

| 输入形态 | TTY | 行为 |
|---|---:|---|
| `volund` | 是 | 进入 Ink REPL |
| `volund chat` | 是 | 进入 Ink REPL |
| `volund <prompt...>` | 任意 | 单轮执行 |
| `volund chat <prompt...>` | 任意 | 单轮执行 |
| chat/session 流式路径 + `--json` | 任意 | NDJSON，禁止 Ink/ANSI |
| 查询类子命令 + `--json` | 任意 | 单个 JSON payload，禁止 Ink/ANSI |
| 有 prompt + `--no-tui` | 任意 | 单轮行输出，禁止 Ink |
| 无 prompt + `--no-tui` | 是 | readline fallback，禁止 Ink |
| `volund` / `volund chat` 无 prompt | 否 | 报错，不等待 stdin |

分流优先级固定为：

1. `--json` 永不启动 Ink；chat/session 输出 NDJSON，查询类子命令输出单个 JSON payload。
2. `--no-tui` 永不启动 Ink；有 prompt 走单轮行输出，无 prompt 且 TTY 时可使用 readline fallback。
3. 无 prompt + TTY + 未禁用 TUI 时进入 Ink REPL。
4. 无 prompt + 非 TTY 必须报错，不读取无限 stdin。

`readline` 只允许用于 `--no-tui` fallback、认证输入、危险确认和权限 fallback；默认交互 REPL 必须由 §7 定义的 Ink TUI 承载。退出 REPL 时必须 emit `session.ended`、flush snapshot、释放 provider/plugin/native runtime，并恢复 terminal raw mode / cursor / alternate screen。

#### 11.3.2 login / logout

```
volund login [provider]
  # 无 provider 时列出可登录的 provider 并交互选择
  # 引导流程：显示 OAuth URL 或让用户粘贴 API key
  # ★ 顺序：读取 key → 调 provider 的最小验证请求（如 anthropic /v1/models；
  #    配置了 provider.<name>.baseUrl 时对该 baseUrl 验证，否则打官方端点）
  #    → 只有 2xx 且返回 body schema 合法才写 auth；4xx/5xx 直接报错不落盘
  # 存到 auth（macOS Keychain / Linux libSecret / Windows Credential Manager；缺失时 fallback 加密文件；--api-key-stdin 场景下 env-only 也允许）
  # ★ no-op 短路（§8.4）：[auth] skipAuth=true 或 [auth] <provider>_api_key 已配置时，
  #    交互式 login 直接提示现状并退出（不弹输入、不发 verify）；
  #    显式 --api-key-stdin 传入仍可落盘（skipAuth 期间该凭据不生效，会附提示）
  Flags:
    --api-key <key>              # 非交互，从 stdin 或 flag 传入（脚本用）
    --api-key-stdin              # 从 stdin 读，避免 shell history 泄漏
    --oauth                       # 走 OAuth flow（若 provider 支持）
    --skip-verify                 # ⚠️ 跳过验证（离线场景，需 --dangerous 标记）

volund logout [provider]         # 清凭据
volund logout --all
```

#### 11.3.3 config

```
volund config list                              # 打印合并后的完整配置
volund config get <key>                         # e.g. volund config get provider.default
volund config set <key> <value>                 # 写 global config
volund config set --project <key> <value>       # 写 project config
volund config unset <key>
volund config edit [--project]                  # 打开 $EDITOR
volund config path                              # 打印 config 文件位置
```

#### 11.3.4 history

> **命名澄清**：`volund history` 操作的是 **session 会话**（`~/.volund/sessions/*.jsonl`，完整对话记录）。另一个"history"——`~/.volund/history`（§7.5.1 / §8.1）——是**输入行历史**（交互 REPL 里 ↑↓ 翻历史输入），纯文本脱敏，与 `volund history` 命令族**无关**。两者故意分开：会话是结构化可 replay 的，输入行历史只是行编辑便利。

```
volund history list [--limit N] [--since <date>] [--project]
volund history show <session-id>                # 打印 session 完整对话
volund history search <query>                   # 全文搜索历史 (L3)
volund history export <session-id> [-o file]    # 导出 markdown/json
volund history import <file>                    # 导入
volund history clear [--all|--older-than <date>]
```

#### 11.3.5 resume / restore

```
volund resume <session-id>                      # 继续该 session
volund resume                                   # 交互式选最近 10 个
volund restore <session-id>                     # 回滚该 session 期间的文件变更
volund restore <session-id> --dry-run           # 展示将变更什么，不写
```

#### 11.3.6 model

```
volund model list [--provider <name>]           # 列出可用模型
volund model use <name|alias>                   # 设为 default
volund model alias <alias> = <provider>:<model> # 建 alias
volund model unalias <alias>
```

#### 11.3.7 plugin

```
volund plugin install <spec>                    # spec: npm:volund-plugin-x | github:user/repo | ./local-dir
volund plugin uninstall <name>
volund plugin list [--enabled|--disabled|--banned]
volund plugin enable <name>
volund plugin disable <name>
volund plugin upgrade <name|--all>
volund plugin doctor <name>                     # 见 §6.11.3
volund plugin ban <name>                        # 永久拉黑
volund plugin dev <path>                        # 软链接本地目录 + hot reload (L4)
volund plugin init [--template <name>]          # 生成骨架
```

#### 11.3.8 skill

> **SKILLS-MCPS-r1.4（2026-08-26）已实现**：`install`（spec = 本地目录 | git URL | `github:owner/repo` | `owner/repo` | `file://…`；git 仓库根有 SKILL.md 装 root，否则装一层子目录全部带 SKILL.md 的；`--scope project` 装 `<cwd>/.volund/skills`）、`uninstall`（仅可写非 interop 作用域）、`list`（scope 过滤 + status 列）、`show`、`enable/disable`（持久面）。详见 [SKILLS-MCP-UI-r1](./SKILLS-MCP-UI-r1.md) §S3.7。

```
volund skill install <spec>                     # 类似 plugin
volund skill uninstall <name>
volund skill list
volund skill activate <name>                    # 会话内激活
volund skill deactivate <name>
volund skill show <name>                        # 打印 SKILL.md
volund skill init [--template <name>]
```

> **SKILLS-MCP-r1（2026-08-25）**：skill 协议对齐 [agentskills.io](https://agentskills.io/specification) 开放标准——frontmatter 标准字段（`name`/`description`）必填、`volundVersion` 降级可选；多作用域（user / project / `.agents/skills/` 互操作 / 插件）+ 信任门；新增 `enable`/`disable`/`validate` 子命令与 `/skills` 面板。完整契约见 [SKILLS-MCP-UI-r1](./SKILLS-MCP-UI-r1.md)。

#### 11.3.9 mcp

> **SKILLS-MCPS-r1.4（2026-08-26）已实现**：`add`（stdio `--` 透传 / http url；`-e K=V`、`-H 'K: v'` 可重复；`-s user|project` 选目标 mcp.toml）、`remove`、`enable/disable`、`list`（连通性有界等待后快照）、`test`、`inspect`。`reload` 走 REPL `/mcp reload`；`login/logout` 属 SM-07 未做。详见 [SKILLS-MCP-UI-r1](./SKILLS-MCP-UI-r1.md) §S3.7。

```
volund mcp add <name> <transport-config>        # transport-config: stdio:cmd | http://... | sse://...
volund mcp remove <name>
volund mcp list
volund mcp test <name>                          # 连通性测试
volund mcp inspect <name>                       # 打印其暴露的 tools/resources
```

> **SKILLS-MCP-r1（2026-08-25）**：配置结构对齐业界通用形态——mcp.toml 顶层 `[mcp_servers.<name>]` 表（stdio `command/args/env/cwd`；远程 `type/url/headers`）+ `${VAR}`/`${VAR:-default}` env 展开 + 项目级 `.mcp.json` 只读互操作导入；工具命名由 `mcp:<server>:<tool>` 改为 `mcp__<server>__<tool>`（权限规则三粒度：`mcp__server` / `mcp__server__tool` / `mcp__server__*`）；新增 `enable`/`disable`/`reload`/`login`/`logout` 子命令与 `/mcp` 面板。完整契约见 [SKILLS-MCP-UI-r1](./SKILLS-MCP-UI-r1.md) §S3.5。

**★ Transport credentials 存储规则（W7）**：MCP server 的 auth 材料（HTTP `Authorization` header / bearer token / OAuth refresh / env 注入的 API key / stdio 命令行内的敏感 flag）**禁止**明文进 `~/.volund/mcp.toml` 或 `~/.volund/config.toml`。

- `volund mcp add` 交互流程：CLI 检测到 transport 需要凭据（`--header 'Authorization: ...'` / `--env FOO=bar` / URL 含 userinfo `https://user:pass@...`）时 →
  1. 提示用户："检测到敏感字段 `Authorization`，是否写入 auth（推荐）？[Y/n]"
  2. 用户 Y → 调 `auth.storeCredential({ scope: 'mcp', name, field: 'Authorization', value })` → 写入 OS keychain / 加密文件；配置里只留 `keyref://mcp.<name>.Authorization` 占位
  3. 用户 n → 写入 `mcp.toml` 但打红色警告 + telemetry event `mcp.credential_plaintext`
- MCP client 加载时通过 `auth.resolveKeyref(ref)` 解引用，得到明文注入 header / env / argv
- 明文 URL userinfo（`https://user:pass@host`）**强制**转成 keyref，不给退路
- `volund mcp list` 打印时对 keyref 只显示 `keyref://... (hidden)`
- 老配置里已有明文凭据的：启动阶段扫描 → 一次性迁移到 auth 并改写 config，提示用户

**★ MCP fatigue 防护（REVIEW-r6 P1-2）**：恶意/失控 MCP server 可批量暴露 tool → 每个 tool 调用都触发权限弹窗 → 疲劳轰炸用户"点 allow"。三层防护：
1. **弹窗 batch 合并**：1 秒内同一 MCP server 来源的多个权限请求**合并**成一个弹窗，选项为"允许此 MCP server 全部 tool（allow-mcp-server）/ 仅本次批量（allow-batch-once）/ 逐个询问 / 拒绝此 server"。`allow-mcp-server` 写入 `permissions.mcp.<name>` 域（等价对该 server 的 tool 全 allow-session）。
2. **per-MCP 限速**：`mcp.toml` 可配 `max_prompts_per_minute`（默认 10）；某 server 触发权限弹窗超此速率 → 后续请求自动 `deny` + telemetry `mcp.fatigue_rate_limited`，提示用户该 server 行为异常。
3. **MCP tool 上线信任门**：`volund mcp add` 后首次连接，列出该 server 暴露的**全部 tool 清单**（名字 + 描述 + permissionSpec 摘要），用户一次性批准"信任此 server 的 tool 集"；之后新增 tool 再弹一次（防 server 偷偷加危险 tool）。

> MCP fatigue 防护整体归 L3（随 MCP 上线），但 §13 security-model 页 L1 起就应把"MCP server 是半信任第三方"写进 threat model。

#### 11.3.9b hook

`volund hook` 用于查看 / 排查 hook 注册与命中情况。hook 本身在 §2.6 定义，注册来源可能是 builtin / plugin / project config。

```
volund hook list                                # 打印当前会话所有已注册 hook：
                                                #   NAME               POINT              SOURCE                 PRIORITY
                                                #   audit-write        beforeToolCall     builtin                1000
                                                #   sensitive-scrub    beforeToolResult   plugin:guardian        800
                                                #   git-autoformat     onTurnEnd          project:.volund/hooks  600

volund hook list --point <point-name>           # 按 hook 点过滤（e.g. beforeToolCall）
volund hook list --source <builtin|plugin|project>

volund hook test <name> [--input <json-file>]   # 干跑：读取 input.json 作为 hook ctx，打印 hook 返回值
                                                # 不会写盘/发网/执行 tool；用于插件作者调试
volund hook test <name> --last-turn             # 用最后一轮真实 ctx（从 session JSONL 回放）复现

volund hook show <name>                         # 打印 hook 元数据：定义位置、优先级、匹配规则、最近 10 次触发耗时
```

**边界**：`volund hook` 只读 + 干跑；不提供 `enable/disable`（走 `volund plugin disable` 或改 config），不提供 `add`（hook 只能来自 builtin / manifest 声明 / 项目 config）。

**里程碑**：`hook list` L1（builtin only 也要能列）；`hook test` L3（配合 plugin-runtime）；`hook show` 详细统计 L4。

#### 11.3.10 doctor / telemetry

```
volund doctor                                   # 输出（按里程碑分层，同一二进制内 feature-flag 显示）：
                                                # ── L1 项（必检） ──
                                                #   ✓ node version
                                                #   ✓ volund version
                                                #   ✓ native-bridge available (sandbox: ✓, search: ✓, fs: -)
                                                #   ✓ auth: anthropic (keychain)
                                                #   ✓ config valid
                                                #   ✓ cwd writable
                                                #   ✓ gh CLI: 2.x (/opt/homebrew/bin/gh)   # r13-G6：缺失 ⚠️ 不 fail，
                                                #                                           # 提示 "PR 工作流需要 gh（CONTRIBUTING 推荐依赖）"
                                                # ── L2+ 项（当对应能力启用时展示） ──
                                                #   ✓ skills: 3 installed / 0 broken           # skills-runtime 装载后
                                                #   ✓ context policy: sliding+summary          # L2 加入
                                                # ── L3+ 项 ──
                                                #   ✓ plugins: 2 enabled / 0 banned            # plugin-runtime 装载后
                                                #   ✗ mcp: server "foo" unreachable            # 有 mcp 配置时
                                                # ── L4+ 项 ──
                                                #   ✓ providers reachable: anthropic, openai, gemini
  Flags:
    --json                                        # 结构化输出，便于 CI 消费
    --strict                                      # 任何 ✗ 都 exit 1
volund telemetry status                         # 显示 sink 配置 + 存储量
volund telemetry export -o report.tgz           # 导出用于 bug 报告
volund telemetry clear [--older-than <date>]
```

#### 11.3.11 completion

```
volund completion bash > /etc/bash_completion.d/volund
volund completion zsh > "${fpath[1]}/_volund"
volund completion fish > ~/.config/fish/completions/volund.fish
```

#### 11.3.12 context（r10 新增）

> Context 透明可控，详见 [§8b.13](./08b-context-policy.md)。让用户能看、能强制保留、能手动压缩、能查改策略。

```
volund context show [--json]              # 当前 token 占用 / 各来源占比(system/skill/memory/messages) / 距压缩剩余 / 当前策略
volund context diff                       # 上次压缩移除了哪些消息(messageId + 摘要 + turnId)
volund context keep <messageId|turnId>    # 打 pinned-to-context 标记 → 压缩强制保留(session 结束失效)
volund context unkeep <messageId|turnId>  # 清除 pinned-to-context 标记
volund context compact [--strategy sliding|summary]   # 手动触发压缩(尊重 preCompact hook veto)
volund context policy get                 # 查当前策略 + 参数
volund context policy set <name> [--param K=V ...]     # 改策略/参数(立即生效下一轮)
```

- 适用于脚本审计（`--json` 输出结构化）+ 人机交互（TUI 内 `/context` 面板，§11.4）
- `keep` 的 pinned-to-context 标记独立于 Memory 的 pinned（§6.12），是 context 级、session 内

#### 11.3.13 evolution（r10 新增）

> 自我进化框架的审计入口，详见 [§15](./15-self-evolution.md)。让用户能看进化的调整历史、回滚、开关。

```
volund evolution show [--namespace context|router|retry|tool-timeout] [--since <date>]
                                          # 查看近期调整(参数 before/after/reason/signal + audit 记录)
volund evolution rollback [--namespace <ns>] [--to <timestamp>]
                                          # 回滚参数到指定时间点;不指定则回滚最近一次调整
volund evolution enable [--namespace <ns>]
                                          # 启用进化(全局或单 namespace)
volund evolution disable [--namespace <ns>]
                                          # 关闭进化(参数回内置默认)
volund evolution dashboard                # L4: 参数随时间变化曲线
```

- `show` 默认显示所有 namespace 最近 7 天的调整；`--namespace` 过滤
- `rollback --to <timestamp>` 把指定 namespace 的所有参数还原到该时间点的值（读 `tuning/<ns>.jsonl` 找最近 ≤ timestamp 的每参数值）
- `disable` 后参数立即回内置默认（非保留当前值），防"关闭后仍被旧调参影响"

#### 11.3.14 status（2026-08-23 新增）

> 会话 / 模型 / 上下文 / **token 计量** / **prompt 缓存状态**的总览入口。TUI 面板渲染与按键见 §7.10；插件贡献的只读 section 走 §6.4.1a `ui.status.registerSection`（ui-surface，§19.1.1）。

```
volund status [--json]                    # 查询类命令（§11.1：--json 输出单个 JSON payload）
```

**数据源（全部 K0/core 持有，不依赖插件）**：SessionState 累计 usage（`turn.completed` 累计，含 `reflection: true` 归因标记，§21.4）、Router pricing 表（§3.3）、最近一次 ProviderRequest 的 `cache` 快照与 `ProviderCapabilities.cache`（§3.2 / §3.3）、ContextPolicy 估算（§8b）、hook/plugin/skill 注册表。

**section 清单与字段**（面板与 `--json` 共用同一数据组装层，字段名一致）：

| Section | 行 |
|---|---|
| Session | session id / cwd / 模型（`provider:model`，含 alias 来源）/ 运行时长 / turn 数 |
| Context | 当前 token 估算占用 / `max_tokens` / 距压缩阈值 / 策略（同 `volund context show` 摘要） |
| Usage & Cost | 累计 input / output token；累计 costUSD（pricing 已知时）；last-turn input / output；per-provider 分行；**reflection 归因用量单独一行**（主会话消耗与反思消耗分离，§21.4） |
| Prompt Cache | provider cache 能力（`none` / `ephemeral` / `persistent`）；当前生效策略 + TTL（来源标注：`request.cache` 通用抽象 / `rawMeta` 覆盖 / provider 自动，§3.4）；累计 cacheRead / cacheWrite token；last-turn cacheRead / cacheWrite；命中率 = `cacheRead ÷ (cacheRead + input)`（分母为 0 时显示 `—`）；估算节省 = `cacheRead × (inputPerM − cacheReadPerM)`（pricing 缺任一值时显示 `n/a`） |
| Tools & Permissions | 已注册 tool 数 / 本会话白名单命中数 / pending 权限请求数 |
| Plugins & Skills | enabled 插件数 / active skill 列表 |
| Memory | pinned 条数 / 本 session recall 次数（§6.12.11 事件计数） |
| Reflection | **条件渲染**：仅 §21 插件 enabled 时由 ui-surface 贡献（enabled 状态 / 各 trigger / session 预算 consumed·remaining / 最近一次 run / pending job）；插件 disabled 时整区不渲染 |

**诚实显示（强制）**：

- provider 不支持 cache（`capabilities.cache === 'none'`）→ Prompt Cache 区首行 `unavailable (provider)`，其余行 `n/a`，**禁止**用 0 冒充。
- provider 不上报 `cacheRead` / `cacheWrite` → 对应行 `n/a`；命中率只对已知字段求和。
- pricing 缺失 → costUSD 与"估算节省"显示 `n/a`，不得借用其他 provider 的价格估算。
- `--json` payload 同规则：未知字段**省略**（不是 `0`），payload 带 `version: 1`。

**边界**：`status` 是只读命令，不写任何状态；非 TTY 且无 `--json` 时按查询类命令输出纯文本表格（无 ANSI 控制符）；面板打开期间不自动轮询，手动 `r` 刷新（§7.10）。

#### 11.3.15 web（2026-08-28 proposed）

> 完整功能、安全、API 和交付门见 [§22 Volund Web Console](./22-web-console.md)。本命令**尚未交付**，首版只提供本地 loopback 浏览器 adapter。

```
volund web
  Flags:
    --cwd <path>          # 工作区；复用 §11.6 realpath/path guard 与 §8.3.1 trust gate
    --port <1024..65535>  # 默认随机空闲端口
    --no-open             # 不自动打开浏览器，只打印 URL
    --new-instance        # 不复用相同 canonical cwd 的健康实例
    --log-level <level>   # server 本地日志级别；不改变 telemetry 网络策略
```

**首版强制语义**：

- 只绑定 `127.0.0.1` 或 `::1`；不提供通用公网/LAN `--host`。
- terminal 输出 URL、PID、canonical cwd、sandbox/runtime 状态、停止方式；不得在日志打印 browser session secret。
- 浏览器通过一次性启动 nonce 换 HttpOnly local session，mutation 继续受 Origin/Host/CSRF、PermissionManager、Sandbox 和 workspace trust 约束。
- SIGINT/SIGTERM 有界 drain：停止新 mutation、interrupt turn、flush session/telemetry、结束后台 shell、关闭 listener。
- Web 启动/失败不得影响 `volund` TUI、`--no-tui` 或 `--json` 入口。
- 远程、手机、微信/企微和团队能力只在 §22 W-18 长期路线设计，不得用开放监听地址偷渡。

**返回码**：0 正常停止；1 参数/路径/trust 用户错误；2 listener/runtime/静态资源系统错误；130 Ctrl+C。

### 11.4 交互 REPL 内 slash 命令

进入交互模式后，用户可用 `/` 前缀触发命令，等价于 CLI 部分子命令但**作用于当前 session**：

| Slash 命令 | 等价 CLI | 说明 |
|---|---|---|
| `/help` | `volund help` | |
| `/exit` / `/quit` | Ctrl+D | 退出会话 |
| `/clear` | — | 清屏（不清 session） |
| `/reset` | — | 清 session（保留配置） |
| `/compact` | `volund context compact` | 手动触发上下文压缩（r10：补 CLI 交叉引用） |
| `/context` | `volund context show` | **r10 新增**：打开 TUI `/context` 面板（实时 token 占用 + 占比 + 最近压缩 + K/C 快捷键，见 §8b.13） |
| `/model <alias>` | `volund model use` | 切当前 session 模型 |
| `/skill activate <name>` | `volund skill activate` | 会话内激活 skill（r1.2 补实现，另有 `deactivate` / `show` 动词） |
| `/<skill-name> [args]` | — | **SKILLS-MCPS-r1 §S3.3a 新增**：每个 user-invocable skill 自动注册为同名命令；执行 = 一次性调用（invocation）——skill 内容 + args 任务作为用户消息进当轮对话，不持久改 prompt（Claude Code / Codex / Cursor 惯例） |
| `/skills` | `volund skill list` | **SKILLS-MCP-r1 新增**：打开 skill 管理面板（多作用域列表 / 启停 / 激活 / 重扫描，见 [SKILLS-MCP-UI-r1](./SKILLS-MCP-UI-r1.md) §S3.3）；另有 `/skills list` 纯文本形式 |
| `/mcp` | `volund mcp list` | **SKILLS-MCP-r1 新增**：打开 MCP server 管理面板（状态 / view tools / 启停 / 重连 / reload，见 [SKILLS-MCP-UI-r1](./SKILLS-MCP-UI-r1.md) §S3.6）；子命令 `list` / `reload` / `auth [<name>]` |
| `/plugin list` | `volund plugin list` | |
| `/debug prompt` | — | dump 当前 system prompt（见 §6.5.5） |
| `/debug state` | — | dump SessionState 摘要 |
| `/save <name>` | `volund history export` | 命名当前 session |
| `/undo` | — | 撤销最后一次 tool 执行（若有 backup；选点规则见 §8.6.2） |
| `/shells` | — | **r13 新增**：列出后台 shell（shellId / 命令 / 运行时长 / 输出预览），可选中 kill |
| `/review [flags 子集]` | `volund review` | **r13 新增**：对当前 working tree 跑 code review（详见 §17） |
| `/status` | `volund status` | **2026-08-23 新增**：打开状态面板（token 计量 + prompt 缓存状态等，§11.3.14 / §7.10） |
| `/reflect …` | — | **2026-08-23 新增**：动态反思（`now`/`on`/`off`/`list`/`show`/`save`/`rm`/`clear`，§21.8）；仅 `volund.core.reflection` enabled 时可用，否则提示 not available（§7.9 边界语义） |
| 用户自定义 | 插件 `volund.commands.register` | |

### 11.5 输入前缀（非 slash）

| 前缀              | 语义                                                        | 详见       |
|-------------------|-------------------------------------------------------------|------------|
| `@`               | **统一 picker**（r9：alias 置顶 ⭐ + 文件候选 📄 跟后，前缀过滤；选中 alias→model / 选中文件→file） | §7.5.3     |
| `@@<path>`        | 显式 **file 模式**（picker 只显示文件候选）—— 引用文件为 attachment | §7.5.3     |
| `@!<alias>`       | 显式 **model 模式**（picker 只显示 alias 候选）—— 单次覆盖本 turn 模型 | §3.9       |
| `#sess_<id>`      | 跨会话上下文引用（默认 `relevant` 策略，Tab 切 `handoff`）     | §7.5.4 / §8.5 |
| `#<tag> ...`      | 标记 message（用于历史搜索）—— **必须**非 `sess_` 开头            | —          |
| `!<cmd>`          | 直接跑 shell 命令（走 Bash tool 但跳过模型）                     | —          |
| 拖拽 / 粘贴文件路径 | 自动附加为 attachment                                          | §7.5.2     |
| 粘贴剪贴板图片    | 落盘到 attachments，行内插入 chip                              | §7.5.2     |

**歧义规则**：
- `#sess_` 前缀**保留给会话引用**，其它 `#` 前缀（不以 `sess_` 开头）继续作为 message tag
- `@` 无后续字符时开**完整统一 picker**（alias 全列 + 文件候选按 gitignore 过滤）；已有 `@<非空>` 时按前缀过滤两类候选，Esc 可退出并清空；alias 与文件同名时 alias 置顶 + Tab 切 file
- `@` 单键无后续字符时打开选择器；已有 `@<非空>` 时按当前模式（首次进入时的选择）继续补全，Esc 可退出并清空

### 11.6 边界与安全清单

| 规则 | 强制点 |
|---|---|
| `volund login` **禁止** flag 明文传 key 到 shell history（推荐 `--api-key-stdin`） | CLI 输出警告 |
| `--dangerously-*` / `--yolo` **必须** telemetry 记录一次 event | apps/cli 强制 |
| **项目级 config / mcp.toml 非交互模式默认不加载**，需 `--trust-project-config`；交互模式走 §8.3.1 信任门 | apps/cli 启动流程 + 单元测试 |
| **非交互模式**（`--no-tui` / stdin 非 TTY）**必须**拒绝加载未信任的项目级 config，避免 CI 跑恶意仓库被注入 | apps/cli + TTY 检测 |
| CLI 命令返回码：0 成功 / 1 用户错误 / 2 系统错误 / 130 Ctrl+C | 统一约定 |
| `volund history export` **必须**脱敏 credentials | export 函数白名单过滤 |
| `volund plugin dev` 必须在 shell 顶栏红条提示"开发模式" | Ink 强制 |
| 交互 slash 命令与 CLI 子命令**名字与语义保持一致** | 单元测试 |
| citty 的自动 help **必须**支持中文（i18n 后续再做） | 先英文，i18n 归 Future |
| `--cwd <path>` **必须** `fs.realpath` 归一化，且拒绝以下路径（W6）：（a）解析到 `/` / `C:\` 等根；（b）解析到 `~` / `$HOME`；（c）解析后 symlink 逃出原参数所在文件系统或指向 `~/.volund/` / `~/.ssh/` / `/etc/` / `/private/` 等敏感前缀；违规 → exit code 1 + 错误消息 | apps/cli 启动阶段 + `packages/shared/path-guard.ts` |

### 11.7 里程碑

- **L1（MVP）**：`chat` / `login` / `logout` / `config` / `history list-show` / `doctor`（L1 项） / `hook list`（builtin only） / `version` / `help` + 交互 REPL 内基础 slash
- **L2**：`history search-export-import` / `resume` / `restore` / `model` / `completion` / **`context *`（r10，随 §8b.13）** / **`evolution show/rollback`（r10，随 §15）** / **`review`（r13，本地 diff 模式 + `/review`，随 §17）** / **`status` + `/status` 面板（2026-08-23，§11.3.14）** + TUI `/context` 面板
- **L3**：`plugin *` / `skill *` / `mcp *` / `hook test` / `telemetry *` / doctor 加 plugin/mcp 段 / **`evolution enable/disable`（r10）** / **`review --pr` 模式 + 分片（r13，随 §17）**
- **L4**：`plugin dev` / `plugin init` templates / `hook show` 详细统计 / doctor 加 provider 健康 / **`review` CI gate 文档模板 + reviewer 角色路由（r13，随 §17）** / **`/reflect` 族 + §21 反思 bundle（2026-08-23，随 §6.4.1a bridge 扩展与 RoleRouter 同批）**；`volund web` 是 §10 R4 的 proposed 可选 product slice，不阻塞 CLI/TUI L4，选入 release 时按 §22 单独过 evidence gate
- **v2（不进 L1-L4）**：`volund update`（自升级 + 签名校验，需要发布渠道成熟）
