# Plugin Kernel + Controlled Self-Development 实施计划（2026-08-20）

> **状态**：IN EXECUTION · ABI-00 CONTRACT DRAFT（2026-08-21）。P0-00 deny-only fence 已在 `33e5ce5` 通过独立 final review（0 Critical / 0 Important）并保持关闭；其余 runtime/Catalog/ABI 功能未交付。
>
> **权威规范**：[§19 Plugin Kernel](../specs/2026-07-31-volund-code-design/19-plugin-kernel.md)；ABI-00 byte contract 见 [§19a Capability Contract V1](../specs/2026-07-31-volund-code-design/19a-capability-contract.md)；Self-Development control plane 继续遵守 [§18](../specs/2026-07-31-volund-code-design/18-self-development.md)。
>
> **计划优先级**：本计划在 phase 顺序、候选对象与 promotion 终点上优先于 [2026-08-19 Self-Development 计划](./2026-08-19-self-development-implementation.md)；旧计划的 identity、evidence、review、approval、Git transaction 与 release 安全契约仍有效。
>
> **品牌占位**：最终名称未冻结。本文继续用 Volund CLI 指代当前仓库；brand discovery/clearance 可只读并行，但 identity/package/CLI/logo migration 必须等待硬门。

## 0. ABI-00 迭代结论

代码与两轮独立安全复审推翻了原顺序与三个隐含假设：

- 历史 production registry verifier 未接线、bundle integrity optional/未传入时，local install 曾写 `enabled:true` 并被 `loadEnabled()` 自动加载；**P0-00 kill switch 已作为 ARCH 后第一个 runtime mutation在 `33e5ce5` 完成**，deny-only关闭不依赖 Manifest v2/DAG，重新开放才依赖 CAT。
- P0-00 已证实 production legacy authority/test harness 不能作为 ABI fixture 保留；PluginManager/PluginRuntime production 路径必须持续 deny-only，ABI-00 只能提供 pure schema/corpus，不能经 env/config/test adapter 暗开 activation。
- ABI-00 随后冻结 raw-byte Canonical JSON V1、domain preimage/digest/signature、closed-role artifact DAG、permission template、Activation/Invocation/Broker authority、bootstrap 与 promotion/adoption/enable contracts；FileManifest 必须 payload-only，K3 promotion approval 只能指向下游 CatalogEvidenceBinding。
- 长驻 plugin host 必须物理断网、固定最小 bootstrap；workspace fs、HTTP、process 与 Memory 一律经 broker，不能让 manifest 扩大 host mount/network。
- Permission approval 只产生 invocation 上限；handler dispatch 后每个 concrete effect 还要 exact single-use broker token。Workspace fs/HTTP/process 由 Rust-owned broker 直接执行，TS 只编排。
- Catalog 必须先交付 BundleBinding/CatalogEvidenceBinding/CatalogAdoptionBinding、origin/source-trust/target-installation、lifecycle 和独立 AdoptionApproval/EnableApproval receipts，ABI runtime 才能拿到可由 Rust 二次验证的 production grants。
- Self-Development promotion 使用 per-capability reservation/fencing 的 Catalog + Git 两个幂等 effect；Completion经primary PREPARED→independent AnchorStore ANCHORED→primary FINALIZED发布，最终同一local finalized snapshot含 anchored CompletionReceipt、`run=COMPLETED`、`reservation=RELEASED_COMPLETED` 与 active-pointer clear，`STAGED_DISABLED` 是无第三写的纯投影。确定性冲突终止为 `FAILED/promotion_conflict`。

新的主依赖链是：

```text
ARCH
→ P0-00 legacy fence（completed baseline）
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
→ anchored approval/consumption → CatalogStageEffect + GitPromotionEffect
→ 两个 receipts → anchored Completion + idempotent FINALIZED
→ local branch + read-only STAGED_DISABLED projection
```

它不会修改 K0/K1，也不会自动 adopt、enable、push、merge、tag、publish 或 deploy。

## 1. 当前基线与状态口径

本阶段基线为 `codex/self-evolution@33e5ce5`。P0-00 legacy authority 已从 production/package surface 移除，PluginManager/PluginRuntime 为 deny-only，独立 final review 为 0 Critical / 0 Important。SD0 raw Bash silent-auto-allow 和 oversized builtin-hook 问题已有实现/测试证据；brand/ABI 变化后仍需在新 exact SHA 重跑。

按 §19 目标能力面的当前粗估为 **约 30% / partial**：

| 能力面 | 当前证据 | 状态 |
|---|---|---|
| v1 local manifest/install/runtime | SDK primitives 仍存在；production PluginManager/PluginRuntime 已 deny-only，未接 CAT 前不可 install/activate | contained / unavailable |
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
- scoped tests + integration/E2E + `git diff --check`，记录 canonical verification-command container、exit status 与 sanitized-log `RawContentDigestV1`/size。
- production composition evidence；interface/unit test 单独存在最多是 `implemented-unwired`。
- deny fixture 必须分开计数 persistent host bootstrap 与本次 invocation；grant 前本次 dispatch/permission callback/handler/broker effect 必须为 0，已存活 bootstrap host 不能被误报成 handler 已执行。
- human gate 记录 actor/time/decision 与 exact typed CEB/CAB ArtifactRef、SafeDisplay embedded bytes/digest；不记录泛化裸 digest。
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
- **Exit**：边界与 inventory 签字后当时只允许先实施 P0-00；该顺序已由 `33e5ce5` evidence证明，ABI-00继续不得成为绕过/重开该 fence的理由。
- **ITERATE focus**：所有 direct I/O、broker 和 security gate 是否入 K0。

## 5. P0-00 — 第一个 runtime mutation：关闭 legacy activation

### P0-00 · Legacy production activation containment

- **Dependencies**：仅 ARCH-01；不得等待 ABI-00、Manifest v2 或 Catalog。
- **Current evidence**：权威基线是 `33e5ce5`，已通过 P0-00 独立 final review（0 Critical / 0 Important）；production manager/runtime deny-only，可发布 legacy authority/test harness/host execution bypass=0，旧 `enabled:true` 只作 disabled 投影，doctor 不加载 bundle。
- **Scope**：用独立 production policy/composition kill switch 禁用 v1 local/registry install→activation 与 `loadEnabled()`；已有 `enabled:true` records 一律迁移/解释为 disabled。不得保留可经 env/config/path alias 到达的 test authority；fixture 只能是 production 不可 import 的 pure data corpus。该 change 不解析任何新 DAG/schema。
- **Tests/evidence**：在尚无 Manifest v2 类型的 fixture 上，install/upgrade/startup/old-state/CLI/API corpus 全部 activation=0；fence closed + malformed/oversized payload必须先返回 `admission.production-fence-closed`且 read/parse/fetch/mutation=0；missing integrity、registry verifier absent、bundle swap、symlink、forged metadata、stale enabled record 都 fail closed。
- **Human gate**：security + plugin product owner 明确接受 temporary unavailable。
- **Exit**：CAT/ABI runtime 前没有 production executable third-party plugin path；重新开放条件显式指向 CAT-01/02 + ABI-R1，而不是删除 kill switch 即完成。
- **ITERATE focus**：枚举实际被关闭的 activation/load surfaces 与 compatibility fallout，并写入 ABI-00 inherited learnings；不得以临时 reopen 解决测试不便。
- **Nonblocking CAT/CLI follow-up**：legacy disable/uninstall state save 当前没有跨进程 CAS，竞态最多留下 disabled ghost，因 deny-only fence 不会恢复 activation；CAT-02 journal/CAS 需吸收该一致性债务。`plugin disable/uninstall --json` 成功路径当前仍输出人类文本；在 CAT/CLI typed response 阶段修正。两项均非 P0-00 reopen blocker。

## 6. ABI-00 — 只冻结可验证 data contract

### ABI-00-01 · Closed-role DAG、permission grants 与 promotion contracts

- **Normative artifact**：[§19a Capability Contract V1](../specs/2026-07-31-volund-code-design/19a-capability-contract.md)。
- **Scope**：在 private `packages/capability-contract` 用 bootstrap meta-schema + single versioned registry生成 TS/Rust exact types/tables/validators；冻结 raw UTF-8 Canonical JSON V1、`ASCII(prefix+role+NUL)+uint64_be(length)+canonical bytes` domain、互不混用的 raw/external/canonical/journal nominal digest forms（canonical/ref用 SHA-256）与 `ContractStrictPureEd25519V1`。Closed DAG 是 source/build→payload-only FileManifest→Manifest→Binding→publisher signatures→same-closure Evidence/Provenance/SBOM→distinct signed `CatalogVerificationEndorsement`→CEB→promotion/completion→CAB→独立 adoption/enable→Catalog event。
- **Scope**：Manifest contribution内嵌input/output schema与permission template完整bytes+digest；multiline/binary走candidate output→K0 NONSECRET gate→Utf8Text/SealedBlob，secret只走protected SecretHandleRef→secret-operand-binding，SafeDisplay仅显示decision-scoped alias/scope/kind/fingerprint。BuildInputSet冻结exact sorted toolchain/runtime/runtimeClosure/`ExecutableBindingV1`供process Rust no-follow identity launch。K3唯一SelfDevPromotionPlan先进入endorsement，CEB逐字复用且无future back-reference；bundle/VerificationBundle/plan/effects/Git base/parent exact equality。Effective promotion deadline恰为两个plan lease deadlines、approval expiry、endorsement expiry四个signed timestamps的minimum；policy只约束issue-time lifetime并以epoch保证freshness。Endorsement签§18 full context/participants/anchors。CAB保留origin/source trust并新增target domain/authorityGeneration；三类human receipt分离。
- **Authority**：冻结net=false profile、closed permission/broker grammar、protected refs、single-use DecisionProof与exhaustive SafeDisplay。Requested/effective effectId set exact equality；secret binding bytes必须逐字段等于input SecretHandleRef。AMBIGUOUS普通分支关闭/revoke contexts；promotion分支把run终止为`FAILED/recovery_failed`。Per-effect reconciliation不释放parent，all-sibling aggregate release后只允许fresh human lineage绑定reconciled dependency，旧authority无ack恢复。
- **Catalog/revision**：`capabilityRevision`只在DISCOVERED/new restore allocation一次分配并贯穿。PromotionApproval、consumption与Completion/terminal failure使用PREPARED→independent AnchorStore ANCHORED|CANCELLED→idempotent FINALIZED；Stage/Git不写PROMOTING→PROMOTING。Global content index固定`(capabilityId,full CanonicalSemVer)→Binding`，per-target authorityGeneration允许same content fresh CEB/CAB；human enable绑定history-derived normal/reenable/rollback/authority-refresh与watermark。Completion finalization置RELEASED_COMPLETED/clear pointer；rollback不降watermark，stale never-enabled record不能restore。
- **Limits**：严格采用 §19a role table和 `D/E/N`公式：Activation/Decision/Grant/checkpoint payload 16 KiB、Broker payload 8 KiB、profile 4 KiB、inline envelope/receipt/event 64 KiB、Manifest/Binding 1 MiB、Evidence/Provenance/Endorsement/CEB 2 MiB、FileManifest/SBOM 16 MiB、closure 64 MiB/100k lookups；journal predecessor与每 event/root artifact+authority+trust traversal各自≤32，前者 checkpoint anchor=depth0、first post-checkpoint event=depth1，大型 boundary用共享 recipe生成，不把 max fixtures原样入库。
- **Tests/evidence**：TS/Rust读取同一`.bin`/single-generated bytes；覆盖registry/bootstrap/canonical/domain/signature、VerificationSources三temporal modes/current revocation、anchors/checkpoint≤32、SemVer large numeric/build metadata/content-vs-authority generation、SafeDisplay renderer/binding、all reconciliation races与constructible maxima。Contract/admission exact enum+first-error一致，fence/store/resource preflight失败read/parse/fetch/mutation=0。
- **Package fence**：`packages/capability-contract` private/pure/verifier-only；`authority`不从 root barrel导出，plugin-sdk不依赖 authority。Pure `buildDetachedSignaturePreimage(expectedRole,canonicalBytes)`允许导出，但不得接受 key/handle或产生 signature；production exports/packlist/dependency graph以 behavioral probe证明任何接受 signing material/handle或产生 signature/issuer/mint/key-store authority的 API=0（不可只靠函数名），test signer/test keys只能 test target可达。ABI-00 production runtime/native/CLI imports=0，不接 activation、不创建 final identity、不 reopen P0-00。
- **Human gate**：architecture + security + supply-chain reviewers。
- **Exit**：§19a single registry覆盖全部 closed roles/unions/derivations/error phases，六个原始 blocker及 review发现的 endorsement/carrier/authority/size/identity/Git/Catalog闭环全关闭；P0-01…03有稳定 fixture，production legacy deny-only fence仍关闭。

## 7. PK-P0 — 让安全边界成为真实 enforcement

### P0-01 · Fixed HostBootstrapProfile、physical no-network 与 truthful platforms

- **Scope**：Linux/macOS persistent host 使用固定 profile：runtime closure + sealed bundle RO + private data/scratch + one IPC；无 broad root/workspace/home/manifest fs mount，固定 `net=false`。Tier 按 persistent features 计算。Windows 当前明确 `pluginHost=unavailable`；若要支持，必须另交同等级 persistent implementation/evidence。
- **Tests/evidence**：host direct fs/network/DNS/proxy/child escape matrix；allowed bootstrap paths 正向；broad `/` fallback=0。probe/doctor/UI/machine JSON 区分 ordinary exec 与 persistent plugin host；Windows activation fail closed。
- **Human gate**：Linux/macOS platform + security；Windows owner只可签 unavailable，或在真实 Windows 证据完成后签 supported。

### P0-02 · Rust enforcement primitives、hard resources 与 OS brokers

- **Scope**：Rust verifier 对 ABI-00 fixture activation/grant/broker tokens、profile、closed-role bundle/evidence binding、policy/catalog epoch、budget/revocation 二次验证；实现 wall/CPU/RSS/PID/FD/output/RPC/process-tree kill/reap。Plugin host 永久断网。v1 workspace fs、HTTP 与 process broker 由 Rust canonicalize/validate/reserve budget并直接执行 OS effect；TS只编排，不持有 fd/socket/child/scoped I/O handle。HTTP pin exact scheme/host/port/path+query/header/body/credential；V1 redirect不 follow，3xx结束该 effect，只有全新 invocation/decision/grant可另行授权。Process从 verified BuildInputSet重建 exact ExecutableBinding，以 no-follow path traversal/opened-file identity检查 target/toolchain/digest/size/executable mode后启动，无 PATH/host fallback。
- **Tests/evidence**：token/grant/profile/file/bundle/role/epoch/revocation/budget tamper/stale/replay 在 spawn/dispatch/effect 前拒绝；fork/native allocation/CPU/FD/output/RPC flood/timeout/crash/cancel 无 orphan。Direct fs/socket/process永远 deny；broker邻接 path/endpoint、DNS rebinding、redirect、metadata、proxy/credential forwarding、executable binding field substitution、symlink/reparse/TOCTOU deny；TS 假 allow/伪造 result不能造成 OS effect。
- **Scope fence**：production activation仍关闭；CAT 之前只用受信 fixture issuer 验 enforcement primitive。
- **Human gate**：Rust/native + network security reviewers。

### P0-03 · Two-layer authorization、SafeDisplay 与 mandatory gates

- **Scope**：K0从frozen template+canonical input+protected policy派生requested/effective PermissionSpec，effectId set exact equality且只逐字段收窄。SecretOperandBinding逐字段绑定input SecretHandleRef，SafeDisplay/DecisionProof/Grant仅携decision-scoped alias与protected refs。Ledger AMBIGUOUS ordinary分支关闭/revoke effect/Grant/Invocation/Activation contexts；promotion分支才转exact run `FAILED/recovery_failed`，不存在caller可选BLOCKED状态。外部per-effect reconciliation+all-sibling aggregate release后仍只允许fresh human lineage绑定dependency，旧authority无ack恢复。UI/token/output gates保持K0。
- **Tests/evidence**：grant 前本次 permission callback/handler/dispatch=0；template missing/ambiguous/widen、requested effect drop/add、mapping/display backedge、UI subject/result cross-effect、grant sibling op/target/budget、broker replay/race/revoke、AMBIGUOUS同/new lineage retry/ack、TS token CAS loser、path/symlink/net/process/oversize/nondeterminism、display control/bidi/Unicode/collision/secret、hook disable/reorder/priority/name/timeout/oversize/rewrite全 deny；host bootstrap计数与本次 invocation计数分开。
- **Human gate**：security + CLI UX + hook/memory owners。
- **Exit**：八项 §19 P0 均有 same-SHA evidence；P0-00 kill switch 仍保持，尚不代表 Catalog/runtime ready。

## 8. CAT — 先建立 production trust 与 lifecycle core

### CAT-01 · Closed-role DAG、registry trust 与 CatalogEvidenceBinding

- **Scope**：production按 §19a 逐层重读/复算 source/build→payload-only FileManifest→Manifest embedded subdocs→Binding→publisher signatures→Evidence/Provenance/SBOM→purpose-scoped signed CatalogVerificationEndorsement→CEB。Endorser必须重读 NONSECRET evidence bytes，以及包含全部 performed/designated run roles、purpose/session/context与 stable principal/credential commitments的 trusted participant/acceptance/isolation records；reissued id/null key不能伪造 independence。ArtifactRef pair/cardinality/rank/closure与 detached authority pairing都 closed。K3 PromotionApproval只接受 exact CEB ref，重验 endorsement与逐字复用 plan，不接受裸 digest/self-claimed outputs。
- **Tests/evidence**：optional/missing integrity、unknown/reverse role ref、FileManifest 混入 metadata、partial file list、file/order/mode/symlink/tar traversal/timestamp/bundle swap、outer digest only、signature/domain/issuer/revocation/epoch/provenance mismatch、approval 指向 raw/partial artifact 全拒绝；rebuild reproducible。
- **Human gate**：supply-chain + trust/security owners。

### CAT-02 · Catalog、origin/lifecycle、approval/adoption/enable receipts

- **Scope**：实现append-only Catalog transaction/storage/verifier **primitives与fixtures**：Candidate/InstallationRecord/ActivationSlot+history三流、revision/fence allocators、reservation/pointer records、event/checkpoint reducer、global accepted-content index、per-target authority-generation index/watermark、adoption/enable receipt verifier与normal/reenable/rollback/authority-refresh matrix。Event先定bytes再派生head digest；candidate v2与active v1 side-by-side，enable CAS原子swap。CAT-02不得接入production SelfDev run、不得消费Promotion/Stage/Git/Completion receipt或宣称完成anchored cross-store protocol；这些primitive的首个production SelfDev wiring唯一属于SDP-03。
- **Tests/evidence**：以fixture/fake stores验证concurrent discover/install/adopt/enable/revoke、revision/fence、event/head/checkpoint、content index跨domain Binding substitution、SemVer huge numeric/build metadata、authority refresh/expiry quarantine/history-derived mode、receipt replay与CAS loser mutation=0。提供PREPARED/ANCHORED/FINALIZED所需storage interfaces和fault harness但不在CAT-02执行production SelfDev effects。无valid projection+adoption/enable receipts时activation token不可签发。
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

- **Scope**：在 branded exact SHA重新验证 ABI-00 bootstrap `registry-meta-schema.v1.bin` raw/domain digest、generator/version lock、CapabilityContractRegistry digest与 generated TS/Rust types/tables/validators；重跑完整 shared golden/reject/large-recipe corpus（canonical/domain/closure/authority/contract+admission exact first-error code与 preflight zero-read）、`ContractStrictPureEd25519V1` vectors与 locked TS/Rust crypto dependency versions/resolved features/checksums。重新执行 private package root/subpath export、packlist、dependency graph、production import/reachability和 behavioral private-key/signing/issuer fence（pure `buildDetachedSignaturePreimage`仍允许）。同时重跑 SD0、P0-00…03、CAT-01/02 的 threat/platform/DAG/trust/Catalog/docs/config/event checks；production P0 fence/activation=0不得改变。所有 commands、artifacts、sanitized evidence和 reviewer decisions绑定 branded exact SHA，pre-brand pass不可复用。
- **Tests/evidence**：除上述 ABI byte/crypto/package gates外，必须逐项保留 P0 host/profile/no-network/ExecutableBinding/process、two-layer effect-set/mapping/UI、Catalog monotonic revision/release/rollback/SemVer、identity commitment/isolation、separate traversal-depth及 AMBIGUOUS terminal fault matrix；缺任一 listed gate或 feature-lock drift均失败，不允许“品牌只改字符串”豁免。
- **Human gate**：原 product/security/platform/supply-chain reviewers 重新签字。
- **Exit**：ABI runtime production wiring 才可开始。

## 10. ABI-RUNTIME — Catalog 之后才接 activation

### ABI-R1 · Typed transport、ActivationToken 与 persistent host wiring

- **Scope**：接通 CAT issuer→single-use ActivationToken→Rust validation→fixed HostBootstrapProfile。Activation绑定 exact CEB/CAB/Adoption/Enable receipts、current InstallationRecordHead + ActivationSlotHead（不绑定 CandidateHead）、policy/trust/revocation epochs和 protected profile/probe/principal `CanonicalObjectRefV1`；admission transaction消费 `ActivationNonceV1`/sidecars并创建 activation `AuthorityContextRefV1`。Invocation必须绑定 fresh input/template/spec/SafeDisplay/effectivePolicy/decisionProof refs与 activation context，Rust issuer重读 exact bytes/envelope后签 Grant，dispatch guard通过才发送 handler frame。实现 bounded registration/invoke/cancel/heartbeat/error transport；Production禁 direct import/spawn/alternate loader。
- **Tests/evidence**：closed-role DAG/activation/invocation grant/catalog/policy/revocation/profile/budget fault injection；grant 前本次 permission callback/dispatch/handler=0，host bootstrap 单独计数；fragmented/oversized/replayed/out-of-order frames、callback abuse、heartbeat/crash/restart/cancel。所有 capability PID 证明 Rust parent path；Windows仍 unavailable除非真实 P0 evidence。
- **Human gate**：native/runtime/security reviewers。

### ABI-R2 · Universal registry 与 typed brokers

- **Scope**：统一capability registry。七类broker request经Rust验证为Grant equal-or-narrower后签exact refs/token。Ledger实现`RESERVED→CONSUMED→SUCCEEDED|FAILED_DETERMINISTIC|AMBIGUOUS`，AMBIGUOUS仅可经purpose-signed exact record进入`RECONCILED_NOT_OCCURRED|RECONCILED_OCCURRED_EXACT` audit终态而不恢复authority；ordinary HTTP/process AMBIGUOUS关闭/revoke其authority contexts，不写SelfDev state；K3 promotion AMBIGUOUS另由SDP-03 anchored transition把run→`FAILED/recovery_failed`。两者都需all-sibling release，fresh human lineage绑定dependency且不恢复old authority；mandatory gates仍K0。
- **Tests/evidence**：每 kind contract suite；sibling target/op、permission widening、ExecutableBinding field/symlink/TOCTOU、UI subject/result cross-effect、token replay/CAS race/revocation deny；AMBIGUOUS同/new token/invocation/run retry/ack全部effect=0。Plugin/TS direct fs/network/process unavailable，TS fake allow/result不产生 OS effect；Memory/UI CAS loser=effect 0；raw secret不返回；result/prompt/UI untrusted label。
- **Human gate**：security + capability architecture owners。
- **Exit**：production只允许 closed-role CEB→CAB→AdoptionApproval→EnableApproval、default-disabled/current-enabled bundles activation；完成显式 reopen review 后才可窄化 P0-00 kill switch，不能通过删除 guard 偷开。

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

- **Scope**：实现 §18 SD1/SD2，但 allowed output只含 policy路径内 Manifest v2 K3 candidate。K0/K1/trust/Catalog/suite/CI/release/brand/SelfDev hard deny；state/source/build inputs与 candidate BundleBinding closure绑定 canonical Git baseRef + namespace=`git-object` base object、content candidateRevision、monotonic capabilityRevision、Candidate head、ABI policy与 immutable K3 origin/trust。此阶段只准备 candidate/binding与受保护输入，**不得**生成 SelfDevPromotionPlan、verification outputs、CatalogVerificationEndorsement、CatalogEvidenceBinding或 approval。
- **Tests/evidence**：path/symlink/rename/generated/submodule/worktree escape、deceptive classification、mixed diff、kernel/policy修改；protected touch fail closed。
- **Human gate**：architecture/repository/security。

### SDP-02 · Frozen promotion plan、isolated verification 与 independent acceptance

- **Scope**：typed file operations、no Bash/network/secrets/Memory/arbitrary plugins。顺序是硬合同：先从 SDP-01 exact candidate/source tree/Binding closure构造并冻结唯一、无 endorsement/CEB/approval/self/completion back-reference的 `SelfDevPromotionPlan`，连同 Catalog/Git effect containers及其 lease deadlines、repository object format、verified source tree、raw CommitObjectPlan/expected OID、baseRef verify + expected-zero promotionRef create的单一 Git ref transaction；SourceInputSet/VerificationBundle/plan/two effects/Git verifyBase的 baseRef，以及 baseRevision/baseSha/parent/expected object必须 exact equal且使用 git-object format mapping。**之后**才运行 base-owned deterministic/holdout/sandbox suites并构建 output attestations。最终 purpose-scoped endorser把 exact verification context、同一 frozen plan、ParticipantIdentitySet全部 performed/designated §18 roles/purpose/session/context与 stable principal/credential commitments、independent Acceptance/Isolation、limitations/rollback签入 CatalogVerificationEndorsement，CEB只逐字复用 plan并引用 endorsement。任何 verification先于 plan freeze、测试后重写 plan/tree/OID/deadline、reissued-id/null-key identity降级或另构 CEB plan都失败。
- **Tests/evidence**：pass/repair/reject/cancel/crash/restart/budget/stale；candidate改 tests/config、污染 FileManifest、伪造 role/evidence/provenance/SBOM、approval 指向 raw bundle、holdout leak、reviewer identity/context reuse全 deny；sandbox/DAG/Catalog dry-run included。
- **Human gate**：independent acceptance + eval + security；model recommendation仅 advisory。

### SDP-03 · Catalog reservation、Git effect、anchored Completion 与 terminal conflicts

- **Scope**：这是CAT-02 primitives的**首个production SelfDev wiring**。只消费SDP-02 exact plan/endorsement/CEB；Human PromotionApproval绑定SafeDisplay+run context/head/anchor。AWAITING→APPROVED、APPROVED→PROMOTING consumption和PROMOTING→COMPLETED/FAILED均用primary PREPARED lock→independent AnchorStore OPEN→ANCHORED|CANCELLED→idempotent FINALIZED。Anchor HSM以trustedNow materialize event/checkpoint/anchor/final receipt并由durable transition-finalizer签，不依赖post-anchor worker。Consumer/Stage/Git/Completion分别绑定leaseId/RunWorkerFence，且与CapabilityReservationFence nominally distinct。Stage/Git只写effect ledger/receipts。Effective deadline恰为四signed timestamps minimum。Completion FINALIZED写COMPLETED+RELEASED_COMPLETED+clear pointer；STAGED_DISABLED只从finalized released history投影。
- **Tests/evidence**：fault-inject PREPARED/OPEN/checkpoint/ANCHORED/FINALIZED、late anchor vs cancel、key loss/rotate/revoke、worker lease steal/fence swap、Stage/Git effect/receipt、四source minimum/exact/one-over、completion-vs-expiry。Expired non-ambiguous仅在`trustedNow>expiresAt`+all-ledger linearizable absence proof时FAILED/recovery_failed；AMBIGUOUS旧run同样FAILED/recovery_failed但不TTL release。Per-effect reconciliation、all-sibling aggregate release、late outcome race与fresh dependency都覆盖；FAILED run永不FAILED→FAILED/重开。Deterministic mismatch仍FAILED/promotion_conflict。所有intermediate adopt/activate=0，成功后worktree/remote/network unchanged。
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
- Single registry已生成/冻结全部 byte roles/unions/derivations/error phases；closed DAG无 self/reverse/unknown ref，FileManifest payload-only，purpose-scoped signed CatalogVerificationEndorsement覆盖 same-closure outputs、完整 performed/designated participant roles与 stable identity commitments、acceptance后 CEB才可形成，K3 PromotionApproval只指向 CEB；bundle/verification/plan/Git base exact equality，CAB保留 origin/source trust并新增 target installation，三种 approval独立。
- 长驻 host固定 minimal mounts、物理断网；所有 workspace fs/HTTP/process/Memory均broker。
- InvocationDecisionProof + protected policy/input/template/spec/display/principal refs均重读后 Grant才可签；requested/effective effectId set exact equality，PermissionSpec无 mapping/display backedge，DecisionProof/Grant才绑定 mapping；Grant只作为 handler/effect上限，每个 closed concrete request使用 exact single-use BrokerCallToken，UI display在token后由lineage派生且result不授权其他 effect；grant前本次 handler/permission callback=0。
- Rust对activation/invocation/broker token与current authority二次验证，以exact ExecutableBinding执行OS effect；ordinary AMBIGUOUS关闭/revoke contexts，K3 promotion AMBIGUOUS把run→FAILED/recovery_failed。只有signed per-effect reconciliation+all-sibling release后的人类fresh lineage可绑定dependency，旧authority无ack恢复；unsupported Windows明确unavailable。
- SafeDisplay不含 raw secret且injective；无法无歧义展示的请求deny-only。
- Mandatory security hooks/secret/payload/verdict gates留K0；plugin hooks仅 observation/transform。
- Extensible inventory 100%经 ABI 或 unavailable；direct bypass=0。
- Candidate/InstallationRecord/ActivationSlot+history支持side-by-side/atomic swap；global content index与per-target authority generations分离，enable mode由history派生且watermark不回退。K3 promotion用CapabilityReservationFence+RunWorkerFence、四source deadline和PREPARED→ANCHORED→FINALIZED；Completion finalized snapshot含receipt+COMPLETED+RELEASED_COMPLETED，STAGED_DISABLED从released history纯投影，中间不可activation。
- SelfDev development/test/accept/human evidence绑定同一 base/candidate/Catalog/policy/identity chain。
- External release gates未由 mock/dry-run/self-signed代替；publication由人类 custodian完成。

任一项缺失时状态必须是 `partial`、`implemented-unwired`、`verified-local`、`verified-ci`、`external-pending`、`unavailable` 或 `blocked`，不是“可发布”“Rust-enforced 已完成”“everything is plugin 已完成”或“自进化已开启”。
