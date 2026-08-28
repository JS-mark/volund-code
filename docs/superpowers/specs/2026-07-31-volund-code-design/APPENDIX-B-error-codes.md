> ↩ [返回索引 (README)](./README.md)

---

# 附录 B · 错误码登记表（r13-I3 新增）

`error.raised` 的 `code` 是跨模块契约（core emit → ui 渲染 → telemetry 分类 → 用户 grep），**必须集中登记**。散落必漂移——实现轨迹已出现 spec 外新码。

## B.1 实现约定

- 唯一真相源：`packages/shared/error-codes.ts` 集中 const registry（`export const ErrorCodes = { ... } as const`）。
- **ESLint 禁裸字符串**：emit `error.raised` 时 `code` 必须引用 registry 常量，禁止字面量。
- **CI 强制**：新增错误码不进本表 → CI fail（`pnpm verify:error-codes` 比对 registry 与本表）。
- `--json` 模式的错误输出协议（`{type:'error', code, ...}`，§7.6）引用本表。

## B.2 登记表

| code                             | 来源章节               | 触发条件                                                                           | UI 期望                                                          | 可否重试                     |
| -------------------------------- | ---------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ---------------------------- |
| `tool_loop_exhausted`            | §2.4 B2                | turn 内 tool_use 迭代达 `maxToolLoopsPerTurn`（默认 25）                           | system note 提示已达上限；turn 正常结束                          | 用户重发（loopCount 已重置） |
| `stream_interrupted`             | §2.4 B6 / §3.9a        | provider stream 异常终止（RST/429/abort/不完整响应）                               | streaming block 灰色标注 `[stream interrupted: <reason>]` + 撤销 | 自动（router.onError 决策）  |
| `provider_sticky_violation`      | §2.4 B4 / §3.7.1       | sticky 锁定期 Router 返回异 provider decision                                      | 提示"provider 冷却中，请重发"                                    | 用户重发                     |
| `subagent_budget_exhausted`      | §2.7                   | subagent 三阈值（cost/token/time）任一命中                                         | 子任务标注 `[budget exhausted, partial result]`                  | 用户提额重派                 |
| `builtin_hook_payload_too_large` | §2.6 / §18 SD0-02      | builtin Hook 当前 canonical JSON-v1 payload 超过 1 MiB；未调用 handler、未开始扫描 | 红条“安全检查输入超限，操作已阻断”                               | 缩小 payload 后重试          |
| `builtin_hook_timeout`           | §2.6（r13-I10）        | builtin 域安全 hook 超 5s                                                          | 红条"安全检查超时，操作已阻断（可重试）"                         | ✅                           |
| `hook_priority_out_of_range`     | §6.11.1                | hook priority 超出 [0,1000]                                                        | 装载警告，该 handler 拒载                                        | 修 manifest 后重载           |
| `provider_name_conflict`         | PLUGIN-PROVIDER-r1 §P5 | 插件 provider 名与内置/已注册冲突                                                  | 注册拒绝 + 警告                                                  | 改名重载                     |
| `search_worker_crashed`          | §5.6.1 / §5.8          | volund-search worker 异常退出                                                      | 自动重启（≤3 次）→ 降级 JS fallback 提示                         | 自动                         |
| `fs_worker_crashed`              | §5.8                   | volund-fs worker 异常退出                                                          | 同上                                                             | 自动                         |
| `stream_resume_unsupported`      | §3.9a（r13-D1）        | provider 插件自行声明 offset-resume 能力                                           | 提示 v1 不支持字节级续传                                         | ❌                           |

## B.3 相邻登记（非 error.raised，但同属跨模块契约）

| 标识                                   | 类型                              | 来源                                                                                                                                               |
| -------------------------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ipc.line_too_large`                   | telemetry 事件                    | §5.6.2（NDJSON 行超 `max_line_bytes`）                                                                                                             |
| `hook.payload_rejected`                | telemetry 事件                    | §2.6（builtin Hook canonical JSON-v1 payload 超 1 MiB，direct-veto；含 raw size/digest 与未扫描证据）                                              |
| `directory_untrusted`                  | CLI `--json` error                | §7.6：workspace trust 校验拒绝                                                                                                                     |
| `invalid_workspace`                    | CLI `--json` error                | §7.6：workspace 路径无效                                                                                                                           |
| `plugin_command_target_required`       | CLI `--json` error                | §7.6：plugin 子命令缺少目标；stdout 依次发出 `error`、`final`，stderr 为空                                                                         |
| `plugin_command_unknown`               | CLI `--json` error                | §7.6：未知 plugin action；stdout 依次发出 `error`、`final`，stderr 为空                                                                            |
| `plugin_integration_unavailable`       | CLI `--json` error                | §7.6：plugin integration port 未组合；stdout 依次发出 `error`、`final`，stderr 为空                                                                |
| `plugin_legacy_activation_unavailable` | typed PluginError / doctor reason | §19 PK-P0-0：Catalog v2 + verified ABI reopen review 前，production install/enable/activation 一律 fail closed；list/doctor/disable/uninstall 保留 |
| `prompt_required`                      | CLI `--json` error                | §7.6：JSON chat 缺少 prompt                                                                                                                        |
| `sandbox_unavailable`                  | CLI `--json` error                | §7.6：所需 sandbox 不可用                                                                                                                          |
| `session_resume_failed`                | CLI `--json` error                | §7.6：session resume 失败                                                                                                                          |
| `trust_store_unavailable`              | CLI `--json` error                | §7.6：trust store 不可用                                                                                                                           |
| `unsupported_flag`                     | CLI `--json` error                | §7.6：不支持的全局参数                                                                                                                             |
| `web_origin_rejected`                  | Web API error（proposed）         | §22.10：Host/Origin 不属于当前 loopback server，mutation/read 均拒绝                                                                               |
| `web_session_invalid`                  | Web API error（proposed）         | §22.10：browser session 缺失、过期、server id 不匹配或已撤销                                                                                        |
| `web_csrf_invalid`                     | Web API error（proposed）         | §22.10：mutation 的 CSRF token 缺失/不匹配                                                                                                         |
| `web_schema_invalid`                   | Web API error（proposed）         | §22.8：request/response version 或 payload schema 不合法                                                                                            |
| `web_cursor_expired`                   | Web control/API error（proposed） | §22.8.3：SSE cursor 超出有界 retention，客户端必须拉 snapshot 后 resync                                                                             |
| `web_backpressure_resync`              | Web control/API error（proposed） | §22.8.3：客户端 event queue 超限，server 终止流并要求 resync                                                                                        |
| `web_turn_in_progress`                 | Web API error（proposed）         | §22 W-03：同一 session 已有 in-flight turn，第二次提交返回 409                                                                                      |
| `web_state_conflict`                   | Web API error（proposed）         | §22.9.2：config/permission/undo/extension mutation 的 revision/CAS 已过期                                                                            |
| `web_server_draining`                  | Web API error（proposed）         | §22.9.2：server shutdown drain 期间拒绝新 mutation                                                                                                  |
| `web_capability_unavailable`           | Web API error（proposed）         | §22.3.4：请求能力在当前平台/装配/安全门下不可用；details 返回 typed reason，不用空列表伪装                                                          |
| exit code `4`                          | CLI exit code                     | §17（review 存在 ≥ gate 级 finding）                                                                                                               |
| exit code `130`                        | CLI exit code                     | §11（Ctrl+C 终止）                                                                                                                                 |
| exit code `1` / `2`                    | CLI exit code                     | §11（一般错误 / 用法错误）                                                                                                                         |

> 实现中已出现但尚未入表的历史码（如 `stream_resume_unsafe_partial_tool_use`）：r12 整改时并入本表或改用上表既有码——禁止第三态。
