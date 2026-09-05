# Brand Identity & Migration Plan

> **状态**：`LOCAL BRAND MIGRATION COMPLETE / EXTERNAL CLEARANCE PENDING`；当前代码、协议、插件契约、TUI、README、docs、npm package graph、native bundle 与 repository/docs slug 均以 `Volund` 为唯一主身份；线上发布、registry、signing、域名和法律清查仍需外部门禁。
>
> **更新时间**：2026-08-28（Asia/Shanghai）
>
> **用途**：记录品牌决策、视觉方向、声明边界、仓库迁移面与验收门。未来再次更名必须经过新的版本化决策，不得把品牌替换和产品能力声明混为一谈。

> **Canonical identity: `Volund CLI` / `Volund`; command: `volund`; npm: `\@volund/cli` / `@volund/*`; repository/docs slug: `volund-code`.** Full legal and live-registry clearance remain open gates.

## 1. 当前品牌状态

当前仓库的用户可见名称、TUI/README/docs 视觉、CLI、npm package graph、home/env、插件契约、wire/schema、native/release 标识与 repository/docs deployment slug 均使用 Volund 命名。代码中出现的 `volund`、`VOLUND_*`、`~/.volund`、`\@volund/cli`、`@volund/*` 与 `volund-code` 都是当前 canonical identity，不是旧品牌残留。

`packages/shared/src/product-identity.ts` 是当前代码级品牌身份真值。生产视觉资产统一使用 **pixel hammer + terminal cutout** 系统，TUI、官网、README、favicon 与 `/volund-mark.svg` 使用同一视觉语言。

原因不是品牌工作被取消，而是品牌决策经历了命名否决和语义升级：

1. 用户先要求“AI + 安全 + 极简”，并在当轮候选中选择了 **`Cereward AI`**。
2. 该名称随后触发先前 clearance 否决门，被明确停止落库；它是**曾由用户选中、但已撤回的候选**，不得恢复为 production identity。
3. 用户又增加更重要的产品原则：**Everything is Plugin + Sandbox + Rust**。
4. 该新增原则进一步改变了品牌的产品含义：品牌不能只表达“被保护的 AI 核心”，还必须表达“可替换能力、不可替换可信边界、唯一受控 effect port”。
5. 因而最终名称必须围绕完整的新语义重新设计和清查。

用户已在 2026-08-27 明确授权开始替换品牌，随后要求继续迁移 npm 包和 docs；2026-08-28 又明确要求当前实现不得回退到旧品牌。因此 display identity、CLI、npm package graph、home/env、wire/schema、插件契约、native bundle 与 repository/docs slug 均以 Volund 为准。

## 2. 决策状态

### 2.1 用户要求、架构约束与设计提案

| 项目 | 来源/状态 |
|---|---|
| AI + 安全 + 极简 | 用户明确要求 |
| Everything is Plugin + Sandbox + Rust | 用户明确要求；必须按下方 K0 安全限定解释 |
| 受控、自测、自验收、人工确认的 AI 自我改进 | 用户目标 + §18 安全边界；禁止宣传 autonomous self-evolution |
| `Everything extensible is a capability plugin; the K0 security kernel is not.` | §19 冻结架构原则 |
| 可替换 capability plugins + 可信控制面 + Rust enforcement plane | §19 目标架构；未交付部分不是 shipped claim |
| 极简几何、黑白优先、最多一个信号色 | 已落实为 Forge Black + Forge Teal pixel hammer；用户确认 Logo OK |
| pixel hammer + terminal cutout + `>_` | 当前生产 Logo；用户确认 |
| 避免盾牌、锁、机器人脑、Rust 齿轮、复杂电路、紫蓝 AI 渐变 | 已落实到当前确定性 SVG 与 TUI Unicode mark |
| 16px、单色、终端 mark、app icon 保持同一轮廓 | Phase A 已覆盖 SVG、favicon、README hero 与 TUI mark；完整平台 app icon 套件仍属 Phase C |
| 分阶段 identity map + 兼容层；禁止全局 search-replace | 工程/安全迁移约束 |

这里的 **K0 security kernel** 是非穷尽集合：至少包括 sandbox/reference monitor、permission/policy、identity/trust registry、canonical/signature verifier、Catalog reducer/journal、mandatory security hooks/secret guard、核心 state/promotion invariants 与 human gates。新增可信裁判默认属于 K0，不能因为未列名就插件化。

### 2.2 已撤回或被后续输入推翻

| 旧决策 | 当前处理 |
|---|---|
| `Cereward AI` | 用户曾选择，但先前 clearance gate 随后否决并停止落库；`WITHDRAWN / DO NOT USE` |
| `Evalistry` | 从未得到用户确认；用户随后明确要求“名字不好，重新设计”；`REJECTED` |
| `Rigorbind` | 从未得到用户确认，且先前 clearance gate 淘汰；`CLEARANCE-REJECTED / DO NOT USE` |
| `Nomitera` / `Ordiflux` / `Tenitera` | 用户未接受；伪拉丁构词离 AI 产品心智过远；`REJECTED` |
| `Coldframe` / `Toolpost` / `Benchdog` | 用户要求“再换，要贴近 AI”；工程物件隐喻离 AI 主类别过远；`REJECTED` |
| “中央绿色 AI 方块 + 开放保护边界” | 与 `Controlled Port` 一并停止作为品牌主标志；只保留在历史研究记录中 |
| `Controlled Port` 主标志 | 用户未接受；架构表达准确但 AI 识别过弱；`REJECTED AS PRIMARY MARK` |
| `Secure AI Evolution` | 不作为最终 category line；过于宽泛，也容易把尚未交付的安全能力说成绝对保证 |
| “围绕不可变核心的演化环” | 不再作为主 Logo；可降级为 Self-Development 功能的 secondary motion/glyph |

### 2.3 已确认与仍开放的身份字段

已确认：

- display name / short name：`Volund CLI` / `Volund`；
- canonical CLI：`volund`；`volund` 在兼容窗口保留；
- canonical npm meta package：`\@volund/cli`；canonical workspace/platform scope：`@volund/*`；
- legacy npm compatibility：`volund-code` 作为生成的 meta shim，解析到相同 `@volund/<triple>` 平台包；
- repository/docs deployment slug：`volund-code`；GitHub repository 为 `JS-mark/volund-code`，VitePress base 为 `/volund-code/`；
- production visual mark：pixel hammer + terminal cutout + `>_`；
- signal color：当前 Phase A 使用 Forge Teal `#2BBD9B`。

仍开放：

- `volund` alias 的移除版本；
- npm registry owner / scope ownership 与首发 publish clearance；
- home directory / env prefix；
- 自定义 docs domain；
- native bundle、release artifact 与 signing identifiers；
- trademark、company/common-use、domain、GitHub/npm/PyPI/crates/Homebrew/Winget 的实时清查结果；
- wordmark 字体与最终信号色精确值。

## 3. 品牌战略

### 3.1 品牌命题

目标产品的第一身份是 **terminal-native AI coding CLI**：把 agentic coding loop 带到命令行，让开发者在终端中对话、修改代码、调用工具并接入自动化脚本。可见的 trust、permission、credential、sandbox state、可恢复文件修改和 machine-readable output 是它区别于普通 AI coding CLI 的可信特征，而不是替代 CLI 品类的另一套产品定位。

长期的 plugin-native、Rust-enforced 与 controlled self-development 是底层架构方向。当前实现只能称为 functional self-owned Agent Harness foundation，尚不是完整的 plugin-native、Rust-enforced 或 self-developing Harness；品牌不能把未来架构写成当前主品类，更不能让用户误以为这是独立的 AI governance 平台。

品牌要按以下顺序讲清三层：

1. **AI Coding CLI**：在 terminal 中完成 agentic coding loop，这是产品品类与第一认知；
2. **Visible, Recoverable Control**：trust、permission、sandbox、diff、receipt 与 machine-readable output 在 CLI 中可见且可恢复；
3. **Plugin + Enforcement Architecture**：可演进能力收敛为 capability plugin，插件不能修改自己的裁判，真实 effect 经过可信边界和受控 broker。

### 3.2 信息层级

在相应发布门关闭后，建议使用以下信息结构：

| 层级 | 建议文案 | 用途 |
|---|---|---|
| Brand thesis | **Reason in the terminal. Act within bounds.** | 品牌核心句；先表达 AI CLI，再表达可信差异 |
| Product promise | **An AI coding CLI with visible control.** | 首页/README 简短承诺 |
| Current category | **A terminal-native AI coding agent.** | 当前产品主品类；与 README 和实际交互入口一致 |
| Target architecture | **A plugin-native AI coding CLI with Rust-enforced boundaries.** | 长期技术定位；只有下方 §3.2 claim matrix 的对应门逐项关闭后才可作为 shipped claim |
| Self-development feature | **Improve by evidence. Advance by approval.** | 自我开发功能页 |
| Architecture principle | **Everything extensible is a plugin. The K0 security kernel is not.** | 架构文档 |
| 中文核心句 | **在终端中推理，在边界内行动。** | 中文品牌表达 |

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

### 4.1 2026-08-26 shortlist（已被用户否决）

本轮保持同一套 `Controlled Port` mark、相同 palette 和相同应用场景，只比较名称语义、读写感与 wordmark，不把三种不同 Logo 风格混入命名决策：

| 候选 | 构词与含义 | 当前判断 | Discovery board |
|---|---|---|---|
| **`Nomitera`** | `nomos`（规则/秩序）+ `iterare`（迭代） | `REJECTED`；构词需要解释，AI 类别感弱 | [`2026-08-26-nomitera-board.png`](../../assets/brand-discovery/2026-08-26-nomitera-board.png) |
| **`Ordiflux`** | `ordo`（秩序）+ `flux`（变化） | `REJECTED`；偏抽象基础设施，AI 类别感弱 | [`2026-08-26-ordiflux-board.png`](../../assets/brand-discovery/2026-08-26-ordiflux-board.png) |
| **`Tenitera`** | `tenet`（不变量/原则）+ `iterare`（迭代） | `REJECTED`；词源和读音成本高，AI 类别感弱 | [`2026-08-26-tenitera-board.png`](../../assets/brand-discovery/2026-08-26-tenitera-board.png) |

2026-08-26（Asia/Shanghai）的工程级实时初筛：

- 精确名称 + `software / AI / developer / company` 搜索未发现与三项直接重叠的相关产品；精确名称 + `trademark / trade mark` 搜索也未返回明显结果。
- GitHub user/org 查询对三项均未显示现有主体；`.dev` 与 `.ai` RDAP 查询均返回未找到。
- `.com` RDAP、npm/PyPI/crates 的直接查询在本轮受到连接重置/超时影响，状态仍是 **INCONCLUSIVE**，不得解读为可注册。
- 上述是命名工程初筛，不是法律意见；进入 `BRAND-FREEZE` 前仍须由 owner 完成中美欧商标、公司/普通使用、domain、GitHub/npm/PyPI/crates/Homebrew/Winget 的正式复核并保存原始证据。
- 三张 board 是生成式 discovery preview，不是生产 Logo；选择名称后仍要用确定性 SVG 重建 mark，并执行 16px、单色、相似性和 accessibility 验收。

Preview SHA-256：

- `Nomitera`: `888a7e6e33c0631dd04b10706ccacb1f48668f84dcd7b42643463595671709e9`
- `Ordiflux`: `e27511ded7bb51f8f6a62cc5e7c2832f28b187833b5e44dcc51d7d002baf12d5`
- `Tenitera`: `e3f9786c189081e20de90bfce5a0d3cb52414ccbbec72a555367034c5faae183`

### 4.2 2026-08-27 AI-close 第一轮（`ReasonBound` 暂时保留）

用户新增硬约束：名称不能只在解释后才与 AI 发生关系；第一眼应落在 reasoning、inference 或 model signal 语境中。同时仍不能直接退化为 `SafeAI`、`GuardAI`、`AgentOS` 一类泛化拼接词。

| 候选 | AI 直接语义 | 与产品事实的映射 | 当前判断 |
|---|---|---|---|
| **`ReasonBound`** | reasoning + bounded agency | AI 可以推理和演进，但 effect、promotion 与 enable 始终受 K0 边界约束 | **`RETAINED / DISCOVERY`**；用户要求暂时保留并继续生成 |
| **`ReasonSignal`** | reasoning + inspectable signal | 模型判断先成为可观察、可验证、可审批的信号，再进入真实 effect | `DROPPED FROM ACTIVE POOL`；更像 observability 产品 |
| **`InferenceField`** | inference + controlled field | 可替换模型与插件在同一受控运行场中协作，可信边界定义可产生的现实效果 | `DROPPED FROM ACTIVE POOL`；技术描述感强，品牌人格偏弱 |

2026-08-27（Asia/Shanghai）的工程级实时初筛：

- 精确名称 + `AI / software / company` 搜索未发现三项直接同名的 AI 产品；这只代表本轮搜索结果，不代表法律可用。
- npm、PyPI、crates.io 与 GitHub repository-name 初筛未发现三项精确包名或仓库名。
- `ContextSpan` 因已有精确同名软件/代码概念而退出；`Bounded`、`ReasonLoop`、`Mindframe`、`Agentwise` 等更直白候选因同类 AI 产品重名而退出。
- domain、GitHub user/org、公司普通使用及中美欧商标仍未完成正式清查。三项只能标记为 `DISCOVERY`，用户选中一项后才能进入完整 clearance。
- 本轮不生成 discovery board。先确认命名谱系，再用确定性几何草图验证视觉，避免把生成图片的完成度误当成品牌决策质量。

### 4.3 2026-08-27 AI-close 第二轮（继续生成）

这一轮以 `ReasonBound` 为基准线，不再重复生成“AI + 安全”直白拼接词，而是在 AI 识别度、品牌人格和受控执行语义之间拉开差异：

| 候选 | AI 直接语义 | 核心品牌命题 | 优势 | 主要风险 |
|---|---|---|---|---|
| **`ReasonBound`** | reasoning + bounded agency | **Intelligence can advance without outrunning authority.** | 产品事实最完整；名称、CLI 与技术叙事一致 | `bound` 会让一部分人先想到限制，需要视觉和文案表达“能力可进化，现实效果受约束” |
| **`LatentBound`** | latent intelligence + boundary | **Power in the model. Limits in the runtime.** | AI 模型感最强；比 `ReasonBound` 更接近生成式 AI 语汇 | `latent bound` 也是机器学习/数学中的描述性短语，商标独占性可能较弱 |
| **`ReasonPact`** | reasoning + explicit pact | **AI acts under an explicit, inspectable agreement.** | 最接近 `Anthropic` 式的人文/制度气质；能承载 human gate、policy 与 receipts | `pact` 偏制度和关系，Rust enforcement 需要通过 descriptor 补足 |
| **`ReasonSeal`** | reasoning + verified seal | **Reason first. Verify before effect.** | 视觉符号潜力最好；天然连接 evidence、signature 与 promotion gate | 容易被误读为“认证/盖章”产品，不能宣传成绝对安全保证 |
| **`ReasonProof`** | reasoning + proof | **Every advance must earn its evidence.** | 最直接表达自验收、验证与可审计 AI | 偏形式验证/评测工具，覆盖 plugin runtime 的能力较弱；11 字符略长 |

第二轮工程级初筛：

- npm、PyPI、crates.io 与 GitHub repository-name 查询未发现 `latentbound`、`reasonpact`、`reasonseal`、`reasonproof` 的精确包名或仓库名；此结果不代表 domain 或商标可用。
- `ModelBound` 已有 AI agent skills / context 产品（<https://modelbound.co/open-source>）；`AgentBound` 已有高度重叠的 AI agent execution-boundary 研究与 artifact（<https://conf.researchr.org/details/fse-2026/fse-2026-research-papers/14/AgentBound-Securing-Execution-Boundaries-of-AI-Agents>）。
- `AgentProof` 已有多项 AI agent compliance / observability 产品（<https://agentproofhq.com/>）；`ReasonTrace` 已有本地 AI agent reasoning drift 产品和 PyPI 包（<https://pypi.org/project/reasontrace/>）。这些名称不进入 active pool。
- 当时的 active pool 是 `ReasonBound`、`LatentBound`、`ReasonPact`、`ReasonSeal`、`ReasonProof`。除 `ReasonBound` 外，其余均未获得用户保留。

用户随后指出关键偏差：项目定位首先是 CLI。该判断成立，因此 `LatentBound`、`ReasonPact`、`ReasonSeal`、`ReasonProof` 均退出 active pool；它们表达了 AI 与可信边界，却没有建立 terminal / command-line 品类认知。`ReasonBound` 因用户明确要求暂时保留而继续留在池中，但也必须配合 CLI descriptor 比较，不能单独按 runtime/platform 品牌评估。

### 4.4 2026-08-27 CLI-literal 第三轮（用户未接受）

本轮强制使用完整定位：**terminal-native AI coding CLI with visible, recoverable control**。名称需要先让开发者想到 shell、execution 或 TTY，再把 reasoning / inference 作为 AI 信号；候选不必同时把全部安全架构塞进一个词。

| 候选 | CLI 信号 | AI 信号 | 品牌命题 | 当前判断 |
|---|---|---|---|---|
| **`ReasonShell`** | `shell` 直接指向 terminal | `reason` 指向 agentic reasoning | **An AI coding agent that lives in your shell.** | `DROPPED FROM ACTIVE POOL`；像 package / shell integration 名，不像长期品牌 |
| **`ReasonExec`** | `exec` 指向命令与工具执行 | `reason` 表达先推理后执行 | **Reason first. Execute with control.** | `DROPPED FROM ACTIVE POOL`；像执行模块或子命令，品牌人格不足 |
| **`InferShell`** | `shell` 直接指向 CLI | `infer` 明确连接模型 inference | **Model intelligence, native to the terminal.** | `DROPPED FROM ACTIVE POOL`；基础设施术语拼接感过强 |
| **`ReasonTTY`** | `TTY` 是最纯粹的 terminal-native 信号 | `reason` 表达 AI agent | **A reasoning agent for the TTY.** | `DROPPED FROM ACTIVE POOL`；平台语义过窄，也像内部工程代号 |
| **`ReasonBound`** | 名称本身没有 CLI 信号，必须依赖 descriptor | `reason` 直接表达 AI | **The bounded AI coding CLI.** | **用户暂时保留**；差异点准确，但品类识别弱于前三项 |

第三轮工程级初筛：

- README 的当前定位原文是 “brings an agentic coding loop to the command line”；中文 README 同样明确写作“把智能体式编程循环带到命令行”。命名和视觉以后以此为第一事实。
- npm、PyPI、crates.io 与 GitHub repository-name 初筛未发现 `reasonshell`、`reasonexec`、`infershell`、`reasontty` 的精确包名或仓库名；domain、GitHub user/org、公司普通使用和商标仍未正式清查。
- `ReasonRun` 已有精确同名应用和 domain（<https://reasonrun.com/>）；`PromptShell` 已是 AI-powered terminal assistant 和 PyPI 包（<https://pypi.org/project/promptshell/>）；`PromptBound` 已有 AI engineering 产品（<https://promptbound.ai/>）；`ReasonCode` 已有 AI coding 产品（<https://marketplace.visualstudio.com/items?itemName=deepvadaliya.reasoncode>）。它们不进入 active pool。

用户随后明确反馈本轮仍“不太行”。问题不在 CLI 定位，而在命名方法：把 `shell`、`exec`、`TTY` 直接焊到 AI 词根后，虽然解释清楚，却更像 package、adapter 或内部模块。CLI 应由产品 descriptor、安装命令、binary 与使用体验建立，而不是强迫主品牌承担全部品类说明。

### 4.5 2026-08-27 brand-led 第四轮（当前 active pool）

本轮改为两层身份：**主品牌负责记忆、AI 心智和差异；固定 descriptor 负责准确声明 CLI 品类。** 这允许名称像一个长期产品，而不是功能清单。

固定品类描述暂定为：

> **The open, model-agnostic AI coding CLI.**

中文：

> **开放、模型无关的 AI 编程 CLI。**

当前只保留两个有实质差异的方向，不用弱候选填满表格：

| 候选架构 | AI / code 心智 | CLI 呈现 | 优势 | 风险与状态 |
|---|---|---|---|---|
| **`ReasonBound Code`** | `Reason` 直接指向 AI reasoning；`Bound` 承载受控 agency；`Code` 明确编程场景 | Display name 使用 `ReasonBound Code`；descriptor 明确 AI coding CLI；binary 在 identity tuple 冻结时单独决定 | 保留现有候选的核心差异，同时避免 `ReasonShell` 式模块名；可形成 `ReasonBound` 品牌与 `Code` 产品层级 | **`USER-RETAINED / DISCOVERY`**；用户已明确要求继续保留；名称偏长，且仍需验证 `Bound` 是否显得过度限制 |
| **`ReasonPatch`** | `Reason` 是 AI；`Patch` 是可检查、可恢复、可审阅的代码变更单位 | Display name 使用 `ReasonPatch`；descriptor 明确 CLI；binary 可自然使用 `reasonpatch`，但尚未冻结 | 比 `ReasonBound` 更 code-native，不依赖 `shell/TTY/exec` 字面量；直接连接项目的 recoverable file changes | **`NEW / DISCOVERY`**；可能被误解为只做补丁生成或代码审查，需要产品面验证覆盖完整 agentic loop |

第四轮工程级初筛：

- `Reasonline` 原本是最强的“双关”方向：既可理解为 line of reasoning，也可指 command line；但已有正在运营的 AI assessment 产品（<https://www.reasonline.org/>），不进入 active pool。
- `ReasonPath` 已有 AI 学习平台（<https://reasonpath.ai/>）；`BoundLoop` 已有活跃商业品牌（<https://boundloop.com/>）；二者不进入 active pool。
- `AgentPact` 已有多个 AI agent 产品和直接相邻的 AI coding-agent governance 标准（<https://kyr.is/agentpact>）；`ReasonForge` 已有 AI-native decision infrastructure 与多个 AI reasoning 项目（<https://reasonforge.ai/>）；二者不进入 active pool。
- 本轮精确产品搜索没有发现直接以 `ReasonPatch` 为名的 AI coding CLI；搜索只出现论文算法中的 `reasonPatch` 标识。这只是 preliminary discovery，不代表商标、domain、registry 或普通使用可用。
- `Boundline`、`GroundLoop`、`PatchBound` 虽未在本轮发现直接同类重叠，但品牌语义分别偏服装/边界术语、电气回路、代码安全模块，不提升为 shortlist。
- 当前不生成 Logo board。先判断 `ReasonBound Code` 与 `ReasonPatch` 的语言方向是否值得保留，再进入完整 clearance 和视觉验证。

### 4.6 2026-08-27 collaborator 第五轮（用户未接受）

用户明确要求继续保留 `ReasonBound Code`。这代表“AI reasoning + bounded agency + code product layer”的方向已经进入稳定保留池，但不代表名称冻结、clearance 通过或允许开始迁移。

第五轮不继续发明边界同义词，而是比较 AI coding CLI 在开发者心中的角色：它是受约束的系统、并肩工作的 reasoning peer，还是产生可审阅变更的工具。

| 候选 | 品牌角色 | 与 AI coding CLI 的关系 | 优势 | 风险与状态 |
|---|---|---|---|---|
| **`ReasonBound Code`** | bounded reasoning system | AI reasoning 在可见授权边界内完成 coding loop | 差异最完整，能够承载 trust、permission、sandbox、recoverable changes 与长期 plugin architecture | **`USER-RETAINED / DISCOVERY`**；继续作为基准线，不自动进入 `BRAND-FREEZE` |
| **`ReasonPeer`** | reasoning peer | 终端里与开发者共同理解仓库、计划、修改和验证的 AI 合作者 | 比安全/基础设施名称更有人格；`reason` 保持 AI 心智，`peer` 比 `assistant` 更符合可审阅、可质疑的协作关系 | `REJECTED`；用户未接受 |
| **`ReasonPair`** | pair-programming partner | 把 agentic loop 收敛为 terminal-native AI pair programming | 对开发者品类最直接，读写简单；既能作名词也能表达配对动作 | `REJECTED`；用户未接受 |
| **`ReasonPatch`** | inspectable change maker | reasoning 最终落为可检查、可恢复的代码变更 | code-native，最贴近 recoverable file changes | `REJECTED`；用户未接受，且范围容易被误读为只做 patch / review |

第五轮工程级初筛：

- 精确名称 + `AI coding / CLI / software` 搜索未发现直接以 `ReasonPeer` 或 `ReasonPair` 为名的同类 AI coding 产品；结果只出现无关文本或代码标识。这只是本轮产品搜索结果，不是商标、domain 或 registry clearance。
- `ReasonMate` 没有提升为候选：`mate` 更像消费级 assistant，弱化了项目的 builder-native、可质疑和 evidence-driven 气质。
- `Directive` 已有直接相邻的 AI coding rules CLI（<https://www.npmjs.com/package/@directive-run/cli>）；`Delegate` 已有 AI coding-agent orchestration 产品（<https://github.com/nikhilgarg28/delegate>）；`Steward` 已被多个 AI agent governance、code review 与 authority-plane 产品使用（<https://www.steward.foo/>）。三者不进入 active pool。
- `Deliberate` 已有直接同类的多 LLM coding-agent CLI（<https://pypi.org/project/deliberate/>）；`Intent` 已有面向 AI coding agents 的 CLI（<https://tanstack.com/intent/latest/docs/overview>）；`Grounded` 已有 AI-agent developer product 与 `grounded-cli`（<https://grounded-api.dev/>）。三者不进入 active pool。
- `PromptDiff` 已有多个 LLM prompt diff CLI / 产品（<https://pypi.org/project/promptdiff-ai/>）；`PromptPatch` 虽未发现直接同类重叠，但仍像单点功能名，暂不提升为 shortlist。
- 用户随后明确反馈本轮候选“也不行”。`ReasonPeer`、`ReasonPair`、`ReasonPatch` 全部退出 active pool；`ReasonBound Code` 因用户此前单独明确保留而不受本次否决影响。

### 4.7 2026-08-27 AI × Git 第六轮（用户未接受）

前五轮暴露了两个反复出现的问题：抽象 AI 名称离 CLI 太远，直白 CLI 后缀又像 package。第六轮只使用同时天然存在于 **AI reasoning** 与 **Git / code-change workflow** 的语义，避免依赖长篇解释。

| 候选 | 双重语义 | CLI / code 映射 | 优势 | 风险与状态 |
|---|---|---|---|---|
| **`ReasonBound Code`** | reasoning + bounded agency + coding | 品牌层 `ReasonBound`，产品层 `Code`；固定 descriptor 明确 AI coding CLI | 用户已明确保留；产品差异最完整 | **`USER-RETAINED / DISCOVERY`**；继续作为基准线 |
| **`ReasonBranch`** | reasoning branch + Git branch | Agent 可以探索多个 reasoning 分支，但真实代码变更落在可检查的 repository branch / diff 上 | AI 与代码工作流的双关最自然；不像 `ReasonShell` 那样是模块名，也不像 `ReasonPeer` 那样只描述关系 | **`REJECTED`**；用户未接受本轮候选 |
| **`Amend`** | improve a proposal + `git commit --amend` | 一个短、自然的终端命令；表达 AI 对代码进行有依据、可复核的修改 | 五字符、可读、可作动词；比 AI 热词更像长期 developer-tool 品牌 | **`REJECTED`**；用户未接受本轮候选 |

第六轮工程级初筛：

- 精确名称 + `AI coding / CLI / software` 搜索未发现直接以 `ReasonBranch` 或 `Amend` 为名的同类 AI coding CLI。这只是 preliminary product search，不代表商标、domain、GitHub/npm/PyPI/crates/Homebrew/Winget 可用。
- `ReasonTree` 已有 reasoning-based document retrieval 项目（<https://github.com/sunilgentyala/ReasonTree>）；不进入 active pool。
- `Quine` 已有同名 streaming graph CLI，并有直接相邻的 LLM agents as native POSIX processes 研究/实现（<https://arxiv.org/abs/2603.18030>）；不进入 active pool。
- `Latent` 已有 `LatentCode` 和相关 AI coding integration（<https://github.com/LatentForce-ai/latentgraph-mcp-server>）；`Logit` 更像模型内部统计量，且没有形成用户可感知的产品动作；两者不进入 active pool。
- `Lemma` 已有同名 CLI / MCP（<https://lemma.run/reference/cli>）；`Axiom` 已有 AI-agent developer platform 与 CLI（<https://dev.axiomide.com/docs>）；不进入 active pool。
- `Draft` 已有多个直接面向 Claude Code、Codex 等 coding agents 的产品/插件（<https://www.getdraft.dev/>）；不进入 active pool。
- `Staged` 与项目的 `STAGED_DISABLED` / reviewable-change 原则一致，但当前品牌不能暗示每次文件修改都会自动进入 Git staging area，因此只保留为产品状态语言，不作为名称。
- 用户随后明确反馈本轮候选“这些也不行”。`ReasonBranch`、`Amend` 退出 active pool；`ReasonBound Code` 因用户此前单独明确保留而不受本次否决影响。

### 4.8 2026-08-27 personified + CLI 第七轮（方向误读，已停止）

用户提出新的命名架构：**拟人化名称 + `CLI` 后缀**。这条方向成立，因为两部分只承担各自最重要的任务：角色名建立 AI collaborator 的人格与记忆，`CLI` 直接锁定 command-line 产品类别，不再要求一个生造词同时解释 AI、代码、安全、Git 与 runtime boundary。

本轮先冻结命名语法，不冻结具体 identity tuple：

- display name：`[PERSONA] CLI`；对话中可简称 `[PERSONA]`；
- category descriptor：**The open, model-agnostic AI coding CLI.** / **开放、模型无关的 AI 编程 CLI。**；
- persona：冷静、坦诚、会质疑假设、修改前先读取和验证、修改后给出证据；不是可爱机器人，也不是无条件服从的消费级 assistant；
- canonical binary、package scope、home/env 与 signing principal 仍在 `BRAND-FREEZE` 单独决定。display name 采用 `CLI` 后缀，不代表 binary 可以未经 registry clearance 直接占用同名小写命令。

当前不以弱名字填满 shortlist，只提升一个语义完整的主候选：

| 候选 | 拟人人格 | AI / CLI 映射 | 优势 | 风险与状态 |
|---|---|---|---|---|
| **`Clare CLI`** | Clare 是一个会先把事情说清楚、再执行的 coding collaborator | `Clare` 与 *clear* 形成自然听觉联想，承载 visible plan、permission、diff 与 uncertainty；`CLI` 明确产品类别 | 像真实角色而不是内部模块；短、可呼叫；人格与“visible, recoverable control”一致 | **`DROPPED / DIRECTION MISREAD`**；用户要的不是普通真人名字，而是像 `volund` 一样能够成为品牌原型并直接 Logo 化的主体名 |
| **`ReasonBound Code`** | 非拟人路线的受控 reasoning system | 保留 reasoning + bounded agency + code product layer；descriptor 继续明确 CLI | 用户明确要求保留，仍是技术差异表达最完整的基准线 | **`USER-RETAINED / DISCOVERY`**；作为平行保留路线，不因本轮改用拟人语法而自动淘汰或冻结 |

第七轮工程级初筛：

- `Vera CLI`、`Tess CLI`、`Ada CLI`、`Grant CLI`、`Reid CLI`、`Ernest CLI`、`Frank CLI` 已有精确或高度相邻的 CLI / AI developer tools，不进入 active pool。
- `Verity CLI` 已有多个当前 AI code quality / verification CLI，其中包括 Codacy 的 AI-generated code gate（<https://verity.md/docs>）；`Clara CLI` 已有 terminal coding agent（<https://github.com/claraverse-space/ClaraVerse>）；二者不进入 active pool。
- `Scout CLI`、`Candor CLI`、`Steward CLI`、`Shelby CLI`、`Clive CLI`、`Grace CLI`、`Alan CLI` 均已有当前 CLI 或直接相邻 developer / AI tooling；不因为“像人或角色”就忽略 command、registry 与搜索占位。
- 对 `Clare CLI` 的精确名称 + `AI coding / CLI / software` 及 GitHub/npm/PyPI 定向搜索，当前未发现直接同名产品。这只是 preliminary product search，不构成商标法律意见或最终可用性证明。

用户随后纠正“拟人化”的含义：不是给工具取一个普通真人名字，也不是在名字旁边画角色头像；而是让主品牌像 `volund` 一样，拥有一个可叙述的原型人格，同时让**品牌名本身成为 Logo**。因此 `Clare CLI` 不进入下一轮，前述普通人名方法停止。

### 4.9 2026-08-27 archetype wordmark + CLI 第八轮（当前方向）

新命名与视觉不再分成两个串行任务。每个候选必须作为一个最小 identity prototype 同时提交：

1. **Archetype name**：一个有角色原型、精神命题和长期叙事空间的 proper noun；像 `volund` 一样可以被“呼叫”，但不能只是普通人名或随意借用神名；
2. **Primary wordmark**：品牌名的字母结构本身完成 Logo 化，通过一至两个可解释的 cut、path、boundary、cursor 或 negative-space 动作建立识别；禁止在字标左边再挂一个无关图标；
3. **CLI endorsement**：`CLI` 是较小的等宽品类签名，可位于 cap-height 右侧或 baseline 右下方；它不与主品牌等权，也不强迫 canonical binary 与 display name 完全同名；
4. **Derived terminal mark**：16px icon / favicon / TUI ASCII mark 必须从主字标的同一字母动作中抽出，而不是另造机器人、头像、头盔、盾牌或 sparkle；
5. **One-line myth**：用一句话解释这个角色如何对待代码，例如“先穿过复杂性，再留下可验证的路径”；不能依赖长篇词源说明才成立。

标准 lockup 关系：

```text
┌──────────────────────────────┐
│  [CUSTOM ARCHETYPE WORDMARK]  CLI_ │
│   └─ same gesture ─────────┘       │
└──────────────────────────────┘
```

其中 `_` 可以是 live cursor，但只在它与字标主动作一致时使用。`CLI` 后缀是 Logo lockup 的一部分，不是必须写入所有口语名称、package、env 或 protocol identifier 的字符串。

第八轮排除结果：

- `Daedalus` 已有直接同类 AI planning / coding CLI（<https://github.com/internet-development/daedalus>）；`Ariadne` 已有面向 Codex / Claude Code 的本地记忆与 MCP 产品（<https://github.com/mclaut/ariadne>）；不进入候选。
- `Seshat` 已有 terminal-first、model-provider configurable agent CLI（<https://seshat-ai.com/fr/docs/getting-started/quick-start/>）；`Themis CLI` 已有 AI-assisted development workflow CLI（<https://pypi.org/project/themis-cli/>）；不进入候选。
- `Nabu CLI` 已是 Codex / Claude Code / OpenCode 的 cross-agent history CLI（<https://docs.rs/crate/nabu-cli/>）；`Cadmus` 已有直接安装 `cadmus` 命令的 AI spec engine（<https://pypi.org/project/cadmus-spec/>）；不进入候选。
- 这说明“借一个神名”本身不是策略。下一轮要生成的是具有原型重量、但不直接复用拥挤 myth / developer-tool namespace 的新 proper noun，并把名称与 wordmark construction 一起评审。

### 4.10 2026-08-27 mythic persona + terminal-cell wordmark 第九轮（Volund 已进入 Phase A）

用户进一步明确：问题首先是 `volund` 这个品牌名本身不合适；新名称应像 `volund` 一样拥有可叙述的拟人或神话人物原型，同时 Logo 必须能只靠终端字符成立。`CLI` 继续作为较小的品类后缀，主品牌名称本身才是 Logo。

本轮不再给每个名字另造一个图标，而是采用同一条可比较的字标规则：把名称中的 `O` 变成 terminal cell **`[>_]`**。它同时是字母 `O`、command prompt、live cursor 和 derived TUI mark；脱离完整名称时也只能使用同一个 `[>_]`，不能再补机器人、神像、头盔或独立徽章。

```text
V[>_]LUND   CLI
H[>_]ENIR   CLI
KUEBIK[>_]  CLI

derived terminal mark: [>_]
```

| 候选 | 人格原型 | One-line myth | 与产品的映射 | 风险与状态 |
|---|---|---|---|---|
| **`Volund CLI`** | 取自北欧/日耳曼传说中的传奇锻造者 Völund / Wayland | **把模糊意图锻成可运行、可验证的变更。** | `forge` 不是写进名字的功能词，而是角色行为：理解材料、使用工具、产出可以检验的成品；最接近 AI coding CLI 的 builder 身份 | **`USER-PREFERRED / DISCOVERY`**；用户认为该方向最符合“强大的铁匠，为 coder 提供最好的工具”。六字母、字形硬朗、ASCII lockup 最稳。风险是原典还包含囚禁与复仇，品牌叙事必须明确只取“master craft”原型；`Volund` 也是无变音符号的工程拼写，正式 clearance 前不能视为可用 |
| **`Hoenir CLI`** | 取自参与创造人类、与“赋予心智/判断”相关的北欧神祇 Hœnir | **先赋予判断，再允许命令行动。** | reasoning 发生在 effect 之前，能自然承载 plan、permission、tool call 与 receipt；比直接拼 `Reason*` 更像一个可呼叫的角色 | **`SECONDARY / DISCOVERY`**；语义最接近 AI reasoning，但神话材料本身稀少且解释不完全一致；`oe` 的读音和 Hœnir → Hoenir 的转写需要验证 |
| **`Kuebiko CLI`** | 取自日本神话中无法行走、却广知世事的知识之神 Kuebiko | **站在终端里读懂整片代码田，再指出正确的名字。** | “rooted but broadly aware”可映射本地 terminal agent 对 repository context 的理解；角色记忆点最强，也最容易形成独特语气 | **`EDGE / DISCOVERY`**；文化原型鲜明，但拼读成本最高；scarecrow / cannot walk 也可能被理解为被动、笨拙或不能执行，不作为当前首选 |

原型依据：Völund / Wayland 是传说中的 master smith（<https://www.encyclopedia.com/places/united-states-and-canada/us-political-geography/wayland>）；Hœnir 在现存材料中参与塑造最初的人类并赋予关键心智能力（<https://www.worldhistory.org/Hoenir/>）；Kuebiko 在《古事记》叙事中不能行走但广知世事（<https://d-museum.kokugakuin.ac.jp/eos/detail/?id=9372>）。这里只借用角色原型，不声称对神话人物拥有排他权，也不以改写神话代替产品定位。

2026-08-27（Asia/Shanghai）的 preliminary product search：

- 对 `Volund CLI`、`Hoenir CLI`、`Kuebiko CLI` 分别执行 exact-name + `AI / coding / software / CLI` 搜索，当前未发现直接同名的 AI coding CLI。该结果只允许三项留在 `DISCOVERY`，不代表 package、domain、company、trademark 或跨地区普通使用已经可用。
- 同一轮继续排除了多个“神话锻造者/知识神”近邻：`Eitri` 已有正式发布的开发者 CLI（<https://docs.eitri.tech/en/concepts/eitri-cli/>）；`Brokkr` 已有 CLI 与 HPC 平台（<https://github.com/project-mjolnir/brokkr>）；`Wayland` 已有 AI desktop + standalone Rust agent CLI（<https://docs.getwayland.com/>）；`Khnum` 已有可安装并执行 `khnum` 命令的 memory compiler（<https://github.com/Lord1Egypt/Khnum>）。`Bragi` 也已有公开 CLI package、代码编辑器与 AI 叙事产品，因此不进入候选。
- `[>_]` 目前只是 ASCII identity prototype。只有用户先确认名称方向，才值得做终端宽度、ASCII fallback、16px redraw、dark/light、README/TUI snapshot 和相似性测试；不能把本轮文本草图当作 production asset。
- `ReasonBound Code` 按用户此前要求继续留在平行保留池。它是技术命题型名称，不自动与本轮 mythic-persona 路线竞争出最终结论。

用户随后把 `Volund CLI` 选为当前最佳方向，并把人格进一步定义为：**强大的铁匠，为 coder 锻造最好的工具。** 第一版确定性 ASCII logo prototype 已记录在 [`2026-08-27-volund-cli-ascii-logo.txt`](../../assets/brand-discovery/2026-08-27-volund-cli-ascii-logo.txt)。主字标是 `V[>_]LUND  CLI`：`[>_]` 直接替代 `O`，同时表达 terminal cell、command prompt 与 live cursor；启动页 hero lockup 才增加由字符构成的铁砧基座。暂定 tagline 为 **FORGED FOR CODERS.**

用户随后确认 Logo 可以明确使用锤子。V2 不增加独立 pictogram，而把 `[>_]` 同时解释为终端炉膛和锤头，并从该字母单元向下延伸 `||` 形成锤柄：

```text
V[>_]LUND  CLI
  ||
```

在 hero lockup 中，锤柄继续落向 ASCII 铁砧；在单行 shell、package badge 或极窄 viewport 中退回 `V[>_]LUND CLI`，不能为了保留锤子破坏文本行高。derived TUI mark 使用三行 `[>_] / || / ||`，因此 terminal、hammer 与字母 `O` 仍是同一个母形，而不是三套互不相关的 Logo。

用户随后明确要求“开始做品牌替换”，因此该方向从 discovery prototype 转为 **Phase A 用户可见身份**：TUI/CLI/README/docs 使用 `Volund CLI`，canonical command 使用 `volund`，`volund` 保留兼容别名。这不代表完整法律 clearance 或非 display identity tuple 已获签收。

### 4.11 2026-08-27 pixel hammer 视觉修正（当前生产方向）

用户明确否决了上一版“字标 + 细 ASCII 锤柄 + 铁砧”的构图，并提供了一张粗像素、高对比、大图标主导的 terminal 参考。新方向只提取其形状逻辑，不复制 U 形机器人脸：

- 主轮廓是宽锤头 + 中央锤柄，先作为独立 silhouette 成立；
- 锤头内部是一个深色 terminal screen，只保留像素 `>_` cutout；
- 主字标恢复为直接的 `VOLUND CLI`，不再把 `[>_]` 强行塞进名称；
- 唯一信号色改为 **Forge Teal `#2BBD9B`**，底色为 **Forge Black `#06100F`**；
- TUI 使用 24 列 Unicode block 投影，SVG/favicon 使用同一像素几何，README hero 只保留一个大标志。

可编辑的方向研究资产记录在 [`2026-08-27-volund-pixel-hammer-v2.svg`](../../assets/brand-discovery/2026-08-27-volund-pixel-hammer-v2.svg)。

## 5. Logo 系统

### 5.1 已停止的主符号：Controlled Port

`Controlled Port` 架构含义准确，但用户未接受，且第一眼更像安全容器/基础设施，不够贴近 AI。它降级为架构图语言，不再作为品牌主 Logo 方向。

该历史方案使用三个几何事实：

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

### 5.2 当前 Volund CLI 视觉母题（pixel hammer）

当前方向不画机器人、脑、神经网络或通用 sparkle。主 mark 是一个粗像素锤子：宽锤头提供图标冲击力，中央锤柄锁定铁匠隐喻，锤头内的 terminal screen 提供 AI coding CLI 品类信号。

```text
  ████████████████████
████████████████████████
████     >_         ████
████                ████
  ████████████████████
          ████
          ████
```

- 锤子 silhouette 是第一识别层，即使去掉内部字符也要成立；
- `>_` 是第二识别层，表达 terminal prompt + live cursor；
- wordmark 使用 `VOLUND CLI`，不再承担绘制锤子的任务；
- Forge Teal 只用于品牌识别，不表示 verified、approved、safe 或 success。

当前视觉方向不再按 `Clare CLI` 生成独立人物或图标。`ReasonBound Code` 仍可作为技术命题型保留路线，但新的 archetype 候选必须把 prompt、decision、boundary 与 cursor 中的一至两个动作直接嵌入主字标；图标只是该字标动作的缩略投影。用户未确认名称前，不冻结构图，也不把角色画成机器人或吉祥物。

### 5.3 Secondary glyph：Proof Ratchet

Self-Development / Evolution Loop 可使用独立的功能 glyph 或 motion：candidate 只有在 evidence 到达、verifier 通过、human gate 打开后才前进一格。它不能替代主 Logo，也不能暗示自动启用、自动合并或自动发布。

### 5.4 视觉规范

- 主 Logo：纯黑/纯白优先；
- 唯一品牌信号色提案：**Forge Teal `#2BBD9B`**；它本身不表示 verified、approved、safe 或 success；
- success、warning、danger 等产品状态色不属于 Logo palette；
- 不使用渐变、发光、玻璃、3D、阴影或细密线条；
- 不在 mark 内放字母、盾牌、锁孔、脑、机器人、齿轮或 Rust 语言图标；
- mark 必须能输出：SVG、16/20/24/32px icon、favicon、macOS/Windows/Linux app icon、CLI Unicode、纯 ASCII fallback、单色印刷；
- 生产 SVG 必须是确定性几何资产，不直接采用生成式图片中的不可控路径。

### 5.5 最小验收

- 16px 下 prompt、decision point、boundary 与 cursor 仍可辨；
- 黑底白标、白底黑标、单色打印均成立；
- 终端窄字符版本不依赖颜色；
- 与常见安全盾牌、容器立方体、芯片/电路和现有知名标志不存在高相似；
- wordmark 移除后，mark 仍能表达“a terminal prompt becomes a bounded AI effect”；
- Forge Teal 缺失时，锤子与 terminal cutout 仍由形状而不是颜色表达。

## 6. Identity tuple：品牌迁移前的人工硬门

以下十项必须作为一个版本化 artifact 一次冻结，不允许只选 display name 就开始散改：

| # | Identity field | 当前值 | 目标值 | 状态 |
|---|---|---|---|---|
| 1 | display name / short name | volund Code / volund | `Volund CLI` / `Volund` | USER-APPROVED / PHASE A |
| 2 | machine slug | `volund-code` | `volund-code`（repository/docs deployment slug；npm product name 单独为 `\@volund/cli`） | IMPLEMENTED / EXTERNAL CLEARANCE PENDING |
| 3 | canonical CLI | `volund` | `volund`；`volund` 保留兼容 alias，移除版本待冻结 | IMPLEMENTED / PHASE A |
| 4 | npm root / scope | `volund-code`, `@volund-code/*` | `\@volund/cli`, `@volund/*`；`volund-code` 作为 legacy meta shim | IMPLEMENTED / PHASE B:NPM；REGISTRY CLEARANCE PENDING |
| 5 | home / env | `~/.volund`, `volund_*` | 待确认；同时冻结读取优先级和迁移规则 | BLOCKED |
| 6 | repo / docs origin | volund 相关路径与 URL | GitHub `JS-mark/volund-code` + docs base `/volund-code/`；自定义域名仍待确认 | IMPLEMENTED / DOMAIN CLEARANCE PENDING |
| 7 | native / release IDs | volund 相关标识 | 待确认 | BLOCKED |
| 8 | plugin namespace | legacy volund v1 + brand-neutral v2 target | v1 兼容 + v2 exact rule | BLOCKED |
| 9 | signing/security principal | 当前/待建 | brand-neutral 或新 namespace | BLOCKED |
| 10 | wire/event/error/schema IDs | 已存在 volund 与中性常量 | 列明永久冻结项；禁止自动替换 | BLOCKED |

冻结 artifact 至少包含：`schemaVersion`、十项映射、alias expiration policy、path precedence、telemetry namespace、signing principal、legacy compatibility、frozen protocol identifiers 与审核人。

## 7. 仓库迁移顺序

2026-08-27 的用户明确指令先授权可回滚的 Phase A display migration，随后明确要求继续迁移 npm 包，因此 package root/scope 获得独立 Phase B:NPM 授权。该授权不扩大到 home/env、wire/schema、signing、native/release 和外部地址；这些 surface 仍等待完整 identity clearance 与对应 gate。

### BRAND-DISCOVERY · 已完成的历史阶段

- 冻结品牌命题、命名约束、Logo 语义和 claim gate；
- 对最终 shortlist 做实时 registry/domain/trademark/common-use 清查；
- 输出 2–3 个名称 + 同一 Controlled Port mark 的 wordmark 适配；
- 用户确认一个最终 identity。

本阶段的限制已由用户对 `Volund CLI` 与 pixel hammer 的确认关闭；后续仍不得据此改写 package、home、env、schema 或 signing identity。

### BRAND-FREEZE · Identity ADR

- 生成唯一、版本化的 canonical identity artifact，例如 `brand/identity.v1.json`，再由确定性生成器投影到 TS、Rust、package、docs 和 release surface；具体路径在实现审查时冻结；
- artifact 包含完整 identity tuple、compatibility policy、frozen literal allowlist 与 owner，禁止继续散落手写新品牌常量；
- 用户/product/security 共同确认；
- 记录哪些 `volund` 是 display identity，哪些是兼容 API，哪些是历史证据，哪些永久不迁移；
- 为每个迁移 surface 建立 old → new 映射和 rollback rule。

### BRAND-ASSETS · 确定性资产

- 建立主 mark SVG、wordmark、favicon、app icons、CLI/ASCII mark、spacing/min-size/color tokens；
- 先替换可回滚的 display-only surface；
- 更新 §13 中旧的“太阳/神庙/宇航头盔、深蓝+太阳金”视觉方案；
- 做 snapshot、视觉、16px、单色、dark/light 和 docs build 验收。

### BRAND-MIGRATE-A · 用户可见身份

状态：**COMPLETE（scoped Phase A）**。依用户明确授权完成 display-only 与 CLI alias 迁移；Phase B:NPM 已独立执行，其余 B/C surface 仍需完整 freeze/clearance/gate。

- README、docs、onboarding、TUI welcome、help/version/about、release notes templates；
- 2026-08-27 完成第二轮 docs sweep：VitePress 双语正文、当前 RFC/spec、CLI tree、onboarding 与官网视觉规范不再使用旧 display brand 或把 `volund` 当 canonical command；`scripts/verify-l1-docs.test.mjs` 增加回归守卫；
- REVIEW、archived spec、model-switch/handoff 与 exact-SHA release evidence 保留历史原文；`.volund`、`volund_*`、`volund.*` schema、`VolundBridge` 和 legacy plugin bridge 是真实兼容标识，不伪写成已经迁移；
- canonical CLI 新名上线，`volund` 保留明确期限的兼容 alias；
- 旧命令输出 deprecation，但不得破坏脚本的 exit code/JSON contract。

### BRAND-MIGRATE-B · 本地状态与包身份

- **npm 子阶段状态：IMPLEMENTED（live registry/publish 未执行）**。canonical root/meta package 为 `\@volund/cli`，workspace/platform scope 为 `@volund/*`；manifests、imports、TypeScript paths、lockfile、changesets、standalone packer 与 publish order 已原子迁移；旧 `volund-code` 由同一 pack step 生成 compatibility meta shim；
- 正式发布前必须验证 `\@volund/cli` 与 `@volund` 的 registry owner/权限，并在 release approval 下执行 clean-install smoke；本地实现不等于名称已获占用或已发布；
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
| TUI Logo | `packages/ui/src/components/welcome/VolundLogo.tsx` | 已使用 24 列 pixel hammer + `>_` terminal cutout，并通过 snapshots |
| Docs mark/favicon | `apps/docs/public/volund-mark.svg`, `apps/docs/public/favicon.svg` | 与 deterministic SVG 同源生成 |
| README hero | `docs/assets/readme-hero.svg` | 移除旧 A/orbit/gradient，不在位图上二次描摹 |
| Docs 视觉规范 | `docs/superpowers/specs/2026-07-31-volund-code-design/13-docs-site.md` | 废止 volund 太阳语义，改为新 identity system；同步实际 docs origin |
| Docs theme | `apps/docs/.vitepress/theme/custom.css` | token 化，不靠全局字符串替换 |
| CLI identity | `apps/cli/src/command.ts`, `apps/cli/package.json`, `apps/cli/rolldown.config.mjs` | 新 binary + compatibility alias + help/version/build contract |
| npm packages | root/package manifests、lockfile、changesets、`scripts/pack-standalone-npm.mjs`、`publish-npm.yml` | canonical `\@volund/cli` / `@volund/*` 已落地；生成 `volund-code` legacy meta shim；live registry clearance 与真实 publish 仍待人工门禁 |
| Home/config/env | `apps/cli/src/runtime.ts`, `apps/cli/src/trust.ts`, `packages/native-bridge/src/resolver.ts` | 覆盖 `VOLUND_HOME`, `~/.volund`, `.volund/config.toml`, `VOLUND_BUILD_*`, `VOLUND_NATIVE_*` 等；明确 precedence、diagnostic、backup 和 rollback |
| Operational locks | `.volundlock`, `.volund-tmp`, `.volundignore` | 新旧客户端共存时锁必须共享，不能因改名造成并发写穿；ignore/temp 需显式迁移 |
| Plugin contracts | `packages/plugin-sdk`, `packages/plugin-runtime`, `crates/volund-sandbox/src/plugin_host.mjs` | v1 `volund-plugin-*`、`engines.volund`、`permissions.volund`、`volund.` RPC 冻结；v2 brand-neutral + re-sign/re-auth |
| Evidence/protocol | `packages/shared/src/protocol.ts`, `packages/shared/src/error-codes.ts`, `packages/shared/src/events` | 逐项分类；历史与 v1 wire/event/error 常量禁止误改 |
| Persisted schemas | `packages/storage`, `packages/context`, `packages/plugin-runtime` | `volund.memory.v1`、`volund.memory.export.v1`、`volund.semantic-index.v1`、`$volund.bytes.v1` 按 v1 literal freeze |
| Native/release/signing | Rust crates/bins、`packages/native-bridge`, release scripts/workflows/evidence | 已发布 artifact/tag 不改；新品牌 parallel mapping，最后 same-SHA 重签/重验 |

## 9. 不可破坏的兼容不变量

- 已发布 artifact、tag、历史 session、evidence、digest 和 signature preimage 不做原地重写。
- Protocol v1、`volund_*` wire error、事件字段 `volundVersion`、现有 error registry 与上述 persisted schema literals 按精确字节冻结；新身份通过 v2、alias 或 migrator 引入。
- Legacy plugin v1 继续作为 disabled reader/migration input；不能把 `volund-plugin-*`、`engines.volund`、`permissions.volund` 或 `volund.` RPC 原地 search-replace 后冒充同一签名主体。
- Plugin v2/Catalog 采用 brand-neutral contract；迁移到新 identity 需要 re-sign、re-auth、重新 adoption/enable，且默认仍为 disabled。
- `VOLUND_HOME`、`~/.volund` 与 `.volund/config.toml` 的兼容读取必须有冻结 precedence；迁移保留备份、可重入、可诊断，不在 startup 静默删除旧状态。
- `.volundlock` 在新旧客户端并存期必须保持同一锁域；先改锁名会让两个版本并发写同一状态。
- 当前规范中的 `volund-code.dev` 与实际 docs origin 不一致；迁移时以冻结后的 canonical identity artifact 为唯一来源，不复用任何一方作为隐含真值。
- 中文/英文 README 和 docs 中的安全、plugin availability 声明必须先按真实实现校准，再做品牌翻译；品牌迁移不能放大未交付能力。

## 10. 完成定义

品牌工作只有同时满足以下条件才算完成：

1. 用户确认最终名称和完整 identity tuple；
2. 实时 clearance 结果被记录，风险有明确 owner；
3. Logo/wordmark/CLI/app/docs 资产是确定性、可复现的 source assets；
4. 用户可见 surface 无非兼容性的 volund 残留；
5. 所有 legacy alias/path/env/plugin 行为有测试、期限和移除策略；
6. wire/event/error/schema/security 历史常量未被误迁移；
7. 新旧 package/CLI/config 的 clean-install 与 upgrade smoke 通过；
8. branded exact-SHA 的安全、ABI、Catalog、docs、release evidence 全部重建；
9. `plugin-native`、`Rust-enforced`、`controlled self-development` 等声明分别通过 §3.2 claim matrix 及 §18/§19 对应门禁；
10. product/security 人工验收通过后才进入 prerelease。

## 11. 下一次需要用户确认的内容

pixel hammer 已得到用户确认，Phase A 不再等待 Logo 评审。当前品牌的下一个高价值决策是：

> 为 full identity clearance 指定 owner，完成 `\@volund/cli` / `@volund` registry ownership 复核，并确认 home/env、自定义域名迁移策略及 `volund`/`volund-code` alias 的移除版本。

`ReasonBound Code` 的“保留”状态与下一轮 archetype wordmark prototype 都不自动授权正式 clearance、生产 Logo、package、CLI、home、env、wire 或 signing identity 迁移；完整 identity tuple 仍需在 `BRAND-FREEZE` 人工签收。

## Appendix A · Rejection ledger

此表只记录工程筛查和用户决策，不构成商标法律意见。旧轮外部搜索证据没有形成仓库内 canonical clearance artifact，因此不得把历史搜索结果当作当前可用性证明；新 shortlist 必须重新做带日期、查询范围、链接和 owner 的实时清查。

| 名称 | 时间/来源 | 结论 | 证据状态 |
|---|---|---|---|
| `Cereward AI` | 2026-08，用户选择后进入 prior clearance gate | 相邻名称/类别风险超过工程阈值；`WITHDRAWN / DO NOT USE` | 决策在任务历史；外部链接未落库，不作为当前法律证据 |
| `Evalistry` | 2026-08，命名探索 | 从未确认；用户后续要求“名字不好，重新设计”；`REJECTED` | 用户决策在任务历史 |
| `Rigorbind` | 2026-08，prior clearance gate | 相邻 `RIGOR` 权利风险；`CLEARANCE-REJECTED / DO NOT USE` | 决策在任务历史；外部链接未落库 |
| `Permrun` / `Cratrun` / `Briklet` | 2026-08，命名探索 | 工程代号感强、品牌质量不足；`REJECTED` | 设计筛选记录 |
| `Nomitera` / `Ordiflux` / `Tenitera` | 2026-08-26，命名探索 | 用户未接受；伪拉丁构词离 AI 类别心智过远；`REJECTED` | 用户决策 + 本文历史 board |
| `Coldframe` / `Toolpost` / `Benchdog` | 2026-08-27，命名探索 | 用户要求“再换，要贴近 AI”；工程物件隐喻偏离主类别；`REJECTED` | 用户决策在任务历史；未生成生产资产 |
| `Controlled Port`（主标志） | 2026-08，视觉探索 | 架构表达准确但 AI 识别弱；`REJECTED AS PRIMARY MARK` | 用户决策；保留为架构图语言 |
| `ModelBound` | 2026-08-27，AI-close 命名探索 | 已有相邻 AI agent skills / context 产品；`CLEARANCE-REJECTED` | 实时产品搜索；见 §4.3 |
| `AgentBound` | 2026-08-27，AI-close 命名探索 | 已有高度重叠的 AI agent execution-boundary 研究和 artifact；`CLEARANCE-REJECTED` | 实时论文/项目搜索；见 §4.3 |
| `AgentProof` | 2026-08-27，AI-close 命名探索 | 多项 AI agent compliance / observability 产品正在使用；`CLEARANCE-REJECTED` | 实时产品搜索；见 §4.3 |
| `ReasonTrace` | 2026-08-27，AI-close 命名探索 | 已有 AI agent reasoning drift 产品与 PyPI 包；`CLEARANCE-REJECTED` | 实时 registry / 产品搜索；见 §4.3 |
| `LatentBound` / `ReasonPact` / `ReasonSeal` / `ReasonProof` | 2026-08-27，AI-close 命名探索 | 用户指出项目第一定位是 CLI；这些名称没有建立 terminal / command-line 品类认知；`DROPPED FROM ACTIVE POOL` | 用户定位纠正；见 §4.4 |
| `ReasonRun` | 2026-08-27，CLI-first 命名探索 | 已有精确同名应用和 domain；`CLEARANCE-REJECTED` | 实时产品搜索；见 §4.4 |
| `PromptShell` | 2026-08-27，CLI-first 命名探索 | 已有 AI-powered terminal assistant 与 PyPI 包；`CLEARANCE-REJECTED` | 实时 registry / 产品搜索；见 §4.4 |
| `PromptBound` | 2026-08-27，CLI-first 命名探索 | 已有相邻 AI engineering 产品；`CLEARANCE-REJECTED` | 实时产品搜索；见 §4.4 |
| `ReasonCode` | 2026-08-27，CLI-first 命名探索 | 已有 AI coding 产品；`CLEARANCE-REJECTED` | 实时产品搜索；见 §4.4 |
| `ReasonShell` / `ReasonExec` / `InferShell` / `ReasonTTY` | 2026-08-27，CLI-literal 命名探索 | 用户未接受；把品类词直接焊到 AI 词根后更像 package、adapter 或内部模块；`DROPPED FROM ACTIVE POOL` | 用户反馈；见 §4.4 |
| `Reasonline` / `ReasonPath` / `BoundLoop` | 2026-08-27，brand-led 命名探索 | 已有正在运营的相邻 AI 或商业品牌；`CLEARANCE-REJECTED` | 实时产品搜索；见 §4.5 |
| `AgentPact` / `ReasonForge` | 2026-08-27，brand-led 命名探索 | 已有直接相邻的 AI agent governance / AI reasoning 产品与项目；`CLEARANCE-REJECTED` | 实时产品搜索；见 §4.5 |
| `Directive` / `Delegate` / `Steward` | 2026-08-27，collaborator 命名探索 | 已有直接相邻的 AI coding CLI、agent orchestration、governance、code review 或 authority-plane 产品；`CLEARANCE-REJECTED` | 实时产品搜索；见 §4.6 |
| `Deliberate` / `Intent` / `Grounded` | 2026-08-27，AI-native word 命名探索 | 已有直接相邻的 coding-agent CLI、agent skill CLI 或 AI-agent developer product；`CLEARANCE-REJECTED` | 实时产品搜索；见 §4.6 |
| `PromptDiff` | 2026-08-27，product-action 命名探索 | 已有多个 LLM prompt diff CLI 与产品；`CLEARANCE-REJECTED` | 实时 registry / 产品搜索；见 §4.6 |
| `ReasonPeer` / `ReasonPair` / `ReasonPatch` | 2026-08-27，collaborator 命名探索 | 用户明确反馈本轮候选“也不行”；`REJECTED` | 用户决策；见 §4.6 |
| `Quine` / `Latent` / `Lemma` / `Axiom` / `Draft` | 2026-08-27，AI-native / proof / change-state 命名探索 | 已有同名或直接相邻的 AI agent、developer CLI、MCP、coding-agent 插件或基础设施；`CLEARANCE-REJECTED` | 实时产品搜索；见 §4.7 |
| `ReasonBranch` / `Amend` | 2026-08-27，AI × Git 命名探索 | 用户明确反馈本轮候选“这些也不行”；`REJECTED` | 用户决策；见 §4.7 |
| `Vera CLI` / `Tess CLI` / `Ada CLI` / `Grant CLI` / `Reid CLI` / `Ernest CLI` / `Frank CLI` | 2026-08-27，personified + CLI 命名探索 | 已有精确或高度相邻的 CLI / AI developer tools；`CLEARANCE-REJECTED` | 实时产品与 registry 搜索；见 §4.8 |
| `Verity CLI` / `Clara CLI` / `Scout CLI` / `Candor CLI` / `Steward CLI` / `Shelby CLI` / `Clive CLI` / `Grace CLI` / `Alan CLI` | 2026-08-27，personified / character CLI 命名探索 | 已有当前 CLI、terminal coding agent 或直接相邻 developer / AI tooling；`CLEARANCE-REJECTED` | 实时产品与 registry 搜索；见 §4.8 |
| `Clare CLI` | 2026-08-27，personified + CLI 命名探索 | 将“拟人化”误读为普通真人名字；不符合用户要求的 volund 式 archetype 与 name-as-logo 方向；`DROPPED / DIRECTION MISREAD` | 用户纠正；见 §4.8–§4.9 |
| `Daedalus` / `Ariadne` / `Seshat` / `Themis CLI` / `Nabu CLI` / `Cadmus` | 2026-08-27，archetype wordmark 命名探索 | 已有直接或高度相邻的 AI coding、planning、memory、agent、workflow 或 spec CLI；`CLEARANCE-REJECTED` | 实时产品与 registry 搜索；见 §4.9 |
| `Eitri` / `Brokkr` / `Wayland` / `Khnum` / `Bragi` | 2026-08-27，mythic persona 命名探索 | 已有直接或高度相邻的 developer CLI、AI agent、editor、compiler 或计算平台；`CLEARANCE-REJECTED` | 实时产品与 registry 搜索；见 §4.10 |
