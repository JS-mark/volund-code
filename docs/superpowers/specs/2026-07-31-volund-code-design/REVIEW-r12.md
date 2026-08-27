> ↩ [返回索引 (README)](./README.md) · ← [上一轮: REVIEW-r11](./REVIEW-r11.md)

---

# REVIEW r12 · 剩余卷文档正确性审计 + 修正设计

- **审查范围**：r11 未覆盖的全部卷——§02 Agent Loop / §03 Provider & Router / §04 工具与权限 / §05 Rust 侧车 / §08 会话与配置 / §08b Context / §09 构建CI分发 / §12 治理 / §13 文档站 / §14 Onboarding。r11 审了插件/UI/memory 主题，本轮补全后**十卷全覆盖，审计闭环**。
- **审查日期**：2026-08-15（基准：main `5fa00a7`）
- **审查方法**：五路并行核查（①§02+§8b↔core/context ②§03↔provider-*/router ③§04+§14↔tool-kit/tools/permission/cli ④§05+§09↔crates/native-bridge/workflows ⑤§08+§12+§13↔storage/config/auth/docs），全部结论附 file:line；四项关键断言（Bash 5s 强杀 / Write-Edit 不过沙箱 / config 信任门未接线 / docs 假命令）经主审独立复核确认。
- **修正设计**：本文档每条差异的处置（A 改代码追设计 / B 改文档认现实）以 **REM-26 起编号**延续 [设计一致性整改方案](../../../superpowers/plans/2026-08-15-design-remediation.md)（现有 REM-1~25），可直接合入执行。

---

## 第一部分 · 总体判定

**结论：十卷的实现真实度呈"哑铃型"——契约层（类型/接口/核心算法/数值）普遍真实且质量高，但"组装层"（CLI 装配 / hook 派发 / 持久化 / 超时与并行度执行点）系统性未接线；另有一批 spec 写了、实现走了另一条路的"换轨"（分发模型 / replay 机制 / macOS 后端）需要 BDFL 裁定认现实。**

| 卷 | 审计条目 | 整块未实现 | 部分准确/偏差 | 总判定 |
|---|---:|---:|---:|---|
| §02 Agent Loop | 21 大项 | hooks 全谱派发¹ / 幂等去重接线 / 附件 handle 生命周期 / agentType 定义文件 | 8 项 | 🟡 核心循环真实；hook 与执行点系统性缺失 |
| §03 Provider & Router | 23 大项 | ESLint 边界三条 / @alias 链路² / listModels+complete / Runner 错误反应大半 | 12 项 | 🟡 契约与四家适配器真实；CLI 只装 Anthropic |
| §04 工具与权限 | 21 大项 | permissions.toml³ / 危险操作黑名单 / 25k 截断 / Write-Edit 沙箱化⁴ / tool 超时执行 | 9 项 | 🟡 契约贴合；**Bash 被 5s 强杀**⁵ |
| §05 Rust 侧车 | 19 大项 | platforms/ 平台包矩阵⁶ / 流式 chunk 协议 / alloc-handle / seccomp 接线 | 11 项 | 🟡 骨架真实；macOS 恒 Partial、Linux 无分层 |
| §08 会话与配置 | 21 大项 | §8.3.1 信任门产品接线⁷ / §8.2b 索引 / §8.5 SessionContextReader / OAuth refresh / keychain 层 | 10 项 | 🟡 存储核心真实；**replay 实为快照** |
| §08b Context | 8 大项 | token 三层接线 / CompactHooks / ContextPort 生产接线 | 5 项 | 🟢 数值最贴 spec；生产只剩字符近似估算 |
| §09 构建CI分发 | 26 大项 | npm publish 闭环 / SBOM / notarize 实操 / turbo 子任务 | 6 项 | 🟡 CI 矩阵超预期；**分发已换轨** |
| §12 开源治理 | 28 大项 | ISSUE_TEMPLATE / PR 模板 / CODEOWNERS / codeql / dco workflow | 6 项 | 🟡 四大文件真实；.github 只剩 workflows |
| §13 文档站 | 30 大项 | docs:gen:cli 生成管线 / config reference | 4 项 | 🟢 L1 页面全真且有 CI 强制；**CLI 页含假命令** |
| §14 Onboarding | 28 大项 | 3 步 onboarding 全流程 / Ollama 分支 / --reconfigure / 项目检测 | 9 项 | 🟡 Tier 披露/trust 真实；首跑体验未成体系 |

¹ 除 memory.* 外全部 hook 点（prePrompt/preProviderCall/pre/postToolUse/stop）从未派发——r11 发现 pre/postToolUse，本轮扩展确认全谱 + W13 depth 字段缺失。
² ui 包 picker 纯函数是孤儿代码；`models.aliases` 配置不存在。
³ 全仓库零引用；决策链步骤 1/2/4/5 在产品路径 no-op。
⁴ §4.3 表格标 ✅ 沙箱的 Write/Edit/MultiEdit 全部直接 node:fs 写入。
⁵ `native-bridge/src/sandbox.ts:27` 对所有 sandbox 调用统一 5s SIGKILL——`npm install`/`cargo build` 级命令必死。
⁶ `platforms/` 目录不存在；npm optionalDependencies 方案被 GitHub Release 下载整体替换。
⁷ `packages/config` 的 loadConfig（信任门+hash+禁覆盖过滤）库层完整有测试，生产 runtime 只 import parseTomlFile。

---

## 第二部分 · 逐卷审计结论（高密度摘要）

> 完整证据（file:line）见五路核查底稿；本节只保留会影响处置决策的判定。

### 2.1 §02 Agent Loop（🟡）

**真实**：ContentPart/AttachmentRef 模型（provider-kit:20-30）；immer+version（session.ts:66-74）；17 事件类型+UUIDv7（event-bus.ts:4-22,2）；B1 composer→system（runner.ts:143-147,203）；B2 上限 25+tool_loop_exhausted（runner.ts:129-132）；B3 abort 全链（runner.ts:62-67,199-207,293）；B4 首个 tool_use.start 即锁+violation 错误（runner.ts:209,240-246）；B6 作废不落盘+复用 tool_result（runner.ts:226-235 + 测试 211-236）；budget 三阈值+partial 返回（runner.ts:111-127,344-359 + subagent:98-105）；W8 权限收窄（runtime.ts:1179-1192）。

**未接线**：hooks 全谱（tools:503-526 与 runtime:1348-1365 均直通 executor，全仓库 runHooks 仅 memory.* 两处）；`tool.requested` 声明未 emit；幂等去重（idempotentSubscriber 无调用方；storage 用自己的无上限内存 Set，无 tail 二级查重——重启后重放事件会被重复写盘）；附件 handle 引用计数（handle 实为内容哈希文件名）；ENOSPC 降级。

**偏差**：Message.role 无 'tool'（tool_result 包在 user 里）；permissionCache 不在 SessionState（在 PermissionManager 私有）；routerState 字段不存在；B2 触顶无 systemNote；未知异常 turn.status='aborted' 而 'error' 枚举从不赋值；**并行度零消费**（capabilities.toolUse 三值 + Tool.parallelSafe 声明后无任何调度点读取——Bash 与 Write 可并行）；**框架级 timeout 零执行**（AbortSignal.any 不存在，只有个别 tool 自理）；ctx.kv 按 (plugin,turnId) 而非 (event+来源+toolUseId)；嵌套深度硬顶 3（配置无效）。

**spec 盲点（实现自定）**：`session.snapshot` 每 turn 全量 state 进 JSONL（绕过 17 事件体系）；subagent 事件重发会换 event.id；budget 对顶层也生效+第四维度 toolCallMax；Task 并发上限 4。

### 2.2 §03 Provider & Router（🟡）

**真实**：ProviderChunk 10 kind 一字不差（provider-kit:131-145）；usage 覆盖式合并（runner.ts:417）；argsFragment Map 聚合（runner.ts:409-419）；RawMeta 四命名空间且各家只读自己的（openai:305/gemini:324/ollama:412）；Router 三策略全实现且测试覆盖（router/index.ts:52-552）；sticky 早锁+两 router 主动尊重（router:161-167,485-493）；四家适配器 message.interrupted 三场景全覆盖+contract tests 断言（provider-contract.test.ts:48-51）；TextDecoder streaming 四家全有+emoji 边界测试；ProviderRegistry 真实被 CLI 使用（runtime.ts:1253-1258）。

**未接线**：**CLI 只构造 AnthropicClient**（runtime.ts:1229）——OpenAI/Gemini/Ollama 包完整但 apps 下零引用；FallbackRouter/CostAwareRouter 零装配；listModels/complete 契约缺失（countTokens 仅 Gemini 实现）；@alias 断链（picker 纯函数孤儿 + 无 models.aliases 配置 + ModelPicker 硬编码 2 个模型）；**ESLint 三条边界全落空**（仓库用 oxlint，.oxlintrc.json 无相关规则）；RouterPolicy.init 无人调用。

**偏差**：错误分类 17 类而非 11 类（shared/errors.ts:4-21）；**provider throw 与 error chunk 都不进 router.onError**（runner 全文仅 1 处 onError 且在 interrupted 分支内——§3.6 Runner 列大半未落地）；ProviderCapabilities 缺 pricing/audio 多 streamResume；parse 失败的 tool_use 仍会执行（塞 parseError 标记而非转 tool_result error）；重试上限 3 次/退避 1s/4s/16s 超出 spec 的 2 次/1s/4s；sticky+partial tool_use 直接结束不询问 onError（比 spec 更保守）；anthropic 适配器不读自己的 rawMeta（cacheControl 逃生舱失效）；anthropic 忽略 temperature/topP/stopSequences 等请求字段；FallbackRouter 以 throw 表达不可路由。

**spec 盲点（实现自定，值得回写）**：streamResume capability + 防误用护栏；Ollama 远程明文审批门；HttpPort/CredentialPort DI 结构替代 http-kit 包；gemini/ollama 合成 tool_use id；[router] 是项目层禁止键（config:23）。

### 2.3 §04 工具与权限（🟡）

**真实**：Tool 接口全字段（tool-kit:35-45）；11 个 builtin 工具+Skill.activate+Memory.*（tools:482-494）；Edit 唯一性校验（tools:238-239）；Bash tier=none 拒绝（sandbox.ts:63）+sandbox-exec -p /bin/sh -c（macos.rs:110-117）；PermissionSpec 六字段；决策链 8 步顺序精确一致（permission:67-84）；auto-allow 规则集一致（:91-104）；串行队列（:116-123）；schema 验证先于 permission（tools:508-510）；mcp:/plugin: 前缀校验；危险 flag 警告+telemetry；W8/深度/崩溃隔离（tools:470-479）。

**未实现**：**timeoutMs 60s 无任何执行点**——且 **bridge 对所有 sandbox 调用统一 5s SIGKILL**（sandbox.ts:27，Rust 侧 timeout_ms 有默认但 output() 不 enforce）→ Bash 实际 5 秒必死；**Write/Edit/MultiEdit 不过沙箱**（atomicWrite 直接 node:fs/promises，tools:75-84）；permissions.toml 不存在（决策链 1/2/4/5 步 no-op，persist 回调无人传）；allow-project/forever/deny-forever 三档不可达（弹窗只有 a/s/d）；危险操作黑名单（rm -rf/sudo/RC）零实现；25k 截断已导出无调用点；错误脱敏不存在；MCP 工具注册逻辑在但生产不构造连接；**PermissionSpec→sandbox profile 翻译不存在**（Bash 硬编码 cwd 读写，runtime:1315-1339）。

**偏差**：Edit 无 replace_all、字段名 oldText/newText、0 命中与多命中同错误；Write 无覆盖提示/无 diff 预览；**跨 cwd 是硬拒绝而非弹窗**（Read 也读不了 cwd 外）；Skill.activate 空 spec 不命中 auto-allow（每次弹窗）；非交互权限静默 deny 无明确报错；--dangerously 红条仅非 TUI；WebSearch permissionSpec 用 custom 而非 net。

**spec 盲点（实现自定，多为好设计）**：lockfile+原子写+备份事务三件套并发保护；permission glob 按字面路径处理（**传入 glob 会被当字面**——方言缺失的现实后果）；手写 schema 子集验证；walk 跳过 .git/node_modules；net key 按 origin 归一。

### 2.4 §05 Rust 侧车（🟡）

**真实**：三产物独立二进制无 napi；三模式 CLI（exec/--run-plugin/--probe）；bundled bwrap memfd 嵌入+SHA256+CI Docker 双架构可复现校验（bundled_bwrap.rs:35-59 + native.yml:220-227）；Windows Tier1+Tier2 合体（Job+RestrictedToken+AppContainer+ACE journal+orphan 清理，windows.rs:109-436）；escape 测试 Unix+Windows 分层（sandbox-escape.yml:79-101）；WorkerPool 参数精确（握手 5s/idle 30s/重启 3 次，worker-pool.ts:34-66）；插件宿主唯一经 sandbox（plugin.rs:39 宿主嵌入二进制）。

**换轨（需 BDFL 认定）**：**分发模型整体换轨**——npm optionalDependencies 平台包 → 四级 resolver 链（env override > bundled assets > **GitHub Release 下载+sha256** > unavailable，resolver.ts:68-157）；platforms/ 目录与 24 平台包不存在；standalone bun compile 已提前落地成为 bundled 来源。**macOS 后端 shell-out `/usr/bin/sandbox-exec` 而非 link libSystem**（macos.rs:109-121），**恒报 Partial 无 Full 路径**；Linux 无 landlock fallback、无 Partial/Weak 分层（只有 Full/None 二值，seccomp "pending vendor integration"，linux.rs:37-41）；vendor 从"fork 12 crate"缩为"4 文件 provenance 快照"（VENDOR.toml 声明 allowlist，Cargo.lock 中 codex 依赖计数=0，实为按快照重写）。

**未实现**：流式 chunk 协议（search 一次性批量返回，search.abort 是空操作）；alloc/releaseHandle；NativeBridge 统一类与 available 聚合（doctor 不显示 worker 状态）；60KB 折叠/ProfileTooLarge；网络白名单（macOS 全放）；protected subpath/glob 否认/重叠路径优先级；Windows --run-plugin（只认 fd3）。

**spec 盲点（实现自定）**：--verify-bwrap-digest CLI；resolver 下载的供应链细节（GitHub repo 硬编码 JS-mark/volund-code）；probe features 键名三平台不一致；sandbox.* method 前缀（实际一次性 stdin/stdout 非 JSON-RPC）。

### 2.5 §08 会话与配置（🟡）

**真实**：JSONL append+fsync+v 首字段+id 幂等（storage:32-69）；stream.delta 不落盘；附件 hash 索引+拒绝内联二进制；v>1 拒绝；session.resumed+半途 turn 强制 aborted（runtime:402-411）；Argon2id 参数精确（encrypted-store:19-30）；20 次锁 24h+auth.state.json；verify-first；备份 GC 7d/500MB/LRU+manifest 完整性；.volundlock 重试锁；telemetry 本地+sanitize（redact key/bearer/userinfo）。

**未接线**：**§8.3.1 信任门库层完整但生产零调用**（config/index.ts:62-84 有信任门+hash+禁覆盖过滤+测试；runtime.ts:20 只 import parseTomlFile，项目级 config 从不加载，welcome 硬编码 project disabled）——**且 apps/docs/docs/reference/cli.md:46 宣称 `--trust-project-config` flag 存在（文档撒谎，主审复核确认）**；§8.2b 行级索引零实现（resume 是全量读入后 slice，无 fseek）；§8.5 SessionContextReader 零实现（且 load 无 10MB 上限）；OAuth refresh/revoke 端口缺失；auth 事件谱 12/22 且 unlock_result 语义走样；**生产无 keychain 层**（runtime.ts:1167 只传 encrypted+env；SECURITY.md:4 还宣称走 OS keychain）。

**偏差**：**replay 实为每 turn 全量 session.snapshot 快照**（runtime:496-507）——非事件重放，长会话存储放大（每 turn 重写全部 messages），且 snapshot 不在 17 事件表内；退避公式 min(2^(n-3)*100ms,5s) 远弱于 spec 的 min(2^(n-2),60s)（20 次爆破从"数分钟"变"约 20 秒"）；zod 启动校验不存在（未知 key 静默收下——spec 盲点）；telemetry 单文件不分日、无 metrics 文件；flock 实为 wx 锁（崩溃残留不释放，无 stale GC）；`volund history` 命令不存在但 docs 宣称存在（cli.md:32）。

### 2.6 §08b Context（🟢 最贴合）

**真实**：契约在 provider-kit 实现在 context（归属正确）；SlidingWindow 全参数精确（0.85/0.6/8192/20，context:58-65）；tool 配对保护+budget 预扣（:129-168）；SummaryPolicy+失败回退+summary 重包 untrusted（:223-282）；缓存 key 含 model+LRU 5000；preCompact veto 尊重；compact 异步+compacting 状态；pinned-to-context 强制保留；`volund context` CLI 命令面齐全（cli.ts:236-297）；进化参数默认表与 §8b.14 一致（evolution-engine:3-6）。

**未接线**：**token 三层估算生产只用字符近似**（CLI 构造 policy 不传 counter，native-bridge 的 countTokens+gpt-tokenizer 零消费）；CompactHooks 生产不传（插件无法拦截压缩，CompactHookResult 多字段未实现）；**ContextPort 未进 createProductionPorts**——生产 `volund context *` 一律 "not connected"；ContextPolicyRegistry/SemanticPolicy（已实现！）零引用；§8b.10 事件 4/7 缺失。

**盲点（实现超前）**：SemanticPolicy 已完整实现（含本地 embedding fail-closed+云显式授权——spec 标 v2）；summary 消息 id 非 UUIDv7。

### 2.7 §09 构建CI分发（🟡）

**真实**：rolldown 单 bin+CI 断言 shebang；pnpm catalog；**CI native 8-target 全量矩阵**（含 windows-11-arm/双 musl/aarch64 cross）+lipo universal2 三产物+cargo deny（deny.toml 全禁 codex-*，比 spec"只减不增"更严格）+bwrap digest 双重校验；sandbox-escape 分层 verification+Graviton 真机 job；ts×3 平台+frozen-lockfile；changesets Version PR 流程；GitHub Release 产物+checksums.sha256。

**换轨/未实现**：**npm publish 闭环不存在**（release.yml 无 publish step；changesets privatePackages version:false——workspace 内部包不发版，spec 的平台包版本策略整条失效）；`pnpm build:native` 幻影命令确认（root scripts 无，但 CLAUDE.md:54/CONTRIBUTING.md:60 仍在教）；SBOM 只有 dry-run 合同；notarize/authenticode 只是闸门检测+自签 smoke；turbo 无 docs:build/build:native task；"VitePress 8"实为 1.x。

**盲点（实现自建）**：release evidence 脚本族（七八个 release:* 脚本）自成体系；resolver 直连 GitHub Release 下载的供应链契约；windows-2022 需 Node 22.13.0+turbo concurrency=1 的环境坑。

### 2.8 §12 治理（🟡）

**真实**：LICENSE Apache-2.0 全文+Cargo workspace license；SECURITY.md 48h/14d/不开公开 issue/范围表完整；CoC v2.1；CONTRIBUTING 覆盖 §12.5 清单绝大部分；Renovate 提前到位；docs.yml 部署；18/25 提交带 Signed-off-by。

**缺失**：**`.github/` 下只有 workflows/**——ISSUE_TEMPLATE 四件套、PR 模板、CODEOWNERS、FUNDING、codeql、dco workflow 全不存在（CONTRIBUTING.md:27 "bug template"、:90 "PR template"、:97 `pnpm docs:gen:cli` 三处引用不存在的文件）；DCO 有漏网（bot 提交与 1 个人工提交无 sign-off）；RFC 清单缺 r10 的 2 条（CLI 命令集变更/进化护栏）；npm package.json 无 license 字段；§12.6b 七步协作流程无落地物。

### 2.9 §13 文档站（🟢）

**真实**：VitePress+private；**L1 必需页全齐且有 CI 硬性强制**（verify-l1-docs.test.mjs 清单进 pnpm test）；security-model 含 Prompt Injection Threat Model 段（逐项满足 §13.5）；TypeDoc API 生成+docs.yml 重建；GitHub Pages；**零追踪脚本**（grep 全无）；手写/生成分目录；中文站提前全量交付（spec 排 L4）。

**失实**：**CLI reference 是手写快照且含假命令**（`--trust-project-config` 与 `volund history list/show` 均不存在于 CLI——文档撒谎，主审复核确认）；`docs:gen:cli` 生成管线不存在但 CONTRIBUTING 在教；域名实为 js-mark.com/volund-code 非 volund-code.dev；无 changelog 同步机制。

### 2.10 §14 Onboarding（🟡）

**真实**：verify-first-save-second+真实 API 校验；mask 输入+--api-key-stdin；Tier 四挡披露渲染+--strict-sandbox exit 3+None 强制确认句；workspace trust 完整（DirectoryTrustStore+敏感目录拒绝+三态 scope+`volund trust` 命令+telemetry）；隐私声明文本（非 TUI 路径）。

**未实现**：**3 步 onboarding 全流程不存在**（无 provider 选择屏/无 Step 1 of 3/无首任务建议）；Ollama 分支（包内明文门原语已写好，CLI 不装配）；--reconfigure；项目首次进入检测+AGENT.md 生成；`sandbox.tier.acknowledged/declined` 事件；`--sandbox=<tier>` flag 与 `[sandbox] minimum_tier`；非交互无 provider 的 exit 2 明确报错；keychain（同 §08）；**trust 写盘发生在隐私披露打印之前**（违反"写 config 前展示"顺序，cli.ts:453-509 vs :534）。

---

## 第三部分 · 高危误导/伤害条目（按危害排序）

**A. 直接伤害用户（代码问题，非文档）**：

1. **Bash 5s 强杀**（sandbox.ts:27）——`npm install`/`cargo build`/测试套件全部必死；spec 的 60s 默认与 Task 10min 均无执行点。**当前产品不可能完成 L1 DoD"跑测试"**。
2. **Write/Edit 不过沙箱**——§4.5"双层安全"叙事只对 Bash 成立；模型驱动的文件写入无 syscall 层兜底。
3. **hooks 全谱未派发**——preToolUse veto（防 rm -rf 的招牌示例）、prePrompt、preProviderCall、stop 全部不存在；安全 hook 无从谈起。
4. **退避防护弱化 12 倍**（20 次爆破约 20 秒 vs spec 数分钟）。
5. **wx 锁崩溃残留**——进程崩溃后 `.volundlock`/`.gc.lock` 永久锁死（无 flock 内核释放语义，无 stale GC）。

**B. 文档撒谎（会误导 AI 代理与用户）**：

6. `apps/docs/docs/reference/cli.md:46` `--trust-project-config`——flag 不存在。
7. `apps/docs/docs/reference/cli.md:32` `volund history list/show`——命令不存在。
8. `CONTRIBUTING.md:97` `pnpm docs:gen:cli` + `:27` bug template + `:90` PR template——全部不存在。
9. `SECURITY.md:4` "routes credentials through OS keychains"——生产无 keychain 层。
10. `CLAUDE.md:54`/`CONTRIBUTING.md:60` `pnpm build:native`——幻影命令（r11 已发现，本轮确认仍在）。
11. §5.9/§9.5 平台包分发矩阵整章——已被 GitHub Release 模型替换；§5.4.1 "link libSystem"——实为 shell-out。

---

## 第四部分 · 修正设计（REM-26 ~ REM-50，合入整改方案）

> 编号延续 [设计一致性整改方案](../../../superpowers/plans/2026-08-15-design-remediation.md)（REM-1~25）。每项：出口（A 改代码 / B 改文档 / A+B 双轨）+ 验收标准。

### WP4 级 · P0（直接伤害用户 / 违反硬约束，与 REM-1~7 同批）

| # | 问题 | 处置 | 验收 |
|---|---|---|---|
| **REM-26** | Bash 5s 强杀（bridge 常量 5_000） | **A**：`sandbox.ts` timeout 从 ExecRequest.timeout_ms 读取（默认 60_000），透传 tool.timeoutMs；同步实现 §2.5 的 `AbortSignal.any([turnAbort, timeout])` 框架级合并（覆盖 Task 10min） | e2e：`sleep 8` 成功返回；60s 超时路径 SIGTERM→SIGKILL 阶梯；turn 中断传播 |
| **REM-27** | Write/Edit/MultiEdit 不过沙箱 | **决策点**：A 路线=三工具的文件写入走 `volund-sandbox exec`（写白名单=cwd，Bash 同框架）；B 路线=spec §4.3 表改标注"写入走 permission+lockfile+backup 事务，不经 syscall 沙箱"并同步安全叙事。**推荐 A**（§1.1 一等公民条款："所有执行第三方/用户/未审计代码的路径"——模型驱动的写文件 qualifies） | A：越 cwd 写入被 sandbox 拒绝的 escape 测试；B：AGENT.md §4.7/§1.1 措辞更新 |
| **REM-28** | hooks 全谱未派发（扩展 REM-5） | **A**：Runner/ToolExecutor 接线 prePrompt/preProviderCall/postProviderCall/pre/postToolUse/stop（复用 runHooks pipeline + veto 短路）；hook ctx 补 depth/isSubagent（W13）；同步落地超时语义——**builtin 域 fail-closed、其余 fail-open**（spec §2.6 需同步补此分域，设计缺口） | e2e 复刻 §6.4.2 veto rm -rf；prePrompt 改写用户消息；深度>0 的 hook 收到 isSubagent |
| **REM-29** | config 信任门产品接线 | **A**：runtime 改用 loadConfig（含信任门+hash+禁覆盖过滤）；加 `--trust-project-config` flag；`config.trust.toml` 持久化信任记录；**同步修 docs 两处假命令**（cli.md:32/46） | e2e：恶意项目 config 的 baseUrl 覆盖被忽略+warning；非交互默认 deny；首次弹信任 |
| **REM-30** | permissions.toml + 四档不可达 | **A**（联动 REM-15）：持久化层（全局+项目 toml）；弹窗补 project/forever 档（键位扩展）；deny-forever 黑名单文件 | 跨 session 的 allow-forever 生效；项目 toml 提交进仓库可团队共享 |
| **REM-31** | 危险操作黑名单缺失 | **A**：Bash 层 rm -rf 模式硬拒+sudo 拒绝+RC 文件强制弹窗（§4.6 表三项）；接 truncateToolResult 到 Runner（25k 截断） | 单测三类 pattern；大输出 tool_result 被截断含标记 |

### WP5 级 · P1（能力补齐 / 决策类）

| # | 问题 | 处置 | 验收 |
|---|---|---|---|
| **REM-32** | 并行度零消费 | **A**：Runner 消费 capabilities.toolUse（sequential→串行）+ Tool.parallelSafe（false→串行队列）；Bash/MultiEdit 不再与 Write 并行 | 单测：parallelSafe=false 的工具与其它 tool_use 串行 |
| **REM-33** | 幂等去重接线 | **A**：storage 落盘前查 JSONL tail（N=1000 二级查重，spec NEW-P3-3）；idempotentSubscriber 用于 telemetry/hooks 订阅 | 重放事件不重复写盘的单测 |
| **REM-34** | @alias 链路断链 | **A**（联动 REM-13）：`models.aliases` config schema+runtime 读取+InputBox 接线孤儿 picker 函数+剥离逻辑；未识别 alias 报错列出可用项 | 手验 §7.5.3 三场景；`@<alias>` 切模型 e2e |
| **REM-35** | multi-provider CLI 装配 | **A**：registry 注册 openai/gemini/ollama（按 config 存在的 credential 动态）；router.type=fallback 的 TOML 装载路径；Ollama 分支 onboarding（复用包内明文门原语） | 配置 fallback 链后跨 provider 切换 e2e；Ollama 本地模型对话 |
| **REM-36** | 边界 ESLint 落空 | **A**：oxlint 规则补三条（provider-* 禁 undici/禁 process.env API key/Runner 禁 import provider-*）；架构测试补"ui 不 import provider/tool-kit"（REM-24 联动） | CI 红灯可被故意违规触发（负向测试） |
| **REM-37** | Runner 错误反应缺失 | **A**：provider throw 与 error chunk 统一进 router.onError；context_length 触发紧急压缩+重试一次；auth 类错误带 `volund login` 提示 | 单测每 category 的 Runner 行为对齐 §3.6 表 |
| **REM-38** | macOS/Linux 沙箱分层失真 | **决策点**：A=macOS 评估 libSystem FFI 或 Full 判定依据；Linux 补 landlock fallback+WSL1 检测+seccomp 接线。B=spec §5.4 承认现状（macOS Partial/二值 Linux）并在 tier 表标注。**推荐先 B 认现实 + 建 A 的 spike issue**（codex vendor 里两者都有参考实现） | tier 表与 --probe 输出一致；文档不再承诺未实现的挡位 |
| **REM-39** | keychain 层 | **A**：至少 macOS Keychain（swift-security 或 keyring 等价）生产接线；SECURITY.md:4 措辞先改真 | macOS 上 login 后 keychain 可见凭据 |
| **REM-40** | context 生产接线三缺 | **A**：token counter 注入（native→gpt-tokenizer→近似三层）；ContextPort 进 createProductionPorts；CompactHooks 接 plugin hook pipeline | `volund context show` 生产可用；压缩 token 数来自真实 tokenizer |
| **REM-41** | replay 快照机制 | **决策点**：A=实现事件重放（去 session.snapshot）；B=spec 契约化 session.snapshot（补事件表+payload 上限+与 v 字段的迁移语义）。**推荐 B 先行**（快照对 resume 性能友好，但必须补：单行上限、写入频率、17 事件表登记）+ 长期 A | spec 有 snapshot 契约；50MB 会话 resume <2s 基准测试 |
| **REM-42** | onboarding 3 步流程 | **A**（L1 承诺）：provider 选择屏+首任务建议+中断恢复；trust 写盘挪到隐私披露之后 | 手验 §14.2 全流程 ≤60s |
| **REM-43** | 退避公式弱化 | **A**：改 `min(2^(n-2)s, 60s)` 对齐 spec | 单测锁定公式 |
| **REM-44** | wx 锁崩溃残留 | **A**：锁文件写 pid+启动 GC 清 >1h 陈旧锁（spec §8.6.1 原文）；错误信息补 pid | 杀进程后新实例可自动接管 |

### WP6 级 · P2（长尾，认现实或择机）

| # | 问题 | 处置 |
|---|---|---|
| **REM-45** | 分发模型换轨 | **B**：spec §5.8/§5.9/§9.5/§9.6 按 GitHub Release 四级 resolver 链+standalone 重写；ADR 记录弃用 npm 平台包的决策与理由（供应链影响：GitHub Release 仓库硬编码需参数化） |
| **REM-46** | vendor 现实 | **B**：§5.12/SANDBOX-COMPAT ADR-1 补记"按 provenance 快照重写"现状（VENDOR.toml allowlist 机制值得回写 spec 为治理契约） |
| **REM-47** | 治理补件 | **A**：ISSUE_TEMPLATE 四件套+PR 模板+CODEOWNERS+dco workflow（或删 CONTRIBUTING 引用）；RFC 清单补 2 条；npm packages 补 license 字段；DCO 补签纪律入 CI |
| **REM-48** | docs 真伪检测 | **A**：verify-l1-docs 扩展——扫描 reference/cli.md 中的命令/flag 与 citty 定义 diff（手写过渡期的漂移闸门）；`docs:gen:cli` 要么真实现要么从 CONTRIBUTING 删除 |
| **REM-49** | 类型语义对齐 | **A+B**：Message.role 补 'tool' 或 spec 认 user-wrapping；turn.status 'error' 赋值或删枚举；错误码 17 类回写 §3.6；事件名对齐（sandbox.probe→probe.completed 或反之）；stream_resume/Ollama 门/合成 id 四个"实现自加好设计"回写 spec |
| **REM-50** | spec 盲点补契 | **B**：未知 config key 策略（warn+ignore）；permission glob 方言（当前字面路径——要么实现 picomatch 要么 spec 声明 v1 只支持字面）；resolver 四级链；parallelSafe 消费点；Ollama 明文门；`session.snapshot`（REM-41 联动） |

### 处置顺序建议

```
REM-26 → REM-28 → REM-27/31（安全叙事恢复）
  ↓
REM-29/30/44（信任与权限持久化）
  ↓
REM-32~37（执行点接线批次）
  ↓
REM-38/41/45/46（BDFL 决策批次：沙箱分层/replay/分发/vendor）
  ↓
REM-39/40/42/43 + WP6 长尾
```

---

## 第五部分 · 与 r11/整改方案的关系

- r11 + r12 = **十卷全覆盖 + 治理文件**，文档正确性审计闭环。
- REM-1~25（已有）覆盖插件/UI/memory；**REM-26~50（本轮）覆盖其余**。两批可并行执行，仅 REM-5↔28、REM-13↔34、REM-15↔30、REM-24↔36 有联动。
- 16-capability-traceability 建议在两批 REM 完成后统一刷新（其 memory 三行已过时，r11 已记录）。

## 建议下一轮（r13）聚焦

1. REM-26/27/28 完成后的**安全叙事复审**（§4 双层安全 + §6.4.2 hook 示例是否真实可跑）
2. **L1 DoD 可达性重估**：Bash 5s 强杀修复后，"改文件+跑测试+提 PR"端到端是否走通（当前不可能）
3. spec 换轨四项（REM-38/41/45/46）的 BDFL 批注

---

## 变更日志

| 日期 | 版本 | 内容 |
|---|---|---|
| 2026-08-15 | r12 v1 | 剩余十卷（02/03/04/05/08/08b/09/12/13/14）文档正确性审计：五路并行核查 + 四项主审复核。总体判定"哑铃型"——契约层真实、组装层系统性未接线。最高危：Bash 5s 强杀（REM-26）/ Write-Edit 不过沙箱（REM-27）/ hooks 全谱未派发（REM-28）/ config 信任门库好产品未接线且 docs 撒谎（REM-29）/ 权限四档三档（REM-30）。分发/vendor/replay/macOS 后端四项换轨需 BDFL 裁定（REM-38/41/45/46）。修正设计 REM-26~50 延续整改方案编号，可直接合入。与 r11 合并后审计闭环。 |
