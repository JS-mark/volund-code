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
→ BRAND-01
→ SD1-01 → SD1-02 → SD1-03
→ SD2-01 → SD2-02 → SD2-03
→ SD3-01 → SD3-02 → SD3-03
→ SD4-01 → SD4-02 → SD4-03
→ REL-01 → REL-02
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

`BRAND-01` 关闭前只允许在文档/一次性 fixture 中使用 `packages/self-development` 作为**中性占位路径**，不能据此建立 production package/CLI identity。用户冻结 canonical identity 后，正式工作包拥有纯领域模型、reducer、policy 和 orchestrator ports；具体存储适配放 `packages/storage`，sandbox/process 适配放 `packages/native-bridge`，CLI composition 放 `apps/cli`，fixtures 放 `packages/testkit`。不能把该能力塞进现有 `EvolutionEngine`。

## 2. 任务总览

| ID | 阶段 | 交付 | 依赖 | Human gate |
|---|---|---|---|---|
| `SD0-01` | SD0 | 移除 raw Bash silent auto-allow | 无 | Security reviewer required |
| `SD0-02` | SD0 | 修复 builtin Hook >1MB 截断绕过 | SD0-01 | Security reviewer required |
| `SD0-03` | SD0 | 冻结 threat model、路径分类、off-by-default 和测试骨架 | SD0-02 | BDFL/product + security required |
| `BRAND-01` | Brand | canonical identity 决策与原子迁移 | SD0-03 | **User decision required; currently pending** |
| `SD1-01` | SD1 | 数据模型、状态 reducer、transition contract | BRAND-01 | Architecture reviewer required |
| `SD1-02` | SD1 | CAS/fencing/signed anchor/effect recovery | SD1-01 | Storage/security reviewer required |
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
| `REL-01` | Release | `0.1.0-beta.1` immutable candidate/evidence/channel manifest | SD4-03 | Release review required |
| `REL-02` | Release | beta publication（若 external gates 全闭合） | REL-01 | Release custodian explicit approval required |
| `SD5-01` | SD5 | post-beta bounded proposal/shadow 扩展 | REL-02 | Separate product/security opt-in required |

## 3. SD0 — 先关闭安全 P0

### SD0-01 · v1 移除所有 raw Bash silent auto-allow

- **Scope**：修改 `packages/permission`，在 v1 取消所有 raw Bash 的 silent auto-allow；不再让 prefix regex、字符串 parser 或“看起来只读”的 allowlist 成为无提示授权依据。普通交互会话中的任意 Bash 都按现有显式 prompt/deny policy 处理；§18 Runner 永不暴露 Bash，进程执行只经 base-owned typed `Check.run(suiteId)`。
- **Dependencies**：无；它是所有专用 Runner 之前的 P0。
- **Tests/evidence**：`packages/permission/src/index.test.ts` 增加 table corpus，至少覆盖普通 `git status`/`git diff`、`;`、`&&`、newline、pipe、redirect、backtick、`$()`、Unicode whitespace、quoted control token 和未知 executable；断言每个 raw command 都**不会 silent auto-allow**，合法只读命令同样进入显式 prompt/deny。运行 `pnpm --filter @apollo-code/permission test`、typecheck 和依赖它的 CLI permission integration；另由 SD3-01 测试 typed `Check.run`，两条能力不可混用。
- **Human gate**：独立 security reviewer 审查权限差异、UX 影响和完整攻击 corpus；未签字不得开始 SD0-02。

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

## 4. Brand phase（最终身份待用户决定）

### BRAND-01 · 在 production contracts 前冻结 canonical identity

- **Scope**：**先等待用户给出最终 canonical identity**；随后建立唯一 source-of-truth 映射，原子迁移现有 package scope/names、CLI binary、config/home paths、env prefixes、docs/URLs、GitHub/npm metadata、telemetry namespaces、native artifacts、signing identifiers 和兼容 alias/deprecation。最终 identity artifact/digest 必须在 SD1 contracts、SD4 CLI/composition 与 SD0–SD4 exact-SHA evidence 之前固定。Logo/视觉资产只有在用户确认 identity 与视觉方向后另行设计；不得在本计划中创造候选品牌。
- **Dependencies**：SD0-03；此外依赖用户明确选择名称、scope、CLI 命令、域名/仓库归属和兼容期限。
- **Tests/evidence**：identity string inventory 前后对账为 0 未分类；fresh install/upgrade/config/session/credential/native resolution/docs links/CLI aliases/package publication dry-run；旧 identity 仅出现在 approved compatibility/history allowlist。迁移必须单独 changeset 和 rollback plan，并生成后续任务绑定的 canonical identity artifact/digest。
- **Human gate**：**当前 BLOCKED ON USER CHOICE**。用户签署 canonical identity/mapping；法律、npm/GitHub/domain 可用性由授权人核验。任何 agent 不得替用户选择名称或生成 final logo。

## 5. SD1 — Contracts、Store 与 Worktree

### SD1-01 · 领域模型与确定性 reducer

- **Scope**：按 BRAND-01 冻结的 identity 新建正式领域包，实现 §18 的 `SelfDevRun`、versioned policy/artifact、Baseline/Candidate/Verification/Acceptance/Approval/Promotion/effect/journal-anchor types、typed reasons、domain-separated canonical encoding 和纯状态 reducer。明确区分 existing `baseRef@baseSha` 与事前不存在的 `promotionRef`。Reducer 不 import provider、tools、CLI 或 storage；模型输出永远是 input data，不直接 transition。
- **Dependencies**：BRAND-01。
- **Tests/evidence**：表驱动逐条覆盖 §18 显式 transition、统一 FAILABLE/CANCELLABLE 集、`STALEABLE` **每个状态**→STALE、reason/state 适用表、清理 guard 和 PROMOTING commit point；特别包含 PROPOSED 的 stale-base/ref-occupied。所有未列 transition、未完成 worker/lease/challenge/worktree cleanup、终态恢复、version mismatch、missing guard、inconclusive-as-pass 均拒绝。加入 property/fuzz test 验证任何状态序列都不能绕过 SEALING/VERIFYING/ACCEPTING/AWAITING_HUMAN，且 cancel/promotion CAS 竞态只收敛到 CANCELLED 或 COMPLETED/FAILED。运行新包 test/typecheck 和 architecture dependency test。
- **Human gate**：独立 architecture reviewer 对照 §18 transition table 逐行签字。

### SD1-02 · CAS、monotonic fencing、独立 journal anchor 与 effect recovery

- **Scope**：在 `packages/storage` 增加 SelfDev adapter，实现 atomic compare-and-swap、短 lease + 单调 fencing token、corruption-evident hash chain/checkpoint、single-use nonce/receipt 和 crash-safe append；在候选/Runner/本地 store 写权限之外提供 protected append-only Ed25519 `JournalAnchorStore` + monotonic counter。Effect intent 显式分类为 transactional/queryable、idempotent/retryable 或 opaque/ambiguous，开始前预留 worst-case budget，每个 attempt 计费；只承诺 exactly-once committed state，opaque provider/model/suite 未知结果不盲重放。Orchestrator port 必须带 expectedVersion/effectKey/generation/fencingToken；禁止 last-write-wins。
- **Dependencies**：SD1-01。
- **Tests/evidence**：并发双 writer、lease expiry/steal/token 单调性，以及 worker 在“authorization 后、commit 前”暂停、被 steal 后恢复写入的 fault injection；断言旧 fence + generation + stateVersion 100% 被拒绝。覆盖 journal truncate/reorder/duplicate/unknown schema、**完整链重写**、旧有效 anchor/store snapshot rollback、counter 回退、key revocation、anchor outage、checkpoint rollback；覆盖三类 effect 在 intent/physical attempt/receipt 前后的 crash，验证 transactional reconcile、idempotent retry 逐次计费、opaque 无 receipt 必为 fail/inconclusive 且无 blind replay。运行 storage test/typecheck、Windows/Linux filesystem fixture；保存 local bytes、独立 anchor 记录和恢复状态 digest。
- **Human gate**：storage reviewer + security reviewer 确认 durability、fencing、anchor trust boundary、budget charging 和 fail-closed 语义；无独立 protected anchor 的实现不得称 tamper-evident/production。

### SD1-03 · 隔离 worktree、ArtifactRef 与 immutable seal

- **Scope**：实现 typed Git/worktree adapter、versioned/canonical `ArtifactRef`、content-addressed artifact store、canonical file manifest、patch/tree/candidate digest、read-only seal 和 cleanup。每个 fencing-token holder 使用独立 worktree；旧 Runner 确认停止且旧 mount 只读后，才可选择当前 holder tree 进入 seal。Adapter 使用固定 executable/argv、`shell:false`；候选不能触达 `.git` 控制面。用户当前 worktree/index/未提交文件永远不变。
- **Dependencies**：SD1-02。
- **Tests/evidence**：dirty user worktree 不变；symlink/hardlink/path traversal/case collision/mode bit/rename/binary file；ArtifactRef schema/canonicalizer/domain/raw digest 任一变化即拒绝；旧 holder 在授权后暂停并跨 fence 写自己的 worktree 不能污染 current tree，旧 Runner 未停止时 seal 必拒绝；seal 后 write/TOCTOU 全失败；取消/崩溃清理可重复。运行 self-development、storage、native-bridge 集成测试和 Git 版本矩阵 fixture。
- **Human gate**：security reviewer 核对隔离边界；repository owner 确认不污染当前 worktree/ref。

## 6. SD2 — Restricted Developer

### SD2-01 · base-SHA policy intersection 与 protected surfaces

- **Scope**：实现 versioned `meet_v1(builtinPolicy,userPolicy,policyLoadedFrom(baseSha))`，把 builtin/user/base source artifacts 与独立 EffectivePolicy artifact 在 PROPOSED 固定。逐字段 lattice 不得自行解释：allowed paths/capabilities/suites 取交集，deny 取并集且优先；最大 budget/TTL/diff/repair/concurrency 取 min；最低 quality/holdout/safety/reviewer count 取 max；required suites/safety/holdout 取并集；所有 allow-boolean 取 AND；missing/unknown/unfulfillable 全 fail closed。建立 default-deny 路径分类。最低 protected：SelfDev 控制面、Permission、Sandbox/native、Auth/secret、Plugin/Hook trust、Skill auto-activation、approval/journal/anchor/artifact、CI/release/signing、`.git`、依赖 manifests/lockfile、工作区外路径。候选 policy/AGENT/Skill/Plugin/CI 不参与当前 run。
- **Dependencies**：SD1-03。
- **Tests/evidence**：对每个 lattice 字段做三源排列、边界、空集、deny-vs-allow、required-not-allowed、整数溢出、布尔 AND 的 table/property tests；source/effective artifact bytes/digest 在 run 中改变必拒绝。每一 protected category 至少一个真实路径和新增未知路径 fixture；user/base 尝试扩大 builtin、candidate 修改 policy、symlink/case/rename/Unicode 绕过全部 deny；missing field、unknown field/enum/schema/lattice/canonicalizer、parse/digest error 全 fail closed。输出机器可读 coverage 报告，未分类路径数量必须为 0。
- **Human gate**：security owner 和 repository owner 对首版路径映射逐项确认；任何例外必须写 RFC，不能在 prompt 中临时允许。

### SD2-02 · 专用 Developer Runner 与 typed tools

- **Scope**：实现 `selfdev.developer` profile，只开放允许路径的 typed Read/Grep/Glob/Edit/Write 和已注册的 `Check.run` port；禁用普通 Bash、Task/subagent、network、secrets/env、MCP/Plugin、自动 Skill、persistent Memory、dangerous flags 和普通 permission cache。Developer authority 只在 `DEVELOPING` 有效；每次 tool authorize 与真正 commit 都校验 leaseId/fencingToken/generation/stateVersion。
- **Dependencies**：SD2-01。
- **Tests/evidence**：对每个禁用能力做直接调用、prompt injection 和 indirect tool fixture；断言拒绝发生在执行前且 journal 有 typed reason。状态离开 DEVELOPING/lease 过期或被 steal 后，旧 tool token 100% 失败；逐个 mutable tool 注入 pause-after-auth/before-commit，改变 fence/generation/stateVersion 后恢复，必须无 commit。真实模型 smoke 只能作为补充，不替代 deterministic boundary tests。
- **Human gate**：独立 security reviewer 审查 capabilities diff 和 sandbox profile；不得用“模型会遵守”关闭缺口。

### SD2-03 · Budgets、repair generation、cancel 与 Developer recovery

- **Scope**：实现 tokens/cost/time/tool/file/lines/artifact/suite/concurrency/repair 硬预算；每个 attempt 开始前 CAS 预留 worst-case、已启动即计费，只有受信 receipt 可释放未使用额度。repair 只创建新 generation；cancel 两阶段停止/清理且在 PROMOTING commit point 后拒绝；Developer crash 通过 lease/fence/CAS 恢复，opaque model result 未知时不盲重放。安全失败/篡改/isolation 失败不可自动 repair。
- **Dependencies**：SD2-02。
- **Tests/evidence**：逐预算的边界-1/边界/边界+1、并发 reservation、crash/timeout/provider unknown 的完整收费；超限后无额外 write/tool；repair 保留旧 manifest 且新 digest；每个开发 effect 边界 crash；并发 cancel 与 seal 竞态。E2E 覆盖 `FAILED`、`CANCELLED` 和 repair exhausted。
- **Human gate**：product owner 确认默认预算/最大 repair 次数和成本提示；security owner 确认不可修复类别。

## 7. SD3 — Verifier、Eval 与独立 Reviewer

### SD3-01 · Trusted `Check.run(suiteId)` 与同环境执行

- **Scope**：在 self-development 工作包实现 trusted suite registry 和 `Check.run`；suite 只来自 builtin/base SHA policy，固定 `suiteDefinitionDigest`、executable/argv/env/timeout/sandbox/output contract，`shell:false`、`cwd:'subject'`。`subject=base|candidate` 与 mount/source digest 只能由 trusted state-machine context 注入，candidate/argv/env/suite file 不得选择。Base/candidate 使用同一 suite definition 与 environment digest；candidate scripts/config 只能作为 untrusted 被测输入。SuiteResult 绑定 subject、subjectSourceDigest 和 CheckRunContext digest。
- **Dependencies**：SD2-03。
- **Tests/evidence**：candidate 尝试改 cwd/subject/source、command/control 字符、候选 package script、PATH shadow、env injection、network/secret access、output spoof、timeout、OOM、missing artifact 全 fail closed；base/candidate 断言同一 `suiteDefinitionDigest`/environment、不同受信 subject/source binding，篡改任一 SuiteResult binding 即拒绝。运行 native sandbox escape、check-runner integration 和 reproducibility tests。
- **Human gate**：build owner 确认 suite command graph；security reviewer 确认候选代码执行 sandbox 和无 secret/network。

### SD3-02 · Baseline/Candidate verifier、holdout 与 VerificationBundle

- **Scope**：实现 BASELINING/VERIFYING worker、required/safety/holdout suites、deterministic graders、ArtifactRef evidence 和 bundle digest。Holdout 对 Developer 不可见；反馈只暴露规范化类别。Baseline 失败处理必须由 base policy 明确，不能默认忽略。
- **Dependencies**：SD3-01。
- **Tests/evidence**：pass/fail/inconclusive/baseline-existing-failure/timeout/crash/environment drift/holdout leak fixture；同输入重复两次 bundle digest 一致；missing/modified evidence、伪造 stdout、candidate 更改 test/config 都不能提升 verdict。记录 trajectory/quality/cost/safety 四类指标。
- **Human gate**：eval owner 批准 required/holdout 来源、泄漏模型和 grader 阈值；安全 suite 必须零失败。

### SD3-03 · 独立 Reviewer、AcceptanceReport 与 shadow E2E

- **Scope**：实现 `selfdev.review` 无工具 profile、新会话/身份、sealed-only 输入和 versioned/length-bounded/strict-schema typed data channel；候选 bytes 只能位于 untrusted field，不能靠 delimiter/prompt 指令隔离。AcceptanceReport/model recommendation 明确为 **advisory**，绝不构成安全事实；isolation attestation 绑定 reviewer runtime/profile/prompt/typed envelope/decoder/context-source digests。Reviewer 只能建议 `accept|repair|reject|inconclusive`，不能修改 candidate、verification 或状态；deterministic safety/verification 保持硬门。EffectivePolicy 判定 high-risk 时需要两个独立 reviewer，否则 inconclusive。完成 SD3 shadow pipeline，但 promotion API 保持不存在。
- **Dependencies**：SD3-02。
- **Tests/evidence**：证明 reviewer 看不到 Developer transcript、临时文件、Memory、自动 Skill、Plugin、holdout secret；candidate 做 prompt/delimiter/schema/oversize/parser injection 时必须 parse-fail→inconclusive 且不能取得工具/审批；篡改任一 isolation digest 即拒绝；deterministic fail 无法被模型改 pass。High-risk fixture 必须证明两个 reviewer 无共享 session/Memory/Plugin/context 且缺一即停。Shadow E2E 覆盖完整 pass、repair、reject、cancel、crash recovery 和 stale base，重复运行保存 metrics。
- **Human gate**：由未参与 Developer 实现的 acceptance reviewer 检查 isolation evidence 和一组 sealed advisory reports；product owner 明确接受“模型只建议、人类最终逐项判断”的 shadow UX。

## 8. SD4 — 人工批准与 Branch-only Promotion

### SD4-01 · Human challenge 与 ApprovalReceipt

- **Scope**：实现 discriminated actor/key registry/revocation 与两种信任根：本地 TTY + recent OS re-auth + OS-protected key，或独立受信审批界面；model/service 永不能构造 `HumanApproverRef`。按 §18 冻结字段并生成 domain-separated ApprovalContext，覆盖 goal、run/state version、generation、budget limits/usage、baseline/environment、candidate/policy、完整 CommitObjectPlan/PromotionPlan、verification/acceptance。Challenge issuer signature、HumanProof actor signature 和 Receipt issuer signature 逐层绑定 context/challenge/proof；区分 challenge nonce 与 Receipt 两次 single-use。UI 展示完整 context、deterministic 硬门、advisory findings 和 `expectedCommitObjectId`。无 `--yes`/`--force`/env/stdin/model confirmation。
- **Dependencies**：SD3-03。
- **Tests/evidence**：仅 TTY 无 OS auth、uid/name 伪装、model/service actor、错误/撤销 key、registry rollback、auth context 过期、pipe/stdin、`--yes`、signature/domain swap、重放、nonce/receipt race 全拒绝；goal/state version/generation/budget usage/baseline/environment/candidate/policy/plan/verification/acceptance 任一字段在 freeze 后变化都吊销旧 challenge/receipt。覆盖 base race、promotionRef 预占和 request-changes；nonce 与 receipt 各自只能消费一次。安全 UX 测试必须验证人类看到了完整绑定摘要、硬门和 advisory findings 后才签发 actor proof。
- **Human gate**：BDFL/product owner 做真实交互与最终语义判断验收；security reviewer 审批 trust root、registry/revocation、signature/domain、context freeze、nonce/TTL 和 replay 模型。没有两方签字不得连接 promotion。

### SD4-02 · Typed Git 本地 Branch-only Promotion Worker

- **Scope**：实现 `selfdev.promote`，重新验证 receipt/context/freshness，以完整 canonical CommitObjectPlan 固定 tree、唯一 parent、author/committer raw identity、timestamps/timezones、message bytes、ordered extra headers、encoding 与 unsigned-v1 signature policy，并预计算 `expectedCommitObjectId`。Worker 清空/隔离 Git config/env/hooks/credential/signing helper，以 low-level typed object API 生成逐字节相同 payload/OID，再执行 expected=null/all-zero → new=exact OID 的 ref CAS。只允许本地未检出 branch；不访问 remote，不修改 current branch/index/worktree。effect recovery 只承诺 exactly-once committed state。
- **Dependencies**：SD4-01。
- **Tests/evidence**：对 author/committer name/email raw bytes、timestamp、timezone、message newline/encoding、extra-header order/continuation、signature policy、sha1/sha256 object format、user/system Git config 做 golden OID；任一 byte/implicit clock/config 漂移即拒绝。覆盖 dirty worktree、promotionRef 已存在、baseRef moved、receipt expired/replayed、cancel 与 commit-point CAS、crash before/after object/ref/PromotionReceipt、hook、remote URL/credential trap；网络 0 请求、current worktree hash 不变，ref CAS 的 expected/new OID 与批准 plan 精确相等。
- **Human gate**：repository owner 对真实临时仓库演示确认 branch-only、无 hooks/remote/current-worktree mutation。

### SD4-03 · Production composition、CLI 与跨平台 E2E

- **Scope**：在 `apps/cli` 按 BRAND-01 冻结的 canonical namespace 注册 §18 API/selfdev 子命令，连接 orchestrator/workers/store/Runner profiles；默认 off，仅显式 propose/start。实现 status/evidence/cancel/request-changes/reject/approve；文档、doctor、machine JSON 和 capability matrix 诚实披露 beta/branch-only。
- **Dependencies**：SD4-02。
- **Tests/evidence**：composition-root 测试证明每个 production port 已连接；CLI golden/JSON、restart/crash、multi-process CAS、supported OS path/Git/sandbox E2E；禁止命令与 remote side effect 断言；全仓 typecheck/test/build、docs、config/event verifiers、same-SHA CI。SD4 attack matrix 100% 预期 deny。
- **Human gate**：独立 product readiness review + security sign-off + product UX acceptance。完成后状态最多为 `verified-ci`；它不构成 release approval，release custodian 只在 REL-02 出现。

## 9. `0.1.0-beta.1` release

### REL-01 · Freeze immutable beta candidate

- **Scope**：基于 BRAND-01 已冻结 identity 的 SD4-03 exact SHA 生成 changeset、release notes、SBOM/checksums、capability/status 表和 candidate manifest。另生成 canonical `ReleaseChannelManifest`，至少绑定 candidate SHA/artifact manifest/package set、`version=0.1.0-beta.1`、`npmDistTag=next`、`githubPrerelease=true`、`githubMakeLatest=false`、发布前 npm `next`/GitHub latest 状态、预定义 rollback plan digest。Release notes 明示：SD4 branch-only、default off、无 push/merge/publish automation、SD5 不含；§15 runtime tuning 状态单独披露。生成 release checklist，不改写历史 evidence。
- **Dependencies**：SD4-03（BRAND-01 已是其上游硬依赖）。
- **Tests/evidence**：`pnpm turbo run typecheck test build --force`、docs API/VitePress、release status、frozen-lockfile、native/sandbox matrix（按选择的 beta target scope）、snapshot install in disposable checkout、security/eval bundle、all artifacts same SHA/digest。对 channel manifest 做 canonical/digest/schema tests，并 dry-run 断言 npm 只会写 `next`、GitHub 只会建 prerelease 且 `make_latest=false`；dry-run 只验证请求，不能代替 external publish gate。未满足 external gate 标 `external-pending`。
- **Human gate**：release reviewer 和 security owner 对 candidate manifest、channel manifest digest、claims、known limitations 和 rollback plan 签字；`ReleaseApprovalReceipt` 必须绑定两个 manifest digest。任何失败都产生新 candidate SHA/manifest/approval，并重跑全部绑定 evidence。

### REL-02 · Human-controlled beta publication

- **Scope**：仅授权 release custodian 可按获批 `ReleaseChannelManifest` 创建 tag/Release/registry publication；npm publication 必须显式使用 dist-tag `next`，GitHub Release 必须 `prerelease=true` 且 `make_latest=false`。使用 protected environment secrets，验证 provenance、checksums、platform disclosure 和安装路径。Self-Development pipeline 本身不能执行本任务。
- **Dependencies**：REL-01 且 [L2 release checklist](../../releases/L2-RELEASE-CHECKLIST.md) 中与所声明 beta target/渠道相关的 repository、credential、hardware、signing/notarization/publication gate 全部有 same-candidate evidence；未关闭则保持 blocked。
- **Tests/evidence**：tag 指向 candidate SHA；published assets 与 manifest 逐个 checksum；registry provenance；发布后从权威 API 断言 npm `next` 精确指向 `0.1.0-beta.1`、npm `latest` 保持发布前值，GitHub Release `prerelease=true` 且不是 latest；clean-machine install/first-run/branch-only smoke；release notes 无 stable/L2 误称。任一 package/channel/assertion 失败立即执行预定义 rollback：停止剩余 publication、把 npm `next` 恢复到 manifest 中的 previous value（原先不存在则移除）、deprecate 已发布 beta 而不自动 unpublish/overwrite、将 GitHub prerelease 标为 withdrawn 且保持 latest=false、保存 incident/effect evidence；rollback 后再次断言 stable/latest 未变。
- **Human gate**：release custodian 在看到最终 candidate + channel manifest digest 后显式批准并亲自执行/授权 publication 与预定义 rollback。配置了 workflow、拥有 credential 或 SelfDev receipt 都不是 release approval。

## 10. SD5（post-beta，可选）

### SD5-01 · Bounded autonomous proposals / shadow expansion

- **Scope**：在 SD4 稳定和 beta 数据复盘后，才评估去敏信号触发 proposal、更多可信任务类别和有界 repair。默认仍 off/shadow；每个 proposal 仍走完整 SD4 Human approval，promotion 仍 branch-only。不得增加 push/merge/publish 或 protected-surface 修改。
- **Dependencies**：REL-02、beta incident/cost/quality review、单独 RFC。
- **Tests/evidence**：预先冻结 baseline/eval/holdout 和质量/成本阈值；长期 crash/restart/lease/预算/攻击模拟；新任务类别逐个 threat model 和 suite；Safety 任何失败即退出。报告成功率同时展示人工返工、成本和拒绝率，禁止只报 cherry-picked wins。
- **Human gate**：新的 product decision + independent security review + user opt-in；不得因 `0.1.0-beta.1` 已发布而默认开启。

## 11. Beta 退出判定

只有以下条件同时成立，计划才可标记完成：

- BRAND-01 在 SD1 前由用户冻结 canonical identity 并完成迁移；SD0–SD4 后续每个任务均绑定该 identity artifact、exact-SHA evidence 和对应 human gate；§18 状态表按真实 wiring 更新。
- SelfDev 默认 off、branch-only；无 push/merge/tag/publish path，无 dangerous bypass。
- Baseline、VerificationBundle、AcceptanceReport、ApprovalReceipt 与 promotion receipt 绑定同一 base/candidate/policy digest；stale/timeout/inconclusive 全 fail closed。
- 全仓与目标平台 gates 通过；external/human release checklist 没有被 mock/dry-run/self-signed 证据冒充。
- ReleaseApprovalReceipt 绑定 candidate/channel manifest；npm `next` 与 GitHub prerelease/latest post-publish assertions 全通过，或失败后预定义 rollback 已恢复 stable/latest 并留下 incident evidence。
- 发布由 REL-02 release custodian 完成，Self-Development 自身没有获得发布权限。

若任一项缺失，正确状态是 `partial`、`verified-local`、`verified-ci`、`external-pending` 或 `blocked`，不是“自进化已开启”。
