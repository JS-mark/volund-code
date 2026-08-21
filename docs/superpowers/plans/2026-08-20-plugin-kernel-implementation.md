# Plugin Kernel + Controlled Self-Development 实施计划（2026-08-20）

> **状态**：PROPOSED / PHASE RE-PLAN · FIX2（2026-08-21）。运行时任务尚未开始；设计存在不等于功能已交付。
>
> **权威规范**：[§19 Plugin Kernel](../specs/2026-07-31-apollo-code-design/19-plugin-kernel.md)；Self-Development control plane 继续遵守 [§18](../specs/2026-07-31-apollo-code-design/18-self-development.md)。
>
> **计划优先级**：本计划在 phase 顺序、候选对象与 promotion 终点上优先于 [2026-08-19 Self-Development 计划](./2026-08-19-self-development-implementation.md)；旧计划的 identity、evidence、review、approval、Git transaction 与 release 安全契约仍有效。
>
> **品牌占位**：最终名称未冻结。本文继续用 Apollo Code 指代当前仓库；brand discovery/clearance 可只读并行，但 identity/package/CLI/logo migration 必须等待硬门。

## 0. FIX2 重规划结论

代码与两轮独立安全复审推翻了原顺序与三个隐含假设：

- 当前 production registry verifier 未接线、bundle integrity optional/未传入，local install 会写 `enabled:true` 并被 `loadEnabled()` 自动加载；**P0-00 kill switch 是 ARCH 后第一个 runtime mutation**，临时关闭不依赖 Manifest v2/DAG，重新开放才依赖 CAT。
- ABI-00 随后冻结 closed-role artifact DAG、permission template、InvocationGrant/BrokerCallToken、bootstrap 与 promotion contracts；FileManifest 必须 payload-only，K3 approval 只能指向下游 CatalogEvidenceBinding。
- 长驻 plugin host 必须物理断网、固定最小 bootstrap；workspace fs、HTTP、process 与 Memory 一律经 broker，不能让 manifest 扩大 host mount/network。
- Permission approval 只产生 invocation 上限；handler dispatch 后每个 concrete effect 还要 exact single-use broker token。Workspace fs/HTTP/process 由 Rust-owned broker 直接执行，TS 只编排。
- Catalog 必须先交付 BundleBinding/CatalogEvidenceBinding、origin/trust、lifecycle 和 approval/enable receipts，ABI runtime 才能拿到可由 Rust 二次验证的 production grants。
- Self-Development promotion 使用 per-capability reservation/fencing 的 Catalog + Git 两个幂等 effect；CompletionReceipt 与 `COMPLETED` 同一 SelfDev CAS，`STAGED_DISABLED` 是无第三写的纯投影。确定性冲突终止为 `FAILED/promotion_conflict`。

新的主依赖链是：

```text
ARCH
→ P0-00 legacy kill switch
→ ABI-00 data contract
→ PK-P0-01…03 safety enforcement
→ CAT core
→ BRAND identity migration + security re-verification
→ ABI runtime
→ capability migration
→ K3 Self-Development
→ publishable prerelease
```

Brand naming、legal/domain/npm/GitHub clearance 可在 ARCH 后作为**只读 side lane**与 P0-00/ABI-00/其余 P0/CAT 并行；它不能改 repository/package/CLI/native identity。真正 identity migration 和 branded exact-SHA re-verification 仍是 ABI runtime 前硬门。

Self-Development v1 的产品结果是：

```text
显式目标 → K3 candidate bundle → isolated development
→ deterministic test → independent acceptance → human approval
→ CatalogStageEffect reservation/fence → GitPromotionEffect
→ 两个 receipts → SelfDev Completion CAS
→ local branch + read-only STAGED_DISABLED projection
```

它不会修改 K0/K1，也不会自动 adopt、enable、push、merge、tag、publish 或 deploy。

## 1. 当前基线与状态口径

计划创建时审计基线为 `codex/self-evolution@378c466`。SD0 raw Bash silent-auto-allow 和 oversized builtin-hook 问题已有实现/测试证据；brand/ABI 变化后仍需在新 exact SHA 重跑。

按 §19 目标能力面的当前粗估为 **约 30% / partial**：

| 能力面 | 当前证据 | 状态 |
|---|---|---|
| v1 local manifest/install/runtime | SDK、PluginManager、PluginRuntime 已存在，但 install→enabled 与 integrity/trust 有 P0 | unsafe partial |
| registry verification | metadata verifier primitive 存在，production install/activation 未接线 | implemented-unwired |
| supported plugin process path | macOS/Linux 有 `startPluginHost`/persistent path；none 时拒绝 | partial |
| Windows persistent host | backend 明确返回 unsupported | unavailable |
| contribution bridge | tool/command/prompt/hook/UI/Memory/Provider 分散存在 | fragmented |
| fixed bootstrap / physical no-network / Rust token enforcement | 无完整闭环 | unstarted |
| Manifest ABI v2 / closed-role DAG / universal registry | 无 | unstarted |
| bundle evidence / rollback-resistant Catalog | 仅早期 primitives | early partial |
| K1 migration / K3 SelfDev | production composition hardwired；§18 仅规范 | unstarted |

这个数字不是 release 百分比。只有 production composition、same-SHA evidence 与 human gate 同时满足，状态才能变为 complete。

## 2. 执行纪律与并行边界

每个主 phase 完成实现、spec review 和 quality/security review 后，controller 必须执行 ITERATE：

1. 提取环境限制、被推翻假设、实际 API surface 与 deferred work。
2. 检查下一 phase goal、测试矩阵、platform/identity 假设和 scope fence。
3. 记录 `NO-OP | MINOR PATCH | PROMPT REWRITE | PHASE RE-PLAN`。
4. 更新下一 phase goal card与本计划，再开始下一 phase。

只允许两类并行：

- 同一 phase 内真正独立的 read-only audit/platform test。
- ARCH 后的 BRAND-DISCOVERY，只做命名、clearance 与视觉探索，不修改 repo identity。

不得提前实现下一主 phase。Brand migration、external platform、credential/signing/notarization/publication gate 不能靠 mock 关闭。

每个任务的统一 evidence：

- exact SHA、scope paths、spec subsection、threat/failure matrix 与未覆盖项。
- scoped tests + integration/E2E + `git diff --check`，记录 command/exit/log digest。
- production composition evidence；interface/unit test 单独存在最多是 `implemented-unwired`。
- deny fixture 必须分开计数 persistent host bootstrap 与本次 invocation；grant 前本次 dispatch/permission callback/handler/broker effect 必须为 0，已存活 bootstrap host 不能被误报成 handler 已执行。
- human gate 记录 actor/time/decision/evidence digest。
- Approval UI/log/snapshot/evidence raw secret=0；SafeDisplay 不可 injective 时只能 deny。

## 3. Phase map 与依赖

| Phase | Tasks | 交付 | Human gate |
|---|---|---|---|
| **ARCH** | ARCH-01 | K0 planes、K0–K3、inventory、claim policy | Product + security |
| **LEGACY-KILL** | P0-00 | 无 ABI 依赖地关闭 production legacy install/activation | Security + plugin product |
| **ABI-00** | ABI-00-01 | closed-role DAG、grant/token/bootstrap/reservation data contracts | Architecture + security |
| **PK-P0** | P0-01…03（覆盖 §19 PK-P0-1…7） | fixed sandbox、two-layer grants、Rust-owned brokers、truthful platform、SafeDisplay/security gates | Security + platform + UX |
| **CAT** | CAT-01…02 | production closed-role verifier + CatalogEvidenceBinding/reservation/receipt core | Supply-chain + trust/storage/security |
| **BRAND side lane** | BRAND-DISCOVERY | name/logo direction + clearance evidence；read-only | User + authorized clearance owners |
| **BRAND hard gate** | BRAND-MIGRATE, BRAND-VERIFY | canonical identity + branded exact-SHA evidence | User + product/security |
| **ABI-RUNTIME** | ABI-R1…02 | Rust-validated activation、typed transport、universal brokers/registry | Runtime + security |
| **MIG** | MIG-01…04 | all extensible surfaces migrate；bypass=0 | Capability owners + security |
| **SDP** | SDP-01…03 | K3 develop/test/accept/human + dual-effect staged promotion | Product + independent acceptance + security |
| **REL** | REL-01…02 | first publishable prerelease | Release custodian |

主链：

```text
ARCH-01
→ P0-00
→ ABI-00-01
→ P0-01 → P0-02 → P0-03
→ CAT-01 → CAT-02
→ BRAND-MIGRATE → BRAND-VERIFY
→ ABI-R1 → ABI-R2
→ MIG-01 → MIG-02 → MIG-03 → MIG-04
→ SDP-01 → SDP-02 → SDP-03
→ REL-01 → REL-02
```

只读 side lane：

```text
ARCH-01 → BRAND-DISCOVERY ───────────────┐
CAT-02 + cleared identity ───────────────┴→ BRAND-MIGRATE
```

## 4. ARCH — 冻结 kernel boundary

### ARCH-01 · K0 planes、origin/lifecycle 与 inventory

- **Scope**：冻结 “Everything extensible is plugin; kernel is not”；区分 TS K0 control plane 与 Rust K0 enforcement plane；冻结 K0–K3 为 immutable `originClass`、`trustDomain`，并与 `LifecycleState` 分离。生成每个 production capability 的 machine inventory。
- **Tests/evidence**：inventory 覆盖 composition/plugin runtime/native/Rust；未分类=0；标出 direct launch/register/network、mandatory security hook、secret/payload/verdict guard 和 legacy auto-activation。
- **Scope fence**：不改 runtime，不冻结品牌名称。
- **Human gate**：product/security owner 接受 kernel exception、K3 provenance 永保留与 current claims policy。
- **Exit**：边界与 inventory 签字后只允许先实施 P0-00；ABI-00 不得抢跑该 kill switch。
- **ITERATE focus**：所有 direct I/O、broker 和 security gate 是否入 K0。

## 5. P0-00 — 第一个 runtime mutation：关闭 legacy activation

### P0-00 · Legacy production activation containment

- **Dependencies**：仅 ARCH-01；不得等待 ABI-00、Manifest v2 或 Catalog。
- **Scope**：用独立 production policy/composition kill switch 禁用 v1 local/registry install→activation 与 `loadEnabled()`；已有 `enabled:true` records 一律迁移/解释为 disabled。Test fixture adapter 与 production adapter 类型和配置隔离；该 change 不解析任何新 DAG/schema。
- **Tests/evidence**：在尚无 Manifest v2 类型的 fixture 上，install/upgrade/startup/old-state/CLI/API corpus 全部 activation=0；missing integrity、registry verifier absent、bundle swap、symlink、forged metadata、stale enabled record 都 fail closed。
- **Human gate**：security + plugin product owner 明确接受 temporary unavailable。
- **Exit**：CAT/ABI runtime 前没有 production executable third-party plugin path；重新开放条件显式指向 CAT-01/02 + ABI-R1，而不是删除 kill switch 即完成。
- **ITERATE focus**：枚举实际被关闭的 activation/load surfaces 与 compatibility fallout，并写入 ABI-00 inherited learnings；不得以临时 reopen 解决测试不便。

## 6. ABI-00 — 只冻结可验证 data contract

### ABI-00-01 · Closed-role DAG、permission grants 与 promotion contracts

- **Scope**：以 brand-neutral namespace 冻结 source/build inputs → payload-only FileManifest → Manifest → BundleBinding → detached signatures → EvidenceSet/provenance/SBOM output attestations → CatalogEvidenceBinding → Approval/Completion → Catalog events。每个 ArtifactRef 带 closed-enum `mediaRole/schemaRole` 且有 allowed-upstream matrix；FileManifest 明确排除 manifest/binding/signature/provenance/SBOM/evidence/receipt/Catalog metadata。K3 在 approval 前冻结不含 binding/approval/self back-reference 的 SelfDevPromotionPlan，CatalogEvidenceBinding 内嵌其 canonical bytes/digest；approval 只指向该 binding。另定义 immutable origin/trust、LifecycleState、`HostBootstrapProfileV1`、data-only permission grammar、injective `SafeDisplayV1`、`ActivationToken`→upper-bound `InvocationGrant`→exact single-use `BrokerCallToken`，以及 capability reservation/fence、effect/receipt contracts。
- **Tests/evidence**：canonical/domain/role-pair golden；self-reference/cycle/unknown or reverse upstream ref、payload contamination、outer-only trust、unknown/duplicate key、unsafe path/number/Unicode、signature replay、approval 指向 raw bundle、origin/trust rewrite、template nondeterminism、SafeDisplay collision、grant widening、effect-plan/reservation cross-binding 全 fail closed。
- **Scope fence**：schema/encoder/verifier fixture only；不接 production activation，不创建 final package identity，不重新开放 P0-00 kill switch。
- **Human gate**：architecture + security + supply-chain reviewers。
- **Exit**：P0-01…03 有稳定 role/grant/profile/receipt fixture；production legacy 已由 P0-00 独立关闭。

## 7. PK-P0 — 让安全边界成为真实 enforcement

### P0-01 · Fixed HostBootstrapProfile、physical no-network 与 truthful platforms

- **Scope**：Linux/macOS persistent host 使用固定 profile：runtime closure + sealed bundle RO + private data/scratch + one IPC；无 broad root/workspace/home/manifest fs mount，固定 `net=false`。Tier 按 persistent features 计算。Windows 当前明确 `pluginHost=unavailable`；若要支持，必须另交同等级 persistent implementation/evidence。
- **Tests/evidence**：host direct fs/network/DNS/proxy/child escape matrix；allowed bootstrap paths 正向；broad `/` fallback=0。probe/doctor/UI/machine JSON 区分 ordinary exec 与 persistent plugin host；Windows activation fail closed。
- **Human gate**：Linux/macOS platform + security；Windows owner只可签 unavailable，或在真实 Windows 证据完成后签 supported。

### P0-02 · Rust enforcement primitives、hard resources 与 OS brokers

- **Scope**：Rust verifier 对 ABI-00 fixture activation/grant/broker tokens、profile、closed-role bundle/evidence binding、policy/catalog epoch、budget/revocation 二次验证；实现 wall/CPU/RSS/PID/FD/output/RPC/process-tree kill/reap。Plugin host 永久断网。v1 workspace fs、HTTP 与 process broker 由 Rust canonicalize/validate/reserve budget 并直接执行 OS effect；TS 只编排，不持有 fd/socket/child/scoped I/O handle。HTTP 做 exact scheme/host/port pinning、redirect per-hop revalidation、credential scoping。
- **Tests/evidence**：token/grant/profile/file/bundle/role/epoch/revocation/budget tamper/stale/replay 在 spawn/dispatch/effect 前拒绝；fork/native allocation/CPU/FD/output/RPC flood/timeout/crash/cancel 无 orphan。Direct fs/socket/process 永远 deny；broker 邻接 path/endpoint、DNS rebinding、redirect、metadata、proxy/credential forwarding deny；TS 假 allow/伪造 result 不能造成 OS effect。
- **Scope fence**：production activation仍关闭；CAT 之前只用受信 fixture issuer 验 enforcement primitive。
- **Human gate**：Rust/native + network security reviewers。

### P0-03 · Two-layer authorization、SafeDisplay 与 mandatory gates

- **Scope**：K0 从冻结 data-only template + canonical input 派生 per-call PermissionSpec；删除/禁用 plugin executable `permissionSpec(input)`/PermissionIntent path和 implicit empty adapter。Approval 后由 Rust-backed K0 issuer 签 upper-bound InvocationGrant 才 dispatch handler；每个 concrete broker request 经 TS 预检 + Rust subset/exact-target revalidation 后，由 Rust 签 single-use BrokerCallToken。Persistent host 可仅 bootstrap 存活。Memory/UI 等 TS effect 使用 Rust-issued token，受保护 ledger 以 CAS 原子消费并重查 replay/revocation。SafeDisplay 永不含 raw secret；decision-relevant nonsecret fields injective，无法无歧义展示则 deny-only。Mandatory security hook、secret guard、payload gate、permission/verdict reducer 与 untrusted wrapper 固定 K0；plugin hook只 observation/transform。
- **Tests/evidence**：grant 前本次 permission callback/handler/dispatch=0；template missing/ambiguous/widen、grant sibling op/target/budget、broker replay/race/revoke、TS token CAS loser、path/symlink/net/process/oversize/nondeterminism、display control/bidi/Unicode/collision/secret、hook disable/reorder/priority/name/timeout/oversize/rewrite 全 deny；host bootstrap 计数与本次 invocation 计数分开。
- **Human gate**：security + CLI UX + hook/memory owners。
- **Exit**：八项 §19 P0 均有 same-SHA evidence；P0-00 kill switch 仍保持，尚不代表 Catalog/runtime ready。

## 8. CAT — 先建立 production trust 与 lifecycle core

### CAT-01 · Closed-role DAG、registry trust 与 CatalogEvidenceBinding

- **Scope**：production 逐层重读/复算 source/build inputs→payload-only FileManifest→Manifest→BundleBinding→signatures→EvidenceSet/provenance/SBOM outputs→CatalogEvidenceBinding。ArtifactRef media/schema role 与 allowed-upstream matrix 都是 closed enum；接线 registry/publisher/producer identity、signature/revocation。K3 approval API 只接受 CatalogEvidenceBinding digest。
- **Tests/evidence**：optional/missing integrity、unknown/reverse role ref、FileManifest 混入 metadata、partial file list、file/order/mode/symlink/tar traversal/timestamp/bundle swap、outer digest only、signature/domain/issuer/revocation/epoch/provenance mismatch、approval 指向 raw/partial artifact 全拒绝；rebuild reproducible。
- **Human gate**：supply-chain + trust/security owners。

### CAT-02 · Catalog、origin/lifecycle、approval/adoption/enable receipts

- **Scope**：append-only CAS/fencing Catalog；immutable `originClass`/`trustDomain`/provenance 与独立 LifecycleState。跨域采用使用引用原 binding 的 `CatalogAdoptionBinding.targetInstallationDomain`，不得重写来源 trust domain。Install default disabled；approval、adoption、enable 独立。增加线性一致 serializable `PromotionCoordinationStore`，把 Catalog-owned reservation namespace 与 SelfDev run/receipt namespace 放在同一事务域。Keyed by `capabilityId` 的 bounded-lease reservation 使用 monotonic capability revision/fence；`STAGE_PENDING` 是非 lifecycle、不可激活 record。Completion transaction锁 reservation并在 SelfDev namespace同 CAS写 receipt+COMPLETED；`STAGED_DISABLED` 只从同一 snapshot 纯投影，无第三写。Expired incomplete reservation 只有在同 transaction 锁 reservation/completion keys 并取得 absence proof 后，才可被新获批 run 以更高 fence supersede；禁止跨 store eventual “not found”。无关 capability event 不冲突；global policy/trust epoch 变化仍按 stale fail closed。K3 adoption 后仍保持 K3。
- **Tests/evidence**：concurrent stage/install/adopt/enable/revoke、same-key idempotency、不同 plan/bundle reservation conflict、same-capability stale revision/fence、lease expiry 边界 completion vs higher-fence supersede 的所有 serializable interleaving（只能一个 winner）、eventual/跨store absence fixture 必须拒绝、unrelated-capability update 不冲突、global policy/trust epoch stale、head rollback/fork、receipt replay、permission/SafeDisplay diff、origin/trust rewrite、signer rotate/revoke、offline freshness、quarantine。确定性冲突可分类为 `promotion_conflict`；无 valid projection + adoption/enable receipts 时 activation token 不可签发。
- **Human gate**：storage/trust/security + product UX。
- **Exit**：legacy bundle 只有转成 closed-role CatalogEvidenceBinding、default disabled 并走独立 receipts 才能进入后续 ABI runtime；旧 approval不得沿用，P0-00 kill switch 仍不解除。

## 9. BRAND — 只读并行，迁移仍是硬门

### BRAND-DISCOVERY · Name/logo exploration 与 clearance（side lane）

- **Scope**：ARCH-01 后即可并行做候选命名、legal/domain/npm/GitHub/package/CLI clearance 和“stable boundary + capability cells”视觉探索；对外 “Rust-enforced” 仍标 target。
- **Writes**：不得修改 repo/package/CLI/home/env/native/signing/telemetry identity；只允许本计划外的人类决策记录或独立研究 artifact。
- **Human gate**：用户选择最终 identity；authorized owners 关闭 legal/registry/domain。
- **Blocking rule**：未完成不会阻塞 P0/CAT，但会阻塞 BRAND-MIGRATE。

### BRAND-MIGRATE · Canonical identity 原子迁移

- **Dependencies**：CAT-02 + BRAND-DISCOVERY user/clearance gate。
- **Scope**：迁移 package scope/binary/home/config/env/telemetry/native/signing/docs/URLs 与 compatibility aliases；更新 brand-neutral manifest migration map，不改变 detached DAG语义。
- **Tests/evidence**：identity inventory 未分类=0；fresh install/upgrade/config/session/credential/native/docs/package dry-run；16px/单色/terminal mark。
- **Human gate**：用户签 canonical mapping + rollback plan。

### BRAND-VERIFY · Branded exact SHA 上重建信任 evidence

- **Scope**：重跑 SD0、P0-00…03、CAT-01/02 的 threat/platform/DAG/trust/Catalog/docs/config/event checks；所有 artifacts 绑定 branded exact SHA。
- **Human gate**：原 product/security/platform/supply-chain reviewers 重新签字。
- **Exit**：ABI runtime production wiring 才可开始。

## 10. ABI-RUNTIME — Catalog 之后才接 activation

### ABI-R1 · Typed transport、ActivationToken 与 persistent host wiring

- **Scope**：接通 CAT production issuer→short-lived single-use ActivationToken→Rust second validation→fixed HostBootstrapProfile。Host 可仅 bootstrap 存活；TS permission/SafeDisplay 完成后由 Rust-backed K0 issuer重验 binding并签 upper-bound InvocationGrant，Rust dispatch guard 通过后才发送本次 handler frame。实现 bounded registration/invoke/cancel/heartbeat/error transport；Production 禁 direct import/spawn/alternate loader。
- **Tests/evidence**：closed-role DAG/activation/invocation grant/catalog/policy/revocation/profile/budget fault injection；grant 前本次 permission callback/dispatch/handler=0，host bootstrap 单独计数；fragmented/oversized/replayed/out-of-order frames、callback abuse、heartbeat/crash/restart/cancel。所有 capability PID 证明 Rust parent path；Windows仍 unavailable除非真实 P0 evidence。
- **Human gate**：native/runtime/security reviewers。

### ABI-R2 · Universal registry 与 typed brokers

- **Scope**：统一 tool/provider/router-policy/prompt/observational-hook/command/memory/skill/subagent/context/eval/UI/protocol/observability registry。每个 broker request 经 TS 预检后由 Rust 重新验证为 InvocationGrant 子集，再签 exact-target single-use BrokerCallToken。Workspace fs/HTTP/process v1 由 Rust-owned broker 原子消费 token 并直接执行 OS effect；TS 只编排。Memory/UI 等 TS effect 使用 Rust-issued token，protected ledger CAS `ISSUED→CONSUMED` 并在 replay/revocation/budget check 后执行；mandatory security gates仍K0。
- **Tests/evidence**：每 kind contract suite；sibling target/op、permission widening、token replay/CAS race/revocation deny；plugin/TS direct fs/network/process unavailable，TS fake allow/result 不产生 OS effect；Memory/UI CAS loser=effect 0；raw secret不返回；result/prompt/UI untrusted label。
- **Human gate**：security + capability architecture owners。
- **Exit**：production只允许 closed-role、CatalogEvidenceBinding/default-disabled/approved/enabled bundles activation；完成显式 reopen review 后才可窄化 P0-00 kill switch，不能通过删除 guard 偷开。

## 11. MIG — 把 extensibility 从 hardwire 迁到 ABI

### MIG-01 · 两个 pilot capability

- **Scope**：一个 data-only prompt/status capability + 一个 read-only Search capability；Search 只能经 per-call fs broker，不挂 workspace。
- **Tests/evidence**：新旧 golden parity、startup/latency、deny path invocation=0、disable/revoke/rollback；legacy direct path不可达。
- **Human gate**：product UX + security。
- **ITERATE focus**：ABI/broker friction 决定后续 wave。

### MIG-02 · Tool / Provider / Prompt / Observational Hook / Command

- **Scope**：builtin tools、production Providers、prompt、observational/transform hooks、commands 迁移 K1 bundles。Provider HTTP/credentials全经 broker。Mandatory security hooks/secret/payload/verdict gates留K0。
- **Tests/evidence**：provider stream/usage/router、tool broker permissions、hook ordering/hard deny、CLI collision；无 concrete Provider/tool direct register。
- **Human gate**：capability owners + security。

### MIG-03 · Router / Memory / Skill / Subagent / Context / Eval / MCP / UI / Observability

- **Scope**：剩余 extensible surfaces 走统一 ABI；hard token/budget/depth/scope/security/holdout/telemetry consent guards留K0。
- **Tests/evidence**：Router ceiling、Memory secret/scope、prompt injection、subagent principal/budget、context mandatory retention、holdout leak、MCP trust、UI data-only、telemetry redaction/opt-in。
- **Human gate**：Memory/eval/product/security owners。

### MIG-04 · Composition bypass=0 与 claim gate

- **Scope**：production composition 只注册 K0 bootstrap、Catalog loader 和 reviewed compatibility allowlist；删除 direct registration/launch/network path。Capability matrix从 inventory 生成。
- **Tests/evidence**：dependency/AST test；enabled executable全部经 Rust验证；inventory未分类=0、legacy bypass=0；全仓 tests/typecheck/build/docs/platform。
- **Human gate**：independent architecture + product claim review。
- **Exit**：此后才允许对目标支持平台使用“plugin-native”；“Rust-enforced”只修饰 same-SHA 证明由 Rust 实际强制的 sandbox/bundle-token/workspace-fs/HTTP/process/resource 边界。Memory/UI 等仍须标 `Rust-authorized + TS effect semantics`；everything claim仍带 kernel exception。

## 12. SDP — K3 develop/test/accept/human

### SDP-01 · Candidate-only state、policy 与 protected surfaces

- **Scope**：实现 §18 SD1/SD2，但 allowed output只含 policy路径内 Manifest v2 K3 bundle。K0/K1/trust/Catalog/suite/CI/release/brand/SelfDev hard deny；state/evidence绑定base SHA、Catalog head、ABI policy与 immutable K3 origin/trust，最终形成 CatalogEvidenceBinding。
- **Tests/evidence**：path/symlink/rename/generated/submodule/worktree escape、deceptive classification、mixed diff、kernel/policy修改；protected touch fail closed。
- **Human gate**：architecture/repository/security。

### SDP-02 · Isolated development、deterministic test、independent acceptance

- **Scope**：typed file operations、no Bash/network/secrets/Memory/arbitrary plugins；base-owned suites构建/验证 closed-role candidate DAG：payload-only FileManifest→Manifest→Binding→signatures→output attestations→CatalogEvidenceBinding。复用 §18 baseline/holdout/Reviewer identity/isolation/AcceptanceReport。
- **Tests/evidence**：pass/repair/reject/cancel/crash/restart/budget/stale；candidate改 tests/config、污染 FileManifest、伪造 role/evidence/provenance/SBOM、approval 指向 raw bundle、holdout leak、reviewer identity/context reuse全 deny；sandbox/DAG/Catalog dry-run included。
- **Human gate**：independent acceptance + eval + security；model recommendation仅 advisory。

### SDP-03 · Catalog reservation、Git effect、Completion CAS 与 terminal conflicts

- **Scope**：K0 先冻结无 binding/approval/self back-reference 的 `SelfDevPromotionPlan`、`CatalogStageEffectPlan`、`GitPromotionEffectPlan` 并把 canonical plan 纳入 CatalogEvidenceBinding；Human 只批准 exact binding。Catalog effect 在 PromotionCoordinationStore 的 Catalog namespace 以 capabilityId CAS 创建/重读带 expiresAt 的 fenced `STAGE_PENDING` reservation并产绑定 plan/binding/approval 的 `CatalogStageReceipt`；Git effect携带 reservation/fence 产同样绑定的 `GitPromotionReceipt`。Reducer 在 reservation lease 内以同一 serializable transaction 锁 reservation，并在 SelfDev namespace 同 CAS 写 `SelfDevCompletionReceipt + run=COMPLETED`。`STAGED_DISABLED` 仅从同一 snapshot 对 `STAGE_PENDING + CompletionReceipt` 做纯投影，无第三 Catalog write/event；expired incomplete reservation 只有在同 transaction 证明 matching completion absent 后，才可由新获批 run 以更高 fence supersede。
- **Tests/evidence**：对 Catalog CAS、Catalog side effect→receipt、Git call、Git ref update→receipt、两个 receipts、Completion CAS/lease expiry/supersede 的 before/after/response-unknown 与所有 completion-vs-supersede interleaving 全部 fault-inject，并覆盖 crash/restart、duplicate/reorder/replay。断言只能一个 serialization winner，跨store/eventual absence 拒绝。Transient unknown 只按同 idempotency key reconcile；reservation/capability-revision/fence/branch-target/receipt mismatch 等 deterministic conflict 必须 `FAILED/promotion_conflict`，停止重试，新尝试需新 run + 新 approval；无关 capability update 不制造冲突。所有单边/中间态 adopt/activate=0；成功后 current worktree/remote/network unchanged。
- **Human gate**：BDFL/product + security + independent acceptance + repository owner。
- **Exit**：最多“controlled self-development to staged-disabled K3 capability”；adoption与enable另需人工 receipts。

## 13. REL — 可发布 prerelease

### REL-01 · Freeze immutable candidate

- **Scope**：基于 MIG-04/SDP-03 final SHA 生成 changeset、release notes、SBOM/checksum、capability/platform/persistent-tier matrix、known limitations、channel manifest与rollback。暂以 `0.1.0-beta.1` 为 planning label。
- **Tests/evidence**：forced full test/typecheck/build/docs、native/escape/platform、clean install/upgrade、sealed plugin/Catalog/revoke、K3 dual-effect staged smoke；same-SHA artifacts。Release notes禁止 autonomous/absolute secure，unsupported Windows明确 unavailable。
- **Human gate**：product readiness + security + release reviewer。

### REL-02 · Human-controlled publication

- **Scope**：只有 release custodian 使用 protected credentials按获批 channel manifest发布 prerelease；SelfDev/Plugin/普通 Agent无 publication capability。
- **Tests/evidence**：tag/SHA/checksum/provenance、npm prerelease tag、GitHub prerelease/latest、clean-machine install、post-publish verify；失败按预签 rollback恢复 stable/latest。
- **Human gate**：release custodian final explicit approval。

## 14. 最终退出判定

只有以下全部成立，计划才可完成：

- ARCH 后 P0-00 已先独立关闭 legacy activation；ABI-00 与其余七项 PK-P0 human gates随后关闭，且 reopen 经过独立 review。
- CAT production verifier/Catalog/receipt core与 branded exact-SHA evidence关闭。
- Closed-role artifact DAG 无 self/reverse/unknown upstream ref；FileManifest payload-only，CatalogEvidenceBinding 下游绑定 attestations，K3 approval只指向它；origin/trust/provenance不可变，LifecycleState独立。
- 长驻 host固定 minimal mounts、物理断网；所有 workspace fs/HTTP/process/Memory均broker。
- InvocationGrant 只作为 handler/effect 上限，每个 concrete request 使用 exact single-use BrokerCallToken；grant 前本次 handler/permission callback=0。
- Rust对 activation/invocation/broker token、profile/bundle/evidence binding、policy/catalog epoch/budget/revocation二次验证，并直接执行 workspace-fs/HTTP/process OS effect；Memory/UI token由Rust签发并CAS消费；unsupported Windows明确 unavailable。
- SafeDisplay不含 raw secret且injective；无法无歧义展示的请求deny-only。
- Mandatory security hooks/secret/payload/verdict gates留K0；plugin hooks仅 observation/transform。
- Extensible inventory 100%经 ABI 或 unavailable；direct bypass=0。
- K3 promotion使用 per-capability reservation/fence；Git/Catalog receipts绑定同一 plan，CompletionReceipt+COMPLETED同一SelfDev CAS；STAGED_DISABLED为无第三写纯投影。确定性冲突终止 `FAILED/promotion_conflict`，中间不可 activation。
- SelfDev development/test/accept/human evidence绑定同一 base/candidate/Catalog/policy/identity chain。
- External release gates未由 mock/dry-run/self-signed代替；publication由人类 custodian完成。

任一项缺失时状态必须是 `partial`、`implemented-unwired`、`verified-local`、`verified-ci`、`external-pending`、`unavailable` 或 `blocked`，不是“可发布”“Rust-enforced 已完成”“everything is plugin 已完成”或“自进化已开启”。
