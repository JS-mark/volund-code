> ↩ [返回索引 (README)](./README.md) · ← [上一章: §18 受控自我开发](./18-self-development.md) · [下一章: §20 自有 Harness](./20-harness.md) →

---

## §19 Plugin Kernel：Everything Extensible Is a Plugin

> **状态：PARTIALLY SHIPPED（2026-09-05）——运行时内核已按 Cordis 路线落地（S0/S1/G），capability bundle / signing / catalog 面仍为 ABI-00 草案未交付。**落地映射见 §19.0。
>
> **日期：2026-08-21（草案）· 2026-09-05（落地状态更新）。**
>
> **目标产品原则：Everything extensible is a plugin; the security kernel is not.**
>
> 本节是 §4、§5、§6 与 §18 之间的新架构总约束。它取代“把所有东西，包括安全边界本身，都做成可替换插件”的字面理解。Canonical display identity 已冻结为 **Volund CLI**，canonical CLI/npm identity 为 `volund`、`volund-cli` 与 `@volund/*`；本节不重新决定品牌，也不授权迁移 home/env、wire/schema、native/release 或 signing identity。

### 19.0 落地状态（2026-09-05，kernel 化改造 S0/S1/G）

**决策变更**：运行时组合内核不再自研 ABI-00，直接采用 **Cordis**（`@cordisjs/core` 3.18.1 稳定线，MIT，deps 仅 cosmokit + standard-schema）作为 Context 树 / 服务注册 / 依赖解析 / 卸载语义的骨架——与 DeepSeek Harness 同内核，生态契约距离最小化。本节其余原则不变：**Rust sandbox、权限决策链、事件 payload 契约（D.2 + zod）、UI 渲染权仍属 TCB，不是插件**。

已落地（`@volund/kernel` 包，提交 95658bd…3b03da3）：

| Surface | 落地形态 |
|---|---|
| `model` | 每会话 Context 的 `model` 服务（ProviderRegistry 封装） |
| `tool` | `tools` 服务 + 内置件按域拆分（`volund.core-tools` / `volund.exec` / `volund.orchestration`，`[plugins] builtin_disabled` 可整域禁用，/plugins 与 `volund plugins builtin` 可见可切）+ 桥 `tools.register/unregister`（名字强制 `plugin:<manifest.name>:` 前缀，permissionSpec 收敛 `{custom:{pluginTool}}` 进统一权限链，输出 `<untrusted>` 包裹） |
| `prompt-source` | 桥 `prompt.contribute/revoke` → 每会话 composer（`plugin:<名>:` id 命名空间，priority 缺省 600） |
| `hook` | 桥 `hooks.on` / `session.on` → 插件 hook 订阅；`preToolUse/postToolUse` 由 ToolExecutor dispatchHook 消费（首个 HookResult 生效、fail-open），`sessionStart/sessionEnd` 由会话事件广播 |
| 卸载语义 | 会话中途卸载/禁用插件：命令/页签立即摘除，贡献工具经 `ToolsService.unregisterPlugin` 对全部活会话内核广播摘除 |
| 可见性 | 内置域在 /plugins 面板 Domains 页签 + `volund plugins builtin` CLI |

未落地（保持草案）：provider/router-policy 的插件注册面（`ProviderRegistry` 已有 `{kind:'plugin'}` 源位与 manifest `kind:'provider'` 校验，宿主未接）、sandbox/session-store 可替换化、capability bundle 签名/catalog、L4 热重载完整语义。

### 19.1 决策与边界

目标架构（不是当前 shipped claim）可以压缩成一句话：

> **Everything extensible plugs in. Nothing bypasses the Rust-enforced kernel.**

“Everything is plugin” 在本项目中的严格含义是：

- 所有可以由用户、发行方或未来 Self-Development 替换、增加或升级的能力，统一以 versioned capability bundle、manifest、contribution ABI 和 catalog lifecycle 进入系统。
- 内置能力和第三方能力使用同一 ABI、同一逐调用权限模型、同一 evidence 语言；“内置”不等于可以绕过权限。
- 插件默认不可信。插件代码不能被主进程直接 `import()`，不能直接拿 Node host object、宿主文件系统、环境变量、credential 或网络句柄。
- Rust sandbox、权限/策略求交、canonical digest/signature 验证、catalog reducer、证据绑定、人工审批与 promotion 控制面属于可信计算基（TCB），不是插件，且不能被插件覆盖。

因此，本原则不是“所有代码都是第三方插件”，而是“所有**可扩展能力**都是受内核约束的 capability plugin”。Sandbox 本身绝不能成为可替换插件；否则插件可以替换执行它的规则，安全模型会形成循环信任。

#### 19.1.1 目标 capability surfaces

以下 surface 最终必须经 Capability ABI 注册，不再由 composition root 私自发明第二套扩展路径：

| Surface | 典型能力 | 内核保留的不可委托职责 |
|---|---|---|
| `tool` | Read/Search/Edit/typed process adapter/MCP tool | 输入校验、逐调用权限、sandbox profile、输出标记 |
| `provider` | Anthropic/OpenAI/兼容网关 | credential broker、网络 policy、usage accounting、Router 最终约束 |
| `router-policy` | fallback/role/cost-aware 候选排序 | allowed Provider 集、安全/成本 hard ceiling、最终选择与审计 |
| `prompt-source` | system fragment、项目说明、Memory recall | 优先级域、可信/不可信分隔、token budget |
| `hook` | observational/transform pre/post lifecycle hook | mandatory security hook、secret guard、payload gate、优先级域与 verdict reducer 永远在 K0；插件不可禁用、替换或抢先执行 |
| `command` | CLI/TUI command contribution | 命名冲突、交互身份、危险操作确认 |
| `memory-adapter` | recall/index/import/export | secret guard、scope policy、provenance 与删除语义 |
| `skill-source` | Skill discovery/activation | trust domain、自动激活 policy、prompt 包裹 |
| `subagent-profile` | 专用 agent role/profile（含 §21 reflector 的受控 dispatch） | budget、depth/concurrency、principal isolation、dispatch 预算求交与 per-session 硬顶 |
| `context-policy` | compaction/selection strategy | hard token ceiling、不可丢弃的安全消息 |
| `evaluator` | deterministic grader/holdout adapter | suite registry、evidence binding、verdict reducer |
| `ui-surface` | status/只读 panel 数据（含 `/status` section，§11.3.14） | 允许的 surface、纯数据渲染、control-character guard |
| `protocol-adapter` | MCP 等外部能力协议 | endpoint trust、auth、namespace 和 contribution conversion |
| `observability-sink` | local telemetry、显式 opt-in OTel adapter | secret redaction、consent/egress policy、事件 schema 与本地审计底账 |

Agent loop、state reducer、permission evaluator、sandbox launcher、Router 的强制 policy 层、mandatory security hooks 和 human gate 不属于这些 surface。

#### 19.1.2 K0 的两个执行平面

K0 是同一个 TCB 内职责分离的两个平面，不等于“所有安全代码都已经用 Rust 实现”：

| 平面 | 主要职责 | 不能单独证明的事实 |
|---|---|---|
| **TypeScript K0 control plane** | strict-schema 解码、catalog/state reducer、policy 求交、data-only permission template 解释、SafeDisplay、human challenge、broker orchestration、evidence/receipt 组装 | TS 产生的 token/profile/decision 不是最终 enforcement；不能直接 launch、mount、开网络或代替 Rust 验证 |
| **Rust K0 enforcement plane** | closed-role bundle/launcher、固定 HostBootstrapProfile、platform sandbox、resource/process control、activation/invocation/broker token 二次验证、Rust-owned OS broker direct execution、运行时 revocation/budget enforcement | Rust 语言本身不是证明；缺少 same-SHA platform attack evidence 时仍只能标 partial/unavailable |

TS control plane 可以“计划和申请”，Rust enforcement plane 必须“重新验证并强制”。任一平面失效都 fail closed，不存在 TS-only 或 Rust-bypass fallback。

### 19.2 当前实现基线：约 30%，且只能称 partial

截至 2026-08-20，按本节**目标能力面**而不是代码行数做保守粗估，完成度约为 **30% / partial**。这个数字只用于路线排序，不是 release burn-up、质量分数或营销口径。

已经存在的真实基础：

- `packages/plugin-sdk` 有 v1 manifest、bridge、tool/command/prompt/hook/UI/Memory capability 的部分类型。
- `packages/plugin-runtime` 有本地 install/inspect/approval、registry metadata verifier **primitive**、RPC guard、activation/deactivation 和 contribution bridge；registry verifier 尚未接入 production install/activation。
- `packages/native-bridge/src/sandbox.ts` 把 `startPluginHost` 定义为唯一支持的插件进程入口；sandbox probe 为 `none` 时 fail closed。
- `crates/volund-sandbox/src/plugin.rs` 校验 bridge fd、manifest entry、read/write roots 与资源字段，并从 Rust 侧启动 persistent plugin host。

尚未完成、因此禁止过度宣称的部分：

- `apps/cli/src/runtime.ts` 仍直接组装 Anthropic、builtin tools、Memory tools、Skill、Subagent 和 ContextPolicy；它们还不是统一的 capability bundles。
- v1 `ToolSpec` 没有逐调用 `permissionSpec`；生产 adapter 当前为插件工具填入空权限，这是 P0。
- Linux backend 仍 `--ro-bind / /`；任何声明 read roots 的最小权限语义会被整个 host root 的只读可见性破坏。
- 非空 network allowlist 在 Linux 只导致“不 unshare network”，插件进程会获得普通 host network；目标架构不延续 direct egress，而是让 plugin host 永久物理断网并统一走 K0 HTTP broker。
- sandbox tier 与 resource fields 还没有逐 feature、逐平台证明真实强制；“字段被校验”不能等同于“OS 已执行限制”。
- 安装/升级确认界面没有展示 fs/net/env/bash/Memory/resource/`minSandboxFeatures` 等完整 effective permission。
- 历史 v1 local install 曾在 production verifier/integrity 未接线时写 `enabled:true` 并可被 `loadEnabled()` activation；P0-00 已在 `33e5ce5` 删除 legacy authority/host execution bypass并把 production manager/runtime 变成 deny-only（独立 review 0 Critical / 0 Important）。这只是 containment，不是“已有安全 catalog”；CAT + ABI-RUNTIME 显式 reopen 前 install/activation 保持 unavailable。
- Windows backend 当前明确不支持 persistent plugin host；在完成同等级 P0 证据前必须显示 `unavailable`，不能从普通 exec sandbox 的 partial tier 推导 plugin host support。
- 没有 Capability Manifest/ABI v2、统一 bundle evidence、rollback-resistant catalog 或 K3 Self-Development promotion。
- §18 的 production orchestrator、independent acceptance、human receipt 与 promotion 尚未交付。

在最后一项 migration gate 关闭前，只能说“正在建设 Rust-enforced plugin runtime”，不能无条件使用“Rust-enforced”“plugin-native”或“everything is plugin”；在 K3 human gate 关闭前，不能说“self-evolving”或“可开启自进化”。

### 19.3 K0–K3 origin class 与生命周期分离

`originClass` 与 `trustDomain` 由受信 catalog/bundle binding 根据 producer、signer 和 policy 分配，**不能由插件 manifest 自我声明**，且一经绑定不可修改。`LifecycleState` 是另一条独立轴；install/adopt/enable 不能把 K3 改写为 K2，也不能抹掉 Self-Development provenance。

| Origin class | 名称 | 不可变来源 | 执行与变更规则 |
|---|---|---|---|
| **K0** | Trusted Kernel / TCB | Rust sandbox 与 launcher、permission/policy evaluator、canonicalizer/verifier、identity/trust registry、catalog reducer/journal、Agent/control-plane reducer、human approval 与 promotion worker | 非插件、不可运行时覆盖；只能走普通人工治理的 release 流程，Self-Development v1 永久禁止修改 |
| **K1** | Built-in Signed Capability | 官方 Provider、内置 Tool、Prompt/Hook、Memory、Skill、Subagent、Context/Eval adapter | 与 K2/K3 使用同一 ABI 和 permission path；由发行 trust root 签名。可获得的 capability 仍受 K0 ceiling 限制 |
| **K2** | External / Manually Authored Capability | 用户从受信 source 安装或本地人工导入的第三方/本地 bundle | 默认 disabled；代码仅经 Rust plugin host 运行。安装、升级与 enable 分离，permission/evidence digest 变化必须重批 |
| **K3** | Self-Developed Capability | §18 Developer 产出的 sealed candidate capability bundle及其所有后继 catalog records | staging sandbox、无 secrets、物理断网、不可读个人 Memory；adoption/enable 后仍是 K3，并永久保留 run/base/candidate/acceptance/human provenance |

K1 是分发来源上的“first party”，不是安全上的“无限权限”。K2/K3 不能注册或替换 K0 namespace；K1 也不能把 K0 policy 暴露为 contribution。跨 trust domain 采用 bundle 时必须创建引用原 binding 的新 `CatalogAdoptionBinding`，并用独立的 `targetInstallationDomain` 表示采用目标；原 `originClass`、原 `trustDomain` 和 provenance 仍保留，禁止 in-place rewrite 或把目标安装域冒充成来源 trust domain。

### 19.4 永久架构不变量

1. **Kernel exception**：K0 永不作为 plugin contribution 加载；不存在 `sandbox.override`、`permission.override`、`verifier.override`、`approval.override` 或等价 capability。
2. **One launch path**：任何 executable capability 只能通过受信 Rust launcher 进入；生产环境禁止 direct `import()`、`fork()`、`spawn()` 或备用 host loader。
3. **No silent widening**：effective permission 是 K0 ceiling、base policy、catalog approval、manifest envelope 与由 K0 data-only template interpreter 派生的 per-call request 的交集；任一解析/归一化/求交失败都 deny。
4. **No plugin-decided permission**：缺失 data-only per-call permission template 不是“无权限”，而是 ABI error。插件代码不得执行 permission function、返回 permission intent 或在 permission decision 前运行；只有显式 `effects: []` 的纯计算 contribution 才可得到空 spec。
5. **Truthful sandbox**：tier 是已验证 feature 的结果，不是平台名或 backend 名。请求的 feature 未强制时必须降低 tier 或拒绝启动。
6. **Data-only control plane**：manifest、registration、permission template、evidence、approval 与 lifecycle event 都是 strict-schema、bounded、canonical data；插件文本始终标为 untrusted。
7. **Closed-role detached DAG**：ArtifactRef 的 `mediaRole/schemaRole` 都来自 closed enum，并按 source/build inputs → payload-only FileManifest → Manifest → BundleBinding → signatures → output attestations → approval/completion → Catalog events 单向流动；unknown role、unknown upstream ref、逆向 ref 或任何自引用一律拒绝。
8. **Disabled by default**：install、catalog promotion 与 enable 是三个独立 transition；无 auto-enable、无 approval inheritance。
9. **Revocation wins**：revoked signer/bundle/capability 在下一次 activation 和每次 privileged broker call 前重查；离线无法证明 freshness 时按 policy fail closed。
10. **SelfDev cannot rewrite the referee**：K3 不能修改 K0、K1、trusted suites、holdout、catalog/trust store、CI/release 或自己的 approval path。
11. **Mandatory gates stay K0**：security hooks、secret guard、builtin payload gate、permission/verdict reducer 与 untrusted-content wrapper 不能以 plugin contribution 表达；插件 hook 只能 observation/transform，且必须在 K0 gates 之后、受其结果约束。
12. **Origin is immutable**：`originClass`、`trustDomain` 与 provenance 永不因 lifecycle transition 改写；`LifecycleState` 只能通过 catalog reducer 追加事件推进。

### 19.5 P0：先让安全声明变成事实

ARCH 冻结边界后，**PK-P0-0 已作为第一个 runtime mutation在 `33e5ce5` 关闭 legacy production activation**；这个 deny-only fence不依赖 Manifest v2 或 detached DAG，并继续保持。随后 ABI-00 冻结 data contract，再关闭 PK-P0-1…7。任一未关闭，Catalog 之后的 runtime/activation 只能做 schema/fixture，不能把插件系统标为 production-ready。

| P0 | 当前断层 | 强制决策 | 最低 acceptance evidence |
|---|---|---|---|
| **PK-P0-0 Legacy activation containment** | 历史 production verifier/integrity 未接线且 install→enabled→load 可达；`33e5ce5` 已以 deny-only manager/runtime 删除该 authority path | **CLOSED / fence remains**：production legacy install/activation unavailable，旧 enabled records 只作 disabled projection；重新开放仍依赖 sealed CEB→CAB、CAT verifier、default-disabled adoption 与独立 enable receipt | 独立 final review 0 Critical / 0 Important；production command/startup activation=0，fence closed + malformed payload先返回 typed admission error且 payload read/parse/fetch=0，伪造 registry/local swap/缺 integrity/旧 enabled record 全 deny；无可发布 test authority/host harness |
| **PK-P0-1 Fixed HostBootstrapProfile** | Linux backend 使用 `--ro-bind / /`，plugin profile 还会直接挂 workspace/read roots | 长驻 host 从 empty root 构造固定 profile：只见 content-addressed runtime closure、bundle RO、private data/scratch 与单一 IPC；固定 `net=false`，不挂 workspace、用户 home 或任意 manifest fs roots | direct open 任何 workspace/home/credential/Git config/相邻 bundle/system path 均失败；runtime/bundle/data/scratch/IPC 正向用例通过；broad root fallback=0 |
| **PK-P0-2 Physical no-network + Rust-owned OS brokers** | 非空 allowlist 会让 Linux/macOS plugin process 获得宽网络，TS effect 也不能证明 OS 边界 | 所有长驻 plugin host 物理断网；workspace fs、HTTP 与 process 的 v1 broker 由 Rust 验证 exact token/target 并直接执行 OS effect。HTTP 只解析/pin exact scheme+host+port+path/query；process target必须复制 BuildInputSet exact `ExecutableBindingV1`，Rust no-follow重建 closure path并 identity-pin executable，禁止 PATH/host fallback。V1 的 3xx 结束当前 effect，follow 必须 fresh invocation/decision/grant，不存在逐 hop沿用旧授权；不设计 direct endpoint egress | plugin socket/connect/DNS/proxy env 永远失败；TS/plugin 不能持有可直接 I/O 的 fd/socket/child handle；broker allow target 成功，邻接 path/port/IP、redirect、DNS rebinding、metadata、credential forwarding、executable logicalId/target/toolchain/path/digest/size/mode substitution与 symlink/TOCTOU 全 deny |
| **PK-P0-3 Truthful tier + persistent platform support** | Linux 可报告 `full` 但 seccomp 尚未集成；普通 exec probe 会掩盖 Windows persistent host 实际未实现 | tier 按 persistent-host required features 计算；Manifest `minSandboxFeatures` 必须是 current persistent probe verified feature set 的子集，tier只由该结果派生而非 Manifest声明。Windows 若进入支持矩阵必须先交付同等级 persistent host；此前明确 `pluginHost=unavailable` 并 fail closed | per-platform persistent probe golden/fault injection；缺一个 required feature 即 downgrade/deny；Windows 不得从普通 exec partial tier 推导 activation |
| **PK-P0-4 Hard resources + Rust second validation** | fields/TS profile 有校验，但 OS enforcement 与 trust handoff 不完整 | Rust 对 ActivationToken、InvocationGrant、BrokerCallToken、HostBootstrapProfile、BundleBinding/FileManifest、policy/catalog epoch、origin/trust domain、lifecycle/revocation、budget/expiry/typed nonce 全部二次验证，再强制 wall/CPU/RSS/PIDs/FD/output/RPC/process-tree kill/reap | token/grant/profile/bundle/epoch/budget/revocation 任一篡改或 stale 均在 spawn/dispatch/effect 前拒绝；fork/native allocation/CPU/FD/output/RPC flood/timeout/crash/cancel 后无 orphan |
| **PK-P0-5 Injective SafeDisplay** | approval 只显示 `permissions.volund`，完整请求可能含 secret/控制字符/歧义路径 | 永不展示 raw secret或bearer handle；只显示decision-scoped alias、scope、kind与安全 fingerprint。所有 decision-relevant 非秘密字段使用injective length/escape encoding完整展示；若无法区分则只能deny | collision/control-char/bidi/Unicode/path/host/secret corpus；不同 permission digest必须有不同SafeDisplay或deny-only；日志/snapshot/evidence raw secret=0 |
| **PK-P0-6 Two-layer invocation/effect authorization** | plugin `ToolSpec` 无逐调用 spec，adapter 使用 `() => ({})`，单个宽 token 会把“允许调用 handler”误当成“允许任意 effect” | K0 在插件代码运行前用冻结 data-only template 产生 PermissionSpec；requested/effective effectId set必须 exact equality，只有每个 effect的 bounds/budget可收窄，V1无 optional/drop effect。PermissionSpec只含 secret operand binding id，不含 mapping/SafeDisplay back-reference；获批后由 Rust-backed K0 issuer 签 upper-bound `InvocationGrant` 才 dispatch handler。每个具体 broker request再签 exact-target、single-use `BrokerCallToken`；UI只凭 exact challenge subject+verified lineage在 token消费后由K0派生 display，UI result不能授权其他 effect | grant 前本次 handler/permission callback invoke=0（长驻 host 可仅 bootstrap 存活）；effect drop/add、grant widening、mapping/display backedge、UI subject/result复用、broker sibling target/op、token replay/race/revocation/budget 全 deny；相同输入结果可复现 |
| **PK-P0-7 Mandatory security gates stay K0** | “hooks plugin 化”容易把 secret/payload/verdict guard 一并变成可替换 extension | mandatory security hook、secret guard、builtin payload gate、permission/verdict reducer 与 untrusted wrapper 固定为 K0，先于 plugin observation/transform hook，且后者不能改变 hard deny | disable/reorder/name collision/priority spoof/timeout/crash/oversize/rewrite corpus；K0 deny 时 plugin hook、permission prompt、broker/handler invoke 全为 0 |

执行顺序固定为 `ARCH → PK-P0-0 kill switch → ABI-00 contract → PK-P0-1…7 → CAT core → ABI runtime`。`HostBootstrapProfile` 的 runtime closure 必须是 per-target、content-addressed、可审计的最小集合；为了兼容动态库而重新挂载整个 `/` 不算修复。Workspace fs、network、process 与 Memory 能力全部是逐调用 broker operation，不是长驻 host mount/capability。

### 19.6 Capability Manifest / ABI v2

#### 19.6.1 Manifest envelope

Artifact role 必须先于字段 schema 冻结。ABI-00 的 byte-level canonical JSON、domain preimage/digest/signature、closed media/schema pair、精确字段/基数、size/closure limit、authority envelope 与 TS/Rust corpus 以 [§19a Capability Contract V1](./19a-capability-contract.md) 为规范性权威；本节只保留架构摘要。

`ArtifactRefV1` 固定包含 `{ version, digestAlgorithm, digest, size, mediaRole, schemaRole }`；`mediaRole`、`schemaRole` 及合法 pair 都是 closed enum。v1 不存在 generic/unknown/extension fallback：unknown/illegal pair、错误具名字段、缺失/重复/超额 ref、rank 不下降、direct/indirect/self cycle、逆向 ref，或无法完整重读并复算的 closure 一律拒绝。

```text
SourceInputSet + BuildInputSet
  → trusted build produces payload bytes
  → payload-only FileManifestPayload
  → ManifestPayload
  → BundleBindingPayload
  → detached SignatureEnvelope(s)
  → EvidenceSet + ProvenanceAttestation + SbomAttestation
  → signed CatalogVerificationEndorsement
  → CatalogEvidenceBinding
  → PromotionApprovalReceipt → Catalog/Git receipts → SelfDevCompletionReceipt
  → CatalogAdoptionBinding → AdoptionApprovalReceipt → EnableApprovalReceipt
  → Catalog lifecycle events
```

closed artifact schema roles 恰为 source/build/FileManifest/Manifest/BundleBinding/Signature、三种 output attestation、CatalogVerificationEndorsement、CatalogEvidenceBinding、四种 promotion receipt、CatalogAdoptionBinding、adoption/enable approval receipt 与 Catalog event 的 §19a V1 role。closed media roles 恰为 `canonical-json`、`signature-envelope`、`attestation`、`endorsement`、`receipt`、`catalog-event`，pair allowlist 也完全关闭。Raw file digest、external source identity、canonical payload digest 是不同 nominal type。

| Node / role | 允许的 upstream ArtifactRef | 明确排除 |
|---|---|---|
| `SourceInputSetV1` / `BuildInputSetV1` | 无 ArtifactRef；只列 bounded external source/base/recipe/toolchain/runtime digests；K3 Source冻结 exact Git baseRef/base object，BuildInputSet内嵌 per-target runtime closure并列 exact `ExecutableBindingV1(logicalId,target,toolchain,path,digest,size,executable-mode)` | 任何 plugin output ref、自身 ref、floating source identity、PATH/host executable fallback |
| `FileManifestPayloadV1` | **无 ArtifactRef**；只含 sorted `path/type/modeClass/size/contentDigest` payload entries，entrypoint 必须在内 | manifest、binding、signature、provenance、SBOM、evidence、approval/effect/completion receipt、Catalog metadata/event，以及自身 digest/ArtifactRef |
| `ManifestPayloadV2` | `fileManifestRef` exactly 1；每个 contribution 内嵌 canonical input schema、output schema、permission template 的完整 bytes/role/size/digest | source/build/binding/signature/attestation/receipt/Catalog ref、自身 ref、origin/trust/lifecycle；subdocument 不得改用 ArtifactRef |
| `BundleBindingPayloadV1` | exact source/build input set、FileManifest、Manifest refs；producer/publisher assertion、K0-assigned immutable origin/trust、binding epoch/domain | signature、provenance、SBOM、evidence、receipt、Catalog metadata/event、自身 ref |
| `SignatureEnvelopeV1` | exactly one `bundle-binding-payload.v1` digest，且只签 domain-separated binding bytes | mutable inline payload、attestation/receipt/Catalog ref、自身 terminal digest |
| `EvidenceSetV1` / `ProvenanceAttestationV1` / `SbomAttestationV1` | exact signed BundleBinding + same ordered 1..16 signatures；Provenance 另精确引用 source/build/FileManifest，SBOM 另精确引用 FileManifest | mixed closure、未签 binding、approval/completion/Catalog ref、自身 ref；这些 output attestations 不得回填 BundleBinding |
| `CatalogVerificationEndorsementV1` | exact binding/signatures/Evidence/Provenance/SBOM；purpose-scoped K0 signer另覆盖 verification context、§18 全部 performed/designated participant roles/purpose/session/context与 issuer-authenticated stable principal/credential commitments、independent acceptance/isolation、limitations/rollback；K3 先内嵌唯一 plan | publisher signature冒充 output verification、self-asserted pass/clean、遗漏 designated role、用 reissued id/null key掩盖 same-principal、cross-role reviewer、future CEB/receipt/event ref |
| `CatalogEvidenceBindingV1` | exact binding + same signatures + Evidence/Provenance/SBOM + signed endorsement 各 1；K3 逐字复用 endorsement 中无 back-reference 的 frozen `SelfDevPromotionPlan` container | 缺/混合 endorsement、approval/effect/completion/Catalog ref、自身 ref；K1/K2 不得携带 SelfDev plan |
| promotion approval/effect/completion receipts | PromotionApproval→CEB；Stage/Git→同 CEB+approval；Completion→同 CEB+approval+Stage+Git | cross-binding、未来/逆向 event、自身 ref；promotion approval 不得用于 adoption/enable |
| `CatalogAdoptionBindingV1` + adoption/enable receipts | CAB→CEB；K3 另→Completion；CAB 显式增加 `targetInstallationDomain` 且保留原 origin/source trust；AdoptionApproval→CAB；EnableApproval→CAB+AdoptionApproval，并计 current head 内 conditional CAB/CEB refs与 HostBootstrapProfile 内 exact BuildInputSet/Binding/FileManifest refs | in-place trust rewrite、K3 缺 Completion、K1/K2 携 Completion、复用 promotion approval、漏算或替换 embedded/head ref |
| `CatalogEventV1` | exact CEB 与 transition 所需 CAB/AdoptionApproval/EnableApproval refs，以及 expected head/result projection内 §19a closed conditional refs | 未绑定 evidence、未知 receipt、任何漏计 nested occurrence、逆向或自引用 |

Source/build inputs 到 payload files 的边是受信 builder 的 consume/produce relation；为保持 FileManifest payload-only，它不把 source/build refs 塞进 FileManifest。FileManifest 最多 65,536 个 regular files，禁止 symlink/hardlink/device/FIFO/socket。`BundleBindingPayloadV1` 是第一个同时绑定 input sets 与 outputs 的 node。各 payload 使用独立 raw-byte domain；ArtifactRef/content digest 一律在被引用 bytes 外计算。Verifier 必须按 §19a 的 strict canonical re-encode、role rank + visiting set、具名基数、global 64 MiB/100k lookup limits、journal predecessor depth≤32与每个 event/root artifact+authority+trust depth≤32逐层验证；journal checkpoint anchor计 depth0、first post-checkpoint event计 depth1，不能只相信最外层 digest 字符串或错误地把两种 depth相加。

#### 19.6.2 Contribution ABI

每个 contribution registration 必须与 Manifest 中下列 exact closed fields一致，不能增加旧 registration-only 摘要或 flags：

- `version=1`、`contributionId`、closed `kind`、`activationScope`、`resourceClass`、exact `concurrency`、sorted `effectsDeclared` 与 literal `resultTrust="untrusted"`。
- 完整 embedded input/output schema 与 data-only permission template containers；registration只引用/重读 Manifest 已冻结 bytes，不能另带 `bundleBindingPayloadDigest`、`catalogEvidenceBindingDigest`、`deterministic/idempotent` 或其他 unknown field。
- Bundle/CEB/activation lineage由受信 host context提供并在 grant中绑定，不让 plugin registration自报。

ABI v2 不允许传递函数、prototype、Node handle 或任意 host object。Permission template 在 activation 前由 K0 从 ManifestPayload 冻结；runtime registration 只能引用其 digest，不能新增、替换或扩大它。跨边界只传 bounded NDJSON frames 或后续经 ADR 批准的等价 typed transport；每帧、每 turn、每 capability 都有 byte/call/deadline quota。

Input/output schema 与 permission template 不是外部 ArtifactRef，而是 Manifest 内的 `EmbeddedCanonicalV1`：完整 canonical bytes、role、size、domain digest 必须同时存在并可重算。Pure computation 也必须内嵌 `effects:[]` template；缺失 template 是 ABI error，不是 implicit empty permission。字段 grammar、256 KiB/64 KiB subdocument limits 与 private package/import fence 见 [§19a](./19a-capability-contract.md)。

#### 19.6.3 Tool 的逐调用协议

Tool invocation 的固定顺序是：

1. K0 以冻结的 input schema 校验并 canonicalize model input。长驻 plugin host 可以只以固定 HostBootstrapProfile bootstrap 存活，但**本次 invocation 的 handler 尚未 dispatch**。
2. TS K0 使用冻结的 data-only template grammar 解释 canonical input，产生 `PermissionSpec`；不存在 plugin callback/`permissionSpec(input)` executable hook。到本步结束，本次 handler 与 permission callback invocation count 必须都是 0。
3. TS K0 以 protected effective-policy snapshot执行 requested→effective meet：requested/effective effectId set exact equality，per-effect target/secret operand不变，只有 bounds/budget/allow-list可收窄；任一 effect denied时整次 invocation deny，V1没有 optional/drop effect。PermissionSpec只含 secret operand binding id，不能回指 mapping/SafeDisplay。K0归一化 exact path/HTTP authority+path/query/operation/header/body/secret operand；需要人工确认时生成 injective SafeDisplay，再签 single-use `InvocationDecisionProof`。Caller boolean或显示文本不是 authority；任何 raw secret、ambiguous handle或授权歧义都 deny-only。
4. 获批后，Rust-backed K0 authorization issuer重读 decision proof与 fresh protected input/template/spec/display/policy/principal refs，并生成签名、短期、single-invocation 的 `InvocationGrant`。它绑定 activation context、CEB/CAB/heads/epochs、deadline与总 budget，只是 handler可提出 effect request的**上限**，本身不能执行 effect。
5. Rust 验证 InvocationGrant 与 current activation/revocation/budget 后，才把 canonical input 与 grant id dispatch 给 handler。Handler 返回的每个 broker request 都是不可信候选 request，不能直接执行。
6. 每个具体 broker request 先由 TS 编排层预检，再由 Rust authorization service按 §19a closed target/request variants重新 canonicalize，并验证 operation、exact target（含 HTTP path/query/exact non-auth headers，process exact ExecutableBinding，UI exact challenge subject）、content/secret operand、amount与resource相对 InvocationGrant是 equal-or-narrower、non-widening subset。通过后由 Rust签发绑定 protected target/request refs的 single-use `BrokerCallToken`；sibling path/host/port/op/header/handle/executable/UI subject、扩大 budget、换 invocation或重放都拒绝。UI display只在 token验证后由K0从 verified lineage派生，result不能授权其他 effect。V1 redirect不自动 follow；必须新 invocation/decision/grant。
7. Workspace fs、HTTP、process 等 OS effect 由 Rust-owned broker 再验 grant/token/current policy/catalog epoch/revocation/budget，并在同一受控路径直接执行；Memory/UI 等 TS-owned logical effect 按 §19.6.4 原子消费 Rust-issued token 后才能执行。
8. Broker 结果经过 size/schema/secret/untrusted-content gate 后返回 handler；handler 最终结果再经同样的 K0 gate 回到 Agent loop。

同一 input/template/policy snapshot 的 permission derivation 必须可复现。依赖时间、随机数、可变网络或插件私有状态的 template/result 视为 invalid 并拒绝，而不是交给插件“解释”。Persistent host 的“已启动”不等于本次 handler 已获授权；测试必须分别计数 host bootstrap、invocation dispatch、handler call、permission callback 与 broker effect。

#### 19.6.4 Privileged brokers

Provider credential、HTTP fetch、filesystem read/write、process execution、Memory read/write、UI confirmation 和 secret handle 只能经 K0 broker。Plugin host 的物理网络恒为 off；即使 manifest 声明 network，也只能请求 HTTP broker。插件永远拿不到原始 credential；签名类 Provider 只得到 scoped signing result 或短生命周期 opaque handle。

v1 对 OS effect 选择 **Rust-owned broker direct execution**：workspace filesystem、HTTP/DNS/TLS/redirect 与 child process 的 canonicalization、grant/token 验证、budget reservation、OS call、handle ownership、kill/reap 和 result bounding 都在 Rust enforcement plane 内完成。Process launcher必须从 verified BuildInputSet重建 exact ExecutableBinding，以 no-follow traversal打开 runtime-closure relative path并在执行前后验证 regular-file identity/digest/size/executable mode，禁止 PATH、host binary、symlink/reparse或 TOCTOU fallback。TS 只编排 request/result，不拿 fd、socket、可复用 filesystem capability 或 child handle，也不能把一个 TS “allow” 结果当执行证明。未来若改为 Rust 创建不可伪造的 scoped OS capability，必须另立 ADR 与同等级 P0 evidence；它不是 v1 fallback。

Memory、UI confirmation 等仍由 TS service 实现的 logical effect，必须使用 Rust-issued、exact-target、single-use token。Protected ledger closed outcome是 `RESERVED→CONSUMED→SUCCEEDED|FAILED_DETERMINISTIC|AMBIGUOUS`，仅`AMBIGUOUS`可经purpose-signed exact record进入`RECONCILED_NOT_OCCURRED|RECONCILED_OCCURRED_EXACT` audit终态；这些状态都不恢复旧执行authority。Ledger绑定 invocation/effect/idempotency key/request/result并在消费时重查 replay、expiry、policy/catalog epoch、revocation与 budget；CAS输家、stale token或 target不一致一律不执行。可权威查询/事务化的 effect只能在证明exact result后reconcile；HTTP/process outcome不明必须AMBIGUOUS。Ordinary invocation分支原子关闭/revoke effect、Grant、Invocation与Activation contexts；没有SelfDev run/reservation字段。Promotion分支另把exact PROMOTING run转terminal `FAILED/recovery_failed`并阻塞reservation。Per-effect signed reconciliation不能单独release parent；只有穷举全部sibling terminal proofs的signed lineage release才可清coordination gate，old authority永不恢复。Fresh human-started lineage必须绑定exact reconciled dependency；`PROVEN_OCCURRED_EXACT`的same HTTP/process semantic operation V1永久deny，不能靠ack重放。

### 19.7 Rust sandbox contract

Rust enforcement plane 是目标 product identity 的安全核心，但“用 Rust 写”本身不是安全证明。

#### 19.7.1 固定 `HostBootstrapProfileV1`

长驻 plugin host 不按 manifest 动态扩大物理 sandbox。所有 K1/K2/K3 executable capability 使用同一固定上界：

- `net=false`；没有 direct DNS/socket/connect，网络能力只经 HTTP broker。
- read-only：content-addressed runtime closure（含逐文件登记的 loader/dynamic libraries）与 sealed bundle；不存在额外 broad system closure。
- writable：per-bundle private data、per-activation scratch；二者不能包含 workspace symlink/bind。
- IPC：唯一受信 bridge fd/handle；stdout/stderr 只是 bounded diagnostics，不是 control protocol。
- env：固定最小 locale/runtime keys，不继承 `HOME`、proxy、credential、shell init 或完整 `PATH`。
- 不挂 workspace、用户 home、Memory store、credential store、Git config 或 manifest 声明的 fs roots。

Workspace fs、HTTP、process、Memory、credential 与 privileged UI 均是 broker operation。Manifest permission envelope 只决定 broker 可申请的上限，不改变 HostBootstrapProfile。

#### 19.7.2 Rust 的强制二次验证

TS K0 只能编排 candidate plan/request；Rust 在 spawn 前必须重新读取/验证：

1. domain-separated、短期、single-use `ActivationToken` 的 issuer/signature/`ActivationNonceV1`/expiry。
2. closed-role artifact DAG、BundleBinding/CatalogEvidenceBinding closure、全部 FileManifest bytes/digests、entrypoint 与实际 bundle files。
3. immutable `originClass`/`trustDomain`、Catalog head/`LifecycleState=ENABLED`、exact CatalogAdoptionBinding + AdoptionApprovalReceipt + EnableApprovalReceipt、policy epoch 与 current revocation。
4. exact HostBootstrapProfile、runtime closure/backend/probe digest；profile 必须等于或严格窄于固定模板，不能只信 TS 的 subset assertion。
5. wall/CPU/RSS/PID/FD/output/RPC budgets 和 remaining counters。

每次 invocation dispatch 前，Rust 还必须验证 `InvocationGrant` 的 issuer/signature、input/template/permission/CatalogEvidenceBinding digests、activation lineage、deadline、policy/catalog epoch、revocation 与总 budget；未通过不得给长驻 host 发送本次 handler frame。每次 privileged broker call 再验证 grant lineage 与 exact `BrokerCallToken`、operation/target、remaining budget，并原子消费 token。验证结果不一致、store 无法证明 freshness、sibling request 或 token replay 一律拒绝。

每个 platform persistent-host backend 必须输出 feature attestation，至少覆盖：

- minimal mount/filesystem visibility、symlink/canonical path handling、private data/scratch。
- plugin physical no-network，以及 Rust-owned HTTP/workspace-fs/process broker 的 direct execution evidence；不以 direct endpoint egress 或 TS-only allow decision 计入能力。
- process tree、syscall/seccomp/seatbelt/AppContainer 等平台强制机制。
- env clearing、inherited handle/fd、stdio/RPC channel 和 credential isolation。
- CPU/wall/RSS/PID/FD/output limits，以及 kill/reap/cancel semantics。
- backend/runtime closure/bundle digests、tier、known limitations 和测试矩阵 digest。

Windows 当前 persistent plugin host 未实现，因此状态必须是 `unavailable`；只有交付固定 bootstrap、IPC、physical no-network、resource、token/revocation 与 escape evidence 后才能加入支持矩阵。

`SandboxTier` 是这些 persistent-host feature 的 policy projection。UI 可以显示简化 tier，但 evidence 必须保留逐 feature 结果。任何 plugin activation 都绑定 probe snapshot digest，运行中 backend 消失、probe/policy/catalog epoch 变化或 revocation 必须终止/隔离，不得切换到 unsandboxed mode。在这些门禁完成前，品牌句中的 “Rust-enforced boundaries” 是 **target positioning**，不是 shipped claim。

### 19.8 Bundle、Evidence 与 Catalog lifecycle

#### 19.8.1 Bundle evidence

一个可进入 catalog 的 bundle 至少绑定：

- source/build input sets，以及 payload-only FileManifestPayload → ManifestPayload → BundleBindingPayload → detached signatures 的 closed-role closure；逐层可复算且无自引用。
- signatures 之后生成的 EvidenceSet、provenance 与 SBOM output attestations；它们引用 signed binding，绝不回填或改变已签 BundleBinding。
- K0 Catalog verifier用 distinct purpose-scoped key签 `CatalogVerificationEndorsement`，覆盖 exact output refs、可信 builder/runner/SBOM/reviewer identities、independent acceptance/isolation、known limitations与 rollback；publisher signature本身不证明 tests pass或 SBOM clean。
- 把 signed binding、全部 required output attestations与 exact signed endorsement冻结在一个 `CatalogEvidenceBinding`；publisher/producer identity、source/base SHA、build recipe/environment bytes都能沿该 binding向上追溯。
- 从 Manifest 内嵌 permission template/resource/`minSandboxFeatures` bytes确定性重建的 `catalog-permission-projection.v1` 与 `sandbox-feature-requirements.v1`。Approval 时的 candidate/current diff只由这两组 exact verified projection按 registry固定算法即时派生并进入 SafeDisplay decision entries；V1 没有独立 diff role/digest，禁止把“typed diff”或裸摘要当 authority。
- static validation、unit/integration、sandbox escape、platform matrix、deterministic baseline/candidate suites。
- independent acceptance report、known limitations、revocation/rollback target。
- K3 先把 §18 run、sealed candidate、VerificationBundle replacement、participant identities与无 back-reference的唯一 frozen SelfDevPromotionPlan纳入 signed endorsement；CatalogEvidenceBinding随后逐字复用 plan并引用 endorsement。`PromotionApprovalReceipt` **只批准这个下游 binding**，不直接批准 raw bundle、plan或零散 evidence，也不能复用于 adoption/enable。

日志路径或 stdout 文本不是 evidence；evidence 是有 closed role 的 content-addressed artifact，并由 CatalogEvidenceBinding 指向。Promotion/Adoption/Enable/Completion receipts 与后续 Catalog lifecycle events 只能向上引用对应 CEB/CAB，不能反向进入 bundle payload。

#### 19.8.2 Catalog state machine

`CapabilityCatalog` 的 activation lifecycle 使用 append-only、CAS/fencing、rollback-resistant journal。K3 promotion 使用一个线性一致、serializable 的 `PromotionCoordinationStore`：Catalog-owned reservation namespace 与 SelfDev run/receipt namespace 必须处于**同一事务域**，不是两个 eventually-consistent stores。`STAGE_PENDING` 是 effect-preparation record，**不是 Catalog lifecycle event，也不是 activation state**。核心关系为：

```text
Catalog lifecycle: DISCOVERED → BUNDLE_VERIFIED → APPROVAL_REQUIRED
→ INSTALLED_DISABLED → ENABLED
ENABLED → DISABLED
* → QUARANTINED → REMOVED
* → REVOKED

K3 SelfDev store: CANDIDATE_SEALED → VERIFIED → ACCEPTED
→ HUMAN_APPROVED → PROMOTING

PromotionCoordinationStore / Catalog-owned reservation namespace:
NO_ACTIVE → STAGE_PENDING(capabilityId, capabilityRevision, reservationId, fence, planDigest, expiresAt)

anchored run-transition protocol:
primary PREPARED lock → independent AnchorStore OPEN
→ ANCHORED(event+checkpoint+anchor+final receipt/envelope) | CANCELLED
→ idempotent primary FINALIZED {
    run=COMPLETED, reservation=RELEASED_COMPLETED,
    activeReservation=null }

read-only pure projection, no write/event:
STAGED_DISABLED := immutable RELEASED_COMPLETED history + matching SelfDevCompletionReceipt

adoption after projection:
STAGED_DISABLED → Catalog APPROVAL_REQUIRED event
→ INSTALLED_DISABLED → ENABLED   (独立 adoption 与独立 enable)
```

上图是用户可见 phase 投影，不是一个会被新候选覆盖的单 `capabilityHead`。Reducer物理上维护三条 nominal CAS stream：`CandidateHead(capabilityId,candidateId)` 跟踪 bundle/CEB verification并含 monotonic `capabilityRevision`，`InstallationRecordHead(capabilityId,targetInstallationDomain,CAB)` 跟踪每个已采用版本，`ActivationSlotHead(capabilityId,targetInstallationDomain)` 只指向 current enabled CAB或 empty；三类 projection/head/event/receipt延续 exact attempt revision。Per-capability allocator只在 `DISCOVERED` 或 explicit new restore attempt以 CAS 分配 initial 1 / checked high-watermark+1，之后 plan、reservation、receipts和该 attempt events只能复制该值，reservation不得再次分配“next”；allocation本身不代表 verified/installed/active。Initial `INSTALLED_DISABLED→ENABLED`复用 adoption attempt revision，任何 `DISABLED→ENABLED` re-enable/rollback先分配 fresh larger revision并签新 EnableApproval，历史 AdoptionApproval只作 same-CAB immutable provenance。该值是 Catalog fencing counter，**不同于** content `candidateRevision` 与 Manifest canonical SemVer。发现/验证 v2不改变 active v1；enable transaction只比较/更新相关 InstallationRecordHead + ActivationSlotHead，CandidateHead保持不变，把旧 record置 DISABLED、新 record置 ENABLED并原子切 slot。Activation同样不绑定 CandidateHead。CatalogEvent只携 expected prior heads与 desired result projections（无 new event digest）；event canonicalize/sign/append后 reducer才用其 digest派生 materialized heads，禁止 self-digest。

规则：

- `originClass`、`trustDomain`、producer/provenance 在 binding 后不可修改；Catalog `LifecycleState` 与 SelfDev/reservation state 分离。K3 adoption 后仍是 K3。
- install 只写 immutable bundle store 与 disabled catalog record；activation 不属于同一 transaction。CAT core 之前 legacy production activation 保持禁用。
- promotion approval 只绑定 exact CatalogEvidenceBinding 及其 permission-template/tier/SafeDisplay projection，升级不能沿用旧 receipt；K3 promotion approval 不能指向 raw BundleBinding 或零散 evidence。AdoptionApprovalReceipt 只绑定保留 source trust 且新增 target installation domain 的 exact CatalogAdoptionBinding；EnableApprovalReceipt 是之后独立的 recent-human decision。
- staging reservation 以 `capabilityId` 为 active-pointer互斥键并带 monotonic `capabilityRevision/fence`；create CAS必须证明 pointer为空、revision与已由 allocator 分配的 exact CandidateHead/plan/approval attempt field-equal，且严格大于 last completed/superseded attempt，不得在此二次取 `max+1`。同 plan/idempotency key 可重读，另一个 bundle/plan 占用、revision冲突或 fence失效是 deterministic `promotion_conflict`，不能无限 reconcile。无关 capability 的 Catalog event 不得制造伪冲突；global policy/trust/revocation epoch 变化按安全 stale 规则另行拒绝。
- reservation bounded lease的`expiresAt` exact等于四个已持久签名时间戳的minimum：Catalog/Git effect-plan lease deadlines、PromotionApproval expiry、Endorsement expiry；issue-time policy只限制approval lifetime并绑定policyEpoch，不是第五个deadline。Stage/Git receipts携带四source+derived output，worker不得延长/替换。
- Approval、consumption、Completion与expiry run transition都先在PromotionCoordinationStore写durable PREPARED lock，再由独立monotonic AnchorStore以trusted commit time做OPEN→ANCHORED|CANCELLED；ANCHORED原子持久event/checkpoint/anchor及durable K0 final receipt envelope，是logical commit。Primary随后幂等FINALIZED，把run/receipt/reservation/pointer发布到consistent snapshot；gap内所有reader必须先resolve PREPARED，不能消费旧head或用eventual not-found。
- 没有CompletionReceipt的expired reservation只可在non-AMBIGUOUS、`trustedNow>expiresAt`且全effect ledger线性一致absence proof成立时anchored转run `FAILED/recovery_failed`、reservation `SUPERSEDED_EXPIRED`并清pointer。AMBIGUOUS不走TTL；signed external reconciliation + all-sibling aggregate release后只清coordination state，FAILED run不再变化。
- `STAGED_DISABLED` 只能由 reader在同一 consistent snapshot中，对 immutable `RELEASED_COMPLETED` reservation history与 matching SelfDevCompletionReceipt纯计算得出；CompletionReceipt已绑定 CatalogStageReceipt，禁止为该投影追加第三个 Catalog write/event。
- `STAGED_DISABLED→APPROVAL_REQUIRED` 是 completion 后的首个 adoption Catalog event，不能把 SelfDev promotion approval 当 adoption/enable receipt。
- enable 是单独的 recent-human decision；`STAGED_DISABLED` 不能被 Self-Development 自己 adopt 或 enable。
- activation 前重验 catalog head、revocation、bundle bytes、durable enable-event provenance、current CEB authority expiry与 current probe；已消费human receipt按event-time历史验证，其自然TTL过去不成为runtime lease。任一current authority不一致进入 quarantine。
- Manifest `capabilityVersion`使用§19a `CanonicalSemVerV1`和跨TS/Rust exact comparator；numeric identifier按digit length+lex比较，build metadata不进入precedence。Global immutable content index固定`(capabilityId,full version)→BundleBinding`，跨installation domain同version换Binding也冲突；per-target watermark只由successful normal-upgrade推进。
- CEB/CAB是同content的monotonic `authorityGeneration`，允许endorsement expiry后同Binding/version重新verification→fresh CEB/CAB generation，但不能in-place续签。Enable human authority绑定expected activation-history subject、old/new generation与derived mode：normal-upgrade、reenable、rollback或authority-refresh。Restore只选曾successful ENABLED且current-live generation；expired generation必须fresh adoption/enable。Rollback不降watermark，never-enabled stale INSTALLED_DISABLED不能伪装restore。

### 19.9 Self-Development v1 重定向

§18 的状态机、独立验收、evidence 和 human gate 继续有效，但 v1 的**候选对象和 promotion 目标被本节收窄**：

1. Developer 只能创建/修改 policy 明确允许的 K3 capability bundle；不能提交通用 repository refactor。
2. K0、K1、trust/catalog store、trusted suites/holdout、CI/release、品牌/identity migration 与 §18 自身控制面永久 protected。
3. Developer 使用 isolated worktree 和 K3 staging sandbox；默认 `net=false`、无 secrets、无个人/项目 Memory、无任意 plugin/Skill、无通用 Bash。
4. baseline 与 candidate 使用同一 base-owned suite definition、runtime closure 和 sandbox feature snapshot。
5. sealed bundle 经过 deterministic verification、holdout、sandbox escape matrix和独立 Reviewer，先生成 signed CatalogVerificationEndorsement，再生成下游 CatalogEvidenceBinding；K3 `PromotionApprovalReceipt`只指向该 binding，模型 recommendation仍只是 advisory。
6. Promotion approval 后，流水线执行绑定同一 PromotionPlan 的 Catalog reservation/stage 与 Git promotion 两个幂等 effect；只有两个 receipts 都验证通过，才可进入§19a primary PREPARED→independent AnchorStore ANCHORED→primary FINALIZED 的 Completion protocol，最终发布 anchored CompletionReceipt + `COMPLETED`，且任何中间态不可 activation。
7. 最终 `STAGED_DISABLED` 只是 immutable `RELEASED_COMPLETED` reservation history + SelfDevCompletionReceipt 的只读纯投影，不触发第三次 Catalog 写；`originClass=K3` 与 SelfDev provenance 永久保留。它不能 install-as-enabled、adopt、enable、push、merge、tag、publish 或部署。
8. `STAGED_DISABLED→APPROVAL_REQUIRED→INSTALLED_DISABLED` adoption，以及之后 `ENABLED`，是流水线外两个独立人工 gate。

这使“自我开发”首先成为“安全地产生候选能力”，而不是“让程序修改自己的安全内核”。

#### 19.9.1 Git + Catalog 双 effect 与恢复

在 verification/human prompt 前，K0必须冻结唯一 `SelfDevPromotionPlan`，其中内嵌 exact `CatalogStageEffectPlan` 与 `GitPromotionEffectPlan` canonical bytes/role/size/domain digest；plan绑定 run、exact Git `baseRef` + namespace=`git-object` base object、candidate、capability-scoped revision、global policy/trust/revocation epochs、effect id/idempotency key/write intent/lease deadline，但**不含 Endorsement、CatalogEvidenceBinding、自身或未来 approval 的 back-reference**。SourceInputSet/VerificationBundle/plan/two effects/Git verifyBase/ref + baseSha/parent必须分别 byte-equal。Signed CatalogVerificationEndorsement先内嵌该 plan、§18 verification context和完整 performed/designated participant roles（稳定 principal/credential commitments防 reissued-id/null-key绕过），CatalogEvidenceBinding随后逐字复用同一 container；`PromotionApprovalReceipt`只引用 CEB。执行器必须同时验证 endorsement/CEB plan、approval与运行时输入完全一致：

1. Approval-consumption以exact APPROVED run head、single-use consumer permit/RunWorkerFence、approval、allocation和active pointer写PREPARED，并在锁定per-capability fence allocator时预留exact next `CapabilityReservationFenceV1`但不发布；ANCHORED/FINALIZED唯一winner才原子推进allocator、创建`CapabilityStageReservation{capabilityRevision,reservationId,capabilityReservationFence,planDigest,state=STAGE_PENDING,expiresAt}`并run→PROMOTING。Revision逐字段复用DISCOVERED allocation，reservation不二次取next；expiry是四signed sources的minimum。Stage/Git execution permit/receipt同时绑定capability fence与各自leaseId/RunWorkerFence并在effect前后重验。Catalog stage不写lifecycle event。
2. Git effect 必须携带匹配的 reservation id/fence/deadline，使用 §18 typed ref transaction 创建获批 local branch/commit，产出绑定 plan/CatalogEvidenceBinding/approval和相同 expiry的 `GitPromotionReceipt`。相同 idempotency key + target 只能依据 authoritative transaction state补记已证明结果；branch/ref 已被不同 target 占用是 deterministic conflict。
3. 两个receipts到齐后，completion-worker用exact PROMOTING permit授权TransitionIntent；primary PREPARED锁run/reservation/pointer/receipts，AnchorStore在trustedNow不晚于effective deadline时物化run event→checkpoint→anchor→SelfDevCompletionReceipt并由独立durable transition-finalizer签envelope，OPEN→ANCHORED。Primary即使随后过期也只能复制exact outcome并FINALIZED `run=COMPLETED,reservation=RELEASED_COMPLETED,pointer=null`；finalizer不得冒充human/worker，worker死亡/key rotation不能让ANCHORED outcome不可恢复。Immutable history保留。
4. Catalog reader 从该 store 的同一 consistent snapshot 以 `RELEASED_COMPLETED history + matching SelfDevCompletionReceipt` 纯计算 `STAGED_DISABLED`；没有第三个 promotion write/event。Activation/adoption guard 每次重算该投影；仅凭 branch、pending reservation、CatalogStageReceipt 或 PromotionApprovalReceipt 均拒绝。
5. Crash/unknown只用原idempotency key查询authoritative state；证明exact success才补receipt，证明未发生且operation transactional/queryable才在live permit下继续。仍不明则promotion branch原子terminal-marker并anchored转old run `FAILED/recovery_failed`、reservation `AMBIGUOUS_BLOCKED`；它永不恢复。Per-effect purpose-signed reconciliation只能更新该ledger，全部plan effect terminal proofs的signed aggregate release才可清pointer且不改FAILED run；new run必须human-started并绑定reconciled dependency。Deterministic plan/revision/fence/ref/receipt conflict则`FAILED/promotion_conflict`，不得无限reconcile。

Fault matrix覆盖PREPARED/OPEN/checkpoint/ANCHORED/FINALIZED每个crash/response-lost boundary、cancel-vs-late-anchor、key loss/rotate/revoke、worker lease steal、effect前后fence、四个deadline source分别minimum、exact/one-over、completion-vs-expiry、AMBIGUOUS-vs-child-issue、one sibling reconciled/one unresolved及late outcome-vs-release。断言一个logical winner、old head不可消费、所有中间态activation=0、同key不重复side effect、deadline不扩展，cross-store not-found拒绝。

### 19.10 Migration 与兼容规则

- v1 manifest/bridge 只保留为 legacy compatibility input，adapter 必须标为 `legacy-partial`，不能伪装为 ABI v2。ARCH 后第一个 runtime change 就启用独立 kill switch；这个关闭动作不解析 ABI v2/DAG，CAT core 之前 production install/activation 整体禁用。
- 重新开放必须等 CAT core；legacy bundle 也必须先转成 closed-role DAG + CatalogEvidenceBinding、默认 disabled、经 production registry verifier 和独立 adoption/enable receipts。无法生成 K0 data-only per-call template 与 two-layer grants 的 legacy tool 永久 disabled。
- composition root 在 migration 期间可以保留显式 K1 legacy adapter，但必须登记 capability inventory、owner、target wave 和删除 gate。
- mandatory security hook、secret/payload guard 和 verdict reducer 留在 K0；migration 只移动 observational/transform hooks。
- 最终 architecture test 只允许 composition root 注册 K0 bootstrap 与 catalog loader；直接 `registry.register(builtin)`、直接 new concrete Provider/Memory/Skill/Subagent contribution 都应成为 CI failure。
- 迁移不要求在同一提交完成；每一 wave 完成后必须执行 ITERATE，按新发现重写后一 wave，而不是机械照搬初版计划。

### 19.11 发布门禁与诚实状态

品牌 identity migration 后，`BRAND-VERIFY` 必须在 branded **exact SHA**重新运行 ABI-00 bootstrap meta-schema/registry digest与 generator lock、generated TS/Rust validators + 全部 golden/reject/large-recipe corpus、`ContractStrictPureEd25519V1` dependency/feature lock，以及 capability-contract export/packlist/dependency/import/behavioral signing fence；同时重跑 SD0、P0-00…03、CAT-01/02、platform/docs/config/event gates。所有 evidence/artifacts/reviewer signatures绑定该 branded SHA；pre-brand通过记录不能平移。此硬门关闭前 ABI runtime production wiring不得开始。

只有同时满足以下条件，才可在 release notes 使用“plugin-native”：

- PK-P0 八项关闭，目标平台 persistent-host feature/tier 与 attack evidence same-SHA；未交付的 Windows persistent host 明确 unavailable。
- Manifest/ABI v2、closed-role artifact verifier、CatalogEvidenceBinding、catalog lifecycle 和 signature/revocation production composition 已连接。
- 每个已启用 executable capability 都经 Rust launch path；Rust 已二次验证 activation/invocation/broker tokens、profile/bundle/evidence binding、policy/catalog epoch/budget/revocation，并直接执行 workspace-fs/HTTP/process OS effects；无 direct import/spawn/network/I/O bypass。
- 目标 capability inventory 100% 分类为 K0/K1/K2/K3，未分类为 0。
- 所有 extensible surfaces 已迁移或在 capability matrix 明确标为 unavailable；不能用“legacy hardwired”冒充完成。

只有 K3 全链、独立验收、human receipt、`STAGED_DISABLED` promotion 和人工 adoption 演示通过，才可说“supports controlled self-development”。即使如此，也不能说“autonomous self-evolution”，因为 enable/release 仍由人控制。

### 19.12 品牌语义（不在此冻结名称）

品牌需要同时表达三个事实：

1. **AI capability**：智能由可组合能力提供，不绑定单一模型。
2. **Safety boundary**：能力在明确边界内运行，不能绕过 kernel。
3. **Rust enforcement**：Rust 是目标 enforcement plane；只有实际由 Rust 强制的 sandbox、bundle/token、workspace-fs/HTTP/process/resource/revocation 边界和 platform evidence 完成后才是可发布事实，不是装饰性“安全感”。Memory/UI 等 TS effect 只能描述为 “Rust-authorized + TS effect semantics”，除非未来也交付端到端 Rust enforcement evidence。

建议的**目标** category line：

> **A plugin-native AI capability runtime with Rust-enforced boundaries.**

建议的**目标**产品承诺：

> **Pluggable intelligence. Rust-enforced boundaries.**

视觉隐喻应是“稳定边界 + 可替换 capability cells/ports”：一个不可变的极简外框或核心，容纳少量可组合模块。避免通用盾牌、锁、机器人脑、Rust 齿轮和复杂电路。Logo 必须在 16px、单色、终端 ASCII/Unicode mark 与 app icon 中保持同一轮廓。

在 legal/domain/registry clearance 全部关闭前：

- 当前文档统一使用 **Volund CLI**、`volund`、`volund-cli` 与 `@volund/*`；legacy `volund`/`volund-code` 只在兼容说明中出现。
- 新 manifest schema 使用品牌无关字段和 namespace，避免下一次品牌迁移改变 evidence digest 语义。
- 不把 “secure” 当绝对保证；对外声明必须附 supported platform/tier 和 known limitations。

### 19.13 交叉引用与权威性

- §4 定义 Tool/Permission 的通用接口；冲突时，本节的逐调用、无 implicit permission 和 P0 gate 更严格。
- §5 与 SANDBOX-COMPAT 定义 platform backend；本节补充 fixed bootstrap、physical no-network、Rust-owned OS brokers、two-layer grants、resource/Rust second validation 与 truthful persistent-host tier 的 release gate。
- §6a/§6b 描述当前 v1 plugin surfaces；Capability ABI v2 以本节为架构权威，legacy 只作迁移输入。
- [§19a Capability Contract V1](./19a-capability-contract.md) 是 ABI-00 的 byte-level 权威：single registry、canonical/domain/strict signature、closed role/cardinality、signed output endorsement、embedded schemas/唯一 K3 plan、CEB/CAB/三流 Catalog heads/receipts、protected authority lineage/carriers、limits与 cross-language corpus以该附录为准。
- §15 仍只负责白名单参数 tuning，不能创建 bundle 或 catalog event。
- [§21](./21-dynamic-reflection.md) 定义动态反思：K1 builtin bundle 只经 §19.1.1 公开 surface 组合而成（subagent-profile 受控 dispatch、hook 触发、prompt-source 注入、memory-adapter 提升、command、ui-surface），是"everything extensible is a plugin"的第一个 K1 级自证用例；其运行所需的 `volund.agents.run` / `volund.jobs.schedule` / `volund.ui.status.registerSection` v1 bridge 扩展见 §6.4.1a，内核保留职责以 §19.1.1 为准。
- §18 负责 Self-Development control plane；本节负责候选 capability 类型、K3 限制和 `STAGED_DISABLED` 终点。实施阶段中 CAT-02 只交付 transaction/storage/verifier primitives与fixtures，SDP-03才是这些 primitives 的首个 production SelfDev wiring；两者不得重复宣称 Completion/reservation/run 协议所有权。
- 实施顺序与 phase gate 见 [Plugin Kernel 实施计划](../../plans/2026-08-20-plugin-kernel-implementation.md)。

---

## 变更日志

| 日期 | 变更 |
|---|---|
| 2026-08-23 | §19.1.1 surface 表登记 §21 动态反思（subagent-profile 受控 dispatch 含 per-session 预算硬顶、ui-surface 含 `/status` section）；§19.13 增加 §21 交叉引用 |
| 2026-08-21 | ABI-00 review draft：§19a增加 single machine registry、strict crypto、signed output endorsement、唯一 K3 plan、multiline/secret carriers、protected decision/authority refs、三流 Catalog heads、exact broker/Git contracts与可构造 limits/corpus；P0-00仍关闭 |
| 2026-08-21 | FIX2：关闭 UI/mapping backedge；冻结完整 K3 identity commitments、ExecutableBinding/process identity、exact effect set、AMBIGUOUS terminal、Git base equality、monotonic capabilityRevision/release/SemVer、双 traversal depth与 branded exact-SHA reverify |
| 2026-08-20 | FIX1：修正 detached digest DAG、legacy activation、fixed no-network host、K0/Rust 双平面、immutable origin/lifecycle、双 effect promotion、阶段顺序与品牌 claim gate |
| 2026-08-20 | PHASE RE-PLAN：新增 Everything Extensible Is a Plugin、K0–K3、真实 P0、Capability ABI v2、bundle/evidence/catalog、K3 Self-Development 与品牌语义 |
