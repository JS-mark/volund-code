> ↩ [返回索引 (README)](./README.md) · ← [上一章: §4 工具与权限](./04-tools-permissions.md) · [下一章: §6a 插件核心 (6.1–6.4)](./06a-plugins-core.md) →
>
> 关联文档：[SANDBOX-COMPAT-r1](./SANDBOX-COMPAT-r1.md)（沙箱跨平台白皮书；本节的权威扩展）

---

## §5 Rust 侧车（沙箱 + 搜索 + FS）

本节定义 `crates/*` 与 `packages/native-bridge` 的边界。

> **产品硬约束（不可动摇，r9 分层）**：沙箱必须在 **mac/linux 4 target（L1 硬约束）** 全绿；**L2 扩至 8 target（补 Windows Tier1 + Linux musl）为全平台硬约束**。作为对应里程碑的发版闸门。详见 [SANDBOX-COMPAT-r1](./SANDBOX-COMPAT-r1.md) §S1。
>
> **口径说明（避免 6/8 混淆）**：本文档同时出现"6"和"8"两个数字，指代不同维度，**不矛盾**：
> - **6 平台组合**（platform combination）= mac/linux/win × arm64/x64 —— 产品覆盖口径（L2 起的全平台目标）
> - **8 Rust native target** = 上述 6 个 + Linux 的 2 个 musl 变体（`x86_64-unknown-linux-musl` / `aarch64-unknown-linux-musl`，Alpine/distroless 用户）—— Rust 编译/CI 矩阵口径（L2 起全平台）
> - **4 Rust native target（L1）** = darwin-arm64 / darwin-x64 / linux-x64-gnu / linux-arm64-gnu —— **L1 发版闸门口径**（r9 调整：Windows + musl 推 L2）
> - **24 平台包** = 8 Rust native target × 3 crate（sandbox/search/fs）—— npm 分发口径（L2 起）；**L1 先发 12 包**（4 target × 3 crate）
>
> 凡说"6"指平台组合（产品硬约束的语义层），凡说"8"指 Rust 编译 target（CI/分发的实现层，L2 起），凡说"4"指 L1 范围。

### 5.1 设计目标

| 目标                | 具体含义                                                             |
|---------------------|----------------------------------------------------------------------|
| **性能敏感走 Rust** | 搜索（ripgrep）、AST（tree-sitter）、大文件 diff、tokenize            |
| **安全敏感走 Rust** | Shell 命令沙箱执行 + 插件宿主 sandbox（syscall / SID 隔离）           |
| **单点接入**        | JS 侧只有 `packages/native-bridge` 一个包能调 Rust；其它包禁 direct  |
| **零系统工具依赖**  | **用户无需装任何系统工具**；沙箱所需一切随 volund-code 自带（Linux 的 bundled bwrap 编译时嵌入 + SHA256 校验，非 shell out） |
| **License 硬约束**  | Rust 依赖树**禁止**任何 `GPL-*` / `AGPL-*` / `SSPL-*` / `BUSL-*`；CI `cargo deny check licenses` release-blocking；codex workspace 依赖**只减不增**（每里程碑剥离 ≥2 crate） |
| **Fork codex 底座** | 沙箱三件套 fork 自 OpenAI codex-rs（生产验证，103k star），详见 [SANDBOX-COMPAT-r1 ADR-1 r3](./SANDBOX-COMPAT-r1.md#adr-1)；**持续跟踪 upstream + 单点失败缓解**（§5.12） |
| **L1 平台硬覆盖** | macOS(arm64+x64) / Linux(arm64+x64 glibc) = **4 target 全部落地**（L1 闸门）；Windows + musl 推 L2 扩至 8 target |
| **JS 有 fallback**  | 只针对 search/fs：找不到二进制 / worker 崩溃超限时只读能力降级 JS；副作用能力 + 沙箱**不做 JS fallback** |
| **可独立发布**      | 每 target × 每能力一个 npm 平台包，共 24 个（产物均为独立二进制；L1 先发 12 个，见 §5.9），通过 `optionalDependencies` 挂载 |

### 5.2 Rust 产物清单

| 名称                | 类型              | 主要能力                                                    | 落盘位置                          |
|---------------------|-------------------|-------------------------------------------------------------|-----------------------------------|
| `volund-sandbox`    | 独立可执行二进制  | 执行 shell 命令 + syscall/SID 隔离；**沙箱内执行插件 Node 子进程**；`--probe` 输出 tier | `platforms/native-sandbox-*/bin/` |
| `volund-search`     | 独立可执行二进制  | ripgrep 绑定 + tree-sitter 语法查询；**常驻 worker 模式 + IPC** | `platforms/native-search-*/bin/`  |
| `volund-fs`         | 独立可执行二进制  | 大文件 diff / tokenize（tiktoken-rs）；**常驻 worker 模式 + IPC** | `platforms/native-fs-*/bin/`      |

> **r9 架构变更**：`volund-search` / `volund-fs` 从 napi-rs `.node` addon 改为**独立二进制常驻 worker**（与 `volund-sandbox` 形态统一）。理由：(1) 消除 napi ABI 版本依赖，提升安装可靠性（历史性痛点）；(2) 三产物架构统一，降低维护复杂度；(3) universal2 限制解除（napi-rs 不支持 universal `.node` 的硬约束失效，darwin 可 lipo 合并）。代价：search/diff/tokenize 调用走 IPC 往返 ~1-5ms/次（可接受，非热路径）。详见 §5.6.2 IPC 协议。

**为什么三个产物都是独立二进制**：
- 沙箱需要 fork/exec 新进程 + 挂载 syscall 过滤 / SID / AppContainer，Node 主进程内做会污染
- 独立二进制让每个产物有自己的进程生命周期，崩溃不影响 volund 主进程
- 便于用户手动审查（`file volund-sandbox` + 校验签名）
- **同一套框架同时服务 Bash / Plugin / Search / FS**：v3+ 修正后，插件也在 volund-sandbox 子进程内跑（见 §5.3 `--run-plugin` 模式与 §6.4.3），search/fs 各自常驻 worker，避免"最需要沙箱的地方反而没沙箱"或"napi addon 一崩主进程跟着崩"的自相矛盾
- **同一套二进制既能被 native-bridge 派生子进程，也可以被用户直接 `volund-sandbox --probe` 调试**，Runtime 与 CLI 语义合并

### 5.3 volund-sandbox 设计

**三种运行模式**，共用同一套 `SandboxProfile` 数据模型 + 每平台 Backend 应用逻辑：

#### 5.3.1 `exec` 模式（Bash 命令，默认）

```
职责：接收 JSON 配置 → 平台 Backend 生成原生沙箱策略 → 执行子命令 → 返回结果

CLI：volund-sandbox exec  （或省略子命令，兼容默认）

输入（stdin JSON）：
  {
    "command": "git status",
    "cwd": "/path/to/project",
    "timeout_ms": 60000,
    "permissions": {
      "fs": { "read": ["/path/to/project/**"], "write": ["/path/to/project/**"] },
      "net": false,
      "env": { "read": ["HOME", "PATH", "LANG"] },
      "exec": { "allow": ["/bin/bash", "/usr/bin/git"] },   // ★ r13-D1：可执行白名单（syscall 名单的输入位）
      "limits": {                                            // ★ r13-D1：资源上限（rlimit 系）
        "max_memory_mb": 2048,                               //   RLIMIT_AS 等价
        "max_cpu_seconds": 600,                              //   RLIMIT_CPU
        "max_processes": 256,                                //   RLIMIT_NPROC
        "max_file_size_mb": 512                              //   RLIMIT_FSIZE
      }
    },
    "env": { "CUSTOM_VAR": "value" }
  }
// exec.allow 缺省 = 仅沙箱选择的 shell 本身（§4.3.1）；limits 缺省 = 上表默认值。
// exec/limits 由各平台 Backend 翻译：Linux seccomp + setrlimit；macOS sbpl + POSIX rlimit；
// Windows job object + AppContainer 能力限制（个别项无直接等价则就近映射并在 violations 记录）

输出（stdout JSON）：
  {
    "stdout": "...",
    "stderr": "...",
    "exit_code": 0,
    "duration_ms": 123,
    "sandbox_tier": "full",              // full | partial | weak | none
    "sandbox_violations": []             // 有 syscall / API 被拦时填充
  }
```

#### 5.3.2 `--run-plugin` 模式（插件宿主，v3 新增）

```
职责：在沙箱内 execve/CreateProcess 一个 Node 进程加载指定插件 index.js，
      通过预先打开的 fd 3（Unix）或 named pipe（Windows）与父 volund 做 JSON-RPC bridge

CLI：volund-sandbox --run-plugin \
       --entry <pluginDir>/index.js \
       --data-dir <perPluginDataDir> \
       --sandbox-profile <profile-json>     # 可 @file: 传路径
       --bridge-fd 3                        # Unix：父进程 posix_spawn 时保留
       # 或（Windows）：
       --bridge-pipe \\.\pipe\VolundBridge.<pid>.<uuid>

内部流程（跨平台一致的抽象）：
  1. 解析 profile-json（同 exec 模式，含 fs/net/env/exec 段）
  2. 打开或继承 bridge IPC 句柄（Unix fd / Windows pipe）
  3. 调用平台 Backend::apply(profile) 挂载沙箱
  4. spawn Node：argv = [node, <volund-runtime>/plugin-host.mjs, <entry>, <dataDir>]
     - Unix：posix_spawn + posix_spawn_file_actions_addinherit_np/adddup2
     - Windows：CreateProcessAsUserW + STARTUPINFOEXW + PROC_THREAD_ATTRIBUTE_HANDLE_LIST
  5. 子进程内 plugin-host.mjs 从 bridge 读写 JSON-RPC NDJSON
  6. 进程退出 → volund-sandbox 自身退出，退出码透传

> ★ r13-D1：Unix `--bridge-fd 3` 与 Windows `--bridge-pipe` **同为 L2 落地要求**——插件宿主进 Windows（§5.9 T5/T6 平台包）时 named pipe 路径必须同 PR 交付，不允许"先只做 Unix fd、Windows 留 TODO"。

profile 差异 vs exec 模式：
  - fs.read: pluginDir 只读 + Node 内置模块路径 + tzdata 等
  - fs.write: dataDir 独占（每插件一个）
  - net: 按 manifest.permissions.net 白名单开
  - env: 强制 clear_env + 只保留最小集（PATH, HOME, LANG, NODE_OPTIONS 白名单化）
  - syscall/权限额外拒绝：ptrace / mmap w+x / SeDebugPrivilege / SeTakeOwnership （阻止 JIT 逃逸 + 特权提升）
```

#### 5.3.3 `--probe` 模式（启动探测）

```
职责：native-bridge 启动时调用；返回本机沙箱能力
CLI：volund-sandbox --probe
输出（stdout JSON）：
  {
    "platform": "linux",
    "arch": "aarch64",
    "libc": "gnu",              // gnu | musl | null (macos/windows)
    "os_version": "6.8.0-40",
    "tier": "full",             // full | partial | weak | none
    "features": {
      "landlock_abi": 4,        // Linux only
      "seccomp": true,
      "namespaces": true,
      "sandbox_init": true,     // macOS only
      "appcontainer": true,     // Windows only
      "wfp": true               // Windows only
    },
    "known_limitations": [
      "no dns-name net whitelist",
      "seccomp cannot be revoked"
    ]
  }
```

- 5 秒超时；若崩溃 / 超时 → native-bridge 视为 tier=none
- 结果**冻结**在 SessionState.sandbox_info，session 内不重探
- ★ **r13-D1：features 键名三平台统一契约**：合法键 = `landlock_abi`（int，Linux）/ `seccomp`（bool，Linux）/ `namespaces`（bool，Linux）/ `sandbox_init`（bool，macOS）/ `appcontainer`（bool，Windows）/ `wfp`（bool，Windows）。**非本平台的键整体省略**（不输出 `false` 也不输出 `null`）——消费侧（native-bridge / doctor / §14.3b Tier 披露）以"键存在与否"判断能力，禁止自创键名。

### 5.4 平台 Backend 实现（三平台各一份）

**核心抽象**：`SandboxProfile` 是 Volund 内部的**能力级**中间表示，每平台 Backend 负责翻译为原生策略。**不假装存在跨平台 profile 格式**（详见 [SANDBOX-COMPAT-r1](./SANDBOX-COMPAT-r1.md) §S3 ADR-5）。

```rust
// crates/volund-sandbox/src/backend/mod.rs
pub trait Backend {
    fn tier(&self) -> SandboxTier;                                // Full / Partial / Weak / None
    fn apply(&self, profile: &SandboxProfile) -> Result<AppliedHandle, SandboxError>;
    fn spawn_child(&self, cmd: SpawnCmd, profile: &SandboxProfile) -> Result<ChildHandle>;
}
```

#### 5.4.1 macOS Backend（T1 aarch64 / T2 x86_64）

- **API**：直接 link libSystem，调用 `sandbox_init_with_parameters(profile_str, flags, params, &error)`（事实公开的私有 API，Chromium / Firefox / nono / codex 均依赖；fork codex 的 `sandboxing/seatbelt.rs` 28 KB + `seatbelt_base_policy.sbpl` 已实现完整 sbpl 生成）。
- **profile 生成**：`sbpl` 子模块动态构造 SBPL（Sandbox Profile Language）字符串；`(version 1) (deny default)` + 白名单开孔。
- **路径转义**：`escape_sbpl_string()` 处理 `"` / `\` / `(` / `)` / 换行；100 种 corner case unit test 全覆盖。
- **尺寸门槛**：> 60 KB profile 折叠为 `(subpath ...)`；仍超限 → `SandboxError::ProfileTooLarge` 硬报错。
- **网络语义**：`OnHostsPorts` 在应用层 DNS resolve 为 IP 后写入 sbpl；DNS 失败 → 报错不静默放开。
- **Universal2**：CI 分别在 `macos-14` (arm64) / `macos-13` (x64) 构建 → `lipo -create` 合并为 universal2 二进制发布。

**tier 判定**：macOS 11+ → Full；旧版本 → Weak（sandbox_init 存在但部分 API 差异大）。

#### 5.4.2 Linux Backend（T3/T4 glibc + T3-musl/T4-musl）

> **r3 更新**：默认后端从 landlock 改为 **bundled bwrap**（fork codex `linux-sandbox`），landlock 降为 fallback。详见 [SANDBOX-COMPAT-r1 §S5](./SANDBOX-COMPAT-r1.md#s5-linux) 。

**默认路径：bundled bwrap**（Full Tier）：

```
Layer 1  bundled bwrap 二进制      — 编译嵌入，运行时 SHA256 校验后 execv（非 shell out）
         ├─ --unshare-user          CLONE_NEWUSER（无需 root）
         ├─ --unshare-pid           CLONE_NEWPID
         ├─ --unshare-net           CLONE_NEWNET（仅 net restricted 时）
         ├─ --ro-bind / /           根 fs 只读
         ├─ --bind <writable-root>  writable root 叠加
         └─ protected subpath 重挂只读（.git / resolved gitdir / .volund）
Layer 2  seccomp-bpf（in-process）  — PR_SET_NO_NEW_PRIVS + 网络 filter
Layer 3  proxy bridge（可选）       — TCP→UDS→TCP，仅放行 configured proxy
```

**fallback 路径：landlock**（Partial Tier）：`sysctl kernel.unprivileged_userns_clone=0` / 容器内 userns 不可用 / 用户 `-c use_legacy_landlock=true` 时自动降级。

**Tier 判定**：

| 环境 | Tier | 判定依据 |
|---|---|---|
| userns 可用（Ubuntu/Debian/Fedora 主流） | **Full** | bundled bwrap + seccomp |
| userns 禁用但 landlock ≥5.13 | **Partial** | landlock fallback |
| userns 禁 + landlock <5.13（RHEL 8/AL2） | **Weak** | 仅 seccomp + rlimit |
| WSL1 | **None** | 无法 CLONE_NEWUSER，拒绝沙箱命令 |

**libc 差异**：glibc / musl 沙箱代码本身无差异，仅 link 阶段分裂；CI 用 `cargo-zigbuild` 编译 musl target（codex 已验证 musl 兼容性）。

**容器探测**：读 `/proc/1/cgroup` / `/.dockerenv` 判定容器环境；`no_new_privs` 已 set 时跳过重设；WSL2 正常走 bwrap，WSL1 拒绝。

**codex 已处理的 Linux 细节**（我们 fork 后继承）：
- protected subpath symlink 绕过 → 挂 `/dev/null`
- glob 否认条目（`**/*.env`）→ `rg --files` 展开 + bwrap mask
- 重叠路径优先级 → 按路径特异性排序
- managed proxy mode → seccomp 阻断用户新建 AF_UNIX/socketpair

#### 5.4.3 Windows Backend（T5 x86_64 / T6 aarch64）

**三挡阶梯**（对齐里程碑）：

| Tier | 机制 | 时机 |
|---|---|---|
| **Tier 1 (Weak)** | Job Object + Restricted Token（剥离 Administrators SID + SeDebug/SeShutdown/SeTakeOwnership） | **L1 必交付** |
| **Tier 2 (Partial-fs)** | Tier 1 + AppContainer profile；fs 通过 grant ACE 到 AppContainer SID 实现白名单 | L2 |
| **Tier 3 (Full)** | Tier 2 + WFP user-mode 网络白名单（IP:port 级） | L3 |

**Windows IPC**：无 fd 3 语义 → 用 named pipe（`\\.\pipe\VolundBridge.<pid>.<uuid>`）+ `STARTUPINFOEXW` 显式继承 handle；协议层（JSON-RPC over NDJSON）跨平台一致。

**arm64 Windows 特别注意**：
- GitHub Actions `windows-11-arm` runner GA 后可真机测试
- SmartScreen 对未签名 arm64 sandbox exe 屏蔽率高 → L1 起做 authenticode 签名，L4 前升级 EV 证书
- WFP API 在 arm64 功能等价 x64，但 kernel-mode driver（不做）成本 2×

**AppContainer ACE 污染防护**：AppliedHandle::drop() 里 revoke；启动时扫描并清理 orphaned ACE（前次崩溃遗留）；命名 `VolundCode.Sandbox.<uuid>` 每 profile 独立。

### 5.5 Sandbox Tier 模型（跨平台统一暴露）

**四挡语义**（详见 [SANDBOX-COMPAT-r1](./SANDBOX-COMPAT-r1.md) §S3 ADR-4）：

| Tier | 语义 | UI 表现 |
|---|---|---|
| **Full** | fs 读写白名单 + syscall 过滤 + 网络白名单/关闭 | 静默 |
| **Partial** | fs 读写白名单 + syscall 过滤，网络只能全开/全关 | 状态栏 ⚠️ 徽章 |
| **Weak** | 仅资源上限（rlimit / Job Object）；无 fs / syscall 隔离 | 首屏一次说明 + doctor 红标 + 危险弹窗红条 |
| **None** | 无任何沙箱（`--dangerously-no-sandbox` 显式） | 首屏必须显式确认 + 每次危险操作弹窗 |

**tier 冻结**：native-bridge 启动时探测一次，session 内不再变化；tier 变化必须重启 volund。

**telemetry**：`sandbox.tier` 事件启动即发（含 platform/arch/libc/os_version/kernel/tier/features），本地 sink 默认，OTel opt-in。

> ★ **自我进化：不接入（r10）**：sandbox 参数（profile / tier 判定 / syscall 过滤规则）**永不参与自调优**——安全边界冻结（[§15.5](./15-self-evolution.md)）。进化系统**仅观察** sandbox violation 频率 / tier 降级频率，发现高频异常时记 Memory(scope=tuning) 教训提示用户（如"该项目常触发 fs.write 越界，建议检查 AGENT.md 权限配置"），但**不调整**任何 sandbox 参数。

### 5.6 volund-search 设计

**独立可执行二进制 + 常驻 worker 模式**（r9 改造，原 napi-rs addon 作废）。导出能力不变，但调用经 IPC：

```ts
// packages/native-bridge/src/search.ts（worker RPC 客户端封装）
export function search(opts: SearchOpts, signal: AbortSignal): AsyncIterable<SearchMatch>
export function astQuery(opts: AstQueryOpts, signal: AbortSignal): AsyncIterable<AstMatch>

interface SearchOpts {
  pattern: string
  path: string                                        // 起点
  glob?: string                                        // 过滤
  caseInsensitive?: boolean
  maxMatches?: number
  ignore?: string[]                                    // gitignore-like
}

interface SearchMatch {
  path: string
  lineNumber: number
  line: string
  span?: { start: number; end: number }               // 字节偏移
}
```

- 基于 `grep` crate（ripgrep 底层）+ `ignore` crate
- 支持 tree-sitter 语法查询（`astQuery`），比如"找所有导出的 async function"
- 返回是**流式**的（IPC chunked notifications，见 §5.6.3），避免大项目一次性拉完

**Windows mmap 注意**：ripgrep 底层 `grep-searcher` 在 Windows 下 mmap 会独占锁大文件；与 §4 Write/Edit 冲突时 volund-search 自动降级 read+buffer 模式（不 mmap）。

#### 5.6.1 Worker 生命周期

```
启动：native-bridge 启动时 spawn volund-search worker（一次）
       ├─ posix_spawn（Unix）/ CreateProcess（Windows）
       ├─ 继承 fd 3（Unix）/ named pipe（Windows）作 IPC 通道
       ├─ worker 发 "ready" 握手 → native-bridge 标 available.search = true
       └─ 握手超时 5s → available.search = false → JS fallback

常驻：worker 进程存活整个 session，复用连接池 / ripgrep 内部缓存

idle 回收：worker 空闲（无 RPC 调用）超过 30s → 自行退出（省内存）
          下次调用时 native-bridge 重新 spawn（首次 ~50ms 启动开销）

崩溃恢复：worker 异常退出 → native-bridge 感知 exit code
          ├─ 自动重启（最多 3 次/session，超限标 available.search=false 不再试）
          ├─ 重启期间调用降级 JS fallback
          └─ emit error.raised { code: 'search_worker_crashed', exit_code }
```

#### 5.6.2 IPC 协议（复用 §5.3.2 模式）

复用 `volund-sandbox --run-plugin` 已验证的 **fd 3（Unix）/ named pipe（Windows）+ NDJSON JSON-RPC 2.0** 通道模式（见 §5.3.2 / §6.4.3），仅 method 命名空间不同：

| 方向 | 形态 | 示例 |
|---|---|---|
| request（main → worker） | 带 id | `{"jsonrpc":"2.0","id":1,"method":"search.query","params":{...SearchOpts}}` |
| response（worker → main） | 匹配 id | `{"jsonrpc":"2.0","id":1,"result":{"truncated":false}}` 或 error |
| streaming chunk（worker → main） | 无 id，带 streamId | `{"jsonrpc":"2.0","method":"search.chunk","streamId":"s_1","params":{"match":{...}}}` |
| stream end（worker → main） | 无 id，带 streamId | `{"jsonrpc":"2.0","method":"search.end","streamId":"s_1"}` |
| abort（main → worker） | 无 id，带 streamId | `{"jsonrpc":"2.0","method":"search.abort","streamId":"s_1"}` |

**method 前缀约定**：`search.*`（volund-search worker）/ `fs.*`（volund-fs worker）。worker 侧只认自己前缀，未知 method 返 `-32601`。

> ★ **r13-D1（sandbox 协议形态修正）**：`sandbox.*` 前缀**从本表删除**——volund-sandbox 是**一次性进程协议**（exec 模式：stdin 喂 JSON → stdout 收 JSON → 进程退出，见 §5.3.1），**不是**常驻 NDJSON JSON-RPC 通道。只有 search / fs 两个 worker 走本节的常驻协议。

**★ r13-I6：单行尺寸上限**：NDJSON 逐行读取**必须带上限**——`max_line_bytes = 4MB`（`config [native] ipc_max_line_bytes` 可配）。超限行为：该 RPC 返 JSON-RPC error `-32600`（invalid request）+ telemetry `ipc.line_too_large`，**通道存活**（读端丢弃该行直至下一个 `\n`）。设计推论：任何入参可能 > 4MB 的 API（如大文件内容）**必须走分片子协议**（§6.4.3 附件分片 / `fs.read_chunk` 流式），不得单行直传——否则一行 2GB JSON 可 OOM 主进程。强制点：ipc 单测（5MB 单行 → 拒绝且通道存活）。

#### 5.6.3 流式结果协议

`search` / `astQuery` 的 `AsyncIterable<SearchMatch>` 走 chunked notifications（复用 §6.4.3 附件分片 `readAttachment(token, {chunk})` 的先例）：

```
main 调 search(opts):
  1. 生成 streamId，发 search.query request（params 含 opts + streamId）
  2. worker 收到 → 开始流式扫 → 每个 match 发 search.chunk notification
  3. main 侧 AsyncIterable yield 每个 chunk.match
  4. worker 扫完发 search.end → main AsyncIterable 完成
  5. main 中途 abort（AbortSignal）→ 发 search.abort → worker 停扫
```

**背压**：main 侧为每个 streamId 维护接收缓冲；若 main 消费慢（AsyncIterable 未 yield）缓冲超过 `max_stream_buffer_matches`（默认 10000）→ 发 search.abort + 视为截断（返部分结果 + truncated=true）。不无限堆积。

**JS Fallback**（找不到二进制 / worker 崩溃超限）：
- `search` → `fast-glob` + `readline` + JS RegExp（慢 10-100x，但可用）
- `astQuery` → 直接返回错误（tree-sitter JS 太重不做 fallback）

### 5.7 volund-fs 设计

**独立可执行二进制 + 常驻 worker 模式**（r9 改造，原 napi-rs addon 作废）。导出能力不变，但调用经 IPC：

```ts
// packages/native-bridge/src/fs.ts（worker RPC 客户端封装）
export function computeDiff(before: string, after: string, opts?: DiffOpts): Promise<string>  // unified diff
export function countTokens(text: string, model: string): Promise<number>                       // tiktoken-rs
export function readLarge(path: string, opts?: ReadLargeOpts): Promise<string>                  // mmap + 编码检测
```

> **契约变化**（vs napi addon）：`computeDiff` / `countTokens` 从同步直返改为 `Promise`（IPC 异步往返）。NativeBridge 对外接口签名（§5.8）已是 Promise，无需上层改。

- Diff 用 `similar` crate（Rust patience diff，比 JS 快 10x+）
- Token 计数用 `tiktoken-rs`（BPE 缓存 in-memory，比重复 JS 实现快）
- 大文件读取用 mmap + `encoding_rs`（避免整文件读 UTF-8 再截）
  - **mmap 上限 100 MB**，且只用于 read-only；超限或写入路径 → 走 stream
  - Windows 下 mmap 独占锁行为已知；volund-fs 需与 volund-search 协调（读写不同文件时无冲突）

**Worker 生命周期**：同 §5.6.1（握手 → 常驻 → idle 30s 回收 → 崩溃重启 3 次上限）。

**IPC 协议**：同 §5.6.2，method 前缀 `fs.*`：
- `fs.diff`（request/response，返 diff 文本）
- `fs.count_tokens`（request/response，返 token 数）
- `fs.read_large`（request/response；超大文件可选流式，走 `fs.read_chunk` notifications，同 §5.6.3 模式）

**BPE 表打包**：tiktoken 的 BPE 数据放主 npm 包 `@volund/native-fs-common`（~2MB，跨平台共享），**worker 启动时**从该包路径加载到内存（非 addon 进程内静态链接）。native 平台包只装 worker 二进制，避免 8 target × 2MB 的冗余。

**JS Fallback**（找不到二进制 / worker 崩溃超限）：
- `computeDiff` → `diff` npm package（慢但可用）
- `countTokens` → `gpt-tokenizer` npm package（准确度低一点）
- `readLarge` → `fs.createReadStream` + iconv-lite

### 5.8 native-bridge 结构（packages/native-bridge）

```
packages/native-bridge/
├─ src/
│  ├─ index.ts                # 对外统一入口 export NativeBridge
│  ├─ resolver.ts             # 二进制路径发现（platform 包内 bin 路径）
│  ├─ worker-pool.ts          # 常驻 worker 管理（spawn / 握手 / 重启 / idle 回收）
│  ├─ sandbox.ts              # 封装 volund-sandbox 子进程调用 + probe/tier 缓存
│  ├─ search.ts               # 封装 volund-search worker（IPC RPC 客户端）
│  ├─ fs.ts                   # 封装 volund-fs worker（IPC RPC 客户端）
│  ├─ ipc.ts                  # 共享 IPC 协议层（NDJSON JSON-RPC over fd3/pipe）
│  ├─ fallback/
│  │  ├─ search-js.ts         # fast-glob + regexp
│  │  └─ fs-js.ts             # diff + tokenizer JS 实现
│  └─ types.ts                # NativeBridge 接口 + AttachmentRef handle + SandboxTier
└─ package.json               # 声明 24 个 platform 包为 optionalDependencies（产物为二进制）
```

**统一接口**（签名不变，实现改 IPC）：

```ts
export interface NativeBridge {
  readonly available: {
    // r13-P1：探测期为 'probing'（三态），REPL 先起、结果异步回填（见下方启动时序契约）
    sandbox: boolean | 'probing'
    search: boolean | 'probing'
    fs: boolean | 'probing'
    sandbox_tier: 'full' | 'partial' | 'weak' | 'none'   // 探测后冻结
    sandbox_info: {
      platform: string
      arch: string
      libc: 'gnu' | 'musl' | null
      os_version: string
      features: Record<string, unknown>
      known_limitations: string[]
    }
  }

  //-------- sandbox --------
  exec(opts: ExecOpts, signal: AbortSignal): Promise<ExecResult>
  runPlugin(opts: RunPluginOpts, signal: AbortSignal): Promise<PluginProcHandle>

  //-------- search（经 worker IPC） --------
  search(opts: SearchOpts, signal: AbortSignal): AsyncIterable<SearchMatch>
  astQuery(opts: AstQueryOpts, signal: AbortSignal): AsyncIterable<AstMatch>

  //-------- fs（经 worker IPC） --------
  computeDiff(before: string, after: string, opts?: DiffOpts): Promise<string>
  countTokens(text: string, model: string): Promise<number>
  readLarge(path: string, opts?: ReadLargeOpts): Promise<string>

  //-------- attachment handle --------
  allocHandle(bytes: Uint8Array): NativeHandle       // 传给 provider 用
  releaseHandle(handle: NativeHandle): void
}
```

**解析逻辑**（`resolver.ts`，r9 改造）：

```
resolveBinary(kind):  # kind = 'sandbox' | 'search' | 'fs'
  triple = `${process.platform}-${process.arch}${libcSuffix()}`
  pkg = `@volund/native-${kind}-${triple}`
  try:
    pkgDir = require.resolve(pkg)         # 平台包已 installed → 拿到包目录
    binPath = readPackageJson(pkgDir).bin.volund   # 平台包 bin 字段指向二进制
    return path.join(pkgDir, binPath)
  catch:
    return null                           # 触发 fallback（仅 search/fs）
                                          # sandbox 走 tier=none 语义
```

**WorkerPool 管理**（`worker-pool.ts`，r9 新增）：

```ts
class WorkerPool {
  private workers: Map<'search' | 'fs', WorkerHandle>
  private restartCount: Map<'search' | 'fs', number>   # session 内重启计数，上限 3

  async ensureWorker(kind: 'search' | 'fs'): Promise<WorkerHandle | null> {
    if (this.workers.has(kind)) return this.workers.get(kind)!
    const binPath = resolveBinary(kind)
    if (!binPath) return null                              # 触发 JS fallback
    const handle = await this.spawnAndHandshake(binPath)
    handle.onExit = (code) => this.handleCrash(kind, code)
    handle.onIdle = () => this.workers.delete(kind)        # 30s idle 自行退出
    this.workers.set(kind, handle)
    return handle
  }

  private handleCrash(kind, code) {
    this.workers.delete(kind)
    if (this.restartCount.get(kind)++ < 3) {
      emit('error.raised', { code: `${kind}_worker_crashed`, exit_code: code, will_restart: true })
      # 下次 ensureWorker 自动重启
    } else {
      emit('error.raised', { code: `${kind}_worker_crashed`, exit_code: code, will_restart: false, degraded: true })
      # 标 available[kind] = false，后续走 JS fallback
    }
  }
}
```

**available 探测**（启动时一次）：
- `available.sandbox` = sandbox 二进制存在 + `--probe` 5s 内返合法 JSON
- `available.search` = search 二进制存在 + worker 握手成功（ready 通知 5s 内）
- `available.fs` = fs 二进制存在 + worker 握手成功
- 任一失败 → 对应 `available.* = false` + 走 JS fallback（仅 search/fs；sandbox → tier=none）
- 结果**冻结**在 SessionState，session 内不重探（tier 变化需重启 volund）

**★ 启动时序契约（r13-P1，P0 级）**——探测串行还是并行、阻塞 REPL 与否，钉死：

1. **全部并行发起**：probe 与 search/fs worker 握手用 `Promise.allSettled` 同时发起，互不等待（最坏路径从 +15s 串行降到 +5s）。
2. **REPL 就绪不等探测**：UI 先起、输入符先出；探测结果**异步回填**——`available.*` 初始值 `probing`（三态：`probing | true | false`），回填后 TopBar 徽标刷新。
3. **探测未完成期间的按需等待**：副作用工具（Bash/Write/Edit）被调用 → `await` 对应探测（带剩余超时预算）；**只读工具不等待**（search/fs 未就绪先走 JS fallback，回填后自动切 native）。
4. **tier 冻结起点 = 探测完成时刻**（§5.5 冻结约束不变：冻结后 session 内不重探）。
5. **首次运行的二进制下载必须显示进度且可 Ctrl+C 跳过**（降级提示：跳过 = 本 session JS fallback / tier=none）。
- 强制点：集成测试——探测 stub 挂 5s，assert REPL 100ms 内可用（对应 §9.10 冷启动预算）。

**★ 二进制来源优先级（r13-D1，四级链钉死）**：`resolveBinary` 的完整决策序：

```
env（VOLUND_NATIVE_<KIND>_PATH 显式指定，doctor/调试用）
  > bundled（§5.9 平台包 require.resolve 命中）
  > download（按 §5.9 矩阵 + digest 校验拉 GitHub Release，缓存目录 ~/.volund/native/<ver>/）
  > cache（上次下载的版本，版本号不匹配则视为 miss）
```

任一级命中即用；全 miss → JS fallback（search/fs）或 tier=none（sandbox）。分发模型若经 r12 REM-45 换轨认定，本链的 download 级同步改写（§5.9 联动）。

**对接 tool-kit / permission / UI**：
- `Bash` 检查 sandbox tier → tier=none 时拒绝或走 --dangerous 覆盖
- 权限弹窗根据 tier 选择红条 / 徽章 / 静默
- `Grep` 检查 search 是否可用 → 不可用则用 JS fallback
- `volund doctor` sandbox 段显示当前 tier + search/fs worker 状态（pid / rss / restart_count）

### 5.9 平台包矩阵（对齐 §9）

**24 个平台包 = 8 target × 3 crate**（产物均为独立二进制）。**L1 先发 12 包（4 target × 3），L2 扩 24 包（补 Windows + musl）**：

| Crate → | `native-sandbox` | `native-search` | `native-fs` | 里程碑 |
|---|---|---|---|---|
| `darwin-arm64` | ✅ | ✅ | ✅ | **L1** |
| `darwin-x64` | ✅ | ✅ | ✅ | **L1** |
| `linux-x64-gnu` | ✅ | ✅ | ✅ | **L1** |
| `linux-arm64-gnu` | ✅ | ✅ | ✅ | **L1** |
| `linux-x64-musl` | ✅ | ✅ | ✅ | L2 |
| `linux-arm64-musl` | ✅ | ✅ | ✅ | L2 |
| `win32-x64-msvc` | ✅ | ✅ | ✅ | L2 |
| `win32-arm64-msvc` | ✅ | ✅ | ✅ | L2 |

**额外**：
- `@volund/native-fs-common`（跨平台 BPE 表，主 npm 包，非平台包，fs worker 启动时读）
- `@volund/native-sandbox-darwin-universal`（可选：universal2 合并包，Homebrew 用）
- ★ **r9 新增**：`@volund/native-search-darwin-universal` / `@volund/native-fs-darwin-universal`（可选 universal2 合并包）。原 napi-rs 不支持 universal `.node` 的限制（SANDBOX-COMPAT §S2 历史约束）**随二进制化解除**，darwin-arm64 + darwin-x64 可像 sandbox 一样 `lipo -create` 合并（Homebrew / 体积优化用）。

**依赖对接**：
- `crates/xtask` 负责跨平台交叉编译 + universal2 合并，输出到 `platforms/*/`
- 每个 platform 包 `package.json` 声明 `os` / `cpu` / `libc`，pnpm install 时按当前机器过滤
- `native-bridge` 的 `optionalDependencies` 挂载全 24 个平台包
- pnpm 在不匹配的平台上跳过（不报错，装不上就是 undefined）
- CI matrix：见 §9.4（8-runner 矩阵，含 `windows-11-arm`）

### 5.10 边界与安全清单

| 规则                                                                              | 强制点                                          |
|-----------------------------------------------------------------------------------|-------------------------------------------------|
| JS 侧**只有** `packages/native-bridge` 可以 `require` platform 包                   | ESLint no-restricted-imports                    |
| `native-bridge` **不感知具体工具**，只暴露原语（exec / runPlugin / search / diff / probe / ...） | code review                                      |
| Sandbox binary **必须**是独立进程，不 dlopen 进 Node                                | crates/volund-sandbox 是 bin，不是 lib          |
| **L1: mac/linux 4-target 全绿是 L1 发版闸门**（L2 扩至 8-target 全绿）；任一 target CI 红 → 不允许 release | GitHub branch protection                        |
| **每 target 必须跑真机 escape 逃逸测试**（无 runner 时明示 `unverified` 不发 stable） | `.github/workflows/sandbox-escape.yml`          |
| `--dangerously-no-sandbox` **必须**打日志 + UI 红条 + telemetry `security.event` + 每次危险操作二次弹窗（不再"一次授权全程免弹"） | apps/cli + permission 强制                      |
| Rust worker 崩溃（异常退出）**必须**降级到 JS fallback（仅 search/fs，重启 3 次上限后标 available=false）；sandbox 崩溃 → session tier=none | try/catch + `error.raised` + WorkerPool 自动重启 |
| Native handle **必须**在 Session 结束时全部释放；handle 绑定 pid + TTL，crash-safe   | native-bridge 维护 handle 集合 + 启动 GC        |
| Sandbox profile **禁止**放宽已在 PermissionSpec 声明的权限                          | crates/volund-sandbox 单元测试                  |
| **sbpl 路径转义 / seccomp 架构分表 / AppContainer ACE 回滚** 强制单元测试覆盖       | crates 单元测试                                 |
| Rust crate **禁止**发布到 npm（只发平台产物包）                                     | pnpm workspace 配置                              |
| `volund-search` 结果**必须**尊重 `.gitignore` / `.volundignore`                     | search crate 单元测试                            |
| 插件宿主 **必须**通过 `volund-sandbox --run-plugin` 启动，不允许 plugin-runtime 内直接 `child_process.spawn(node)` | ESLint + code review                             |
| 插件 profile **必须**由 `native-bridge` 从 `manifest.permissions` 生成，plugin-runtime 不得越级 | plugin-runtime 单元测试                          |
| 插件子进程崩溃 / OOM **必须**触发 `error.raised` 且不影响主 session                  | plugin-runtime 集成测试                          |
| 插件 RPC method **必须**在 `manifest.permissions.volund` 白名单内，未声明直接拒绝    | plugin-runtime bridge 单元测试                    |
| **`sandbox.tier` telemetry 事件启动即发，含 os/arch/kernel/features/limitations**   | native-bridge 启动路径                          |
| **codex fork 保留原 LICENSE + NOTICE**（Apache-2.0，OpenAI 归属）                      | 代码审查 + 发布前检查                            |
| **codex workspace 依赖只减不增**（CI `cargo deny` 禁止新增 codex-* 依赖）             | CI license/dependency check                      |
| **bundled bwrap 二进制 SHA256 校验**（运行时 verify_digest + CI 构建 digest 比对）   | volund-sandbox 启动路径 + CI step                |
| Windows 二进制**必须** authenticode 签名（L1 起）；macOS **必须** notarize（L2 起）   | release CI 强制                                  |
| Named pipe / fd 3 IPC 句柄**禁止**继承给白名单外子进程                              | volund-sandbox spawn 层控制                     |

### 5.11 里程碑

**每个里程碑发版前必须满足**（r9 调整：L1 砍平台范围，分层闸门）：
- **L1**：mac/linux **4-target** CI 全绿（含 native + escape test）+ `volund doctor --strict` 4 target 各跑通过 + macOS notarize（L2 起）
- **L2+**：扩至 **8-target** CI 全绿（补 Windows Tier1 + Linux musl）+ Windows authenticode 签名

- **L1（MVP）**：
  - **vendor codex 沙箱三件套**（sandboxing + linux-sandbox + windows-sandbox-rs）+ 12 workspace 依赖 crate，跑通 **mac/linux 4-target** 编译
  - `volund-sandbox exec` + `--probe` 四挡（Full/Partial/Weak/None）
  - macOS Backend（codex seatbelt.rs）完整（T1/T2）
  - Linux Backend：bundled bwrap 默认 + landlock fallback（T3/T4 glibc）
  - `volund-search` + `volund-fs` 改**独立二进制 worker**（r9 架构变更：原 napi addon 作废，三产物形态统一，见 §5.6/§5.7）
  - `native-bridge` 二进制路径发现 + WorkerPool（spawn/握手/重启/idle 回收）+ tier 探测（对接 codex `get_platform_sandbox`）+ 冻结缓存 + JS fallback（search/fs）
  - **mac/linux 4-target** CI matrix 全绿 + escape 测试基础用例（复用 codex smoketests + seatbelt/landlock tests）
  - bundled bwrap SHA256 校验机制落地

- **L2**：
  - **平台扩面**：Windows Tier 1 (Job + Restricted Token，codex windows-sandbox-rs)（T5/T6）+ Linux musl × 2 target；平台包 12 → 24
  - `volund-sandbox --run-plugin` 模式落地（三平台），支持 §6.4.3 JSON-RPC bridge
  - Windows Tier 2 (AppContainer file 隔离 + ACL 回滚，codex setup.rs)
  - macOS notarize 上线 + Windows authenticode 自签
  - plugin-runtime v1 集成
  - **剥离 codex-utils-* → volund-utils**（workspace 依赖只减不增 L2 目标）

- **L3**：
  - AST 查询（tree-sitter）
  - 沙箱违规实时日志（codex violation.rs + telemetry）
  - Windows Tier 3 (WFP user-mode 网络白名单，codex wfp.rs)
  - 插件资源守护（`setrlimit` + Job 强制 kill）
  - 外部安全审计发起
  - **剥离 codex-protocol → volund-permission + codex-network-proxy**（L3 目标）

- **L4**：
  - `volund-sandbox --test-escape` self red-team CLI
  - EV 代码签名（Windows）
  - 沙箱违规实时 dashboard（volund doctor + 官网 troubleshooting）
  - volund-search 支持自定义 codec / 二进制识别

- **v2**：
  - FreeBSD (Capsicum) / OpenBSD (pledge+unveil) backend（社区 PR）
  - Windows kernel-mode WFP driver（若签名成本降低）

### 5.12 codex fork 治理（r9 新增）

> 沙箱一等公民地位建立在 fork OpenAI codex-rs 上（§5.1 / SANDBOX-COMPAT ADR-1）。fork 是外部依赖，需主动治理以缓解「单点失败」风险。本节**不改架构**（fork 仍是核心决策），仅补治理流程。

**治理措施**：

| 维度 | 措施 |
|---|---|
| **upstream 跟踪** | 维护 `crates/volund-sandbox-vendor/CODEOWNERS` + 每季度评估 rebase（记录 fork 偏离点 + 原因） |
| **安全公告订阅** | 订阅 [codex-rs security advisories](https://github.com/openai/codex/security/advisories) + GitHub Dependabot；每 release 前检查 codex 自上次 fork 以来的安全修复 |
| **抽象层（已有，显式声明）** | sandbox profile 生成 + tier 探测经 `native-bridge` 抽象（§5.8），上层 core/tools/permission **不直接依赖** codex 类型；fork 替换或剥离不影响上层契约 |
| **workspace 依赖只减不增** | 每 milestone 剥离 ≥2 crate（§5.1 已有硬约束，CI `cargo deny` 强制）；目标：长期把 vendor 范围收敛到最小（仅 sandboxing 核心，utils/protocol 等逐步自研替代） |
| **License 变更应急** | 若 codex-rs 未来改 license（如转 BUSL/SSPL），2 周内评估自研 seatbelt/bwrap/AppContainer 三件套的可行性；因有抽象层（上条），替换成本可控 |
| **fork 仓库镜像** | vendor 同时维护一份内部 mirror（防 upstream 强推删库 / force-push 历史）；mirror 地址记录在 `crates/volund-sandbox-vendor/UPSTREAM.md` |

**已知限制**（写入 release notes，非 bug）：
- codex-rs 的产品方向、API 演进、license 变更都是外部变量，无法控制
- fork 漂移期间，codex 上游修的 bug 在本仓库可能滞后（每季度 rebase 缓解）
