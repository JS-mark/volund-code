> ↩ [返回索引 (README)](./README.md) · 关联章节：[§5 Rust 侧车](./05-rust-sidecar.md) · [§9 构建/CI/分发](./09-build-ci-dist.md) · [§10 里程碑](./10-milestones.md) · [§14 Onboarding](./14-onboarding.md) · [REVIEW-r6](./REVIEW-r6.md)

---

# Volund CLI · Rust 沙箱跨平台兼容性白皮书 (r1)

> **状态**：Approved（2026-08-01）
> **文档类型**：架构决策记录 (ADR) + 兼容性规约（Compatibility Spec）
> **范围**：`crates/volund-sandbox` + `packages/native-bridge` 的沙箱能力
> **产品硬约束（r9 分层）**：**L1: mac/linux 4 target（`aarch64-apple-darwin` / `x86_64-apple-darwin` / `aarch64-unknown-linux-gnu` / `x86_64-unknown-linux-gnu`）硬约束全绿为 L1 发版闸门；L2: 扩至全 6 平台组合 / 8 target（补 Windows Tier1 + Linux musl）为全平台发版闸门**

---

## §S1 目标与非目标

### S1.1 硬性目标（不可谈判，r9 分层）

1. **L1: 4-target 全覆盖**（mac/linux）：`aarch64-apple-darwin` / `x86_64-apple-darwin` / `aarch64-unknown-linux-gnu` / `x86_64-unknown-linux-gnu` **每一个都必须在 L1 交付可用的沙箱**。
2. **L2: 扩至 6-target 全覆盖**（补 Windows）：`aarch64-pc-windows-msvc` / `x86_64-pc-windows-msvc` 在 L2 交付（Windows Tier 1 Job+Restricted Token 起步）。
3. **musl 双 target L2 同发**（r9 调整，从 L1 推 L2）：`aarch64-unknown-linux-musl` / `x86_64-unknown-linux-musl` L2 起同期发布（Alpine / static container 用户）。
4. **零系统工具依赖**（r3 修订）：用户 `npm i -g volund-cli` 后**不需要额外装任何系统工具**。沙箱所需的一切（包括 Linux 上的 bwrap）**都随 Volund CLI standalone 布局自带**：bundled bwrap 二进制在编译时嵌入、运行时 SHA256 校验后执行（fork 自 codex 的机制）。这不是"shell out 到系统 bwrap"——用户无需 `apt install bubblewrap`。兼容窗口内旧 `volund-code` meta 包解析到相同 `@volund/<triple>` 平台布局。
5. **一等公民**：沙箱是 Volund CLI 的核心卖点，与 §4 权限体系正交但同等重要；**L1 聚焦 mac/linux 4 target 先把核心 loop 跑通，Windows/musl L2 补齐**（r9 调整：非"某平台永久 no-sandbox"，而是分里程碑交付）。
6. **每 target 真机沙箱逃逸测试**：CI 必须能验证"沙箱确实拒绝了 fs.read/write/net"，仅编译通过不算合格（L1 跑 4 target，L2 跑全 8）。

### S1.2 非目标（划清边界）

- **不做**：kernel-mode 驱动（Windows）、SIP-off / kext（macOS）、要求 root 的用户命名空间（Linux 默认关闭时不启用）。
- **不做**：DNS 层网络白名单（三平台底层都不支持稳定按域名过滤，只做 IP+port）。
- **不做**：跨平台"统一 profile 格式" —— **能力**归一化（fs/net/env），**机制**按平台原生表达。
- **不承诺**：FreeBSD / OpenBSD / illumos / Android(Termux) / iSH 的沙箱，这些平台明确列入"沙箱不可用" 清单（走 `--dangerously-no-sandbox` 提示流）。

---

## §S2 Target 落地矩阵（r9: L1 4 target / L2 扩 8 target）

| # | Target | 沙箱底层 | Full 挡位交付时机 | 里程碑 | 备注 |
|---|---|---|---|---|---|
| T1 | `aarch64-apple-darwin` | `sandbox_init_with_parameters` + 动态 sbpl | L1 | **L1** | Apple Silicon 主力 |
| T2 | `x86_64-apple-darwin` | 同上 | L1 | **L1** | Intel Mac；Universal2 打包 |
| T3 | `x86_64-unknown-linux-gnu` | landlock (ABI 探测) + seccomp-bpf | L1 | **L1** | 服务器/桌面主力 |
| T4 | `aarch64-unknown-linux-gnu` | 同上 | L1 | **L1** | Graviton / Ampere / Pi 5 |
| T3-musl | `x86_64-unknown-linux-musl` | 同 T3 | L2 | **L2**（r9 调整） | Alpine / distroless |
| T4-musl | `aarch64-unknown-linux-musl` | 同 T4 | L2 | **L2**（r9 调整） | Alpine arm64 |
| T5 | `x86_64-pc-windows-msvc` | Job + Restricted Token（L2）→ + AppContainer file（L2）→ + WFP net（L3） | 分阶段 | **L2**（r9 调整） | Intel/AMD Win |
| T6 | `aarch64-pc-windows-msvc` | 同 T5 | 分阶段 | **L2**（r9 调整） | Snapdragon X / Surface Pro X |

**每 target 3 个 native crate**（`volund-sandbox` / `volund-search` / `volund-fs`，r9 后均为独立二进制）→ **L1: 4 target × 3 = 12 个平台包；L2: 8 target × 3 = 24 个 `@volund/native-*` 平台包**，通过 `native-bridge` 的 `optionalDependencies` 挂载。

---

## §S3 架构决策记录（ADR）

### ADR-1 · **Fork OpenAI codex-rs 沙箱三件套** 作底座（r3，2026-07-31）

> **⚠️ 本 ADR 修订史**：
> - r1（初稿）：fork birdcage —— 作废（GPL-3.0 + archived）
> - r2（2026-07-31 上午）：分平台组合 landlock/seccompiler/rustix/caps + win32job/rappct —— 作废，理由见下
> - **r3（2026-07-31 下午，当前版本）**：整套 fork codex-rs 沙箱

**决策**：Volund CLI **整套 fork OpenAI [codex](https://github.com/openai/codex) monorepo 里的三个沙箱 crate** 作为底座，vendor 进 `crates/volund-sandbox/vendor/codex/`，保留 Apache-2.0 + NOTICE 归属，逐步剥离 codex-* workspace 依赖。

| fork 来源 | 角色 | 关键文件（2026-07-31 实测） |
|---|---|---|
| `codex-rs/sandboxing/` | 跨平台抽象层（SandboxManager / SandboxType / policy_transforms / violation） | manager.rs 27 KB、policy_transforms.rs 20 KB、seatbelt.rs 28 KB、windows.rs 17 KB、violation.rs 10 KB |
| `codex-rs/linux-sandbox/` | Linux 后端（**bundled bwrap** + seccomp + landlock fallback） | bwrap.rs **105 KB**、linux_run_main.rs 51 KB、proxy_routing.rs 29 KB、landlock.rs 12 KB、bundled_bwrap.rs 11 KB |
| `codex-rs/windows-sandbox-rs/` | Windows 后端（**AppContainer + Job Object + WFP + ACL 回滚 + ConPTY**） | setup.rs **77 KB**、lib.rs 30 KB、acl.rs 27 KB、wfp.rs 16 KB、spawn_prep.rs 26 KB、wrapper.rs 14 KB |

**附带 vendor 的 workspace 依赖**（10+ crate，先全 vendor 后逐步剥离）：
`codex-protocol`（PermissionProfile / SandboxPolicy / CodexErr）、`codex-network-proxy`、`codex-execpolicy`、`codex-process-hardening`、`codex-install-context`、`codex-utils-absolute-path`、`codex-utils-path-uri`、`codex-utils-pty`、`codex-utils-home-dir`、`codex-utils-string`、`codex-utils-rustls-provider`、`codex-otel`

**关键技术决策（用户拍板）**：

1. **Linux 后端跟 codex：bwrap 默认 + landlock fallback**
   - **默认走 bundled bwrap**（user namespace `CLONE_NEWUSER` + PID namespace + bind mount + seccomp），与 codex 上游一致，便于同步
   - codex **自带 bundled bwrap 二进制**（编译时嵌入 `codex-resources/bwrap`，运行时 SHA256 校验后 `execv`），**不是 shell out 到系统 bwrap**——用户无需装任何工具
   - landlock 作 `use_legacy_landlock=true` 时的 fallback（受限容器 / 禁用 unprivileged userns 的企业 Linux）
   - **放弃**我们 r2 原定的"landlock 优先"策略

2. **workspace 依赖处理：全 vendor 后逐步剥离**
   - L1：把上述 12 个 codex-* crate 连同三个沙箱 crate 一起 vendor，改 workspace 名为 `volund-sandbox-vendor/`，先跑通
   - L2-L3：逐步把 `codex-protocol` → `volund-protocol`、`codex-utils-*` → `volund-utils-*` 重写替换，最终消除 codex 包名残留
   - L4：只剩沙箱三件套保留 codex attribution，其余完全 volund 化

**为什么 r2"分平台组合 crate"方案作废**：
- 🟡 r2 方案理论上干净（直接 cargo add 官方 crate），但 **Windows 部分（AppContainer + WFP + ACL 回滚）自己写要 4-6 周**，且达不到 codex 的生产深度（codex setup.rs 77 KB 是 OpenAI 团队真金白银堆出来的，含 ConPTY / DPAPI / desktop isolation / elevated 处理 / helper_materialization）
- 🟡 r2 的 rappct 是个人项目 7 star，bus factor 更差；codex 是 103k star 生产验证
- 🟢 codex 三件套**已经把 landlock + seccomp + bwrap + AppContainer + WFP 编排好**，r2 方案要自己写的胶水层（Backend trait + profile IR + policy_transforms）codex 已有（manager.rs + policy_transforms.rs 20 KB）

**为什么 r2 调研里的其他候选不选**：
- ❌ **birdcage**：GPL-3.0 + archived（r1 已作废理由）
- ❌ **nono**：Apache-2.0 活跃，但**不支持原生 Windows**，与全 6 平台（L2 全覆盖）硬约束不符（r9 注：即便 L1 不交付 Windows，Windows 仍是 L2 必交付项，候选方案必须能覆盖）
- ❌ **arapuca**（sergio-correia，Apache-2.0，10 star，单作者 359 commits）：Linux/macOS 部分干净独立，但 **Windows 无 WFP + 未在生产规模验证**。混合方案（codex Win + arapuca Linux/Mac）增加抽象适配成本，不如整套 codex 统一
- ❌ **microsandbox**（superradcompany，Apache-2.0，7k star）：microVM 路径（KVM/HVF/WHP），**缺 x86_64-apple-darwin**（HVF 仅 Apple Silicon）+ 需下发 guest kernel/OCI 镜像（破坏零系统依赖）+ 冷启动 100ms+ 对交互式 CLI 不友好
- ❌ **wasm-sandbox**（ciresnave，MIT，12 star）：单作者 7 commits 2025-07 后停更；WASM 沙箱不了 native subprocess（用户跑不了 npm/cargo/git）
- ❌ **gaol**（servo）：Apache-2.0 但 20 个月无维护，无 crates.io release

**风险控制**：
- **workspace 依赖剥离是长期债**：L1 全 vendor 后，CI 加 `cargo deny` 规则禁止新增 codex-* 依赖（只减不增），每里程碑强制剥离 ≥2 个 crate
- **bwrap 二进制供应链安全**：bundled bwrap 编译时嵌入 + SHA256 校验（codex 已实现 `verify_digest`），我们 fork 后保留此机制；CI 每次构建校验 digest 一致
- **codex 上游同步策略**：fork 后建 `upstream-codex` remote，每月 cherry-pick 沙箱相关安全 fix；不做无脑 merge（避免引入 codex 业务逻辑变更）
- **License**：codex Apache-2.0，Volund CLI Apache-2.0，双向兼容；`NOTICE` 文件列 OpenAI/Volund CLI 联合版权 + codex crate 归属
- **`cargo deny check licenses`** 仍作 CI 硬门，禁止 GPL/AGPL/SSPL/BUSL 进依赖树（codex 依赖树已审计为 Apache-2.0/MIT/BSD-3 干净）

### ADR-2 · Windows CI 使用 GitHub `windows-11-arm` 免费 runner（2025-Q4 GA），Azure Windows-on-ARM VM 作为兜底

**决策**：`aarch64-pc-windows-msvc` 走 GitHub `windows-11-arm` runner 做真机测试；当 runner queue > 30 分钟时降级 Azure VM（$200/月预算上限）。

**理由**：
- GitHub Actions 2025-Q4 已 GA Windows on ARM 免费 runner（公开 repo）；无需自购硬件。
- Cross-build 只能验证编译，无法验证 AppContainer / Job Object 实际行为 —— 沙箱产品这是不可接受的。
- Azure Windows-on-ARM VM 单价约 $0.12/h，跑测试足够；预留兜底避免完全阻塞。

### ADR-3 · Linux musl（两 target）L2 起同期发布（r9 调整：从 L1 推 L2）

**决策**（r9 调整）：**L2 起** `x86_64-unknown-linux-musl` + `aarch64-unknown-linux-musl` 与 glibc target 同期出包。原 r1 决策是 L1 起同期出包，r9 分层调整后 musl 双 target 从 L1 推到 L2（L1 只交付 mac/linux 4 target，musl 与 Windows Tier 1 一起进 L2）。

**理由**（保留 r1 论证逻辑，为何要支持 musl）：
- Alpine / distroless / `FROM scratch` 场景在 CI/CD 生态占比 30%+，缺失即缺失一半 dev 用户。
- musl 交叉链一次搭好后无边际成本（`cross-rs` + `cargo-zigbuild` 已成熟）。
- Rust 沙箱代码本身 libc-agnostic，musl 与 glibc 分歧点只在最终 link 阶段。

> **r9 里程碑归属变更**：论证逻辑不变（musl 仍然必须支持），仅把交付里程碑从 L1 推到 L2，与 L1 聚焦 mac/linux 4 target 的硬约束对齐。

### ADR-4 · 沙箱强度分四挡（Tier 模型）

Volund 内部对每 target 声明其当前**沙箱等级**，由 `native-bridge` 启动时探测得出：

| Tier | 语义 | 允许的工具 | UI 表现 |
|---|---|---|---|
| **Full** | fs 读写白名单 + syscall 过滤 + 网络白名单/关闭 | 所有 | 静默 |
| **Partial** | fs 读写白名单 + syscall 过滤，网络只能全开/全关（无按 IP） | 所有（网络白名单降级为全开警告） | 状态栏 ⚠️ 徽章 |
| **Weak** | 仅资源上限（rlimit / Job Object）；无 fs / syscall 隔离 | 拒绝副作用工具，除非 `--dangerously-no-sandbox` | 首屏 + 每次弹窗红条 |
| **None** | 无任何沙箱 | 副作用工具全拒；需 `--dangerously-no-sandbox` 覆盖 | 首屏必须显式确认 |

**Tier 映射**（r3 更新：Linux 改为 bwrap 可用性判定，跟 codex 上游一致）：

| Target | 常见环境 | 当前 Tier | 判定依据 |
|---|---|---|---|
| macOS 11+（T1/T2） | 主流 | Full | sandbox-exec + sbpl（codex seatbelt.rs） |
| Linux + unprivileged userns 可用（T3/T4 主流） | Ubuntu / Debian / Fedora / Arch | **Full** | **bundled bwrap**（CLONE_NEWUSER + PID ns + bind mount + seccomp）|
| Linux + userns 禁用但 landlock ≥5.13 | 某些企业 hardened kernel / RHEL 系 | **Partial** | 自动降级 landlock fallback（`use_legacy_landlock=true`）|
| Linux + userns 禁用且 landlock <5.13 | RHEL 8 / Amazon Linux 2 / Ubuntu 20.04 | **Weak** | 仅 seccomp + rlimit；codex 会 startup warning 并拒绝沙箱命令 |
| Linux WSL1 | — | **None** | 无法 CLONE_NEWUSER，codex 明确拒绝（WSL2 正常走 bwrap） |
| Windows 10/11 x64 沙箱 Tier 1（里程碑 L2 落地，r9 调整：原计划 L1） | 主流 | Weak（Job + Restricted Token） | codex windows-sandbox-rs 沙箱 Tier 1 |
| Windows 10/11 x64 L2 | 已升级 | Partial（+ AppContainer fs + ACL） | codex Tier 2 |
| Windows 10/11 x64 L3 | 已升级 | Full（+ WFP net） | codex Tier 3（wfp.rs 16 KB） |
| Windows arm64 (T6) | Snapdragon X | 与 T5 同挡（同一里程碑同挡） | windows-11-arm runner 真机验证 |
| 任意平台 `--dangerously-no-sandbox` | 用户显式关闭 | None | — |

**约束**：
- **`native-bridge.available.sandbox_tier` 在启动时确定并冻结**；tier 变化必须重启进程。
- **每 tier 降级都必须发 telemetry `sandbox.tier` 事件**（含 kernel/os version 字段以便统计）。
- **UI 层必须能显示当前 tier**（`volund doctor` + 状态栏徽章）。

### ADR-5 · Profile 抽象：能力归一，机制分背端

**决策**：`SandboxProfile` 是 Volund 内部**能力级**中间表示，向下由每 target 的 `Backend` trait 分别翻译成 sbpl / landlock rules / AppContainer SID+ACL；**不假装存在跨平台 profile 格式**。

```rust
// crates/volund-sandbox/src/profile.rs
pub struct SandboxProfile {
    pub fs: FsPolicy,           // read/write path lists (canonical)
    pub net: NetPolicy,         // Off / OnAll / OnHostsPorts(Vec<HostPort>)
    pub env: EnvPolicy,         // clear + allowlist
    pub exec: ExecPolicy,       // 允许 execve 的可执行路径白名单
    pub limits: ResourceLimits, // RSS / CPU / fds / procs
    pub violations: ViolationPolicy, // 命中时是 kill / log / notify
}

pub trait Backend {
    fn tier(&self) -> SandboxTier;
    fn apply(&self, profile: &SandboxProfile) -> Result<AppliedHandle, SandboxError>;
    fn spawn_child(&self, cmd: SpawnCmd, profile: &SandboxProfile) -> Result<ChildHandle>;
}
```

`Backend` 实现列表（编译时按 feature 挑选）：
- `backend::macos::MacosBackend`
- `backend::linux::LinuxBackend`（内含 ABI 探测与三挡自选）
- `backend::windows::WindowsBackend`（内含 Tier 1/2/3 探测与升级）
- `backend::nosandbox::NoSandboxBackend`（`--dangerously-no-sandbox` 唯一入口）

---

## §S4 macOS 后端设计（T1 / T2）

### S4.1 底层机制

- **API**：直接 link `libSystem`，调用 `sandbox_init_with_parameters(profile: *const c_char, flags: u64, params: *const *const c_char, error: *mut *mut c_char) -> c_int`。
- **性质**：技术上私有 API，但 Chromium / Firefox / Homebrew / Nix / nono / sandbox-exec 全部依赖，Apple 20 年未改签名，事实公开。
- **迁移预案**：若 Apple 未来移除，evidences 指向 Endpoint Security Framework（要求 entitlement + notarization + 用户 System Settings 授权），列入 v3 长期风险跟踪，不阻碍 L1 落地。

### S4.2 sbpl 生成器

`crates/volund-sandbox/src/backend/macos/sbpl.rs` 独立子模块：

- 默认 `(version 1) (deny default)`，仅按 profile 白名单开孔。
- `SbplBuilder` 提供类型安全的 append API，禁止裸字符串拼接。
- **路径转义**：所有路径经 `escape_sbpl_string()` 处理 `"` / `\` / `(` / `)` / 换行；unit test 覆盖 100 种 corner case。
- **尺寸门槛**：生成后 profile 若 > 60 KB → 尝试 `(subpath "...")` 折叠；折叠后仍 > 60 KB → 报错 `SandboxError::ProfileTooLarge`，UI 提示"权限白名单过大"。
- **模板变量**：`{{cwd}}` / `{{home}}` / `{{plugin_data}}` 在 builder 层完成插值，不留给 Apple sbpl 解析器。

### S4.3 网络语义

- `NetPolicy::Off` → `(deny network*)`。
- `NetPolicy::OnAll` → `(allow network*)`。
- `NetPolicy::OnHostsPorts(list)` → 应用层先 DNS resolve 为 IP → sbpl `(allow network-outbound (remote ip "1.2.3.4:443"))`。**若 DNS 解析失败** → 报错，不静默放开。
- 域名白名单**不在 sbpl 层做**（Apple sbpl 无稳定域名支持）；应用层 http-kit 再做二次校验。

### S4.4 macOS 特有风险

| ID | 风险 | 缓解 |
|---|---|---|
| MAC-R1 | sbpl 转义 bug 导致 profile 加载失败 → sandbox_init 返回 0 但语义错 | `sandbox_check()` 复核 + fuzz test 100k 路径样本 |
| MAC-R2 | Profile 超 64KB 静默截断 | `ProfileTooLarge` 硬报错 + 大小 unit test |
| MAC-R3 | Rosetta 2 混合架构下 posix_spawn fd 继承 edge case | Chromium 已文档化，unit test 覆盖 |
| MAC-R4 | macOS 26+ 未来版本行为变更 | 每季度回归测试新版本 macOS |
| MAC-R5 | Universal2 打包（合并 T1+T2） | 用 `lipo -create` 打进单一 `volund-sandbox` bin；Homebrew formula 依赖 universal2 |

### S4.5 Universal2 分发

- CI 分别在 `macos-14` (arm64) / `macos-13` (x64) 构建 `volund-sandbox`；额外 `lipo -create` 步骤合并为 universal2 二进制，随 `@volund/native-sandbox-darwin-universal` 包发布。
- napi-rs 产物 `volund-search.node` / `volund-fs.node` 保持双 target 独立包（napi-rs 不支持 universal .node）。

---

## §S5 Linux 后端设计（T3 / T4 + musl 两个）

> **r3 更新**：默认后端从 landlock 改为 **bundled bwrap**（跟 codex 上游一致）。landlock 降为 fallback。本节描述 fork codex `linux-sandbox` 后的实际机制。

### S5.1 默认路径：bundled bwrap（Full Tier）

**机制**（来自 codex `linux-sandbox/bwrap.rs` 105 KB + `bundled_bwrap.rs` 11 KB）：

```
Layer 1  bundled bwrap 二进制      — 编译时嵌入，运行时 SHA256 校验后 execv
         ↓ bwrap 提供：
         ├─ --unshare-user          CLONE_NEWUSER（无需 root，需 sysctl 允许）
         ├─ --unshare-pid           CLONE_NEWPID（PID 隔离）
         ├─ --unshare-net           CLONE_NEWNET（仅 net restricted 时；断网）
         ├─ --ro-bind / /           根文件系统只读
         ├─ --bind <root> <root>    writable roots 叠加
         ├─ --proc /proc            新挂载 /proc（可选 --no-proc）
         └─ --dev /dev              新挂载 /dev
Layer 2  seccomp-bpf（in-process）  — PR_SET_NO_NEW_PRIVS + 网络 syscall 过滤
Layer 3  proxy bridge（可选）       — TCP→UDS→TCP 路由，仅放行 configured proxy endpoints
```

**关键行为**（codex README 实测）：
- **bundled bwrap 不是 shell out**：codex 把 bwrap 二进制嵌入 `codex-resources/bwrap`，运行时 `verify_digest`（SHA256）校验后通过 `/proc/self/fd/<n>` execv——用户**无需装 bwrap**
- 若系统 PATH 上有更新的 bwrap，优先用系统的；太旧（不支持 `--argv0`）走 no-`--argv0` 兼容路径
- **protected subpaths**（`.git` / resolved `gitdir:` / `.codex`）在 writable root 内重新挂为只读
- **symlink-in-path / 不存在的 protected path** → 挂 `/dev/null` 阻断
- **glob 否认条目**（`**/*.env = none`）→ 启动前用 `rg --files` 展开 + bwrap mask
- **重叠路径优先级**：`/repo=write, /repo/a=none, /repo/a/b=write` → 按路径特异性排序，narrower denied 子路径胜出，narrower writable 可在 denied 父下重开
- **managed proxy mode**：`--unshare-net` + 内部 TCP→UDS bridge；bridge 上线后 seccomp 阻断用户命令的 `AF_UNIX`/`socketpair` 新建

### S5.2 fallback 路径：landlock（Partial Tier）

**触发条件**（codex 自动降级逻辑）：
- `sysctl kernel.unprivileged_userns_clone=0`（RHEL 系 / 企业 hardened kernel 默认）
- 或 bwrap 无法创建 user namespace（容器内权限不足）
- 或用户显式 `-c use_legacy_landlock=true`

**机制**（codex `linux-sandbox/landlock.rs` 12 KB + `sandboxing/landlock.rs` 4 KB）：
- landlock ABI 探测（v1-v5）；fs 白名单
- 仅当 split filesystem policy 能 round-trip 回 legacy `SandboxPolicy` 模型时才用 landlock fallback
- **split-only policies（nested 只读/denied carveouts）不回退 landlock**，留在 bwrap 以保留细粒度控制 → 此时若 bwrap 不可用则报错

### S5.3 WSL1 / 受限容器（Weak / None Tier）

| 环境 | 行为 |
|---|---|
| **WSL2** | 正常走 bwrap 路径 |
| **WSL1** | 无法 CLONE_NEWUSER → codex 明确**拒绝**沙箱命令，startup warning |
| Docker 默认 seccomp | 探测 `/proc/1/cgroup` + `/.dockerenv`；`no_new_privs` 已 set 时跳过重设；容器内 tier 标记降级 |
| gVisor / Firecracker | landlock syscall 可能 ENOSYS → ABI 探测返回 Unsupported → 若 bwrap 也不可用则 Weak |

### S5.4 Seccomp 架构分表

`crates/volund-sandbox/vendor/codex/linux-sandbox/` 内：
- bwrap 模式：seccomp 在 bwrap 子进程内 in-process 应用（`PR_SET_NO_NEW_PRIVS` + 网络 filter）
- landlock 模式：seccomp filter 由 codex `sandboxing` 层注入
- x86_64 / aarch64 syscall 号差异由 codex 已处理的 `#[cfg(target_arch)]` 分派覆盖

### S5.5 libc 变体

- **glibc target**（`x86_64-unknown-linux-gnu` / `aarch64-unknown-linux-gnu`）：bwrap 原生支持
- **musl target**（`x86_64-unknown-linux-musl` / `aarch64-unknown-linux-musl`）：bwrap 二进制需 musl 兼容构建；codex 已验证 musl 兼容性（commit 历史有 `fix: musl compatibility for seccomp tests`）
- CI 用 `cargo-zigbuild` 交叉编译 musl target
- Alpine 用户 `apk add volund-code`（v2）时提供 musl binary；npm 用户 pnpm 按 `libc` 字段挑选

### S5.6 Linux 特有风险（r3 更新）

| ID | 风险 | 缓解 |
|---|---|---|
| LIN-R1 | RHEL 8 / Amazon Linux 2 落 Weak 挡（userns 禁 + landlock <5.13） | UI 首屏 + `volund doctor` 明示；不阻塞使用 |
| LIN-R2 | **bwrap 二进制供应链篡改** | codex 的 `verify_digest`（SHA256）机制保留；CI 每次构建校验 digest；签名后分发 |
| LIN-R3 | bwrap 在某些容器 runtime（podman rootless / k8s）下 CLONE_NEWUSER 失败 | 探测失败 → 自动降级 landlock fallback；两者都失败 → Weak + warning |
| LIN-R4 | seccomp filter 永久无法撤销，需 spawn 子进程 | volund-sandbox 本就独立 bin + bwrap 子进程，天然满足 |
| LIN-R5 | managed proxy mode 的 seccomp 阻断 AF_UNIX 影响某些工具 | codex 已处理：仅 bridge 上线后阻断用户命令的新建，不影响已建立的 stdio |
| LIN-R6 | protected subpath（`.git`）的 symlink 绕过 | codex 已处理：symlink-in-path 挂 `/dev/null`；resolved `gitdir:` 重新挂只读 |
| LIN-R7 | glob 否认条目展开性能（大仓库 `rg --files` 慢） | `glob_scan_max_depth` 配置上限；rg 不可用时回退内部 globset walker |
| LIN-R6 | musl `libc::syscall` 数字与 glibc 一致但错误码转译差异 | 通过 `seccompiler` 抽象，测试覆盖两 libc |

---

## §S6 Windows 后端设计（T5 / T6）—— 自研重点

### S6.1 三挡阶梯（对齐里程碑，r9 调整：Tier 1 推 L2）

```
Tier 1 (Weak)      Job Object + Restricted Token
                   限 RSS / CPU / 进程数；剥离 Administrators SID 与
                   SeDebugPrivilege / SeShutdownPrivilege 等敏感权限
                   → L2 交付（r9 调整：从 L1 推 L2）

Tier 2 (Partial)   Tier 1 + AppContainer profile
                   fs 通过预 grant ACL 到 AppContainer SID 实现白名单；
                   注册表默认拒；无网络白名单（全开或全关）
                   → L2 交付

Tier 3 (Full)      Tier 2 + WFP (user-mode) 网络过滤
                   按 IP:port 白名单拦截 outbound；
                   inbound 拒绝
                   → L3 交付
```

### S6.2 Tier 1 实现（L2 必交付；r9 调整：从 L1 推 L2）

> **r9 调整**：Windows Tier 1 (Weak) 原为 L1 必交付，r9 分层调整后 L1 只交付 mac/linux 4 target，Windows Tier 1 推到 L2 与 musl 一起交付。下方代码与"实际能做到"清单保留不变（论证 Windows Tier 1 的实现路径与边界，仅在 L2 落地）。

```rust
// crates/volund-sandbox/src/backend/windows/tier1.rs
use windows::Win32::System::JobObjects::*;
use windows::Win32::Security::*;

pub fn apply_tier1(profile: &SandboxProfile) -> Result<AppliedHandle> {
    // 1. Create Job with kill-on-close + resource limits
    let job = unsafe { CreateJobObjectW(None, PCWSTR::null())? };
    let mut ext = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    ext.BasicLimitInformation.LimitFlags =
          JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        | JOB_OBJECT_LIMIT_PROCESS_MEMORY
        | JOB_OBJECT_LIMIT_ACTIVE_PROCESS
        | JOB_OBJECT_LIMIT_JOB_MEMORY
        | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
    ext.ProcessMemoryLimit = profile.limits.rss_bytes as usize;
    ext.BasicLimitInformation.ActiveProcessLimit = profile.limits.max_procs;
    unsafe { SetInformationJobObject(job, JobObjectExtendedLimitInformation, ..., ...)? };

    // 2. Create Restricted Token: strip DENY_ONLY 敏感 SID + disabled privileges
    let restricted = create_restricted_token(&[
        Sid::BUILTIN_ADMINISTRATORS,
        Sid::BUILTIN_POWER_USERS,
    ], &[
        SE_DEBUG_NAME,
        SE_SHUTDOWN_NAME,
        SE_TAKE_OWNERSHIP_NAME,
    ])?;

    // 3. Spawn child with restricted token + assign to job
    // ... (CreateProcessAsUserW + AssignProcessToJobObject)
    Ok(AppliedHandle { job, ... })
}
```

**Tier 1 实际能做到**：
- ✅ 限制 RSS / CPU / 子进程数（Job 层）
- ✅ 剥离管理员权限（Restricted Token 层）
- ✅ 强制随主进程一起被 kill（KILL_ON_JOB_CLOSE）
- ❌ **不能限制 fs 读写**（用户仍能 read/write 任何有 ACL 的路径）
- ❌ **不能限制网络**

→ **Windows L2 明确 Tier=Weak；副作用工具（Bash/Write/Edit）在无 `--dangerously-no-sandbox` 时全部要走 permission 弹窗二次确认，且弹窗上标红条 "sandbox: weak"**（r9 调整：原 L1 推 L2）。

### S6.3 Tier 2 实现（L2）

- `CreateAppContainerProfile(name, displayName, description, capabilities, capabilityCount)` 创建持久 SID
- 派生进程通过 `UpdateProcThreadAttribute(PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, &sec_caps)` 注入
- **文件系统 grant**：对 `profile.fs.read/write` 列表中每个路径，`AddAccessAllowedAce(dacl, ...S-1-15-2-...)` 增加 ACE
- **注意事项**：ACE 修改会**持久化在 NTFS**上，进程退出不自动回滚 → 必须在 `AppliedHandle::drop()` 里 revoke，且启动时清理"orphaned ACE"（前次崩溃遗留）
- **AppContainer 命名规则**：`VolundCode.Sandbox.<uuid>`，uuid 每个 profile 实例独立，避免命名冲突

### S6.4 Tier 3 实现（L3）

- **WFP user-mode**：`FwpmEngineOpen0` → 添加 filter callout（`FWPS_LAYER_ALE_AUTH_CONNECT_V4/V6`）→ 按 IP:port 判断放行
- **限制**：user-mode 只能拦 outbound + 不能拦 raw socket；kernel-mode driver 需签名（不做）
- **回退**：Tier 3 不可用时降 Tier 2 并 telemetry `sandbox.net.downgraded`
- **arm64 Windows 特殊**：WFP API 在 arm64 上功能等价 x64，但 SmartScreen 对未签名 arm64 sandbox 二进制屏蔽率高 → 发版必须做 EV 代码签名（v2 前用普通 authenticode + notarize URL）

### S6.5 Windows IPC（插件 bridge）

- 无 fd 3 语义 → 用 `CreateNamedPipeW(\\.\pipe\VolundBridge.<pid>.<uuid>, ...)` 建 named pipe
- 派生子进程时用 `STARTUPINFOEXW` + `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` 显式继承 pipe handle
- 子进程内 plugin-host.mjs 通过 `net.Socket({ fd })` 兜底不通用；改为约定环境变量 `VOLUND_BRIDGE_PIPE=\\.\pipe\...` → Node 侧 `net.createConnection({ path: process.env.VOLUND_BRIDGE_PIPE })`
- 协议层（JSON-RPC over NDJSON）保持跨平台一致

### S6.6 Windows 特有风险

| ID | 风险 | 缓解 |
|---|---|---|
| WIN-R1 | AppContainer ACE 遗留污染用户 NTFS | 启动时扫描 orphaned ACE 清理 + 每个 profile 独立 uuid |
| WIN-R2 | arm64 Windows 生态 & 测试机稀缺 | ADR-2：GitHub windows-11-arm runner + Azure 兜底 |
| WIN-R3 | Windows Defender / SmartScreen 屏蔽未签名 volund-sandbox.exe | L1 起做 authenticode 签名；L4 前升级 EV 证书 |
| WIN-R4 | Job Object 无法限制文件系统 → Tier 1 沙箱强度弱 | UI 明示 tier=weak；permission 弹窗强制二次确认 |
| WIN-R5 | WFP user-mode 无法拦 raw socket | 文档披露限制；用户若跑要求 raw socket 的插件默认拒绝 |
| WIN-R6 | Windows Sandbox (.wsb) 家用版不可用 | 不作为路径 |
| WIN-R7 | AppContainer 与用户 AV 软件冲突（Kaspersky/360 常见） | doctor 检测常见 AV + 建议加白名单 |

---

## §S7 探测与降级流程（native-bridge 启动时）

```
native-bridge init 顺序：
  1. resolveNative('sandbox')   → 找到平台包
  2. spawn `volund-sandbox --probe` (5s 超时)
       ├─ 输出 { platform, arch, kernel/os_version, tier, features }
       └─ 若超时/崩溃 → tier=None，副作用工具全禁
  3. 缓存 tier 到 SessionState.sandbox_info
  4. 发 telemetry event `sandbox.tier` (脱敏)
  5. UI 层：
       - Full  → 静默
       - Partial → 状态栏 ⚠️ 徽章 + doctor 标注
       - Weak  → 首次弹一次说明 + doctor 红标 + 每次危险弹窗红条
       - None  → 首屏必须显式确认 + 每次危险操作弹窗
```

**tier 冻结规则**：一旦 session 内确定 tier，中途不再重新探测；改变需重启 volund。

---

## §S8 逃逸测试策略（CI 硬要求）

`crates/volund-sandbox/tests/escape/`：

每 target 至少跑一次以下用例，**沙箱声明 Full/Partial 挡时必须全部拒绝**：

| 用例 | 期望结果 |
|---|---|
| `open("/etc/passwd", O_RDONLY)` | Full/Partial: 拒绝；Weak: 允许 |
| `open("/tmp/escape.txt", O_WRONLY \| O_CREAT)` | 白名单外: 拒绝 |
| `socket(AF_INET, SOCK_STREAM, 0)` + connect | NetPolicy::Off: 拒绝 |
| `execve("/bin/sh", ...)` | Exec 白名单外: 拒绝 |
| `ptrace(PTRACE_ATTACH, parent_pid)` | 所有 Tier: 拒绝 |
| `mount(...)` / `unshare(CLONE_NEWUSER)` | 所有 Tier: 拒绝 |
| `keyctl(...)` / `bpf(...)` | 所有 Tier: 拒绝 |
| 分配 500MB RSS | rlimit 生效: OOM kill |
| fork bomb（1000 子进程） | Job/rlimit 生效: kill |

**跑不动真机的 target**（如无 windows-11-arm runner 时）→ escape test 跳过并标 `unverified`，doctor 显示 `⚠️ escape tests not run on this target`。**Unverified target 不允许发版为 stable**。

---

## §S9 已明确"沙箱不可用"平台清单

以下平台 volund `--probe` 后直接返回 tier=None，`volund doctor` 说明"当前系统沙箱能力不可用"：

- **RHEL 7 / CentOS 7**：EOL，kernel 3.10，landlock/seccompv2 缺失 → Weak（仅 rlimit）
- **RHEL 8 / Amazon Linux 2 / Ubuntu 18.04**：kernel < 5.13，无 landlock → Weak
- **Android (Termux)**：无 root 且 vendor kernel 通常 3.x-5.x，Weak/None
- **iSH (iOS Alpine 模拟)**：用户态模拟，Weak
- **老 32-bit ARM Linux（armv7）**：不在 6 平台组合矩阵（L2 全覆盖范围），不支持
- **FreeBSD / OpenBSD / NetBSD / illumos**：v2 前不支持（可 PR，走 Capsicum / pledge / unveil）

---

## §S10 里程碑映射

> **r9 调整**：L1 从「6-target 全绿」收缩为「mac/linux 4 target 全绿」（Windows Tier 1 + Linux musl 双 target 推 L2）。下表的 L1/L2 行已按 r9 分层重排。

| 里程碑 | Sandbox 交付 | tier by target |
|---|---|---|
| **L1** | **mac/linux 4 target 全绿**（r9 调整：从 6-target 收缩）；macOS Full（sandbox-exec + sbpl）；Linux Full（bundled bwrap，若 kernel ≥ 5.13 userns 可用）或 Partial（landlock fallback） | mac/Linux Full or Partial |
| **L2** | **扩至 8 target 全绿**：补 Windows Tier 1 (Weak，Job + Restricted Token) + Linux musl 双 target；Windows Tier 2 (Partial-fs) 同期交付；Linux ABI 探测三挡降级完备；`--run-plugin` 全平台 | mac/Linux Full or Partial · Win Weak→Partial |
| **L3** | Windows Tier 3 (Full-fs+net WFP)；macOS sbpl 网络细控完整；违规日志谱完整；外部安全审计 | mac/Linux/Win Full |
| **L4** | 沙箱违规实时 telemetry；`volund-sandbox --test-escape` self red-team CLI；EV 代码签名 | 所有 target Full |
| **v2** | FreeBSD/OpenBSD backend；Windows kernel driver 签名 net 强化 | 社区 PR |

**闸门**：每个里程碑发版前必须满足（r9 调整：L1 跑 4 target，L2 起跑全 8 target）：
1. **L1: 4-target CI 全绿；L2+: 8-target CI 全绿**（含 native + escape test）
2. `volund doctor --strict` 在对应 target 各跑一次通过（L1 跑 4，L2+ 跑 8）
3. `sandbox.tier` telemetry 事件在对应 target 各触发一次并落盘
4. Windows 二进制通过 authenticode 签名（L2 起）
5. macOS 二进制通过 notarize（L2 起）

---

## §S11 与既有 REVIEW-r6 的对应关系

本白皮书解决 REVIEW-r6 中以下条目（一起升为 P0）：

| REVIEW 条目 | 本文对应节 | 状态 |
|---|---|---|
| L1（landlock ABI v1 truncate 攻击） | §S5.2 Partial 挡 + seccomp 补拦 truncate | ✅ |
| L2（RHEL8/AmznLinux2 无沙箱） | §S3 ADR-4 Weak 挡 + §S7 UI 强告 | ✅ |
| L3（seccomp 无法撤销） | §S5.6 LIN-R2 (volund-sandbox 独立 bin 天然满足) | ✅ |
| L4（seccomp BPF 4096 上限） | §S5.3 ProfileTooComplex 硬报错 | ✅ |
| L5（aarch64 vs x86_64 syscall 表两套） | §S5.3 架构分表 | ✅ |
| L6（Docker/K8s 套娃冲突） | §S5.6 LIN-R3 探测容器环境 | ✅ |
| W1（L1-L3 Windows 裸奔） | §S6.2 L2 交付 Tier 1（r9 调整：原 L1 推 L2） | ✅ 已消除（里程碑归属调整） |
| W2（AppContainer profile-json 不跨平台） | §S3 ADR-5 能力归一机制分背端 | ✅ |
| W3（AppContainer ACL 污染） | §S6.6 WIN-R1 orphaned ACE 清理 | ✅ |
| W4（arm64 Windows 未测） | §S3 ADR-2 windows-11-arm runner | ✅ |
| W5（Windows fd 3 需 named pipe） | §S6.5 named pipe backend | ✅ |
| S-1 ~ S-12（review r6 建议清单） | 本白皮书全部覆盖 | ✅ |

---

## §S12 长期风险跟踪

| 风险 | 时间视野 | 触发条件 | 应急预案 |
|---|---|---|---|
| Apple 移除 `sandbox_init` | 3-5 年 | macOS 主版本 release notes | 迁移 Endpoint Security Framework（v3） |
| Windows 11 App Isolation 替代 AppContainer | 2-3 年 | Microsoft 官方 deprecation | Backend trait 局部替换 |
| landlock ABI 破坏性升级 | 每 6-12 月 | kernel release | ABI 探测已就位 |
| `landlock` / `seccompiler` crate 停摆 | 不定 | GitHub repo 无活跃 | 均为官方组织（landlock-lsm / rust-vmm）维护，风险极低；且 codex 已 vendor 这两 crate 的用法，我们跟随 codex 升级节奏 |
| **codex 上游沙箱架构大改**（如弃 bwrap 转 landlock 默认 / 重写 windows-sandbox） | 中 | codex release notes | 我们 fork 后独立维护；每月 cherry-pick 安全 fix 但不无脑 merge 架构变更；重大变更走我们的 ADR 流程评估 |
| **codex workspace 依赖剥离拖期** | 高（L1-L3） | 里程碑 review | CI `cargo deny` 禁止新增 codex-* 依赖（只减不增）；每里程碑强制剥离 ≥2 个 crate；剥离进度作 milestone DoD |
| **bundled bwrap 二进制在某 musl/Alpine 变体下不兼容** | 中 | CI musl target 测试失败 | codex 已有 musl 兼容 commit；CI 每 PR 跑 musl escape test；失败时该 target 标 Partial（landlock fallback）|
| **codex Windows WFP 在 arm64 行为未充分验证** | 中 | windows-11-arm runner 测试 | ADR-2 windows-11-arm runner 真机覆盖；arm64 WFP 异常时降级 Tier 2（AppContainer 无 WFP）|
| GitHub `windows-11-arm` runner 停用 | 不定 | GitHub actions changelog | Azure Windows-on-ARM VM 兜底（ADR-2） |
| 外部安全审计报告发现 escape | L3 前 | 审计触发 | SECURITY.md 48h 响应流程 |

---

## §S13 决策清单（作为 spec 增量）

**接下来需要落地到代码/CI/spec 的具体动作**（对应本白皮书 approve 后的实施顺序）：

1. `crates/volund-sandbox/` 骨架 + **vendor codex 三件套**：`vendor/codex/{sandboxing,linux-sandbox,windows-sandbox-rs}/` + 保留 LICENSE/NOTICE（OpenAI 归属）
2. **vendor codex workspace 依赖**（ADR-1）：`vendor/codex/{protocol,network-proxy,execpolicy,process-hardening,install-context,utils-*,otel}/` 共 12 个 crate，改 workspace 名为 `volund-sandbox-vendor`，先跑通编译
3. **`deny.toml` 白名单**：允许 `Apache-2.0` / `MIT` / `BSD-3-Clause` / `Unicode-DFS-2016`；**硬拒 `GPL-*` / `AGPL-*` / `SSPL-*` / `BUSL-*`**；CI 加 `cargo deny check licenses` step 作 release-blocking gate（codex 依赖树已审计干净）
4. **codex 上游同步策略**：fork codex 仓库 → 建 `upstream-codex` remote → 每月 cherry-pick 沙箱安全 fix（仅 `codex-rs/{sandboxing,linux-sandbox,windows-sandbox-rs}/` 目录）；不做无脑 merge
5. **workspace 依赖剥离计划**（L1-L4 渐进）：
   - L1：全 vendor 跑通，CI 加规则禁止新增 codex-* 依赖
   - L2：剥离 `codex-utils-*`（路径/字符串/pty 工具类）→ 合并进 `volund-utils`
   - L3：剥离 `codex-protocol`（PermissionProfile/SandboxPolicy）→ 重写为 `volund-permission`；剥离 `codex-network-proxy`
   - L4：剥离 `codex-execpolicy` / `codex-process-hardening`；最终仅沙箱三件套保留 codex attribution
6. **bundled bwrap 供应链**：保留 codex 的 `verify_digest`（SHA256）机制；CI 每次构建校验 bwrap 二进制 digest；签名后分发；记录 expected digest 到 `crates/volund-sandbox/BWRAP_DIGEST.txt`
7. **NOTICE 文件**：列 OpenAI codex 版权 + 各 crate 归属（`cargo about generate` 自动生成 + 手动补 codex 段）
8. `packages/native-bridge/src/sandbox.ts` 扩展 tier 探测 + 缓存（对接 codex `get_platform_sandbox`）
9. `apps/cli/src/ui/SandboxTierBadge.tsx`（Ink 组件）
10. `volund doctor` 增加 sandbox 段（含 codex crate 版本 + bwrap digest 回显）
11. CI matrix：**r9 调整分层** —— L1：4-runner（mac/linux × aarch64/x86_64，gnu）；L2：扩至 8-runner（+ windows-11-arm + 2 musl target + windows x64）；两层都加 `cargo deny check licenses` job + **bwrap digest 校验** step
12. `.github/workflows/sandbox-escape.yml` 每 target 跑 escape test（复用 codex 的 `sandbox_smoketests.py` + `seatbelt_tests.rs` / `landlock_tests.rs`）
13. `packages/native-bridge` `optionalDependencies` 平台包（**r9 调整**：L1: 12 包 = 4 target × 3 crate；L2: 24 包 = 8 target × 3 crate）
14. `apps/docs/content/concepts/security-model.md` 官网文档（含**fork codex 归属公示** + bwrap 机制说明）
15. AGENT.md / CLAUDE.md 硬约束条目补（**r9 调整：分层表述**）：L1 4-target Full 覆盖（mac/linux）/ L2 扩 8-target Full 覆盖（补 Windows Tier1 + musl）+ tier 探测强制 + 逃逸测试强制 + **license 白名单** + **codex workspace 依赖只减不增**

---

## 变更日志

| 日期 | 版本 | 内容 |
|---|---|---|
| 2026-08-01 | r1 | 初稿：产品硬约束确认（6-target × 4 tier）；ADR-1 fork birdcage；ADR-2 windows-11-arm runner；ADR-3 musl L1 同发；ADR-4 tier 模型；ADR-5 能力归一机制分背端；分平台 backend 详细设计；逃逸测试策略；里程碑映射；REVIEW-r6 P0/P1 升级 |
| 2026-07-31 | r2 | **ADR-1 全面修订**（响应用户提问"Rust 有没有现成三方沙箱包"，触发 GitHub / crates.io 系统调研）。核心发现：(a) birdcage 实为 **GPL-3.0** 且 2026-07-06 已 archived — 原方案是 license 红线 + 死项目；(b) 市场无覆盖 mac+linux+win 三平台的活跃 crate；(c) 分平台组合 Apache-2.0 crate 是唯一可行路径。落地：ADR-1 重写为"直接依赖 `landlock` (landlock-lsm 官方) + `seccompiler` (rust-vmm/AWS Firecracker) + `rustix`/`caps` (bytecodealliance) + `win32job` + `rappct` + macOS ~50 行自研 FFI"，共 6 层组件的 crate 选型表 + license + 备用兜底；新增"为什么不用 nono"讨论段；替代方案与放弃理由重写。§S4.1 macOS API 描述里 `birdcage` 依赖参照替换为 `nono`。§S12 长期风险表新增 3 行（landlock/seccompiler 停摆、rappct 停摆、cargo deny 间接 GPL），删除"birdcage 停摆"行。§S13 决策清单从 10 项扩至 13 项，插入 3 项硬约束：**#2 Cargo.toml 分 target crate 依赖清单**、**#3 `deny.toml` license 白名单 + CI hard gate（拒绝 GPL/AGPL/SSPL/BUSL）**、**#4 `NOTICE` 自动生成**、**#5 rappct audit 记录制度**。产品影响：L1 时间估算下限可能从 8-10 周略降（Linux 底层与 Windows Job Object 复用官方 crate 节省 ~1-2 周），但 rappct audit 与 macOS FFI 仍需保留缓冲，暂不调整 §10 数字。 |
| 2026-07-31 | r3 | **ADR-1 再次全面修订：整套 fork OpenAI codex 沙箱**（响应用户"codex 方案靠谱，毕竟是成熟运行了的"+ 提示 arapuca / microsandbox / wasm-sandbox 候选，触发第二轮深调研）。核心决策转变：放弃 r2 的"分平台组合官方 crate 自研胶水层"，改为**整套 fork codex-rs/{sandboxing, linux-sandbox, windows-sandbox-rs} 三件套 + 12 个 workspace 依赖 crate**，vendor 后逐步剥离。用户拍板的两项关键技术决策：(1) **Linux 后端跟 codex：bwrap 默认 + landlock fallback**（放弃 r2 的 landlock 优先）；(2) **workspace 依赖全 vendor 后逐步剥离**（L1 全 vendor → L2 剥 utils → L3 剥 protocol → L4 仅留沙箱三件套 codex attribution）。四方候选否决理由记录：arapuca（单作者 10 star 未实战验证 + Windows 无 WFP）、microsandbox（microVM 缺 x86_64-apple-darwin + 破坏零系统依赖 + 冷启动 100ms+）、wasm-sandbox（单作者 7 commits 停更 + WASM 沙箱不了 native subprocess）、birdcage/nono/gaol（r2 已否决）。落地变更：ADR-1 重写 r3（fork 来源表 + 关键文件实测大小 + workspace 依赖清单 + 修订史三段）；§S1.1.3 "零外部工具依赖"重定义为"零系统工具依赖"（bundled bwrap 编译嵌入 + SHA256 校验 ≠ shell out）；ADR-4 Tier 模型 Linux 行从 landlock ABI 版本判定改为 bwrap/userns 可用性判定（+ WSL1 None + 企业 hardened kernel Partial landlock fallback）；§S5 Linux 后端整段重写（bundled bwrap 默认路径 5 层机制 + protected subpath/symlink/glob/重叠路径优先级 + managed proxy bridge + landlock fallback 触发条件 + WSL1/容器/gVisor 特例 + 风险表 LIN-R1~R7 更新）；§S12 长期风险表删 landlock/rappct 停控行，加 4 行（codex 上游架构大改 / workspace 剥离拖期 / musl bwrap 兼容 / arm64 WFP 验证）；§S13 行动清单从 13 项扩至 15 项（vendor codex 三件套 + 12 crate + 上游同步策略 + 4 阶段剥离计划 + bundled bwrap digest 供应链）。产品影响：L1 时间从 8-10 周**下调到 5-7 周**（沙箱核心代码不用自己写，codex 已生产验证；主要工作是 vendor + workspace 适配 + escape 测试对接）。 |
