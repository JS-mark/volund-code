> ↩ [返回索引 (README)](./README.md) · ← [上一章: §17 Code Review](./17-code-review.md)

---

## §18 受控自我开发 / 变更流水线（Controlled Self-Development / Change Pipeline）

> **状态：PROPOSED — NOT SHIPPED。** 本节是目标契约，不描述当前产品能力。当前仓库没有本节定义的 orchestrator、状态存储、受限 Developer Runner、独立验收、审批回执或 branch promotion。最早可用于生产的阶段是 **SD4（branch-only）**；在此之前只能做单元测试、fixture 或 shadow 评估。
>
> 本节与 [§15 自适应运行时调优](./15-self-evolution.md) 是两个独立系统：§15 只调节白名单内的运行时数值参数，不改代码或制品；§18 才讨论如何提出、开发、验证并经人工批准一个仓库变更。

### 18.1 术语、范围与非目标

| 术语 | 严格含义 | 是否修改仓库制品 |
|---|---|---|
| **Adaptive Runtime Tuning** | §15 的有界参数观察、建议、验证和回滚 | 否 |
| **Self-Development / Change Pipeline** | 本节定义的、以不可变 base SHA 为起点并产出候选变更的受控流水线 | 是，仅候选 worktree |
| **普通编码会话** | 用户要求 Agent 使用 Read/Edit/Write/Bash 完成任务 | 可能，但它是用户驱动的 harness 行为 |
| **Self-Evolution** | 不作为泛化营销词；只有明确指向 §15 或 §18 时才可使用 | 依上下文 |

**禁止误称**：普通 Agent 使用 Edit、Write 或 Bash 修改用户项目，不等于“自我进化”；模型生成代码、subagent 协作、Memory、Skill、Plugin 或 Hook 的存在，也不等于 §18 已形成闭环。

v1 的范围是：由显式目标创建一次 run，在隔离 worktree 中产生候选代码/文档/测试变更，使用可信策略规定的检查和独立验收，经人类签发一次性批准回执后，仅提升为**本地分支**。

v1 明确不做：

- 不自动 push、merge、tag、publish、部署、创建远端 PR 或触发生产发布。
- 不自动改写当前检出的分支、用户工作区或未提交改动。
- 不修改自身的信任根、安全策略、审批机制或发布机制。
- 不把候选提交新增/修改的测试、脚本或配置当作验证命令来源。
- 不使用网络、用户 secrets、任意 Plugin、自动 Skill、持久 Memory 写入或通用 Bash。
- 不以质量/成本收益抵消任何安全不变量；安全失败没有可接受的加权分数。

### 18.2 信任边界与角色分离

§18 的控制面必须是确定性的状态 reducer。模型可以提出目标、生成候选或给出评审意见，但不能决定状态跃迁、放宽策略、签发批准或执行 promotion。

| 角色 | 可读 | 可写 / 可签 | 明确禁止 |
|---|---|---|---|
| **Orchestrator** | base-SHA policy、run 状态、已验证 evidence digest | 通过 CAS 追加 journal、调度幂等 effect | 直接改候选、解释候选内指令、代替人审批 |
| **Developer** | 目标、base、允许路径、可信开发说明、已批准 suite 列表 | 仅在 `DEVELOPING` 写隔离候选 worktree | policy/审批存储、通用 Bash、网络、secrets、Plugin、自动 Skill、Memory 写入、promotion |
| **Deterministic Verifier** | sealed candidate、base、可信 suite policy | 只写隔离 scratch 与内容寻址 evidence | 修改候选、选择候选提供的命令、作最终语义接受决定 |
| **Independent Reviewer** | sealed diff、目标、VerificationBundle、允许的只读证据 | 产生 isolation-attested advisory review，汇入 `AcceptanceReport` | 把模型意见当安全事实、读开发会话/草稿/私有 Memory、调用写工具、修改 evidence、批准 promotion |
| **Human Approver** | 完整绑定摘要、diff、deterministic gates、advisory findings、预算与安全结果 | 逐项承担最终语义判断并签发 `ApprovalReceipt`，或 request-changes/reject | 用通用 `--yes`、脚本 stdin、模型/服务身份或 advisory recommendation 替代本人确认 |
| **Promotion Worker** | 已批准的精确 digest 集合、base、新本地 ref 名 | 幂等创建本地 branch/commit ref、记录结果 | push、merge、tag、publish、改当前 worktree、重跑开发 |
| **Journal Anchor Service** | 已验证的下一个链头、store generation、前一 anchor | 用独立 issuer key 推进 append-only monotonic anchor | 使用 human key、签审批、读取候选内容、接受分叉/回退 |

**Reviewer isolation** 是硬要求，不是“换一个 prompt”即可满足：只有 `ReviewerActorRef` 的 model/service reviewer profile 可产出 attestation/advisory；Human Approver、run owner、Developer 或任意 non-reviewer role 在类型层即拒绝。每个 actor 都必须携带受信 identity issuer 签发的 `principalBindingDigest + credentialBindingDigest`，新 `actorId` 或新 session 不能掩盖同一 principal/key/credential。Reviewer 使用新会话、reviewer-only principal 和新 context-source instance，不能读取 Developer transcript、隐藏思维、临时文件、自动激活 Skill、个人/项目 Memory 或可变 Plugin 状态。Reviewer 输入必须由 sealed artifacts 和可信控制面重新构造；候选内容一律作为 untrusted data 包裹。

#### 18.2.1 Human approval trust root

Human Approver 必须是 discriminated `HumanApproverRef { kind:'human', role:'human-approver' }`。本地 CLI 路径要求交互式 TTY **加**近期 OS re-auth，并由 OS keychain/Secure Enclave 等受保护、不可由模型导出的本地 key 签名；TTY、进程 uid、用户名或点击本身都不是身份。独立审批界面必须使用预先固定的独立 trust root 和签名 key，不能复用 Developer/Orchestrator credential。

Key registry 不得自引用：canonical `SelfDevKeyRegistryPayload` **不含**自身 digest、ArtifactRef 或 binding；其 bytes 以 `selfdev.key-registry-payload.v1` domain digest。外部 `SelfDevKeyRegistryBinding` 才保存 `payloadArtifact + payloadDigest + registryEpoch + previousBindingDigest`，并以 `selfdev.key-registry-binding.v1` domain 计算 terminal `bindingDigest`。Run、actor、auth context、challenge、receipt 与 journal anchor 都绑定该 binding digest；消费时重读 payload bytes、复算 artifact/payload/binding 三层，并与受保护 latest epoch/lineage 对账。

Registry record 以 discriminator 分离 principal-binding issuer、credential-binding issuer、builtin-classifier-registry issuer、task-class-attestation issuer、human approval actor key、challenge issuer、receipt issuer 和 journal-anchor issuer；每条记录绑定 issuer/actor/service build、usage、唯一允许的 signature domain、trust root purpose、有效期和 revocation epoch。Verifier 必须同时匹配 `keyId + algorithm + usage + domain + issuer/actor/service + role + build/channel + root purpose`，并在签发与消费时重查 expiry/revocation；cross-domain、cross-role、未知 usage、过期、撤销或 registry/anchor rollback 一律拒绝。Human key 只能签 `HumanProof`，绝不能充当 identity/classifier/challenge/receipt/journal issuer；模型和 service actor 也不能借用 OS/session 字段伪装 Human Approver。

#### 18.2.2 Participant identity trust root

所有参与者——Human Run Owner/Approver、Service Orchestrator/Verifier/Promotion/Anchor worker、Model Developer/Reviewer 及 service reviewer——共享同一 identity contract。受保护的 trust root、launcher 或 auth subsystem 先签发不含秘密的 `CredentialBinding`，再签发引用它的 `PrincipalBinding`；两者分别使用独立 signature domain/key usage，绑定 `actorId + kind + role + purpose domain + issuer + subject/key/opaque credential digest + validity + revocation epoch`。原始 token、private key、cookie、OS credential 或 provider secret 永不进入 run/evidence；只有受信 registry artifact、公开验证材料和 digest 可持久化。

`ActorRef` 只保存两个 binding digest；消费 actor 的每个 transition、lease、effect、review 和 approval 都必须重读 artifacts，复算 payload/binding/signature，并确认 actor 字段、用途、有效期、latest registry epoch 和 revocation 一致。Issuer 由 registry 中的 identity-issuer key 标识，不能用一个完整 ActorRef 自签自身 binding，也不能让 candidate/model提供 issuer、subject 或 credential digest。

Builtin role-purpose matrix 固定如下，identity issuer record 只能在其中进一步收窄 `allowedActorKinds/allowedRoles/allowedPurposeDomains`，不能新增组合：human=`run-owner|human-approver`；model=`developer|reviewer`；service=`orchestrator|verifier|reviewer|promotion-worker|journal-anchor`，且每个 role 只能使用同名 `selfdev.participant.<role>.v1` purpose。任一 kind/role/purpose 交叉、issuer scope 越界或 user/base policy 试图扩张 matrix 均拒绝。

`authenticationContextDigest` 不得形成 actor↔context 自引用。Human Approver 的 `ApprovalAuthenticationContext` payload 只嵌入去掉该字段的 `HumanApproverIdentityRef`；最终 `HumanApproverRef.authenticationContextDigest` 再指向已完成的 context digest。其他 actor 的该字段指向 launcher/auth subsystem 先完成的外部 authentication-context artifact，不能指回包含完整 ActorRef 的对象。

控制面在 `ACCEPTING` 前冻结完整 `ParticipantIdentitySet`：包括已经执行动作的 actor，以及当前 generation 被指定用于后续审批、promotion 和 anchor 的 actor。集合按规范键排序去重，forbidden 集只能由 reducer 从完整 role/participation 记录派生，调用方不能提交排除名单。Reviewer 必须与 Developer、run owner、所有 Human Approver、Orchestrator、Verifier、Promotion Worker、Journal Anchor 和其他 forbidden participant 在 `actorId`、principal/credential binding digest、payload 内稳定 `principalSubjectDigest`/`opaqueCredentialHandleDigest` 和 key 全部不同；高风险 reviewer 彼此也在这些维度以及 session/context-source 上全部不同。若审批或 promotion 临时换成未列入集合的新 participant，必须作废 Acceptance/Approval context，重建集合并重新独立验收，不能事后追加绕过排除检查。

### 18.3 状态机

主成功路径固定为：

```text
PROPOSED → BASELINING → DEVELOPING → SEALING → VERIFYING
         → ACCEPTING → AWAITING_HUMAN → APPROVED → PROMOTING → COMPLETED
```

修复协调态为 `REPAIRING`；取消协调态为 `CANCEL_REQUESTED`。终态为 `COMPLETED`、`REJECTED`、`FAILED`、`CANCELLED`、`STALE`。终态不可恢复、不可原地重开；继续工作必须创建新 run。`REPAIRING` 自身不可写候选，只能为下一代候选分配新 generation 并跃迁回 `DEVELOPING`。

下表是**允许跃迁的穷举表**；表外跃迁一律由 reducer 拒绝。每行只有一个目标状态，不能把“替代出口”留给调用方解释。

| From | To | 唯一授权角色 | 必须满足的 guard |
|---|---|---|---|
| `PROPOSED` | `BASELINING` | Orchestrator | caller `taskClassHints` 仅按 untrusted hint 保存；protected builtin registry/release expected digest、base-policy constraint digest 与 typed slots 已校验；可信控制面已从冻结的 goal/base/static inputs 生成 deterministic result 和 signed `TaskClassAttestation`，其 registry/definition/request/result/effective-policy digest 均固定且 issuer 当前有效；run owner、Orchestrator 和已 designated actor 的 Principal/Credential bindings 均通过 latest registry/validity/revocation 校验；`baseRef` 匹配 effective allow 且不命中 deny，当前 head 等于 `baseSha`；`promotionRef` 匹配 prefix/deny policy、不存在且所需 store reservation 已固定；policy/预算均固定 |
| `BASELINING` | `DEVELOPING` | Orchestrator | BaselineBundle 完整且非 inconclusive；每个可修复现有失败的 repair rule 必须匹配 `baselineExceptionAuthorizedTaskClassIds` 中同一个 authoritative class，mixed/ineligible/fallback 不得串权；新 generation/worktree 已分配 |
| `DEVELOPING` | `SEALING` | Developer 申请、Orchestrator 执行 | lease 有效；变更全在允许路径；预算未超；无 cancel intent |
| `SEALING` | `VERIFYING` | Orchestrator | 写 lease 已撤销；manifest/tree/patch/policy/artifact digest 复算一致；PromotionPlan 已固定 |
| `VERIFYING` | `ACCEPTING` | Deterministic Verifier | required、holdout、safety 全部明确 pass；VerificationBundle 完整；本 generation 的 performed + designated `ParticipantIdentitySet` 已完整验证并以该 transition 的 exact state version 冻结，后续 review 只能绑定该 digest |
| `VERIFYING` | `REPAIRING` | Orchestrator | verdict 为可修复 `fail`；安全不变量未失败；repair budget 尚有余额；finding 已去敏 |
| `ACCEPTING` | `AWAITING_HUMAN` | ReviewerActorRef 申请、Orchestrator 执行 | deterministic verification/safety 硬门仍为 pass；typed channel 无解析异常；全部 policy-required advisory reviews 建议 `accept`；`TaskClassificationResult` 与 signed `TaskClassAttestation` 仍有效且每个 isolation attestation 均绑定其 digest；`ParticipantIdentitySet` 与进入 ACCEPTING 时冻结的 exact digest/version 相同，reviewer actor/principal/credential/key/session/context-source 两两唯一且不复用任何 forbidden participant；classification/risk reviewer count 满足；AcceptanceReport 完整绑定 classification、participant set、verification 与 PromotionPlan |
| `ACCEPTING` | `REPAIRING` | Orchestrator | advisory finding 建议 repair；finding 可修复且 repair budget 尚有余额；deterministic safety 未失败 |
| `ACCEPTING` | `REJECTED` | Independent Reviewer 申请、Orchestrator 执行 | advisory recommendation=`reject`；report digest 已持久化；Orchestrator 按固定 policy 接受该终止建议 |
| `REPAIRING` | `DEVELOPING` | Orchestrator | 上一 sealed generation 未变；attempt 原子加一且未超过 limit；新 generation/worktree/lease 已分配 |
| `AWAITING_HUMAN` | `APPROVED` | Human Approver 申请、Orchestrator 执行 | challenge nonce 在同一 CAS 中首次消费；receipt 全字段绑定、签名有效；actor 授权；`baseRef` fresh；`promotionRef` 仍不存在 |
| `AWAITING_HUMAN` | `REPAIRING` | Human Approver 申请、Orchestrator 执行 | request-changes reason 已持久化；repair budget 尚有余额；所有 challenge 作废 |
| `AWAITING_HUMAN` | `REJECTED` | Human Approver 申请、Orchestrator 执行 | reject reason 已持久化；所有 challenge 作废 |
| `APPROVED` | `PROMOTING` | Promotion Worker | receipt 与 promotion reservation 未过期/未消费；完整 digest/plan 复算一致；store CAS 只消费 receipt、写 promotion intent 并改变 run state；ref freshness 读取仅 preflight，不授权 Git 写入 |
| `PROMOTING` | `COMPLETED` | Promotion Worker | 同一个 Git ref transaction 已原子 `verify baseRef==baseSha` + `create promotionRef expected-zero→expectedCommitObjectId`，或被同一 effect 对账为该精确 transaction；PromotionReceipt 已持久化 |
| `CANCEL_REQUESTED` | `CANCELLED` | Orchestrator | 活动 Runner 已停止；lease 已撤销；临时 worktree 已隔离/清理；审计保留 |

三个统一 terminal 规则同样属于穷举契约：

- `FAILABLE = { PROPOSED, BASELINING, DEVELOPING, SEALING, VERIFYING, ACCEPTING, REPAIRING, AWAITING_HUMAN, APPROVED, PROMOTING, CANCEL_REQUESTED }`。只有 Orchestrator 可将其中任一状态转为 `FAILED`，且 `TypedReason.code` 必须属于 `policy_invalid | baseline_inconclusive | security_invariant_failed | integrity_failed | budget_exhausted | nonrepairable_verification | acceptance_inconclusive | reviewer_isolation_failed | approval_invalid | promotion_conflict | recovery_failed`；reason evidence 先持久化。暂时性 I/O/worker crash 不转移，保留原状态按 effect receipt 恢复。
- `STALEABLE = { PROPOSED, BASELINING, DEVELOPING, SEALING, VERIFYING, ACCEPTING, REPAIRING, AWAITING_HUMAN, APPROVED }`。只有 Orchestrator 可将其中任一状态转为 `STALE`。`base_ref_moved`、`promotion_ref_occupied` 与 `promotion_reservation_expired` 适用于全部 STALEABLE；`approval_expired` 只适用于 `AWAITING_HUMAN`/`APPROVED`，其他 reason/state 组合必须拒绝。跃迁 guard 必须先：停止/确认退出全部 active workers，撤销 lease、reservation、challenge 和未消费 receipt，隔离或丢弃 mutable worktree，保留 sealed artifacts/journal，并证明没有 promotion effect intent；无资源的早期状态以空集满足。这样 `PROPOSED` 在 base 已移动或 promotion ref 被占用时也能确定终止。`PROMOTING` 已过 store commit point，不属于 STALEABLE。
- `CANCELLABLE = { PROPOSED, BASELINING, DEVELOPING, SEALING, VERIFYING, ACCEPTING, REPAIRING, AWAITING_HUMAN, APPROVED }`。Run owner 或 Human Approver 只能把这些状态转为 `CANCEL_REQUESTED`。`PROMOTING` 是不可取消的 commit point：cancel 与 `APPROVED → PROMOTING` 用同一 CAS 竞争；promotion 先成功后，cancel 必须返回 typed conflict，worker只能对账到 `COMPLETED` 或 `FAILED`。

所有跃迁都必须提交 `{ runId, expectedVersion, from, to, guardDigest, actor, effectKey }`。存储层使用 compare-and-swap；版本不匹配即拒绝，不允许 last-write-wins。

### 18.4 永久不变量

1. **只有 `DEVELOPING` 可变**：只有该状态下的当前 generation 候选源树可写。Baseline/Verification 可写各自 disposable scratch，但 base 与 sealed candidate 挂载为只读。
2. **seal 后不可回写**：进入 `SEALING` 即撤销 Developer lease；`CandidateManifest.candidateDigest` 生成后，任何字节或 mode 变化都使 run 失败。修复创建新 generation，不修改旧候选。
3. **证据完整绑定**：Verification、Acceptance、Approval 和 Promotion 必须逐层绑定同一 `runId + baseRef + baseSha + candidateDigest + policyDigest + promotionPlanDigest`；Approval 还必须绑定 verification/acceptance digest，不得只绑定 branch 名、路径或时间。
4. **base/目标 ref 不漂移**：`baseRef` 是已有基线 ref，其 head 必须始终等于 `baseSha`；`promotionRef` 是本 run 要新建的本地 ref，在 Git commit point 前必须不存在。store freshness check 不能关闭 Git TOCTOU；唯一授权 ref 写入的是同一 Git ref transaction 中的 base verify + promotion create。不自动 merge/rebase，也不把二者混成一个 `targetRef`。
5. **不确定即拒绝**：missing、timeout、crash、unsupported、partial、inconclusive 或 digest 不明，均不能被折算为 pass。
6. **effect 只保证状态提交一次**：每个 effect 由稳定 `effectKey` 唯一标识；系统保证的是 exactly-once **committed state**，不声称底层进程/模型调用物理执行一次。恢复必须按 effect class 查询、对账或 fail closed，禁止对不透明调用盲重放。
7. **lease 有界且带 fencing**：Developer、Verifier、Reviewer、Promotion Worker 都使用短租约和单调递增 fencing token。每个 mutable tool/effect 必须在授权时和提交前同时校验 `leaseId + fencingToken + generation + stateVersion`；旧 holder 即使仍持有 token 也不得提交。
8. **不可原子 fence 的文件系统写入必须物理隔离**：每个 lease holder 使用独立 worktree；lease 被接管后，旧 Runner 必须确认停止，其 worktree 永不复用。`SEALING` 只能选取当前 fencing token 对应的 tree，且必须证明所有旧 Runner 已停止或其 mount 已变只读。
9. **审批不可转移**：Developer、Reviewer、Orchestrator 和 Promotion Worker 不能成为该 run 的 Human Approver；同一模型的不同 prompt 不构成人类审批。
10. **审计不可删除且有独立锚点**：取消、失败、拒绝和清理不能删除 journal、manifest、evidence digest 或 receipt 使用记录。hash chain 单独只能证明内部损坏；production 必须把链头提交到候选与 Runner 均不可写的受保护单调签名锚点。
11. **当前任务分类不受候选影响**：authoritative task classes 只由可信控制面在 `PROPOSED` 读取 canonical goal、`baseSha` 路径/可选可信 base diff 和 policy 允许的静态输入后产生并固定。Caller hints、Developer/Reviewer/模型输出、候选 diff、候选 policy 或候选新增文件都不能改变当前 generation 的 classification；改变目标或 classifier inputs 必须创建新 run。
12. **参与者身份不能靠改名漂移**：每个 actor 的 principal/credential binding 必须由受信 identity issuer 签发并在使用时验证；`actorId`、session 或 instance 改变但 principal/credential/key 相同，仍视为同一参与者并拒绝 reviewer 独立性。Acceptance 后 participant set 改变会使 report、challenge 与 receipt 全部失效。

### 18.5 策略优先级、受保护面与 Runner profiles

有效能力必须按下式计算，并在 `PROPOSED → BASELINING` 前固定为内容寻址 artifact：

```text
effectivePolicy = meet_v1(builtinPolicy, userPolicy, policyLoadedFrom(baseSha))
```

`SelfDevPolicy` 与 `EffectivePolicy` 必须使用注册的 `schemaVersion=1`、`latticeVersion=selfdev-policy-lattice-v1` 和 `canonicalizer=selfdev-cjson-v1`；原始 bytes、canonical payload 和 digest 均保存为 `ArtifactRef`。`PROPOSED` 固定 builtin/user/base 三个 source artifact 及 effective artifact，`basePolicyArtifact` 必须从 `baseSha` 读取并显式声明 base TaskClassifier constraint artifact/digest，二者一起进入 `PolicyBinding`；后续配置或候选改动不影响本 run。未配置用户策略时，控制面生成并固定一个显式、完整的 builtin-derived 用户 artifact，不能用“字段缺失”表示默认。

逐字段 meet 规则是规范的一部分，禁止实现者自行选择优先级：

| Policy 字段 | `meet_v1` | 更严格的方向 |
|---|---|---|
| `allowedPathPatterns` / `allowedCapabilities` / `allowedSuiteIds` | 对三个 canonical set 取**交集** | 允许项更少 |
| `deniedPathPatterns` / `deniedCapabilities` | 取**并集**，最后从所有 allow 结果中剔除；deny 永远胜出 | 拒绝项更多 |
| `refs.baseRefAllowMatchers` | 对 versioned matcher language 做语义**交集**；结果不可 canonical 表达则失败 | 可选 base refs 更少 |
| `refs.promotionRefAllowPrefixes` | 逐 prefix 求语义交集（保留更具体者）；无交集则 policy 不可满足 | promotion namespace 更窄 |
| `refs.deniedRefMatchers` | 语义**并集**且 deny 优先 | 禁止 refs 更多 |
| `refs.requirePromotionReservation` / backend / TTL | required 取 **OR**（v1 builtin=true）；backend 必须精确同版本；max TTL 取 **min** | 必须 reservation、实现固定、TTL 更短 |
| `maxima.budget.*`、approval TTL、单次/累计 diff、文件/行/字节、repair/concurrency | 按精确整数逐字段取 **min** | 上限更低 |
| `minimums.quality*`、holdout/safety pass、independent reviewer count | 按精确整数逐字段取 **max** | 最低要求更高 |
| `requiredSuiteIds` / `requiredSafetyCheckIds` / `requiredHoldoutIds` | 取**并集**，且每项还必须存在于最终 `allowedSuiteIds`；否则 policy 不可满足并失败 | 必跑项更多 |
| `baseline.existingFailureRepairRules` | 仅保留三源都有的 `{suiteId,failureClassId}`；其 `allowedTaskClassIds` 取交集、`maxBaselineOccurrences` 取 min；空 task set 删除该 rule | 可声明修复的既有失败更少 |
| `baseline.forbidNewFailureClasses/forbidIncreasedOccurrences/forbidSeverityIncrease/forbidIncreasedOutputBytes` | 逻辑 **OR**；v1 builtin 四项永远为 true | 禁止回归更严格 |
| `baseline.maxRepairableExistingFailures` | 取 **min** | 可带入/修复的既有失败更少 |
| `risk.highRisk*` path/task/capability triggers | 取**并集**；命中任一即 high-risk | 更容易升级风险 |
| `risk.diff*AtLeast` / `deterministicFindingSeverityAtLeast` | 数值阈值取 **min**；severity 按 `low < medium < high < blocker` 取更低触发级别 | 更早升级风险 |
| `risk.requiredReviewerCount.normal/high` | 分别取 **max**，且 high 不得小于 normal | reviewer 要求更多 |
| `taskClassification.classifierEngineVersion/ruleDialectVersion` | 三源必须精确等于 builtin 注册版本；base classifier constraints 还必须绑定 `baseSha` | 不允许替换分类器语义 |
| `BaseSelfDevPolicy.taskClassifierConstraintRuleSet` | source-discriminated 强制字段：base 必须提供 exact artifact/digest 并原样写入 PolicyBinding；builtin/user 对应字段为 `never`；missing/extra/mismatch 或 typed-slot swap 失败 | 初始规则来源更可信 |
| `taskClassification.allowedAuthoritativeTaskClassIds` / `allowedStaticInputKinds` / `baselineExceptionEligibleTaskClassIds` | 三源 canonical set 取**交集**；base constraint 只能删除 builtin 结果，不能新增 class | 可用类别、输入与 exception 更少 |
| `taskClassification.forcedHighRiskTaskClassIds` | 取**并集**；builtin high-risk 结果不可被 user/base 移除 | 更容易升级风险 |
| `taskClassification.maxStaticInputBytes` | 取 **min** | 可参与分类的静态输入更少 |
| `taskClassification.fallbackRequiredReviewerCount` | 取 **max**，并至少等于最终 high-risk reviewer count | fallback reviewer 要求更多 |
| 所有 `allow*` 布尔能力 | 逻辑 **AND**；字段命名必须保持“true=授予能力” | false 更严格 |

集合元素先按版本化 path/capability/suite/ref/risk/task-class 方言 canonicalize，再比较；禁止字符串近似交集。数值必须是 canonical 非负安全整数（费用用十进制整数串）并做溢出检查。Risk classifier 是纯函数：任一 effective trigger 命中即 high-risk；证据缺失、规则不支持或无法分类时也按 high-risk 处理，模型/Developer/Reviewer 无权降级。最终 reviewer 数为 `max(minimums.independentReviewerCount, risk.requiredReviewerCount[classification], taskClassificationResult.requiredReviewerCount)`。Baseline 只有 rule 同时匹配 suite、trusted failure class 和 `TaskClassificationResult.baselineExceptionAuthorizedTaskClassIds` 中的**同一个** authoritative task class 时，才能声明“修复既有失败”；candidate 永远不得新增 failure class、增加 occurrence、提高 severity 或增加 failure output bytes。任一 source 缺字段、未知字段、未知 enum/schema/lattice/canonicalizer、重复 canonical key、不可满足 required-vs-allowed/ref/reviewer 约束或 digest 不一致，均 `policy_invalid` fail closed。EffectivePolicy 必须重新 canonicalize、digest、写入独立 ArtifactRef，并绑定四个 artifact digest；运行时只读取该固定 effective artifact。

#### 18.5.1 Trusted task classification

`taskClassHints` 是 caller 提供的**不可信标签**，只能用于检测 mismatch 和审计；它不能直接进入 baseline exception、risk 降级、suite 选择或 reviewer count。可信控制面使用固定 `TaskClassifierDefinition` 执行版本化、非图灵完备、确定性的 classifier。受保护 `BuiltinTaskClassifierRegistryBinding` 中的 release manifest 必须由 usage=`builtin-task-classifier-registry-issuer`、domain=`selfdev.builtin-task-classifier-release-manifest.v1` 且 build/channel/validity/revocation 匹配的 key 签名；manifest payload 的 registry payload digest、epoch/version、expected builtin rules/groups digest 必须分别与 binding 和 registry payload **逐字段相等**。合法 manifest A + 不同 payload B、旧 epoch、或只有无密钥 `bindingDigest` 都不能建立信任。Builtin rule set 再精确匹配该 expected digest；base constraint slot 只能接受 `source:'base'` 且 digest 由 `BaseSelfDevPolicy@baseSha` 的强制字段声明的 rule set，builtin/base typed slot 不可互换。Builtin rules 先从 canonical goal bytes、`baseSha` 的可信 path index、policy 明确允许的静态 base diff/metadata 得到初始 class；base-SHA constraint rules 和 user/base policy只能删除 class、拒绝输入或把 risk floor 提高到 high，不能新增 builtin 未产生的 class、放宽 predicate、降低风险或减少 reviewer。Candidate worktree、模型/Developer/Reviewer 生成的标签、diff、文件或 policy 永不进入当前 run 的 classifier input。

Digest 分层不能混用：`TaskClassifierTrustedInputPayload` 只含可信 goal/base/static inputs；`TaskClassifierRequestBinding` 另绑定该 payload 与 caller hints；纯函数输出 `TaskClassificationResult`，其 `classificationResultDigest` 对相同 definition/request/effective policy 必须确定一致；最后带 `runId/issuedAt/issuedBy` 的 `TaskClassAttestation` wrapper 才绑定该 result。Wrapper 必须用最新 key registry 中 usage=`task-class-attestation-issuer`、domain=`selfdev.task-class-attestation.v1`、role=`orchestrator` 且 build/validity/revocation 均匹配的独立 service key 签名；rogue initial artifact、cross-domain/revoked issuer 或 registry rollback 均拒绝。只有 result digest 可用于跨 run determinism 比较，attestation digest 因 run/time/signature 不要求相同。

非空 hint set 与 authoritative class set 不完全相同、零规则匹配/未知 class、policy 交集后 class set 为空、classifier/decoder 失败、unsupported static input、或 builtin/base rules 在任一 registered mutually-exclusive group/constraint 上冲突，都会得到 `fallback-high-risk`：有效 class set 与 `baselineExceptionAuthorizedTaskClassIds` 都为空，required reviewer count 取 EffectivePolicy 中所有 reviewer minimum 的最大值（至少 high-risk count）。正常 result 的 authorized exception set 也只能是 `authoritativeTaskClassIds ∩ taskClassification.baselineExceptionEligibleTaskClassIds`；每条 baseline repair rule 必须匹配该集合中的**同一个** class，不能用一个 eligible class 为同一 run 的另一个 ineligible class 串权。这些结果不能被 caller 通过换标签修复；只有更正可信 goal/base/static input 后创建新 run。

三层都只能**收窄**权限。候选内的 policy、测试脚本、AGENT/CLAUDE 指令、Skill、Plugin、Hook、package script 或 CI 变更，不影响当前 run。

v1 builtin deny 至少覆盖以下受保护面；用户/base policy 可以继续扩大 deny 集，不能缩小：

- §18 自身实现包、Orchestrator、状态 reducer、policy loader、Runner profile 和 `Check.run` suite registry。
- Permission、Sandbox/native bridge、Auth/credential、secret redaction、untrusted wrapping、Plugin/Hook trust 与自动 Skill 激活机制。
- Human approval store、actor/nonce/TTL 校验、journal/独立 anchor、artifact store 和 promotion worker。
- CI、release、signing/notarization、provenance、branch protection、CODEOWNERS、远端凭据与发布证据。
- `.git/**`、工作区外路径、symlink 逃逸目标、依赖/包管理 manifest 与 lockfile（v1 不做依赖演进）。

初始 base policy 必须将这些类别映射到当前仓库的实际路径；任何未分类的新路径默认 protected。候选可以修改普通产品代码、文档和测试，但候选新增/修改的测试仅是补充材料，不能成为 required suite 或 holdout 的来源。

#### 18.5.1 专用执行 profiles

| Profile | 允许 | 默认拒绝 |
|---|---|---|
| `selfdev.developer` | 只读 base；对允许路径使用 typed Read/Grep/Glob/Edit/Write；调用允许的 `Check.run(suiteId)` | 通用 Bash、Task/subagent、网络、secrets/env、Plugin/MCP、自动 Skill、持久 Memory 读写、受保护路径、工作区外写 |
| `selfdev.verify` | 只读 sealed candidate/base；写隔离 scratch/artifact；执行 base policy 选择的 `Check.run` | 修改候选、动态命令、网络、secrets、Plugin/Skill/Memory、交互 permission bypass |
| `selfdev.review` | 只读规范化 diff、VerificationBundle 和目标 | 文件/进程/网络工具、Developer 上下文、持久 Memory、Plugin/Skill、审批与 promotion |
| `selfdev.promote` | 校验 digest；在受限 Git ref API 中原子创建一个本地 branch ref | 通用 git/Bash、当前 worktree 修改、push/merge/tag/publish、网络凭据 |

这些 profile 不复用普通交互会话里的“用户已 allow-session/allow-project”缓存；`--dangerously-skip-permissions`、`--dangerous-no-sandbox` 或等价开关在 §18 路径中永远无效。

#### 18.5.2 `Check.run(suiteId)`

`Check.run` 是唯一进程入口，输入只能是已注册 `suiteId` 和 policy 允许的有限参数（例如 shard 编号），不能接收 shell 字符串：

```ts
interface BuiltinExecutableId {
  id: string
  executableDigest: string
}

interface OutputContract {
  logicalName: string
  mediaType: string
  required: boolean
  maxBytes: number
  schemaDigest?: string
}

interface TrustedSuite {
  suiteId: string
  suiteDefinitionDigest: Digest
  executable: ArtifactRef | BuiltinExecutableId
  argv: readonly string[]
  shell: false
  cwd: 'subject'
  envAllowlist: readonly string[]
  timeoutMs: number
  sandboxProfileDigest: string
  expectedOutputs: readonly OutputContract[]
  holdoutRef?: ArtifactRef
}

interface CheckRunContext {
  runId: string
  generation: number
  stateVersion: number
  subject: 'base' | 'candidate'
  subjectSourceDigest: Digest
  suiteDefinitionDigest: Digest
  effectivePolicyDigest: Digest
  environmentDigest: Digest
  contextDigest: Digest
}
```

- suite 从 builtin 或 `baseSha` 的可信 policy registry 加载，`shell: false`，固定 executable/argv；不做字符串插值、管道、重定向或 command substitution。
- suite definition 永远写 `cwd:'subject'`；`subject=base|candidate`、挂载点和 `subjectSourceDigest` 只能由可信状态机通过 `CheckRunContext` 注入，candidate input、argv、环境变量和 suite 文件都不能选择 subject。
- 候选代码必然会在测试中执行，因此仍必须处于无网络、无 secret、最小 env、只读 source + 限额 scratch 的 sandbox。
- baseline 与 candidate 必须绑定同一 `suiteDefinitionDigest`、镜像、依赖缓存 digest、环境变量、资源限制和时钟策略；每个 SuiteResult 同时绑定 subject 与 source digest。无法证明同定义/同环境则结果为 inconclusive。
- candidate 修改的 package scripts、测试配置或 snapshots 不得改变 required suite 的命令图；如 suite 必须加载候选配置，policy 必须显式把该配置视为被测输入而非可信控制面。

### 18.6 权威数据模型

以下是 v1 最小持久模型。所有 `*Digest` 使用版本化 canonical encoding + SHA-256；schema 版本和 canonicalizer 版本必须进入 digest 域。结构末尾保存的自身 digest 字段不进入自己的 preimage，其余字段一律覆盖，禁止实现者自行省略。

```ts
type Digest = `sha256:${string}`
type GitObjectId = string
type Timestamp = string

type SelfDevState =
  | 'PROPOSED' | 'BASELINING' | 'DEVELOPING' | 'SEALING'
  | 'VERIFYING' | 'ACCEPTING' | 'REPAIRING' | 'AWAITING_HUMAN'
  | 'APPROVED' | 'PROMOTING' | 'CANCEL_REQUESTED'
  | 'COMPLETED' | 'REJECTED' | 'FAILED' | 'CANCELLED' | 'STALE'

type SelfDevRole =
  | 'orchestrator' | 'developer' | 'verifier'
  | 'reviewer' | 'human-approver' | 'promotion-worker' | 'journal-anchor' | 'run-owner'

interface ActorBase {
  actorId: string
  role: SelfDevRole
  authenticationContextDigest: Digest
  principalBindingDigest: Digest
  credentialBindingDigest: Digest
}

interface HumanActorRef extends ActorBase {
  kind: 'human'
  role: 'human-approver'
  humanId: string
  keyId: string
  trustRootId: string
  keyRegistryBindingDigest: Digest
  revocationEpoch: number
}

interface HumanApproverRef extends HumanActorRef {
  kind: 'human'
  role: 'human-approver'
}

interface HumanRunOwnerRef extends ActorBase {
  kind: 'human'
  role: 'run-owner'
  humanId: string
}

interface ServiceActorRef extends ActorBase {
  kind: 'service'
  role: 'orchestrator' | 'verifier' | 'promotion-worker' | 'journal-anchor'
  serviceBuildDigest: Digest
  instanceId: string
}

interface ModelActorRef extends ActorBase {
  kind: 'model'
  role: 'developer'
  providerModelDigest: Digest
  isolatedSessionId: string
}

interface ModelReviewerActorRef extends ActorBase {
  kind: 'model'
  role: 'reviewer'
  providerModelDigest: Digest
  reviewerProfileDigest: Digest
  isolatedSessionId: string
}

interface ServiceReviewerActorRef extends ActorBase {
  kind: 'service'
  role: 'reviewer'
  serviceBuildDigest: Digest
  reviewerProfileDigest: Digest
  instanceId: string
  isolatedSessionId: string
}

type ReviewerActorRef = ModelReviewerActorRef | ServiceReviewerActorRef
type ActorRef = HumanApproverRef | HumanRunOwnerRef | ServiceActorRef | ModelActorRef | ReviewerActorRef
type HumanApproverIdentityRef = Omit<HumanApproverRef, 'authenticationContextDigest'>

interface ApprovalAuthenticationContext {
  schemaVersion: 1
  method: 'local-tty-os-reauth' | 'independent-approval-ui'
  actorIdentity: HumanApproverIdentityRef // avoids actor↔context digest cycle
  trustRootId: string
  keyRegistryBindingDigest: Digest
  osPrincipalDigest?: Digest
  ttyDeviceDigest?: Digest
  authenticatedAt: Timestamp
  expiresAt: Timestamp
  revocationEpoch: number
  contextDigest: Digest
}

type SignatureDomain =
  | 'selfdev.principal-binding.v1'
  | 'selfdev.credential-binding.v1'
  | 'selfdev.builtin-task-classifier-release-manifest.v1'
  | 'selfdev.task-class-attestation.v1'
  | 'selfdev.approval-challenge.v1'
  | 'selfdev.human-proof.v1'
  | 'selfdev.approval-receipt.v1'
  | 'selfdev.journal-anchor.v1'

type KeyUsage =
  | 'principal-binding-issuer'
  | 'credential-binding-issuer'
  | 'builtin-task-classifier-registry-issuer'
  | 'task-class-attestation-issuer'
  | 'human-approval-actor'
  | 'approval-challenge-issuer'
  | 'approval-receipt-issuer'
  | 'journal-anchor-issuer'

interface KeyRecordBase {
  keyId: string
  trustRootId: string
  algorithm: 'Ed25519' | 'ECDSA-P256-SHA256'
  publicKeySpkiDerBase64: string
  validFrom: Timestamp
  validUntil: Timestamp
  revokedAt?: Timestamp
  revocationEpoch: number
}

interface HumanApprovalKeyRecord extends KeyRecordBase {
  kind: 'human-approval-actor-key'
  usage: 'human-approval-actor'
  humanId: string
  actorId: string
  allowedRoles: readonly ['human-approver']
  allowedSignatureDomains: readonly ['selfdev.human-proof.v1']
}

interface BuiltinTaskClassifierRegistryIssuerKeyRecord extends KeyRecordBase {
  kind: 'builtin-task-classifier-registry-issuer-key'
  usage: 'builtin-task-classifier-registry-issuer'
  issuerId: string
  issuerBuildDigest: Digest
  allowedReleaseChannels: readonly ('stable' | 'beta' | 'development')[]
  allowedSignatureDomains: readonly ['selfdev.builtin-task-classifier-release-manifest.v1']
}

type ServiceIssuerKeyRecord =
  | (KeyRecordBase & {
      kind: 'service-issuer-key'
      usage: 'task-class-attestation-issuer'
      serviceActorId: string
      serviceRole: 'orchestrator'
      serviceBuildDigest: Digest
      allowedSignatureDomains: readonly ['selfdev.task-class-attestation.v1']
    })
  | (KeyRecordBase & {
      kind: 'service-issuer-key'
      usage: 'approval-challenge-issuer'
      serviceActorId: string
      serviceRole: 'orchestrator'
      serviceBuildDigest: Digest
      allowedSignatureDomains: readonly ['selfdev.approval-challenge.v1']
    })
  | (KeyRecordBase & {
      kind: 'service-issuer-key'
      usage: 'approval-receipt-issuer'
      serviceActorId: string
      serviceRole: 'orchestrator'
      serviceBuildDigest: Digest
      allowedSignatureDomains: readonly ['selfdev.approval-receipt.v1']
    })
  | (KeyRecordBase & {
      kind: 'service-issuer-key'
      usage: 'journal-anchor-issuer'
      algorithm: 'Ed25519'
      serviceActorId: string
      serviceRole: 'journal-anchor'
      serviceBuildDigest: Digest
      allowedSignatureDomains: readonly ['selfdev.journal-anchor.v1']
    })

type IdentityBindingIssuerKeyRecord =
  | (KeyRecordBase & {
      kind: 'identity-binding-issuer-key'
      usage: 'principal-binding-issuer'
      issuerKind: 'trust-root' | 'launcher' | 'auth-subsystem'
      issuerId: string
      issuerBuildDigest: Digest
      allowedActorKinds: readonly ('human' | 'service' | 'model')[]
      allowedRoles: readonly SelfDevRole[]
      allowedPurposeDomains: readonly ParticipantPurposeDomain[]
      allowedSignatureDomains: readonly ['selfdev.principal-binding.v1']
    })
  | (KeyRecordBase & {
      kind: 'identity-binding-issuer-key'
      usage: 'credential-binding-issuer'
      issuerKind: 'trust-root' | 'launcher' | 'auth-subsystem'
      issuerId: string
      issuerBuildDigest: Digest
      allowedActorKinds: readonly ('human' | 'service' | 'model')[]
      allowedRoles: readonly SelfDevRole[]
      allowedPurposeDomains: readonly ParticipantPurposeDomain[]
      allowedSignatureDomains: readonly ['selfdev.credential-binding.v1']
    })

interface SelfDevKeyRegistryPayload {
  schemaVersion: 1
  registryVersion: number
  trustRoots: readonly {
    trustRootId: string
    kind: 'local-os-bound-key' | 'independent-approval-service' | 'control-plane-service' | 'journal-anchor-service'
    rootKeyIds: readonly string[]
    purposes: readonly KeyUsage[]
  }[]
  keys: readonly (
    | HumanApprovalKeyRecord
    | BuiltinTaskClassifierRegistryIssuerKeyRecord
    | ServiceIssuerKeyRecord
    | IdentityBindingIssuerKeyRecord
  )[]
}

interface SelfDevKeyRegistryBinding {
  schemaVersion: 1
  registryEpoch: number
  previousBindingDigest?: Digest
  payloadArtifact: ArtifactRef            // canonical SelfDevKeyRegistryPayload bytes only
  payloadDigest: Digest
  bindingDigest: Digest
}

interface Signature {
  algorithm: 'Ed25519' | 'ECDSA-P256-SHA256'
  keyId: string
  domain: SignatureDomain
  valueBase64: string
}

type ParticipantPurposeDomain =
  | 'selfdev.participant.run-owner.v1' | 'selfdev.participant.human-approver.v1'
  | 'selfdev.participant.orchestrator.v1' | 'selfdev.participant.developer.v1'
  | 'selfdev.participant.verifier.v1' | 'selfdev.participant.reviewer.v1'
  | 'selfdev.participant.promotion-worker.v1' | 'selfdev.participant.journal-anchor.v1'

interface CredentialBindingPayload {
  schemaVersion: 1
  actorId: string
  actorKind: 'human' | 'service' | 'model'
  role: SelfDevRole
  purposeDomain: ParticipantPurposeDomain
  issuerKind: 'trust-root' | 'launcher' | 'auth-subsystem'
  issuerId: string
  issuerBuildDigest: Digest
  trustRootId: string
  subjectIdDigest: Digest
  keyId?: string
  opaqueCredentialHandleDigest: Digest       // stable identifier only; never credential/token bytes
  validFrom: Timestamp
  validUntil: Timestamp
  revocationEpoch: number
}

interface CredentialBinding {
  schemaVersion: 1
  payloadArtifact: ArtifactRef
  payloadDigest: Digest
  keyRegistryBindingDigest: Digest
  issuerSignature: Signature & { domain: 'selfdev.credential-binding.v1' }
  bindingDigest: Digest
}

interface PrincipalBindingPayload {
  schemaVersion: 1
  actorId: string
  actorKind: 'human' | 'service' | 'model'
  role: SelfDevRole
  purposeDomain: ParticipantPurposeDomain
  issuerKind: 'trust-root' | 'launcher' | 'auth-subsystem'
  issuerId: string
  issuerBuildDigest: Digest
  trustRootId: string
  principalSubjectDigest: Digest
  credentialBindingDigest: Digest
  validFrom: Timestamp
  validUntil: Timestamp
  revocationEpoch: number
}

interface PrincipalBinding {
  schemaVersion: 1
  payloadArtifact: ArtifactRef
  payloadDigest: Digest
  keyRegistryBindingDigest: Digest
  issuerSignature: Signature & { domain: 'selfdev.principal-binding.v1' }
  bindingDigest: Digest
}

interface ParticipantIdentity {
  actor: ActorRef
  participation: 'performed' | 'designated'
  principalBinding: PrincipalBinding
  credentialBinding: CredentialBinding
  identityDigest: Digest
}

interface ParticipantIdentitySet {
  schemaVersion: 1
  runId: string
  frozenStateVersion: number
  participants: readonly ParticipantIdentity[]
  forbiddenForReviewerIdentityDigests: readonly Digest[] // reducer-derived; never caller supplied
  identitySetDigest: Digest
}

type ReasonCode =
  | 'policy_invalid' | 'baseline_inconclusive' | 'security_invariant_failed'
  | 'integrity_failed' | 'budget_exhausted' | 'nonrepairable_verification'
  | 'acceptance_inconclusive'
  | 'reviewer_isolation_failed' | 'approval_invalid' | 'promotion_conflict'
  | 'recovery_failed' | 'human_rejected' | 'human_cancelled'
  | 'base_ref_moved' | 'promotion_ref_occupied' | 'promotion_reservation_expired'
  | 'approval_expired'

interface TypedReason {
  code: ReasonCode
  messageDigest: Digest
  evidence: readonly ArtifactRef[]
}

interface CanonicalRefMatcher {
  matcherVersion: 'selfdev-ref-matcher-v1'
  kind: 'exact' | 'prefix'
  value: string                         // canonical full ref or canonical full-ref prefix
}

interface ExistingFailureRepairRule {
  suiteId: string
  failureClassId: string                // emitted by trusted suite registry, never candidate text
  allowedTaskClassIds: readonly string[]
  maxBaselineOccurrences: number
}

type TaskClassifierStaticInputKind =
  | 'goal-canonical-bytes' | 'base-path-index'
  | 'base-tree-diff' | 'base-owned-metadata'

interface TaskClassifierPolicy {
  classifierEngineVersion: 'selfdev-task-classifier-v1'
  ruleDialectVersion: 'selfdev-task-classifier-rules-v1'
  allowedAuthoritativeTaskClassIds: readonly string[]
  allowedStaticInputKinds: readonly TaskClassifierStaticInputKind[]
  forcedHighRiskTaskClassIds: readonly string[]
  baselineExceptionEligibleTaskClassIds: readonly string[]
  maxStaticInputBytes: number
  fallbackRequiredReviewerCount: number
}

interface RiskClassificationPolicy {
  rulesVersion: 'selfdev-risk-rules-v1'
  highRiskPathPatterns: readonly string[]
  highRiskTaskClassIds: readonly string[]
  highRiskCapabilityIds: readonly string[]
  diffFilesAtLeast: number
  diffLinesAtLeast: number
  diffBytesAtLeast: number
  deterministicFindingSeverityAtLeast: 'low' | 'medium' | 'high' | 'blocker'
  requiredReviewerCount: { normal: number; high: number }
}

interface SelfDevPolicyCore {
  schemaVersion: 1
  latticeVersion: 'selfdev-policy-lattice-v1'
  canonicalizer: 'selfdev-cjson-v1'
  policyId: string
  capabilityRegistryVersion: string
  pathDialectVersion: string
  suiteRegistryDigest: Digest
  allowedPathPatterns: readonly string[]
  deniedPathPatterns: readonly string[]
  allowedCapabilities: readonly string[]
  deniedCapabilities: readonly string[]
  allowedSuiteIds: readonly string[]
  requiredSuiteIds: readonly string[]
  requiredSafetyCheckIds: readonly string[]
  requiredHoldoutIds: readonly string[]
  refs: {
    baseRefAllowMatchers: readonly CanonicalRefMatcher[]
    promotionRefAllowPrefixes: readonly string[]
    deniedRefMatchers: readonly CanonicalRefMatcher[]
    requirePromotionReservation: boolean
    reservationBackend: 'selfdev-store-cas-v1'
    maxReservationTtlMs: number
  }
  baseline: {
    existingFailureRepairRules: readonly ExistingFailureRepairRule[]
    forbidNewFailureClasses: boolean
    forbidIncreasedOccurrences: boolean
    forbidSeverityIncrease: boolean
    forbidIncreasedOutputBytes: boolean
    maxRepairableExistingFailures: number
  }
  taskClassification: TaskClassifierPolicy
  risk: RiskClassificationPolicy
  maxima: {
    budget: BudgetVector
    approvalTtlMs: number
    maxDiffFiles: number
    maxDiffLines: number
    maxDiffBytes: number
    maxSingleFileBytes: number
  }
  minimums: {
    qualityScorePermille: number
    holdoutPassPermille: number
    safetyPassPermille: number
    independentReviewerCount: number
  }
  grants: {
    allowRepair: boolean
    allowCandidateTests: boolean
    allowDocumentationChanges: boolean
    allowModelReviewer: boolean
  }
}

interface BuiltinOrUserSelfDevPolicy extends SelfDevPolicyCore {
  source: 'builtin' | 'user'
  taskClassifierConstraintRuleSet?: never
  policyDigest: Digest
}

interface BaseSelfDevPolicy extends SelfDevPolicyCore {
  source: 'base'
  taskClassifierConstraintRuleSet: {
    artifact: ArtifactRef
    digest: Digest
  }
  policyDigest: Digest
}

type SelfDevPolicy = BuiltinOrUserSelfDevPolicy | BaseSelfDevPolicy

interface EffectivePolicy extends Omit<SelfDevPolicyCore, 'policyId'> {
  source: 'effective'
  // Source-only taskClassifierConstraintRuleSet is intentionally absent; PolicyBinding carries the base declaration.
  sourcePolicyDigests: readonly [Digest, Digest, Digest] // builtin, user, base
  effectivePolicyDigest: Digest
}

interface PolicyBinding {
  builtinPolicyArtifact: ArtifactRef
  userPolicyArtifact: ArtifactRef
  basePolicyArtifact: ArtifactRef
  effectivePolicyArtifact: ArtifactRef
  builtinPolicyDigest: Digest
  userPolicyDigest: Digest
  basePolicyDigest: Digest
  effectivePolicyDigest: Digest
  baseTaskClassifierRuleSetArtifact: ArtifactRef // declaration extracted from basePolicyArtifact at baseSha
  baseTaskClassifierRuleSetDigest: Digest
  bindingDigest: Digest
}

interface TaskClassifierPredicate {
  dialect: 'selfdev-task-classifier-rules-v1'
  expressionArtifact: ArtifactRef          // canonical, non-Turing-complete registered rule bytecode
  expressionDigest: Digest
}

interface BuiltinTaskClassifierRule {
  source: 'builtin'
  ruleId: string
  predicate: TaskClassifierPredicate
  emitTaskClassId: string
  riskFloor: 'normal' | 'high'
}

interface BaseTaskClassifierConstraintRule {
  source: 'base'
  ruleId: string
  predicate: TaskClassifierPredicate
  constrainedTaskClassIds: readonly string[]
  effect: 'retain-only-if-match' | 'force-high-risk-if-match' | 'reject-static-input-if-match'
  // No emit/lower-risk/reviewer-decrement effect exists for base rules.
}

type TaskClassifierRuleSet =
  | {
      schemaVersion: 1
      classifierEngineVersion: 'selfdev-task-classifier-v1'
      ruleDialectVersion: 'selfdev-task-classifier-rules-v1'
      source: 'builtin'
      sourceBaseSha?: never
      rules: readonly BuiltinTaskClassifierRule[]
      mutuallyExclusiveClassGroups: readonly (readonly string[])[]
      ruleSetDigest: Digest
    }
  | {
      schemaVersion: 1
      classifierEngineVersion: 'selfdev-task-classifier-v1'
      ruleDialectVersion: 'selfdev-task-classifier-rules-v1'
      source: 'base'
      sourceBaseSha: GitObjectId
      rules: readonly BaseTaskClassifierConstraintRule[]
      mutuallyExclusiveClassGroups: readonly (readonly string[])[] // must copy builtin groups exactly
      ruleSetDigest: Digest
    }

interface BuiltinTaskClassifierRegistryPayload {
  schemaVersion: 1
  registryVersion: number
  classifierEngineVersion: 'selfdev-task-classifier-v1'
  ruleDialectVersion: 'selfdev-task-classifier-rules-v1'
  expectedBuiltinRuleSetDigest: Digest
  expectedMutuallyExclusiveClassGroupsDigest: Digest
  registeredTaskClassIds: readonly string[]
}

interface BuiltinTaskClassifierReleaseManifestPayload {
  schemaVersion: 1
  buildDigest: Digest
  releaseChannel: 'stable' | 'beta' | 'development'
  classifierRegistryEpoch: number
  classifierRegistryVersion: number
  classifierRegistryPayloadDigest: Digest
  expectedBuiltinRuleSetDigest: Digest
  expectedMutuallyExclusiveClassGroupsDigest: Digest
  signedAt: Timestamp
}

interface BuiltinTaskClassifierReleaseManifest {
  schemaVersion: 1
  payloadArtifact: ArtifactRef
  payloadDigest: Digest
  keyRegistryBindingDigest: Digest
  issuerId: string
  issuerSignature: Signature & { domain: 'selfdev.builtin-task-classifier-release-manifest.v1' }
  manifestDigest: Digest
}

interface BuiltinTaskClassifierRegistryBinding {
  schemaVersion: 1
  registryEpoch: number
  previousBindingDigest?: Digest
  trustRootId: string
  releaseManifest: BuiltinTaskClassifierReleaseManifest
  payloadArtifact: ArtifactRef
  payloadDigest: Digest
  bindingDigest: Digest
}

interface BuiltinTaskClassifierRuleSetRef {
  artifact: ArtifactRef
  rulesDigest: Digest
  source: 'builtin'
  builtinRegistryBindingDigest: Digest
}

interface BaseTaskClassifierRuleSetRef {
  artifact: ArtifactRef
  rulesDigest: Digest
  source: 'base'
  sourceBaseSha: GitObjectId               // must equal run baseSha
  basePolicyDigest: Digest                 // must equal PolicyBinding.basePolicyDigest
  // rulesDigest/artifact must equal PolicyBinding.baseTaskClassifierRuleSet{Digest,Artifact}
}

interface TaskClassifierDefinition {
  schemaVersion: 1
  classifierEngineVersion: 'selfdev-task-classifier-v1'
  ruleDialectVersion: 'selfdev-task-classifier-rules-v1'
  builtinRegistryBinding: BuiltinTaskClassifierRegistryBinding
  builtinRules: BuiltinTaskClassifierRuleSetRef
  baseConstraintRules: BaseTaskClassifierRuleSetRef
  mutuallyExclusiveClassGroupsDigest: Digest
  policyBindingDigest: Digest
  effectivePolicyDigest: Digest
  definitionDigest: Digest
}

interface TaskClassifierTrustedInput {
  kind: TaskClassifierStaticInputKind
  provenance: 'trusted-control-plane' | 'base-sha'
  artifact: ArtifactRef
  sourceDigest: Digest
}

interface TaskClassifierTrustedInputPayload {
  schemaVersion: 1
  goalCanonicalArtifact: ArtifactRef       // canonical text + acceptance criteria; excludes caller hints
  goalCanonicalBytesDigest: Digest
  baseSha: GitObjectId
  basePathIndexArtifact: ArtifactRef
  basePathIndexDigest: Digest
  trustedStaticInputs: readonly TaskClassifierTrustedInput[]
  trustedStaticInputBytes: number
  trustedStaticInputSetDigest: Digest
  trustedInputDigest: Digest                // terminal digest; candidate/model input is impossible by schema
}

interface TaskClassifierRequestBinding {
  schemaVersion: 1
  trustedInputArtifact: ArtifactRef
  trustedInputDigest: Digest
  callerTaskClassHints: readonly string[]
  callerTaskClassHintsDigest: Digest
  requestBindingDigest: Digest
}

type TaskClassificationFallbackReason =
  | 'unknown-class' | 'classifier-failure' | 'hint-mismatch'
  | 'conflicting-rules' | 'unsupported-static-input' | 'policy-empty-class-set'

interface TaskClassificationResult {
  schemaVersion: 1
  classifierDefinitionDigest: Digest
  trustedInputDigest: Digest
  classifierRequestBindingDigest: Digest
  callerTaskClassHintsDigest: Digest
  policyBindingDigest: Digest
  effectivePolicyDigest: Digest
  classificationStatus: 'authoritative' | 'fallback-high-risk'
  authoritativeTaskClassIds: readonly string[] // empty for fallback-high-risk
  matchedBuiltinRuleIds: readonly string[]
  matchedBaseConstraintRuleIds: readonly string[]
  riskFloor: 'normal' | 'high'
  requiredReviewerCount: number
  baselineExceptionAuthorizedTaskClassIds: readonly string[] // authoritative ∩ effective eligible; empty on fallback
  fallbackReasons: readonly TaskClassificationFallbackReason[]
  classificationResultDigest: Digest       // deterministic for identical definition/request/policy
}

interface TaskClassAttestation {
  schemaVersion: 1
  runId: string
  classifierDefinitionDigest: Digest
  trustedInputDigest: Digest
  classifierRequestBindingDigest: Digest
  policyBindingDigest: Digest
  effectivePolicyDigest: Digest
  classificationResultDigest: Digest
  keyRegistryBindingDigest: Digest
  issuedBy: ServiceActorRef & { role: 'orchestrator' }
  issuedAt: Timestamp
  issuerSignature: Signature & { domain: 'selfdev.task-class-attestation.v1' }
  attestationDigest: Digest
}

interface BudgetVector {
  wallClockMs: number
  inputTokens: number
  outputTokens: number
  modelCostMicrounits: string       // canonical non-negative integer string
  toolCalls: number
  changedFiles: number
  changedLines: number
  maxSingleFileBytes: number
  scratchBytes: number
  artifactBytes: number
  suiteRuns: number
  concurrentWorkers: number
  repairAttempts: number
}

interface RunBudget {
  limits: BudgetVector
  consumed: BudgetVector
  reserved: BudgetVector
  limitsDigest: Digest
  usageDigest: Digest                    // consumed + all outstanding reservations
  budgetDigest: Digest
}

interface SuiteResult {
  suiteId: string
  suiteDefinitionDigest: Digest
  kind: 'baseline' | 'required' | 'holdout' | 'safety'
  subject: 'base' | 'candidate'
  subjectSourceDigest: Digest
  environmentDigest: Digest
  checkRunContextDigest: Digest
  status: 'pass' | 'fail' | 'inconclusive'
  exitCode?: number
  failureSummaries: readonly {
    failureClassId: string
    severity: 'low' | 'medium' | 'high' | 'blocker'
    occurrences: number
    outputBytes: number
    outputDigest: Digest
  }[]
  artifacts: readonly ArtifactRef[]
  startedAt: Timestamp
  completedAt: Timestamp
  resultDigest: Digest
}

interface BaselineBundle {
  schemaVersion: 1
  runId: string
  baseRef: string
  baseSha: GitObjectId
  policyDigest: Digest
  taskClassificationResultDigest: Digest
  taskClassAttestationDigest: Digest
  environmentDigest: Digest
  suites: readonly SuiteResult[]
  verdict: 'pass' | 'fail' | 'inconclusive'
  bundleDigest: Digest
  completedAt: Timestamp
}

interface PromotionRefReservation {
  schemaVersion: 1
  backend: 'selfdev-store-cas-v1'
  reservationId: string
  runId: string
  promotionRef: string
  effectivePolicyDigest: Digest
  acquiredStateVersion: number
  acquiredAt: Timestamp
  expiresAt: Timestamp
  reservationDigest: Digest
}

interface MutationAuthority {
  schemaVersion: 1
  runId: string
  leaseId: string
  holder: string
  role: Exclude<SelfDevRole, 'human-approver' | 'run-owner'>
  fencingToken: string                 // canonical non-negative integer; monotonically increases per run
  generation: number
  authorizedState: SelfDevState
  authorizedStateVersion: number
  expiresAt: Timestamp
  authorityDigest: Digest
}

interface SelfDevRun {
  schemaVersion: 1
  runId: string
  version: number                    // CAS version
  state: SelfDevState
  goal: {
    text: ArtifactRef
    taskClassHints: readonly string[]       // caller-provided, untrusted, never authoritative
    acceptanceCriteria: readonly string[]
    goalDigest: Digest
  }
  createdBy: ActorRef
  keyRegistryBinding: SelfDevKeyRegistryBinding
  baseRef: string                     // existing full ref; head must equal baseSha
  baseSha: GitObjectId
  promotionRef: string                // new local refs/heads/...; must not exist
  promotionRefReservation?: PromotionRefReservation
  policy: PolicyBinding
  taskClassifierDefinitionArtifact: ArtifactRef
  taskClassifierDefinitionDigest: Digest
  taskClassifierTrustedInputArtifact: ArtifactRef
  taskClassifierTrustedInputDigest: Digest
  taskClassifierRequestBindingArtifact: ArtifactRef
  taskClassifierRequestBindingDigest: Digest
  taskClassificationResultArtifact: ArtifactRef
  taskClassificationResultDigest: Digest
  taskClassAttestationArtifact: ArtifactRef
  taskClassAttestationDigest: Digest
  participantIdentitySetArtifact?: ArtifactRef
  participantIdentitySetDigest?: Digest
  environmentDigest?: Digest
  lease?: MutationAuthority
  lastIssuedFencingToken: string       // durable high-water mark; never decreases or reuses a value
  budget: RunBudget
  repair: { generation: number; attempts: number; limit: number }
  baselineBundleDigest?: Digest
  candidateManifestDigest?: Digest
  promotionPlanDigest?: Digest
  verificationBundleDigest?: Digest
  acceptanceReportDigest?: Digest
  approvalContextArtifact?: ArtifactRef
  approvalContextDigest?: Digest
  approvalReceiptDigest?: Digest
  approvalConsumptionDigest?: Digest
  promotionReceiptDigest?: Digest
  createdAt: Timestamp
  updatedAt: Timestamp
  terminalReason?: TypedReason
}

interface CandidateManifest {
  schemaVersion: 1
  runId: string
  generation: number
  baseRef: string
  baseSha: GitObjectId
  policyDigest: Digest
  parentCandidateDigest?: Digest
  entries: readonly { path: string; mode: number; size: number; sha256: Digest }[]
  patchDigest: Digest
  treeDigest: Digest
  gitTreeObjectId: GitObjectId
  candidateDigest: Digest
  sealedAt: Timestamp
}

interface GitIdentityPlan {
  nameBytesBase64: string
  emailBytesBase64: string
  timestampSeconds: string              // canonical Unix seconds; no promotion-time clock read
  timezoneOffsetBytes: string            // exact ASCII ±HHMM; validated by schema
}

interface CommitHeaderPlan {
  nameAscii: string                     // exact header name; reserved structural headers forbidden here
  valueBytesBase64: string              // exact raw value, including canonical continuation bytes
}

interface CommitObjectPlan {
  schemaVersion: 1
  objectFormat: 'sha1' | 'sha256'
  rawEncoding: 'git-commit-object-v1'
  treeObjectId: GitObjectId
  parentObjectIds: readonly [GitObjectId] // exactly baseSha in v1
  author: GitIdentityPlan
  committer: GitIdentityPlan
  encodingHeaderValueBytesBase64?: string
  extraHeaders: readonly CommitHeaderPlan[] // ordered; order is part of the object bytes
  signaturePolicy: { mode: 'unsigned-v1'; policyDigest: Digest }
  messageBytes: ArtifactRef             // encoding=raw-bytes-v1; exact bytes, including final newline policy
  rawCommitPayload: ArtifactRef         // exact bytes after trusted serialization, excluding `commit <n>\0`
  expectedCommitObjectId: GitObjectId   // precomputed using objectFormat over exact Git object bytes
  objectPlanDigest: Digest
}

interface GitRefTransactionPlan {
  schemaVersion: 1
  objectFormat: 'sha1' | 'sha256'
  verifyBase: { ref: string; expectedObjectId: GitObjectId }
  createPromotion: {
    ref: string
    expectedOldObjectId: null            // encoded as repository-format all-zero OID
    newObjectId: GitObjectId
  }
  transactionPlanDigest: Digest
}

interface PromotionPlan {
  schemaVersion: 1
  runId: string
  baseRef: string
  baseSha: GitObjectId                 // commit parent and freshness anchor
  promotionRef: string                 // must not exist before commit point
  candidateDigest: Digest
  candidateTreeDigest: Digest
  gitTreeObjectId: GitObjectId
  commitObjectPlan: CommitObjectPlan
  refTransactionPlan: GitRefTransactionPlan
  planDigest: Digest
}

interface VerificationBundle {
  schemaVersion: 1
  runId: string
  baseRef: string
  baseSha: GitObjectId
  candidateDigest: Digest
  policyDigest: Digest
  taskClassificationResultDigest: Digest
  taskClassAttestationDigest: Digest
  promotionPlanDigest: Digest
  environmentDigest: Digest
  baselineBundleDigest: Digest
  candidate: readonly SuiteResult[]
  holdouts: readonly SuiteResult[]
  safetyChecks: readonly SuiteResult[]
  artifacts: readonly ArtifactRef[]
  verdict: 'pass' | 'fail' | 'inconclusive'
  verifierDigest: Digest
  bundleDigest: Digest
  completedAt: Timestamp
}

interface ReviewerIsolationAttestation {
  schemaVersion: 1
  reviewer: ReviewerActorRef
  reviewerId: string                    // must equal reviewer.actorId
  principalBindingDigest: Digest        // reviewer-only service/model principal; never approval key
  credentialBindingDigest: Digest       // opaque key/account binding; no secret bytes
  taskClassificationResultDigest: Digest
  taskClassAttestationDigest: Digest
  participantIdentitySetDigest: Digest  // complete performed + designated set, not actor-id-only exclusions
  isolatedSessionId: string
  reviewerRuntimeDigest: Digest
  runnerProfileDigest: Digest
  promptDigest: Digest
  contextSourceInstanceId: string        // fresh per reviewer and run
  contextSourceManifestDigest: Digest
  sealedEvidenceSourceDigests: readonly Digest[]
  typedInputEnvelopeDigest: Digest
  decoderDigest: Digest
  attestationDigest: Digest
}

interface AdvisoryReview {
  reviewer: ReviewerActorRef
  isolationAttestationDigest: Digest
  recommendation: 'accept' | 'repair' | 'reject' | 'inconclusive'
  findings: readonly { severity: 'blocker' | 'high' | 'medium' | 'low'; evidence: ArtifactRef }[]
  parsedOutputArtifact: ArtifactRef
  reviewDigest: Digest
}

interface AcceptanceReport {
  schemaVersion: 1
  runId: string
  baseRef: string
  baseSha: GitObjectId
  candidateDigest: Digest
  policyDigest: Digest
  taskClassificationResultDigest: Digest
  taskClassAttestationDigest: Digest
  participantIdentitySetDigest: Digest
  promotionPlanDigest: Digest
  verificationBundleDigest: Digest
  deterministicGateDigest: Digest
  risk: 'normal' | 'high'
  requiredIndependentReviewers: number
  reviewerIndependenceDigest: Digest
  isolationAttestations: readonly ReviewerIsolationAttestation[]
  advisoryReviews: readonly AdvisoryReview[]
  aggregateAdvisory: 'accept' | 'repair' | 'reject' | 'inconclusive'
  reportDigest: Digest
  completedAt: Timestamp
}

interface ApprovalContext {
  schemaVersion: 1
  runId: string
  runState: 'AWAITING_HUMAN'
  awaitingHumanStateVersion: number
  goalDigest: Digest
  taskClassifierRegistryBindingDigest: Digest
  taskClassifierDefinitionDigest: Digest
  taskClassifierTrustedInputDigest: Digest
  taskClassifierRequestBindingDigest: Digest
  taskClassificationResultDigest: Digest
  taskClassAttestationDigest: Digest
  participantIdentitySetDigest: Digest
  keyRegistryBindingDigest: Digest
  generation: number
  budgetLimitsDigest: Digest
  budgetUsageDigest: Digest
  baselineBundleDigest: Digest
  environmentDigest: Digest
  candidateManifestDigest: Digest
  candidateDigest: Digest
  policyBindingDigest: Digest
  effectivePolicyDigest: Digest
  promotionRefReservationDigest: Digest
  promotionPlanDigest: Digest
  verificationBundleDigest: Digest
  acceptanceReportDigest: Digest
  frozenAt: Timestamp
  approvalContextDigest: Digest
}

interface ApprovalReceipt {
  schemaVersion: 1
  runId: string
  baseRef: string
  baseSha: GitObjectId
  promotionRef: string
  candidateDigest: Digest
  policyDigest: Digest
  taskClassificationResultDigest: Digest
  taskClassAttestationDigest: Digest
  participantIdentitySetDigest: Digest
  promotionPlanDigest: Digest
  verificationBundleDigest: Digest
  acceptanceReportDigest: Digest
  approvalContextDigest: Digest
  challengeDigest: Digest
  humanProofDigest: Digest
  keyRegistryBindingDigest: Digest
  actor: HumanApproverRef
  issuer: ServiceActorRef & { role: 'orchestrator' }
  nonce: string
  issuedAt: Timestamp
  expiresAt: Timestamp
  decision: 'approve'
  humanProofActorSignature: Signature & { domain: 'selfdev.human-proof.v1' }
  issuerSignature: Signature & { domain: 'selfdev.approval-receipt.v1' }
  receiptDigest: Digest
}

interface ApprovalConsumption {
  schemaVersion: 1
  runId: string
  approvalReceiptDigest: Digest
  promotionEffectKey: string
  consumedStateVersion: number
  consumedAt: Timestamp
  consumptionDigest: Digest
}

interface PromotionReceipt {
  schemaVersion: 1
  runId: string
  promotionPlanDigest: Digest
  approvalConsumptionDigest: Digest
  effectKey: string
  refTransactionPlanDigest: Digest
  verifiedBaseObjectId: GitObjectId
  expectedCommitObjectId: GitObjectId
  commitObjectId: GitObjectId
  promotionRef: string
  previousRefObjectId: null             // v1 requires ref absence
  completedAt: Timestamp
  receiptDigest: Digest
}

interface ArtifactRef {
  schemaVersion: 1
  encoding: 'raw-bytes-v1' | 'selfdev-cjson-v1'
  digestDomain: string
  mediaType: string
  size: number
  sha256: Digest
  storageKey: string                  // 内容寻址；不能是可变路径的信任依据
  createdAt: Timestamp
  artifactRefDigest: Digest
}

type EffectRecoveryClass =
  | 'transactional-queryable'
  | 'idempotent-retryable'
  | 'opaque-ambiguous'

interface EffectIntent {
  schemaVersion: 1
  runId: string
  effectKey: string
  attemptId: string
  recoveryClass: EffectRecoveryClass
  authority: MutationAuthority
  reservedBudget: BudgetVector
  inputDigest: Digest
  recordedAt: Timestamp
  intentDigest: Digest
}

interface EffectReceipt {
  schemaVersion: 1
  runId: string
  effectKey: string
  attemptId: string
  recoveryClass: EffectRecoveryClass
  outcome: 'committed' | 'failed' | 'inconclusive'
  outcomeDigest: Digest
  chargedBudget: BudgetVector
  completedAt: Timestamp
  receiptDigest: Digest
}

type JournalEventType =
  | 'state.transitioned' | 'lease.acquired' | 'lease.released'
  | 'effect.intent_recorded' | 'effect.receipt_recorded'
  | 'approval_nonce.consumed' | 'approval_receipt.consumed'
  | 'cancellation.requested' | 'checkpoint.created'

interface JournalEntry {
  schemaVersion: 1
  runId: string
  sequence: number
  previousEntryDigest: Digest
  stateVersion: number
  actor: ActorRef
  eventType: JournalEventType
  effectKey?: string
  payloadDigest: Digest
  at: Timestamp
  entryDigest: Digest
}

interface JournalAnchor {
  schemaVersion: 1
  runId: string
  anchorVersion: string                 // independent store monotonic counter
  storeGeneration: string
  maxSequence: number
  chainHeadDigest: Digest
  checkpointDigest?: Digest
  previousAnchorDigest?: Digest
  anchoredAt: Timestamp
  trustRootId: string
  keyRegistryBindingDigest: Digest
  issuer: ServiceActorRef & { role: 'journal-anchor' }
  signedPayloadDigest: Digest
  signature: Signature & { domain: 'selfdev.journal-anchor.v1' }
  anchorDigest: Digest
}

interface ProposeRunInput {
  goal: {
    text: ArtifactRef
    taskClassHints: readonly string[]   // optional empty set means “no assertion”; never authoritative
    acceptanceCriteria: readonly string[]
  }
  baseRef: string
  expectedBaseSha: GitObjectId
  promotionRef?: string                // omitted => deterministic refs/heads/selfdev/<runId>
  userPolicy: ArtifactRef
  requestedBudget: Partial<BudgetVector>
}

interface ReadonlyEvidenceIndex {
  runId: string
  stateVersion: number
  digests: readonly Digest[]
  artifacts: readonly ArtifactRef[]
  indexDigest: Digest
}

interface ApprovalChallenge {
  schemaVersion: 1
  runId: string
  expectedStateVersion: number
  approvalContextDigest: Digest
  taskClassificationResultDigest: Digest
  taskClassAttestationDigest: Digest
  participantIdentitySetDigest: Digest
  keyRegistryBindingDigest: Digest
  baseRef: string
  baseSha: GitObjectId
  promotionRef: string
  candidateDigest: Digest
  policyDigest: Digest
  promotionPlanDigest: Digest
  verificationBundleDigest: Digest
  acceptanceReportDigest: Digest
  actor: HumanApproverRef
  issuer: ServiceActorRef & { role: 'orchestrator' }
  nonce: string
  issuedAt: Timestamp
  expiresAt: Timestamp
  issuerSignature: Signature & { domain: 'selfdev.approval-challenge.v1' }
  challengeDigest: Digest
}

interface HumanProof {
  actor: HumanApproverRef
  keyRegistryBindingDigest: Digest
  challengeDigest: Digest
  approvalContextDigest: Digest
  exactResponseDigest: Digest
  signedAt: Timestamp
  actorSignature: Signature & { domain: 'selfdev.human-proof.v1' }
  proofDigest: Digest
}

interface HumanConfirmationInput {
  proof: HumanProof
  exactResponse: string                // ephemeral transport; never persisted
}
```

`ArtifactRef` 自身使用 `selfdev.artifact-ref.v1 || selfdev-cjson-v1(record-without-artifactRefDigest)` canonicalize/digest；`sha256` 只表示重新读取后的原始 content bytes。`storageKey` 只是定位提示，消费前必须按 content digest 重读校验。Journal 以 `previousEntryDigest` 形成 hash chain；周期 checkpoint 必须绑定链头、run version 和 store generation。hash chain 本身只能称 **corruption-evident**：能发现无意损坏，却不能阻止有本地写权限的攻击者重写整条链或回滚旧快照。

production 的 **tamper-evident** 声明必须额外依赖独立 `JournalAnchorStore`：它位于仓库、候选 worktree、普通 storage adapter 和全部 Runner 的写权限之外，只使用最新 registry binding 中 usage=`journal-anchor-issuer`、domain=`selfdev.journal-anchor.v1`、service role=`journal-anchor` 且 build/validity/revocation 均匹配的受保护不可导出 Ed25519 key。它维护 append-only 记录与单调 `anchorVersion`；identity-binding/classifier issuer、human approval key、challenge/receipt issuer key 均不得跨域签 anchor。Anchor service 只接受 `previousAnchorDigest` 和当前受权 CAS transition/effect receipt 均匹配的下一个链头；本地状态只有在 anchor CAS 成功后才可对外确认 committed。恢复必须从独立 store 取得最新 counter/registry epoch，验证 signature、完整 journal 链、checkpoint、store generation 和链头；整链重写、旧有效签名 rollback 或 registry rollback 均会被检测。Anchor 不可用或校验不明时 §18 必须停止，不能降级为本地 hash chain 后仍宣称 production/tamper-evident。

该保证的信任边界是防候选、模型 Runner 和被篡改的本地 run store；已攻陷的 host administrator、anchor service 或其 signing key 不在保证内，必须由平台 incident/revocation 流程处理。截断、重排、重复 sequence、未知 schema、完整链重写、anchor rollback、key revocation 或 counter 回退都导致 fail closed。

所有 digest 使用 domain-separated canonical encoding，例如 `selfdev.approval-receipt.v1 || canonicalPayload`，不能只 hash 字段拼接。每个 `Signature` 签名相同 domain 下、排除该 signature 字段与对象 terminal self-digest 后的 canonical payload；外层对象 digest 再覆盖签名 bytes。`ApprovalReceipt.humanProofActorSignature` 是已校验 HumanProof 的原签名副本，Receipt issuer signature 则覆盖该副本与 `humanProofDigest`。Challenge nonce 在 `AWAITING_HUMAN → APPROVED` 的 CAS 中消费一次；`ApprovalReceipt` 是另一种 single-use capability，在 `APPROVED → PROMOTING` 的 CAS 中消费并生成 `ApprovalConsumption`；`PromotionReceipt` 只证明 Git effect 的幂等结果，三者的用途和消费记录不得复用。

### 18.7 Public API / CLI 提案与人工确认语义

本节 API/CLI **尚未实现**；命名在实现阶段仍可走兼容性评审，但语义不可弱化。

```ts
interface SelfDevelopmentService {
  propose(input: ProposeRunInput, actor: ActorRef): Promise<SelfDevRun>
  start(runId: string, expectedVersion: number, actor: ActorRef): Promise<SelfDevRun>
  get(runId: string): Promise<SelfDevRun>
  evidence(runId: string): Promise<ReadonlyEvidenceIndex>
  cancel(runId: string, expectedVersion: number, reason: string, actor: ActorRef): Promise<SelfDevRun>
  requestChanges(runId: string, expectedVersion: number, reason: string, actor: ActorRef): Promise<SelfDevRun>
  reject(runId: string, expectedVersion: number, reason: string, actor: ActorRef): Promise<SelfDevRun>
  approvalChallenge(runId: string, actor: HumanApproverRef): Promise<ApprovalChallenge>
  approve(challenge: ApprovalChallenge, input: HumanConfirmationInput): Promise<ApprovalReceipt>
}
```

建议 CLI namespace 为 `apollo selfdev`，与现有 `apollo evolution show|rollback`（§15 参数调优）严格分离：

```text
apollo selfdev propose --goal-file <path> --base-ref <full-ref> --base-sha <sha> [--task-class-hint <id>] [--promotion-ref <new-local-ref>]
apollo selfdev start <runId>
apollo selfdev status <runId> [--json]
apollo selfdev evidence <runId>
apollo selfdev cancel <runId> --reason <text>
apollo selfdev request-changes <runId> --reason <text>
apollo selfdev reject <runId> --reason <text>
apollo selfdev approve <runId>
```

`baseRef` 和 `promotionRef` 必须是 canonical full refs，并通过 EffectivePolicy 的 allow matcher/prefix 与 deny matcher。v1 的 `baseRef` 只允许匹配的本地基线 branch；`promotionRef` 只允许受控 `refs/heads/` 前缀，禁止 `HEAD`、symbolic ref、tag、remote-tracking ref 和任意 refspec。调用方省略 promotion ref 时，由 runId 确定性派生；一旦 `PROPOSED` 持久化就不可改变。Policy 要求的 `selfdev-store-cas-v1` reservation 必须由 runId 独占并续期到 Git transaction；它只阻止其他 SelfDev run 竞争，不锁住外部 Git actor，因此绝不能替代 transaction 内的 ref verify/create。

`--task-class-hint`/`ProposeRunInput.goal.taskClassHints` 只记录 caller 的不可信猜测；省略表示“不作声明”，不会成为 unknown。非空 hints 与可信 classifier 结果不完全一致则触发 `hint-mismatch` fallback，绝不能用它选择 baseline exception 或减少 reviewer。API 不接受 caller-supplied authoritative class、classifier rule、participant binding issuer 或候选生成的 classification artifact。

审批字段按阶段冻结，不能在同一个 run 上 patch-in-place：`PROPOSED` 固定 goal/hints、`baseRef@baseSha`、`promotionRef`、policy source/effective artifacts、TaskClassifier registry/definition/trusted-input/request/result/signed-attestation 和 budget limits；`BASELINING` 完成固定 baseline/environment；`SEALING` 固定 generation、CandidateManifest 与完整 CommitObjectPlan；`VERIFYING → ACCEPTING` transition 原子冻结完整 ParticipantIdentitySet，`VERIFYING`/`ACCEPTING` 分别固定 VerificationBundle/AcceptanceReport。进入 `AWAITING_HUMAN` 前必须停止全部 worker，并固定 active-execution budget usage；等待时间只由 approval TTL 计量。Orchestrator 随后持久化：

```text
approvalContextDigest = sha256(
  "selfdev.approval-context.v1" || canonical(ApprovalContext)
)
```

该 context 必须覆盖 goal/hints、TaskClassifier registry/definition/request、TaskClassificationResult、signed TaskClassAttestation、完整 ParticipantIdentitySet、runId、`AWAITING_HUMAN` state version、generation、budget limits 与 usage、baseline/environment、candidate、policy binding/effective policy、promotion-ref reservation、key-registry binding、CommitObjectPlan/GitRefTransactionPlan/PromotionPlan、verification 和 acceptance。Challenge、HumanProof、ApprovalReceipt 逐层绑定该 context、registry binding 与 `challengeDigest`；任何覆盖字段、identity/classifier binding、registry epoch/bytes、reservation、usage、version、generation 或 artifact bytes 变化，必须先吊销 challenge/未消费 receipt，再走新的 repair/stale/failure transition 并重新生成 context，绝不能沿用旧签名。

`approve` 的精确交互契约：

1. 必须提供 `HumanApproverRef`，并通过最新 `SelfDevKeyRegistryBinding` 中未撤销、usage/domain/角色绑定正确的 human key 与未过期 `ApprovalAuthenticationContext` 认证；交互只能是本地 TTY + recent OS re-auth，或独立受信审批界面。先以 CAS 重读 `AWAITING_HUMAN` 最新版本、registry epoch 和独立 journal anchor。
2. UI 完整显示 `approvalContextDigest`、registry/reservation、TaskClassificationResult/TaskClassAttestation/ParticipantIdentitySet digest、authoritative/fallback classification、`runId`/state version/generation、`baseRef@baseSha`、新建的 `promotionRef`、全部 candidate/policy/plan/verification/acceptance digest、预计算 `expectedCommitObjectId`、commit raw-byte plan、原子 base-verify/promotion-create transaction plan、diff、deterministic 硬门、advisory findings、预算 limits/usage、repair 次数和 TTL。
3. 控制面生成至少 128-bit 随机一次性 nonce，并只用 registry 中 `approval-challenge-issuer` service key/domain 签名完整 challenge；用户必须准确输入 UI 给出的 `approve <candidate-short-digest> <nonce-challenge>`。`HumanProof.actorSignature` 只能用 `human-approval-actor` key/domain，覆盖 `actor + registryBindingDigest + challengeDigest + approvalContextDigest + exactResponseDigest + signedAt`。
4. 服务端重新计算全部 digest，查询最新 registry binding/epoch，按 usage/domain/actor/service/build/root/expiry/revocation 校验 challenge issuer、HumanProof actor 和 receipt issuer 三种不同 key；再校验 auth context、TTL、nonce、exact response、base/ref preflight。随后在同一 store CAS 中消费 challenge nonce 并签发绑定 `challengeDigest + humanProofDigest + approvalContextDigest + keyRegistryBindingDigest` 的 Receipt。默认 TTL 由 builtin policy 限定，user/base policy 只能缩短。
5. 不提供 `--yes`、`--force`、环境变量确认、pipe/stdin 自动确认或模型 tool-call 确认。非 TTY 只能导入由独立受信审批界面/硬件身份签发的同结构签名 receipt，不能降级成布尔值。
6. request-changes、reject、key 撤销、auth context/TTL 过期、base/promotion ref 变化或任一 context 字段变化都使旧 challenge/receipt 永久失效；receipt 消费时还要按当前 registry/anchor 再验证一次。

Human approval 只授权**该 ApprovalReceipt 绑定的 PromotionPlan**：精确 parent/tree/raw commit、`expectedCommitObjectId`，以及同 transaction 的 `verify baseRef@baseSha + create promotionRef expected-zero`。进入 `PROMOTING` 时 receipt 再作为 single-use capability 原子消费；它不授权 push、merge、tag、publish、release、其他 ref 或未来修复 generation。

### 18.8 预算、修复、崩溃恢复、取消与回滚

`RunBudget` 至少包含 wall-clock、模型 token/费用、tool calls、变更文件数、增加/删除行、单文件大小、scratch/artifact 字节、suite 次数、并发数和 repair attempts。effective policy 对每项给出硬上限；缺失上限不是无限，而是不能启动。每个 effect attempt 开始前必须用 CAS 预留 worst-case budget；每个已启动 attempt（包括 crash、timeout、provider unknown 和 suite inconclusive）都计费，只有受信 receipt 能证明未使用部分时才可释放预留。超限先原子记录原因，再停止 Runner，不能靠删除 evidence 续跑。

修复规则：

- 每次 repair 从 sealed generation 复制到一个新的可写 generation；旧 manifest/evidence 保留。
- Reviewer/Verifier 给 Developer 的反馈必须是规范化 finding，不传递隐藏 holdout 内容、grader secrets 或审批凭据。
- 安全不变量、策略越界、证据篡改和 reviewer isolation 失败不可自动修复，直接 `FAILED`。
- 普通测试/验收失败只有在 repair budget 内才可转 `REPAIRING`；每次都重新 seal、完整 verify、independent review 和 human approval。

崩溃恢复规则：

- Orchestrator 从 journal + checkpoint + 最新独立 JournalAnchor 纯函数重建状态；链、signature、anchor counter 或 store generation 任一不一致即停止。
- 外部 effect 执行前写带 recovery class 与预算预留的 `EffectIntent`，执行后写 `EffectReceipt`。系统只承诺 exactly-once committed state；attempt 可能物理执行多次或留下未知结果，绝不把它误报为 exactly-once execution。
- `transactional-queryable`（例如 store CAS、Git ref transaction）在恢复时查询权威状态并 reconcile；`idempotent-retryable`（例如内容寻址 artifact put）可用同一 key 重试并逐 attempt 计费；`opaque-ambiguous`（provider/model 调用、任意 suite process）在 receipt 缺失时**禁止盲重放**，模型调用转 `FAILED/recovery_failed`，suite 转 `inconclusive`，后续只能由新 repair generation 或新 run 产生新 attempt。
- 在状态跃迁、文件 seal、suite 完成、approval 消费和 ref 创建之间的每个崩溃点都必须有故障注入测试；特别测试“授权已通过、提交前暂停”时 lease 被 steal，旧 worker 恢复后仍必须因 fence/version 不匹配而失败。
- 过期 lease 由恢复 worker 撤销；新 holder 通过 CAS 取得严格更大的 `fencingToken` 和独立 worktree。每个 mutable file/tool/effect 在真正 commit 前必须重读并匹配 `leaseId + fencingToken + generation + stateVersion`；旧 Runner 已确认停止后才允许 seal。

取消/回滚规则：

- Cancel 是异步、幂等的：只对 `CANCELLABLE` 集合先 CAS 到 `CANCEL_REQUESTED`，再停止模型/进程、撤销 lease、隔离 worktree，最后 `CANCELLED`；审计和内容寻址 evidence 按 retention policy 保留。
- `APPROVED → PROMOTING` 是 **store commit point**：Cancel 与它竞争同一个 run version；cancel 先赢则 promotion 不得开始，promotion 先赢则 cancel 返回 `promotion_commit_in_progress`。它只消费 approval/write intent，不是 Git freshness authorization；Git commit point 是下述原子 ref transaction 成功。
- 未 promotion 时，回滚等于丢弃候选 worktree，不触碰用户当前 worktree。
- promotion 只按已批准 PromotionPlan 原子创建一个新的本地 `promotionRef`（缺省可确定性派生为 `refs/heads/selfdev/<runId>`）。Promotion Worker 必须在清空/隔离用户 Git config、env、hooks、credential helper 和 signing helper 的 profile 中，以受信 low-level typed object API 从 CommitObjectPlan 生成 raw payload；序列化 bytes/digest 和按 repository object format 计算的 OID 必须逐字节等于 `rawCommitPayload`/`expectedCommitObjectId`，不得调用带隐式 author、clock、timezone、encoding 或 config 的 porcelain commit。
- Promotion Worker 必须把 `verify baseRef <baseSha>` 与 `create promotionRef <expectedCommitObjectId>` 放进**同一个受信 Git ref transaction**；create 的 expected old value 是 repository-format all-zero OID。任一 verify/create 失败时整个 transaction abort，`promotionRef` 不得出现。任何先读 freshness、暂停、再单独 create 的实现均不合规。
- Transaction 因 base moved/ref occupied 失败后，worker 保存 typed Git evidence 并从 `PROMOTING` 转 `FAILED/promotion_conflict`；不得改记 `STALE`、重新读取新 base 后重试或生成不同 plan。
- 已存在的 `promotionRef` 只有在同一 effect intent 的 transaction receipt/权威 reflog 能证明它是该精确 OID 时才可对账；否则是 `promotion_conflict`。若 transaction 已成功但 PromotionReceipt 未记账，恢复应查询并补记后转 `COMPLETED`，而非创建第二个 ref 或接受不同 commit。`COMPLETED` 后系统不自动删除或重写该 ref；人类可用普通 Git 流程检查、改名、合并或删除。

### 18.9 Baseline、测试、eval 与独立验收

**同环境原则**：Baseline 和 Candidate 必须使用同一可信 suite、环境镜像、工具链/依赖 digest、资源配额、时钟/随机种子策略和 sandbox。Baseline 以 trusted suite registry 的 versioned failure class/severity/count/output bytes+digest 记录现有失败；只有 EffectivePolicy rule 同时匹配 suite、failure class 和 `TaskClassificationResult.baselineExceptionAuthorizedTaskClassIds` 中的同一个 authoritative class，才允许目标修复它。Fallback、unknown、hint mismatch、conflicting rules 或 classifier failure 的 authorized set 为空；mixed eligible/ineligible 多 class 也不能串权。Candidate 相对 baseline 新增 class、增加 occurrence、提高 severity 或增加 failure output bytes 均为硬失败，不能被总分或“已有失败”豁免。环境无法复现或 baseline 超时不能被解释成 candidate pass。

验证分四层：

1. **Deterministic required suites**：类型、单元、集成、文档、静态安全、受保护路径和 reproducibility 检查。
2. **Holdouts**：由 builtin/base policy 或外部只读 artifact 提供；Developer 不可见内容和路径，只收到去敏结果类别。
3. **Deterministic graders**：以机器可重复规则评估 acceptance criteria、diff scope、行为输出和预算，输出结构化 evidence。
4. **Isolated model reviewer（advisory only）**：只在前三层明确完成后评估语义正确性、设计一致性、风险和可维护性；模型报告不是安全事实，不能把 deterministic fail 改成 pass，也不能替人批准。

候选 diff/文本必须通过 versioned、length-bounded、strict-schema typed data channel 送入 Reviewer，候选 bytes 只出现在明确的 untrusted field；禁止把 delimiter 拼接当隔离。decoder、长度、字段、delimiter 或协议异常一律产生 `inconclusive`，不尝试“让模型忽略注入”。Isolation attestation 必须绑定 TaskClassificationResult、signed TaskClassAttestation、ReviewerActorRef、完整 ParticipantIdentitySet、reviewer-only principal/credential、runtime/profile、prompt、typed envelope/decoder、fresh session、fresh context-source instance/manifest 和相同 sealed evidence source digests。

独立性 verifier 必须重读 `ParticipantIdentitySet` 中每个 binding artifact 并校验 issuer/用途/subject/key/credential/validity/revocation，然后排除 Developer、run owner、所有 Human Approver、Orchestrator、Verifier、Promotion Worker、Journal Anchor 和其他 non-reviewer participant 的 actor/principal/credential/key。所有计数 reviewer 必须在 `actorId`、`principalBindingDigest`、`credentialBindingDigest`、payload 的 `principalSubjectDigest`/`opaqueCredentialHandleDigest`、credential key、`isolatedSessionId`、`contextSourceInstanceId`、`contextSourceManifestDigest` 上两两唯一；新 actor/session 或重新签发的新 binding 但底层 principal/credential 相同，同样拒绝。任一复用、缺失或无法证明均 `reviewer_isolation_failed`。Task classification fallback 或 EffectivePolicy 判为 high-risk 时，必须达到最大 reviewer count（v1 builtin 至少 2）且每位都给出 advisory accept；不能用同一 principal/key/session/context 的多次采样凑数。无论风险级别，Human Approver 都必须逐项查看 deterministic gates、模型 findings 和语义 acceptance criteria，承担最终语义判断。

必须记录以下指标，并同时保存 baseline/candidate 原值而非只存汇总分：

| 维度 | 最小指标 |
|---|---|
| **Trajectory** | state 停留时间、tool/suite 次数、repair 次数、取消/崩溃恢复、无效跃迁/越界尝试 |
| **Quality** | required/holdout pass delta、回归数、finding severity、accept/reject、后续人工返工 |
| **Cost** | input/output tokens、模型费用、wall time、CPU/内存、artifact 字节、review 成本 |
| **Safety** | protected-path 拒绝、sandbox/网络/secret deny、prompt-injection 命中、evidence/receipt tamper、stale-base 阻断 |

质量或成本阈值由 base/user policy 收窄；Safety 必须全部明确 pass。评估集需要版本化、保留未参与开发的 holdout，并防止同一模型通过持久 Memory/Skill/Plugin 看到答案。模型 grader 的版本、prompt digest、采样参数和原始输出都进入 Acceptance evidence。

### 18.10 Promotion、远端边界与发布关系

SD4/v1 的 promotion 只完成三件事：验证 ApprovalReceipt/PromotionPlan 绑定、在隔离 Git config 的 low-level typed object API 中生成并验证 CommitObjectPlan 的精确 raw bytes/OID、以**一个 Git ref transaction**同时 verify `baseRef@baseSha` 并 create expected-zero → `expectedCommitObjectId` 的 `promotionRef`。store CAS/intent 与任何 transaction 前 freshness read 都不能替代该原子 verify+create；如果二者之间 base 移动，transaction 必须整体失败且不创建 promotion ref。它不修改 current branch/index/worktree，不执行 hooks，不读取用户 Git config/credential，不访问网络，也不在 promotion 时补 author、clock、timezone、message、header、encoding 或签名熵。

完成后的人类流程与 §18 分离：查看本地 branch → 普通 code review → 人工决定 merge/rebase/cherry-pick → 按 [§9](./09-build-ci-dist.md) 和对应 release checklist 重新走同 SHA CI、签名、notarization 与 publication gate。`ApprovalReceipt` 不是 release approval，也不能替代 CODEOWNERS、branch protection、DCO、changeset 或 release custodian。

目标 beta 的 release gate 还必须由独立 `ReleaseChannelManifest`/`ReleaseApprovalReceipt` 绑定 candidate SHA、artifacts、package set 与渠道语义：npm dist-tag=`next`，GitHub `prerelease=true`、`make_latest=false`。发布后必须从权威 API 断言 `next`/latest 状态；partial publish 或断言失败执行预定义 rollback，且 stable/latest 不得被改变。该 manifest、release actor、credential 和 rollback 均属于 [实施计划 REL-01/REL-02](../../plans/2026-08-19-self-development-implementation.md)，不进入 SelfDev ApprovalReceipt，也不能由 Promotion Worker 执行。

### 18.11 安全威胁与强制测试

| 威胁 | 必须的阻断 |
|---|---|
| 候选文档/代码 prompt injection | strict typed data channel；解析异常=inconclusive；Reviewer 无工具且报告仅 advisory；高风险双 reviewer + 人工逐项判断 |
| 命令/参数注入 | `Check.run(suiteId)` typed argv、`shell:false`、base-owned registry；无通用 Bash |
| symlink/path traversal/大小写绕过 | canonicalize + realpath + cwd boundary + protected policy；seal 前后复算 |
| 候选修改测试/CI 让自己通过 | required suite/holdout/command graph 来自 builtin ∩ user ∩ base-SHA policy |
| caller/模型伪造低风险任务标签 | caller 只传 hints；protected builtin registry + base-SHA typed constraints + signed classifier attestation；unknown/mismatch/conflict/failure 均 high-risk、最大 reviewer 且 authorized exception set 为空 |
| TOCTOU / seal 后写入 | 单调 fencing token、独立 holder worktree、commit 前复核 generation/stateVersion、旧 Runner 停止证明、manifest/tree 复算 |
| 自批、自审、改 actorId 或共享记忆污染 | ReviewerActorRef 限 model/service reviewer；全量 ParticipantIdentitySet；受信 principal/credential binding；actor/principal/credential/key/session/context-source 两两唯一；HumanProof 独立 |
| crash 重放双重副作用 | recovery class、预算预留、CAS/fencing、intent/receipt、opaque 不盲重放、故障注入 |
| journal 整链重写/快照回滚 | 独立 append-only 签名 anchor、单调 counter、完整链与 store-generation 校验；anchor 不可用即停机 |
| key cross-domain / registry 自引用或回退 | payload/binding 分离；usage/domain/actor-service-build/root-purpose 与 kind-role-purpose scope 校验；latest epoch/revocation；human/classifier/identity key 不跨域 |
| base 已过时仍 promotion | preflight 只提示；Git ref transaction 原子 verify base OID + create promotion ref，base 移动则全 transaction abort |
| approval replay/替换候选 | domain-separated ApprovalContext、challenge/HumanProof 双签、key revocation、nonce/receipt 各自 single-use、anchor consumption |
| Git config/commit OID 漂移 | 完整 raw-byte CommitObjectPlan、隔离 config、预计算 OID、获批 verify+create GitRefTransactionPlan |
| 通过普通 permission dangerous flags 绕过 | §18 profiles 硬拒绝所有 dangerous bypass；builtin policy 不可收窄 |

### 18.12 SD0–SD5 交付阶段与退出标准

阶段按依赖顺序推进；前一阶段 evidence 未关闭，后一阶段只能保留 backlog。每阶段结果都必须绑定 exact SHA，fixtures/mocks 不能冒充 production wiring。

SD0 builtin Hook 超限证据必须是可判别 union，禁止伪造 scan equality：

```ts
type BuiltinHookScanEvidence =
  | {
      rawBytes: number
      rawDigest: Digest
      scanStatus: 'not_started'
      scannedBytes: 0
      scannedDigest: null
      decision: 'veto'
    }
  | {
      rawBytes: number
      rawDigest: Digest
      scanStatus: 'complete'
      scannedBytes: number               // must equal rawBytes
      scannedDigest: Digest              // must equal rawDigest
      decision: 'allow' | 'veto'
    }
```

SD0-02 v1 选择第一条 direct-veto 路径：每个 builtin handler 输入和每次 non-veto completion（原地 mutation、显式 rewrite、返回 void）都经 `apollo-hook-cjson-v1` 计量；通过后以 fresh measured clone 继续，避免 retained-reference mutation。该编码对 plain JSON 递归排序 key，以保留 base64 typed tag 编码 inline `Uint8Array`，byte view 规范化为 tight copy（不复制/暴露 view 外 backing），增量计算 UTF-8 bytes + SHA-256；cycle、BigInt/undefined/function/symbol、non-finite/-0、accessor/hidden/symbol field、non-plain prototype、sparse/extended array、SharedArrayBuffer 以及 depth=512/node=200,000/canonical-work=16 MiB 预算超限均为 serialization failure，沿 `builtin_hook_error` typed veto，不能制造 rawDigest。serialized bytes ≤ 1 MiB 才把完整 payload 交给 handler；> 1 MiB 必须 emit `builtin_hook_payload_too_large`/`hook.payload_rejected` 与第一条 evidence，handler 不调用。未来只有实际扫描了同一完整 canonical byte stream 才能使用第二条 `complete` 分支。

| 阶段 | 能力边界 | 可量化退出标准 |
|---|---|---|
| **SD0 — Contract & security prerequisites** | 冻结本节、threat model、路径分类和 release scope；先关闭会影响专用 Runner 的已知权限/Hook P0 | 文档/链接/配置/事件检查全绿；v1 raw Bash 零 silent auto-allow；builtin Hook 超限 direct-veto 必为 `rawBytes/rawDigest + scanStatus:not_started + scannedBytes:0 + scannedDigest:null`，只有 full scan 成功才要求 raw/scanned length+digest 一致；安全评审签字。无产品入口 |
| **SD1 — State, store & sealing** | reducer、CAS/fencing、payload/binding key registry、统一 Principal/Credential binding、独立签名 anchor、ArtifactRef、holder-isolated worktree、manifest/seal；使用 fake worker | 显式边/STALEABLE 全测；identity issuer purpose/subject/expiry/revocation/cross-domain 全测；pause-before-commit、opaque effect、registry/整链/anchor rollback 均 fail-closed；effect 达成 exactly-once committed state；无模型开发入口 |
| **SD2 — Restricted Developer** | `selfdev.developer`、typed tools、完整 policy lattice、可信 TaskClassifier/attestation、ref reservation、baseline/risk policy、受保护面、预算/repair | 每个 lattice field/property test；rogue builtin/typed-slot swap/revoked signer 全拒绝；deceptive hint、unknown/mismatch/conflicting rule/classifier failure 均 high-risk + 最大 reviewer + authorized exception set 为空；mixed class 不串权；candidate/model 无法影响 classification；仍不可 promotion |
| **SD3 — Verification & acceptance shadow** | `Check.run`、同环境 baseline/candidate、holdout、deterministic graders、ReviewerActorRef advisory、完整 evidence | SuiteResult subject/source/failure 绑定；typed-channel 异常 inconclusive；Acceptance/attestation 绑定完整 ParticipantIdentitySet；forbidden participant 复用以及新 actor/session 复用相同 principal/credential/key 全拒绝；high-risk reviewers 全维唯一且 count 达标；promotion API 不存在 |
| **SD4 — Human-approved branch-only** | registry-bound approval 三签、freshness、确定性 commit object + Git ref transaction、本地 branch E2E | cross-domain/revoked key、自动确认/context replay 全拒绝；pause-after-freshness 后 base 移动使 verify+create transaction 全 abort 且不建 ref；无 current-worktree/远端副作用；product/security/UX sign-off。**最早 production-capable**；release custodian 仅 REL-02 |
| **SD5 — Bounded autonomous proposals** | 可选的 shadow 信号触发、更多可信任务类别和有界 repair；仍保留 SD4 人批和 branch-only 边界 | 默认仍 off/shadow；长期 crash/retry/预算 eval 无越界；质量/成本相对固定人工基线达到预先登记阈值；安全 suite 零失败；每个新任务类别单独通过产品/安全/人工 gate |

SD4 计划目标可以是 `0.1.0-beta.1`，但版本号不豁免 [§10 evidence gate](./10-milestones.md) 或 [L2 release checklist](../../../releases/L2-RELEASE-CHECKLIST.md) 的同 SHA、凭据、硬件与人工边界。SD5 不授权远端自动化；push/merge/publish 若未来考虑，必须另立新规范和威胁评审。

SD0 安全 P0 不受品牌选择阻塞，可以先修并保留原始审计；但 BRAND-01 改变 identity/package/docs/error/event surface 后，必须在最终 branded exact SHA 执行计划中的 `BRAND-VERIFY`，重跑全部 SD0 tests/threat fixtures/docs/config/error/event checks 并由 product/security 重新签字。该 gate 未关闭不得开始 SD1，brand 前 evidence 不进入 beta chain。

### 18.13 当前实现状态（截至本规范落地基线）

| §18 子系统 | 状态 | 当前事实 / 不得误读之处 |
|---|---|---|
| Terminology 与本节契约 | **Proposed / not shipped** | 文档落地不等于运行时能力 |
| Orchestrator / deterministic reducer | **Proposed / not shipped** | 普通 Agent Runner 不是 §18 Orchestrator |
| `SelfDevRun` store、CAS、lease、journal | **Proposed / not shipped** | 现有 Session/Event 存储未实现本节一致性契约 |
| Policy intersection / protected surfaces | **Proposed / not shipped** | 普通 Permission/Trust 是可复用原语，不是 base-SHA policy |
| Trusted TaskClassifier / TaskClassAttestation | **Proposed / not shipped** | caller task labels、模型分类或候选 diff 当前都不是可信分类证据 |
| Principal/Credential binding / ParticipantIdentitySet | **Proposed / not shipped** | 当前 actor/session 标识不满足跨角色 principal/key 独立性证明 |
| 专用 Developer/Verifier/Reviewer/Promotion profiles | **Proposed / not shipped** | 当前通用 Runner、tools、subagent 不满足角色隔离 |
| Isolated worktree / CandidateManifest / sealing | **Proposed / not shipped** | 普通 Edit backup 或 `/undo` 不等于 run-level immutable candidate |
| `Check.run(suiteId)` trusted runner | **Proposed / not shipped** | 当前 Bash/package scripts 不能作为替代 |
| Baseline/Candidate verifier 与 holdout | **Proposed / not shipped** | 当前 package/CI tests 是工程证据，不是 §18 bundle |
| Independent Reviewer / AcceptanceReport | **Proposed / not shipped** | §17 Code Review 可提供领域概念，但未接入本状态机 |
| Human challenge / ApprovalReceipt | **Proposed / not shipped** | 普通 permission 弹窗和 allow cache 不是候选批准 |
| Branch-only Promotion Worker | **Proposed / not shipped** | 当前 Git/Bash 能创建分支不代表受控 promotion 已实现 |
| Repair、crash recovery、cancel、rollback | **Proposed / not shipped** | 普通重试、session resume 和 file backup 不满足本节绑定 |
| Public API / `apollo selfdev` CLI | **Proposed / not shipped** | 命令 namespace 仅为提案 |
| §15 `EvolutionEngine` | **不属于 §18** | 它是规则驱动运行时参数调优骨架，不修改代码/制品 |

权威实施顺序见 [Self-Development implementation plan](../../plans/2026-08-19-self-development-implementation.md)。在 SD4 evidence gate 完成前，产品文案只能称“设计中 / shadow / experimental”，不得称“可开启自我开发”或“已闭环自进化”。

---

## 变更日志

| 日期 | 版本 | 内容 |
|---|---|---|
| 2026-08-19 | §18 v1.3 | 将 caller task class 降为不可信 hints；新增 protected classifier registry、typed rules、deterministic result + signed attestation、per-class baseline authorization；为所有 actor 增加无环 Principal/Credential binding、role-purpose issuer scope、完整 ParticipantIdentitySet 和全维 reviewer 独立性。 |
| 2026-08-19 | §18 v1.2 | 原子化 base-verify/ref-create promotion；补齐 Hook scan union、ref/baseline/risk policy lattice、registry payload/binding 与 issuer key usage、ReviewerActorRef 独立性和 BRAND-VERIFY gate。 |
| 2026-08-19 | §18 v1.1 | 收紧 stale/fencing、policy lattice、suite subject、human trust root/approval context、advisory reviewer、确定性 commit object、effect recovery、独立 journal anchor 与 beta channel 契约。 |
| 2026-08-19 | §18 v1 | 新增受控 Self-Development/Change Pipeline：术语分离、状态机、角色隔离、不可变候选、base-SHA policy、专用 Runner、可信检查、证据/审批 digest 绑定、branch-only promotion、SD0–SD5 与真实实现状态。 |
