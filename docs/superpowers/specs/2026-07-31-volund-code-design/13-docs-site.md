> ↩ [返回索引 (README)](./README.md) · ← [上一章: §12 开源治理](./12-open-governance.md) · [下一章: §14 首次运行 Onboarding](./14-onboarding.md) →

---

## §13 文档站 IA + 官网首页

本节定义 `apps/docs` 的内容架构、首页设计、品牌与部署。

### 13.1 域名与部署

- **主域名**：`volund-code.dev`（`.dev` 域强制 HTTPS + 品牌感）
- **备选**：`volundcode.io` / `volund.dev`（需查商标 + 注册占用）
- **部署**：
  - MVP：GitHub Pages + Cloudflare（免费）
  - L2+：Vercel（PR preview + edge functions）
- **备用文档站**：`main.volund-code.dev` / `next.volund-code.dev` 分别对应 main / next 分支

### 13.2 IA（信息架构）

```
volund-code.dev/
├─ /                              # Landing / 首页（见 §13.3）
├─ /docs/
│  ├─ /getting-started/
│  │  ├─ install                  # macOS/Linux/Windows 安装
│  │  ├─ first-run                # 第一次 volund（跟 §14 呼应）
│  │  ├─ 5min-tutorial            # 5 分钟完成一个真实任务
│  │  └─ next-steps
│  ├─ /concepts/
│  │  ├─ agent-loop               # Runner / Event / Turn
│  │  ├─ providers-and-router     # 多 provider 模型
│  │  ├─ tools-and-permissions    # tool + permission + sandbox
│  │  ├─ skills-vs-plugins        # 何时用哪个
│  │  ├─ system-prompt-model      # PromptComposer
│  │  └─ security-model
│  ├─ /guides/
│  │  ├─ configure-providers      # 各家 provider 登录方法
│  │  ├─ writing-a-skill          # 从零写一个 skill
│  │  ├─ writing-a-plugin         # 用 plugin-sdk 开发
│  │  ├─ integrating-mcp          # 接入 MCP server
│  │  ├─ custom-hooks             # 用户 hook
│  │  ├─ team-agent-md            # 项目级 AGENT.md 最佳实践
│  │  └─ automating-with-json     # --json 模式脚本化
│  ├─ /reference/
│  │  ├─ cli                      # 所有子命令 + flag（§11 生成）
│  │  ├─ config                   # config.toml 全 schema
│  │  ├─ plugin-sdk               # TypeDoc 生成
│  │  ├─ tools                    # 内置工具 API
│  │  ├─ hooks                    # 10 hook 点
│  │  ├─ events                   # 19 事件（r13：+2 shell 后台事件；payload 字段表 = 附录 D）
│  │  └─ permissions              # PermissionSpec 参考
│  ├─ /cookbook/
│  │  ├─ code-review-workflow     # 用 volund 做 code review（r13：随 §17 功能落地，L2 起有真实支撑）
│  │  ├─ writing-tests            # TDD 流程
│  │  ├─ refactoring              # 大规模重构
│  │  ├─ ci-integration           # 在 CI 里跑 volund（r13：含 §17 review --severity-gate CI gate 模板，L4）
│  │  └─ team-workflows
│  └─ /troubleshooting/
│     ├─ sandbox-issues
│     ├─ auth-issues
│     └─ common-errors
├─ /plugins/                      # 官方推荐 / 社区插件目录（v2 registry）
├─ /skills/                       # 官方推荐 skills
├─ /blog/                         # 发版说明 / 深度技术文
├─ /changelog                     # 从 CHANGELOG.md 自动同步
├─ /roadmap                       # 从 spec §10 提炼
├─ /community                     # Discord / GitHub Discussions / Contributing 入口
└─ /brand                         # logo / 素材下载（v2）
```

**放弃的内容**：**内部设计 spec（`docs/superpowers/`）不进入官网**，仅在仓库内可见。

### 13.3 官网首页 wireframe

```
┌───────────────────────────────────────────────────────────────────────┐
│ [VOLUND CLI logo]  Docs  Plugins  Blog  GitHub ⭐ 12.3k     [Install]│  ← Sticky nav
├───────────────────────────────────────────────────────────────────────┤
│                                                                       │
│         The open, model-agnostic AI coding CLI                        │  ← Hero H1
│         Own your terminal. Choose your model.                         │  ← Sub-h
│                                                                       │
│         ┌─────────────────────────────────────────────┐              │
│         │ $ npm install -g volund-cli                 │  ← One-liner  │
│         │ $ volund                                     │     copyable │
│         └─────────────────────────────────────────────┘              │
│                                                                       │
│         [Get Started]  [Watch demo (2 min)]                          │  ← Primary CTAs
│                                                                       │
├───────────────────────────────────────────────────────────────────────┤
│           [ ANIMATED TERMINAL DEMO GIF / ASCIINEMA ]                  │  ← Above the fold
├───────────────────────────────────────────────────────────────────────┤
│                        Why Volund CLI                                │
│                                                                       │
│   ✱ Multi-provider          ✱ Safe by default        ✱ Extensible    │
│   Not tied to one LLM.       Rust sandbox +           JS plugin SDK   │
│   Route across             explicit permissions.    + MCP + Skills.   │
│   Claude / GPT / Gemini /                                             │
│   Ollama.                                                             │
│                                                                       │
│   ✱ Terminal-native         ✱ Local-first             ✱ Open source  │
│   Ink-powered TUI,           No cloud lock-in.         Apache-2.0.    │
│   works over SSH,            Sessions and configs      Auditable      │
│   integrates with your       in plain files.           end to end.    │
│   shell.                                                              │
│                                                                       │
├───────────────────────────────────────────────────────────────────────┤
│                    From 0 to productive in 3 steps                    │
│                                                                       │
│   1. Install         2. Login                 3. Ask                  │
│   npm i -g volund-cli   volund login anthropic   volund "fix this bug" │
│                                                                       │
├───────────────────────────────────────────────────────────────────────┤
│                        See it in action                                │
│                                                                       │
│   [ Short 30-second GIF: volund does a real task ]                    │
│   Caption: "Volund refactoring 3 files, running tests, opening PR"    │
│                                                                       │
├───────────────────────────────────────────────────────────────────────┤
│              Built for developers who want control                    │
│                                                                       │
│   Concepts diagram: [ user → volund → router → provider ]             │
│                       [           ↑ sandbox     ]                     │
│                                                                       │
│   • Own your prompts (AGENT.md convention)                            │
│   • Own your data (JSONL sessions, plain-text config)                 │
│   • Own your extensions (JS plugin SDK, MCP support)                  │
│                                                                       │
├───────────────────────────────────────────────────────────────────────┤
│                      Trust & Security                                 │
│                                                                       │
│   Every destructive action asks. Sandboxed via Rust.                  │
│   Telemetry is off by default and 100% local.                         │
│   Read our SECURITY.md.                                               │
│                                                                       │
├───────────────────────────────────────────────────────────────────────┤
│                     Community & Ecosystem                             │
│                                                                       │
│   [GitHub logo]    [Discord logo]    [Twitter logo]                   │
│   x contributors    y users online    latest updates                  │
│                                                                       │
│   [Explore plugins]  [Read the blog]  [Join Discord]                  │
│                                                                       │
├───────────────────────────────────────────────────────────────────────┤
│  Docs      Community    Company     Legal                             │
│  Get       GitHub       Roadmap     License                           │
│  Started   Discord      Blog        Security                          │
│  API       Discuss      Changelog   Privacy                           │
│                                                                       │
│  © 2026 Volund CLI contributors. Licensed under Apache-2.0.          │
└───────────────────────────────────────────────────────────────────────┘
```

### 13.4 视觉与品牌

**当前 production identity**（与 README、TUI、favicon、首页同源）：

| 元素 | MVP 决策 |
|---|---|
| Logo | pixel hammer + terminal cutout + `>_`；窄布局使用 `V[>_]LUND CLI`，禁止恢复太阳/神庙/宇航头盔隐喻 |
| 主色 | Forge Black + Forge Teal `#2BBD9B`；单色时仍以锤子轮廓识别 |
| 字体 | Inter（正文）+ JetBrains Mono（代码） |
| 语气 | Direct、technical、no-BS；避免 marketing 套话 |
| 深色模式 | 强制支持（开发者友好） |

**Canonical wordmark**：`VOLUND CLI`；终端 compact lockup 为 `V[>_]LUND CLI`。所有确定性源资产必须从 pixel hammer 母形派生，不能为 docs、TUI 与 favicon 分别设计互不相干的标志。

**素材页 `/brand`**（v2）：SVG logo / PNG / 色卡下载 + 使用规范。

### 13.5 内容优先级（L1 首发）

L1 发布时至少要有：

必需：
- [x] Landing 首页
- [x] `/docs/getting-started/install`
- [x] `/docs/getting-started/first-run`
- [x] `/docs/getting-started/5min-tutorial`
- [x] `/docs/concepts/agent-loop`（简版）
- [x] `/docs/concepts/security-model`
  - ★ L1 起该页**必须**含 **Prompt Injection Threat Model** 段：定义可信指令源（用户直接输入 + system prompt）vs 非可信数据源（tool_result / webfetch / MCP / 文件 / subagent / memory），解释 `<untrusted source="...">` wrapper 机制（§6.5.0a）、untrusted 标签的 best-effort 性质、以及用户如何识别注入企图。配套 §6.5.1 内置 prompt 的 "Untrusted content" 段。
- [x] `/docs/reference/cli`（自动生成）
- [x] `/docs/troubleshooting/*`（3-5 篇常见问题）

推迟：
- Cookbook / Guides 全部 → L2
- API reference 完整 → L2（TypeDoc）
- Blog → 首发那天来 1 篇发布公告
- Plugins/Skills 目录 → L3（有内容时）

### 13.6 内容生成自动化

- **CLI reference** 从 `apps/cli` 的 citty 定义 **代码生成 markdown**（`pnpm docs:gen:cli`）
- **配置 schema reference** 从 zod schema 生成（`zod-to-doc`；源头 = 附录 C）
- **API reference** 从各 package 的 TypeDoc（`pnpm docs:gen:api`）
- 手写内容与生成内容分开目录：`content/` vs `generated/`，避免误覆盖
- CI 每次发版重跑生成，diff 大时提示 PR
- ★ **r13-D1：手写 reference 与 CLI 定义的漂移检测（过渡期强制）**：在代码生成完全覆盖前，CI 跑 `pnpm docs:verify:cli`——比对 `content/reference/cli.md` 手写的命令/flag 清单与 citty 实际定义的 diff；不一致 → CI fail 并列出漂移项（命令改名 / flag 增删）。防止 r11/r12 审计发现的"文档说有的命令实现没有"再次发生。生成覆盖完成后（`content/reference/cli.md` 改为纯生成）此脚本自然退化为空 diff。

### 13.7 SEO / 分析

- OpenGraph / Twitter Card meta（VitePress 支持）
- Sitemap.xml 自动生成
- **MVP（L1）不加任何行为分析**（与 §13.8 边界"官网不加行为追踪脚本"一致；隐私价值观优先）
- **L2 起评估 Plausible.io**（自托管或 cloud，均配置为 cookie-less + 不采集 IP/UA）：
  - **必须**在隐私页 `/privacy` 显著声明使用 Plausible + 说明采集范围（聚合 pageview，不含用户标识）
  - **必须**提供 opt-out 链接（Plausible 的 "My site is privacy-friendly" widget）
  - 自托管（`plausible.volund-code.dev`）优先于 cloud，进一步降低数据出域
- **永久不加**：Google Analytics（与 volund 隐私价值观矛盾）

> **与产品隐私强约束的关系**：`[AGENT.md §4.13](../../../AGENT.md#413-遥测隐私强约束)` + spec [§8.7](./08-session-config.md#87-telemetry默认本地) 管 **volund CLI 运行时的 telemetry**（默认本地，OTel opt-in）；本节管**官网 volund-code.dev 的访客分析**。两者都是隐私强约束场景，MVP 一致取最保守口径（CLI 不出网 + 官网不追踪），L2+ 再各自评估 opt-in/opt-out 方案。

### 13.8 边界与安全清单

| 规则 | 强制点 |
|---|---|
| `apps/docs` **禁止**发布 npm | `"private": true` |
| 生成的 CLI/API reference **必须** CI 每次发版更新 | GitHub Action |
| 官网**不加**行为追踪脚本（隐私价值观一致性） | code review |
| 品牌素材 `/brand` 明确 Apache-2.0 与 trademark 分离声明 | v2 时定 |
| `/blog` 每篇文章底部**必须**署名 + license 声明 | 模板强制 |
| 首页 install 一行命令**必须** copy-to-clipboard 且**不带**执行推荐（不用 `curl \| sh` 反 pattern） | code review |

### 13.9 里程碑

- **L1（MVP）**：域名 + Landing + Getting Started 3 篇 + Concepts 2 篇 + CLI reference + Troubleshooting；GitHub Pages 部署
- **L2**：完整 Guides / Cookbook / API reference；Vercel + preview；blog 首篇
- **L3**：Plugins/Skills registry 目录页；社区分区
- **L4**：设计升级（专业设计师）+ `/brand` 素材页 + i18n 中文版
