# Apollo Code · Self-Evolution / Plugin Kernel Progress Handoff

> **用途**：给后续模型或工程师继续当前工作。本文记录的是当前分支的工程事实、未提交改动归属、已完成审查、下一步和不可跨越的安全边界。
>
> **更新时间**：2026-08-22（Asia/Shanghai）
>
> **注意**：本文是进度/交接记录，不替代 §15、§18、§19、§19a 的规范权威。切换模型后先重读本文，再以 `git status`、exact SHA 和测试结果刷新事实。

## 1. 当前仓库状态

- 工作目录：`/Users/mark/myself/code/apollo-code`
- 分支：`codex/self-evolution`
- 实现基线 HEAD（不含本文自己的文档提交）：`33e5ce531bd6df0c73fdef3ab4c902e45f1dba06`
- 实现基线短 SHA：`33e5ce5`
- 禁止 amend、push、merge、tag、publish；除非用户另行明确授权。
- 工作树为共享 dirty worktree；不能 reset、checkout、清理或覆盖不属于本任务的改动。

最近已提交：

```text
2450a95 docs(plan): record self-evolution handoff
33e5ce5 fix(plugin): harden contained legacy state
e220d08 fix(ci): select cli workspace by path
9ccf9f1 fix(plugin): remove legacy authority bypass
c3de176 fix(plugin): contain legacy production activation
4ed57c7 docs(spec): define the plugin security kernel
378c466 test(native-bridge): assert sandbox resolver kind
```

## 2. 已确认的产品/架构判断

### 2.1 当前项目是什么

项目在工程类别上已经是一个可运行的自有 Agent Harness：Runner、session/event、prompt、tools、permission、context、storage、TUI/line/JSON driver、subagent 等基础组件已存在。

当前只能宣称：

> Functional self-owned agent harness foundation.

当前不能宣称：

- HarnessSpec-conformant；
- self-hosted；
- plugin-native；
- Rust-enforced capability runtime 已完成；
- self-evolving / 自我开发闭环已完成。

### 2.2 Plugin-first 边界

冻结的方向是：

> Everything extensible is a capability plugin; the K0 security kernel is not.

对应职责：

- Harness 拥有 loop、state reducer、extension contract、driver contract 与 hard invariants。
- K1–K3 capability plugin 提供可替换行为。
- K0/Rust 是 reference monitor 和安全执行平面，验证并强制 authority ceiling。
- Rust 不意味着所有业务插件必须用 Rust；Rust 负责可信 launcher、sandbox、broker、token/effect enforcement。
- K0 职责按 §8/§19 的非穷尽定义解释；未列名的可信裁判默认不能插件化。

### 2.3 “自进化”的真实状态

- §15 是白名单运行时数值调优，不改代码或制品。
- §18 才是候选代码/制品的受控自我开发流水线。
- 当前 `EvolutionEngine.observe()`、`validate()`、`TuningMemoryStore.write()` 均无生产调用。
- §18 的 SelfDev orchestrator、sealed candidate、base-owned checks、independent acceptance、human receipt、promotion transaction 均未实现。
- 生产上不得开启或宣传“自我开发/闭环自进化”。
- 第一条允许的 vertical slice 只能是 K3、deterministic、data-only、`effects: []`，最终止于本地 branch + Catalog `STAGED_DISABLED`；不得 adoption、enable、push、merge、publish 或 deploy。

## 3. 已完成：P0 legacy plugin containment

P0 kill switch 已提交并通过独立审查：

- `PluginManager.install()` deny-only；
- `setEnabled(true)` deny-only；
- stale approval 初始化时只投影为 disabled；
- `PluginRuntime.loadEnabled()` 返回空；
- `load()` 拒绝；
- `active()` 返回空；
- production activation 数必须继续为 0。

不得为了演示或后续 SelfDev 开发而重开 legacy activation。只有新的 Catalog/ABI/Rust validation 路径完成并独立验收后，才能讨论另一个显式人工 enable gate。

## 4. 正在进行的未提交工作

### 4.1 §15 T0/T1a：default-off + strict tuning boundary

目标：先关闭当前历史调优路径的 fail-open/不可信输入问题，不接通自动 `observe()` 或 `validate()`。

已经完成并经过第一轮测试的部分：

- `EvolutionEngine` 默认 `enabled=false`。
- 运行时只接受字面 boolean `true`；string/number/object 等 truthy 值不是 authority。
- disabled 时 `values/observe/propose/validate` 均为零 persistence I/O。
- production 只在 `~/.apollo/config.toml` 显式 `[evolution] enabled = true` 时进入历史值读取路径。
- config 缺失/false 使用内置默认。
- TOML 语法错误、已知字段错类型、EACCES 等非 ENOENT 错误向上传播，在读取 tuning 前阻止 Runner 创建。
- `[evolution]` config schema 已从开放段收窄为严格 `enabled?: boolean`。
- `apollo evolution show|rollback` 仍是显式维护命令；它们不会开启自动调优。

第一轮独立审查结果曾为 `0 Critical / 4 Important / REQUEST_CHANGES`。四项均已由 writer 在冻结候选中处理，但尚未取得对最终 exact diff 的独立 PASS：

1. Engine 曾把 truthy 非 boolean 当启用；已修。
2. production 曾吞掉坏 config 后继续；已修为非 ENOENT 向上抛。
3. 显式启用后曾原样信任 legacy JSONL；冻结候选已加入 Store + Engine 双层 strict validation。
4. 公开默认行为变化缺独立 changeset；冻结候选已新增 changeset。

当前 T1a writer 已停写并报告 frozen candidate：

- focused tracked diff SHA-256：`452211bab71530bc6de45f12cad3bf64f580144dca79534c2194b2cac6a94dfd`；
- changeset SHA-256：`d44b8a8a15da0d919d0af1981676310ed1e40c2ae348491b6b0e38a53a968cea`；
- 未 stage、未 commit；最终独立复审前不能把它当作 accepted evidence。

冻结候选合同：

- Core 冻结 context 安全范围：
  - `compaction_threshold`: `0.65..0.95`
  - `target_ratio`: `0.45..0.75`
  - `keep_recent`: integer `15..25`
  - `summary_keep_recent`: integer `15..25`
  - cross constraint：`target_ratio + 0.10 <= compaction_threshold`
- `EvolutionEngine.values()` 把任意 `EvolutionPersistence` 当不可信输入：plain object、exact allowlist、finite、bounds、integer、whole-snapshot cross constraint；非法 resolved projection 整 namespace 回 defaults。
- 当前只允许 context persistence apply。Router/Retry/动态 per-tool timeout bounds 未冻结，持久化 apply 和 rollback 必须 deny-only；只读 audit 可保留。
- `EvolutionStore` 实现 bounded strict JSONL decoder：合法 legacy-v0 可作为 compatibility current source，但不能作为未来 T1/T2 evidence；新 append 写 flat V1 `schemaVersion:1`；future schema 不得降级解释。
- invalid legacy 行忽略并保留前一合法值；future schema 使该 namespace 的 current/rollback fail-closed。
- 固定 diagnostic code，不得包含原始 JSON、reason/signal 值、secret 或绝对路径。
- T1a 不声称 namespace/audit 双写 crash-atomic，也不引入无跨进程锁保障的 global sequence。
- 独立 changeset 已生成，覆盖 `@apollo-code/core`、`apollo-code`、`@apollo-code/shared`、`@apollo-code/config`、`@apollo-code/storage`；最终内容仍需随 focused diff 复审。

T1a 当前可能涉及的文件：

```text
apps/cli/src/runtime.ts
apps/cli/src/runtime.test.ts
apps/docs/docs/reference/cli.md
apps/docs/zh/docs/reference/cli.md
docs/superpowers/specs/2026-07-31-apollo-code-design/15-self-evolution.md
docs/superpowers/specs/2026-07-31-apollo-code-design/APPENDIX-C-config-schema.md
packages/config/src/index.test.ts
packages/core/src/evolution-engine.ts
packages/core/src/evolution-engine.test.ts
packages/shared/src/config-schema.ts
packages/shared/src/config-schema.test.ts
packages/shared/src/error-codes.ts
packages/storage/src/evolution-store.ts
packages/storage/src/evolution-store.test.ts
.changeset/safe-evolution-projection.md
```

writer 报告的验证结果：core 61/61、storage 73 passed + 1 skipped、CLI 97/97、shared 100/100、config 12/12；全仓 typecheck 55/55、docs build、format、config-docs、error-codes、lint、`git diff --check` 通过。主 agent 仍需核对 exact file set/diff hash，并由独立 reviewer 对同一冻结候选达到 `0 Critical / 0 Important` 后才可单独提交。

### 4.2 ABI-00 文档冻结

ABI writer 已停写并报告 `READY_FIX3` frozen candidate；未 stage、未 commit。五文件 SHA-256：

```text
§18     bbc292f525a94a33360ea91c5db95b961dc9c39c0650018e1fbc3d9e17419a88
§19a    a9accf44d22a1420a4e9478ab918199ddb154400f98d12746d5c63d085eabcdf
§19     59f82dafec3c16fc005bd32e99d8331e169424913cea26bb3009256f6aac125d
Plan    d3a6c02a79b1f81ba247276e0c1645766904c18dd17ae2f2468f93e9af7db158
README  ccd162dcb88f0408326680249fec794674c56225be5d20403340c6f1eab48722
```

冻结候选覆盖：

- Canonical JSON/domain/signature；
- closed role/artifact DAG；
- four-source promotion deadline；
- SafeDisplay 与 secret operand binding；
- Build/Executable exact identity；
- content identity 与 authority generation；
- Catalog revision/history；
- VerificationSources/temporal context；
- participant identity/role revocation；
- AMBIGUOUS reconciliation 与 fresh lineage；
- SelfDev PREPARED → independent AnchorStore ANCHORED/CANCELLED → idempotent FINALIZED；
- TS/Rust shared corpus、caps、error ordering。

ABI 文件归属：

```text
docs/superpowers/plans/2026-08-20-plugin-kernel-implementation.md
docs/superpowers/specs/2026-07-31-apollo-code-design/18-self-development.md
docs/superpowers/specs/2026-07-31-apollo-code-design/19-plugin-kernel.md
docs/superpowers/specs/2026-07-31-apollo-code-design/19a-capability-contract.md  # untracked candidate
docs/superpowers/specs/2026-07-31-apollo-code-design/README.md                # 只能部分暂存 ABI hunks
```

writer 报告 `git diff --check`、Markdown links/fences、docs tests 7/7、direct VitePress、plugin-runtime 94/94、packlist fence 和 stale phrase checks 通过。完整 docs build 在共享 moving worktree 中被 `packages/storage/src/evolution-store.ts` 的 TypeDoc 类型错误阻止；需要在 T1a 候选稳定后重跑并归因，不能把 direct VitePress 通过替代完整门禁。

现在必须让两位独立 reviewer 分别按上述同一组哈希复审：

- byte/crypto/registry reviewer；
- state machine/identity/recovery reviewer。

只有两路都达到 `0 Critical / 0 Important` 才能暂存和提交。

### 4.3 共享但不属于当前 ABI/T1a 提交的文件

以下内容是共享/另一路工作，绝对不能删除、reset、覆盖或混入当前提交：

```text
docs/superpowers/specs/2026-07-31-apollo-code-design/20-harness.md  # untracked
docs/superpowers/specs/2026-07-31-apollo-code-design/README.md      # 含 §20 hunks
```

README 同时包含 ABI hunks 和 §20 hunks。ABI 提交必须 partial-stage，只暂存 §19/§19a/§18/plan 相关行；不得暂存 “自有 Harness”、§20 table/routing/cross-reference hunks。

## 5. §20 Harness 审计结论（尚未修复/提交）

`20-harness.md` 当前是 proposed/shared work，不能直接冻结。主要阻断：

- HarnessSpec 对 prompt fragment 使用裸 SHA-256，存在低熵关联/字典 oracle，且没有绑定 exact executable/build/active capability/Catalog epochs。
- H-1…H-14 被写成当前不变量，但当前 H-2/H-8/H-12/H-13 等并未满足；H0 不能只靠文档合入宣称完成。
- driver 表事实错误：没有 `-p`，pipe chat 不支持；真实 headless 是 `apollo chat "<prompt>" --json`。
- `packages/hooks`、`packages/memory-runtime` 当前不存在；必须拆 current path 与 target owner。
- §16 是旧 SHA 的 historical baseline，不是 current unique authority。
- package-wide `★` 与 plugin-first 冲突，应改成 responsibility-level matrix。
- H3 必须拆：
  - H3a human-directed dogfood；
  - H3b §18 K3 controlled self-development。
- §18 v1 禁止自动 push/merge/remote PR；H3 不得与其冲突。

§20 必须以后单独修复、单独审查、单独提交。

## 6. T1b：Tuning journal / crash recovery（T1a 之后）

T1b 必须是独立提交，不能混入 T1a：

- 跨进程 exclusive lock；
- `.evolution-txn.json` journal；
- namespace/audit 两文件 pre-size + prefix digest；
- PREPARED → NAMESPACE_DURABLE → BOTH_DURABLE；
- partial/torn write 默认 abort 回 pre-size；
- 无法证明时 `RECOVERY_REQUIRED`，禁止 append；
- committed visibility 必须由 namespace/audit exact matching record identity 证明；
- crash/fault injection、两个 child process 并发、SIGKILL/restart 测试；
- Windows directory fsync 限制必须诚实披露。

T1b 完成前，当前 JSONL 双写不能称为 crash-atomic 或 evidence-grade。

## 7. 下一步执行顺序

### 立即执行

1. 主 agent 按 T1a focused diff SHA 检查 core/store decoder、安全 bounds、legacy/future schema、路径构造前验证、diagnostic 脱敏与 changeset。
2. 在冻结 T1a 候选上重跑定向 tests/typecheck/config-docs/format/diff-check，并让独立 reviewer 达到 `0C/0I`。
3. 只暂存 T1a 精确文件与独立 changeset，检查 cached diff/name list，单独 commit；不得混入 ABI/§20。
4. 对上述 ABI 五文件 exact SHA 恢复 byte/crypto/registry 与 state/identity/recovery 两位 reviewer；两路都必须 `0C/0I`。
5. 重跑 ABI stale phrase、link/fence/full docs build、plugin-runtime/packlist tests；TypeDoc 红项必须在稳定 worktree 中关闭或证明属于已修复的 T1a moving-state。
6. ABI 只暂存 §18/§19/§19a/plan 与 README ABI hunks，检查 cached diff 后单独 commit；排除 §20 hunks。
7. 并行完成 `BRAND-DISCOVERY/FREEZE`：只做全新候选、实时 clearance、用户选择和 canonical identity tuple；不得提前迁移 package/CLI/home/native/signing identity。

### 随后执行

8. 实现 T1b journal/recovery，独立 fault-injection 验收并单独 commit。
9. 实现私有 TypeScript/Rust contract packages 与同一 checked-in corpus/cross-language golden vectors。
10. 关闭 P0 Rust reference monitor：最小 fs view、真实 seccomp、origin-level network、resource limits、identity-pinned executable、credential/token 不外泄。
11. 实现 Catalog CAT-01/02：closed-role artifact DAG、CEB/CAB、revision、reservation/fence、immutable identity/history。
12. 只有 `CAT-02 + cleared canonical identity` 同时完成后，执行 `BRAND-MIGRATE`；随后在 branded exact SHA 完成 `BRAND-VERIFY` 和原 product/security/platform/supply-chain 重新签字。
13. `BRAND-VERIFY` 通过后才接 ABI runtime production activation、typed brokers 和 universal registry。
14. 实现 SelfDev control plane、restricted Developer、base-owned checks、independent acceptance、human signed receipt、branch-only promotion。
15. 第一条完整 proof 必须结束于 `STAGED_DISABLED`，仍不得自动 adoption/enable。
16. 完成 HarnessDefinition/RunBinding、driver conformance 和 H3b self-host evidence。
17. 完成全量 release evidence、prerelease/beta gate。

## 8. 品牌与 logo 的硬门

完整品牌决策、视觉语义、identity tuple、迁移顺序和验收门见：

> [Brand Identity & Migration Plan](./2026-08-22-brand-identity-and-migration.md)

用户要求品牌突出：AI + 安全 + 极简，同时体现 plugin cells / sandbox boundary / Rust enforcement。精确架构表述统一为：`Everything extensible is a capability plugin; the K0 security kernel is not.` K0 是非穷尽集合，包括 sandbox/reference monitor、permission/policy、identity/trust、canonical/signature verifier、Catalog reducer/journal、mandatory security hooks/secret guard、核心 state/promotion invariants 与 human gates。

历史决策必须准确解释：用户曾在“AI + 安全”轮次选择 `Cereward AI`，但该名称随后触发先前 clearance 否决门并停止落库，状态为 `WITHDRAWN / DO NOT USE`。`Evalistry` 被用户后续的“名字不好”推翻，`Rigorbind` 也未通过 clearance，三者都不是当前候选。用户随后加入 Everything is Plugin + Sandbox + Rust，使品牌语义重新打开。主 Logo 工作方向是 **Controlled Port**：可替换 capability cell + 连续 sandbox/K0 boundary + single logical K0 authority chokepoint；成品仍待用户视觉确认，Rust-enforced 声明仍须逐平台、逐 surface 取证。

但最终 identity tuple 尚未确认，不能猜测，更不能全局替换 `Apollo`。进入品牌迁移前必须由用户确认：

1. display name / short name；
2. machine slug；
3. canonical CLI 与 `apollo` alias 保留周期；
4. npm root/package scope；
5. home dir / env prefix / migration precedence；
6. repo/docs origin；
7. native/release identifiers；
8. plugin schema/name prefix 与 legacy re-sign/re-auth；
9. signing/security principal namespace；
10. v1 wire/event/error/schema IDs 哪些永久冻结。

品牌迁移禁止全局 search-replace。必须保留历史证据和 v1 protocol/event/error/schema/security constants，必要时使用 versioned compatibility layer。

## 9. 验证证据与常用命令

此前已通过的基线：

- plugin-runtime targeted：94/94；
- plugin-runtime typecheck；
- packlist deny-only；
- `cargo test --workspace`；
- `pnpm test` 主体；
- changeset release-plan test 因 sandbox 读取 `.git/worktrees` 单独提升权限后 2/2 通过。

T0 第一版曾通过：

- core 7 tests；
- shared 8 tests；
- config 12 tests；
- runtime 56 tests；
- CLI 41 tests；
- 四包 typecheck；
- `pnpm verify:config-docs`；
- `pnpm format:check`；
- `git diff --check`。

注意：T1a 当前仍在修改 core/storage，因此上述 T0 数字不是最终 candidate 的验收结果，必须重跑。

建议 T1a 完成后：

```bash
pnpm --dir packages/core test
pnpm --dir packages/storage test
pnpm --dir packages/shared test
pnpm --dir packages/config test
pnpm --dir apps/cli test

pnpm --dir packages/core typecheck
pnpm --dir packages/storage typecheck
pnpm --dir packages/shared typecheck
pnpm --dir packages/config typecheck
pnpm --dir apps/cli typecheck

pnpm verify:config-docs
pnpm format:check
pnpm lint
git diff --check
```

最终 release candidate 仍需：

```bash
cargo test --workspace
pnpm test
pnpm typecheck
pnpm lint
pnpm format:check
```

## 10. ABI frozen-candidate stale scan

ABI writer 停写后至少检查：

```text
policy absolute deadline
上述五类 source
current policy bytes
只显示 opaque handle
Manifest 256×3
invocation 320 KiB
其他role沿原同名purpose
既有...purpose
```

其中某些短语可能出现在“明确禁止/不是第五来源”的正确上下文，不能只按命中数判断；必须逐条读语义。

## 11. 暂存/提交纪律

- 每个安全切片独立提交。
- 不 stage 未审文件。
- 每次 commit 前执行：

```bash
git diff --check
git diff --cached --check
git diff --cached --name-only
git diff --cached
```

- README 必须 partial-stage。
- `20-harness.md` 与 README §20 hunks 当前不得进入 ABI/T1a commit。
- 不使用 `git reset --hard`、`git checkout --` 或 destructive cleanup。
- 不 amend，不 push。

## 12. 可对用户使用的诚实口径

> 方向不需要推翻：项目已经有 functional agent-harness foundation，正在建设 plugin-first、Rust-enforced capability runtime 和 human-gated K3 self-development。当前生产自进化尚未实现，也不能开启；第一阶段只会交付经过独立验收、人工签收、最终保持 disabled 的本地候选。
