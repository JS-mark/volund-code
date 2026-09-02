> ↩ [返回索引 (README)](./README.md) · 关联章节：[§2.7 subagent](./02-agent-loop.md) · [§7 终端 UI](./07-terminal-ui.md) · [§11 CLI 命令树](./11-cli-commands.md) · [SKILLS-MCPS-r1](./SKILLS-MCP-UI-r1.md)

---

# Volund CLI · Subagent 运行管理面板 (SUBAGENTS-UI-r1)

> **状态**：r1（2026-09-02）——`/subagents` 面板 + dispatcher 运行注册表已落地（vitest + ink render 测试通过）。
> **文档类型**：功能规约（SKILLS-MCPS-r1 同构范式）
> **范围**：`packages/subagent`（运行注册表）、`packages/ui`（SubagentsPanel + 数据契约）、`apps/cli`（控制器 + REPL 命令装配）

---

## §S0 结论速览

subagent 的可见性此前只有模型侧的 `Task` 工具调用与 D.3 冒泡事件，人这一侧没有运行面。本白皮书按 /skills、/mcp 同构范式补上：**运行注册表（dispatcher）→ 数据契约（ui）→ `/subagents` 面板（列表 + 取消 + 详情）**。运行是 REPL 进程本地的，因此本面板**就是**管理面，不设跨进程 CLI 等价物（与 §S3.7 惯例的偏差，见 §S5）。

## §S1 运行注册表（packages/subagent）

`SubagentDispatcher` 从"只有 activeCount"升级为运行注册表：

- 每次 `dispatch()` 记一条 `SubagentRunEntry`：`{ sessionId, parentSessionId, agentType?, depth, status, startedAt, endedAt?, prompt(首行,>80 截断), budget?, usage?, toolCalls?, detail? }`。
- 生命周期：`running` → `completed | partial | failed | cancelled`；终态填充 `cumulativeUsage` 摘要与 tool_use 计数。
- **取消语义**：`cancel(sessionId)` 对活跃 runner `interrupt()`，标记后无论底层以 aborted turn 还是异常收尾，entry 一律落 `cancelled`（marker 只由显式取消写入，'cancelled' 即真实状态）。`cancelAllRunning()` 返回停止个数。
- 保留策略：环形上限（默认 100 条，最旧淘汰），跨 turn 保留供回看。
- `onRunsChange` 回调 + `list()` 快照（新者在前）供面板轮询/热更新。

## §S2 数据契约（packages/ui）

`SubagentsPanelController { list, cancel, cancelAll }` + `SubagentPanelEntry`（K0 纯数据，与 mcp-panel 同构）；`subagentPanelStatusGlyph`（●运行/●完成/◐部分/✘失败/○取消——运行与完成同 glyph，以颜色区分：cyan/green）；`subagentDuration`（mm:ss，逾时进 h:mm:ss）；`subagentListCommandView`（`/subagents list` 的非面板形态）。

## §S3 面板交互

```
 /subagents
 ▸ ● code-explainer (d1)  00:12 · 1200/300 tok · $0.0200 · 4 tools  Explain the dispatcher…
   ◐ reviewer      (d1)  00:41 · budget exhausted, partial result
   ✘ helper        (d2)  00:03  failed: provider 429
   ○ task-agent    (d1)  00:00  cancelled
```

- `↑/↓` 选择、输入即过滤、翻页窗 10 条。
- **Enter = 详情**：agent/status/depth/duration/started + usage 行 + 工具调用数 + prompt 全文；`j/k` 滚动，Enter/Esc 返回。
- **x = 取消选中**（仅 running 生效；非 running 无操作）；**a = 全停**（返回停止个数）；**r = 刷新**；**Esc = 关闭**。
- 面板打开期间 **1s 轮询**刷新（运行是活数据；关闭即停表）。

## §S4 装配（apps/cli）

`subagentsPanelController` 原生装配进 `renderInteractiveApp`（与 skills/mcp 控制器同层）；`/subagents` 进 builtin 名单（order 125，介于 `/mcp` 120 与 `/skill` 130）；`/subagents list` 输出 ListPicker 视图。取消动作不需要新 permission 面：本地 interrupt，非模型侧操作。

## §S5 与 SKILLS-MCPS-r1 §S3.7 惯例的偏差

1. **无 `volund subagent` CLI 子命令**：运行是进程本地状态，一次性 CLI 进程里注册表恒为空——面板即 REPL 内管理面；"面板动作必有 CLI 等价"在此不适用（spec 边界声明，非遗漏）。
2. 取消跨进程（从第二个终端杀另一个 REPL 的 subagent）属 v2：需要 daemon 化或 IPC，暂不做。

## §S6 落地清单（r1，2026-09-02）

1. `packages/subagent`：`SubagentRunEntry`/`SubagentRunStatus` + 运行注册表（`list`/`cancel`/`cancelAllRunning`/`onRunsChange`/`runHistoryLimit`）+ lifecycle 测试。
2. `packages/ui`：`subagents-panel.ts` 数据契约 + `components/SubagentsPanel.tsx`（列表/取消/详情/轮询）+ ink render 测试。
3. `apps/cli`：`subagentsPanelController` + `renderInteractiveApp` 装配 + `/subagents` builtin 命令。
