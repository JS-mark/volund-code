# JSON 输出契约

Volund 有两种刻意区分的机器输出形态。

- `volund ... --json` 与默认 prompt 入口使用带版本的 NDJSON 流：stdout 每一行都是一个完整 JSON 事件；Ink、横幅、进度文本与 ANSI 样式全部关闭，诊断信息走 stderr。
- `doctor`、`context`、`evolution`、`plugin`、`mcp`、`memory` 等管理命令通常输出单个 JSON 文档加换行；数组保持数组、对象保持对象。memory 文档使用 `schemaVersion: 1`；失败使用 `{ schemaVersion, error: { code, message, exitCode } }`。插件命令失败是刻意设计的例外：stdout 恰好包含 version-1 NDJSON 封套中的一个 `error` 事件加一个 `final` 事件，stderr 保持为空。

## NDJSON 封套（version 1）

每个事件都包含 `v`、`type`、单调递增的 `seq`、`sessionId`、可选 `turnId`、ISO-8601 `timestamp` 与 `data`。消费方必须拒绝不支持的大版本，并忽略受支持版本内的未知字段与未知事件类型。

有序事件词表为 `message.start`、`text.delta`、`tool_use`、`tool_result`、`error`、`router.switched`、`usage`、`final`。`tool_use.data.phase` 取值 `start`、`delta` 或 `end`。一轮对话在其他事件之后恰好以一个 `final` 事件终止。

`error.data` 含稳定的 `code`、`category`、`retryable`、`exitCode` 字段，可能附带脱敏后的上下文。含密钥的键名与常见内联凭据形态会在序列化前替换为 `[REDACTED]`。

## 结束状态与退出码

| 最终状态    | 退出码 | 含义              |
| ----------- | -----: | ----------------- |
| `completed` |      0 | 回合正常完成      |
| `error`     |      1 | 运行时/提供方失败 |
| `cancelled` |    130 | 被中断或取消      |

参数与用法错误继续使用退出码 2；严格沙箱失败使用 3。若在会话 ID 产生之前启动失败，error 与 final 事件使用空 `sessionId`。

NDJSON 是 stdout 契约：人类可读诊断只走 stderr，绝不进入无封套的 stdout。`--json` 已隐含选择非 TUI 运行，脚本无需再传 `--no-tui`。
