# r13 功能设计修正 · 实现执行计划（2026-08-16）

> **状态**：批次 1（5/5）与批次 2（4/4：#114 ad0e7b5 / #115 7d1147e / #116 60322c1 / #117 e20c788）均已合并。批次 3a 全收口：REM-61(#122 @ 4ac2411)/74(#123 @ 1b47c28)/65(#124 @ 8ef1b70) 合并。累计 15/25。批次 3b（REM-62 后台 Bash + REM-63 B7）由巡检自动启动。
> **输入**：[REVIEW-r13](../specs/2026-07-31-apollo-code-design/REVIEW-r13.md) 修正任务清单 25 项，spec 已于 `fb3158c` 落地（docs(superpowers/specs) 为冻结契约，本计划只改代码）
> **编号**：延续 [2026-08-15-design-remediation.md](./2026-08-15-design-remediation.md) 的 REM 编号（r11: REM-1~25，r12: REM-26~50），本计划从 **REM-51** 起
> **执行方式**：并行 worktree + 每 REM 一分支一 PR；验收走 [agents 监督体系](./agents/README.md)；每项完成后回写 [16-capability-traceability](../specs/2026-07-31-apollo-code-design/16-capability-traceability.md)

## 0. 执行约定（所有 REM 通用）

1. **分支**：`rem-<NN>`，基于最新 `main` 建出；**PR 前必须 `git fetch origin && git rebase origin/main`**（BDFL 要求）。
2. **提交**：`git commit -s`（DCO 由指令人类签署——git user 即 Mark）；提交信息 `REM-NN: <摘要> (r13-XX)`。
3. **PR body 必含**（§12.6b）：spec 章节引用 / 强制点测试清单 / 人在环检查点 / 完成状态（done | partial | blocked）。
4. **spec 冻结**：禁止修改 `docs/superpowers/specs/**`；发现契约与现实冲突 → 停在 blocked 状态报告 A/B 出口，不自行裁决。
5. **冲突面纪律**：`packages/tools/src/index.ts` 是单一大文件——同一并行批次内只允许一个 REM 修改它。
6. **验收**：受影响包 `pnpm --filter <pkg> test` + `typecheck` 全绿；禁止跳过既有测试。

## 工作包总览

| 批次 | REM | finding | 主题 | 落点 | 并行 |
|---|---|---|---|---|---|
| 1 | REM-51 | I5 | testkit L1 首批（MockProvider / fakeClock / tempApolloHome） | 新包 packages/testkit | ✅ |
| 1 | REM-52 | I10 + r11-REM5 | hook pre/postToolUse 派发 + 超时分域（builtin fail-closed） | plugin-runtime + tools invoke 链 | ✅ |
| 1 | REM-54 | I1 | tool_use 流式聚合规则（parse 失败不执行） | core/runner.ts | ✅ |
| 1 | REM-55 | I2/D1-4 | 路径模式语义 picomatch + net origin 粒度 | permission（禁改 tools/index.ts） | ✅ |
| 1 | REM-58 | I6 | IPC max_line_bytes=4MB + 通道存活 | native-bridge/ipc.ts | ✅ |
| 2 | REM-56 | J3 | Edit 完整契约（唯一性/no-op/lockfile/mtime） | tools/index.ts（Edit 段） | 批 2 |
| 2 | REM-57 | I11 | Bash shell 选择 /bin/bash -c + env 最小集 | tools/index.ts（Bash 段）+ sandbox profile | 批 2 |
| 2 | REM-53 | P1(r13) | native 探测启动时序（并行 + probing 三态 + REPL 不等） | native-bridge + apps/cli | 批 2 |
| 2 | REM-59 | I3 | 错误码 registry（shared/error-codes.ts）+ ESLint 禁裸串 + verify 脚本 | shared + CI | 批 2 |
| 2 | REM-60 | I8 | per-event zod schema（shared/events/）+ CI 校验 | shared + core | 批 2 |
| 3 | REM-61 | I4 | config 未知 key warn + 附录 C 对齐 | config-loader/shared | 批 3 |
| 3 | REM-75 | LL-7 | storage 并发合并测试根治（锁重试预算可测控 / vitest pool 串行化，二选一或组合；消除满载 Windows 双形态 flaky） | packages/storage | 批 3（新排） |
| 3 | REM-74 | I8 后续 | 事件 emit 点迁移到附录 D 契约形状（13 处漂移，含 stream.delta 整 chunk、tool.* 字段名）+ 消费侧（machine-output）同改 + **清除实现自创 session.snapshot（§8.2 已裁决拒绝）** + subagent 冒泡按 D.3 保留原 event.id | core/ui/subagent/runtime | 批 3（REM-60 审计产出，新排） |
| 3 | REM-62 | G2 | 后台 Bash（runInBackground + ShellOutput/KillShell + 2 事件 + /shells） | tools + core 事件表 + ui | 批 3 |
| 3 | REM-63 | G5 | B7 截断续写（UI 标记 + sticky 复用） | core + ui | 批 3 |
| 3 | REM-64 | G4 | /undo 选点规则 + 无 backup 提示 | storage/tools | 批 3 |
| 3 | REM-65 | G6 | doctor gh CLI 检测（⚠️ 不 fail）；原 `auto-allow gh` 合同已被 SD0-01 supersede，**不得实现或重新引入**，所有 raw Bash（含 `gh`）仍须显式 grant | apps/cli（检测 only；不得修改 permission 为 gh 放行） | 批 3 |
| 4 | REM-66 | G1 | §17 review L2（ReviewReport/ReviewFinding + local pipeline + `apollo review` + exit 4） | shared + 新 review 包 + apps/cli | 批 4 |
| 4 | REM-67 | D1 长尾-a | probe 键名契约 / ExecRequest exec+limits / streamResume 显式拒绝码对齐附录 B / 合成 id 注记落测 | native-bridge + provider 适配器 | 批 4 |
| 4 | REM-68 | D1 长尾-b | 非交互 ui.* 降级 / --json 错误两行协议 / DCO bot 豁免清单 / docs verify:cli 脚本 / 估算缓存生命周期 / Task 并发上限 4 / budget 范围 / **Read 默认 2000 行 + ignore_dirs（§4.3.3，补排）** | 分散小项 | 批 4 |
| 4 | REM-69 | T2 | e2e smoke job（MockProvider 脚本化全链路 + JSONL replay 断言） | CI + e2e | 批 4 |
| 4 | REM-70 | P2/P5/T4 | §9.10 性能预算 CI 采集 + 基线 artifact | CI | 批 4 |
| 4 | REM-73 | P3 | `@` picker 候选缓存（git ls-files 缓存 + TTL + 首帧子集，§7.5.3） | ui | 批 4（补排：r13 对账发现漏排） |
| 5 | REM-71 | G3 | 自定义 agent 定义装载（.apollo/agents/*.md + untrusted 包裹） | subagent + shared/agent-schema | 批 5 |
| 5 | REM-72 | S1/S2 | npm org 抢注防护 / provenance / NOTICE tiktoken | 发布配置 | 批 5 |

> r11/r12 计划中与本计划有依赖关系的项：REM-52 吸收 r11-REM5（pre/postToolUse 派发）；Bash 5s 强杀与 Write/Edit 沙箱链路（r12 项）应在 REM-57/REM-62 之前或同批完成。

## 批次 1 任务卡（已发出）

### REM-51 · testkit L1 首批（r13-I5）
- 契约：`06d-testkit.md` §6.13.1–6.13.4（L1 首批 = MockProvider + fakeClock + tempApolloHome；sessionFixture/nativeStub 属 L2 不做）
- 验收：MockProvider implements `ProviderClient`（provider-kit 契约，typecheck 保证）；scriptChunks + interruptAt/errorAfter/duplicateUsage/brokenToolJson/truncateUtf8At 可编程；dev-only（不进任何运行时包依赖图）；`packages/testkit` 单测绿
- 边界：依赖 provider-kit + core[type-only] + shared；私有包不发布

### REM-52 · hook 派发 + 超时分域（r13-I10 + r11-REM5）
- 契约：`02-agent-loop.md` §2.6 执行语义（r13 分域段）+ `06b` §6.11.1 串行 pipeline + r11 计划 REM-5 落点
- 范围：先接线 preToolUse/postToolUse 到 tools invoke 链（复用 plugin-runtime `runHooks`，veto 短路已实现）；再实现超时 5s 分域——**domain = hook 来源**（builtin/plugin/project/user）：builtin 超时 → fail-closed（veto + `error.raised{code:'builtin_hook_timeout'}`）；其余 → 跳过 + warning。后续 SD0-02 已把原“>1MB 截断闸”修正为 strict canonical JSON-v1 **>1 MiB direct-veto**：handler 不调用，发 `builtin_hook_payload_too_large` + `hook.payload_rejected`，证据明确 `scanStatus:'not_started'`。
- 验收：单测 ×2（builtin 卡 6s → tool 阻断；plugin 卡 6s → 放行 + warning）；veto `rm -rf` e2e 用例（r11-REM5 验收）；SD0-02 另覆盖危险尾部、exact limit/limit+1、UTF-8、异常 serialization、builtin rewrite 复检和真实 ToolExecutor native invoke=0。
- 注：spec 括号里的 priority 900–1000 与现行 -100~100 方言若冲突，按 domain 字段实现并在 PR 里记录（A/B 报告），不改 spec

### REM-54 · tool_use 聚合规则（r13-I1）
- 契约：`03-provider-router.md` §3.2「tool_use 流式聚合规则」四条
- 范围：core/runner.ts 聚合改 `Map<toolUseId, string[]>`；`tool_use.end` 一次 parse；**失败 → isError tool_result（含前 200 字符原文）且不执行**；`message.interrupted` 作废全部未 end entry
- 验收：core 单测——双 tool_use 交错 delta + 破损 JSON 用例；断言破损 tool 不执行且 error tool_result 形状正确；既有 runner 测试全绿

### REM-55 · 路径模式语义 + net origin（r13-I2/D1-4）
- 契约：`04-tools-permissions.md` §4.4「路径模式语义」5 条 +「net 匹配粒度 = origin」
- 范围：permission 包内实现共享 matcher（picomatch、globstar=true、大小写敏感、canonicalize+~ 展开+realpath、cwd 相对解析、不支持 `!`）；net 权限 key 按 origin 归一
- 验收：permission 单测（大小写 / 双星 / symlink / 字面-vs-glob / origin 归一）；**禁改 packages/tools/src/index.ts**（Glob 工具翻译统一留批 2 记录）

### REM-58 · IPC 行上限（r13-I6）
- 契约：`05-rust-sidecar.md` §5.6.2「r13-I6 单行尺寸上限」
- 范围：native-bridge/ipc.ts 行读取带上限（默认 4MB，可配 `[native] ipc_max_line_bytes`）；超限 → JSON-RPC `-32600` + telemetry `ipc.line_too_large`，**通道存活**（读端丢弃至下一 `\n`）
- 验收：ipc 单测——5MB 单行 → 拒绝且通道存活（后续正常消息仍可处理）

## 监控与状态

- 每个 REM 完成即按 [agents/README.md](./agents/README.md) 流程 spawn 监控 agent（general-purpose）出 `reports/REM-NN-<date>.md`
- 主 agent 每 ≥5 份报告或任一 blocked 跑一轮汇总；lessons-learned 追加经验
- PR 合并后回写 16-capability-traceability 对应行（`missing → partial/verified-local` + 绑定合并 SHA）
