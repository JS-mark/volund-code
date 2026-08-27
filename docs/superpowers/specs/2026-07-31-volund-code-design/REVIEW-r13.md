> ↩ [返回索引 (README)](./README.md) · ← [上一轮: REVIEW-r12](./REVIEW-r12.md)

---

# REVIEW r13 · 功能设计完整评审（Functional Design Review）

- **审查对象**：功能设计本身——§1–§15 + 两份白皮书所定义的**产品能力与契约**的完备性、可实现性、体验闭环。
- **审查日期**：2026-08-16
- **文档定位**：**修正功能的设计文档**——每个发现附可直接落地到 spec 的修正设计（改哪节、加什么内容）；按文件分组的修正任务清单在文末，可作为下一轮 spec 修正的执行蓝本。
- **与既有各轮的关系**（本轮不重复它们的工作）：
  - r6–r10 审"设计自洽与范式"（契约安全 / 运行时安全 / 一致性 / 范围 / AI-native 范式）——已清
  - r11–r12 审"文档说的是不是真的"（spec vs 实现）——已出整改方案
  - **本轮审"设计还缺什么"**：假设实现完全忠实于 spec，用户仍会在哪里失望？AI 实现者仍会在哪里卡住？实现中已出现的"spec 未定义、被迫自行决定"的点（r11/r12 审计的 D 类发现），是设计缺口最直接的实证——本报告将其全部收编为设计层修正项。

**严重度**：P0 = 安全设计洞或阻塞核心流程，必须先修 spec；P1 = 核心功能缺口 / 实现必需契约缺失；P2 = 改进；P3 = 记录。

---

## 发现总表

| ID | 严重度 | 发现 | 修正去向 |
|---|---|---|---|
| I10 | **P0** | 拦截型 hook 超时语义 fail-open（安全洞） | §2.6 分域超时 |
| P1 | **P0** | native 探测的启动时序未定义（冷启动可被阻塞） | §5.8 启动时序契约 |
| G1 | P1 | code review 功能整体缺失（第三大核心场景） | 新增 §16（附录 A 草案） |
| G2 | P1 | Bash 无后台任务（长命令场景设计缺席） | §4.3 + 新工具 |
| I1 | P1 | tool_use 流式聚合规则未定义 | §3.2 |
| I2 | P1 | PermissionSpec glob 方言未定义（权限匹配不能有歧义） | §4.4 |
| J3 | P1 | Edit 工具契约不完整（唯一性/replaceAll/并发） | §4.3 |
| I5 | P1 | 测试基建无设计（testkit） | 新 §6.13 |
| G3 | P2 | 自定义 subagent（agentType）定义格式缺失 | §2.7.1 |
| G5 | P2 | max_tokens 截断后续写体验未设计 | §2.4 B7 |
| G6 | P2 | L1 DoD"提 PR"的 gh 依赖未显式化 | §10/§4.4/§11.3.10 |
| I3 | P2 | 错误码无集中登记表 | shared + 附录 B |
| I4 | P2 | config.toml 无全量 schema 与未知 key 策略 | §8.3 + 附录 C |
| I6 | P2 | IPC 单消息尺寸上限未定义 | §5.6.2 |
| I8 | P2 | 事件 payload 无 per-event schema | §2.3 + 附录 D |
| I11 | P2 | Bash shell 选择与 env 继承未定义 | §4.3 |
| P3 | P2 | `@` picker 大仓库扫描性能未设计 | §7.5.3 |
| G4 | P2 | 会话级 checkpoint/rewind 边界未声明（预期管理） | §8.6 末尾 |
| D1 | P2 | 十余个"实现被迫自定"的契约空白集中收编（快照事件/合成 tool_use id/origin 归一/Read 行数等） | 各章 + 附录 E |
| T2 | P2 | e2e smoke 自动化无设计 | §9.4 |
| P2/P5 | P3 | 内存/延迟等量化性能预算缺失 | 新 §9.10 |
| T4 | P3 | 性能回归测试缺失 | §9.4 |
| S1/S2 | P3 | npm org 抢注 / provenance / NOTICE 未排期 | §9.5 |

---

## 第一部分 · 功能完备性评审（G 系列）

> 对标方法：以 claude-code 实际能力清单为基线逐项核对 spec 覆盖。已有能力（对话流式/工具/子 agent/权限/MCP/slash/@ 引用/图片粘贴/resume/compact/hooks/memory/skills/todo/WebFetch/--json 等）spec 均有设计且质量高，不再列举；下表只列**缺口**。

| claude-code 能力 | volund spec 现状 | 判定 |
|---|---|---|
| **/review（代码审查）** | 仅 §13.2 cookbook 列了页面标题，无任何功能设计 | ❌ G1 |
| **后台 Bash + 输出获取** | Bash 同步阻塞 + 60s 超时 | ❌ G2 |
| **自定义 agent 定义文件**（.claude/agents/*.md） | §2.7 `agentType: user-defined` 一笔带过，无格式无装载 | ❌ G3 |
| **checkpoint/rewind（对话+文件整体回退）** | 仅文件级 backup + `/undo` 单步 | ⚠️ G4（需声明边界） |
| **max_tokens 截断续写提示** | StopReason 有 max_tokens，主循环无处理分支 | ⚠️ G5 |
| PR 创建 | 无工具设计（隐含 Bash+gh） | ⚠️ G6（显式化即可） |
| /init 生成 AGENT.md | §14.4 L2 | ✅ |
| thinking 展开/收起、成本显示、模型动态列表 | §7/§3 已有 | ✅ |

### G1（P1）· code review 功能整体缺失

**问题**：AI 编码工具三大高频场景——**写代码 / 改代码 / 审代码**——审代码在 spec 里没有任何功能设计：无 CLI 入口、无数据模型、无流程、无输出格式、无 CI 门禁语义。§3.8.3 RoleRouter 甚至预留了 `reviewer` 角色，却没有任何功能消费它；§13.2 cookbook 的 `code-review-workflow` 页面上线即空文；`--json` 模式最大的价值场景（CI gate）因此缺杀手用例。

**修正设计**：新增 **§16 Code Review 功能**，完整章节草案见[附录 A](#附录-a--16-code-review-功能设计草案)。核心设计决策：

```
入口：volund review [--base <ref>|--staged|--pr <n>|--range] + REPL /review + --severity-gate
数据：ReviewFinding { severity(blocker|warning|info|nit), file, line, category,
      message, suggestion, confidence }（zod 校验，机器可读）
流程：diff 收集（只读）→ 大 PR 按 file 分片（L3 起子 agent 并行）→ reviewer 角色分析
      → 结构化输出 → TUI 分级渲染 / NDJSON / exit code（blocker>0 → exit 4）
安全：diff 与 PR 描述全部 <untrusted> 包裹（被审内容是最高危注入源）；全程只读 auto-allow
里程碑：L2 基础 local review / L3 PR 模式 + 分片 / L4 CI gate 模板
```

### G2（P1）· Bash 无后台任务能力

**问题**：Bash 是同步阻塞 + `timeoutMs ?? 60s`。真实工作流中 `npm install`（1-5min）、`cargo build`（首次 10min+）、`npm test -- --watch`、`pnpm dev` 天然长时——当前设计下要么超时被 abort，要么用户被迫调大超时干等。L1 DoD"完成真实编码任务（改文件 + **跑测试** + 提 PR）"直接受阻。

**修正设计**：§4.3 Bash 行扩展 + 两个配套工具 + 两个事件（17→19）：

```ts
// Bash inputSchema 增可选字段
{ command: string, timeoutMs?: number, runInBackground?: boolean }
  // true → 立即返回 { shellId }，不阻塞 turn

// 新工具（L1 随 Bash 交付）
ShellOutput { shellId, action: 'view'|'wait' }   // 查看输出 / 等待完成（可带 timeout）
KillShell   { shellId }                          // 终止后台任务
```

配套契约：
- **生命周期**：后台 shell **跨 turn 存活**；session 结束（`session.ended`）统一 kill——强制点："session.ended 必须 kill 全部后台 shell（单测）"
- **输出缓冲**：stdout/stderr 环形 buffer 上限 10MB，超限丢头部 + 截断标注
- **沙箱**：与前台 Bash 同 profile（cwd 读写白名单）；abort 语义只在 kill 时生效
- **新事件**：`shell.background_started` / `shell.background_exited`（§2.3 表 +2）
- **UI**：TopBar 后台任务计数；`/shells` slash 命令列出（§11.4 +1）
- **权限**：弹窗文案加"（后台运行）"标注，不进静默白名单

### G3（P2）· 自定义 subagent 定义格式缺失

**问题**：§2.7 `agentType: user-defined` 无处落地——文件放哪、什么格式、Task 工具如何发现、system prompt 如何注入，全部空白。这是生态价值很高的能力（社区分享 agent 定义）。

**修正设计**：§2.7 补 2.7.1：

```
定义文件（两层，项目覆盖全局同名）：
  ~/.volund/agents/<name>.md  +  <cwd>/.volund/agents/<name>.md

frontmatter（zod，schema 放 packages/shared/agent-schema.ts）：
  name（唯一 [a-z0-9-]）/ description / model?{provider,model}（缺省继承父）
  tools?[]（白名单，只能收紧不能放宽）/ maxTurns?

正文 = 该 agent 的 system prompt：
  - 走 PromptComposer 独立槽位（priority=800，与 skill 同级；@include 可用）
  - 项目级 agent 文件属 untrusted 来源（仓库作者可控）→ 正文先包
    <untrusted source="agent-def:<path>"> 再作 prompt 基础；发现注入指令 UI 红条
装载：冷启动扫 frontmatter（复用 §6.5.3 progressive disclosure 三阶段）
Task 校验：inputSchema 的 agentType 枚举 = 内置 + 已扫描定义
里程碑：L3（随 subagent/Task）
```

### G4（P2）· 会话级 checkpoint/rewind 边界未声明

**问题**：现有"后悔药"= 文件级 backup + `/undo` 单步。用户对"回到 10 分钟前状态（对话+文件）"的预期没有管理——spec 既没设计也没声明不做。

**修正设计**：§8.6 末尾追加边界声明（不需要 v1 实现，但必须显式）：

> **v1 边界声明**：v1 回退 = 文件级 backup（session 隔离）+ `/undo` 单步 tool 回退（补注：撤销对象 = 最近一次有 backup 的副作用 tool，按 backup 目录时间序取最新）。**不提供**会话级时间旅行。**v2 占位**：`/checkpoint`（记录 SessionState.version + 文件增量快照）+ `/rewind <checkpoint>`（JSONL 逻辑截断 + 文件恢复），另立 RFC。

### G5（P2）· max_tokens 截断后续写体验未设计

**问题**：长回复被截断时 turn 正常结束，用户拿到半截内容，无提示无续写路径。

**修正设计**：§2.4 说明区追加 B7：

```
B7（截断续写）：stopReason === 'max_tokens' 时——
  1. UI 在截断消息尾部渲染 "[truncated: max_tokens reached]" + 提示"输入 continue 可继续"
  2. 用户输入 continue → 走正常 sendUserMessage；Runner 复用 sticky provider
     （防换 provider 导致风格断裂）
  3. 不自动续写循环（防失控烧钱）：只提示，不自动重发
强制点：ui 单元测试（截断标记渲染）；core 单元测试（B7 路径不新建 turn 语义）
```

### G6（P2）· L1 DoD"提 PR"的 gh 依赖显式化

**问题**：spec 无 PR 创建工具，实际路径是 Bash + `gh` CLI——DoD 没说依赖 gh；auto-allow 没说 gh 怎么处理；doctor 不检测。

**修正设计**（三处小改）：
1. §10 L1 DoD 补注："提 PR 经 Bash + `gh` CLI（用户环境需预装；CONTRIBUTING 已列推荐依赖）"
2. §4.4 auto-allow 规则补一行：`gh pr create/view/checks` → **不进静默白名单**（有外发语义，走弹窗），文案明示
3. §11.3.10 doctor L1 段补：`✓ gh CLI: 2.x (path)`（缺失 ⚠️ 不 fail，提示"PR 工作流需要"）

---

## 第二部分 · 可实现性评审（I 系列）

> 审查标准：§12.6b 说"spec 是 AI 的可执行契约"。逐节模拟"AI 实现者视角"：拿到 spec 能否不回头问人就写出正确代码？**每个盲点都已被实现轨迹证实**——r11/r12 审计的 D 类发现显示，实现者在这些位置被迫自行决定（且各自不同），这就是契约缺失的代价。

### I10（P0）· 拦截型 hook 超时语义是 fail-open（安全设计洞）

**位置**：§2.6"拦截型 hook 必须同步或短异步返回，超时 5 秒视为失败并跳过"。

**问题**："超时跳过"对拦截型 hook（preToolUse/prePrompt/preProviderCall/postToolUse/stop）= hook 卡住 → **不拦截 → tool 照跑**。对 plugin 域可接受（可用性优先），但对 builtin 域安全 hook（memory 脱敏 priority=1000、注入扫描）是可主动利用的旁路：恶意 payload 只需让扫描器卡 5 秒，脱敏即被跳过。

**修正设计**：§2.6 执行语义改分域：

```
hook 超时分域语义：
  - builtin 域（900–1000，安全 hook）：超时 5s → fail-closed——视为 veto，阻断当前
    操作，emit error.raised { code: 'builtin_hook_timeout' } + UI 红条
    "安全检查超时，操作已阻断（可重试）"
  - project / plugin / user 域：超时 5s → fail-open（跳过该 handler 继续 pipeline）
  - 防"喂爆扫描器"：安全 hook 收到的 payload 先过尺寸闸（>1MB 截断后扫描，
    超限部分记 telemetry）
强制点：core 单测（builtin hook 卡 6s → tool 被阻断；plugin hook 卡 6s → 放行+warning）
```

### I1（P1）· tool_use 流式聚合规则未定义

**位置**：§3.2 关键约定仅一句"tool_use.end 时一次性 JSON.parse"。

**问题**：多 tool_use 交错流式时按什么聚合？parse 失败的 tool_result 错误格式？能否部分校验？——实现已被迫自定（且出现了"parse 失败的 tool_use 仍会执行"的歧义解法）。

**修正设计**：§3.2 追加聚合规则（v1 钉死）：

```
1. Runner 维护 Map<toolUseId, string[]>；delta 按 id 追加；end 时合并全文一次 parse
2. parse 失败 → 构造 tool_result：isError + "Invalid JSON arguments for tool <name>
   (stream truncated?): <first 200 chars>..."（截断附原文供模型自纠）
   ★ 失败的 tool_use 不执行、直接以该 error tool_result 返模型
3. v1 不做流式部分校验
4. message.interrupted 到达时所有未 end 的 entry 作废（引用 §3.9a）
强制点：core 单测（双 tool_use 交错 + 破损 JSON 用例；断言破损 tool 不执行）
```

### I2（P1）· PermissionSpec glob 方言未定义

**位置**：§4.4 `fs.read/write?: string[] // 具体路径或 glob`。

**问题**："glob" 无方言 = 权限匹配歧义：`**` 跨不跨分隔符？大小写？`~/` 展开否？symlink？**权限系统的模式匹配不能有歧义**。实现轨迹已证实危害：permission 层把 glob 当字面路径处理，而 Glob 工具另有一套自写翻译——同一个仓库两种 glob 语义。

**修正设计**：§4.4 补"路径模式语义"小节：

```
1. 实现库钉死：picomatch（与 fast-glob 同源，依赖树内已有）
2. ** 跨目录分隔符（globstar=true）；大小写敏感（保守方向：宁可多弹窗）
3. 匹配前双方 canonicalize 到绝对路径 + 展开 ~；被检路径 realpath（防 symlink 绕过）
4. 相对模式相对 cwd 解析；无前导锚点不支持（v1）
5. 否定模式 ! 不支持（deny 走 permissions.toml 黑名单，不混入 spec）
强制点：permission 单测（大小写/双星/symlink/字面-vs-glob 用例）
```

### J3（P1）· Edit 工具契约不完整

**位置**：§4.3 Edit 行仅"精确字符串替换"。

**问题**：Edit 是最高频写工具，但唯一性语义、replaceAll、失败错误格式、并发保护全部未定义。实现被迫自定（且选择合理），但这是契约不是巧合。

**修正设计**：§4.3 Edit 行展开为完整契约：

```
inputSchema: { path, old_string, new_string, replace_all?: boolean }
- old_string 须唯一（replace_all 缺省 false）；多处命中 → isError 提示提供更长上下文
- 不存在 → isError "old_string not found in <path> (file may have changed; re-Read)"
- new == old → isError（no-op 拒绝）
- 并发保护双闸：写入前 lockfile（<path>.volundlock，重试 3×1s，失败明确报错含 pid）
  + 成功后自动 backup（§8.6）
- Edit 前后各 Read 一次校验文件未变（mtime/size 快照），变了 → isError 提示重读
强制点：tools 单测（多命中/不存在/no-op/锁冲突四用例）
```

### I5（P1）· 测试基建无设计

**问题**：spec 有约 150 个"单元测试"强制点，但**测试怎么写没有基础设施设计**：mock provider（可编程假 chunk 流：正常/中断/交错/多 usage）、fake 时钟（hook 5s/退避测试）、隔离环境 fixture（临时 HOME/假凭据结构）、UI 测试选型。AI-native 范式下这是高杠杆缺失——没有 testkit，每个测试从零造假数据，质量必然参差。

**修正设计**：新 §6.13 测试基建（或并入 §6.7 差量）：

```
packages/testkit（dev-only）：
  1. MockProvider implements ProviderClient——scriptChunks([...]) 声明式脚本 +
     故障注入（interruptAt(n) / errorAfter(n) / duplicateUsage）
  2. fakeClock（vitest fake timers 封装）
  3. tempvolundHome()：每测试隔离 HOME + 预填 config/credentials
  4. sessionFixture(id)：预构造 JSONL（合法/截断/未来版本 v）
  5. ink-testing-library 选型：组件 snapshot
  6. nativeStub：native-bridge 内存假实现（available.* 可编程）
依赖归属：testkit → provider-kit + core[type-only] + shared（不破坏 §1.2 边界）
里程碑：L1 首批与 core 同 PR（测试先行）
```

### I3（P2）· 错误码无集中登记表

**问题**：error.raised 的 code 散落 10+ 处（tool_loop_exhausted / stream_interrupted / provider_sticky_violation / subagent_budget_exhausted / ...），无 registry。错误码是跨模块契约（core emit → ui 渲染 → telemetry 分类 → 用户 grep），散落必漂移——实现轨迹已出现 spec 外新码（stream_resume_unsafe_partial_tool_use 等）。

**修正设计**：`packages/shared/error-codes.ts` 集中 const registry + ESLint 禁裸字符串 code；spec 附录 B 全量登记表（code / 来源章节 / 触发条件 / UI 期望 / 可否重试）；新增码不进表 → CI fail。

### I4（P2）· config.toml 无全量 schema 与未知 key 策略

**问题**：配置 key 分散 7+ 章（[context]/[memory]/[evolution]/[sandbox]/[router]/[subagent]/[prompt]/[telemetry]），无汇总示例；**未知 key 是报错还是忽略未定义**（实现已被迫静默收下——打错段名的配置静默失效）。

**修正设计**：§8.3 补策略 + 附录 C 全量示例：
- 未知 key：**warn + 忽略**（顶层与已知 section 内；向前兼容）；已知 section 内类型错 → 启动 fail
- 附录 C 作为 zod schema 与文档的唯一真相源，各章片段加"以附录 C 为准"

### I6（P2）· IPC 单消息尺寸上限未定义

**问题**：NDJSON 行式协议无单行上限 = 无界内存（一行 2GB JSON 可 OOM 主进程）。分片仅 attachment 有。

**修正设计**：§5.6.2 补：`max_line_bytes = 4MB`（可配），超限 → 该 RPC 返 -32600 + telemetry `ipc.line_too_large`；逐行读取用带上限 readline；大于 4MB 的入参 API 必须走分片子协议。强制点：ipc 单测（5MB 单行 → 拒绝且通道存活）。

### I8（P2）· 事件 payload 无 per-event schema

**问题**：§2.3 有事件表（时机/订阅者）无 payload 字段。replay、迁移、`--json` 外部消费都依赖稳定 payload——实现已出现 payload 形状漂移（delta 塞整 chunk、snapshot 自创）。

**修正设计**：packages/shared/events/ per-event zod schema + spec 附录 D 字段表（字段/类型/必选/来源章节）；`--json` 文档直接引用；新增事件无 schema → CI fail。

### I11（P2）· Bash shell 选择与 env 继承未定义

**问题**：command 用什么 shell 解释（/bin/sh？bash？$SHELL？）影响跨平台一致性、sandbox exec 白名单、PATH 解析——spec 未定，实现选了 /bin/sh。

**修正设计**：§4.3 补执行语义：

```
- Unix：/bin/bash -c（固定，不读 $SHELL——避免 rc 副作用与跨机不确定性）
- Windows：powershell 7+ 若在否则 cmd；config [tools] windows_shell 可配
- sandbox exec 白名单含所选 shell；shell 内命令受 fs/net 策略约束（syscall 层正交）
- env 继承最小集（PATH/HOME/LANG/TZ + 显式白名单），非全量
强制点：tools 单测（管道/变量展开/env 最小集断言）
```

### D1（P2）· "实现被迫自定"的契约空白集中收编

r11/r12 审计的 D 类发现证明了一批 spec 盲点。全部收编为正式契约（逐条落回各章，汇总登记进附录 E）：

| # | 空白点 | 应落的契约 |
|---|---|---|
| 1 | 会话快照事件（实现自创 `session.snapshot` 每 turn 全量落盘） | §8.2 二选一：契约化（登记事件表 + 单行上限 + 写入频率 + 迁移语义）或坚持事件重放并补实现要求 |
| 2 | subagent 事件冒泡的重发语义（重发换 id 对去重/重放的影响） | §2.7 补：冒泡事件保留原 event.id + 加 parent tag（幂等的关键） |
| 3 | gemini/ollama 合成 tool_use id 的合法性 | §3.7.1 补注：合成 id（`gemini-call-N`）turn 内唯一即可，不跨 provider 复用 |
| 4 | net 权限 key 按 origin 归一（同域不同路径共享 allow-session） | §4.4 补注：net 匹配粒度 = origin |
| 5 | Read 默认 2000 行 / walk 跳过 .git+node_modules | §4.3 Read 行补默认值与忽略规则 |
| 6 | 非 TTY 下 confirm/prompt 的降级语义 | §6.4.1 补：非交互 confirm → 默认 deny（fail-closed）；prompt → null |
| 7 | `--json` 模式的错误输出协议 | §7.6 补：错误时输出 `{type:'error', code, category}` + `{type:'final', exitCode}` 两行结构 |
| 8 | 子 agent 权限降级规则（depth>0 只放行 once/session/deny） | §2.7 W8 补：降级档位枚举 |
| 9 | subagent 并发上限 | §2.7 补：同 turn Task 并发默认 4（可配） |
| 10 | budget 对顶层 Runner 是否生效 + toolCallMax 第四维度 | §2.7 补：budget 默认仅 subagent；顶层可选配置；维度三或四（定一个） |
| 11 | token 估算缓存生命周期（per-policy 实例内） | §8b.3 补：缓存 per-policy 实例，dispose 即清 |
| 12 | probe features 键名三平台不一致 | §5.3.3 补统一键名契约（landlock_abi/seccomp/namespaces/sandbox_init/appcontainer/wfp，缺失键省略） |
| 13 | sandbox 二进制的调用形态（一次性 stdin/stdout，非 JSON-RPC） | §5.6.2 修正：sandbox.* 前缀描述删除，注明 sandbox 为一次性进程协议；search/fs 为常驻 NDJSON JSON-RPC |
| 14 | ExecRequest 缺 exec/limits 段（syscall 名单无输入位） | §5.3.1 输入 schema 补 exec 白名单 + limits（rlimit）段 |
| 15 | Windows 插件宿主 IPC（--bridge-pipe） | §5.3.2 已有设计，补 L2 落地要求（当前仅 Unix fd3） |
| 16 | streamResume capability（实现自加的防误用护栏） | §3.9a 规则 5 补：v1 显式拒绝 offset 式 resume（fail-fast 护栏入契约） |
| 17 | Ollama 远程明文审批门（实现自加的好设计） | §14.2 Ollama 分支补：非 loopback endpoint 强制显式确认 + telemetry |
| 18 | resolver 四级链（env > bundled > download > cache） | §5.8 补二进制来源优先级契约（若分发换轨经 BDFL 认定，同步重写 §5.9） |
| 19 | DCO 对 AI/bot 提交者的署名归属 | §12.2 补：bot 提交豁免 sign-off；AI 辅助提交由指令人类签署 |
| 20 | 手写 reference 与 CLI 定义的漂移检测 | §13.6 补：过渡期强制 verify 脚本 diff 命令/flag 清单 |

---

## 第三部分 · 端到端用户旅程评审（J 系列）

十条核心旅程核对（纯设计视角——spec 是否定义了完整体验）：

| 旅程 | 判定 | 缺口 |
|---|---|---|
| 安装 → onboarding → 首任务 | ✅ §14 完整 | — |
| 长会话 → compact → 继续 | ✅ §8b + /context | — |
| 崩溃/断电 → resume | ✅ §8.2 | — |
| 改错文件 → 撤销 | ⚠️ | `/undo` 只有一句"撤销最后一次 tool 执行（若有 backup）"——选点规则/多步/失败提示未定义（并入 G4 修正） |
| 升级 volund → 旧 session 兼容 | ✅ §8.2 迁移 | — |
| 插件升级 → 权限变化 | ✅ §6.11.5 | — |
| CI/脚本使用 | ⚠️ | `--json` ✅；缺 CI 杀手场景 → G1 review gate；**`--json` 的错误输出协议未定义** → D1-7 |
| 多实例并发 | ✅ §8.6.1 | — |
| 恶意仓库打开 | ✅ §8.3.1 | — |
| **长命令跑测试/安装** | ❌ | **G2** |

**结论**：旅程层无新增系统性缺口；两处 ⚠️ 均已并入 G1/G2/G4/D1 修正。

---

## 第四部分 · 性能与资源预算评审（P 系列）

**总判定**：spec 在功能正确性上密度极高，但**几乎无量化性能预算**——AI 实现会以"能跑"为标准，性能劣化无验收线。且已有一处设计未定义时序导致实现把冷启动阻塞（证明这不是杞人忧天）。

### P1（P0）· native 探测的启动时序未定义

**位置**：§5.8"available 探测（启动时一次）"——串行还是并行？阻塞 REPL 吗？

**问题**：sandbox --probe 5s + search/fs 握手 5s，若串行等待最坏 +15s 才见输入符；首次运行还可能触发二进制下载。spec 没写时序，等于把"启动是否卡"交给实现掷骰子。

**修正设计**：§5.8 补启动时序契约：

```
1. probe 与 worker 握手全部并行发起（Promise.allSettled），互不等待
2. REPL 就绪不等探测：UI 先起，探测结果异步回填（available.* 初始 'probing'）
3. 探测未完成期间：副作用工具被调用 → await 对应探测（带剩余超时）；只读工具不等待
4. tier 冻结起点 = 探测完成时刻（§5.5 冻结约束不变）
5. 首次运行的二进制下载必须显示进度且可 Ctrl+C 跳过（降级提示）
强制点：集成测试（探测 stub 挂 5s，assert REPL 100ms 内可用）
```

### P2/P3/P5（P2/P3）· 量化预算表缺失

**修正设计**：新 §9.10 性能预算表（超标 = 性能 bug）：

| 指标 | 预算 | 测量 |
|---|---|---|
| 冷启动（输入符可见，无探测等待） | ≤ 500ms | CI 计时 |
| 热启动（resume tailTurns=20，50MB JSONL） | ≤ 2s | CI fixture |
| 主进程 RSS 基线（无插件/worker） | ≤ 300MB | CI 采样 |
| 单 worker（search/fs）RSS | ≤ 150MB | idle 回收兜底 |
| `@` picker 首帧（大仓库） | ≤ 150ms | 见 P3 |
| provider 首 token 框架开销（网络除外） | ≤ 300ms | mock 计时 |

### P3（P2）· `@` picker 文件候选扫描未设计

**问题**：monorepo 十万文件时每次键入 `@` 全量 walk 不可行。

**修正设计**：§7.5.3 补性能策略：

```
1. 候选源 = git ls-files 输出缓存（非 git 目录 fallback fast-glob 一次遍历）
2. 缓存失效：60s TTL + picker 内 R 手动刷新 + 目录 mtime 抖动检测
3. fuzzy 评分纯内存（fzf 风格）≤10ms；首帧先显示已就绪子集，后台补全
强制点：ui 单测（10 万文件名 fixture 过滤 <150ms）
```

---

## 第五部分 · 测试基建评审（T 系列）

| 检查项 | 判定 | 归宿 |
|---|---|---|
| 单元测试强制点 ~150 条 | ✅ 覆盖全 | — |
| sandbox escape CI | ✅ §9.4 完整 | — |
| provider mock / fake 时钟 / fixture | ❌ 无设计 | **I5**（第二部分） |
| e2e 自动化 smoke | ❌ DoD 全靠手动 dog-fooding | **T2** |
| 性能回归 | ❌ | **T4**（并入 §9.10 预算表） |

### T2（P2）· e2e smoke 无自动化设计

**修正设计**：§9.4 补 `e2e` job（L1 起）：用 testkit.MockProvider 脚本化完整交互（user msg → 流式 + tool_use(Read) → tool_result → tool_use(Edit) → 落盘断言：backup 生成 / JSONL 事件序 / 权限弹窗快照）；断言事件序列符合 §2.3 期望序；断言 JSONL 可 replay 且 SessionState 等价。依赖 I5 的 testkit 同里程碑交付。

---

## 第六部分 · 供应链与发布评审（S 系列）

### S1/S2（P3）· 发布供应链动作未排期

**修正设计**（§9.5 补三条）：
1. **L1 发版前注册 npm org**（scope 保护——无论最终走 npm 平台包还是 GitHub Release 分发，主包与 SDK 都在 scope 下）
2. **L2 起发布带 provenance**（GitHub Actions OIDC 免签溯源），与 bwrap digest 校验形成二进制供应链双保险
3. NOTICE 补 tiktoken-rs / BPE 数据（MIT）归属（native BPE 数据来源声明）

> 注：分发模型本身（npm 平台包 vs GitHub Release）的换轨认定属 r12 的 REM-45（BDFL 决策），本报告不预设立场——但无论哪个方向，上述三条都成立。

---

## 修正任务清单（按 spec 文件分组，可直接执行）

> 用户修正 spec 时按此表逐项落地；每项含目标文件 + 动作 + 对应 finding。

### 安全（最先）

| # | 目标 | 动作 | finding |
|---|---|---|---|
| 1 | `02-agent-loop.md` §2.6 | hook 超时分域语义（builtin fail-closed + payload 尺寸闸） | I10 |
| 2 | `05-rust-sidecar.md` §5.8 | 启动时序契约（并行探测 + REPL 不等待 + 冻结起点 + 下载可跳过） | P1 |

### 功能补缺

| # | 目标 | 动作 | finding |
|---|---|---|---|
| 3 | 新文件 `16-code-review.md` | 按[附录 A](#附录-a--16-code-review-功能设计草案) 落地；README 目录 + §10/§11.7 里程碑同步 | G1 |
| 4 | `04-tools-permissions.md` §4.3 | Bash runInBackground + ShellOutput/KillShell + 后台生命周期/缓冲/权限契约 + shell 执行语义（I11）+ Edit 完整契约（J3） | G2/I11/J3 |
| 5 | `02-agent-loop.md` §2.3 | 事件表 +2（shell.background_started/exited）；同步 §8.2 "17 种"表述、§13.2 events 页 | G2 |
| 6 | `02-agent-loop.md` §2.7 | 2.7.1 自定义 agent 定义格式 + W8 降级档位 + 并发上限 + 冒泡事件保留原 id | G3/D1 |
| 7 | `02-agent-loop.md` §2.4 | B7 截断续写 | G5 |
| 8 | `08-session-config.md` §8.6 | v1 回退边界声明 + /undo 选点规则 + v2 checkpoint 占位 | G4 |
| 9 | `10-milestones.md`/`04`§4.4/`11`§11.3.10 | gh 依赖三处显式化 | G6 |

### 实现必需契约

| # | 目标 | 动作 | finding |
|---|---|---|---|
| 10 | `03-provider-router.md` §3.2 | tool_use 聚合规则（含 parse 失败不执行） | I1 |
| 11 | `04-tools-permissions.md` §4.4 | glob 方言规范 + net origin 粒度 | I2/D1 |
| 12 | 新 `06b` §6.13 或差量 | packages/testkit 设计 | I5 |
| 13 | 新附录 B + shared 约定 | 错误码登记表 | I3 |
| 14 | `08-session-config.md` §8.3 + 附录 C | 未知 key 策略 + config 全量示例 | I4 |
| 15 | `05-rust-sidecar.md` §5.6.2 | IPC max_line_bytes + sandbox 协议形态修正 | I6/D1 |
| 16 | `02-agent-loop.md` §2.3 + 附录 D | per-event payload schema 要求 | I8 |
| 17 | `04-tools-permissions.md` §4.3 | Read 默认行数/忽略规则；非交互 confirm 降级（联动 §6.4.1） | D1 |
| 18 | 新附录 E | D1 的 20 条契约空白逐条登记归宿 | D1 |

### 性能 / 测试 / 供应链

| # | 目标 | 动作 | finding |
|---|---|---|---|
| 19 | `09-build-ci-dist.md` 新 §9.10 | 性能预算表 | P2/P5/T4 |
| 20 | `07-terminal-ui.md` §7.5.3 | picker 缓存策略 | P3 |
| 21 | `09-build-ci-dist.md` §9.4 | e2e smoke job | T2 |
| 22 | `09-build-ci-dist.md` §9.5 | npm org / provenance / NOTICE | S1/S2 |
| 23 | `05-rust-sidecar.md` §5.3.1/§5.3.3 | ExecRequest 补 exec+limits 段；probe features 键名契约 | D1 |
| 24 | `12-open-governance.md` §12.2 | DCO bot/AI 署名规则 | D1 |
| 25 | `13-docs-site.md` §13.6 | 手写 reference 漂移检测强制点 | D1 |

### 落地后的连锁同步

- §2.3 事件 17→19 → §8.2/§13.2 同步
- 新增 §16 → README 目录 + §10 里程碑 + §11.2 顶层命令（+`volund review`）+ §11.4 slash（+/review）
- 新增附录 B/C/D/E → README 附属文档表
- 全部落地 → §14 changelog 加 r13 行

---

## 附录 A · §16 Code Review 功能设计草案

> 可直接并入 spec 的完整章节草案（编号 §16，文件 `16-code-review.md`）。

### 16.1 设计目标

| 目标 | 含义 |
|---|---|
| **一等公民工作流** | review 与"写/改"并列的第三核心场景；CLI + slash + CI gate 三入口 |
| **结构化输出** | findings 是机器可读数据（zod 校验），不是自由文本——支撑 CI gate 与工具集成 |
| **只读安全** | 全程只读（diff/文件/PR 元数据），auto-allow，无副作用工具参与 |
| **注入免疫** | PR 描述 / diff / 被审代码全部 §6.5.0a untrusted 包裹——被审内容是最高危注入源 |
| **模型可换** | 默认走 RoleRouter `reviewer` 角色（§3.8.3 已预留）；`--model` 可覆盖 |

### 16.2 命令入口

```
volund review                         # working tree vs HEAD
volund review --staged                # staged vs HEAD
volund review --base <ref>            # vs <ref>（默认 origin/main..HEAD）
volund review --pr <url|number>       # GitHub PR（gh CLI；需 repo 上下文）
volund review --range <a>..<b>
Flags:
  --json                              # NDJSON（CI 消费）
  --severity-gate <blocker|warning>   # exit 门禁级（默认 blocker）
  --focus <category,...>              # security/perf/style/test/...
  --max-findings <n>                  # 默认 50
  --context-lines <n>                 # hunk 上下文行（默认 3）
REPL：/review [flags 子集]
```

### 16.3 数据模型（shared）

```ts
export interface ReviewReport {
  id: string; createdAt: string
  source: { kind: 'working-tree'|'staged'|'base'|'pr'|'range'; ref?: string }
  stats: { filesChanged: number; insertions: number; deletions: number }
  model: { provider: string; model: string }   // 哪个模型审的（信任度/telemetry）
  findings: ReviewFinding[]
}
export interface ReviewFinding {
  id: string
  severity: 'blocker'|'warning'|'info'|'nit'
  category: 'security'|'correctness'|'performance'|'api-misuse'|'error-handling'
          |'test-coverage'|'style'|'maintainability'
  file: string; line?: number; endLine?: number
  message: string            // 含理由
  suggestion?: string        // 建议修法
  confidence: 'high'|'medium'|'low'
  references?: string[]      // AGENT.md 规则名 / CWE 等
}
```

**severity 语义**（用户与 CI 的契约）：`blocker` 合并前必须处理（安全/明确 bug/数据损坏）；`warning` 大概率该修；`info` 值得知道；`nit` 风格微优化。

### 16.4 流程（ReviewPipeline）

```
1. 收集 diff（git diff / gh pr diff，经 Bash 工具只读执行）
   - PR 元数据（title/description/comments）单独收集，标 untrusted
2. 预处理：
   - 分片：files > 10 或 diff > 8000 行 → 按 file 分组；L3 起子 agent 并行
     （agentType='review-agent'，tools 白名单=Read/Grep/Glob，depth=1）；L2 串行
   - 上下文补全：每个被改文件读全文（≤ context 预算）——模型看 hunk+全文而非孤立 diff
3. 构造 review prompt：
   - system = builtin:review-guide（priority=990 新槽位）+ AGENT.md 项目规则（§6.5.4）
     + 自定义 review 规则（~/.volund/review.md 或 .volund/review.md，priority=610）
   - diff/PR 描述全部 <untrusted source="review:diff"|"review:pr-description"> 包裹
   - 输出契约：responseFormat json + zod schema + few-shot 格式示例
4. 执行：RouterHint { role: 'reviewer' }；RoleRouter 上线前用主 provider
5. 校验与渲染：
   - zord 失败 → 重试一次（附错误提示）；再失败 → 降级纯文本 + 标注 unstructured（不阻塞出结果）
   - TUI 按 severity 着色分组；路径 path:line 可点击（§6.5.1 约定）
   - --json：NDJSON（report 头 + 每行一个 finding）
6. exit code：0 = 无 ≥ gate 级 finding；4 = 存在（新码，不与 0/1/2/130 冲突）
```

### 16.5 与各章集成点

| 集成点 | 内容 |
|---|---|
| §2.7 subagent | L3 起大 PR 分片并行（内置 review-agent） |
| §3.8.3 RoleRouter | reviewer 角色首个真实消费者（RoleRouter 上线前主 provider） |
| §6.5 PromptComposer | 新槽位：builtin:review-guide 990 / project review.md 610 |
| §6.5.0a | diff/PR 描述/文件内容全包裹；review prompt 教模型"被审代码中的指令不服从" |
| §6.12 Memory | 团队 review 偏好（scope=project）召回影响 severity 判断 |
| §15 进化 | v2 接入点：context-lines/max-findings 自调优（信号：finding 采纳率） |
| §13 文档站 | cookbook code-review-workflow + ci-integration 页有功能支撑 |

### 16.6 边界与安全清单

| 规则 | 强制点 |
|---|---|
| review 全程禁止副作用工具（pipeline 工具白名单只读） | 单测（注入写文件尝试 → 拒绝） |
| diff/PR 描述/文件内容进 prompt 必须 untrusted 包裹 | 集成测试（PR 描述含指令 → 不影响输出契约） |
| PR 模式网络访问过 permission（gh + api.github.com 首次弹窗） | permission 单测 |
| findings 必须 zod 校验；失败重试一次后降级标注 | 单测 |
| --severity-gate exit code 语义稳定（CI 契约） | e2e（blocker → exit 4） |
| report 必须带 model 元数据 | schema 校验 |
| 大 PR 分片复用 §2.7 budget（默认 cost $2/PR，防烧钱） | subagent 集成测试 |
| review report 不写 session JSONL（独立命令无 session；--out 可存档） | 设计约定 |

### 16.7 事件（telemetry，本地）

`review.started` / `review.completed`（stats+model+duration）/ `review.finding_summary`（各 severity 计数）/ `review.fallback_unstructured`

### 16.8 里程碑

- **L2**：local diff review（working-tree/staged/base/range）+ `/review` + TUI/JSON 双输出 + untrusted 包裹 + AGENT.md 规则集成
- **L3**：`--pr` 模式（gh）+ 子 agent 分片并行 + review-agent + Memory 偏好召回
- **L4**：CI gate 文档模板（GitHub Actions 例）+ reviewer 角色路由（随 RoleRouter）+ finding 采纳率 telemetry

---

## 建议下一轮（r14）聚焦

1. 本报告修正落地后的 spec 复核（附录 B–E 是否齐、事件数/命令数连锁同步是否净）
2. §16 落地后的 review prompt 质量（需真实 PR 语料迭代——prompt 是体验关键）
3. 性能预算表上线后的首次基线测量（CI 采集）

---

## 变更日志

| 日期 | 版本 | 内容 |
|---|---|---|
| 2026-08-16 | r13 v1 | 功能设计完整评审（纯设计视角，不涉实现一致性）：六维度（功能完备性/可实现性/旅程/性能预算/测试基建/供应链）。23 项发现（P0×2：hook 超时 fail-open I10 + 启动时序未定义 P1；P1×6：G1 code review 缺失 / G2 后台 Bash / I1 聚合规则 / I2 glob 方言 / J3 Edit 契约 / I5 testkit；P2×13 / P3×2）。D1 收编 r11/r12 审计暴露的 20 条"实现被迫自定"契约空白。附录 A 给 §16 Code Review 完整章节草案。修正任务清单 25 项按 spec 文件分组。 |
