<p align="center">
  <img src="docs/assets/readme-hero.svg" alt="Volund CLI——让编程智能体始终可见、可控、可检查" width="100%" />
</p>

<p align="center">
  <strong>面向专业开发者的开源编程基础设施：获得智能体的速度，不交出对系统的控制。</strong>
</p>

<p align="center">
  <a href="#快速开始"><strong>快速开始</strong></a> ·
  <a href="apps/docs/zh/index.md"><strong>中文文档</strong></a> ·
  <a href="README.md"><strong>English</strong></a>
</p>

<p align="center">
  <a href="LICENSE"><img alt="Apache 2.0" src="https://img.shields.io/badge/license-Apache_2.0-2bbd9b?style=flat-square&labelColor=101515" /></a>
  <img alt="Node 20.19+" src="https://img.shields.io/badge/node-%E2%89%A520.19-2bbd9b?style=flat-square&labelColor=101515" />
  <img alt="pnpm 11.10" src="https://img.shields.io/badge/pnpm-11.10-2bbd9b?style=flat-square&labelColor=101515" />
  <a href="CONTRIBUTING.md"><img alt="欢迎贡献" src="https://img.shields.io/badge/PRs-welcome-2bbd9b?style=flat-square&labelColor=101515" /></a>
  <img alt="早期开发" src="https://img.shields.io/badge/status-early_development-f0b35a?style=flat-square&labelColor=101515" />
</p>

Volund CLI 把智能体式编程循环带到命令行，同时让目录信任、操作权限、凭据与沙箱状态保持清晰可见。项目围绕明确的模型供应商边界、可恢复的文件修改、机器可读输出和原生隔离能力设计。

> [!IMPORTANT]
> Volund CLI 仍处于早期开发阶段，尚未发布稳定 npm 包。目前请从源码安装，用于体验和开发；首个稳定版本发布前，接口和行为仍可能变化。

## 目录

- [目录](#目录)
- [为什么选择 Volund CLI](#为什么选择-volund-cli)
- [目前已经可用的能力](#目前已经可用的能力)
- [快速开始](#快速开始)
  - [环境要求](#环境要求)
  - [从源码构建](#从源码构建)
  - [开始第一次会话](#开始第一次会话)
- [常用方式](#常用方式)
- [配置与安全](#配置与安全)
- [项目架构](#项目架构)
- [参与开发](#参与开发)
- [路线图与项目状态](#路线图与项目状态)
- [贡献与支持](#贡献与支持)
- [许可证](#许可证)

## 为什么选择 Volund CLI

| 默认保持控制                                                          | 面向真实工作流                                                     | 每一层都保持开放                                                  |
|-----------------------------------------------------------------------|--------------------------------------------------------------------|-------------------------------------------------------------------|
| **显式目录信任**<br>启动供应商、工具或会话前，先确认真实目录和信任范围。 | **可恢复会话**<br>从可靠的轮次边界续接，并在恢复文件前预览影响。     | **供应商无关核心**<br>把模型适配与路由从智能体循环中分离出来。     |
| **细粒度权限**<br>对写文件、执行命令和访问网络分别授权。                | **原生隔离能力**<br>使用 Rust 实现的沙箱、搜索和文件系统辅助程序。   | **可组合运行时**<br>通过带命名空间的插件、技能、工具和 MCP 扩展。    |
| **安全状态可见**<br>检查凭据、沙箱等级、目录信任与运行环境健康度。       | **为自动化而生**<br>输出版本化 NDJSON，不混入 ANSI 或 TUI 界面内容。 | **架构可检查**<br>清晰追踪 TypeScript 包与 Rust crate 之间的边界。 |

## 目前已经可用的能力

当前 CLI 已包含：

- Ink 交互式终端界面和纯行模式聊天；
- 单次提示词执行，以及供脚本使用的 NDJSON 输出；
- 目录信任规则与项目配置审批；
- 模型供应商凭据的登录、退出和安全存储；
- 权限检查、原生沙箱集成和运行环境诊断；
- 会话历史、续接与带保护的恢复流程；
- 本地插件的安装、启用、禁用、诊断、查看与卸载；
- 本地遥测数据的查看、脱敏导出与清理；
- 可配置的供应商/模型路由，包括按角色选择候选模型。

完整命令以[中文 CLI 参考](apps/docs/zh/docs/reference/cli.md)为准。在敏感仓库中使用前，请先阅读[安全模型](apps/docs/zh/docs/concepts/security-model.md)。

## 快速开始

### 环境要求

- Node.js 20.19 或更高版本
- pnpm 11.10.0（通过 Corepack 管理）
- 本地构建原生 crate 时需要 Rust 1.71 或更高版本

### 从源码构建

```bash
git clone https://github.com/JS-mark/volund-code.git
cd volund-code
corepack enable
pnpm install --frozen-lockfile
pnpm build
node apps/cli/dist/volund.js --help
```

兼容窗口期内，源码构建仍保留 `dist/volund.js` 这个内部文件名。标准 npm 包为 `volund-cli`，平台包使用 `@volund/*` scope；安装后以 `volund` 为标准命令，并保留 `volund` 别名。旧 `volund-code` 仅作为兼容 meta 包生成。

当前 workspace 中的 `0.0.0` 只是开发版本号，并不是已经发布的 npm 版本。发布状态和原生二进制说明请查看[中文安装指南](apps/docs/zh/docs/getting-started/install.md)。

### 开始第一次会话

```bash
node apps/cli/dist/volund.js chat
```

第一次在某个目录运行时，Volund 会先显示解析后的真实目录并询问信任范围，然后才初始化运行时。首次引导中可选择 Anthropic，并只在 Volund 的掩码输入框中填写凭据；也可以单独登录并运行严格诊断：

```bash
node apps/cli/dist/volund.js login anthropic
node apps/cli/dist/volund.js doctor --strict
```

目录信任范围、无头模式行为和沙箱检查详见[首次运行指南](apps/docs/zh/docs/getting-started/first-run.md)。

## 常用方式

当标准输入和输出均为终端时，默认启动交互式聊天：

```bash
node apps/cli/dist/volund.js
node apps/cli/dist/volund.js chat
```

强制使用纯行模式：

```bash
node apps/cli/dist/volund.js chat --no-tui
```

执行一次提示词并输出不含 ANSI 界面的 NDJSON：

```bash
node apps/cli/dist/volund.js chat "概括这个代码仓库" --json
```

查看运行状态，或管理之前的会话：

```bash
node apps/cli/dist/volund.js status --json
node apps/cli/dist/volund.js history list
node apps/cli/dist/volund.js resume <session-id>
node apps/cli/dist/volund.js restore <session-id> --dry-run
```

保存项目级长期知识，并把选定记忆固定注入后续提示词：

```bash
node apps/cli/dist/volund.js memory add --id package-manager --tag tooling --content "使用 pnpm"
node apps/cli/dist/volund.js memory pin package-manager
node apps/cli/dist/volund.js memory list --scope project --pinned --json
```

Pinned memory 受固定预算限制，并以不可信建议数据注入；当前用户和 system 指令始终优先。执行 `memory unpin` 或 `memory delete --yes` 后，后续提示词不再注入该内容。

全部命令请运行 `volund help` 或查看[中文 CLI 参考](apps/docs/zh/docs/reference/cli.md)。自动化输出协议见英文版 [JSON 输出参考](apps/docs/docs/reference/json-output.md)；该页面目前尚无对应中文版本。

## 配置与安全

> [!NOTE]
> A 阶段先迁移用户可见品牌与命令。npm package graph 现已使用 `volund-cli` / `@volund/*`，并保留 `volund-code` 兼容 meta 包；本地数据、环境变量和机器可读 schema 标识仍是这一版本线的兼容面。

用户级配置文件位于 `~/.volund/config.toml`。配置按以下优先级合并：内置默认值、全局配置、已批准的项目配置、环境变量、命令行参数。非交互运行默认不会加载项目配置，除非显式传入 `--trust-project-config`；项目配置也不能覆盖路由、身份验证、服务端点和遥测接收端等敏感项。

可信全局配置中的角色路由示例：

```toml
[router]
type = "role"

[router.default]
provider = "anthropic"
model = "claude-sonnet-4-5"

[router.roles.coder]
provider = "anthropic"
model = "claude-sonnet-4-5"
priority = 100
```

需要留意的安全边界：

- 信任目录不等于授权写文件、执行命令或访问网络；
- 无头运行遇到未信任目录会直接失败，除非显式使用 `--trust-workspace`；
- 凭据存放在操作系统钥匙串或加密降级存储中，不写入项目文件；
- `--dangerously-no-sandbox` 需要明确确认风险，不应作为发布验收方式；
- 遥测默认只保留在本地，只有显式配置后才会启用导出端。

更多说明请阅读[目录信任与首次运行](apps/docs/zh/docs/getting-started/first-run.md)、[安全模型](apps/docs/zh/docs/concepts/security-model.md)和[沙箱故障排查](apps/docs/zh/docs/troubleshooting/sandbox.md)。

## 项目架构

```text
终端 / 自动化脚本
        │
        ▼
  apps/cli ──────── 交互界面、命令、JSON 输出
        │
        ▼
 packages/core ──── 会话与智能体循环
   │      │      │
   │      │      └── 工具、权限、上下文、存储
   │      └───────── 模型路由与供应商适配器
   └──────────────── 插件、技能与 MCP 运行时
        │
        ▼
 crates/* ───────── 原生沙箱、搜索和文件系统辅助程序
```

TypeScript workspace 将智能体循环、供应商、工具、权限、存储、UI、插件和原生桥接拆分为独立包；Rust workspace 包含 `volund-sandbox`、`volund-search` 与 `volund-fs`。完整设计见[架构规格](docs/superpowers/specs/2026-07-31-volund-code-design/README.md)。

## 参与开发

安装依赖并执行常规本地检查：

```bash
corepack enable
pnpm install --frozen-lockfile
cargo test --workspace
pnpm typecheck
pnpm test
pnpm build
pnpm format:check
```

使用 `cargo build --workspace --release` 构建优化后的原生二进制。本地诊断原生能力时，先构建 Rust workspace，再把三个二进制路径传给 Volund：

```bash
cargo build --workspace
pnpm --filter volund-cli build
VOLUND_NATIVE_SANDBOX_BINARY="$PWD/target/debug/volund-sandbox" \
VOLUND_NATIVE_SEARCH_BINARY="$PWD/target/debug/volund-search" \
VOLUND_NATIVE_FS_BINARY="$PWD/target/debug/volund-fs" \
node apps/cli/dist/volund.js doctor --strict
```

即使原生二进制构建成功，缺少 Anthropic 凭据仍会使严格诊断失败。处理方式见[身份验证故障排查](apps/docs/zh/docs/troubleshooting/auth.md)。

## 路线图与项目状态

Volund CLI 正按仓库定义的能力等级逐步推进。公开包尚未发布，部分前瞻性设计文档描述的是尚未交付的后续工作；实际实现与测试始终是判断当前能力的依据。

项目计划和验收证据维护在：

- [里程碑规格](docs/superpowers/specs/2026-07-31-volund-code-design/10-milestones.md)；
- [发布就绪证据](docs/releases/)；
- [能力追踪文档](docs/superpowers/specs/2026-07-31-volund-code-design/16-capability-traceability.md)。

目前，直接从 registry/GitHub 安装插件、插件升级以及 L4 开发热重载命令尚未实现。

## 贡献与支持

欢迎参与贡献。请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md)，遵守[行为准则](CODE_OF_CONDUCT.md)；报告安全漏洞前请查看 [SECURITY.md](SECURITY.md)。

- 可复现的缺陷与已确认工作请提交到 [GitHub Issues](https://github.com/JS-mark/volund-code/issues)。
- 问题与想法可在仓库已启用 Discussions 时提交到 [GitHub Discussions](https://github.com/JS-mark/volund-code/discussions)。
- 涉及架构、安全、模型供应商或公共 API 的改动，请遵循贡献指南中的 RFC 流程。

## 许可证

Volund CLI 使用 [Apache License 2.0](LICENSE) 开源。
