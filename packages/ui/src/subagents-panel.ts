/**
 * SUBAGENTS-UI-r1：/subagents 面板的数据契约（K0 渲染，纯数据 view model）。
 * 控制器由 apps/cli 原生实现：list/cancel 走 SubagentDispatcher 运行注册表。
 * 运行是进程本地的——本面板就是 REPL 内的管理面，不设跨进程 CLI 等价物。
 */

export type SubagentPanelStatus = 'running' | 'completed' | 'partial' | 'failed' | 'cancelled'

export interface SubagentPanelEntry {
  readonly sessionId: string
  readonly agentType?: string
  readonly depth: number
  readonly status: SubagentPanelStatus
  readonly startedAt: number
  readonly endedAt?: number
  readonly prompt: string
  readonly usage?: { input: number; output: number; costUSD: number }
  readonly toolCalls?: number
  readonly detail?: string
}

export interface SubagentsPanelController {
  list(): Promise<readonly SubagentPanelEntry[]>
  /** 取消一个运行中的 subagent；不在运行中抛错。 */
  cancel(sessionId: string): Promise<string>
  /** 全停当前运行；返回停止个数。 */
  cancelAll(): Promise<number>
}

export function subagentPanelStatusGlyph(status: SubagentPanelStatus): string {
  switch (status) {
    case 'running':
      return '●'
    case 'completed':
      return '●'
    case 'partial':
      return '◐'
    case 'failed':
      return '✘'
    case 'cancelled':
      return '○'
  }
}

/** 运行时长的人类可读摘要（mm:ss；超过 1h 进 hh:mm:ss）。 */
export function subagentDuration(startedAt: number, endedAt?: number, now = Date.now()): string {
  const total = Math.max(0, Math.floor(((endedAt ?? now) - startedAt) / 1000))
  const seconds = total % 60
  const minutes = Math.floor(total / 60) % 60
  const hours = Math.floor(total / 3600)
  const pad = (value: number) => value.toString().padStart(2, '0')
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`
}

/** `/subagents list`（非面板形态）：转 ListPicker 可渲染的纯数据视图。 */
export function subagentListCommandView(entries: readonly SubagentPanelEntry[]): {
  kind: 'list'
  title: string
  placeholder?: string
  entries: Array<{
    id: string
    label: string
    value?: string
    status?: string
    detail?: string
  }>
} {
  return {
    kind: 'list',
    title: 'Subagent Runs',
    placeholder: 'filter runs…',
    entries: entries.map((entry) => ({
      id: entry.sessionId,
      label: entry.agentType ?? 'task-agent',
      value: entry.prompt,
      status: entry.status,
      detail: [
        `${entry.agentType ?? 'task-agent'} (depth ${entry.depth} · ${entry.status})`,
        `started: ${new Date(entry.startedAt).toLocaleTimeString()}`,
        entry.usage
          ? `usage: ${entry.usage.input} in / ${entry.usage.output} out · $${entry.usage.costUSD.toFixed(4)}`
          : '',
        entry.toolCalls === undefined ? '' : `tool calls: ${entry.toolCalls}`,
        entry.detail ? entry.detail : '',
      ]
        .filter(Boolean)
        .join('\n'),
    })),
  }
}
