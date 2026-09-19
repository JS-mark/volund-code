> ↩ [返回索引 (README)](./README.md) · 关联章节：[§22 Web Console](./22-web-console.md)（W-12）· [PLUGIN-MANAGER r1](./PLUGIN-MANAGER-r1.md)（市场链/digest/三段状态机）· [SKILLS-MCP-UI r1](./SKILLS-MCP-UI-r1.md)（skill/mcp 协议与管理面板）· [§19a Capability Contract](./19a-capability-contract.md)（签名信任根前置）· [§8 会话配置](./08-session-config.md)（§8.3.1 项目级信任门）

---

# Volund Web 控制台 · 扩展管理（MCP / Skills / Memory / Plugins）+ 市场白皮书 (r1)

> **状态**：r1.1（2026-09-19）——自评审修订：① MG-04 机制改为「域级 reload」（manager 单例重建 + 会话 registry 重挂），并把 `McpPort.test/inspect` 复用共享单例后 `close()` 的**存量缺陷**（web `inspect` 动作现已注册可调，触发即拆活会话 MCP 连接）纳入同批修复；② approve 由「逐项 diff」降级为「全量清单 + permissionHash 变更高亮」（plugin-state 只存哈希，无逐项 diff 数据源）；③ mcp/skill 的 `reload` 动作口径改为「端口新增方法，复用域内同步闭包」；④ `add` 入参演示适配到 `McpAddInput` 判别联合的映射；⑤ 补 memory export/import 与 mcpServers JSON 粘贴预填；⑥ 市场已装回标分段写实（skill 无安装回执，不做更新检测）。r1（2026-09-18）首版起草。**PROPOSED / NOT SHIPPED**
> **文档类型**：ADR + 扩展规约
> **范围**：`apps/web`（ManagePage 及新市场页签）、`packages/web-server`（management 动作表）、`packages/app-runtime`（memory-controller / mcp-domain / skills / plugins-domain 接线）、`packages/shared`（config schema 新键）
> **触发**：Web 控制台四域（MCP/Skills/Memory/Plugins）现状均为只读或仅开关，无法导入/安装/编辑；且无任何市场入口。W-12 验收要求 CLI/TUI/Web 扩展管理三端平权。用户明确要求 memory 支持编辑（markdown 文本编辑器）。
> **编号**：新启 **MG**（web extension ManaGement & Market）序列，不复用 W/SM/CAT。

---

## §S0 结论速览

| 问题 | 现状 | 决策 |
|---|---|---|
| Web 四域管理只读 | MCP/Skills 仅 `setEnabled`；Memory 仅 list/search/pin/unpin/delete；Plugins 仅 builtin 域开关（`packages/web-server/src/index.ts:1257-1328` 动作表） | 动作表全量补齐（MG-01/05/07/10），**全部复用既有 domain/port 方法，零新写路径** |
| Memory 不可编辑 | controller 有 `update` 无 `create`（`app-runtime/src/memory-controller.ts:47`），web-server 动作表两者皆缺；TUI 面板已有编辑模式 | 补 `create`/`update` 动作 + Web 端 **markdown 编辑器**（编辑/预览/分屏，零新依赖，MG-01~03） |
| MCP 装完不生效 | `McpManager.reload` 只重连**冻结的**内存集合，不重读 mcp.toml（`mcp-domain.ts:373`；配置装载发生在 `ensureMcpManager` `:797`，服务面冻结于 manager 创建时）；另 `McpPort.test/inspect` 复用共享单例后 `close()`（`:880`/`:895`）——**存量缺陷**：常驻进程内调用即拆活会话连接，web `inspect` 动作现已可触发 | 后端行为修复：**域级 reload**（重置 manager 单例 → 重读 mcp.toml → 重挂会话 registry）+ test/inspect 改一次性 manager（TUI 同步受益，MG-04） |
| 无市场 | Web 无任何市场概念；唯一可用插件安装通道是 TUI `/plugins` 斜杠命令（builtin volund-plugin-manager）；skills/MCP 无索引概念 | 管理 Page 新增**「市场」页签**：Plugins（复用 `[plugins] market` 既有链）/ Skills 目录（新索引，git 源安装）/ MCP 目录（预填表单安装）（MG-13~15） |
| 插件远程 HTTPS 安装 fail-closed | `plugin_registry_signature_required`（`plugin-market.ts:288`），等签名信任根（§19a/ABI-00） | **维持不动**：市场远程条目可浏览、安装置灰并明示解锁条件（D-1） |
| 供应链门 | digest 校验 / install→approve→enable 三段状态机 / 权限清单 | 不放松：approve 前必须渲染权限清单（web 新增清单 + 变更高亮视图，MG-12；plugin-state 只存哈希，**不做逐项 diff**） |

**架构基线（一句话）**：web-server 的 `/api/v1/{domain}/actions` tagged-union 平面是唯一变更入口，`web.ts` 已把完整 `ports.mcp` / `ports.skill` 传入、plugins domain 全套方法（`installMarketPlugin/approvePlugin/enable/disable/uninstall`，`plugins-domain.ts:478-484,592-657`）已存在——本设计只做**接口放宽 + 动作表登记 + UI**，落盘仍全部走 app-runtime 原子写。

---

## §S1 目标与非目标

### S1.1 目标

1. **四域动作三端平权（W-12）**：MCP add/edit/remove/reload、Skills install/uninstall/show/reload、Memory create/edit（markdown）/delete/pin/**import/export**、Plugins inventory/install/approve/enable/disable/uninstall 在 Web 可完成，语义与 CLI 子命令一致（`volund mcp|skill|memory|plugin(s)`）。
2. **Memory markdown 编辑体验**：新建 + 编辑弹窗内提供 markdown 编辑器（编辑/预览/分屏三模式 + 常用排版工具条 + tags 编辑），预览复用 `apps/web/src/components/Markdown.tsx`（react-markdown + remark-gfm，不渲染原始 HTML）。
3. **统一市场页签**：管理 Page 内新增「市场」，分 Plugins / Skills / MCP 三段；已装条目回标状态（installed / approval-required / enabled）；未配置索引时显示配置引导。
4. **复用而非重建**：安装/写入管线 100% 走既有方法（`McpPort.add`→`upsertMcpServerToml`、`SkillPort.install`→git clone→`SkillsRuntime.installFromDirectory`、memory service CRUD、plugins domain 市场链）；前端复用 SettingsPage 的字段组件族（Modal/键值对编辑/Popconfirm 模式）。
5. **热生效**：MCP reload 修复后 add/remove 即时进入运行会话；skills 装后自动 rescan（既有 `skillsPanelController.reload`）；plugins enable/disable/uninstall 本就热卸载；memory 经 `memory.onDidChange` 即时进提示词。

### S1.2 非目标

1. **不做签名信任根 / Catalog v2**：远程 HTTPS 插件安装继续 fail-closed；市场不内置官方插件源默认值（D-3）。
2. **不做 npm 注册表安装**：插件仍是 digest 校验文件束，不引入 npm/pnpm/bun install。
3. **不做 MCP OAuth 浏览器全流程**（MG-17 为可选项，默认裁剪）：`volund mcp login/logout` CLI 已满足 SKILLS-MCP-UI r1 §S3 边界。
4. **不改 memory 存储格式**：markdown 是编辑体验层，落盘仍是 `records.json` 快照的 JSON record（不落 `.md` 文件）；memory scope 切换（workspace/session）不做，维持 web 现有 project scope。
5. **不动安全模型**：loopback + cookie + CSRF 会话门、`plugins.market` 项目级覆盖禁令不变，本白皮书只做接线。

---

## §S2 现状基线与张力（code-verified 2026-09-18/19）

| 域 | Web 现有动作 | 后端已有能力（可直接接线） | 缺口 |
|---|---|---|---|
| MCP | list / inspect(未用) / setEnabled | `McpPort.add`（`:923`，**只写 TOML 不触碰活会话**）/ `remove`（`:948`）、OAuth login/logout、`[mcp] disabled` 持久写 | add/remove 表单；reload 不重读配置（`:373` 仅重连冻结 `#states`）；`McpPort` 无 `reload` 方法（端口新增）；**test/inspect 单例 close() 存量缺陷**（见 §S0，MG-04 一并修） |
| Skills | list / show(未用) / setEnabled | `SkillPort.install(spec,{scope})`（本地 dir \| git URL \| `github:owner/repo`，partial-failure 续装）/ `uninstall` / `show`；面板手动 rescan（`skills.ts:152`） | install/uninstall/reload 接线；SKILL.md 详情视图 |
| Memory | list / search / get / delete / pin / unpin | controller `update(id,patch,expectedUpdatedAt)`（`memory-controller.ts:47`）；service 层 create（CLI `memory add` 在用；`NewMemoryRecord.provenance` 必填，`memory-runtime.ts:63`）；export/import（`MemoryTransferService`，`volund.memory.export.v1`，16MiB cap，strategy/dry-run）；TUI 面板编辑模式（`packages/ui/src/components/MemoryPanel.tsx:175-232`，含 `memory_conflict`/`memory_scope_denied` 冲突处理） | controller 缺 `create`；web 动作表缺 create/update；import/export 未接；编辑器 UI |
| Plugins | list / domains / setDomain / availability（deny-only 硬编码 `available:false`） | domain 全套：`pluginInventory`（builtin/dev/market + registry，60s 缓存）/ `installMarketPlugin` / `approvePlugin` / `enablePlugin` / `disablePlugin` / `uninstallMarketPlugin`；`volund-market.json` digest 链 | `management.ts` 的 `PluginPortLike` 被收窄成 builtin 域 shim（`web.ts:139-146`）；无市场 UI；无权限 diff 视图 |
| 市场 | 无 | `[plugins] market` 索引链完整（索引 ≤1MiB / 256 条 / 64 文件 / 8MiB 单文件、同源下载、per-file sha256）；skill git 安装通道；`mcp.toml` 写入 | Skills/MCP 无索引概念；无浏览 UI |

**张力与取舍**：

1. **安装类动作耗时**（git clone、市场多文件下载，秒级）：web action 同步等待（caps 有上界，V1 可接受），前端 loading + 错误码透传；不做异步 job 系统（非目标，索引/文件 caps 已把最坏情况封顶）。
2. **approve 是安全关键步骤**：裸「批准」按钮不可接受——必须先渲染 manifest `permissions` 全量清单 + 与 `approvedPermissionHash` 对应版本的 diff，再带 hash 提交（对齐 TUI `/plugins approve <name> <permission-hash>` 语义）。
3. **MCP reload 缺口是后端修复而非 UI，且要害在 manager 拓扑**：活会话与 port 共享 `ensureMcpManager` 缓存的单例（`mcp-domain.ts:796`），配置装载只发生在 manager **构造期**——reload 修复必须是「域级重建」（重置单例 → 重跑 `loadMcpServerConfigs` → 对已 attach 的会话 registry 重挂工具，domain 须记录 attach 句柄），改 `McpManager.reload`（`:373`）本身无效。不修则 web/CLI 装完只能靠下次会话生效，市场体验不成立——列为批次 2 前置。**同批还须修 test/inspect 存量缺陷**（§S0）：两者复用共享单例后 `finally { close() }`，`close()` 置 `#closed=true` 永久断连且单例缓存不感知——一次性 CLI 进程无感，常驻 web-server 进程里 `mcp inspect` 一调即拆活会话连接（该动作现已注册可调，属现存 bug，可先行单独修复）。
4. **web 管理面权威即本机用户**：loopback 单用户 + CSRF 已是既定模型，管理动作不再叠加二次确认密钥；唯一例外是插件 approve（供应链语义，保留强确认）。

---

## §S3 契约

### S3.1 传输与安全总则

- 全部新动作登记进 `packages/web-server/src/index.ts` 的域动作表（POST + `X-Volund-Csrf` 既有门），不新增 REST 资源形态；`management.ts` 的 `*PortLike` 接口放宽至对应 port 方法签名，`web.ts` 接线透传 domain 方法。
- **零新写路径**：所有落盘经 app-runtime 既有原子写（mcp.toml / config.toml disabled 列表 / plugin-state.v2.json / records.json）；web-server 不直接碰文件系统。
- 市场索引 fetch 一律发生在 CLI 进程侧（复用 plugin-market 的 caps 机制），不经浏览器转发；错误码原样透传（`failFrom` 既有映射）。

### S3.2 memory 域（新增 create / update / export / import）

```
create  { content, tags?: string[], pinned?: boolean }        → MemoryPanelRecord   // provenance = { source: 'web' }（NewMemoryRecord.provenance 必填）
update  { id, content?, tags?, expectedUpdatedAt }            → MemoryPanelRecord   // 乐观并发冲突 = memory_conflict（memory-runtime.ts:131,594），
                                                                                        // 前端刷新重编辑（抄 TUI 行为；注意 memory_scope_denied 映射先例）
export  {}                                                    → volund.memory.export.v1 文档   // 浏览器侧存为文件下载；16MiB cap 沿用
import  { doc, strategy?: 'skip'|'overwrite'|'rename', dryRun? } → 导入回执             // 走 MemoryTransferService 既有管线
```

- `MemoryPanelController` 增 `create`（service 层 `memory.create` 已有，controller 补透传并构造 provenance）；`update` 已存在，仅登记动作表。
- 编辑器契约（**MarkdownMemoEditor**，web 新组件）：
  - 三模式：编辑 / 预览 / 分屏（窄屏折叠为切换）；预览复用 `Markdown.tsx`（含代码块复制，不渲染原始 HTML、图片降级占位——既有安全姿态保持）。
  - 工具条：粗体 / 斜体 / 行内代码 / 代码块 / 链接 / 列表 / 引用；等宽字体编辑区。
  - tags 编辑复用 SettingsPage `TagsField` 交互（Select mode="tags"）；pinned 开关；底部字数与 `updatedAt`。
  - 实现选型见 D-2（推荐：antd `Input.TextArea` + 自研分屏，**零新依赖**；monaco 单文件编辑列为 V2 升级路径——workbench 单例不可复用，另行实例成本高）。

### S3.3 mcp 域（新增 add / remove / reload；login/logout 可选）

```
add     { name, transport: 'stdio'|'http'|'sse'|'streamable-http',
          url?, headers?, command?, args?, env?, scope: 'user'|'project' }  → { file, items }
        // 同名 = upsert（编辑语义）；stdio/http 字段组互斥校验；secret 类 header 引导 keyref:// 录入
        // 动作层适配为 McpAddInput 判别联合（{kind:'stdio',command,args,env} | {kind:'http',url,headers,legacySse}，
        //   ports.ts:90；'sse'/'streamable-http' 字符串 ↔ legacySse 布尔在适配层换算）；
        //   McpPort.add 只写 TOML 不触碰活会话（返回 {file}），动作层串联 reload（硬依赖 MG-04）才对运行会话生效；
        //   表单支持粘贴 mcpServers JSON 预填（导入语义：逐条进表单、用户确认落盘，不静默批量写）
remove  { name, scope? }                                                  → { ok: true }
reload  {}                                                                → { items }   // 端口新增 McpPort.reload：域级重建（MG-04），返回新列表
login   { name }  /  logout { name }                                      // MG-17 可选：后端起 McpOAuthClient，
                                                                                        // 返回授权 URL 由 web 新标签打开，loopback 回程落 CLI 进程
```

- `add` 主体逻辑直接调 `McpPort.add`（`${VAR}` 展开 / keyref 语义由 domain 层既有实现承载，表单只做结构校验）。
- **reload = 端口新增方法（域级重建，MG-04）**：重置 manager 单例 → 重新 ensure（`ensureMcpManager` 内重跑 `loadMcpServerConfigs`，项目>用户合并、`.mcp.json` 只读导入维持）→ 重挂已 attach 的会话 registry；`McpManager.reload`（`:373`）保留「断开重连」原语义不动。TUI `/mcp` reload 同步受益。
- **前置存量修复（MG-04 内，可先行单独落地）**：`McpPort.test/inspect` 改用一次性 manager（不复用共享单例），消除 web 常驻进程内调用即拆活会话连接的缺陷。

### S3.4 skill 域（新增 install / uninstall / reload；接线 show）

```
install    { spec, scope?: 'user'|'project' }   → { items, failures }   // spec = 本地目录 | git URL | github:owner/repo | owner/repo
                                                                   // partial-failure 明细透出（既有续装语义）
uninstall  { name, scope? }                     → { ok: true }
reload     {}                                   → { items }        // 端口新增 SkillPort.reload：复用 skillsPanelController.reload 的域内同步闭包
                                                                   //   （skills.ts:152-159：skillsRuntimes 逐个 discover + registerIndex + 斜杠命令同步）
show       { name }                              → { body, frontmatter }   // 形状扩展：现行返回 { body }（无 UI 使用方，直接扩）；
                                                                   //   UI 接 Markdown 只读视图 + frontmatter 字段区
```

- 安装来源输入框同时接受本地路径（相对 cwd；可与 QuickOpenModal 联动选择）与 git 规格；安装完成自动触发 `reload`。

### S3.5 plugins 域（新增 inventory / install / approve / enable / disable / uninstall；保留 builtin 域开关）

```
inventory  {}                                        → PluginInventory   // builtin/dev/market 三源 + registry listings
                                                                        //   含 name/version/source/enabled/phase/permissionHash/approvedVersion
install    { name }                                  → PluginInstallResult   // loopback 索引可装；远程 HTTPS → plugin_registry_signature_required（UI 转译置灰+说明）
approve    { name, permissionHash }                  → PluginInventoryEntry  // 前置：UI 已渲染该 hash 对应权限清单
enable / disable / uninstall  { name }               → PluginInventoryEntry / { name }
inspect    { name }                                  → { manifest, files, integrity }   // volund-market.json + digest 重验结果只读视图
```

- **approve 交互不变量**：未展示权限清单前批准按钮不可用；清单含 `permissions {fs, bash, net, volund[], memory}` 全量（`PluginInventoryEntry.permissions` / `PluginInstallResult.permissions` 已携带）。**不做逐项 diff**——plugin-state.v2.json 只存 `approvedVersion`/`approvedPermissionHash`（plugin-state.ts:14-16），旧权限清单无数据源（升级安装即原子换目录，旧 manifest 不在盘上）；改为 `permissionHash ≠ approvedPermissionHash` 时高亮「权限较已批准版本已变更」，语义与 TUI `/plugins approve <name> <permission-hash>` 对齐。
- `web.ts` plugins shim 放宽为透传 plugins domain 既有方法（与 builtin volund-plugin-manager 走的 `volund.plugins.*` host services 同源，不复制逻辑）。

### S3.6 市场页签与索引契约

**布局**：管理 Page 第 6 个页签「市场」，内分 Plugins / Skills / MCP 三段（Tabs 或分段列表），条目卡片 = name / description / version / 来源标记 + 安装按钮。**已装回标分段**：Plugins 段 = installed / approval-required / enabled（plugin-state.v2.json 状态机）；Skills 段 = 仅「已装」（无安装回执——skill 没有 volund-market.json 等价物，**不做更新检测**，重装即覆盖更新）；MCP 段 = 「已配置」（按 mcp.toml 同名匹配）。

**Plugins 段**：读 `[plugins] market` 既有索引与 60s 缓存，安装链完全复用（§S3.5）。远程 HTTPS 条目可浏览，安装按钮置灰并注明「等待签名信任根（§19a）」。

**Skills 段（新索引）**：config 新键 `[skills] market = "<index-url>"`（**项目级覆盖禁止**，对齐 `plugins.market` 先例——供应链面项目不应能改）。索引 schema：

```jsonc
{ "version": 1, "updated": "…",
  "entries": [ { "name": "…", "description": "…", "version": "…", "source": "git-url|github:owner/repo", "homepage": "…" } ] }
```

- fetch/校验收进 `app-runtime/src/skill-market.ts`，复用 plugin-market 的 caps 机制（索引 ≤1MiB / 条目 ≤256）；`name` 过 skill 命名校验（`^[a-z0-9]([a-z0-9-]*[a-z0-9])?$` ≤64）。
- 安装 = `SkillPort.install(entry.source)`（git 通道既有）；**远程 skills 允许安装**——与 `volund skill install github:…` 风险面一致（skill = 提示词 + 资源文件，安装不执行代码；SKILLS-MCP-UI r1 §S1.2 只是把「skills.sh 集成」划出界，git 安装本就在界内）。

**MCP 段（新目录索引）**：config 新键 `[mcp] market = "<index-url>"`（同样项目级覆盖禁止）。schema：

```jsonc
{ "version": 1, "updated": "…",
  "entries": [ { "name": "…", "description": "…", "transport": "stdio|http", "url"?: "…", "command"?: "…", "args"?: […], "homepage": "…" } ] }
```

- 「安装」= **打开 §S3.3 add 表单并预填**（command/url/env 全文可见、用户确认后才落盘）——目录条目不静默安装（命令注入可见性原则）；env/headers 含 secret 的条目只预填 `keyref://` 占位。
- 两索引默认空 → 市场段显示配置引导（跳 settings 或展示 config 示例）。

### S3.7 安全不变量（回归红线）

1. 远程 HTTPS 插件安装 fail-closed 不变（负向测试保留）；市场不内置默认索引源。
2. install→approve→enable 三段状态机与 digest 校验链（下载期 per-file sha256 + 激活期重验）不变。
3. MCP 目录条目不静默落盘；secret 一律 keyref。
4. web 会话门（loopback + HttpOnly cookie + CSRF + CSP）不变；管理动作不再叠加密门，插件 approve 除外（强确认 + 权限展示前置）。
5. skill / mcp / memory / plugin 全部落盘仍走原子写与乐观并发，冲突不静默覆盖。

### S3.8 telemetry

按「新增事件类型清单」全量走 8 处同步点（含 3 个硬编码计数守卫）：`market_opened`、`market_install_{requested,ok,failed}`（kind=plugin|skill|mcp）、`memory_created/updated`、`mcp_{added,removed,reloaded}`、`skill_{installed,uninstalled}`、`plugin_{installed,approved,enabled,disabled,uninstalled}`；计数守卫同步更新。

---

## §S4 实现映射与任务卡

| 批次 | MG | 主题 | 落点 |
|---|---|---|---|
| 1 | MG-01~03 | Memory 编辑（含 markdown 编辑器） | web-server / app-runtime / apps/web |
| 2 | MG-04~06 | MCP 管理 + reload 后端修复 | app-runtime / web-server / apps/web |
| 3 | MG-07~09 | Skills 安装管理与详情视图 | web-server / apps/web |
| 4 | MG-10~12 | Plugins 全生命周期 + approve 权限 diff | web-server / apps/web |
| 5 | MG-13~16 | 市场页签（Plugins 复用 / Skills / MCP 目录）+ telemetry | shared / app-runtime / web-server / apps/web |
| 可选 | MG-17 | MCP OAuth web 触发 | auth / web-server / apps/web |

### MG-01 · memory create/update 接线
**契约**：§S3.2。`MemoryPanelController` 增 `create`（构造 provenance `{ source: 'web' }`——`NewMemoryRecord.provenance` 必填，memory-runtime.ts:63）；web-server memory 动作表登记 `create`/`update`。
**验收**：web 创建/编辑后 `records.json` 原子更新、`memory:pinned` 提示词片段失效重算；`expectedUpdatedAt` 冲突返回 `memory_conflict` 错误码。

### MG-02 · MarkdownMemoEditor 组件
**契约**：§S3.2 编辑器契约；预览走 `Markdown.tsx`。
**验收**：三模式切换、工具条插入正确、tags/pinned 编辑、窄屏降级；零新依赖（D-2 采纳自研分屏时）。

### MG-03 · Memory 面板升级
新建按钮 + 行内「编辑」动作接入 MG-01/02；空态引导创建；export（下载 `volund.memory.export.v1` 文档）/ import（上传 + strategy 选择 skip/overwrite/rename + dry-run 预览）入口。
**验收**：创建→列表即时出现；编辑冲突有可见提示并可重试；web 导出→清空→导入往返内容一致（dry-run 不落盘）。

### MG-04 · MCP 域级 reload + test/inspect 存量缺陷修复（后端，TUI 同步受益）
**契约**：§S3.3 reload。两个子项：
- **域级 reload（端口新增 `McpPort.reload`）**：重置缓存的 manager 单例（`mcp-domain.ts:796`）→ 重新 ensure（`ensureMcpManager` 内重跑 `loadMcpServerConfigs`，项目>用户合并、`.mcp.json` 只读导入维持）→ 对已 attach 的会话 registry 重挂工具——**domain 须记录 attach 句柄**（现重建即丢工具注册）。`McpManager.reload`（`:373`，遍历冻结 `#states`）保留「断开重连」原语义不动。
- **存量缺陷修复（可先行单独落地）**：`McpPort.test/inspect` 改用一次性 manager（不复用共享单例，正常 close）——现两者 `finally { manager.close() }`（`:880`/`:895`）会永久关闭活会话共享的 manager（`#closed=true` 且单例缓存不感知），web 常驻进程内 `mcp inspect` 一调即拆活会话连接，该动作现已注册可调，属现存 bug。
**验收**：运行中会话 `mcp add` 新 server 后 reload 即连、删除后工具注销；web 调用 inspect 后活会话连接无损（新增回归用例）；`.mcp.json` 只读导入语义不回归（pty 实测 TUI `/mcp` reload）。

### MG-05 · MCP add/remove 表单
**契约**：§S3.3 add/remove。transport 分支字段（stdio: command/args/env；http: url/headers + type）、scope 选择、键值对编辑器（抄 SettingsPage ProvidersEditor 模式）、secret 引导 keyref、**粘贴 mcpServers JSON 预填**（解析后逐条进表单，用户确认落盘）。
**验收**：与 `volund mcp add` 落盘等价（同 TOML 结构，含适配层 `'sse'`/`'streamable-http'` ↔ `legacySse` 换算）；同名 upsert 编辑语义；add 成功自动 reload（依赖 MG-04）。

### MG-06 · MCP 面板动作补齐
reload/重连按钮、inspect 详情视图（元数据 + 工具清单）接线、状态即时刷新。**前置依赖 MG-04 存量缺陷修复**（否则 inspect 入 UI 即接雷）。
**验收**：add→connected 全链路在 web 内闭环（stdio + http 两传输各测一例）；inspect 后既有会话连接与工具无损。

### MG-07 · skill install/uninstall 接线 + SkillPort.reload
**契约**：§S3.4。安装来源输入（路径/git/github 规格），partial-failure 明细展示；**端口新增 `SkillPort.reload`**（`SkillPort` 现无此方法，ports.ts:108-119——实现复用 `skillsPanelController.reload` 的域内同步闭包，skills.ts:152-159）。
**验收**：web 安装 git skill 落 `~/.volund/skills/`（或 project scope），自动 reload 后 `/skills` 三端一致；uninstall 拒绝 interop 源（错误透传）。

### MG-08 · SKILL.md 详情视图
show 动作接线：frontmatter 字段区 + 正文 Markdown 只读渲染 + 路径展示。
**验收**：与 TUI Enter 详情信息等价。

### MG-09 · skills 装后自动 rescan
安装/卸载后自动触发 reload——**依赖 MG-07 落地的 `SkillPort.reload`**（复用 `skillsPanelController.reload` 域内同步闭包，非纯前端串联：`SkillPort.install` 用的是一次性 `listingSkillsRuntime`，写盘后活会话的 skillsRuntimes 不会自动重发现）。
**验收**：装完即可在会话内斜杠命令调用。

### MG-10 · plugins 域动作扩展
**契约**：§S3.5。`management.ts` `PluginPortLike` 放宽 + `web.ts` 接线 domain 既有方法。
**验收**：动作表与 domain 方法一一对应；无逻辑复制（domain 单一实现）。

### MG-11 · Plugins 面板升级（三源 inventory）
builtin / dev / market 三分组 + phase 徽标（loaded/enabled/approved/installed·approval-required）+ 市场条目区；保留 builtin 域开关。
**验收**：与 TUI `/plugins` tabs 信息等价；状态机变更后徽标即时。

### MG-12 · approve 权限清单视图 + 生命周期动作
install（含远程置灰转译）/ approve（权限清单 + hash 变更高亮前置，见 §S3.5——不做逐项 diff）/ enable / disable / uninstall（Popconfirm）。
**验收**：未展示权限时批准不可用；`permissionHash ≠ approvedPermissionHash` 时高亮「权限已变更」；远程 HTTPS 安装仍拒绝且 UI 说明解锁条件；digest 校验链无改动。

### MG-13 · 市场页签骨架
**契约**：§S3.6 布局；索引未配置时的引导态；已装回标**分段**（Plugins = installed/approval-required/enabled；Skills = 仅已装；MCP = 已配置）。
**验收**：管理 Page 第 6 页签；三段结构；各段回标语义正确（skill 段无更新检测）。

### MG-14 · Skills 市场索引
**契约**：§S3.6 Skills 段（`[skills] market` 新键 + `skill-market.ts` caps 复用）。
**验收**：索引解析/命名校验/caps 生效；安装走 git 通道；项目级覆盖禁止（config 负向测试）。

### MG-15 · MCP 目录
**契约**：§S3.6 MCP 段（`[mcp] market` 新键 + 预填表单安装）。
**验收**：目录条目预填 add 表单、确认落盘、secret 只预填 keyref 占位。

### MG-16 · telemetry 事件
**契约**：§S3.8。
**验收**：事件清单 8 处同步点全过、计数守卫更新、面板 events 表可见。

### MG-17 ·（可选）MCP OAuth web 触发
**契约**：§S3.3 login/logout；授权 URL 转交浏览器新标签、loopback 回程落 CLI 进程、成功后自动 reload。
**验收**：needs-auth server 全 web 流程完成认证（默认裁剪，等 D-4）。

---

## §S5 验收清单（DoD）

1. **三端平权抽查（W-12）**：`mcp add/remove`、`skill install/uninstall`、`memory create/update/import/export`、`plugin install/approve/enable` 在 CLI/TUI/Web 均可完成且落盘一致。
2. **供应链门回归**：远程 HTTPS 插件安装仍 fail-closed（负向用例）；approve 无权限展示不可点；skill/mcp 市场索引项目级覆盖被拒。
2a. **存量缺陷回归**：web 调用 `mcp inspect/test` 后活会话 MCP 连接与工具无损（MG-04）。
3. **浏览器冒烟（CDP/cua 配方）**：四域 + 市场页签全动作 e2e；错误码在 UI 可见（不吞）。
4. **pty 实测**：MG-04 reload 修复后 TUI `/mcp` reload 行为不回归。
5. **门禁**：`TURBO_FORCE=true pnpm test` 全绿 + typecheck/format/fence；改动 `packages/*` 后先 `pnpm build` 再验下游（dist 解析坑）。
6. **spec 同步**：`22-web-console.md` W-12 状态、`PLUGIN-MANAGER-r1.md` 状态行、`SKILLS-MCP-UI-r1.md` 偏差清单按落地情况更新。

---

## §S6 开放问题 / 决策点

| # | 问题 | 选项 | 建议 |
|---|---|---|---|
| D-1 | 远程 HTTPS 插件安装是否随本期放宽 | a) 维持 fail-closed 等签名信任根（§19a/CAT 线） b) 本期先允许显式「我信任」覆盖 | **a**：与 PLUGIN-MANAGER r1 决策一致，市场远程条目浏览+置灰已能满足「有市场」诉求 |
| D-2 | markdown 编辑器实现 | a) 自研轻量分屏（TextArea + Markdown.tsx，零依赖） b) 引入 `@uiw/react-md-editor` 类库 c) monaco 单文件编辑器 | **a**：memory 编辑是低频动作，零依赖与既有安全姿态（不渲染原始 HTML）最优；c 留 V2 |
| D-3 | skills/MCP 市场索引是否内置官方默认源 | a) 纯用户配置 b) 随版本内置默认 URL | **a** 先行（供应链面最小承诺）；b 待有官方托管后再议 |
| D-4 | MG-17（MCP OAuth web 触发）是否进一期 | a) 裁剪（CLI 已覆盖） b) 进一期 | **a**：低频 + 涉浏览器跳转链路，市场/管理主线不受影响 |
