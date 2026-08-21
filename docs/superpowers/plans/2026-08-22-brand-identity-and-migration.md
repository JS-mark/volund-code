# Brand Identity & Migration Plan

> **状态**：`BRAND-DISCOVERY`；品牌约束与 target positioning 草案已收敛，最终名称与 identity tuple 尚未冻结，生产资产尚未迁移。
>
> **更新时间**：2026-08-22（Asia/Shanghai）
>
> **用途**：记录品牌决策、视觉方向、声明边界、仓库迁移面与验收门。本文不授权全局替换 `Apollo`，也不把目标安全能力描述成已交付事实。

> **Canonical identity: `UNDECIDED`.** `Apollo Code` remains a migration placeholder. No historical candidate is approved for production use.

## 1. 为什么现在仍然看到 Apollo

当前仓库没有完成品牌迁移。现有 `Apollo Code` 名称、`apollo` CLI、`@apollo-code/*` package scope、`~/.apollo`、环境变量、文档域名和 V14 `AC` Logo 仍是当前实现身份。

2026-08-22 的只读盘点（排除 `.git`、`node_modules`、`dist`）发现约 3,336 个 Apollo 字面量分布在 332 个文件；29 个 `package.json` 都含旧身份。当前也不存在 canonical brand source of truth：`apps/cli/src/shared/app-identity.ts` 只提供 build/version 信息，没有统一管理 display name、slug、CLI、scope、home/env、repo、plugin 或 wire compatibility policy。

视觉上同时存在三套旧 Apollo 资产：TUI 的 AC + orbit、官网的 lime `A`、README 的 A + orbit + gradient。它们都不是新品牌方案。

原因不是品牌工作被取消，而是品牌决策经历了命名否决和语义升级：

1. 用户先要求“AI + 安全 + 极简”，并在当轮候选中选择了 **`Cereward AI`**。
2. 该名称随后触发先前 clearance 否决门，被明确停止落库；它是**曾由用户选中、但已撤回的候选**，不得恢复为 production identity。
3. 用户又增加更重要的产品原则：**Everything is Plugin + Sandbox + Rust**。
4. 该新增原则进一步改变了品牌的产品含义：品牌不能只表达“被保护的 AI 核心”，还必须表达“可替换能力、不可替换可信边界、唯一受控 effect port”。
5. 因而最终名称必须围绕完整的新语义重新设计和清查。

在最终 identity tuple 冻结前，继续使用 `Apollo Code` placeholder 是有意的安全和兼容措施。不得把历史 wire/event/error/schema/security 标识随品牌一起粗暴替换。

## 2. 决策状态

### 2.1 用户要求、架构约束与设计提案

| 项目 | 来源/状态 |
|---|---|
| AI + 安全 + 极简 | 用户明确要求 |
| Everything is Plugin + Sandbox + Rust | 用户明确要求；必须按下方 K0 安全限定解释 |
| 受控、自测、自验收、人工确认的 AI 自我改进 | 用户目标 + §18 安全边界；禁止宣传 autonomous self-evolution |
| `Everything extensible is a capability plugin; the K0 security kernel is not.` | §19 冻结架构原则 |
| 可替换 capability plugins + 可信控制面 + Rust enforcement plane | §19 目标架构；未交付部分不是 shipped claim |
| 极简几何、黑白优先、最多一个信号色 | 品牌设计提案；待用户视觉确认 |
| capability cell + sandbox/K0 boundary + logical controlled port | Logo 工作方向；待用户视觉确认 |
| 避免盾牌、锁、机器人脑、Rust 齿轮、复杂电路、紫蓝 AI 渐变 | 品牌设计提案；待用户视觉确认 |
| 16px、单色、终端 mark、app icon 保持同一轮廓 | 生产资产验收约束；尚未生成成品 |
| 分阶段 identity map + 兼容层；禁止全局 search-replace | 工程/安全迁移约束 |

这里的 **K0 security kernel** 是非穷尽集合：至少包括 sandbox/reference monitor、permission/policy、identity/trust registry、canonical/signature verifier、Catalog reducer/journal、mandatory security hooks/secret guard、核心 state/promotion invariants 与 human gates。新增可信裁判默认属于 K0，不能因为未列名就插件化。

### 2.2 已撤回或被后续输入推翻

| 旧决策 | 当前处理 |
|---|---|
| `Cereward AI` | 用户曾选择，但先前 clearance gate 随后否决并停止落库；`WITHDRAWN / DO NOT USE` |
| `Evalistry` | 从未得到用户确认；用户随后明确要求“名字不好，重新设计”；`REJECTED` |
| `Rigorbind` | 从未得到用户确认，且先前 clearance gate 淘汰；`CLEARANCE-REJECTED / DO NOT USE` |
| “中央绿色 AI 方块 + 开放保护边界” | 保留几何减法思路，但将含义升级为 capability cell + trusted boundary + controlled port |
| `Secure AI Evolution` | 不作为最终 category line；过于宽泛，也容易把尚未交付的安全能力说成绝对保证 |
| “围绕不可变核心的演化环” | 不再作为主 Logo；可降级为 Self-Development 功能的 secondary motion/glyph |

### 2.3 尚未确认

- 最终 display name / short name；
- machine slug；
- canonical CLI 名称与 `apollo` alias 周期；
- npm root name / package scope；
- home directory / env prefix；
- repo slug / docs origin / domain；
- native bundle、release artifact 与 signing identifiers；
- trademark、company/common-use、domain、GitHub/npm/PyPI/crates/Homebrew/Winget 的实时清查结果；
- wordmark 字体与最终信号色精确值。

## 3. 品牌战略

### 3.1 品牌命题

目标产品不是“会任意重写自己的 AI”，而是让 AI 能力在可验证、可撤销、可人工确认的边界中演进。当前实现只能称为 functional self-owned Agent Harness foundation，尚不是完整的 plugin-native、Rust-enforced 或 self-developing Harness。

品牌要同时讲清三层：

1. **AI Self-Evolution**：通过证据闭环改进能力；
2. **Everything Extensible Is a Plugin**：可演进部分被收敛为 capability plugin；
3. **Sandbox + Rust Enforcement**：插件不能修改自己的裁判，真实 effect 经过可信边界和受控 broker。

### 3.2 信息层级

在相应发布门关闭后，建议使用以下信息结构：

| 层级 | 建议文案 | 用途 |
|---|---|---|
| Brand thesis | **AI evolves. Boundaries hold.** | 品牌核心句 |
| Product promise | **Pluggable intelligence. Enforced boundaries.** | 首页/README 简短承诺 |
| Target category | **A plugin-native AI capability runtime with Rust-enforced boundaries.** | 技术定位；只有下方 §3.2 claim matrix 的对应门逐项关闭后才可作为 shipped claim |
| Self-development feature | **Improve by evidence. Advance by approval.** | 自我开发功能页 |
| Architecture principle | **Everything extensible is a plugin. The K0 security kernel is not.** | 架构文档 |
| 中文核心句 | **智能持续演进，边界始终成立。** | 中文品牌表达 |

“Secure”“Safe”“Rust-enforced”“plugin-native”“self-evolving”都不是装饰词。每个词必须受对应 exact-SHA 证据和支持平台限制；门未关闭时使用 `designed for`、`target` 或 `foundation`，不能当作已交付事实。

声明门必须逐项关闭：

| Claim | 最低发布门 |
|---|---|
| `plugin-native` | MIG-04 capability inventory/migration 完成，未分类和 legacy hardwired 冒充项为 0 |
| `Rust-enforced boundaries` | branded same-SHA、逐平台、逐 effect surface 的 Rust enforcement evidence；Memory/UI 只能按事实写 `Rust-authorized + TS effect semantics`，除非未来也完成端到端 Rust enforcement |
| `controlled self-development` | §18/§19 的完整 K3 候选、独立验收、human receipt、`STAGED_DISABLED` promotion 与人工 adoption/enable 链通过 |
| `autonomous self-evolution` | 禁止使用；系统不自动 adoption、enable、merge、publish 或 deploy |

### 3.3 品牌性格

- precise：讲具体边界和证据，不作绝对安全承诺；
- calm：不使用危险感、黑客感或廉价霓虹制造可信度；
- modular：界面和视觉体现 capability 可替换，但不碎片化；
- controlled：所有“前进”动作都经过明确的 port/gate；
- builder-native：在 CLI、terminal、docs 和 evidence UI 中同样成立。

## 4. 命名设计约束

最终名称应满足：

- 5–10 个拉丁字母优先，2–3 音节，易读、易拼、终端中清晰；
- 能承载“智能 + 可信边界/受控演进”，但不直接拼接 `SafeAI`、`GuardAI`；
- 不依赖 `AI`、`Agent`、`Code` 才能成立；这些只作为 descriptor；
- 不把 Rust 写进主名称；Rust 是可信实现证据，不是品牌吉祥物；
- 避免只像安全公司、模型公司、评测平台或普通 IDE；
- 能形成不依赖首字母的几何 mark；
- machine slug、CLI、scope、domain 和主要 registry 有可接受的迁移/占用风险；
- 完成商标与普通使用清查后才进入 `BRAND-FREEZE`。

明确不再复用的低质量候选：`Permrun`、`Cratrun`、`Briklet`。

历史候选 `Evalistry`、`Evidfold`、`Rigilume`、`Rigorbind` 只保留为研究记录，不代表当前 shortlist。`Cereward AI` 虽有用户选择历史，但已被 clearance gate 撤回。`Cereward AI`、`Evalistry`、`Rigorbind` 均不得进入下一轮 shortlist。

## 5. Logo 系统

### 5.1 主符号：Controlled Port

`Controlled Port` 是当前最符合架构的**工作方向**，不是已经过用户视觉验收的最终 Logo。

主 Logo 只使用三个几何事实：

```text
┌─────────┐
│   ■     ├─
└─────────┘
```

- **连续外边界**：trusted kernel / sandbox；不可由插件替换；
- **内部 cell**：AI capability plugin；可安装、验证、撤销、替换；
- **逻辑受控端口**：一个不可绕过的 K0 authority chokepoint；workspace-fs/HTTP/process 等已证明的 OS effects 分发到 typed Rust-owned brokers；Memory/UI 等非 Rust-owned surfaces 只能按 claim matrix 描述为 `Rust-authorized + TS effect semantics`；它不是一个物理 API；
- **留白**：能力与边界之间不是装饰间距，而是 authority separation。

这不是盾牌或锁。它表达的是：系统允许能力变化，但变化不能改写边界；所有受管 effect 都必须经过同一个逻辑 K0 authority chokepoint，但只有通过逐平台、逐 surface 证据的 OS effect 才能称为 Rust-owned/Rust-enforced。普通 invocation 的 authority 来自已验证 policy/token；human gate 只用于协议规定的批准、高风险授权、adoption、enable、promotion 等动作，不代表每一次 broker 调用都需要人工点击。

### 5.2 Secondary glyph：Proof Ratchet

Self-Development / Evolution Loop 可使用独立的功能 glyph 或 motion：candidate 只有在 evidence 到达、verifier 通过、human gate 打开后才前进一格。它不能替代主 Logo，也不能暗示自动启用、自动合并或自动发布。

### 5.3 视觉规范

- 主 Logo：纯黑/纯白优先；
- 唯一品牌信号色提案：**Gate Amber**，只标识 gated transition / logical chokepoint；它本身不表示 verified、approved、safe 或 success，精确色值在用户选择与对比度测试后冻结；
- success、warning、danger 等产品状态色不属于 Logo palette；
- 不使用渐变、发光、玻璃、3D、阴影或细密线条；
- 不在 mark 内放字母、盾牌、锁孔、脑、机器人、齿轮或 Rust 语言图标；
- mark 必须能输出：SVG、16/20/24/32px icon、favicon、macOS/Windows/Linux app icon、CLI Unicode、纯 ASCII fallback、单色印刷；
- 生产 SVG 必须是确定性几何资产，不直接采用生成式图片中的不可控路径。

### 5.4 最小验收

- 16px 下边界、cell、port 三层仍可辨；
- 黑底白标、白底黑标、单色打印均成立；
- 终端窄字符版本不依赖颜色；
- 与常见安全盾牌、容器立方体、芯片/电路和现有知名标志不存在高相似；
- wordmark 移除后，mark 仍能表达“replaceable unit inside enforced boundary”；
- Gate Amber 缺失时，授权端口仍由形状而不是颜色表达。

## 6. Identity tuple：品牌迁移前的人工硬门

以下十项必须作为一个版本化 artifact 一次冻结，不允许只选 display name 就开始散改：

| # | Identity field | 当前值 | 目标值 | 状态 |
|---|---|---|---|---|
| 1 | display name / short name | Apollo Code / Apollo | 待确认 | BLOCKED |
| 2 | machine slug | `apollo-code` | 待确认 | BLOCKED |
| 3 | canonical CLI | `apollo` | 待确认；同时定义 alias 周期 | BLOCKED |
| 4 | npm root / scope | `apollo-code`, `@apollo-code/*` | 待确认 | BLOCKED |
| 5 | home / env | `~/.apollo`, `APOLLO_*` | 待确认；同时冻结读取优先级和迁移规则 | BLOCKED |
| 6 | repo / docs origin | Apollo 相关路径与 URL | 待确认 | BLOCKED |
| 7 | native / release IDs | Apollo 相关标识 | 待确认 | BLOCKED |
| 8 | plugin namespace | legacy Apollo v1 + brand-neutral v2 target | v1 兼容 + v2 exact rule | BLOCKED |
| 9 | signing/security principal | 当前/待建 | brand-neutral 或新 namespace | BLOCKED |
| 10 | wire/event/error/schema IDs | 已存在 Apollo 与中性常量 | 列明永久冻结项；禁止自动替换 | BLOCKED |

冻结 artifact 至少包含：`schemaVersion`、十项映射、alias expiration policy、path precedence、telemetry namespace、signing principal、legacy compatibility、frozen protocol identifiers 与审核人。

## 7. 仓库迁移顺序

`BRAND-DISCOVERY` 可以与安全/ABI/Catalog 的只读工作并行；实际 identity migration 必须同时等待最终 identity clearance 与 `CAT-02` 关闭。不能因为品牌名已选就提前改变 production/package/security identity。

### BRAND-DISCOVERY · 当前阶段

- 冻结品牌命题、命名约束、Logo 语义和 claim gate；
- 对最终 shortlist 做实时 registry/domain/trademark/common-use 清查；
- 输出 2–3 个名称 + 同一 Controlled Port mark 的 wordmark 适配；
- 用户确认一个最终 identity。

本阶段不改 package、CLI、home、env、schema、signing 或 production Logo。

### BRAND-FREEZE · Identity ADR

- 生成唯一、版本化的 canonical identity artifact，例如 `brand/identity.v1.json`，再由确定性生成器投影到 TS、Rust、package、docs 和 release surface；具体路径在实现审查时冻结；
- artifact 包含完整 identity tuple、compatibility policy、frozen literal allowlist 与 owner，禁止继续散落手写新品牌常量；
- 用户/product/security 共同确认；
- 记录哪些 `Apollo` 是 display identity，哪些是兼容 API，哪些是历史证据，哪些永久不迁移；
- 为每个迁移 surface 建立 old → new 映射和 rollback rule。

### BRAND-ASSETS · 确定性资产

- 建立主 mark SVG、wordmark、favicon、app icons、CLI/ASCII mark、spacing/min-size/color tokens；
- 先替换可回滚的 display-only surface；
- 更新 §13 中旧的“太阳/神庙/宇航头盔、深蓝+太阳金”视觉方案；
- 做 snapshot、视觉、16px、单色、dark/light 和 docs build 验收。

### BRAND-MIGRATE-A · 用户可见身份

依赖：`BRAND-FREEZE`、identity clearance、`CAT-02`。后续 B/C 与 A 使用同一 versioned migration map。

- README、docs、onboarding、TUI welcome、help/version/about、release notes templates；
- canonical CLI 新名上线，`apollo` 保留明确期限的兼容 alias；
- 旧命令输出 deprecation，但不得破坏脚本的 exit code/JSON contract。

### BRAND-MIGRATE-B · 本地状态与包身份

- package root/scope、imports、lockfile、changesets、packlist；
- home dir/env/config 为每个 surface 冻结 explicit/default/legacy/conflict precedence matrix：新显式值最高；兼容期内显式 legacy 值不能被任何默认值静默盖掉；新旧显式值冲突必须诊断；credential/trust/signing store 禁止静默合并；每项记录 read/write 行为、移除版本、rollback 与测试；
- 迁移必须可重复、可恢复、保留备份与诊断，禁止 startup 静默破坏性 rewrite；
- plugin manifest v1 仅允许 parse、inspect、diagnose 和 migrate，P0 deny-only activation 永远不能因品牌兼容而重开；v2 采用 brand-neutral contract，不因改名改变 digest 语义。

### BRAND-MIGRATE-C · 外部与安全身份

- repo slug、docs origin/domain、native identifiers、release filenames、telemetry namespaces；
- signing principal、trust registry、SBOM/provenance、security policy 和 artifact URLs；
- legacy plugin 是否需要 re-sign/re-auth 必须显式判定，不能靠字符串兼容冒充同一 principal。

### BRAND-VERIFY · Branded exact-SHA 重验

- 在最终 branded exact SHA 重跑 SD0/P0/Catalog/ABI byte+crypto/package/docs/config/event gates；
- 重建 identity-bound artifacts、digests、SBOM/provenance 和 reviewer decisions；
- pre-brand evidence 保留为历史审计，但不能直接平移为 branded acceptance；
- product + security 重新签字后，才允许继续 ABI runtime production wiring 和 prerelease gate。

## 8. 当前仓库中的主要品牌触点

以下是迁移时必须显式处理的代表性入口，不是全局替换授权：

| Surface | 当前入口 | 处理原则 |
|---|---|---|
| TUI Logo | `packages/ui/src/components/welcome/ApolloLogo.tsx` | BRAND-ASSETS 后替换组件与 snapshots |
| Docs mark/favicon | `apps/docs/public/apollo-mark.svg`, `apps/docs/public/favicon.svg` | 与 deterministic SVG 同源生成 |
| README hero | `docs/assets/readme-hero.svg` | 移除旧 A/orbit/gradient，不在位图上二次描摹 |
| Docs 视觉规范 | `docs/superpowers/specs/2026-07-31-apollo-code-design/13-docs-site.md` | 废止 Apollo 太阳语义，改为新 identity system；同步实际 docs origin |
| Docs theme | `apps/docs/.vitepress/theme/custom.css` | token 化，不靠全局字符串替换 |
| CLI identity | `apps/cli/src/command.ts`, `apps/cli/package.json`, `apps/cli/rolldown.config.mjs` | 新 binary + compatibility alias + help/version/build contract |
| npm packages | root/package manifests、lockfile、changesets | 原子 scope map，验证 packlist/imports |
| Home/config/env | `apps/cli/src/runtime.ts`, `apps/cli/src/trust.ts`, `packages/native-bridge/src/resolver.ts` | 覆盖 `APOLLO_HOME`, `~/.apollo`, `.apollo/config.toml`, `APOLLO_BUILD_*`, `APOLLO_NATIVE_*` 等；明确 precedence、diagnostic、backup 和 rollback |
| Operational locks | `.apollolock`, `.apollo-tmp`, `.apolloignore` | 新旧客户端共存时锁必须共享，不能因改名造成并发写穿；ignore/temp 需显式迁移 |
| Plugin contracts | `packages/plugin-sdk`, `packages/plugin-runtime`, `crates/apollo-sandbox/src/plugin_host.mjs` | v1 `apollo-plugin-*`、`engines.apollo`、`permissions.apollo`、`apollo.` RPC 冻结；v2 brand-neutral + re-sign/re-auth |
| Evidence/protocol | `packages/shared/src/protocol.ts`, `packages/shared/src/error-codes.ts`, `packages/shared/src/events` | 逐项分类；历史与 v1 wire/event/error 常量禁止误改 |
| Persisted schemas | `packages/storage`, `packages/context`, `packages/plugin-runtime` | `apollo.memory.v1`、`apollo.memory.export.v1`、`apollo.semantic-index.v1`、`$apollo.bytes.v1` 按 v1 literal freeze |
| Native/release/signing | Rust crates/bins、`packages/native-bridge`, release scripts/workflows/evidence | 已发布 artifact/tag 不改；新品牌 parallel mapping，最后 same-SHA 重签/重验 |

## 9. 不可破坏的兼容不变量

- 已发布 artifact、tag、历史 session、evidence、digest 和 signature preimage 不做原地重写。
- Protocol v1、`APOLLO_*` wire error、事件字段 `apolloVersion`、现有 error registry 与上述 persisted schema literals 按精确字节冻结；新身份通过 v2、alias 或 migrator 引入。
- Legacy plugin v1 继续作为 disabled reader/migration input；不能把 `apollo-plugin-*`、`engines.apollo`、`permissions.apollo` 或 `apollo.` RPC 原地 search-replace 后冒充同一签名主体。
- Plugin v2/Catalog 采用 brand-neutral contract；迁移到新 identity 需要 re-sign、re-auth、重新 adoption/enable，且默认仍为 disabled。
- `APOLLO_HOME`、`~/.apollo` 与 `.apollo/config.toml` 的兼容读取必须有冻结 precedence；迁移保留备份、可重入、可诊断，不在 startup 静默删除旧状态。
- `.apollolock` 在新旧客户端并存期必须保持同一锁域；先改锁名会让两个版本并发写同一状态。
- 当前规范中的 `apollo-code.dev` 与实际 docs origin 不一致；迁移时以冻结后的 canonical identity artifact 为唯一来源，不复用任何一方作为隐含真值。
- 中文/英文 README 和 docs 中的安全、plugin availability 声明必须先按真实实现校准，再做品牌翻译；品牌迁移不能放大未交付能力。

## 10. 完成定义

品牌工作只有同时满足以下条件才算完成：

1. 用户确认最终名称和完整 identity tuple；
2. 实时 clearance 结果被记录，风险有明确 owner；
3. Logo/wordmark/CLI/app/docs 资产是确定性、可复现的 source assets；
4. 用户可见 surface 无非兼容性的 Apollo 残留；
5. 所有 legacy alias/path/env/plugin 行为有测试、期限和移除策略；
6. wire/event/error/schema/security 历史常量未被误迁移；
7. 新旧 package/CLI/config 的 clean-install 与 upgrade smoke 通过；
8. branded exact-SHA 的安全、ABI、Catalog、docs、release evidence 全部重建；
9. `plugin-native`、`Rust-enforced`、`controlled self-development` 等声明分别通过 §3.2 claim matrix 及 §18/§19 对应门禁；
10. product/security 人工验收通过后才进入 prerelease。

## 11. 下一次需要用户确认的内容

下一轮品牌确认应只做一个高价值决策：

> 从全新、独创、短名称出发，最终更偏“可信边界”还是更偏“受控演进”？

AI、plugin-native、sandbox 和 Rust enforcement 仍会写入 descriptor 与品牌证明，不要求四个概念都生硬塞进主名称。方向确定后，再提供不超过 3 个经过实时清查的全新名称候选；每个候选都使用同一套 Controlled Port 视觉语法，避免把“喜欢哪个 Logo”和“选择哪个产品身份”混成一个问题。

## Appendix A · Rejection ledger

此表只记录工程筛查和用户决策，不构成商标法律意见。旧轮外部搜索证据没有形成仓库内 canonical clearance artifact，因此不得把历史搜索结果当作当前可用性证明；新 shortlist 必须重新做带日期、查询范围、链接和 owner 的实时清查。

| 名称 | 时间/来源 | 结论 | 证据状态 |
|---|---|---|---|
| `Cereward AI` | 2026-08，用户选择后进入 prior clearance gate | 相邻名称/类别风险超过工程阈值；`WITHDRAWN / DO NOT USE` | 决策在任务历史；外部链接未落库，不作为当前法律证据 |
| `Evalistry` | 2026-08，命名探索 | 从未确认；用户后续要求“名字不好，重新设计”；`REJECTED` | 用户决策在任务历史 |
| `Rigorbind` | 2026-08，prior clearance gate | 相邻 `RIGOR` 权利风险；`CLEARANCE-REJECTED / DO NOT USE` | 决策在任务历史；外部链接未落库 |
| `Permrun` / `Cratrun` / `Briklet` | 2026-08，命名探索 | 工程代号感强、品牌质量不足；`REJECTED` | 设计筛选记录 |
