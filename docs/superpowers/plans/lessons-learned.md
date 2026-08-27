# 经验库（Lessons Learned）

> **维护规则**（监控/主 agent 必须遵守）：
> 1. 条目三段式：**问题 → 根因 → 可执行规则**；规则必须是可执行指令，不是口号；单条 ≤15 行。
> 2. 只追加/更新，不删除历史正文；同根因已存在则更新原条目（补实例与日期），不新建。
> 3. 状态：`active`（生效）/ `promoted-candidate`（建议晋升为治理文档条款，由主 agent 提案、BDFL 批准）/ `obsolete`（规则失效，保留正文）。
> 4. 条目总数 >40 时由主 agent 提议归档 obsolete 项。

---

### LL-1 证据行号会漂移，以符号名为准
- 类别：验证陷阱｜日期：2026-08-15｜来源：REVIEW-r11 审计
- 问题：审计/验收引用的 `file:line` 在代码或文档修订后失效，导致误报"问题不存在"或"修复不成立"。
- 根因：行号是快照性证据，符号名才是稳定锚点。
- 规则：任何结论的代码引用必须 `file:line` + 符号名双锚定；复验时先按符号定位再取新行号，行号变了但符号在 ≠ FAIL。
- 状态：active

### LL-2 两路独立核查结论冲突时必须裁定，不得择优引用
- 类别：流程缺口｜日期：2026-08-15｜来源：REVIEW-r11（"500 calls/turn" 语义两路核查不一致）
- 问题：两个并行核查对同一事实给出不同结论（配额是 per-turn 还是 per-process），若直接择优引用会埋下错误结论。
- 根因：浅层 grep（只核默认值）与深层 grep（追接线路径）深度不同，结论可信度不同但表面上都是"有证据"。
- 规则：验收中遇证据冲突，必须用可运行的专项测试裁定，裁定前该标准记 ⚠️ 并在报告 Ambiguity 节说明；禁止因"某一路有 file:line"就采信。
- 状态：active

### LL-3 任务的"完成"必须包含文档同步，改码不同步文档=未完成
- 类别：根因分析｜日期：2026-08-15｜来源：REVIEW-r11（spec/ADR/治理文档三层分裂的系统性根因）
- 问题：本仓库曾出现"主进程机制已实现有测试，但 bridge 未暴露、CLI 未接线、spec 声称已上线"的多层不同步（PLUGIN-PROVIDER-r1），最终导致 24 条治理文档条目失实。
- 根因：任务验收只看代码产出，文档同步（spec 卷 / 16-capability-traceability / 治理文档）从未进入任何人的 DoD。
- 规则：任何 REM 的验收报告必须有"文档同步检查"节；16-traceability 未更新视为 P1 缺陷；执行 agent 的 DoD 必须含文档同步项。
- 状态：active

### LL-4 声明完成 ≠ 验证完成：一切"已实现"都要现场取证
- 类别：验证陷阱｜日期：2026-08-15｜来源：REVIEW-r11（`session.on` no-op、bridge 假实现、`observe()` 零调用）
- 问题：类型定义、SDK 签名、spec 声明都"存在"，但运行时是 no-op/抛错/零调用方——按声明验收会全部误判为完成。
- 根因：存在性检查（符号在不在）与行为验证（调用路径通不通）是两个层次，前者廉价后者昂贵，偷懒会全部停在前者。
- 规则：验收必须含至少一条动态证据（运行测试/命令的真实输出）或调用链证据（调用方 grep 非空）；只有静态存在性证据时 verdict 最高只能给 PARTIAL。
- 状态：active

### LL-5 worktree 不能放 /tmp：macOS realpath 守卫会让部分测试预存失败
- 类别：环境陷阱｜日期：2026-08-16｜来源：r13 批次 1（REM-54 验收发现）
- 问题：git worktree 建在 `/tmp/volund-rem/*` 时，`packages/shared/path-guard` 与 `apps/cli` 共 37 例测试预存失败（干净 base 上可复现），易被误判为 REM 引入的回归。
- 根因：macOS `/tmp` 是 `/private/tmp` 的 symlink，`fs.realpath(PWD)` 与字符串 cwd 不一致，触发仓库的 path-guard 安全守卫（`--cwd` 归一化规则 W6）。
- 规则：并行执行用的 worktree 一律放真实路径目录（如 `~/volund-worktrees/`），禁用 `/tmp`；验收时若见 path-guard/cli 失败，先在干净 base 复现排除环境因素再定性。
- 状态：active

### LL-6 执行 agent 的 DoD 必须含仓库 CI 等价命令（format/lint/跨平台），且 lint error 提取要用 `x` 标记
- 类别：流程缺口｜日期：2026-08-17｜来源：r13 批次 1 CI 修复（4/5 PR 首轮 check 失败）
- 问题：批次 1 五个 PR 中四个首轮 CI 失败：① 全部挂 quality 第一步 `pnpm format:check`（agent 没跑 oxfmt）；② #111 挂 ts (windows)（实现只验了 mac：win32 分隔符/USERPROFILE/盘符 resolve 差异）；③ #112/#113 挂 lint 真错误（悬浮 Promise / 未用参数）。
- 根因：执行 agent 的任务卡 DoD 只写了「test + typecheck 绿」，未含 `pnpm format`、`pnpm lint`，也没有 Windows 语义意识；本地验证 lint error 时误把 warning 帮助文本当 error（oxlint 输出中 `x` 才是 error、`!` 是 warning）。
- 规则：① 执行 agent 任务卡 DoD 固定加：`pnpm format && pnpm turbo run build && pnpm lint`（type-aware lint 依赖先 build 出 dist 声明）+ 受影响包 test；② 路径/权限/IPC 类代码必须考虑 win32 差异（分隔符、HOME vs USERPROFILE、无盘符绝对路径的 resolve、8.3 短名）；③ lint 结果判定以 `grep "^  x "` 提取，CI 为最终裁决；④ 重负载并发类测试（如 storage 的 20 轮文件锁合并）在满载 Windows runner 上需显式 `it(..., 30_000)` 超时。
- 状态：active

### LL-7 storage 并发合并测试在满载 Windows runner 上有两种 flaky 形态，需要根治而非续命
- 类别：测试脆弱性｜日期：2026-08-17｜来源：r13 批次 2 CI（#117 ts windows 二次失败）
- 问题：`packages/storage/src/memory-runtime.test.ts` 的 20 轮双实例并发写用例，在满载 Windows runner 上先后以两种形态失败：① vitest 5s 默认超时（批次 1，已用 `it(..., 30_000)` 缓解）；② 锁竞争失败 `MemoryError: Unable to persist memory`（批次 2 #117，同基线的 #114/#115/#116 均过——非确定性）。
- 根因：该用例依赖真实文件锁的 3×1s 重试预算，慢 runner 上预算不足即抛应用级错误；且它在 ts matrix 里与其它包测试并行跑，负载不可控。
- 规则：① 遇 `memory-runtime` 测试失败先看失败形态（timeout vs MemoryError）并在干净基线判断是否 flaky，flaky 则 rerun + 记录；② 该测试的根治（重试预算可测控 / 串行化 / 减轮数+断言不变式）应排专门 REM，不再逐 PR 打补丁；③ 新写并发类测试必须给重试预算留测试钩子（env 或注入），禁止裸依赖真实时序。
- 状态：active

### LL-8 触碰平台二进制（/bin/sh、pwsh 等）的测试必须显式平台守卫；agent 本地 DoD 验不了异平台
- 类别：测试可移植性｜日期：2026-08-17｜来源：r13 批次 3a（#120 ts windows `spawn /bin/sh ENOENT`）
- 问题：REM-57 的三个用例走真实 `/bin/sh` 往返，mac 本地全绿，Windows runner 全挂 ENOENT——agent 的本地 DoD（test/typecheck/lint）天然无法发现异平台失败。
- 根因：平台专属二进制的测试没有 `it.skipIf(process.platform === 'win32')` 守卫；守卫粒度必须到「用例级」而非 describe 级（同一 describe 里可能混着 win32 必跑用例）。
- 规则：① 测试里 spawn 平台二进制（/bin/*、pwsh、sandbox bin）→ 用例级 `itUnix`/`itWin` 守卫，且反向平台的对应用例必须存在（不是全跳）；② 主会话核验 PR 时把「ts matrix 三平台」当作预期失败面预判（LL-6 补充）；③ GitHub action 下载 429 限流失败（checkout/tar.gz 下载失败）判 infra flake 直接 rerun，不计入修复项。
- 状态：active

### LL-9 暂存区有切片时，`git commit` 会吞并整个 index——提交前必须核对 name-status
- 类别：流程缺口｜日期：2026-08-23｜来源：self-evolution 线 ABI-00 切片（两次误并入）
- 问题：`git add <docs> && git commit` 在 index 已含上一会话 staged 的 ABI-00 切片时，把 59 个文件整体裹进了一个 docs commit；同一错误连续发生两次。
- 根因：`git commit` 提交的是**整个 index** 而非"我刚 add 的东西"；切片并存的工作树里 index 是共享状态。
- 规则：① 任何 commit 前必跑 `git diff --cached --name-status` 核对文件集；② index 里有他人/他线 staged 内容时，用 `git commit -- <paths>`（pathspec 只提交指定路径的工作树状态）或先 `git restore --staged` 隔离；③ 误并入后的修复是 `git reset --soft HEAD~1`（index/worktree 无损），禁 `--hard`。
- 状态：active

### LL-10 管道会吞掉 exit code：`cmd 2>&1 | tail` 能把红灯门禁打印成全绿
- 类别：验证陷阱｜日期：2026-08-23｜来源：ABI-00 隔离树门禁误判
- 问题：`pnpm turbo run test --force 2>&1 | tail -3` 的 exit code 是 `tail` 的（恒 0），core 测试实际红了却打印出 ALL_GATES_GREEN；同一形态还有 `failing_cmd | grep pattern && next`（grep 命中即 0）。
- 根因：管道序列的退出码默认取最后一节；门禁证据链里任何一节被管道截断，失败就被静默吞掉。
- 规则：① 门禁命令禁止接 `| tail/grep/head` 后直接采信——写日志文件再 `echo "gate:$?"` 显式取证（或 `set -o pipefail`）；② 报告门禁结果必须引用真实 exit code，不引用终端观感；③ CI 日志里的 `Failed:` 字样优先于本地摘要。
- 状态：active

### LL-11 spec 表格变更会触发 doc↔code 同步门禁，必须同轮改实现侧 registry
- 类别：流程缺口｜日期：2026-08-23｜来源：§21 spec 切片连破三闸
- 问题：附录 C 加了 `[reflection]` 行 → `verify:config-docs` 红（configKeyRegistry 缺 key）；§2.3/附录 D 加了 6 个事件 → `verify-event-schemas` 红（缺 schema 文件 + 计数 19）；core 事件计数测试硬编码 19 跟着红。一个纯文档切片连破三个实现侧门禁。
- 根因：本仓库把 spec 表当作代码 registry 的镜像源（r13-I4 / 附录 D.1 的 CI 强制），文档与实现是双向校验的同一契约。
- 规则：① 改附录 C/§2.3 事件表/附录 D 时，同轮必须改 `packages/shared` 对应 registry/schema/计数常量；② 自查命令：`pnpm verify:config-docs && pnpm verify:error-codes && node --test scripts/*.test.mjs`；③ spec-only 提交前也要跑全量 test 链（turbo test 含根校验任务）。
- 状态：active

### LL-12 monorepo 里下游包读的是 dist 旧产物——改了上游 src 先重建再诊断
- 类别：环境陷阱｜日期：2026-08-23｜来源：shared 事件枚举改动后 core 测试"反向"失败
- 问题：改了 `shared/src` 的事件枚举后 core 测试报 `expected 19 got 25` 的反向失败（期望新值、拿到旧值），看似测试写错，实为 core 解析的是 shared 的 **stale dist**。
- 根因：直接 `pnpm --filter <下游包> test` 不走 turbo 依赖序，上游包不会自动重建。
- 规则：① 跨包改动后用 `pnpm turbo run test`（turbo 按依赖拓扑先 build）或直接 `pnpm --filter <上游包> build` 再测下游；② 诊断"方向颠倒"的断言失败（expected 新值 got 旧值）时先怀疑 stale dist，不怀疑测试。
- 状态：active

### LL-13 Windows 上 `O_NOFOLLOW` 是 no-op：symlink 拒绝必须用可移植的 lstat 预检
- 类别：平台差异｜日期：2026-08-23｜来源：PR #127 ts (windows-2022) 红灯
- 问题：plugin-runtime 遗留态文件的 symlink 拒绝依赖 `open(O_NOFOLLOW)` 抛 ELOOP，macOS/Linux 正常，Windows 上该 flag 被静默忽略 → symlink 被跟随、`init()` 放行，测试报"resolved instead of rejecting"。
- 根因：`O_NOFOLLOW`/`O_SYMLINK` 类 flag 的语义是平台子集，Windows libuv 不实现；安全边界不能用平台子集 flag 表达。
- 规则：① 凡"拒绝 symlink/特殊文件"的安全检查，必须用 `lstat().isSymbolicLink()` 等可移植原语先行判定，平台 flag 只作 defense-in-depth；② CI Windows 失败的失败形态若是"该拒未拒"，优先排查平台 no-op flag；③ 新增平台相关 flag 时在同行注释标注各平台语义差异（LL-8 的代码侧对应物）。
- 状态：active

### LL-14 GitHub 网络抖动：api.github.com 与 git 传输可用性不同步，重试要带退避和真实 exit code
- 类别：环境陷阱｜日期：2026-08-23｜来源：self-evolution 线 push/fetch 间歇失败
- 问题：`git fetch/push` 对 github.com 反复 timeout/connection reset，但 `gh pr create`（走 api.github.com）同时可用；一次 push 重试循环因 `| tail -1 && break`（LL-10 同族）第一次失败就误退出。
- 根因：git 传输（ssh:22/443、https:443 github.com）与 REST API（api.github.com）是不同入口，封锁/抖动不同步。
- 规则：① `git fetch` 挂了时用 `gh api repos/<owner>/<repo>/branches/<name>` 验证远端 SHA 新鲜度，本地 `origin/main` 可能已是新的；② push 重试循环必须判断 git 真实 exit code（写日志再查），禁管道；③ 间歇性失败按 20-30s 退避重试 3-5 次再上报。
- 状态：active
