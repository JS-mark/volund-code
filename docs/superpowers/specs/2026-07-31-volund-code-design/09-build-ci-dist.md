> ↩ [返回索引 (README)](./README.md) · ← [上一章: §8 会话与配置存储](./08-session-config.md) · [下一章: §10 里程碑 L1 → L4](./10-milestones.md) →

---

## §9 构建 / CI / 分发

本节定义 TypeScript + Rust 双栈的构建链路、CI 矩阵、发布流程。

### 9.1 构建栈

| 层            | 工具                                            |
|---------------|-------------------------------------------------|
| TS 库         | **rolldown**（Vite 8 底层）单文件 ESM 产物         |
| TS 应用       | rolldown（apps/cli 打成单 bin）                  |
| 文档站        | **VitePress 8**（apps/docs，静态站）              |
| Rust 产物    | **cargo**（三产物均为独立二进制：sandbox bin + search/fs worker bin，r9 改造，原 napi-rs addon 作废） |
| Monorepo 编排 | **turborepo**（`turbo run build`）                |
| Package mgr   | **pnpm** workspace + catalog（统一版本）          |
| TypeDoc       | 每个 package 生成 API 文档 → 注入 apps/docs        |

### 9.2 pnpm workspace

`pnpm-workspace.yaml`：

```yaml
packages:
  - 'apps/*'
  - 'packages/*'
  - 'platforms/*'
  - 'examples/*'

catalog:
  # 统一版本管理（所有 packages 引用 catalog:）
  typescript: ^5.6.0
  react: ^19.0.0
  ink: ^5.0.0
  vitest: ^2.0.0
  vitepress: ^2.0.0
  rolldown: ^1.0.0
  vite: ^8.0.0
  zod: ^3.23.0
  immer: ^10.1.0
  # ...
```

### 9.3 turbo pipeline

`turbo.json`（要点）：

```jsonc
{
  "pipeline": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**", "bin/**"]
    },
    "build:native": {
      "outputs": ["bin/**", "target/release/**"]
    },
    "test": {
      "dependsOn": ["build"]
    },
    "typecheck": {
      "dependsOn": ["^build"]
    },
    "docs:build": {
      "dependsOn": ["^build"],
      "outputs": ["apps/docs/.vitepress/dist/**"]
    }
  }
}
```

**依赖顺序**：
- kits（provider-kit / tool-kit）→ core → router / providers / tools → apps
- shared 是根，最先 build
- native-bridge 在 tools / auth 之前 build

### 9.4 CI Matrix

> **产品硬约束（r9 分层，见 [SANDBOX-COMPAT-r1](./SANDBOX-COMPAT-r1.md) §S1）**：沙箱必须在 **mac/linux 4 target（L1 硬约束）** 全部落地；**L2 扩至 8 target（补 Windows Tier1 + Linux musl）为全平台硬约束**。对应里程碑发版前必须通过 native job + 每 target 真机 escape 测试。

**`.github/workflows/ci.yml`**：

```yaml
jobs:
  ts:
    matrix: [ubuntu-24.04, macos-14, windows-2022]
    steps: pnpm install → pnpm turbo run typecheck test build

  license-check:
    # 拒绝 GPL/AGPL/SSPL/BUSL 进依赖树；codex workspace 依赖只减不增
    runs-on: ubuntu-24.04
    steps:
      - cargo deny check licenses bans
      - 检查 codex-* 依赖数量 ≤ 上次 release（只减不增，违反则 fail）

  native:
    needs: [license-check]
    strategy:
      fail-fast: false
      matrix:
        include:
          # ── L1（4 target，mac/linux glibc）──
          - { runner: macos-14,       target: aarch64-apple-darwin,       mode: native, tier: L1 }
          - { runner: macos-13,       target: x86_64-apple-darwin,        mode: native, tier: L1 }
          - { runner: ubuntu-24.04,   target: x86_64-unknown-linux-gnu,   mode: native, tier: L1 }
          - { runner: ubuntu-24.04,   target: aarch64-unknown-linux-gnu,  mode: cross,  tier: L1 }
          # ── L2 补（4 target，musl + Windows）──
          - { runner: ubuntu-24.04,   target: x86_64-unknown-linux-musl,  mode: cross,  tier: L2 }
          - { runner: ubuntu-24.04,   target: aarch64-unknown-linux-musl, mode: cross,  tier: L2 }
          - { runner: windows-2022,   target: x86_64-pc-windows-msvc,     mode: native, tier: L2 }
          - { runner: windows-11-arm, target: aarch64-pc-windows-msvc,    mode: native, tier: L2 }
          # Azure 兜底（仅当 windows-11-arm 队列 > 30 min 时启用；预算上限 $200/月）
          # - { runner: [self-hosted, azure, win-arm64], target: aarch64-pc-windows-msvc, mode: native, tier: L2 }
    steps:
      - cargo build --release --target ${{ matrix.target }}   # 三产物均独立二进制（sandbox + search worker + fs worker）
      - lipo -create ...      # macOS 两 target 完成后合并 universal2（r9 后 search/fs 也可合并）
      - # Linux target: 校验 bundled bwrap 二进制 SHA256 与 BWRAP_DIGEST.txt 一致
        if: matrix.target contains 'linux'
        run: volund-sandbox --verify-bwrap-digest
      - 打包到 platforms/<crate>-<triple>/（L1 仅 tier=L1 的 4 target 入发版包；L2 补齐）

  sandbox-escape:
    # 每 target 独立跑；沙箱声明 Full/Partial 时必须全部拒绝越界操作
    needs: [native]
    strategy:
      fail-fast: false
      matrix: (同上 native.matrix，按 tier 分层：L1 跑 4 组合，L2 跑全 8 组合)
    steps:
      - 加载 volund-sandbox 产物 + 平台探针（codex get_platform_sandbox: seatbelt/bwrap+seccomp/landlock ABI/Job 版本）
      - 跑 escape 用例（复用 codex sandbox_smoketests.py + seatbelt_tests.rs + landlock_tests.rs + windows wrapper_tests.rs）
      - cross target 走 QEMU user-mode 或 Alpine arm64 容器；结果标 partial-verified
      - 上报 sandbox.tier + escape.pass_ratio → CI artifact + release notes

  e2e:                                   # ★ r13-T2：e2e smoke（L1 起，依赖 §6.13 testkit）
    needs: [ts]
    runs-on: ubuntu-24.04
    steps:
      - pnpm turbo run test --filter=e2e
      # 用 testkit.MockProvider 脚本化完整交互（不走真 provider）：
      #   user msg → 流式 + tool_use(Read) → tool_result → tool_use(Edit) → 落盘
      # 断言：backup 生成 / JSONL 事件序符合 §2.3 期望序 / 权限弹窗快照 /
      #       JSONL 可 replay 且 SessionState 等价

  release:
    if: startsWith(github.ref, 'refs/tags/v')
    needs: [ts, license-check, native, sandbox-escape]
    steps:
      - changeset publish   → npm + GitHub Release（L1: 12 平台包 = 4 target × 3 crate；L2: 24 平台包 = 8 target × 3 crate；+ volund-code + fs-common）
      - authenticode sign   → Windows 二进制（L2 起自签，L4 前升级 EV 证书）
      - notarize            → macOS 二进制（L2 起）
      - 生成 SBOM (cyclonedx-cli) + sha256 校验清单 + bwrap digest 清单
```

**CI 硬约束**（release-blocking，r9 分层）：
1. **L1: mac/linux 4 target 任一失败 → 全 CI 红，不允许 release**；L2 扩至 8 target 任一失败同理
2. `sandbox-escape` 每 target 必须至少运行一次基础用例集（L1 跑 4 组合，L2 跑全 8 组合；详见 [SANDBOX-COMPAT-r1](./SANDBOX-COMPAT-r1.md) §S8）
3. `windows-11-arm` runner queue 长时的兜底策略：Azure Windows-on-ARM VM（预算 $200/月上限，见 ADR-2；仅 L2 起 Windows 入 CI 时生效）
4. Cross-build target（arm64 Linux / musl x2）→ QEMU user-mode 跑 escape；QEMU 下 landlock 行为不确定的用例标 `partial-verified` 并强制 real-hardware 抽检（L2 起接入 AWS Graviton spot）

### 9.5 发版策略

**工具**：`changesets`（版本号 + changelog）

**流程**：
1. 开发者提 PR 时，若改动需发版 → `pnpm changeset` 生成 `.changeset/*.md`
2. PR 合入 main 后，`changesets` bot 打开 "Version Packages" PR
3. 合入 Version PR → tag 触发 CI `release` job：
   - `changeset publish` 发所有 packages 到 npm（**L1: 12 个平台包** = 4 target × 3 crate；**L2: 24 个平台包** = 8 target × 3 crate；产物均为独立二进制；详见 [`05-rust-sidecar.md §5.9`](./05-rust-sidecar.md) 与 [SANDBOX-COMPAT-r1 §S2](./SANDBOX-COMPAT-r1.md)）
   - `apps/cli` 单独发 `volund-code` 包（bin）
   - `apps/docs` **不发** npm，`docs:deploy` job 部署到 GitHub Pages / Vercel
4. GitHub Release 附带 changelog + 二进制 archive（可选，方便非 npm 用户）

**版本语义**：
- kits（provider-kit / tool-kit / plugin-sdk） → semver 严格，major 需广而告之
- provider-* / tools → semver
- volund-code（cli）→ semver
- 平台包 → 与 native-bridge 同版本号（`workspace:*`）

**兼容性**：
- `plugin-sdk` major = volund major；volund 支持 sdk 最近 2 个 major（宽松兼容）
- `mcp-client` 兼容 MCP protocol 版本

**★ 供应链动作（r13-S1/S2）**：

1. **L1 发版前注册 npm org**（`@volund` scope 保护——无论最终走 npm 平台包还是 GitHub Release 分发（r12 REM-45 换轨认定），主包与 SDK 都必须在 scope 下，防抢注/仿冒；正式发布前仍需完成 registry owner clearance）。
2. **L2 起发布带 provenance**：GitHub Actions OIDC 免签溯源（npm provenance statement），与 bwrap digest 校验形成二进制供应链双保险。
3. **NOTICE 补归属**：tiktoken-rs / BPE 数据（MIT）——native BPE 数据来源声明进 `NOTICE` 文件（L1 发版前）。

> 注：分发模型本身（npm 平台包 vs GitHub Release）的换轨认定属 r12 REM-45（BDFL 决策）；上述三条无论哪个方向都成立。

### 9.6 apps/cli 打包与分发（r13.2 修订）

- rolldown 打成 `dist/volund.js`（单文件 ESM + minify + treeshake）——它是二进制的**编译原料**与本地开发入口，不再是 npm 面向用户的形态
- **npm 渠道 = 二进制薄壳**（r13.2 起，2026-08-27 品牌迁移修订）：发布 7 个平台包 `@volund/<triple>`（各含 bun 单文件二进制 + native sidecar + 内置插件，os/cpu/libc 字段让包管理器跳过不匹配平台）+ canonical meta 包 `volund-cli`（`bin: bin/volund.cjs` 壳，按宿主 triple 解析平台包并 spawn 转发）。`npm i -g volund-cli` 提供 canonical `volund` 命令并保留 `volund` alias；同一 pack step 还生成 legacy `volund-code` 兼容 meta 包，发布顺序为平台包 → `volund-cli` → `volund-code`
- 平台包由 `scripts/build-all-standalone.mjs`（native.yml `standalone` job，bun `--compile --target` 跨编译）+ `scripts/pack-standalone-npm.mjs` 生成；**不进 pnpm workspace、不经 changesets 版本化**（发布 workflow 在 tag 检出上按 apps/cli 版本打戳），与 ADR-native-github-release 的副作用面零冲突——sidecar 单体的 GitHub Release 分发不变
- **win32-arm64-msvc 例外**：bun 无 `bun-windows-arm64` 编译目标；Windows arm64 由 `@volund/win32-x64-msvc` 包覆盖（`cpu` 同列 arm64，Prism 仿真，仿真进程内 `process.arch=x64` 与包内 x64 sidecar 自洽）
- Homebrew / apt 通道（v2）：`brew install volund-code`
- ~~独立二进制（v2）：bun build --compile 或 pkg 打进 Node runtime~~ → r13.2 已落地为上述薄壳模型（pkg 因 RFC 否决，仅 bun）


### 9.7 apps/docs 部署

- VitePress 8 静态站
- 内容来源：
  - `apps/docs/content/**/*.md` 手写（快速入门 / 概念 / 使用 / 教程）
  - `packages/*/src/**` 通过 **TypeDoc** 生成 API reference → 输出到 `apps/docs/api/`
  - `docs/superpowers/specs/**` **不入**文档站（内部设计文档）
- CI 流程：
  - PR 时构建 preview（Vercel）
  - main 合入自动部署 GitHub Pages 或 Vercel production
  - **不发 npm**（`"private": true`）

### 9.8 边界与安全清单

| 规则                                                                              | 强制点                                          |
|-----------------------------------------------------------------------------------|-------------------------------------------------|
| `apps/docs` **禁止**发布 npm（`"private": true`）                                  | package.json + release CI 校验                  |
| CI **必须**在所有平台跑通 typecheck / test / build 才允许 release                  | GitHub branch protection                        |
| **L1: mac/linux 4 native target + 4 sandbox-escape job 全绿**才允许发 L1 stable；L2 扩至 8+8 全绿才允许发 L2 stable | branch protection + release CI needs 链         |
| `windows-*.exe` **必须**至少 Authenticode 自签（L2+，r9 调整：Windows 推 L2），L4 升级 EV                     | release CI + release notes 显式标注证书类型     |
| `volund-code.pkg` / `volund-code.dmg` **必须** notarize（L2+）                        | release CI                                       |
| `changesets` **必须**在改动 kits 时提示 major bump                                  | changeset config                                 |
| **沙箱降级**（Tier ≠ Full）必须在 release notes 标注具体 target + 原因                | release CI 自动生成                              |
| 依赖升级**必须**通过 Renovate PR + CI 通过；禁止手动改 lock                          | GitHub workflow                                  |
| `pnpm-lock.yaml` **必须**在 CI 校验一致（`--frozen-lockfile`）                       | CI ts job                                        |

### 9.9 里程碑

（与 [`§10 里程碑`](./10-milestones.md) 与 [SANDBOX-COMPAT-r1 §S10](./SANDBOX-COMPAT-r1.md) 保持同步）

- **L1（MVP，8-12 轮 AI 迭代，r10 口径）**：pnpm workspace + turbo build + **mac/linux 4 native target CI + 4 sandbox-escape job + license-check + bwrap-digest 校验** + changesets + macOS 双架构 lipo → universal2 + **vendor codex 沙箱三件套** + **search/fs 改独立二进制 worker（r9 架构变更）**

> **时间口径说明（r10 校准）**：本节早期版本（r9）用「3-4 周（单人）」墙钟口径，与 [§10](./10-milestones.md)（r10 已改「AI 迭代轮数」口径：L1 = 8-12 轮）矛盾。**以 §10 为准**——本项目由 AI 完全开发、人定方向（[§12.6b](./12-open-governance.md#126b-ai-native-开发协作约定r10-新增)），实际墙钟时间取决于人在环检查点响应速度，AI 可 7×24 写代码但人审批串行。设计文档不承诺发布日期，以主分支 changeset 为准。
- **L2**：docs 部署 + TypeDoc 集成 + Renovate + macOS notarize + **平台扩面（Windows Tier1 + musl，CI 扩至 8 native + 8 escape，平台包 12→24）** + Windows authenticode 自签 + Windows Tier 2 (AppContainer) 全平台 escape 通过
- **L3**：Rust binary EV 签名迁移 + preview 环境 + Windows Tier 3 (WFP) + AWS Graviton 真机抽检
- **L4**：独立二进制（bun compile / pkg）+ Homebrew tap + winget / apt 通道 + SBOM 自动上链

> 每个 L 级别的**发版硬门**（r9 分层）：L1 = `ts` + `native` (4 组合) + `sandbox-escape` (4 组合) 全绿；L2+ 扩至 8+8 全绿；任一 target Tier 降级须显式在 release notes 声明。

### 9.10 性能预算表（r13 新增，P2/P5/T4）

> spec 此前几乎无量化性能预算——AI 实现会以"能跑"为标准，性能劣化无验收线。下表为**超标即性能 bug** 的预算（bug 报告 / 回滚依据），CI 采集基线（对应 §9.4 e2e job 附带计时采样）。

| 指标                                        | 预算    | 测量方式                             | 里程碑 |
|---------------------------------------------|---------|--------------------------------------|--------|
| 冷启动（输入符可见，**不含** native 探测等待，§5.8 时序契约） | ≤ 500ms | CI 计时（e2e job）          | L1     |
| 热启动（`resume tailTurns=20`，50MB JSONL fixture） | ≤ 2s | CI fixture（sessionFixture 变体） | L1     |
| 主进程 RSS 基线（无插件 / 无 worker）         | ≤ 300MB | CI 采样                              | L1     |
| 单 worker（search / fs）RSS（idle）          | ≤ 150MB | CI 采样（idle 回收兜底 §5.6.1）      | L1     |
| `@` picker 首帧（10 万文件 fixture，§7.5.3）  | ≤ 150ms | ui 单测计时                          | L2     |
| provider 首 token 框架开销（网络除外，MockProvider 计时） | ≤ 300ms | mock 计时                  | L1     |

**配套（T4 性能回归）**：e2e job 把上表测量结果写 CI artifact（JSON），趋势劣化 > 20% 且破线 → 标 `perf-regression` label（不 block，周报 review）；破线本身 = 性能 bug 进 issue。基线首次测量落在 L1 完成时，此后每 tag 更新基线。


---

## 变更日志

| 日期 | 版本 | 内容 |
|---|---|---|
| 2026-08-27 | §9 r13.3 | npm canonical identity 迁移为 `volund-cli` + `@volund/*`；同一 pack step 生成 `volund-code` compatibility meta 包并共享平台依赖图，发布顺序冻结为平台包 → canonical meta → legacy shim；live registry owner clearance 与真实 publish 仍需人工门禁。 |
| 2026-08-25 | §9 r13.2 | npm 渠道切换为二进制薄壳（§9.6）：7 个 `@volund/<triple>` 平台包 + `volund-code` 壳包；native.yml 新增 `standalone` job（bun `--compile --target` 跨编译，win32-arm64 无 bun 目标由 x64 包 Prism 仿真覆盖）并把 `volund-standalone-<triple>.tar.gz` 挂上 Release；新增手动 dispatch 的 `publish-npm.yml`（tag 一致性门禁 → Release 资产 sha256 校验 → 重组装 → `--provenance` 发布，平台包先于 meta 包）。自动 publish 门禁不变。 |
| 2026-08-16 | §9 r13.1 | r13 修正落地：§9.4 新增 `e2e` smoke job（T2，MockProvider 脚本化交互 + JSONL replay 断言）；§9.5 新增供应链三条——npm org 抢注防护（L1 前）/ provenance（L2 起）/ NOTICE tiktoken-rs 归属（S1/S2）；新增 §9.10 性能预算表 + CI 基线采集（P2/P5/T4）。 |
| 2026-08-01 | §9 r10.1（一致性修复） | §9.9 L1 时间口径对齐 §10：删除"3-4 周（r9 单人口径）"，改"8-12 轮 AI 迭代（r10）"+ 加口径说明段，消除 §9 ↔ §10 的时间估算矛盾（复审 P1）。 |
