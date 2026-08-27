> ↩ [返回索引 (README)](./README.md) · ← [REVIEW-r8](./REVIEW-r8.md)

---

# REVIEW r9 · 「设计本身好不好」独立复审 + 处置落地

- 审查范围：在 r6/r7/r8（聚焦「契约自洽性 + 文档漂移」）基础上，本轮聚焦 **「设计本身好不好」**——合理性、缺点、扩展性、实用性四个维度
- 审查日期：2026-08-01
- 审查方法：通读 16 个 spec 文件 + 3 份 REVIEW + SANDBOX-COMPAT + PLUGIN-PROVIDER 白皮书，刻意避开 r6-r8 已覆盖的两条主线
- 结论摘要：架构/契约/安全纵深一流；但**范围对单人维护者过大**、**context 智能层规格缺失**、**若干实用性硬伤**。本轮与用户确认 5 条指令 + 4 个决策点，落地 **10 项处置**。

---

## 第一部分 · 独立复审发现（10 类系统性短板）

### 范围与复杂度（最大实用性风险）

1. **复杂度预算超标**：16 spec 文件 / 24 平台包 / Rust sandbox fork codex / 4 provider / 6 扩展机制 / 17 core 事件 + 21 auth 事件。§10 估 L1 5-7 周、总计 4-5 月，**乐观到不真实**（单人现实 12-18 月）。
2. **Memory 过度工程**（§6.12）：模型面工具 + pinned + 四层降级 + fence-aware split + BM25 + 6 hook + CLI 子树——但 LLM 主导写 memory 本身不可靠。**用户决策：维持现状，本轮不动**。
3. **核心智能层规格缺失**：ContextPolicy 在 §2.4 只是黑盒 `shouldCompact`/`buildPrompt`，无算法细节。对 AI 编码工具，context 管理是成败关键，却完全 hand-wave。

### 运行时与成本

4. **stream 中断「整 turn 重跑」烧钱**（§3.9a）：弱网/429 反复重跑 = 重复计费 input token + 重复执行 tool。resume-from-offset 推 v2 的理由对，但「复用已完成 tool_result」的中间方案 spec 没考虑。
5. **per-plugin 子进程 30-50MB × N**：CLI 工具叠 N 个插件轻松吃 500MB-1GB。**用户决策：接受（隔离一等公民的代价），本轮不动**。
6. **codex fork 单点失败**：沙箱一等公民绑死外部项目，license 变更 / 上游演进 / 安全 backport 都不可控。

### UX 与数据

7. **untrusted 包裹是「诚实的安慰剂」**：spec 自己承认 LLM 对标签尊重是 best-effort。**用户决策：已是当前最优解，本轮不动（仅记已知限制）**。
8. **hook 并发共享状态把锅甩给作者**（§2.5）：插件作者一定会写依赖共享状态的 hook 且不会正确加锁。
9. **`@` 双模式选择器是 UX 倒退**（§7.5.3）：每次 @ 弹二选一 popup 惩罚高频 @file 操作。
10. **JSONL session 无大小管理**（§8.2）：长会话膨胀、resume 慢、无截断/归档。

---

## 第二部分 · 用户指令 + 决策点

| 维度 | 用户决策 |
|---|---|
| Rust 产物形态 | **3 个独立二进制**（sandbox + search worker + fs worker + IPC 统一） |
| L1 平台范围 | **mac/linux 4 target**（Windows Tier1 + musl 推 L2） |
| ContextPolicy | **三策略全规格化**（Sliding L1 / Summary L2 / Semantic v2），L1 只落地 Sliding |
| @ 前缀 | **统一 picker**（alias 置顶高亮 + 文件候选跟后，无二选一 popup） |
| Memory | **不动**（维持现状） |
| codex fork | **维持现状**，仅补治理（持续跟踪 upstream + 单点失败缓解） |
| provider-plugin | header-template 模式**提前到 L3**（不推 v2） |

---

## 第三部分 · 10 项处置落地表

| # | 处置 | 落地位置 | 状态 |
|---|---|---|---|
| 1 | **新增 ContextPolicy 章节**（三策略全规格化） | 新建 [`08b-context-policy.md`](./08b-context-policy.md)（~280 行：契约 + Sliding L1 + Summary L2 + Semantic v2 + token 估算 + tool 配对保护 + summary untrusted 安全 + preCompact/postCompact 拦截型 hook + 插件 contributePolicy + 失败回退 + 边界清单 + 跨节落地） | ✅ |
| 2 | **@ 选择器改统一 picker** | [`07-terminal-ui.md`](./07-terminal-ui.md) §7.5.3 重写（alias 置顶 ⭐ + 文件候选 📄 + 前缀过滤 + Tab 切 type + `@!` 强制 model / `@@` 强制 file）+ §7.7 边界 + §7.8 L1 里程碑 + [`11-cli-commands.md`](./11-cli-commands.md) §11.5 前缀表 + [`03-provider-router.md`](./03-provider-router.md) §3.9 UI 入口 | ✅ |
| 3 | **JSONL 分段加载与索引** | [`08-session-config.md`](./08-session-config.md) 新增 §8.2b（行级索引 lazy build + sourceHash 失效 + 增量追加 + loadSession range/tailTurns API + resume 只读最后 20 turn + 50MB GC 提示 + 6 条边界） | ✅ |
| 4 | **Rust 全二进制化** | [`05-rust-sidecar.md`](./05-rust-sidecar.md) §5.2 产物表 + §5.6 search（worker 生命周期 + IPC 协议 + 流式结果协议）+ §5.7 fs（worker + 异步化）+ §5.8 native-bridge（resolver 改二进制 + WorkerPool + 崩溃重启）+ §5.9 universal2 解除 + §5.10 边界；[`01-repo-layout.md`](./01-repo-layout.md) §1.1 目录树 + §1.6 分发模型；[`09-build-ci-dist.md`](./09-build-ci-dist.md) §9.1 构建栈 + §9.3 turbo outputs | ✅ |
| 5 | **L1 平台范围切分**（mac/linux 4 target） | [`05-rust-sidecar.md`](./05-rust-sidecar.md) §5 开头硬约束 + 口径说明 + §5.1 目标 + §5.9 矩阵 L1/L2 标注 + §5.10 边界 + §5.11 里程碑；[`10-milestones.md`](./10-milestones.md) L1/L2/L4 重写 + 时间估算（L1 3-4 周 / 总计 3-4 月）+ 闸门分层；[`09-build-ci-dist.md`](./09-build-ci-dist.md) §9.4 CI matrix 分层 + §9.5 release + §9.8 边界 + §9.9 里程碑；[`01-repo-layout.md`](./01-repo-layout.md) §1.6；[`README.md`](./README.md) TL;DR + 附属文档表；[`AGENT.md`](../../../AGENT.md) §4.11；[`06a-plugins-core.md`](./06a-plugins-core.md) Windows 策略；[`14-onboarding.md`](./14-onboarding.md) §14.3b + §14.8；[`SANDBOX-COMPAT-r1.md`](./SANDBOX-COMPAT-r1.md) banner + §S1.1 + §S2 矩阵 + §S3 ADR-3 + §S6 + §S10 + §S13 | ✅ |
| 6 | **stream 中断复用 tool_result** | [`03-provider-router.md`](./03-provider-router.md) §3.9a 规则 4 重写（复用已落盘 tool_result + 只重发 provider.stream + 不重跑已完成 tool_use + 省输入 token）+ 规则 5 区分字节级续传 vs Runner 状态复用；[`02-agent-loop.md`](./02-agent-loop.md) §2.4 loop 注释同步 | ✅ |
| 7 | **hook 框架级 KV store** | [`02-agent-loop.md`](./02-agent-loop.md) §2.5 B5（ctx.kv 命名空间 + 框架保证互斥）+ §2.6 执行语义（命名空间隔离规则）；[`06a-plugins-core.md`](./06a-plugins-core.md) §6.4.1 VolundBridge 新增 `volund.hook.kv`（get/set/delete/clear） | ✅ |
| 8 | **codex fork 单点失败缓解** | [`05-rust-sidecar.md`](./05-rust-sidecar.md) §5.1 目标表补「持续跟踪 upstream」+ 新增 §5.12 codex fork 治理（upstream 跟踪 + 安全公告订阅 + 抽象层声明 + 只减不增 + license 变更应急 + fork 仓库镜像） | ✅ |
| 9 | **provider-plugin header-template 提前 L3** | [`PLUGIN-PROVIDER-r1.md`](./PLUGIN-PROVIDER-r1.md) §P12 重写（L3 = header-template + ProviderRegistry + @alias + stream 通道 + 参考实现；v2-β = signing；v2-GA = 审计）；[`06b-prompt-composer.md`](./06b-prompt-composer.md) §6.10 插件里程碑表；[`10-milestones.md`](./10-milestones.md) L3 条目补 provider-plugin | ✅ |
| 10 | **README + changelog + REVIEW-r9 汇总** | [`README.md`](./README.md) 目录表加 §8b + 附属文档表加 REVIEW-r9 + TL;DR Rust 面积行；新建本文件；各文件 changelog 追加 r9 行 | ✅ |

---

## 第四部分 · 数字对比（含 r6/r7/r8/r9 四轮）

| 级别 | r6 初查 | r7 复审 | r8 文档一致性 | r9 设计本身 |
|---|---|---|---|---|
| P0 | 7 | 6（修后 0） | 0 | —（本轮不分级，10 类短板全处置） |
| P1 | 11 | 14（修后 0） | 0 | — |
| P2 | 14 | 19（修后 14） | 6（修后 0） | — |
| P3 | 10 | 13（修后 8） | 0 | — |

> r6-r8 聚焦「写得对不对」（契约/安全/文档），r9 聚焦「设计好不好」（范围/智能层/UX/成本）。两者正交，本轮 10 项处置不与历史 P0-P3 冲突。

---

## 第五部分 · 仍存在的已知限制（非 bug，本轮明确不动）

- **Memory 系统过度工程**（短板 2）：用户决策维持现状。已知风险：LLM 主导写 memory 不可能保证质量；Memory/Skill/AGENT.md/plugin-prompt 四机制语义重叠。建议 L2 落地后用真实用户数据评估，若模型写出的 memory 质量差，再砍模型面 write 工具。
- **per-plugin 子进程内存**（短板 5）：用户决策接受。30-50MB × N 对 CLI 工具是实打实负担，但隔离一等公民的代价。若未来成为痛点，可考虑「同类插件分时复用」或「懒启动（hook 触发才 spawn）」。
- **untrusted 包裹非数学保证**（短板 7）：用户决策维持。当前 LLM 未被训练尊重 `<untrusted>` 特定标签，它是「诚实的安慰剂」——给模型借口拒绝 + telemetry 统计 + 未来接口。真正有效的 injection 防御（结构化分离 instruction/data channel）未做，记为 known-limitation。
- **codex fork 外部依赖**（短板 6）：已加治理（§5.12）但本质风险不变——codex-rs 的产品方向/license/API 演进是不可控外部变量。
- **复杂度预算**（短板 1）：L1 范围已砍（mac/linux 4 target + search/fs 二进制化），但整体 6 扩展机制 + 4 provider + Memory + ContextPolicy 三策略的广度未减。单人维护到 L4 功能完整仍现实需 12-18 月，L1 的 3-4 周是「核心 loop 跑通」非「产品完整」。

---

## 最终结论

r6-r8 把「设计的骨架」审透了——契约自洽、安全闭环、文档一致。r9 补上了「设计的血肉」：**砍范围让 L1 可交付 + 补 context 智能层让产品有灵魂 + 修 UX/成本/codex 治理让长期可维护**。

10 项处置全部落地。Memory 维持现状（用户决策）。剩余 5 类已知限制均为「接受权衡」非「待修 bug」，记入 release notes 即可。

**建议下一轮（若有 r10）聚焦**：L1 实现启动后的「spike 验证」——尤其 codex vendor 实际成本（spec 估 3-4 周，worst case 应验证是否 5-6 周）+ ContextPolicy SlidingWindow 的 tool 配对保护在真实长会话的表现。

---

## 变更日志

| 日期 | 版本 | 内容 |
|---|---|---|
| 2026-08-01 | r9 v1 | 「设计本身好不好」独立复审：发现 10 类系统性短板（复杂度超标 / Memory 过度工程 / context 智能层缺失 / stream 烧钱 / 插件内存 / codex 单点失败 / untrusted 安慰剂 / hook 竞态 / @ UX 倒退 / JSONL 膨胀）。与用户确认 5 指令 + 4 决策，落地 10 项处置（ContextPolicy 补齐 + Rust 全二进制化 + L1 砍 mac/linux 4 target + @ 统一 picker + JSONL 分段 + stream 复用 tool_result + hook 框架级 kv + codex 治理 + provider-plugin 提前 L3 + README 汇总）。Memory 维持现状。5 类已知限制记入 release notes。 |
