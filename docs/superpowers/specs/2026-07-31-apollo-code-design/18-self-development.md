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

**Reviewer isolation** 是硬要求，不是“换一个 prompt”即可满足：Reviewer 使用新会话和独立身份，不能读取 Developer transcript、隐藏思维、临时文件、自动激活 Skill、个人/项目 Memory 或可变 Plugin 状态。Reviewer 输入必须由 sealed artifacts 和可信控制面重新构造；候选内容一律作为 untrusted data 包裹。

#### 18.2.1 Human approval trust root

Human Approver 必须是 discriminated `HumanApproverRef { kind:'human', role:'human-approver' }`。本地 CLI 路径要求交互式 TTY **加**近期 OS re-auth，并由 OS keychain/Secure Enclave 等受保护、不可由模型导出的本地 key 签名；TTY、进程 uid、用户名或点击本身都不是身份。独立审批界面必须使用预先固定的独立 trust root 和签名 key，不能复用 Developer/Orchestrator credential。

受保护 `ApprovalKeyRegistry` 将 `keyId → humanId + role + trustRootId + validity + revocationEpoch` 绑定，并以内容寻址 artifact 固定。Challenge 签发、Receipt 签发和 Receipt 消费三个时点都要重新校验 registry、actor/role、auth-context TTL 与 revocation；任一 key/actor/trust root 已撤销或 registry 回退即拒绝。模型和 service actor 的 union 分支没有 `human-approver` role，不能注册人类 key、构造 `HumanProof` 或借用 OS/session 字段伪装。

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
| `PROPOSED` | `BASELINING` | Orchestrator | 目标已规范化；`baseRef` 当前 head 等于 `baseSha`；用户策略、base-SHA policy、预算和 `promotionRef` 已固定；`promotionRef` 不存在 |
| `BASELINING` | `DEVELOPING` | Orchestrator | BaselineBundle 完整且非 inconclusive；现有失败按 policy 允许由目标修复；新 generation/worktree 已分配 |
| `DEVELOPING` | `SEALING` | Developer 申请、Orchestrator 执行 | lease 有效；变更全在允许路径；预算未超；无 cancel intent |
| `SEALING` | `VERIFYING` | Orchestrator | 写 lease 已撤销；manifest/tree/patch/policy/artifact digest 复算一致；PromotionPlan 已固定 |
| `VERIFYING` | `ACCEPTING` | Deterministic Verifier | required、holdout、safety 全部明确 pass；VerificationBundle 完整 |
| `VERIFYING` | `REPAIRING` | Orchestrator | verdict 为可修复 `fail`；安全不变量未失败；repair budget 尚有余额；finding 已去敏 |
| `ACCEPTING` | `AWAITING_HUMAN` | Independent Reviewer 申请、Orchestrator 执行 | deterministic verification/safety 硬门仍为 pass；typed review channel 无解析异常；全部 policy-required advisory reviews 建议 `accept`；高风险达到独立 reviewer 数；AcceptanceReport/attestations 完整绑定 verification 和 PromotionPlan |
| `ACCEPTING` | `REPAIRING` | Orchestrator | advisory finding 建议 repair；finding 可修复且 repair budget 尚有余额；deterministic safety 未失败 |
| `ACCEPTING` | `REJECTED` | Independent Reviewer 申请、Orchestrator 执行 | advisory recommendation=`reject`；report digest 已持久化；Orchestrator 按固定 policy 接受该终止建议 |
| `REPAIRING` | `DEVELOPING` | Orchestrator | 上一 sealed generation 未变；attempt 原子加一且未超过 limit；新 generation/worktree/lease 已分配 |
| `AWAITING_HUMAN` | `APPROVED` | Human Approver 申请、Orchestrator 执行 | challenge nonce 在同一 CAS 中首次消费；receipt 全字段绑定、签名有效；actor 授权；`baseRef` fresh；`promotionRef` 仍不存在 |
| `AWAITING_HUMAN` | `REPAIRING` | Human Approver 申请、Orchestrator 执行 | request-changes reason 已持久化；repair budget 尚有余额；所有 challenge 作废 |
| `AWAITING_HUMAN` | `REJECTED` | Human Approver 申请、Orchestrator 执行 | reject reason 已持久化；所有 challenge 作废 |
| `APPROVED` | `PROMOTING` | Promotion Worker | receipt 未过期/未消费；完整 digest 和 PromotionPlan 复算一致；`baseRef` head=`baseSha`；`promotionRef` 不存在；在同一 CAS 中消费 receipt 并写 promotion effect intent |
| `PROMOTING` | `COMPLETED` | Promotion Worker | 本地 commit 的 parent/tree 与 PromotionPlan 一致；`promotionRef` 原子创建或被同一 effect 对账为精确 commit；PromotionReceipt 已持久化 |
| `CANCEL_REQUESTED` | `CANCELLED` | Orchestrator | 活动 Runner 已停止；lease 已撤销；临时 worktree 已隔离/清理；审计保留 |

三个统一 terminal 规则同样属于穷举契约：

- `FAILABLE = { PROPOSED, BASELINING, DEVELOPING, SEALING, VERIFYING, ACCEPTING, REPAIRING, AWAITING_HUMAN, APPROVED, PROMOTING, CANCEL_REQUESTED }`。只有 Orchestrator 可将其中任一状态转为 `FAILED`，且 `TypedReason.code` 必须属于 `policy_invalid | baseline_inconclusive | security_invariant_failed | integrity_failed | budget_exhausted | nonrepairable_verification | acceptance_inconclusive | reviewer_isolation_failed | approval_invalid | promotion_conflict | recovery_failed`；reason evidence 先持久化。暂时性 I/O/worker crash 不转移，保留原状态按 effect receipt 恢复。
- `STALEABLE = { PROPOSED, BASELINING, DEVELOPING, SEALING, VERIFYING, ACCEPTING, REPAIRING, AWAITING_HUMAN, APPROVED }`。只有 Orchestrator 可将其中任一状态转为 `STALE`。`base_ref_moved` 与 `promotion_ref_occupied` 适用于全部 STALEABLE；`approval_expired` 只适用于 `AWAITING_HUMAN`/`APPROVED`，其他 reason/state 组合必须拒绝。跃迁 guard 必须先：停止/确认退出全部 active workers，撤销 lease、challenge 和未消费 receipt，隔离或丢弃 mutable worktree，保留 sealed artifacts/journal，并证明没有 promotion effect intent；无资源的早期状态以空集满足。这样 `PROPOSED` 在 base 已移动或 promotion ref 被占用时也能确定终止。`PROMOTING` 已过 commit point，不属于 STALEABLE。
- `CANCELLABLE = { PROPOSED, BASELINING, DEVELOPING, SEALING, VERIFYING, ACCEPTING, REPAIRING, AWAITING_HUMAN, APPROVED }`。Run owner 或 Human Approver 只能把这些状态转为 `CANCEL_REQUESTED`。`PROMOTING` 是不可取消的 commit point：cancel 与 `APPROVED → PROMOTING` 用同一 CAS 竞争；promotion 先成功后，cancel 必须返回 typed conflict，worker只能对账到 `COMPLETED` 或 `FAILED`。

所有跃迁都必须提交 `{ runId, expectedVersion, from, to, guardDigest, actor, effectKey }`。存储层使用 compare-and-swap；版本不匹配即拒绝，不允许 last-write-wins。

### 18.4 永久不变量

1. **只有 `DEVELOPING` 可变**：只有该状态下的当前 generation 候选源树可写。Baseline/Verification 可写各自 disposable scratch，但 base 与 sealed candidate 挂载为只读。
2. **seal 后不可回写**：进入 `SEALING` 即撤销 Developer lease；`CandidateManifest.candidateDigest` 生成后，任何字节或 mode 变化都使 run 失败。修复创建新 generation，不修改旧候选。
3. **证据完整绑定**：Verification、Acceptance、Approval 和 Promotion 必须逐层绑定同一 `runId + baseRef + baseSha + candidateDigest + policyDigest + promotionPlanDigest`；Approval 还必须绑定 verification/acceptance digest，不得只绑定 branch 名、路径或时间。
4. **base/目标 ref 不漂移**：`baseRef` 是已有基线 ref，其 head 必须始终等于 `baseSha`；`promotionRef` 是本 run 要新建的本地 ref，在进入 `PROMOTING` 前必须不存在。不自动 merge/rebase，也不把二者混成一个 `targetRef`。
5. **不确定即拒绝**：missing、timeout、crash、unsupported、partial、inconclusive 或 digest 不明，均不能被折算为 pass。
6. **effect 只保证状态提交一次**：每个 effect 由稳定 `effectKey` 唯一标识；系统保证的是 exactly-once **committed state**，不声称底层进程/模型调用物理执行一次。恢复必须按 effect class 查询、对账或 fail closed，禁止对不透明调用盲重放。
7. **lease 有界且带 fencing**：Developer、Verifier、Reviewer、Promotion Worker 都使用短租约和单调递增 fencing token。每个 mutable tool/effect 必须在授权时和提交前同时校验 `leaseId + fencingToken + generation + stateVersion`；旧 holder 即使仍持有 token 也不得提交。
8. **不可原子 fence 的文件系统写入必须物理隔离**：每个 lease holder 使用独立 worktree；lease 被接管后，旧 Runner 必须确认停止，其 worktree 永不复用。`SEALING` 只能选取当前 fencing token 对应的 tree，且必须证明所有旧 Runner 已停止或其 mount 已变只读。
9. **审批不可转移**：Developer、Reviewer、Orchestrator 和 Promotion Worker 不能成为该 run 的 Human Approver；同一模型的不同 prompt 不构成人类审批。
10. **审计不可删除且有独立锚点**：取消、失败、拒绝和清理不能删除 journal、manifest、evidence digest 或 receipt 使用记录。hash chain 单独只能证明内部损坏；production 必须把链头提交到候选与 Runner 均不可写的受保护单调签名锚点。

### 18.5 策略优先级、受保护面与 Runner profiles

有效能力必须按下式计算，并在 `PROPOSED → BASELINING` 前固定为内容寻址 artifact：

```text
effectivePolicy = meet_v1(builtinPolicy, userPolicy, policyLoadedFrom(baseSha))
```

`SelfDevPolicy` 与 `EffectivePolicy` 必须使用注册的 `schemaVersion=1`、`latticeVersion=selfdev-policy-lattice-v1` 和 `canonicalizer=selfdev-cjson-v1`；原始 bytes、canonical payload 和 digest 均保存为 `ArtifactRef`。`PROPOSED` 固定 builtin/user/base 三个 source artifact 及 effective artifact，`basePolicyArtifact` 必须从 `baseSha` 读取；后续配置或候选改动不影响本 run。未配置用户策略时，控制面生成并固定一个显式、完整的 builtin-derived 用户 artifact，不能用“字段缺失”表示默认。

逐字段 meet 规则是规范的一部分，禁止实现者自行选择优先级：

| Policy 字段 | `meet_v1` | 更严格的方向 |
|---|---|---|
| `allowedPathPatterns` / `allowedCapabilities` / `allowedSuiteIds` | 对三个 canonical set 取**交集** | 允许项更少 |
| `deniedPathPatterns` / `deniedCapabilities` | 取**并集**，最后从所有 allow 结果中剔除；deny 永远胜出 | 拒绝项更多 |
| `maxima.budget.*`、approval TTL、单次/累计 diff、文件/行/字节、repair/concurrency | 按精确整数逐字段取 **min** | 上限更低 |
| `minimums.quality*`、holdout/safety pass、independent reviewer count | 按精确整数逐字段取 **max** | 最低要求更高 |
| `requiredSuiteIds` / `requiredSafetyCheckIds` / `requiredHoldoutIds` | 取**并集**，且每项还必须存在于最终 `allowedSuiteIds`；否则 policy 不可满足并失败 | 必跑项更多 |
| 所有 `allow*` 布尔能力 | 逻辑 **AND**；字段命名必须保持“true=授予能力” | false 更严格 |

集合元素先按版本化 path/capability/suite 方言 canonicalize，再比较；禁止字符串近似交集。数值必须是 canonical 非负安全整数（费用用十进制整数串）并做溢出检查。任一 source 缺字段、未知字段、未知 enum/schema/lattice/canonicalizer、重复 canonical key、不可满足 required-vs-allowed 约束或 digest 不一致，均 `policy_invalid` fail closed。EffectivePolicy 必须重新 canonicalize、digest、写入独立 ArtifactRef，并绑定四个 artifact digest；运行时只读取该固定 effective artifact。

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
  | 'reviewer' | 'human-approver' | 'promotion-worker' | 'run-owner'

interface ActorBase {
  actorId: string
  role: SelfDevRole
  authenticationContextDigest: Digest
}

interface HumanActorRef extends ActorBase {
  kind: 'human'
  role: 'human-approver' | 'run-owner' | 'reviewer'
  humanId: string
  keyId: string
  trustRootId: string
  keyRegistryDigest: Digest
  revocationEpoch: number
}

interface HumanApproverRef extends HumanActorRef {
  kind: 'human'
  role: 'human-approver'
}

interface ServiceActorRef extends ActorBase {
  kind: 'service'
  role: 'orchestrator' | 'verifier' | 'promotion-worker'
  serviceBuildDigest: Digest
  instanceId: string
}

interface ModelActorRef extends ActorBase {
  kind: 'model'
  role: 'developer' | 'reviewer'
  providerModelDigest: Digest
  isolatedSessionId: string
}

type ActorRef = HumanActorRef | ServiceActorRef | ModelActorRef

interface ApprovalAuthenticationContext {
  schemaVersion: 1
  method: 'local-tty-os-reauth' | 'independent-approval-ui'
  actor: HumanApproverRef
  trustRootId: string
  keyRegistryDigest: Digest
  osPrincipalDigest?: Digest
  ttyDeviceDigest?: Digest
  authenticatedAt: Timestamp
  expiresAt: Timestamp
  revocationEpoch: number
  contextDigest: Digest
}

interface ApprovalKeyRegistry {
  schemaVersion: 1
  registryVersion: number
  trustRoots: readonly {
    trustRootId: string
    kind: 'local-os-bound-key' | 'independent-approval-service'
    publicKey: string
  }[]
  keys: readonly {
    keyId: string
    humanId: string
    trustRootId: string
    allowedRoles: readonly ['human-approver']
    validFrom: Timestamp
    validUntil: Timestamp
    revokedAt?: Timestamp
    revocationEpoch: number
  }[]
  registryDigest: Digest
  registryArtifact: ArtifactRef
}

interface Signature {
  algorithm: 'Ed25519' | 'ECDSA-P256-SHA256'
  keyId: string
  domain:
    | 'selfdev.approval-challenge.v1'
    | 'selfdev.human-proof.v1'
    | 'selfdev.approval-receipt.v1'
    | 'selfdev.journal-anchor.v1'
  valueBase64: string
}

type ReasonCode =
  | 'policy_invalid' | 'baseline_inconclusive' | 'security_invariant_failed'
  | 'integrity_failed' | 'budget_exhausted' | 'nonrepairable_verification'
  | 'acceptance_inconclusive'
  | 'reviewer_isolation_failed' | 'approval_invalid' | 'promotion_conflict'
  | 'recovery_failed' | 'human_rejected' | 'human_cancelled'
  | 'base_ref_moved' | 'promotion_ref_occupied' | 'approval_expired'

interface TypedReason {
  code: ReasonCode
  messageDigest: Digest
  evidence: readonly ArtifactRef[]
}

interface SelfDevPolicy {
  schemaVersion: 1
  latticeVersion: 'selfdev-policy-lattice-v1'
  canonicalizer: 'selfdev-cjson-v1'
  source: 'builtin' | 'user' | 'base'
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
  policyDigest: Digest
}

interface EffectivePolicy extends Omit<SelfDevPolicy, 'source' | 'policyId' | 'policyDigest'> {
  source: 'effective'
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
  bindingDigest: Digest
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
  environmentDigest: Digest
  suites: readonly SuiteResult[]
  verdict: 'pass' | 'fail' | 'inconclusive'
  bundleDigest: Digest
  completedAt: Timestamp
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
  goal: { text: ArtifactRef; acceptanceCriteria: readonly string[]; goalDigest: Digest }
  createdBy: ActorRef
  baseRef: string                     // existing full ref; head must equal baseSha
  baseSha: GitObjectId
  promotionRef: string                // new local refs/heads/...; must not exist
  policy: PolicyBinding
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
  planDigest: Digest
}

interface VerificationBundle {
  schemaVersion: 1
  runId: string
  baseRef: string
  baseSha: GitObjectId
  candidateDigest: Digest
  policyDigest: Digest
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
  reviewer: HumanActorRef | ModelActorRef
  reviewerRuntimeDigest: Digest
  runnerProfileDigest: Digest
  promptDigest: Digest
  contextSourceDigests: readonly Digest[]
  typedInputEnvelopeDigest: Digest
  decoderDigest: Digest
  attestationDigest: Digest
}

interface AdvisoryReview {
  reviewer: HumanActorRef | ModelActorRef
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
  promotionPlanDigest: Digest
  verificationBundleDigest: Digest
  deterministicGateDigest: Digest
  risk: 'normal' | 'high'
  requiredIndependentReviewers: number
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
  generation: number
  budgetLimitsDigest: Digest
  budgetUsageDigest: Digest
  baselineBundleDigest: Digest
  environmentDigest: Digest
  candidateManifestDigest: Digest
  candidateDigest: Digest
  policyBindingDigest: Digest
  effectivePolicyDigest: Digest
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
  promotionPlanDigest: Digest
  verificationBundleDigest: Digest
  acceptanceReportDigest: Digest
  approvalContextDigest: Digest
  challengeDigest: Digest
  humanProofDigest: Digest
  actor: HumanApproverRef
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
  signedPayloadDigest: Digest
  signature: Signature & { domain: 'selfdev.journal-anchor.v1' }
  anchorDigest: Digest
}

interface ProposeRunInput {
  goal: { text: ArtifactRef; acceptanceCriteria: readonly string[] }
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
  baseRef: string
  baseSha: GitObjectId
  promotionRef: string
  candidateDigest: Digest
  policyDigest: Digest
  promotionPlanDigest: Digest
  verificationBundleDigest: Digest
  acceptanceReportDigest: Digest
  actor: HumanApproverRef
  nonce: string
  issuedAt: Timestamp
  expiresAt: Timestamp
  issuerSignature: Signature & { domain: 'selfdev.approval-challenge.v1' }
  challengeDigest: Digest
}

interface HumanProof {
  actor: HumanApproverRef
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

production 的 **tamper-evident** 声明必须额外依赖独立 `JournalAnchorStore`：它位于仓库、候选 worktree、普通 storage adapter 和全部 Runner 的写权限之外，使用受保护不可导出的 Ed25519 key、append-only 记录与单调 `anchorVersion`。Anchor service 只接受 `previousAnchorDigest` 和当前受权 CAS transition/effect receipt 均匹配的下一个链头；本地状态只有在 anchor CAS 成功后才可对外确认 committed。崩溃留下的唯一、连续 pending entry 可由该 service 对账，任何分叉均 fail closed。恢复必须从独立 store 取得最新 counter，验证 signature、完整 journal 链、checkpoint、store generation 和链头；因此整链重写无法伪造签名，回滚到旧的有效签名也会因 counter 落后被检测。Anchor 不可用或校验不明时 §18 必须停止，不能降级为本地 hash chain 后仍宣称 production/tamper-evident。

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
apollo selfdev propose --goal-file <path> --base-ref <full-ref> --base-sha <sha> [--promotion-ref <new-local-ref>]
apollo selfdev start <runId>
apollo selfdev status <runId> [--json]
apollo selfdev evidence <runId>
apollo selfdev cancel <runId> --reason <text>
apollo selfdev request-changes <runId> --reason <text>
apollo selfdev reject <runId> --reason <text>
apollo selfdev approve <runId>
```

`baseRef` 和 `promotionRef` 必须是 canonical full refs。v1 的 `baseRef` 只允许 policy 指定的本地基线 branch；`promotionRef` 只允许 `refs/heads/` 下的受控前缀，禁止 `HEAD`、symbolic ref、tag、remote-tracking ref 和任意 refspec。调用方省略 promotion ref 时，由 runId 确定性派生；一旦 `PROPOSED` 持久化就不可改变。

审批字段按阶段冻结，不能在同一个 run 上 patch-in-place：`PROPOSED` 固定 goal、`baseRef@baseSha`、`promotionRef`、policy source/effective artifacts 和 budget limits；`BASELINING` 完成固定 baseline/environment；`SEALING` 固定 generation、CandidateManifest 与完整 CommitObjectPlan；`VERIFYING`/`ACCEPTING` 分别固定 VerificationBundle/AcceptanceReport。进入 `AWAITING_HUMAN` 前必须停止全部 worker，并固定 active-execution budget usage；等待时间只由 approval TTL 计量。Orchestrator 随后持久化：

```text
approvalContextDigest = sha256(
  "selfdev.approval-context.v1" || canonical(ApprovalContext)
)
```

该 context 必须覆盖 goal、runId、`AWAITING_HUMAN` state version、generation、budget limits 与 usage、baseline/environment、candidate、policy binding/effective policy、CommitObjectPlan/PromotionPlan、verification 和 acceptance。Challenge、HumanProof、ApprovalReceipt 逐层绑定该 context 与 `challengeDigest`；任何覆盖字段、usage、version、generation 或 artifact bytes 变化，必须先吊销 challenge/未消费 receipt，再走新的 repair/stale/failure transition 并重新生成 context，绝不能沿用旧签名。

`approve` 的精确交互契约：

1. 必须提供 `HumanApproverRef`，并通过 registry 中未撤销、角色绑定正确的 key 与未过期 `ApprovalAuthenticationContext` 认证；交互只能是本地 TTY + recent OS re-auth，或独立受信审批界面。先以 CAS 重读 `AWAITING_HUMAN` 最新版本和独立 journal anchor。
2. UI 完整显示 `approvalContextDigest`、`runId`/state version/generation、`baseRef@baseSha`、新建的 `promotionRef`、全部 candidate/policy/plan/verification/acceptance digest、预计算 `expectedCommitObjectId`、commit raw-byte identity/timestamp/timezone/message/header/signature policy、diff、required/holdout/safety 硬门、全部 advisory findings、预算 limits/usage、repair 次数和 receipt TTL。
3. 控制面生成至少 128-bit 随机一次性 nonce，并用 issuer key 签名完整 challenge；用户必须准确输入 UI 给出的 `approve <candidate-short-digest> <nonce-challenge>`。短 digest 仅用于人机挑战，`HumanProof.actorSignature` 必须 domain-separated 地覆盖 `actor + challengeDigest + approvalContextDigest + exactResponseDigest + signedAt`。
4. 服务端重新计算全部完整 digest，重新查询 key registry/revocation epoch，校验 challenge issuer signature、HumanProof actor signature、actor/role/auth context、TTL、nonce 未使用、exact response、`baseRef` head 仍为 `baseSha` 且 `promotionRef` 仍不存在；随后在同一 CAS 中消费 challenge nonce 并签发绑定 `challengeDigest + humanProofDigest + approvalContextDigest` 的 `ApprovalReceipt`。默认 TTL 由 builtin policy 限定，user/base policy 只能缩短。
5. 不提供 `--yes`、`--force`、环境变量确认、pipe/stdin 自动确认或模型 tool-call 确认。非 TTY 只能导入由独立受信审批界面/硬件身份签发的同结构签名 receipt，不能降级成布尔值。
6. request-changes、reject、key 撤销、auth context/TTL 过期、base/promotion ref 变化或任一 context 字段变化都使旧 challenge/receipt 永久失效；receipt 消费时还要按当前 registry/anchor 再验证一次。

Human approval 只授权**该 ApprovalReceipt 绑定的 PromotionPlan**：精确 parent=`baseSha`、tree=`gitTreeObjectId`、完整 commit raw-byte plan、`expectedCommitObjectId` 和新本地 `promotionRef`。进入 `PROMOTING` 时 receipt 再作为 single-use capability 原子消费；它不授权 push、merge、tag、publish、release、其他 ref 或未来修复 generation。

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
- `transactional-queryable`（例如 store CAS、ref CAS）在恢复时查询权威状态并 reconcile；`idempotent-retryable`（例如内容寻址 artifact put）可用同一 key 重试并逐 attempt 计费；`opaque-ambiguous`（provider/model 调用、任意 suite process）在 receipt 缺失时**禁止盲重放**，模型调用转 `FAILED/recovery_failed`，suite 转 `inconclusive`，后续只能由新 repair generation 或新 run 产生新 attempt。
- 在状态跃迁、文件 seal、suite 完成、approval 消费和 ref 创建之间的每个崩溃点都必须有故障注入测试；特别测试“授权已通过、提交前暂停”时 lease 被 steal，旧 worker 恢复后仍必须因 fence/version 不匹配而失败。
- 过期 lease 由恢复 worker 撤销；新 holder 通过 CAS 取得严格更大的 `fencingToken` 和独立 worktree。每个 mutable file/tool/effect 在真正 commit 前必须重读并匹配 `leaseId + fencingToken + generation + stateVersion`；旧 Runner 已确认停止后才允许 seal。

取消/回滚规则：

- Cancel 是异步、幂等的：只对 `CANCELLABLE` 集合先 CAS 到 `CANCEL_REQUESTED`，再停止模型/进程、撤销 lease、隔离 worktree，最后 `CANCELLED`；审计和内容寻址 evidence 按 retention policy 保留。
- `APPROVED → PROMOTING` 是 commit point。Cancel 与它竞争同一个 run version：cancel 先赢则 promotion 不得开始；promotion 先赢则 cancel 返回 `promotion_commit_in_progress`，不得把已创建/待对账的 ref 记成 `CANCELLED`。
- 未 promotion 时，回滚等于丢弃候选 worktree，不触碰用户当前 worktree。
- promotion 只按已批准 PromotionPlan 原子创建一个新的本地 `promotionRef`（缺省可确定性派生为 `refs/heads/selfdev/<runId>`）。Promotion Worker 必须在清空/隔离用户 Git config、env、hooks、credential helper 和 signing helper 的 profile 中，以受信 low-level typed object API 从 CommitObjectPlan 生成 raw payload；序列化 bytes/digest 和按 repository object format 计算的 OID 必须逐字节等于 `rawCommitPayload`/`expectedCommitObjectId`，不得调用带隐式 author、clock、timezone、encoding 或 config 的 porcelain commit。
- `promotionRef` 事前必须不存在；ref CAS 的 expected value 是 null/all-zero，new value 必须是获批的精确 `expectedCommitObjectId`。已存在但不能由同一 effect intent/该精确 OID 对账时是 `promotion_conflict`。若 ref 已由本 effect 正确创建但 PromotionReceipt 未记账，恢复应补记并转 `COMPLETED`，而非创建第二个 ref 或接受不同 commit。`COMPLETED` 后系统不自动删除或重写该 ref；人类可用普通 Git 流程检查、改名、合并或删除。

### 18.9 Baseline、测试、eval 与独立验收

**同环境原则**：Baseline 和 Candidate 必须使用同一可信 suite、环境镜像、工具链/依赖 digest、资源配额、时钟/随机种子策略和 sandbox。Baseline 记录现有失败；policy 明确哪些任务允许修复已有失败。环境无法复现或 baseline 超时不能被解释成 candidate pass。

验证分四层：

1. **Deterministic required suites**：类型、单元、集成、文档、静态安全、受保护路径和 reproducibility 检查。
2. **Holdouts**：由 builtin/base policy 或外部只读 artifact 提供；Developer 不可见内容和路径，只收到去敏结果类别。
3. **Deterministic graders**：以机器可重复规则评估 acceptance criteria、diff scope、行为输出和预算，输出结构化 evidence。
4. **Isolated model reviewer（advisory only）**：只在前三层明确完成后评估语义正确性、设计一致性、风险和可维护性；模型报告不是安全事实，不能把 deterministic fail 改成 pass，也不能替人批准。

候选 diff/文本必须通过 versioned、length-bounded、strict-schema typed data channel 送入 Reviewer，候选 bytes 只出现在明确的 untrusted field；禁止把 delimiter 拼接当隔离。decoder、长度、字段、delimiter 或协议异常一律产生 `inconclusive`，不尝试“让模型忽略注入”。Isolation attestation 必须绑定 reviewer runtime、Runner profile、prompt、typed input envelope、decoder 和全部 context-source digests。EffectivePolicy 判为 high-risk 的变更至少需要两个彼此独立、无共享 session/Memory/Plugin/context 的 Reviewer 都给出 advisory accept；无论风险级别，Human Approver 都必须逐项查看 deterministic gates、模型 findings 和语义 acceptance criteria，承担最终语义判断。

必须记录以下指标，并同时保存 baseline/candidate 原值而非只存汇总分：

| 维度 | 最小指标 |
|---|---|
| **Trajectory** | state 停留时间、tool/suite 次数、repair 次数、取消/崩溃恢复、无效跃迁/越界尝试 |
| **Quality** | required/holdout pass delta、回归数、finding severity、accept/reject、后续人工返工 |
| **Cost** | input/output tokens、模型费用、wall time、CPU/内存、artifact 字节、review 成本 |
| **Safety** | protected-path 拒绝、sandbox/网络/secret deny、prompt-injection 命中、evidence/receipt tamper、stale-base 阻断 |

质量或成本阈值由 base/user policy 收窄；Safety 必须全部明确 pass。评估集需要版本化、保留未参与开发的 holdout，并防止同一模型通过持久 Memory/Skill/Plugin 看到答案。模型 grader 的版本、prompt digest、采样参数和原始输出都进入 Acceptance evidence。

### 18.10 Promotion、远端边界与发布关系

SD4/v1 的 promotion 只完成三件事：验证 `baseRef@baseSha` 与 ApprovalReceipt/PromotionPlan 绑定、在隔离 Git config 的 low-level typed object API 中生成并验证 CommitObjectPlan 的精确 raw bytes/OID、以 expected=null → new=`expectedCommitObjectId` 的原子 ref CAS 创建 plan 指定且事前不存在的 `promotionRef`。它不修改 current branch/index/worktree，不执行 hooks，不读取用户 Git config/credential，不访问网络，也不在 promotion 时补 author、clock、timezone、message、header、encoding 或签名熵。

完成后的人类流程与 §18 分离：查看本地 branch → 普通 code review → 人工决定 merge/rebase/cherry-pick → 按 [§9](./09-build-ci-dist.md) 和对应 release checklist 重新走同 SHA CI、签名、notarization 与 publication gate。`ApprovalReceipt` 不是 release approval，也不能替代 CODEOWNERS、branch protection、DCO、changeset 或 release custodian。

目标 beta 的 release gate 还必须由独立 `ReleaseChannelManifest`/`ReleaseApprovalReceipt` 绑定 candidate SHA、artifacts、package set 与渠道语义：npm dist-tag=`next`，GitHub `prerelease=true`、`make_latest=false`。发布后必须从权威 API 断言 `next`/latest 状态；partial publish 或断言失败执行预定义 rollback，且 stable/latest 不得被改变。该 manifest、release actor、credential 和 rollback 均属于 [实施计划 REL-01/REL-02](../../plans/2026-08-19-self-development-implementation.md)，不进入 SelfDev ApprovalReceipt，也不能由 Promotion Worker 执行。

### 18.11 安全威胁与强制测试

| 威胁 | 必须的阻断 |
|---|---|
| 候选文档/代码 prompt injection | strict typed data channel；解析异常=inconclusive；Reviewer 无工具且报告仅 advisory；高风险双 reviewer + 人工逐项判断 |
| 命令/参数注入 | `Check.run(suiteId)` typed argv、`shell:false`、base-owned registry；无通用 Bash |
| symlink/path traversal/大小写绕过 | canonicalize + realpath + cwd boundary + protected policy；seal 前后复算 |
| 候选修改测试/CI 让自己通过 | required suite/holdout/command graph 来自 builtin ∩ user ∩ base-SHA policy |
| TOCTOU / seal 后写入 | 单调 fencing token、独立 holder worktree、commit 前复核 generation/stateVersion、旧 Runner 停止证明、manifest/tree 复算 |
| 自批、自审或共享记忆污染 | 角色身份约束、Reviewer 新会话、无 persistent Memory/Skill/Plugin、HumanProof |
| crash 重放双重副作用 | recovery class、预算预留、CAS/fencing、intent/receipt、opaque 不盲重放、故障注入 |
| journal 整链重写/快照回滚 | 独立 append-only 签名 anchor、单调 counter、完整链与 store-generation 校验；anchor 不可用即停机 |
| base 已过时仍 promotion | approval 前和 promotion 前两次 freshness check；不自动 rebase |
| approval replay/替换候选 | domain-separated ApprovalContext、challenge/HumanProof 双签、key revocation、nonce/receipt 各自 single-use、anchor consumption |
| Git config/commit OID 漂移 | 完整 raw-byte CommitObjectPlan、隔离 config、预计算 OID、expected=null 的精确 ref CAS |
| 通过普通 permission dangerous flags 绕过 | §18 profiles 硬拒绝所有 dangerous bypass；builtin policy 不可收窄 |

### 18.12 SD0–SD5 交付阶段与退出标准

阶段按依赖顺序推进；前一阶段 evidence 未关闭，后一阶段只能保留 backlog。每阶段结果都必须绑定 exact SHA，fixtures/mocks 不能冒充 production wiring。

| 阶段 | 能力边界 | 可量化退出标准 |
|---|---|---|
| **SD0 — Contract & security prerequisites** | 冻结本节、threat model、路径分类和 release scope；先关闭会影响专用 Runner 的已知权限/Hook P0 | 文档/链接/配置/事件检查全绿；v1 raw Bash 零 silent auto-allow；builtin Hook 对超限 payload 全量 fail-closed 且原始/扫描 digest 一致；安全评审签字。无产品入口 |
| **SD1 — State, store & sealing** | reducer、CAS/monotonic fencing、独立签名 journal anchor、ArtifactRef、holder-isolated worktree、manifest/seal；使用 fake worker | 所有显式边和每个 STALEABLE→STALE/非法跃迁表驱动测试 100% 通过；pause-after-auth/before-commit、opaque effect、整链重写/anchor rollback fixture 均 fail-closed；每个 effect 达成 exactly-once committed state；无模型开发入口 |
| **SD2 — Restricted Developer** | `selfdev.developer`、typed file tools、base policy intersection、受保护面、开发预算和新 generation repair | protected/symlink/case/traversal 攻击 corpus 100% deny；generic Bash/net/secret/Plugin/auto-Skill/Memory write/dangerous flags 全拒绝；候选只能在隔离 worktree 变化；仍不可 promotion |
| **SD3 — Verification & acceptance shadow** | `Check.run`、同环境 baseline/candidate、holdout、deterministic graders、isolated advisory reviewer、完整 evidence | required + holdout fixtures 可重复两次且 digest 相同；base/candidate 同 suiteDefinitionDigest 且 SuiteResult subject/source 绑定；环境/typed-channel/timeout/missing evidence 全为 inconclusive；高风险双 reviewer isolation；shadow E2E 覆盖 pass/repair/reject/crash/cancel，promotion API 仍不存在 |
| **SD4 — Human-approved branch-only** | approval context/challenge/receipt、key registry/revocation、freshness、确定性 commit-object promotion、本地 branch E2E | 非可信认证、`--yes`/stdin/replay/过期/替换 context 全拒绝；base race 与 OID/config 漂移阻断；支持平台 E2E 均不改 current worktree 且无远端请求；独立 product readiness、security 与 UX sign-off 通过。**这是最早 production-capable 阶段**；release custodian 只在独立 REL-02 gate 出现 |
| **SD5 — Bounded autonomous proposals** | 可选的 shadow 信号触发、更多可信任务类别和有界 repair；仍保留 SD4 人批和 branch-only 边界 | 默认仍 off/shadow；长期 crash/retry/预算 eval 无越界；质量/成本相对固定人工基线达到预先登记阈值；安全 suite 零失败；每个新任务类别单独通过产品/安全/人工 gate |

SD4 计划目标可以是 `0.1.0-beta.1`，但版本号不豁免 [§10 evidence gate](./10-milestones.md) 或 [L2 release checklist](../../../releases/L2-RELEASE-CHECKLIST.md) 的同 SHA、凭据、硬件与人工边界。SD5 不授权远端自动化；push/merge/publish 若未来考虑，必须另立新规范和威胁评审。

### 18.13 当前实现状态（截至本规范落地基线）

| §18 子系统 | 状态 | 当前事实 / 不得误读之处 |
|---|---|---|
| Terminology 与本节契约 | **Proposed / not shipped** | 文档落地不等于运行时能力 |
| Orchestrator / deterministic reducer | **Proposed / not shipped** | 普通 Agent Runner 不是 §18 Orchestrator |
| `SelfDevRun` store、CAS、lease、journal | **Proposed / not shipped** | 现有 Session/Event 存储未实现本节一致性契约 |
| Policy intersection / protected surfaces | **Proposed / not shipped** | 普通 Permission/Trust 是可复用原语，不是 base-SHA policy |
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
| 2026-08-19 | §18 v1.1 | 收紧 stale/fencing、policy lattice、suite subject、human trust root/approval context、advisory reviewer、确定性 commit object、effect recovery、独立 journal anchor 与 beta channel 契约。 |
| 2026-08-19 | §18 v1 | 新增受控 Self-Development/Change Pipeline：术语分离、状态机、角色隔离、不可变候选、base-SHA policy、专用 Runner、可信检查、证据/审批 digest 绑定、branch-only promotion、SD0–SD5 与真实实现状态。 |
