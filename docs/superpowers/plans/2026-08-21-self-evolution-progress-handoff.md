# Apollo Code · Self-Evolution / Plugin Kernel Progress Handoff

> **用途**：给后续模型或工程师继续当前工作。本文记录的是当前分支的工程事实、未提交改动归属、已完成审查、下一步和不可跨越的安全边界。
>
> **更新时间**：2026-08-22（Asia/Shanghai，第二轮：T1a/ABI/§20 已提交）
>
> **注意**：本文是进度/交接记录，不替代 §15、§18、§19、§19a、§20 的规范权威。切换模型后先重读本文，再以 `git status`、exact SHA 和测试结果刷新事实。
>
> **模型切换**：可直接复制 [Model-Switch Continuation Prompt](./2026-08-22-model-switch-continuation-prompt.md) 给其他模型；切换回来时也以该提示词的“最短提示”恢复。

## 1. 当前仓库状态

- 工作目录：`/Users/mark/myself/code/apollo-code`
- 分支：`codex/self-evolution`
- HEAD（本文提交前）：`5c85d825a10119aeac573e06c6a28007f4884ae0`（T1b commit）；本文与 continuation prompt 的更新是其后的独立 docs(progress) commit。
- 工作树：**当前完全干净**（`git status` 无条目）。此前的 T1a / ABI / §20 三组未提交候选已全部独立提交。
- 验证用 worktree `/Users/mark/myself/code/apollo-code-{t1a,abi,s20}-verify` 已创建、使用并移除；其它 `rem-*` worktree 属于别的任务线，未触碰。
- 禁止 amend、push、merge、tag、publish；除非用户另行明确授权。

最近已提交：

```text
5c85d82 feat(storage): journal-backed tuning store with record identity
3b0503d docs(spec): add §20 self-owned harness chapter
df4a2dd docs(spec): freeze ABI-00 capability contract V1
6dd0b20 fix(core): default-off adaptive tuning with strict persistence boundary
5e04cf4 docs(handoff): add model switch continuation prompt
46898cb docs(brand): record identity and migration plan
2450a95 docs(plan): record self-evolution handoff
33e5ce5 fix(plugin): harden contained legacy state
```

## 2. 已确认的产品/架构判断

### 2.1 当前项目是什么

项目在工程类别上已经是一个可运行的自有 Agent Harness：Runner、session/event、prompt、tools、permission、context、storage、TUI/line/JSON driver、subagent 等基础组件已存在；§20 已把 harness 确立为一等架构层（proposed / not shipped 的规范层冻结）。

当前只能宣称：

> Functional self-owned agent harness foundation.

当前不能宣称：

- HarnessSpec-conformant（H1 未开始）；
- self-hosted（H3a/H3b 未开始）；
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

- §15 是白名单运行时数值调优，不改代码或制品。**T1a 已提交（6dd0b20）**：default-off、strict boolean opt-in、context 安全 envelope、strict V1/legacy decoder、non-context deny-only。
- §18 才是候选代码/制品的受控自我开发流水线。
- 当前 `EvolutionEngine.observe()`、`validate()`、`TuningMemoryStore.write()` 均无生产调用。
- §18 的 SelfDev orchestrator、sealed candidate、base-owned checks、independent acceptance、human receipt、promotion transaction 均未实现。
- 生产上不得开启或宣传“自我开发/闭环自进化”。
- 第一条允许的 vertical slice 只能是 K3、deterministic、data-only、`effects: []`，最终止于本地 branch + Catalog `STAGED_DISABLED`；不得 adoption、enable、push、merge、publish 或 deploy。

## 3. 已完成并独立验收（本轮新增提交）

### 3.1 P0 legacy plugin containment（既有基线）

`33e5ce5`：production activation deny-only；install/enable/load/active 继续 fail-closed。不得为了 demo 或 SelfDev 重开。

### 3.2 T1a tuning hardening — `6dd0b20`（已提交）

- **Frozen candidate**：staged patch SHA-256 `ff2c6d52f17921e528866f98e47eb8e8a439427fb3a1646a3785d3c614619ae1`；verified candidate tree / commit tree `786f6ae86020235a3a9f5c7aaeb950f719a072ab`（commit tree 已核对相等）。
- **范围**：16 个文件（14 tracked + `packages/config/src/index.ts` + `.changeset/safe-evolution-projection.md`）。
- **内容**：engine/production default-off（仅字面 own-property boolean `true`）；非 ENOENT 配置错误阻止 Runner；`[evolution]` 严格 schema；context 冻结 bounds + 整快照 cross constraint 原子投影；EvolutionStore bounded strict JSONL decoder（V1 写入、legacy-v0 兼容 provenance、future schema fail-closed、固定诊断码、路径构造前验证）；non-context persisted apply/rollback deny-only。
- **独立 reviewer（通用 agent，非 writer）**：R1 发现 1 Important（`__proto__` TOML 段经 `assign()` 写入 `Object.prototype` 可绕过 exact-boolean 门）→ 修复（parser 魔术段拒绝 + 门 own-property 守卫 + 回归测试）→ R2 全量重审 **0 Critical / 0 Important**（2 Minor 留存见 §9.4）。
- **Binding gates（isolated clean candidate tree）**：core 61/61、storage 73+1 skipped、shared 100/100、config 14/14、CLI 137/137；全仓 `turbo run test --force` 51/51、`typecheck --force` 55/55；脚本组 64/64；`verify:config-docs`、`verify:error-codes`、docs build（typedoc+vitepress）、format、lint（0 errors）、`git diff --check` 全绿。
- **环境归因**：首次把候选树放在 `/tmp` 导致 CLI/shared 测试因 `validateWorkspacePath` 拒绝 `/private/tmp` 而失败——纯候选树位置问题，移到 `/Users/mark/myself/code/apollo-code-t1a-verify` 后全绿；非产品缺陷。

### 3.3 ABI-00 文档冻结 — `df4a2dd`（已提交）

- **Frozen candidate**：staged ABI-only patch SHA-256 `f9b06a001ef5d78812af514606bf227534b4ec083136b1d70c203281863aa6ae`；verified candidate tree / commit tree `d3bb1aed8e1c0f3ab7b510807bfdbf426b4fdd29`（commit tree 已核对相等）。
- **Staged blobs**：plan `4ca6d7c2…5528`、§18 `9a3ba6aa…96ef`、§19 `ad1700c8…46b3c`、§19a `b9cdf9e2…747e`、README `133c4d4a…18da`。
- **范围**：恰好 5 个文件（M plan、M §18、M §19、A §19a、M README）。README/§19 为 partial-stage：全部 §20/Harness 及 §20 navigation hunks 被排除（staged diff 中 `§20`/`20-harness` 计数为 0）。
- **两位独立 reviewer（均非 writer）**：
  - byte/crypto/registry lane：R1 发现 1 Important（`sanitizedReasonEvidence.mediaRole:"sanitized-nonSECRET"` 与 `ClosedMediaRoleV1` 闭枚举冲突）→ 修复（字段改名 `evidenceKind` + `SanitizedEvidenceKindV1` 名义不相交声明）→ R2 **0C/0I**（1 Minor 暂缓，见 §9.4）。golden vector SHA-256 与 Ed25519 test vector 由 reviewer 独立重算验证通过。
  - state/identity/recovery lane：R1 **0C/0I**（3 Minor，其中 mode 无命中拒绝、RESERVED 过期边两条已随修复轮关闭；RECONCILING 边集暂缓）→ R2 **0C/0I/0M**。
- **Binding gates（isolated clean candidate tree）**：build 27/27、test 51/51、typecheck 55/55（全部 0 cached）、docs build、l1-docs+packlist 8/8、plugin-runtime 94/94、脚本组 64/64、lint 0 errors、format、`git diff --check`、stale-phrase 扫描（语义逐条核对）全绿。
- 此前 ABI writer 报告的“完整 docs build 被 storage TypeDoc 错误阻止”在 isolated 树中不复现——是 shared moving worktree 的中间态，非候选内容问题。

### 3.4 §20 Harness 章节 — `3b0503d`（已提交）

- **Frozen candidate**：staged patch SHA-256 `cee98232b57f6f7e86c3b38a889d0de88599b9d9852b09c32370a90902d8bff9`；verified candidate tree / commit tree `5eed000befb4db385aedc8ae7dfbb50ce29f7b2d`。
- **范围**：恰好 3 个文件（A `20-harness.md`、M README §20 hunks、M §19 §20 navigation 行）。
- **审计阻断全部修复**：HarnessSpec 改 domain-separated canonical digest（禁裸 SHA-256）+ `harnessBuild`/`activeCapabilities` 绑定；H-1…H-14 改为验收宪法口径并登记 H-2/H-8/H-12/H-13 证据缺口；driver 表修正为真实 CLI（`apollo chat "<prompt>" --json` / `--no-tui`，无 `-p`，无 stdin 管道 prompt，headless 权限 fail-closed deny）；`packages/hooks`、`packages/memory-runtime` 拆当前路径（plugin-runtime/storage）与目标归属（含 HookRegistry 契约目标归 core、当前代码不存在的如实标注）；§16 降级为冻结基线表述；★ 降为职责级；H3 拆分为 H3a（human-directed）/H3b（§18 K3，止于本地 branch + STAGED_DISABLED）。
- **独立 reviewer（非 writer）**：R1 **0C/0I**/1 Minor（driver 表状态列未对齐 §10/§16 词汇）→ 修复（改 `verified-local`（§16 基线））→ R2 **0C/0I/0M**。
- **Binding gates**：build 27/27、test 51/51、typecheck 55/55、docs build、l1-docs+packlist 8/8、脚本组 56+8/64、lint 0 errors、format、`git diff --check` 全绿。

## 4. 已完成：T1b tuning journal / crash recovery — `5c85d82`

- **Frozen candidate**：staged patch SHA-256 `ab15bf66846906ef186c62743808fcd9a483a1797a7701b75b017f0c79d09e03`；verified candidate tree / commit tree `0d17b93d5425f599dccbc6856a29ffdab2c07ac1`（commit tree 已核对相等）。
- **范围**：11 个文件（storage 实现+测试、core 类型+测试、shared error-codes、cli ports/runtime/doctor/测试、§15 v2.3、changeset）。
- **内容**：flat V2 wire 记录（`recordId` 32-hex + per-namespace 单调 `sequence`，锁内分配、调用方 identity 一律剥离）；`.evolution-lock.json` 跨进程锁（O_EXCL + pid 存活检查，仅 demonstrably-dead 可接管）；`.evolution-txn.json` journal（PREPARED→NAMESPACE_DURABLE→BOTH_DURABLE，逐步 fsync）；恢复语义：BOTH_DURABLE 仅在两文件尾部逐字节等于 journal 行时 commit，PREPARED/NAMESPACE_DURABLE 默认在 prefix digest 验证后截断回 pre-size，无法证明→RECOVERY_REQUIRED（拒绝一切 mutation，doctor warn-only 提示，人工移除后恢复）；TuningMemoryStore id 先验证后拼路径；storage 源保持 Node strip-types 可加载（无 parameter properties）。
- **独立 reviewer（非 writer）**：一轮 **0 Critical / 0 Important** / 3 Minor（两偷锁者残窗-文献化 best-effort、4 条 crafted-state 测试缺口、doctor 行无 CLI 测试）；reviewer 另做了 12 轮真实 SIGKILL 崩溃窗口枚举与双 store/双进程并发 probe，全部恢复为字节一致状态。
- **Binding gates（isolated tree 0d17b93d）**：build 27/27、test 51/51、typecheck 55/55（0 cached）；脚本组 64/64；docs build；storage 85+1 skipped、cli 138、core 62；lint 0 errors（546 warnings = 基线 536 + 10 条测试 JSON.parse 断言告警）；format、diff --check 全绿。
- **诚实边界**：文件内容 fsync；新文件创建的跨断电持久性受无可移植目录 fsync 限制（Windows 披露）；锁是协调原语非安全边界；audit 数据在 T1/T2 promotion evidence 使用前仍需独立评审。

## 5. 正在进行的未提交工作

无。工作树当前干净。

## 6. §20 Harness 审计结论（已关闭）

原阻断（HarnessSpec digest、现状声明、driver、package ownership、H3a/H3b）已全部修复并随 `3b0503d` 提交。遗留非阻断 Notes：§20.7 的 domain prefix 是 §19a.3.2 两段式 domain 的缩写表述；D5 草案退出码 `3` 与当前 cli.ts 已有 `3` 用法需在 H2 冻结时对齐；`readStdin` 除 `--api-key-stdin` 外还供 `memory --body-stdin`。

## 7. 下一实现任务：ABI-00 contract packages

按实施计划 §6（ABI-00-01）：新建 private `packages/capability-contract`（pure schema/canonical/crypto/verifier-only，含 `authority` 子路径不进 root barrel），以已冻结的 §19a 为 normative 输入，实现 bootstrap meta-schema + single versioned registry + TS/Rust 生成器 + 共享 golden/reject corpus（含 large-recipes）；registry 阶段需补齐两个暂缓 Minor：D/E/N 表 `InvocationDecisionProof` 行的机器推导数字、`RECONCILING` ledger 边集。P0-00 fence 保持关闭；production runtime/native/CLI import = 0。完成后再进入 P0 Rust reference monitor。

T1b 必须是独立提交，从 T1a 已提交的 base 继续：

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

**T1b 第一条可执行命令**（先读 T1a 已提交的实现）：

```bash
git -C /Users/mark/myself/code/apollo-code show 6dd0b20 --stat && \
sed -n 1,120p /Users/mark/myself/code/apollo-code/packages/storage/src/evolution-store.ts
```

## 8. 下一步执行顺序（更新）

1. ~~T1a 最终复审与独立提交~~ → **已完成（6dd0b20）**。
2. ~~ABI-only staged patch + 双路 0C/0I + 独立提交~~ → **已完成（df4a2dd）**。
3. ~~§20 Harness 修复 + 独立复审 + 独立提交~~ → **已完成（3b0503d）**。
4. ~~T1b journal/recovery~~ → **已完成（5c85d82）**。
5. 品牌 discovery/freeze 可并行准备，但最终 identity tuple 由用户确认（硬门见 §9）；此时不得改 production identity。
6. **实现私有 TypeScript/Rust contract packages + shared canonical/crypto/reject corpus**（ABI-00 实现阶段，见 §7；输入是已冻结的 §19a）。
7. 关闭 P0 Rust reference monitor：最小 fs view、逐平台真实 OS sandbox feature、origin-level network、resource limits、identity-pinned executable、secret/token 不外泄；未取证平台必须 downgrade/unavailable。
8. 实现 CAT-01/02 closed-role evidence/Catalog primitives。
9. cleared identity + CAT-02 后执行 BRAND-MIGRATE；在 branded exact SHA 执行 BRAND-VERIFY 并重新取得 product/security/platform/supply-chain 签字。
10. BRAND-VERIFY 后接 ABI runtime activation、typed brokers 和 universal registry。
11. 实现 HarnessDefinition/RunBinding + driver conformance（§20 H1/H2），然后完成 H3a human-directed dogfood；H3a 不能冒充 §18 自我开发。
12. 实现 SelfDev control plane、restricted Developer、base-owned checks、独立验收、human receipt、branch-only promotion。
13. 第一条 K3 完整 proof 与 H3b controlled SelfDev dogfood 只能结束于本地 branch + Catalog STAGED_DISABLED；不得自动 adoption/enable。
14. 完成 full release evidence 后再进入 prerelease/beta 人工门。

## 9. 品牌与 logo 的硬门

完整品牌决策、视觉语义、identity tuple、迁移顺序和验收门见：

> [Brand Identity & Migration Plan](./2026-08-22-brand-identity-and-migration.md)

用户要求品牌突出：AI + 安全 + 极简，同时体现 plugin cells / sandbox boundary / Rust enforcement。精确架构表述统一为：`Everything extensible is a capability plugin; the K0 security kernel is not.` K0 是非穷尽集合，包括 sandbox/reference monitor、permission/policy、identity/trust、canonical/signature verifier、Catalog reducer/journal、mandatory security hooks/secret guard、核心 state/promotion invariants 与 human gates。

历史决策必须准确解释：用户曾在“AI + 安全”轮次选择 `Cereward AI`，但该名称随后触发先前 clearance 否决门并停止落库，状态为 `WITHDRAWN / DO NOT USE`。`Evalistry` 被用户后续的“名字不好”推翻，`Rigorbind` 也未通过 clearance，三者都不是当前候选。用户随后加入 Everything is Plugin + Sandbox + Rust，使品牌语义重新打开。主 Logo 工作方向是 **Controlled Port**：可替换 capability cell + 连续 sandbox/K0 boundary + single logical K0 authority chokepoint；成品仍待用户视觉确认，Rust-enforced 声明仍须逐平台、逐 surface 取证。

但最终 identity tuple 尚未确认，不能猜测，更不能全局替换 `Apollo`。**等待用户确认的硬门**：全新名称更偏“可信边界”还是更偏“受控演进”？（推荐“可信边界”，把受控演进放入 tagline/feature narrative；不得复活旧候选。）

## 10. 验证证据与常用命令

### 9.1 本轮 binding-gate 命令容器（isolated clean candidate tree）

```bash
# 候选树构造（每次候选 frozen 后）
git worktree add --detach <verify-path> HEAD
git -C <verify-path> apply --index <frozen.patch>
test "$(git -C <verify-path> write-tree)" = "<frozen index tree SHA>"

# 门（在 <verify-path> 内）
pnpm install --frozen-lockfile
pnpm turbo run build --force        # 27 tasks
pnpm turbo run test --force         # 51 tasks
pnpm turbo run typecheck --force    # 55 tasks
pnpm --dir apps/docs build          # typedoc + vitepress
node --test scripts/*.test.mjs      # 14 个 script 测试文件，合计 64
pnpm verify:config-docs && pnpm verify:error-codes
pnpm format:check && pnpm lint      # lint 基线：536 warnings / 0 errors
git diff --cached --check
```

注意：`/tmp` 下的候选树会被 `validateWorkspacePath` 拒绝（`invalid_workspace`）——候选树必须放在守卫接受的路径（如 `/Users/mark/myself/code/` 下）。

### 9.2 已通过的基线（历史）

- plugin-runtime targeted：94/94；packlist deny-only；`cargo test --workspace`；`pnpm test` 主体。
- changeset release-plan test 涉及 `.git/worktrees` 读取，在本环境已随当前 worktree 布局通过（脚本组 64/64 内含）。

### 9.3 测试通过数（本轮 isolated 树，全部 0-cached 强制执行）

| 候选 | 关键数字 |
|---|---|
| T1a（tree 786f6ae8） | core 61/61；storage 73+1 skipped；shared 100/100；config 14/14；CLI 137/137；turbo test 51/51；typecheck 55/55；scripts 64/64 |
| ABI（tree d3bb1aed） | turbo test 51/51；typecheck 55/55；plugin-runtime 94/94；l1-docs+packlist 8/8；scripts 64/64 |
| §20（tree 5eed000b） | turbo test 51/51；typecheck 55/55；l1-docs+packlist 8/8；scripts 56/56（另 8 条已随 l1-docs/packlist 单独跑） |
| T1b（tree 0d17b93d） | build 27/27；test 51/51；typecheck 55/55；scripts 64/64；storage 85+1 skipped；cli 138；core 62；lint 0 errors/546 warnings |

### 9.4 留存 Minor / Note（不阻断，后续阶段吸收）

- T1a M-1：`loadProductionContextTuning` 缺 EACCES 定向测试（代码路径已验证 rethrow）。
- T1a M-2：decoder/projection 若干边角（non-plain prototype、symbol key、ISO 日历非法）有 probe 证据但无 staged 测试。
- T1a N-1：`TuningMemoryStore.write/read` 把 `input.id` 直接 join 进路径（无生产调用方；未来接线前必须修）。
- T1a N-2：engine `allowed()` 允许 `tool:*:timeout_ms`，store decode 拒绝——未来 T1+ 接线时对齐。
- ABI M-3（lane A）：D/E/N 表缺 `InvocationDecisionProof` parent 行——由 registry 生成阶段用机器推导数字补齐，不用散文拍数。
- ABI M2（lane B）：`RECONCILING` ledger 边集未显式画出——registry 阶段冻结边集。
- T1b M-1：偷锁者残窗（先读存活后 rename 的抢占交错）——文献化 best-effort 锁语义内，结局 fail-safe。
- T1b M-2：4 条 crafted-state 测试缺口（错误 prefix digest、sizeBefore>实际、BOTH_DURABLE 单文件缺失、live-holder 超时）——reviewer probe 验证行为正确。
- T1b M-3：doctor evolution 行的 CLI 级测试缺失（storage 级 health() 已测）。
- §20 Notes：见 §6。

## 11. 暂存/提交纪律（本轮已按此执行）

- 每个安全切片独立提交；不 stage 未审文件。
- 每次 commit 前执行 `git diff --cached --check`、`git diff --cached --name-status`、完整 cached diff 审读、frozen patch/index tree SHA 复核。
- 共享 dirty worktree 上的测试只作 diagnostic；binding evidence 来自与 frozen index tree 完全一致的 isolated clean candidate tree（`git worktree` + `apply --index` + `write-tree` 相等证明）。
- reviewer 与 writer 分离；发现 Critical/Important 回 writer 修复后以新 hash 从头复审。
- commit 后 `git rev-parse HEAD^{tree}` 必须等于已验 candidate tree。
- 不使用 `git reset --hard`、`git checkout --` 或 destructive cleanup；不 amend，不 push。

## 12. 可对用户使用的诚实口径

> 方向不需要推翻：项目已经有 functional agent-harness foundation；§15 T1a/T1b 的 default-off 与 journal 化可信持久化、ABI-00 字节级合同冻结、§20 harness 架构层冻结均已提交并通过独立复审。当前生产自进化尚未实现，也不能开启；第一阶段只会交付经过独立验收、人工签收、最终保持 disabled 的本地候选。
