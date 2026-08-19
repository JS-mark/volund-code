# Controlled Self-Development 实施计划（2026-08-19）

> **状态**：PROPOSED / UNSTARTED。本文是实现顺序和 evidence contract，不表示任何 Self-Development 能力已经交付。
>
> **权威规范**：[§18 受控自我开发 / 变更流水线](../specs/2026-07-31-apollo-code-design/18-self-development.md)；运行时参数 tuning 另见 [§15](../specs/2026-07-31-apollo-code-design/15-self-evolution.md)。
>
> **目标 release**：`0.1.0-beta.1`，范围止于 SD4 branch-only。SD5 不进入该 beta。
>
> **Brand gate**：canonical identity、package scope、CLI binary/name、logo 和迁移映射均等待用户选择。本文只使用当前仓库名或中性工作名，不指定最终品牌。

## 0. 结果定义与范围

目标是交付一条可审计的生产路径：

```text
显式提案 → 同环境 baseline → 受限 Developer → immutable seal
→ 确定性 verification/holdout → 独立 Reviewer → 人工 approval receipt
→ 本地 branch-only promotion
```

`0.1.0-beta.1` 不包含自动 push、merge、PR、tag、publish、部署或 release，也不包含自改 policy/orchestrator/permission/sandbox/auth/CI/release/trust/approval store。普通 Agent 使用 Edit/Bash 不属于本计划的 Self-Development。

本计划严格串行；任务依赖链为：

```text
SD0-01 → SD0-02 → SD0-03
→ SD1-01 → SD1-02 → SD1-03
→ SD2-01 → SD2-02 → SD2-03
→ SD3-01 → SD3-02 → SD3-03
→ SD4-01 → SD4-02 → SD4-03
→ BRAND-01 → REL-01 → REL-02
→ SD5-01（post-beta，可选）
```

前一项未达到 exact-SHA evidence 和 human gate，后一项只能写设计/fixture，不能连接 production entry。

## 1. 统一证据与人工门禁

每个任务完成时必须附：

1. exact commit SHA、变更路径、spec 小节、威胁/失败模式和未覆盖项。
2. 受影响 package 的 test/typecheck、必要 integration/E2E、`git diff --check`；命令、exit code、日志 artifact digest。
3. composition-root 证据；仅有 interface/class/unit test 的状态最多为 `implemented-unwired`。
4. 安全任务的攻击 fixture、预期 deny 原因和 fail-closed 断言；不能只断言“没有崩溃”。
5. 独立 reviewer 的结论。标为“Human gate: required”的任务必须记录 actor、时间、decision 和 evidence digest，聊天里的口头“可以”不够。
6. 任何凭据、付费服务、真实硬件、签名、notarization、registry/publication 都单列 external gate，不用 mock、QEMU 或 self-signed 证据代替。

建议新增的工作包名为 `packages/self-development`，仅是当前仓库内的**中性工作路径**；最终 package name/scope 由 `BRAND-01` 决定。它拥有纯领域模型、reducer、policy 和 orchestrator ports；具体存储适配放 `packages/storage`，sandbox/process 适配放 `packages/native-bridge`，CLI composition 放 `apps/cli`，fixtures 放 `packages/testkit`。不能把该能力塞进现有 `EvolutionEngine`。

## 2. 任务总览

| ID | 阶段 | 交付 | 依赖 | Human gate |
|---|---|---|---|---|
| `SD0-01` | SD0 | 修复 SAFE_BASH 前缀/控制符注入 | 无 | Security reviewer required |
| `SD0-02` | SD0 | 修复 builtin Hook >1MB 截断绕过 | SD0-01 | Security reviewer required |
| `SD0-03` | SD0 | 冻结 threat model、路径分类、off-by-default 和测试骨架 | SD0-02 | BDFL/product + security required |
| `SD1-01` | SD1 | 数据模型、状态 reducer、transition contract | SD0-03 | Architecture reviewer required |
| `SD1-02` | SD1 | CAS/lease/hash journal/idempotent effect store | SD1-01 | Storage/security reviewer required |
| `SD1-03` | SD1 | 隔离 worktree、ArtifactRef、manifest/seal | SD1-02 | Security reviewer required |
| `SD2-01` | SD2 | base-SHA policy intersection 与 protected surfaces | SD1-03 | Security + repository owner required |
| `SD2-02` | SD2 | Restricted Developer Runner 与 typed file tools | SD2-01 | Security reviewer required |
| `SD2-03` | SD2 | budgets、repair generation、cancel/recovery | SD2-02 | Product owner required |
| `SD3-01` | SD3 | `Check.run(suiteId)` 与可复现环境 | SD2-03 | Security/build owner required |
| `SD3-02` | SD3 | baseline/candidate verifier、holdout、evidence bundle | SD3-01 | Eval owner required |
| `SD3-03` | SD3 | 独立 Reviewer、AcceptanceReport、shadow eval | SD3-02 | Independent acceptance reviewer required |
| `SD4-01` | SD4 | Human challenge / ApprovalReceipt | SD3-03 | BDFL/product + security UX required |
| `SD4-02` | SD4 | 本地 branch-only Promotion Worker | SD4-01 | Repository owner required |
| `SD4-03` | SD4 | production composition、CLI、跨平台 E2E | SD4-02 | Production readiness sign-off required |
| `BRAND-01` | Brand | canonical identity 决策与原子迁移 | SD4-03 | **User decision required; currently pending** |
| `REL-01` | Release | `0.1.0-beta.1` immutable candidate/evidence | BRAND-01 | Release review required |
| `REL-02` | Release | beta publication（若 external gates 全闭合） | REL-01 | Release custodian explicit approval required |
| `SD5-01` | SD5 | post-beta bounded proposal/shadow 扩展 | REL-02 | Separate product/security opt-in required |

## 3. SD0 — 先关闭安全 P0

### SD0-01 · SAFE_BASH 必须结构化、完整匹配

- **Scope**：修改 `packages/permission` 的 Bash auto-allow。移除当前 prefix regex 作为授权依据；解析/规范化只读命令，拒绝 `;`、`&&`、`||`、pipe、redirect、newline、subshell、command substitution、额外 executable 和未知 flag。优先使用 typed argv；无法无歧义解析即弹窗/deny。禁止扩大现有 allowlist。
- **Dependencies**：无；它是所有专用 Runner 之前的 P0。
- **Tests/evidence**：`packages/permission/src/index.test.ts` 增加 table corpus，至少覆盖 `git status; <write>`、`git diff && <write>`、newline、pipe、redirect、backtick、`$()`、Unicode whitespace、quoted control token、合法只读 argv；运行 `pnpm --filter @apollo-code/permission test`、typecheck 和依赖它的 CLI permission integration。攻击用例必须证明未 auto-allow。
- **Human gate**：独立 security reviewer 审查 parser/allowlist 和完整攻击 corpus；未签字不得开始 SD0-02。

### SD0-02 · Builtin Hook 不得因截断漏扫后缀

- **Scope**：修改 `packages/plugin-runtime` 的 builtin Hook payload gate。当前 >1MB payload 在 dispatch 前截断会让危险内容藏在未扫描后缀；改为 full-payload bounded streaming scan，或对超限 builtin payload 直接 fail-closed。记录 raw digest、scanned digest/length 和 typed denial；不得先截断再当作“已完整审查”。非 builtin fail-open 语义不得扩散到安全 Hook。
- **Dependencies**：SD0-01。
- **Tests/evidence**：在 `domain-hooks.test.ts` 增加危险片段位于 1MB 之后、UTF-8 边界、深层 JSON、超限、timeout/crash fixture；断言 builtin 全部 veto 且 tool 未执行，plugin/project/user 原有语义保持。运行 `pnpm --filter @apollo-code/plugin-runtime test`、typecheck 和 tool-hook E2E。
- **Human gate**：独立 security reviewer 核对扫描覆盖、资源上限、DoS 行为和 fail-closed 日志；未签字不得开始 SD0-03。

### SD0-03 · 冻结 Self-Development threat model 与安全默认

- **Scope**：在新工作包建立 threat-model fixtures、path classification schema、角色矩阵、dangerous-flag hard deny 和 policy version contract；将 §18 所有子系统配置为未注册/默认 off。同步修正 §15 legacy 默认的后续实现任务：缺省 runtime tuning 必须 off，shadow/apply 需注册 schema 和迁移，不能顺手连接 apply。
- **Dependencies**：SD0-02。
- **Tests/evidence**：文档/config/event verifier；policy fixture 验证 builtin deny 不能被 user/base 放宽；production command tree 中不存在 `selfdev` entry；§15 缺省 off 的 config/CLI/runtime migration tests（若该修复与本任务同 PR，否则作为 blocking linked change）。记录 protected category 到实际路径的首版映射。
- **Human gate**：BDFL/product owner 确认 v1 scope；security owner 确认 threat model、protected surface 和 default-off。两者缺一即 blocked。

## 4. SD1 — Contracts、Store 与 Worktree

### SD1-01 · 领域模型与确定性 reducer

- **Scope**：新建 `packages/self-development`（工作路径），实现 §18 的 `SelfDevRun`、Baseline/Candidate/Verification/Acceptance/Approval/Promotion types、typed reasons、domain-separated canonical encoding 和纯状态 reducer。明确区分 existing `baseRef@baseSha` 与事前不存在的 `promotionRef`。Reducer 不 import provider、tools、CLI 或 storage；模型输出永远是 input data，不直接 transition。
- **Dependencies**：SD0-03。
- **Tests/evidence**：表驱动覆盖 §18 每条允许 transition、统一 FAILABLE/CANCELLABLE 集和 PROMOTING commit point；所有未列 transition、终态恢复、version mismatch、missing guard、inconclusive-as-pass 均拒绝。加入 property/fuzz test 验证任何状态序列都不能绕过 SEALING/VERIFYING/ACCEPTING/AWAITING_HUMAN，且 cancel/promotion CAS 竞态只收敛到 CANCELLED 或 COMPLETED/FAILED。运行新包 test/typecheck 和 architecture dependency test。
- **Human gate**：独立 architecture reviewer 对照 §18 transition table 逐行签字。

### SD1-02 · CAS、lease、tamper-evident journal 与 effect receipts

- **Scope**：在 `packages/storage` 增加 SelfDev adapter，实现 atomic compare-and-swap、短 lease、hash-chain journal、checkpoint、single-use nonce/effect receipt 和 crash-safe append。Orchestrator port 只接受 expectedVersion/effectKey；禁止 last-write-wins。
- **Dependencies**：SD1-01。
- **Tests/evidence**：并发双 writer、lease expiry/steal、journal truncate/reorder/duplicate/unknown schema、checkpoint rollback、intent 前/后 crash、receipt 前/后 crash；每个 side-effect 边界故障注入后 exactly-once。运行 `pnpm --filter @apollo-code/storage test`、typecheck、Windows/Linux filesystem fixture；保存 store bytes 和恢复状态 digest。
- **Human gate**：storage reviewer + security reviewer 确认 durability/tamper/fail-closed 语义。

### SD1-03 · 隔离 worktree、ArtifactRef 与 immutable seal

- **Scope**：实现 typed Git/worktree adapter、content-addressed artifact store、canonical file manifest、patch/tree/candidate digest、read-only seal 和 cleanup。Adapter 使用固定 executable/argv、`shell:false`；候选不能触达 `.git` 控制面。用户当前 worktree/index/未提交文件永远不变。
- **Dependencies**：SD1-02。
- **Tests/evidence**：dirty user worktree 不变；symlink/hardlink/path traversal/case collision/mode bit/rename/binary file；seal 后 write/TOCTOU 全失败；artifact path 替换但 digest 不同会拒绝；取消/崩溃清理可重复。运行 self-development、storage、native-bridge 集成测试和 Git 版本矩阵 fixture。
- **Human gate**：security reviewer 核对隔离边界；repository owner 确认不污染当前 worktree/ref。

## 5. SD2 — Restricted Developer

### SD2-01 · base-SHA policy intersection 与 protected surfaces

- **Scope**：实现 `builtinMaximum ∩ userPolicy ∩ baseShaPolicy`，固定 canonical policy digest；建立 default-deny 路径分类。最低 protected：SelfDev 控制面、Permission、Sandbox/native、Auth/secret、Plugin/Hook trust、Skill auto-activation、approval/journal/artifact、CI/release/signing、`.git`、依赖 manifests/lockfile、工作区外路径。候选 policy/AGENT/Skill/Plugin/CI 不参与当前 run。
- **Dependencies**：SD1-03。
- **Tests/evidence**：每一 protected category 至少一个真实路径和新增未知路径 fixture；user/base 尝试扩大 builtin、candidate 修改 policy、symlink/case/rename/Unicode 绕过全部 deny；policy missing/parse/version error fail closed。输出机器可读 coverage 报告，未分类路径数量必须为 0。
- **Human gate**：security owner 和 repository owner 对首版路径映射逐项确认；任何例外必须写 RFC，不能在 prompt 中临时允许。

### SD2-02 · 专用 Developer Runner 与 typed tools

- **Scope**：实现 `selfdev.developer` profile，只开放允许路径的 typed Read/Grep/Glob/Edit/Write 和已注册的 `Check.run` port；禁用普通 Bash、Task/subagent、network、secrets/env、MCP/Plugin、自动 Skill、persistent Memory、dangerous flags 和普通 permission cache。Developer lease 只在 `DEVELOPING` 有效。
- **Dependencies**：SD2-01。
- **Tests/evidence**：对每个禁用能力做直接调用、prompt injection 和 indirect tool fixture；断言拒绝发生在执行前且 journal 有 typed reason。状态离开 DEVELOPING/lease 过期后，旧 tool token 100% 失败。真实模型 smoke 只能作为补充，不替代 deterministic boundary tests。
- **Human gate**：独立 security reviewer 审查 capabilities diff 和 sandbox profile；不得用“模型会遵守”关闭缺口。

### SD2-03 · Budgets、repair generation、cancel 与 Developer recovery

- **Scope**：实现 tokens/cost/time/tool/file/lines/artifact/suite/concurrency/repair 硬预算；repair 只创建新 generation；cancel 两阶段停止/清理且在 PROMOTING commit point 后拒绝；Developer crash 通过 lease/CAS 恢复。安全失败/篡改/isolation 失败不可自动 repair。
- **Dependencies**：SD2-02。
- **Tests/evidence**：逐预算的边界-1/边界/边界+1；超限后无额外 write/tool；repair 保留旧 manifest 且新 digest；每个开发 effect 边界 crash；并发 cancel 与 seal 竞态。E2E 覆盖 `FAILED`、`CANCELLED` 和 repair exhausted。
- **Human gate**：product owner 确认默认预算/最大 repair 次数和成本提示；security owner确认不可修复类别。

## 6. SD3 — Verifier、Eval 与独立 Reviewer

### SD3-01 · Trusted `Check.run(suiteId)` 与同环境执行

- **Scope**：在 self-development 工作包实现 trusted suite registry 和 `Check.run`；suite 只来自 builtin/base SHA policy，固定 executable/argv/env/timeout/sandbox/output contract，`shell:false`。Base/candidate 使用相同 environment digest；candidate scripts/config 只能作为 untrusted 被测输入。
- **Dependencies**：SD2-03。
- **Tests/evidence**：command/control 字符、候选 package script、PATH shadow、env injection、network/secret access、output spoof、timeout、OOM、missing artifact 全 fail closed；base/candidate 两次运行 environment digest 相同。运行 native sandbox escape、check-runner integration 和 reproducibility tests。
- **Human gate**：build owner 确认 suite command graph；security reviewer 确认候选代码执行 sandbox 和无 secret/network。

### SD3-02 · Baseline/Candidate verifier、holdout 与 VerificationBundle

- **Scope**：实现 BASELINING/VERIFYING worker、required/safety/holdout suites、deterministic graders、ArtifactRef evidence 和 bundle digest。Holdout 对 Developer 不可见；反馈只暴露规范化类别。Baseline 失败处理必须由 base policy 明确，不能默认忽略。
- **Dependencies**：SD3-01。
- **Tests/evidence**：pass/fail/inconclusive/baseline-existing-failure/timeout/crash/environment drift/holdout leak fixture；同输入重复两次 bundle digest 一致；missing/modified evidence、伪造 stdout、candidate 更改 test/config 都不能提升 verdict。记录 trajectory/quality/cost/safety 四类指标。
- **Human gate**：eval owner 批准 required/holdout 来源、泄漏模型和 grader 阈值；安全 suite 必须零失败。

### SD3-03 · 独立 Reviewer、AcceptanceReport 与 shadow E2E

- **Scope**：实现 `selfdev.review` 无工具 profile、新会话/身份、sealed-only 输入、untrusted wrapping、isolation attestation 和 AcceptanceReport。Reviewer 只能 `accept|repair|reject|inconclusive`，不能修改 candidate、verification 或状态。完成 SD3 shadow pipeline，但 promotion API 保持不存在。
- **Dependencies**：SD3-02。
- **Tests/evidence**：证明 reviewer 看不到 Developer transcript、临时文件、Memory、自动 Skill、Plugin、holdout secret；candidate prompt injection 不能取得工具/审批；deterministic fail 无法被模型改 pass。Shadow E2E 覆盖完整 pass、repair、reject、cancel、crash recovery 和 stale base，重复运行保存 metrics。
- **Human gate**：由未参与 Developer 实现的 acceptance reviewer 检查 isolation evidence 和一组 sealed reports；product owner 接受 shadow UX。

## 7. SD4 — 人工批准与 Branch-only Promotion

### SD4-01 · Human challenge 与 ApprovalReceipt

- **Scope**：实现认证 actor、128-bit nonce、TTL、domain-separated canonical signature 和 request-changes/reject。区分两次 single-use：challenge nonce 在签发 ApprovalReceipt 时消费；ApprovalReceipt 在 `APPROVED → PROMOTING` 时消费并生成 ApprovalConsumption。UI 必须展示 run、`baseRef@baseSha`、新 `promotionRef`、candidate/policy/PromotionPlan/verification/acceptance 全 digest、commit plan、diff、suite、budget、repair、安全结果。无 `--yes`/`--force`/env/stdin/model confirmation。
- **Dependencies**：SD3-03。
- **Tests/evidence**：非 TTY、pipe/stdin、`--yes`、重放、过期、wrong actor、nonce race、receipt consumption race、任一 digest/ref/commit plan 替换、base race、promotionRef 预占、request-changes 后旧 challenge/receipt 全拒绝；nonce 与 receipt 各自只能消费一次。安全 UX 测试必须验证用户看到了完整绑定摘要再签发。
- **Human gate**：BDFL/product owner 做真实交互验收；security reviewer 审批身份、signature、nonce/TTL 和 replay 模型。没有两方签字不得连接 promotion。

### SD4-02 · Typed Git 本地 Branch-only Promotion Worker

- **Scope**：实现 `selfdev.promote`，重新验证 receipt/digest/freshness，以固定 Git argv/typed adapter 创建 PromotionPlan 指定的精确 commit/ref：parent=`baseSha`、tree/metadata 已审批、`promotionRef` 事前不存在。只允许本地未检出 branch；不运行 hooks，不读 credential，不访问 remote，不修改 current branch/index/worktree。effect intent/PromotionReceipt 支持 crash exactly-once。
- **Dependencies**：SD4-01。
- **Tests/evidence**：dirty worktree、promotionRef 已存在、baseRef moved、receipt expired/replayed、cancel 与 commit-point CAS、crash before/after object/ref/PromotionReceipt、Git hook、remote URL/credential trap；网络 mock 必须观测 0 请求，current worktree hash 保持不变，最终 ref 的 parent/tree/metadata 与获批 PromotionPlan 完全一致。
- **Human gate**：repository owner 对真实临时仓库演示确认 branch-only、无 hooks/remote/current-worktree mutation。

### SD4-03 · Production composition、CLI 与跨平台 E2E

- **Scope**：在 `apps/cli` 注册 §18 API/`apollo selfdev` working namespace，连接 orchestrator/workers/store/Runner profiles；默认 off，仅显式 propose/start。实现 status/evidence/cancel/request-changes/reject/approve；文档、doctor、machine JSON 和 capability matrix 诚实披露 beta/branch-only。
- **Dependencies**：SD4-02。
- **Tests/evidence**：composition-root 测试证明每个 production port 已连接；CLI golden/JSON、restart/crash、multi-process CAS、supported OS path/Git/sandbox E2E；禁止命令与 remote side effect 断言；全仓 typecheck/test/build、docs、config/event verifiers、same-SHA CI。SD4 attack matrix 100% 预期 deny。
- **Human gate**：独立 production readiness review + security sign-off + product UX acceptance。完成后状态最多为 `verified-ci`；未完成品牌/release gate 不得称 release-ready。

## 8. Brand phase（最终身份待用户决定）

### BRAND-01 · Canonical identity 决策与原子迁移

- **Scope**：**先等待用户给出最终 canonical identity**；随后建立唯一 source-of-truth 映射，原子迁移 package scope/names、CLI binary、config/home paths、env prefixes、docs/URLs、GitHub/npm metadata、telemetry namespaces、native artifacts、signing identifiers 和兼容 alias/deprecation。Logo/视觉资产只有在用户确认 identity 与视觉方向后另行设计。不得在本计划中创造候选品牌。
- **Dependencies**：SD4-03；此外依赖用户明确选择名称、scope、CLI 命令、域名/仓库归属和兼容期限。
- **Tests/evidence**：identity string inventory 前后对账为 0 未分类；fresh install/upgrade/config/session/credential/native resolution/docs links/CLI aliases/package publication dry-run；旧 identity 仅出现在 approved compatibility/history allowlist。迁移必须单独 changeset 和 rollback plan。
- **Human gate**：**当前 BLOCKED ON USER CHOICE**。用户签署 canonical identity/mapping；法律、npm/GitHub/domain 可用性由授权人核验。任何 agent 不得替用户选择名称或生成 final logo。

## 9. `0.1.0-beta.1` release

### REL-01 · Freeze immutable beta candidate

- **Scope**：基于 BRAND-01 后 exact SHA 生成 changeset、release notes、SBOM/checksums、capability/status 表和 candidate manifest。Release notes 明示：SD4 branch-only、default off、无 push/merge/publish automation、SD5 不含；§15 runtime tuning 状态单独披露。生成 release checklist，不改写历史 evidence。
- **Dependencies**：BRAND-01。
- **Tests/evidence**：`pnpm turbo run typecheck test build --force`、docs API/VitePress、release status、frozen-lockfile、native/sandbox matrix（按选择的 beta target scope）、snapshot install in disposable checkout、security/eval bundle、all artifacts same SHA/digest。未满足 external gate 标 `external-pending`，不能用 dry-run 代替。
- **Human gate**：release reviewer 和 security owner 对 candidate manifest、claims、known limitations 签字；任何失败都产生新 candidate SHA 并重跑全部绑定 evidence。

### REL-02 · Human-controlled beta publication

- **Scope**：仅授权 release custodian 可创建 tag/Release/registry publication；使用 protected environment secrets，验证 provenance、checksums、platform disclosure 和安装路径。Self-Development pipeline 本身不能执行本任务。
- **Dependencies**：REL-01 且 [L2 release checklist](../../releases/L2-RELEASE-CHECKLIST.md) 中与所声明 beta target/渠道相关的 repository、credential、hardware、signing/notarization/publication gate 全部有 same-candidate evidence；未关闭则保持 blocked。
- **Tests/evidence**：tag 指向 candidate SHA；published assets 与 manifest 逐个 checksum；registry provenance；clean-machine install/first-run/branch-only smoke；release notes 无 stable/L2 误称；post-publish rollback/incident owner 已登记。
- **Human gate**：release custodian 在看到最终 digest 后显式批准并亲自执行/授权 publication。配置了 workflow、拥有 credential 或 SelfDev receipt 都不是 release approval。

## 10. SD5（post-beta，可选）

### SD5-01 · Bounded autonomous proposals / shadow expansion

- **Scope**：在 SD4 稳定和 beta 数据复盘后，才评估去敏信号触发 proposal、更多可信任务类别和有界 repair。默认仍 off/shadow；每个 proposal 仍走完整 SD4 Human approval，promotion 仍 branch-only。不得增加 push/merge/publish 或 protected-surface 修改。
- **Dependencies**：REL-02、beta incident/cost/quality review、单独 RFC。
- **Tests/evidence**：预先冻结 baseline/eval/holdout 和质量/成本阈值；长期 crash/restart/lease/预算/攻击模拟；新任务类别逐个 threat model 和 suite；Safety 任何失败即退出。报告成功率同时展示人工返工、成本和拒绝率，禁止只报 cherry-picked wins。
- **Human gate**：新的 product decision + independent security review + user opt-in；不得因 `0.1.0-beta.1` 已发布而默认开启。

## 11. Beta 退出判定

只有以下条件同时成立，计划才可标记完成：

- SD0–SD4 每个任务有 exact-SHA evidence 和对应 human gate；§18 状态表按真实 wiring 更新。
- `0.1.0-beta.1` 的 canonical brand 已由用户决定并完成原子迁移；没有 agent 自创的 final identity。
- SelfDev 默认 off、branch-only；无 push/merge/tag/publish path，无 dangerous bypass。
- Baseline、VerificationBundle、AcceptanceReport、ApprovalReceipt 与 promotion receipt 绑定同一 base/candidate/policy digest；stale/timeout/inconclusive 全 fail closed。
- 全仓与目标平台 gates 通过；external/human release checklist 没有被 mock/dry-run/self-signed 证据冒充。
- 发布由 release custodian 完成，Self-Development 自身没有获得发布权限。

若任一项缺失，正确状态是 `partial`、`verified-local`、`verified-ci`、`external-pending` 或 `blocked`，不是“自进化已开启”。
