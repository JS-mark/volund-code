> ↩ [返回索引 (README)](./README.md) · 关联章节：[§6b Prompt Composer](./06b-prompt-composer.md)（§6.5）· [§7 终端 UI](./07-terminal-ui.md)（§7.9 / §7.10）· [§8 会话配置](./08-session-config.md)（§8.3.1）· [§11 CLI 命令](./11-cli-commands.md)（§11.3.8 / §11.3.9 / §11.4）· [§19 插件内核](./19-plugin-kernel.md)

---

# Volund CLI · `/skills` 与 `/mcp` 命令 + 协议对齐白皮书 (r1)

> **状态**：r1.9（2026-09-01）——MCP 断线自动重连（指数退避 ×3，超限 failed）+ Streamable HTTP transport。前情 r1.8（2026-08-26）——skill 安装支持嵌套仓库(plugins/<name>/skills/…),逐失败续装——SSE 兼容回退 + MCP 结构化日志——「列表 + 开关 + 详情」：**Enter = 详情**（/skills 为 SKILL.md 只读滚动视图、/mcp 为元数据 + 工具清单）、**Space = 启停开关**（行首 ●/○/✘/◌ 图标）——**SM-01~06 + §S3.3a（invocation 语义）+ §S3.7 CLI 管理命令族已落地**（skills 多作用域/标准字段/`/skills` 面板、mcp.toml+`.mcp.json` 装载/McpManager 接线 `mcp__server__tool`/`/mcp` 面板；vitest + pty 实测通过）。**SM-07（OAuth）未做**；~~SM-08 后半（插件捆绑 skills）~~（r1.9 已落地：`SkillScope` 增 `plugin`，已启用插件的 `<pluginDir>/skills/` 进发现面，优先级 project > plugin > user，builtin 无条件收录、dev/market 按 plugin-state enabled 门控；SkillsRuntime sources 支持惰性 provider）；~~SM-08 Streamable HTTP transport~~（r1.9 已落地：POST+SSE 混合应答、`Mcp-Session-Id` 会话回传与 DELETE 终止、`MCP-Protocol-Version` 头、GET 监听流 405 规范内降级、404 会话过期断线交自动重连）。已知实现偏差（vs §S3 原文）：① `/skills` 详情页为只读滚动视图（Enter 打开，j/k 滚动），未做动作菜单与 `$EDITOR`/Copy path；② ~~MCP 无自动重连退避~~（r1.9 已补：断线自动重连 = 指数退避 ×3 次、超限置 failed、needs-auth 不重试），fatigue 三件套未接线；~~keyref 凭据解析未接线~~（r1.9 已补：http headers 的 `keyref://mcp.<name>.<field>` 在连接期经 auth store 解析，miss fail-closed 不上线）；③ ~~§S3.8 telemetry 事件未加~~（r1.9 已补全部 6 类：panel_opened×2、scope_shadowed、standard_schema_rejected、server_state_changed（name sha256 前 8 位）、interop_json_loaded）；④ ~~`volund skill/mcp` CLI 子命令族未加~~（r1.4 已补：skill install/uninstall/list/show/enable/disable + mcp add/remove/enable/disable，含 git 安装源与 `--` 透传，见 §S3.7）；r1.7：SSE 规范回退（先 POST initialize 探测，4xx/405 回退 GET SSE）+ `~/.volund/mcp.log` JSONL 诊断（manager.init/connect.start/connect.ok/connect.failed/connect.needs-auth/disconnect/reconnect.scheduled/reconnect.gave-up/server.stderr/connect.protocol，追加写、失败静默）；⑤ per-skill 命令的 args 作为整体任务文本附在 skill 框架后（Claude Code 的 $ARGUMENTS 占位插值留 r2）。
> **文档类型**：ADR + 扩展规约
> **范围**：`packages/skills-runtime`（多作用域 + 标准字段）、`packages/mcp-client`（接线 + Streamable HTTP）、`packages/ui`（SkillsPanel / McpPanel）、`apps/cli`（REPL 命令 + `volund skill`/`mcp` 子命令增补）、`packages/config`（`[skills]` / mcp.toml schema）
> **触发**：REPL 内缺 `/skills`、`/mcp` 管理入口；skill/MCP 协议与业界通用结构存在漂移，需在实现扩散前对齐。

---

## §S0 结论速览

| 问题 | 现状 | 决策 |
|---|---|---|
| `/skills` REPL 命令 | **不存在**（spec 与实现均无；§11.4 仅 `/skill activate`，实现仅 `Skill.activate` 工具） | 新增 `/skills` 管理面板（SM-03） |
| `/mcp` REPL 命令 | **不存在**（spec 仅顶层 `volund mcp` CLI 族；`packages/mcp-client` 已写好但 runtime 未接线） | 新增 `/mcp` 管理面板（SM-06；业界单数惯例，不设复数形式） |
| Skill 文件协议 | 自定义 frontmatter（`volundVersion` 必填、`resources`、`activation`），单一 `~/.volund/skills` 作用域 | 对齐 [agentskills.io](https://agentskills.io/specification) 开放标准：标准字段必填、Volund 扩展降级为可选；新增项目级 + `.agents/skills/` 互操作路径（SM-01） |
| MCP 配置协议 | `mcp.toml`（键名未定）；工具命名 `mcp:<server>:<tool>` | 键名对齐 `[mcp_servers.<name>]`（Codex 同构）+ 读互操作 `.mcp.json`；工具命名改 `mcp__<server>__<tool>`（业界通用）（SM-04/05） |

**业界基准**（2026-08 调研）：

- **Skill**：Anthropic 2025-10 发布、2025-12-18 成为跨厂商开放标准（agentskills.io，40+ 厂商采用：Claude Code / OpenAI Codex / Gemini CLI / Cursor / VS Code Copilot / opencode…）。通用结构 = 目录 + `SKILL.md`（frontmatter `name`/`description` 必填 + `scripts/`/`references/`/`assets/`）+ 三层渐进披露 + 模型按 description 语义自触发。管理入口 `/skills` 是 Claude Code / Codex / VS Code Copilot 共同惯例。
- **MCP**：`mcpServers` 配置键（stdio: `command/args/env`；http: `type/url/headers`）+ 项目级 `.mcp.json` + 用户级配置的三层 scope 是事实标准；传输 stdio + Streamable HTTP（旧 HTTP+SSE 已废弃，保留回退）；OAuth 2.1 + PKCE + DCR；工具命名 `mcp__<server>__<tool>`；面板交互（状态 / view tools / authenticate / reconnect / enable-disable）以 Claude Code `/mcp` 为准。

---

## §S1 目标与非目标

### S1.1 目标

1. **`/skills` / `/mcp` 两个 REPL 管理面板**：数据契约式（K0 渲染，复用 §7.10 / ListPicker 交互基元），支持查看、启停、激活、重连等动作，无需重启会话。
2. **Skill 协议对齐 agentskills.io**：标准 frontmatter 字段必填、扩展字段可选；多作用域发现（user / project / 插件 / `.agents/skills/` 互操作）；存量 skill 平滑迁移（双读 + deprecation warning）。
3. **MCP 协议对齐通用结构**：`[mcp_servers.<name>]` TOML 键（与 Codex `[mcp_servers.*]` 同构）+ 只读导入业界 `.mcp.json`；`${VAR}` / `${VAR:-default}` env 展开；`mcp__<server>__<tool>` 工具命名与权限规则粒度。
4. **与既有安全机制闭环**：项目级 skills / `.mcp.json` / mcp.toml 全部走 §8.3.1 信任门；MCP fatigue 防护（§11.3.9）与 keyref 凭据规则（W7）不变，本白皮书只做接线。

### S1.2 非目标（划清边界）

- **不做** skill marketplace / `skills.sh` 安装源集成（`volund skill install <spec>` 维持本地目录 + git URL 两种，v2 再议）。
- **不做** MCP server 端实现（Volund 只做 client）；`resources` / `prompts` / sampling / elicitation 原语的**消费**放 v2——L3 只消费 `tools/list` + `tools/call`（现 `packages/mcp-client` 已覆盖），`/mcp` 面板的 inspect 页展示 resources/prompts 清单但不可调用。
- **不做** skills 跨设备同步（claude.ai sync 类功能）。
- **不改** `Skill.activate` 工具契约与 prompt composer 优先级表（§6.5：index=850 / active=800）；`/skills` 面板是旁路管理入口，不影响注入管线。
- **不做**插件捆绑 skills 的自动装载（§6a manifest `"skills": []` 字段保留，装载走 SM-08 后置任务，面板先把 plugin scope 显示为占位列）。

---

## §S2 与既有约束的张力（决策依据）

### S2.1 vs §6.5.2 现行 frontmatter（`volundVersion` 必填）

**张力**：开放标准只有 `name` / `description` 必填，无 `volundVersion` 概念；标准外顶层字段应放 `metadata`。现行实现把 `volundVersion` 设为必填，导致第三方标准 skill（anthropics/skills 仓库等）无法直接安装。

**消解**：采用**双读迁移**——标准字段（`name`/`description`）必填且约束升级（name 1–64 字符 `^[a-z0-9]([a-z0-9-]*[a-z0-9])?$`、不得连续 `--`、**须与父目录名一致**；description 1–1024 字符）；`volundVersion` 降级为可选（缺失 = 视为兼容，不再 warning；出现时语义映射到标准 `compatibility` 字段处理）。存量 skill 不需要改动即可继续工作。详见 §S3.1。

### S2.2 vs 单一 `~/.volund/skills` 作用域

**张力**：业界通用是 user + project（+ 插件）多层作用域，且 `.agents/skills/` 已成跨工具互操作事实路径（Gemini/Codex/Cursor/Copilot/opencode 原生读取）。单作用域意味着仓库级 skill 无法随项目分发。

**消解**：新增作用域，优先级 **project > user > plugin**（与 Codex/Gemini 的"项目覆盖用户"一致；Claude Code 的"个人>项目"不采纳——Volund 的项目级输入已有信任门兜底，覆盖语义与 §8 config 分层一致）。同时**只读**识别互操作路径：项目级 `<cwd>/.agents/skills/` 与用户级 `~/.agents/skills/`（Volund 自有路径 `.volund/skills/` 优先级高于同层 `.agents/skills/`）。项目级目录（含 `.agents/skills/`）首次发现走 §8.3.1 信任门（展示 skill 名 + 来源路径清单）。

### S2.3 vs §11.3.9 `mcp:<server>:<tool>` 工具命名

**张力**：`mcp__server__tool` 双下划线是 Claude Code 事实标准（权限规则 `mcp__github` 匹配整 server、`mcp__github__get_issues` 单工具、`mcp__github__*` 通配）；单冒号命名无法与权限通配规则无歧义解析（tool 名可含 `:`）。

**消解**：改为 `mcp__<server>__<tool>`（server/tool 名内非法字符替换为 `_`）。§11.3.9 / §04 的 `mcp:` 前缀表述随 SM-05 一并修订；由于 MCP 尚未接线，无迁移负担。插件工具前缀 `plugin:<name>:<tool>` 不变（另一族，不混用）。

### S2.4 vs `mcp.toml` vs 业界 `.mcp.json`

**张力**：Volund 配置体系是 TOML；业界项目级共享配置是 JSON `.mcp.json`。二选一会牺牲一侧。

**消解**：**自有读写走 TOML，互操作只读走 JSON**——`volund mcp add` 写 `~/.volund/mcp.toml` / `<cwd>/.volund/mcp.toml`（顶层 `[mcp_servers.<name>]` 表，字段与业界 JSON 条目同构：stdio `command/args/env/cwd`，远程 `type/url/headers`）；`<cwd>/.mcp.json` 与 `<cwd>/.agents/mcp.json`（opencode 等互操作候选）**只读导入**、条目并入 project scope、走信任门。两条路径同名时 TOML 优先（自有配置可覆盖仓库下发的 JSON）。

### S2.5 vs §7.10 面板"只读"边界

**张力**：`/status` 面板明确只读；`/skills`、`/mcp` 需要 enable/disable / reconnect / authenticate 等**写动作**。

**消解**：新面板是**管理面板**而非状态面板——写动作必须经确认或即时反馈（启用切换直接生效并 transcript 打一行结果；OAuth/重连等异步动作在面板内联显示进行中状态）。所有写动作都有 CLI 等价物（§11.3.8/§11.3.9），面板只是会话内快捷入口，不引入 config 之外的隐藏状态（启用名单落 `[skills]` / `[mcp]` config 键，见 §S3.4）。

---

## §S3 契约

### S3.1 Skill frontmatter schema（对齐 agentskills.io，v2）

```yaml
---
# ── 标准字段（agentskills.io）──────────────────────────────
name: git-workflow            # 必填。1–64 字符，^[a-z0-9]([a-z0-9-]*[a-z0-9])?$，
                              # 无连续 --，必须与父目录名一致（现行实现缺目录名校验，SM-01 补）
description: >                # 必填。1–1024 字符。应同时描述"做什么"与"何时用"
  Guides conventional commits, atomic changes...
license: MIT                  # 可选
compatibility: "requires node>=20"   # 可选，≤500 字符；volundVersion 出现时映射到此语义
metadata:                     # 可选，string→string；扩展属性一律放这里（加前缀防冲突）
  volund-version: "^1"
  version: "1.0.0"
allowed-tools: "Bash(git:*) Read"    # 可选（实验性）。激活时映射为 permissions 预授权规则

# ── Volund 扩展（可选；存量字段继续识别，双读）──────────────
volundVersion: ^1.0.0         # 可选。存量字段；缺省 = 兼容；出现时按 compatibility 语义校验
version: 1.0.0                # 可选。存量字段；等价 metadata.version
activation:                   # 可选。存量字段
  auto:
    - path_exists: .git
    - secret: mentions_git
  manual: true
resources:                    # 可选。存量字段：激活时一并注入 prompt 的白名单文件
  - references/conventional-commits.md
disable-model-invocation: false  # 可选（业界通用开关）。true = 仅用户可触发（/skills 面板或 /skill activate）
user-invocable: true             # 可选（业界通用开关）。false = 不进 / 菜单与 /skills 面板，仅模型可调用
---
```

**校验规则**（`packages/shared/skill-schema.ts` 重写，zod）：

| 规则 | 行为 |
|---|---|
| 缺 `name` / `description` / frontmatter 整体缺失 | discover 报 warning（`skill.invalid: <dir>: <reason>`），该 skill 进面板 `broken` 态，不进 index fragment |
| name 与目录名不一致 | 同上（`skill.name_mismatch`）——安装第三方标准 skill 的常见坑 |
| 非法顶层字段（不在标准 + 扩展白名单内） | warning `skill.unknown_field`，不拒绝加载（标准未禁止未知字段） |
| `volundVersion` 主版本不匹配 | warning + 面板 `incompatible` 态（现行语义保留，但从必填检查降为存在才检查） |
| description > 1024 | warning + index fragment 截断到 1024 加 `…` |

**触发模型**（渐进披露三层不变，§6.5.3）：metadata（name+description）常驻 index fragment（priority 850，含 scope 标注）→ 模型调 `Skill.activate` 或 auto 规则命中 → body + `resources` 注入（priority 800）。新增：`disable-model-invocation: true` 的 skill 不进 index fragment（模型不可见），只出现在 `/skills` 面板与 `/` 补全（除非 `user-invocable: false`，则两处都不出现，仅 config 强制 activate 可用）。

### S3.2 Skill 作用域与发现顺序

| scope | 路径 | 信任门 | 说明 |
|---|---|---|---|
| `project` | `<cwd>/.volund/skills/` | 是（§8.3.1） | 随仓库分发；覆盖同名 user skill |
| `project`（互操作） | `<cwd>/.agents/skills/` | 是 | 只读语义（Volund 不写此目录）；同层低于 `.volund/skills/` |
| `user` | `~/.volund/skills/` | 否 | 现行唯一路径，不变 |
| `user`（互操作） | `~/.agents/skills/` | 否 | 只读；同层低于 `~/.volund/skills/` |
| `plugin` | `<plugin 安装目录>/skills/` | 随插件信任 | SM-08 后置；面板先显示占位 |

- 同名冲突：高优先级整条生效，低优先级条目进面板 `shadowed` 态（显示被谁覆盖），**不**报错（与 Codex/Gemini 语义一致；弃用现行"Duplicate skill name 抛错"——该规则在单作用域下成立，多作用域下改为 shadow）。
- `installFromDirectory` / `volund skill install` 默认写 user scope；`--scope project` 写 `<cwd>/.volund/skills/`（交互模式自动记信任）。

### S3.3 `/skills` 命令

**形式**：

```
/skills                    # 打开管理面板（本契约核心）
/skills list               # 非面板：transcript 打印纯文本表格（等价 volund skill list）
/skill activate <name>     # 保留：快捷动词式（§11.4 现行条目不变）
/skill deactivate <name>   # 保留
/skill show <name>         # r1.2：SKILL.md 全文进 transcript
```

**§S3.3a · per-skill 同名 slash 命令（r1.3 修订为 invocation 语义；业界惯例：Claude Code / Codex / Cursor）**：每个 user-invocable 且非 broken / shadowed / disabled 的 skill 自动注册为 `/skill-name` 命令（slash registry source kind = `skill`）。**执行 = 一次性调用**：命令返回 `{kind:'submit'}` 视图，TUI 把「`<skill name directory>` 框架 + SKILL.md body + 任务文本」作为**用户消息提交当轮对话**——不持久改 system prompt（模型按需自行 Read resources；body 内 `</skill` 转义防框架逃逸）。无 args 时附默认任务句 `Follow the "<name>" skill's instructions…`。**展示折叠**：transcript 对该形态的用户消息只渲染一行摘要（`skill <name> invoked · <task 首行>`）+ 行数提示，正文不刷屏；判定只依赖文本自身（resume / 重放同样折叠），session JSONL 仍保存全文。会话级持久激活另有入口：`/skill activate|deactivate`（§11.4）与 `/skills` 面板 `a` 键。同步时机 = 首次装载、`/skills` 面板 `r` 重扫、启停切换（幂等 diff：新增注册、消失注销）。撞 builtin / 已注册命令名 → warn + 跳过；`user-invocable: false` 不注册（模型专用）。**安全**：`{kind:'submit'}` 结果仅 builtin / skill 来源允许产出，插件来源降级为 warning 系统消息（防插件伪造用户发言）；输入行历史记原始命令而非展开文本。

**面板数据契约**（K0 组装，纯数据 view model；UI 不读 SkillsRuntime 内部）：

```ts
interface SkillsPanelView {
  title: 'Skills'
  entries: Array<{
    name: string
    description: string            // 截断 1024
    scope: 'project' | 'user' | 'plugin'
    source: string                 // 目录绝对路径（截中段显示，复用 ListPicker VALUE_COLUMN_CAP）
    status: 'active' | 'available' | 'disabled' | 'shadowed' | 'broken' | 'incompatible'
    shadowedBy?: string            // status=shadowed 时给出覆盖者 scope:name
    version?: string
    flags?: Array<'disable-model-invocation' | 'user-invocable-false'>
  }>
}
```

**交互**（r1.6：列表 + 开关 + 详情）：

| 按键 | 行为 |
|---|---|
| `↑`/`↓` 或 `j`/`k` | 选择；`PgUp`/`PgDn` 翻页 |
| 输入字符 | query 过滤（name/description 模糊匹配，同 ListPicker） |
| `Enter` | **进详情**：SKILL.md 只读滚动视图（j/k 滚动，Enter/Esc 回列表） |
| `Space` | **开关**：enabled↔disabled 切换（行首图标 `●`/`○`），持久写 config（§S3.4），transcript 打一行 `skill <name> enabled/disabled`，列表即时刷新 |
| `a` | 会话级 activate↔deactivate 切换（等价 `/skill activate|deactivate`） |
| `r` | 重扫描（SKILL.md 编辑后免重启生效） |
| `Esc` / `q` | 关闭 |

行首图标：`●` 启用 / `○` 停用 / `✘` broken / `◌` shadowed（broken/shadowed 的 Enter 无效，原因显示在描述列）。SKILL.md 全文查看也可走 `volund skill show`（r1.4）。

**边界**：

- 面板打开期间主 loop 不暂停；数据是打开 / `r` 时刻快照（§7.10 语义）。
- `active` 态的判定来自 SkillsRuntime（prompt fragment 是否注册），面板切换 `a` 后即时反映。
- 端口不可用时命令显示 `not available in this build/session`，不 crash（§7.9 边界语义）。
- 面板所有字符串过 control-character guard（skill description 是不可信第三方输入，同 §7.10 插件 section 规则）。

### S3.4 持久化键（APPENDIX-C 增补）

```toml
[skills]
disabled = ["git-workflow"]     # 用户级禁用名单（Space 切换写这里；对 user+project scope 均生效）
index_budget = 4096             # index fragment 字符预算（默认 4096 ≈ 上下文 1% 量级，超出按 name 降序丢 description）

[mcp]
disabled = ["slow-server"]      # /mcp 面板 Space 切换写这里
enable_all_project_servers = false   # 信任门外另设的总放行（非交互场景）
# 注意：server 定义本体不在这里，在 mcp.toml（§S3.5）
```

项目级 `.volund/config.toml` 可设同名键覆盖用户级（走既有 config 合并 + 信任门）；`disabled` 名单合并（并集）。

### S3.5 MCP 配置结构

**`~/.volund/mcp.toml` / `<cwd>/.volund/mcp.toml`**（顶层表，字段与业界 JSON 条目同构）：

```toml
[mcp_servers.context7]              # stdio
command = "npx"
args = ["-y", "@context7/mcp"]
env = { API_KEY = "${CONTEXT7_KEY:-}" }   # ${VAR} / ${VAR:-default} 展开（启动时解析；未定义且无默认 → 空串 + warning）
cwd = "."

[mcp_services.github]               # 禁止：表名前缀必须是 mcp_servers（未知顶层表 → config warning）
[mcp_servers.github]                # 远程（Streamable HTTP）
type = "http"                       # http | streamable-http（别名）| sse（废弃，兼容回退）
url = "https://api.githubcopilot.com/mcp/"
headers = { Authorization = "keyref://mcp.github.Authorization" }   # W7 凭据规则不变
```

**互操作只读导入**：`<cwd>/.mcp.json`（业界格式：顶层 `mcpServers` 对象，stdio `command/args/env`，http `type/url/headers`）→ 条目并入 project scope；`.volund/mcp.toml` 同名条目优先。`.mcp.json` 走 §8.3.1 信任门 + 启动时首个信任弹窗展示其 server 清单（transport + url/command 摘要）。

**Scope 优先级**：project（`.volund/mcp.toml` > `.mcp.json`）> user（`~/.volund/mcp.toml`）。同名整条覆盖，不合并字段（Claude Code 语义）。`volund mcp add -s user|project`（默认 user）。

**工具命名与注册**：连接后按 `tools/list` 注册为 `mcp__<server>__<tool>`（名字内 `:`/`__` 等非法字符替换 `_`）；`PermissionSpec` 映射 annotations 的 readOnlyHint/destructiveHint（视为 hint 不可信，§04 规则不变）。`notifications/tools/list_changed` → 增量 diff 重注册 + 面板 `r` 可见；新增 tool 触发一次上线信任门（§11.3.9 第 3 层防护，已有设计）。

**权限规则**：`permissions.allow/ask/deny` 支持 `mcp__github`（整 server）、`mcp__github__get_issues`（单工具）、`mcp__github__*`（通配仅允许出现在 tool 段）；deny 优先于 allow。与 §11.3.9 的 `permissions.mcp.<name>` 域（allow-mcp-server 弹窗写入）统一收敛到这一种写法——`permissions.mcp.<name>` 作为其序列化形态保留（改动最小化）。

### S3.6 `/mcp` 命令

**形式**：

```
/mcp                     # 打开管理面板（业界单数惯例，与 Claude Code / Codex / Gemini CLI 一致）
/mcp list                # 非面板：transcript 打印 server 清单 + 健康状态
/mcp reload              # 断开全部并按配置重连（Gemini /mcp reload 语义）
/mcp auth [<name>]       # 无名 = 列出 needs-auth server；有名 = 发起 OAuth（SM-07）
```

**面板数据契约**：

```ts
interface McpPanelView {
  title: 'MCP Servers'
  entries: Array<{
    name: string
    scope: 'project' | 'user'
    transport: 'stdio' | 'http' | 'sse'          // + 简述（command 首词 / host）
    status: 'connected' | 'connecting' | 'needs-auth' | 'failed' | 'disabled'
    tools?: number                                 // connected 时；needs-auth/failed 为 undefined（诚实显示，不写 0）
    detail?: string                                // failed 时的错误摘要（截断 + guard）
    protocolVersion?: string                       // 握手结果（2025-06-18 等）
  }>
}
```

**交互**：

| 按键 | 行为 |
|---|---|
| `↑`/`↓` / `j`/`k`、query 过滤、`Esc`/`q` | 同 `/skills` |
| `Enter` | **进详情**：server 元数据（scope/transport/status/protocolVersion）+ 工具清单（`mcp__<server>__<tool>` + description），j/k 滚动，Enter/Esc 回列表 |
| `Space` | **开关**：enabled↔disabled 持久切换（写 `[mcp] disabled`；disabled = 断开连接 + 注销全部 `mcp__<server>__*` 工具），列表即时刷新 |
| `r` | 对全部 server 重跑连通性测试（等价 `volund mcp test --all`；面板内联显示进行中） |

**r1.7 · SSE 兼容回退 + 诊断日志**：
- `HttpSseTransport` 启动时先 POST `initialize` 到 server URL（JSON）；405/404/401 → 判定为旧 SSE 端点，回退 GET `text/event-stream` 等 `endpoint` 事件（2025-06-18 规范回退流程；Claude Code `.mcp.json` 的 `type:"sse"` server 由此可连）。
- `McpManager` 把生命周期事件追加写 `~/.volund/mcp.log`（JSONL）：`manager.init` / `connect.start`（server、scope、transport 摘要）/ `connect.ok`（protocolVersion、tools 数）/ `connect.failed` / `connect.needs-auth` / `disconnect` / `server.stderr`（stdio 子进程 stderr 逐行）/ `connect.protocol`（HTTP 探测结果）。写入失败静默（不阻塞主链路）；行数不设上限（追加式，跨会话累积，清理随用户/磁盘）。
- `~/.volund/mcp.log` 与 telemetry 事件（§S3.8）正交：日志是排障留痕，telemetry 是采样指标。

**状态机与事件**：`packages/mcp-client` 已有 initialize 握手 + 工具注册；SM-05 新增 `McpManager`（runtime 侧）：持有全部 server 连接、暴露 `snapshot(): McpPanelView` + `subscribe`（状态变更 → UI 热更新，面板关闭时不订阅）；断线自动重连策略 = 指数退避 ×3 次，超限置 `failed`；`needs-auth` 判定 = HTTP 401/403（SM-07 前，此类 server 详情页给出手动 header 配置指引）。

**边界**：

- fatigue 防护三件套（§11.3.9）在接线时一并生效：batch 合并弹窗、`max_prompts_per_minute`（默认 10）、上线信任门。
- 面板动作全部有 CLI 等价物（`volund mcp list/test/inspect/remove` + 新增 `enable/disable/login/logout/reload`）；面板不产生 config 之外的状态。
- 非交互模式（`--no-tui`/非 TTY）：项目级 `.mcp.json` / mcp.toml 默认不加载（§11.6 既有规则），`enable_all_project_servers` 显式放行。

### S3.7 CLI 命令增补（§11.3.8 / §11.3.9 修订）

```
volund skill list [--scope user|project] [--json]         # r1.4 已实现：scope 过滤 + status 列
volund skill enable|disable <name>                        # r1.4 已实现（config [skills] disabled 持久面）
volund skill show <name>                                  # r1.4 已实现（打印 SKILL.md 全文）
volund skill install <spec> [-s user|project]             # r1.4 已实现：spec = 本地目录 | git URL |
                                                          #   r1.8:git 仓库内嵌套路径任意深度(如 anthropics/claude-plugins-official 的
                                                          #   plugins/<name>/skills/…),逐个失败记警告继续;target 已存在即跳过该条
                                                          #   github:owner/repo | owner/repo | file://…；
                                                          #   git 仓库根有 SKILL.md 装 root，否则装一层
                                                          #   子目录里全部带 SKILL.md 的（repo 捆多 skill）
volund skill uninstall <name> [-s user|project]           # r1.4 已实现（仅可写非 interop 作用域）
volund skill validate [<dir>]                             # 未做（doctor 侧覆盖，后置）

volund mcp add <name> -- <command> [args...]              # r1.4 已实现：stdio `--` 透传
volund mcp add [-t http|sse] <name> <url>                 # r1.4 已实现：远程；-e K=V / -H 'K: v' 可重复；
                                                          #   -s user|project 选目标 mcp.toml（默认 user）
volund mcp remove <name> [-s user|project]                # r1.4 已实现（默认先查 project 再查 user）
volund mcp enable|disable <name>                          # r1.4 已实现（config [mcp] disabled 持久面）
volund mcp list / test / inspect                          # r1.4 已实现（list 连通性有界等待 4s 后快照；
                                                          #   stdio 子进程在 CLI 一次性进程收尾关闭）
volund mcp reload                                         # 未做（REPL /mcp reload 已有）
volund mcp login|logout <name>                            # SM-07 未做
```

### S3.8 Telemetry 事件（§8.6 表增补）

| 事件 | 触发 | 属性 |
|---|---|---|
| `skills.panel_opened` | `/skills` 面板打开 | `count`, `broken_count` |
| `skill.scope_shadowed` | discover 发现同名覆盖 | `name`, `winner_scope`, `loser_scope` |
| `skill.standard_schema_rejected` | 标准字段校验失败 | `reason`（name_mismatch / missing_description / …） |
| `mcp.panel_opened` | `/mcp` 面板打开 | `count`, `connected`, `failed`, `needs_auth` |
| `mcp.server_state_changed` | 连接状态迁移 | `name_kind`（哈希后）, `from`, `to` |
| `mcp.interop_json_loaded` | `.mcp.json` 导入 | `count` |

---

## §S4 实现映射与任务卡

| 卡 | 内容 | 触达 | Level |
|---|---|---|---|
| SM-01 | skills-runtime 多作用域发现 + 标准字段双读 + name/目录名一致校验 + shadow 语义 + index_budget | `packages/skills-runtime`、`packages/shared/skill-schema.ts` | L2 |
| SM-02 | `[skills]` config 键 + `volund skill enable/disable/validate/list --scope` + `Skill.activate` 尊重 disabled/disable-model-invocation | `packages/config`、`apps/cli/src/commands/skill/` | L2 |
| SM-03 | `/skills` 面板（SkillsPanelView 组装 + ListPicker 复用 + 详情页 + `a`/`e`/`r` 键位）+ `skills` 进 BUILTIN_SLASH_COMMAND_NAMES | `packages/ui`、`apps/cli` | L2 |
| SM-04 | mcp.toml `[mcp_servers.*]` schema + `.mcp.json` 只读导入 + `${VAR}` 展开 + 信任门联动 | `packages/config`、`apps/cli` 启动流程 | L3 |
| SM-05 | McpManager 接线（mcp-client → ToolRegistry，`mcp__` 命名，重连退避，snapshot/subscribe）+ fatigue 三件套生效 | `apps/cli/src/runtime.ts`、`packages/mcp-client` | L3 |
| SM-06 | `/mcp` 面板（含 reload/auth 子命令壳）+ `mcp` 进 builtin 名单 + `volund mcp enable/disable/reload` | `packages/ui`、`apps/cli` | L3 |
| SM-07 | OAuth 2.1 + PKCE + DCR 客户端流（401 检测 → 浏览器授权 → token 存 auth）+ `volund mcp login/logout` + 面板 Authenticate | `packages/mcp-client`、`packages/auth` | L3 后段 |
| SM-08 | Streamable HTTP transport（现 HttpSseTransport 升级为规范 POST+SSE 混合 + `Mcp-Session-Id` + 协议版本 header）+ 插件捆绑 skills 装载 | `packages/mcp-client`、`packages/plugin-runtime` | L3 后段 |

依赖链：SM-01→02→03；SM-04→05→06；SM-07/08 独立挂 SM-05 之后。SM-01 与 SM-04 可并行。

---

## §S5 验收清单（DoD）

| 规则 | 强制点 |
|---|---|
| 第三方标准 skill（anthropics/skills 仓库任一直接拷入 `~/.agents/skills/`）零改动可被发现、激活 | 集成测试（fixtures 拷贝真实结构） |
| 缺 name/description 或 name≠目录名的 skill 不进 index fragment、面板显示 broken + 原因 | skills-runtime 单测 |
| 项目级 skill/`.mcp.json`/mcp.toml 首次加载必弹信任门（§8.3.1）；非交互默认拒绝 | 启动流程单测 |
| MCP 工具注册名 = `mcp__<server>__<tool>`；权限规则三粒度（server/工具/通配）解析无歧义 | registry + permission 单测 |
| `/skills`、`/mcp` 面板端口不可用时显示 not available，不 crash TUI | tui.test（§7.9 边界语义） |
| 面板 Space 切换持久化到 `[skills]`/`[mcp] disabled`，重启会话后状态保持 | 集成测试 |
| 连接状态迁移只经 McpManager 状态机；failed 原因经 control-character guard | McpManager 单测 |
| bundle 改动后 TUI 实测（pty）通过 | §9 发布前检查（memory: bundle-tui-verify） |
| skills/mcp 面板交互与 builtin 名单变更在 pty 下人工过一遍 | RELEASE-CHECKLIST-L1 增补两行 |

---

## §S6 开放问题（r2 输入）

1. `/skills` 详情页 `Edit` 调 `$EDITOR` 的全屏接管与 Ink 焦点让渡——需 pty 实测定键位细节（resume/`!cmd` 有先例可抄）。
2. index fragment 预算默认值（4096 字符）与 context policy（§8b）的交互：compact 后是否重附最近激活 skill（Claude Code 有此行为），暂不做、留观察。
3. `.agents/mcp.json` 是否纳入互操作导入（opencode 生态），v2 与 `.mcp.json` 一起评估。
4. skill 安装源 `skills.sh`（`npx skills add`）集成价值评估——非目标清单可否决。
