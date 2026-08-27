> ↩ [返回索引 (README)](./README.md) · ← [上一章: §11 CLI 命令树](./11-cli-commands.md) · [下一章: §13 文档站 IA + 官网](./13-docs-site.md) →

---

## §12 开源治理

本节定义许可、贡献流程、社区规范、安全响应。

### 12.1 许可协议

- **主许可**：**Apache License 2.0**
- **仓库根**：`LICENSE`（Apache-2.0 全文）
- 每个源文件顶部 **可选** SPDX 头：`// SPDX-License-Identifier: Apache-2.0`（自动化 lint 补上）
- 依赖许可兼容性：CI 用 `license-checker-rseidelsohn` 扫，禁止 GPL/AGPL 库进 runtime

**为什么 Apache-2.0**：
- 含 **专利授权条款**（MIT 无），保护社区免遭专利伏击
- 企业接受度高（VS Code / Kubernetes / TypeScript / Vue / gRPC / Rust 都是）
- 允许闭源 fork（对小项目吸引 contributor 有利）

**Rust crate 与 npm 包 metadata**：
- `Cargo.toml`：`license = "Apache-2.0"`
- `package.json`：`"license": "Apache-2.0"`

### 12.2 贡献者许可（DCO 而非 CLA）

**决策**：用 **Developer Certificate of Origin (DCO) v1.1**，不用 CLA。

- 每 commit 加 `Signed-off-by: Name <email>`（`git commit -s`）
- GitHub 装 **DCO app** 自动 check
- 无需签合同、无需律师审查、贡献者主权保留
- 参考：Linux / Docker / GitLab 都用 DCO

不用 CLA 的理由：CLA 提高贡献门槛、需要基金会/实体运营、对社区体验负面。DCO 对小项目更合适。

**★ r13-D1：AI / bot 提交者的署名归属**：

- **bot 纯自动提交**（CI bot / renovate / changesets version PR）：豁免 `Signed-off-by`（DCO app 配置跳过 bot 账号列表，登记于 `.github/dco-bots.txt`）——机器无 origins 可声明。
- **AI 辅助的人类提交**（本项目主路径，§12.6b）：由**指令人类签署**——`Signed-off-by` 写人类的名字（操作者 / PR 作者），AI 不作为 sign-off 主体；commit message 可加 `Co-authored-by: Volund <noreply@volund-code.dev>` 标注辅助（可选）。理由：DCO 声明的是"我有权提交这段代码"，只有人能做此声明。
- 该规则同步进 CONTRIBUTING 的 DCO 段。

### 12.3 SECURITY.md

内容：

```md
# Security Policy

## Supported versions
| Version | Supported |
|---------|-----------|
| 0.x (latest, post-L1) | ✅ Latest minor gets patches |
| 0.x (older milestone) | ⚠️ Best-effort until superseded |
| < L1 release          | ❌ Pre-release, upgrade to latest |

> Volund CLI 当前处于 pre-1.0（L1–L4 阶段，见 §10）。在 1.0 GA 之前，仅"最新 0.x"享受安全补丁；老 0.x 尽力维护。1.0 发布后此表切换为标准的 major 支持策略。

## Reporting a vulnerability
**Do not open a public GitHub issue for security bugs.**

Email: security@volund-code.dev (or maintainer email if not set up)
PGP: [public key fingerprint]

We aim to:
- Acknowledge within 48 hours
- Provide a fix or mitigation within 14 days
- Publicly disclose after fix is released (coordinated disclosure)

## Scope
In scope:
- Sandbox escape
- Permission bypass
- Credential exfiltration
- Plugin sandbox breakout
- Supply chain (dependency) issues

Out of scope:
- Vulnerabilities in third-party MCP servers
- Issues requiring physical access
- User misconfiguration (e.g. --dangerous-* flags)
```

### 12.4 CODE_OF_CONDUCT.md

采用 **Contributor Covenant v2.1**（业界标准，直接引用官方文本）。

### 12.5 CONTRIBUTING.md

**权威版本**：仓库根 [`CONTRIBUTING.md`](../../../CONTRIBUTING.md)。若与本节冲突，以仓库文件为准；本节只列**必须覆盖的主题**，避免与文件内容漂移。

必须覆盖的主题清单：

1. Prerequisites（Node 20+ / pnpm 9+ / Rust 1.80+）
2. Setup（clone / install / build / test / dev）
3. Branching model（分层：L1-L2 只有 `main` + topic；L3+ 引入 `next`；见 §10）
4. Making a change 步骤 1-8（含 DCO 签署与 CI 绿灯）
5. Types of contributions（bug / feature / docs / provider / plugin/skill）
6. **RFC 触发条件**（与 §12.5b 一致，见下方"RFC 触发清单"）
7. Coding conventions 指向 AGENT.md §4-§9 + CLAUDE.md §C4
8. Conventional Commits + scope 白名单
9. Tests 分层（unit / integration / e2e / rust）
10. Changesets 提交
11. Apache-2.0 via DCO 声明

#### 12.5b RFC 触发清单（权威）

以下变更**必须**走 RFC + 7 天冷静期：

- 影响任何 `packages/*-kit` 的 public API
- 新增或移除 `packages/*` / `crates/*` / `platforms/*`
- 修改 AGENT.md §4 边界规则
- 修改权限或沙箱模型（§4 / §5）
- 新增 provider 或 transport
- 变更 credentials / telemetry 默认值
- 变更 CLI 顶层命令集或全局 flag（§11）
- **变更自我进化护栏参数**（[§15.5](./15-self-evolution.md) 安全护栏：步长上限 / 可调参数白名单 / 恶化回滚规则 / 安全边界冻结清单）—— r10 新增，属人在环检查点

### 12.6 GitHub 治理仓库文件

`.github/` 目录：

```
.github/
├─ CODEOWNERS                       # 各包责任人 → 自动 review 分派
├─ ISSUE_TEMPLATE/
│  ├─ bug_report.yml                # 结构化：期望 vs 实际 / volund doctor 输出 / 复现步骤
│  ├─ feature_request.yml
│  ├─ rfc.yml                        # RFC 模板：动机 / 详细设计 / 备选 / 风险
│  └─ config.yml                     # 关闭 blank issues
├─ PULL_REQUEST_TEMPLATE.md
├─ FUNDING.yml                       # 赞助渠道（可选）
└─ workflows/
   ├─ ci.yml                         # §9.4
   ├─ release.yml
   ├─ dco.yml                        # DCO check
   ├─ codeql.yml                     # 安全扫描
   └─ docs-deploy.yml                # apps/docs 部署
```

### 12.6b AI-native 开发协作约定（r10 新增）

> **范式声明**：本项目由 **AI 完全开发**，人（Mark）负责方向 / 策略 / 需求 / 审批。spec 是 AI 的可执行契约，人是唯一 in-the-loop 检查点。这不是「AI 辅助人写代码」，而是「人指挥 AI 写代码」——spec 的严谨程度直接决定 AI 产出的正确性。

**spec 的 AI 可执行性标准**：

| 要求 | 含义 |
|---|---|
| **每个契约必须有可验证的强制点** | CI / 单元测试 / ESLint / `volund doctor --strict` / 集成测试之一；无强制点的描述性段落必须明确标「指导性，非强制」 |
| **每个边界规则必须有自动化检查** | §4.11 / §5.10 等边界清单的每条规则都对应一个强制点（已在各节标注「强制点」列） |
| **跨节引用必须可解析** | `§X.Y` 引用必须有对应章节存在（r8 docs-lint 检查）；数字一致性（平台包数 / target 数 / 事件数）跨文件对齐 |

**AI 提交的 review 标准**：

每个 AI 生成的 PR 必须含：
1. 对应 spec 章节引用（改了哪个 §X.Y，为什么）
2. 强制点测试（新增/修改的契约必须有对应测试，CI 绿）
3. **人工审批检查点清单**：列明本 PR 涉及哪些「人在环检查点」（见下），提醒人重点审

**人在环检查点（明确哪些必须人决策，AI 不可自主）**：

| 检查点 | 说明 | 对应章节 |
|---|---|---|
| 安全边界变更 | sandbox profile / permission 决策链 / untrusted 包裹 / `dangerous-*` 行为 | §4 / §5 / §6.5.0a |
| Provider 新增 | 新增 provider-* 包（触及核心流量） | §3 / §12.5b |
| 进化系统护栏调整 | §15.5 安全护栏参数变更 | §15.5 / §12.5b |
| License / 治理变更 | 依赖 license / DCO / CoC / SECURITY 策略 | §12.1-12.4 |
| RFC 触发清单内任何项 | §12.5b 列举的 7 类变更 | §12.5b |

**协作工具约定**（指向 superpowers skills）：

AI 开发流程遵循 superpowers skill 体系：
1. `brainstorming`（新需求先发散讨论方向）
2. `writing-plans`（产出可执行 plan）
3. `test-driven-development`（先写测试再实现）
4. `requesting-code-review`（AI 自审 + 请人审）
5. **人审批**（人在环检查点）
6. `executing-plans`（按批准的 plan 执行）
7. `verification-before-completion`（完成前验证强制点全绿）

**为什么这样设计**：
- AI 写代码快，但「正确性」靠 spec + 强制点保证，不靠 AI 自觉
- 人不写代码，但所有「方向性决策」和「安全边界」由人拍板
- spec 的每个强制点都是 AI 出错的兜底——AI 漏了某条契约，CI 会红

### 12.7 治理决策模型

**r10 校准**：MVP 阶段为 **BDFL 人决策 + AI 执行**——Mark 定方向 / 审 PR / 批决策（含所有 §12.6b 人在环检查点），AI agent 按 spec 实现（遵循 §12.6b 协作工具约定）。

> 原 r1 表述「BDFL 单人主导（Mark）」中的「主导」语义不变（决策权在 Mark），但「执行」由 AI 完成。这不是单人项目变成团队项目，而是单人指挥 AI 执行。

未来（社区活跃后）：
- Core team（5 人）+ SIG（Special Interest Groups）：provider / tool / plugin / docs
- 大决策（§4 边界规则、破坏性 API）走 RFC + core team 一致同意
- 商标 / 治理 独立文档 `GOVERNANCE.md`（v2）

### 12.8 里程碑

- **L1（MVP）**：`LICENSE` / `SECURITY.md` / `CODE_OF_CONDUCT.md` / `CONTRIBUTING.md` / `.github/ISSUE_TEMPLATE/*` / DCO check
- **L2**：`CODEOWNERS` / RFC 模板 / CodeQL 扫描 / Renovate
- **L3**：正式 SIG 结构 / `GOVERNANCE.md`
- **L4**：Trademark 声明 / 基金会讨论（若达到规模）
