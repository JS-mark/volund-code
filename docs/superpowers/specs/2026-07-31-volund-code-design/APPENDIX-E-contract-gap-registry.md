> ↩ [返回索引 (README)](./README.md)

---

# 附录 E · 契约空白登记表（r13-D1 新增）

r11/r12 审计的 D 类发现证明：实现者在 spec 未定义处被迫自行决定（且各自不同）。本表把 20 条"实现被迫自定"的契约空白**收编为正式契约**，登记归宿与裁决。本表是历史登记（r13 时点），后续新发现的契约空白应直接落各章 + 在此追加行。

| # | 空白点 | 裁决 / 契约 | 归宿 | 状态 |
|---|---|---|---|---|
| 1 | 会话快照事件（实现自创 `session.snapshot` 每 turn 全量落盘） | **拒绝快照**：坚持事件重放；resume 加速走 §8.2b 索引 + tailTurns；禁自创快照行 | §8.2 | ✅ r13 落地 |
| 2 | subagent 事件冒泡的重发语义 | 冒泡**保留原 event.id** + parent tag（幂等关键） | §2.7 + 附录 D.3 | ✅ r13 落地 |
| 3 | gemini/ollama 合成 tool_use id 合法性 | 合成 id turn 内唯一即可；不跨 provider/turn 复用 | §3.7.1 注记 | ✅ r13 落地 |
| 4 | net 权限 key 归一粒度 | **origin**（scheme://host[:port]）；同域不同路径共享 allow-session | §4.4 | ✅ r13 落地 |
| 5 | Read 默认行数 / walk 忽略目录 | Read 默认 2000 行；默认跳过 `.git`/`node_modules`/`target`/`dist` | §4.3.3 | ✅ r13 落地 |
| 6 | 非 TTY 下 confirm/prompt 降级 | confirm → `false`（fail-closed）；prompt/pick → `null`；notify → stderr | §6.4.1 | ✅ r13 落地 |
| 7 | `--json` 模式错误输出协议 | `{type:'error', code, category}` + `{type:'final', exitCode}` 两行收尾 | §7.6 | ✅ r13 落地 |
| 8 | 子 agent 权限降级档位 | `depth>0` 可授权档位 = `['allow-once','allow-session','deny']` | §2.7 W8 | ✅ r13 落地（原已有，钉死枚举） |
| 9 | subagent 并发上限 | 同 turn Task 并发默认 4（`[subagent] max_concurrent`），超限排队 | §2.7 | ✅ r13 落地 |
| 10 | budget 顶层生效 + 维度 | 默认仅 subagent；顶层可选（`[runner] top_level_budget=false`）；维度=三维，loop 上限归 §2.4 B2 | §2.7 | ✅ r13 落地 |
| 11 | token 估算缓存生命周期 | per-policy 实例；dispose 即清 | §8b.3 | ✅ r13 落地 |
| 12 | probe features 键名三平台不一致 | 统一契约：`landlock_abi`/`seccomp`/`namespaces`/`sandbox_init`/`appcontainer`/`wfp`；非本平台键省略 | §5.3.3 | ✅ r13 落地 |
| 13 | sandbox 二进制调用形态 | 一次性 stdin/stdout 进程协议（非 JSON-RPC）；删除 `sandbox.*` 前缀表述；search/fs 才是常驻 NDJSON RPC | §5.6.2 | ✅ r13 落地 |
| 14 | ExecRequest 缺 exec/limits 段 | 输入 schema 补 `exec.allow` 白名单 + `limits`（rlimit 系四项） | §5.3.1 | ✅ r13 落地 |
| 15 | Windows 插件宿主 IPC | `--bridge-pipe` 与 Unix fd3 同为 **L2 落地要求**，不允许 Windows 留 TODO | §5.3.2 | ✅ r13 落地 |
| 16 | streamResume 能力护栏 | capabilities 不设该位；插件自声明 offset-resume → 显式拒绝（fail-fast） | §3.9a 规则 5 | ✅ r13 落地 |
| 17 | Ollama 远程明文审批门 | 非 loopback endpoint 强制显式确认 + telemetry | §14.2 | ✅ 已有（REVIEW-r6 P1-8 先行落地；r13 复核确认） |
| 18 | resolver 四级链 | env > bundled > download > cache；全 miss → JS fallback / tier=none | §5.8 | ✅ r13 落地 |
| 19 | DCO 对 AI/bot 提交者署名 | bot 豁免 sign-off（登记 dco-bots.txt）；AI 辅助提交由指令人类签署 | §12.2 | ✅ r13 落地 |
| 20 | 手写 reference 与 CLI 定义漂移 | 过渡期 CI 强制 `docs:verify:cli` diff 校验；生成覆盖后自然退化 | §13.6 | ✅ r13 落地 |

## E.1 维护规则

- 新契约空白的发现路径：review（r 系列）/ 实现审计（D 类）/ 用户报告"行为未定义"。
- 落地要求：直接写进对应章节正文（成为契约），本表只做登记索引——**本表不是契约本身**。
