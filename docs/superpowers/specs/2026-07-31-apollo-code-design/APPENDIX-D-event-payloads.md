> ↩ [返回索引 (README)](./README.md)

---

# 附录 D · 事件 payload 字段表（r13-I8 新增）

§2.3 事件表定义了时机与订阅者，本附录补 **per-event payload 契约**（19 种事件）。replay、§8.2 迁移、`--json` 外部消费都以本表为稳定契约——实现不得自创 payload 形状（delta 塞整 chunk、快照自创字段均违规）。

## D.1 实现约定

- 每事件一个 zod schema：`packages/shared/events/<event>.ts`（文件名 = 事件名）。
- 公共 envelope（§2.3）：`id`（UUIDv7）/ `type` / `version` / `sessionId` / `turnId?` / `at` / `payload`——本表只登记 `payload` 字段。
- **CI 强制**：§2.3 事件表新增行而无对应 schema 文件 → fail；schema 字段与本表 diff 非空 → fail。
- 大 payload（附件二进制）不进事件，只传引用（§2.3 订阅原则）。

## D.2 字段表（19 事件）

| 事件 | payload 字段（★必选 / ?可选） | 备注 / 来源 |
|---|---|---|
| `session.started` | ★`cwd` ?`configHash` ?`apolloVersion` | §8.2 样例 |
| `session.ended` | ★`reason`（`exit` \| `signal` \| `error`） ?`exitCode` | 触发后台 shell 统一 kill（§4.3.1） |
| `session.resumed` | ★`tailTurns` ★`skippedTurns` | W10；替代 session.started |
| `turn.started` | ★`turnId` ?`parentTurnId` ?`agentType` | subagent 冒泡保留原 event.id（§2.7） |
| `turn.completed` | ★`turnId` ★`usage`（Usage） ?`stopReason` | |
| `turn.aborted` | ★`turnId` ★`reason`（`user_interrupt` \| `error` \| `stream_interrupted`） | |
| `message.appended` | ★`messageId` ★`role` ★`content`（ContentPart[]，引用式） | §8.2 样例 |
| `stream.started` | ★`messageId` ?`provider` ?`model` | |
| `stream.delta` | ★`messageId` ★`kind`（`text` \| `thinking` \| `tool_use`） ★`fragment`（string） | **只传增量片段**，不塞整 chunk；不落盘（§8.2） |
| `stream.completed` | ★`messageId` ?`usage` | 落盘含完整 assistant message（§8.2） |
| `tool.requested` | ★`toolUseId` ★`tool` ★`input` | §8.2 样例 |
| `tool.permission_asked` | ★`toolUseId` ★`tool` ★`spec`（PermissionSpec 摘要） | |
| `tool.started` | ★`toolUseId` ★`tool` | |
| `tool.completed` | ★`toolUseId` ★`tool` ★`isError` ?`durationMs` ?`blocked` ?`blockedBy`（`hook`） | hooks(PostToolUse) 触发点 |
| `shell.background_started` | ★`shellId` ★`command` ★`cwd` | r13-G2 新增 |
| `shell.background_exited` | ★`shellId` ★`exitCode` ?`reason`（`exit` \| `killed` \| `session_ended`） ?`droppedBytes` | r13-G2 新增；droppedBytes = 环形缓冲丢弃量 |
| `context.compacted` | ★`before` ★`after`（token 数） ?`strategy` ?`removedMessageIds` | |
| `router.switched` | ★`from` ?`to` ★`reason` | |
| `error.raised` | ★`code`（附录 B） ?`category` ?`context`（Record） | code 必须来自错误码 registry |

## D.3 subagent 冒泡规则

- 冒泡事件**保留原 `event.id`**，envelope 加 `parentTurnId` / `parentDepth` tag（§2.7，r13-D1）——seen-set 去重与 JSONL 重放幂等以 `event.id` 为键。
- payload 字段不变（只加 envelope tag，不动 payload 形状）。

## D.4 本地 telemetry 事件（非 EventBus，平行登记）

auth 事件谱（§8.4.1，17 类）、memory 事件（§6.12.11）、review 事件（§17.7）、context 采样事件（§8b）、telemetry 类（`ipc.line_too_large` / `hook.payload_rejected`）走本地 telemetry sink，**不进 EventBus / JSONL**；其 payload 契约以各章为准，新增时同步登记到对应章节的事件小节。`hook.payload_rejected` 固定记录 `domain:'builtin'/hook/event/limitBytes/rawBytes/rawDigest/scanStatus:'not_started'/scannedBytes:0/scannedDigest:null/decision:'veto'`，不得包含原 payload。
