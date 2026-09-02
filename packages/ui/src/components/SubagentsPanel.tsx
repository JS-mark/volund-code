import { Box, Text, useInput } from 'ink'
import { useCallback, useEffect, useRef, useState } from 'react'

import { filterListEntries, type CommandListEntry } from '../list-picker'
import { truncateTerminal, wrapTerminalLines } from '../memory-panel'
import type { SubagentPanelEntry, SubagentsPanelController } from '../subagents-panel'
import { subagentDuration, subagentPanelStatusGlyph } from '../subagents-panel'
import { PanelFrame } from './PanelFrame'

const PAGE_SIZE = 10
/** 运行是活数据：面板打开期间轮询刷新。 */
const POLL_MS = 1000

export interface SubagentsPanelProps {
  controller: SubagentsPanelController
  noColor?: boolean
  terminalColumns: number
  terminalRows: number
  onNotice(text: string): void
  onClose(): void
}

const STATUS_COLOR: Record<SubagentPanelEntry['status'], string | undefined> = {
  running: 'cyan',
  completed: 'green',
  partial: 'yellow',
  failed: 'red',
  cancelled: 'gray',
}

/**
 * SUBAGENTS-UI-r1：/subagents 运行管理面板 = 列表 + 取消 + 详情。
 * Enter 进详情（prompt/用量/工具调用），x 取消选中，a 全停，r 刷新，
 * 输入即过滤，Esc 关闭。运行中的条目按秒轮询热更新。
 */
export function SubagentsPanel({
  controller,
  noColor = false,
  terminalColumns,
  terminalRows,
  onNotice,
  onClose,
}: SubagentsPanelProps) {
  const [entries, setEntries] = useState<readonly SubagentPanelEntry[]>()
  const [error, setError] = useState<string>()
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const [detail, setDetail] = useState<string>()
  const [detailScroll, setDetailScroll] = useState(0)
  const [footer, setFooter] = useState<string>()
  const [now, setNow] = useState(() => Date.now())
  const generation = useRef(0)

  const refresh = useCallback(async () => {
    const current = ++generation.current
    try {
      const next = await controller.list()
      if (generation.current !== current) return
      setEntries(next)
      setError(undefined)
    } catch (cause) {
      if (generation.current !== current) return
      setError(cause instanceof Error ? cause.message : String(cause))
      setEntries([])
    }
  }, [controller])

  useEffect(() => {
    void refresh()
    const poll = setInterval(() => {
      setNow(Date.now())
      void refresh()
    }, POLL_MS)
    return () => {
      generation.current++
      clearInterval(poll)
    }
  }, [refresh])

  const runAction = useCallback(
    async (action: () => Promise<string>) => {
      setError(undefined)
      setFooter('working…')
      try {
        const note = await action()
        setFooter(note || undefined)
        if (note) onNotice(note)
        await refresh()
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause)
        setError(message)
        setFooter(undefined)
      }
    },
    [onNotice, refresh],
  )

  const pickable = (entries ?? []).map<CommandListEntry>((entry) => ({
    id: entry.sessionId,
    label: entry.agentType ?? 'task-agent',
    value: entry.promptPreview,
    status: entry.status,
  }))
  const filtered = filterListEntries(pickable, query)
  // 翻页窗口必须含选中行（过滤/刷新后 selected 可能落在窗口外，导致行“消失”）
  const safeSelected = Math.max(0, Math.min(filtered.length - 1, selected))
  const pageStart = Math.floor(safeSelected / PAGE_SIZE) * PAGE_SIZE
  const page = filtered.slice(pageStart, pageStart + PAGE_SIZE)
  const entryById = new Map((entries ?? []).map((entry) => [entry.sessionId, entry]))
  const current = entryById.get(filtered[Math.min(selected, filtered.length - 1)]?.id ?? '')

  useInput((input, key) => {
    if (detail !== undefined) {
      const lineCount = wrapTerminalLines(detail, Math.max(30, terminalColumns - 6)).length
      const maxScroll = Math.max(0, lineCount - detailViewport(terminalRows))
      if (key.escape || key.return) {
        setDetail(undefined)
        return
      }
      if (key.downArrow || input === 'j') setDetailScroll((value) => Math.min(maxScroll, value + 1))
      else if (key.upArrow || input === 'k') setDetailScroll((value) => Math.max(0, value - 1))
      return
    }
    if (key.escape) {
      onClose()
      return
    }
    if (entries === undefined) return
    if (!filtered.length) {
      if (key.backspace || key.delete) setQuery((value) => value.slice(0, -1))
      else if (input && !key.ctrl && input !== ' ') setQuery((value) => value + input)
      return
    }
    const last = filtered.length - 1
    if (key.upArrow) setSelected((value) => Math.max(0, value - 1))
    else if (key.downArrow) setSelected((value) => Math.min(last, value + 1))
    else if (key.pageUp) setSelected((value) => Math.max(0, value - PAGE_SIZE))
    else if (key.pageDown) setSelected((value) => Math.min(last, value + PAGE_SIZE))
    else if (key.return) {
      if (current) {
        const entry = current
        const lines = [
          `agent: ${entry.agentType ?? 'task-agent'}`,
          `status: ${entry.status}${entry.detail ? ` (${entry.detail})` : ''}`,
          `depth: ${entry.depth}`,
          `duration: ${subagentDuration(entry.startedAt, entry.endedAt, now)}`,
          `started: ${new Date(entry.startedAt).toLocaleTimeString()}`,
          ...(entry.usage
            ? [
                `usage: ${entry.usage.input} in / ${entry.usage.output} out · $${entry.usage.costUSD.toFixed(4)}`,
              ]
            : []),
          ...(entry.toolCalls === undefined ? [] : [`tool calls: ${entry.toolCalls}`]),
          '',
          'prompt:',
          entry.prompt,
        ]
        setDetail(lines.join('\n'))
        setDetailScroll(0)
        setFooter(undefined)
      }
    } else if (input === 'x') {
      if (current && current.status === 'running')
        void runAction(() => controller.cancel(current.sessionId))
    } else if (input === 'a') {
      void runAction(async () => `${await controller.cancelAll()} running subagent(s) stopped`)
    } else if (input === 'r') {
      void refresh()
    } else if (key.backspace || key.delete) {
      setQuery((value) => value.slice(0, -1))
      setSelected(0)
    } else if (input && !key.ctrl && input !== ' ') {
      setQuery((value) => value + input)
      setSelected(0)
    }
  })

  if (detail !== undefined) {
    const lines = wrapTerminalLines(detail, Math.max(30, terminalColumns - 6))
    const viewport = detailViewport(terminalRows)
    const visible = lines.slice(detailScroll, detailScroll + viewport)
    return (
      <PanelFrame
        footer="↑/↓ scroll · Enter/Esc back to list"
        title={`Subagents · ${current?.agentType ?? 'task-agent'}`}
      >
        <Box flexDirection="column">
          {visible.map((line, index) => (
            <Text key={index}>{truncateTerminal(line || ' ', terminalColumns - 6)}</Text>
          ))}
        </Box>
      </PanelFrame>
    )
  }
  return (
    <PanelFrame
      footer={
        error ??
        footer ??
        '↑/↓ select · Enter detail · x cancel · a stop all · r refresh · type to filter · Esc close'
      }
      title={`Subagents${query ? ` · /${query}` : ''}`}
    >
      {entries === undefined ? (
        <Text color="gray">loading subagent runs…</Text>
      ) : filtered.length === 0 ? (
        <Text color="gray">{query ? 'no runs match the filter' : 'no subagent runs yet'}</Text>
      ) : (
        <Box flexDirection="column">
          {page.map((item) => {
            const entry = entryById.get(item.id)!
            const selectedRow = item.id === current?.sessionId
            const glyph = subagentPanelStatusGlyph(entry.status)
            const color = noColor ? undefined : STATUS_COLOR[entry.status]
            const label = entry.agentType ?? 'task-agent'
            return (
              <Box key={item.id} gap={1}>
                <Text {...(selectedRow ? { color: 'cyan' as const } : {})}>
                  {selectedRow ? '▸' : ' '}
                </Text>
                <Text {...(color ? { color } : {})}>{glyph}</Text>
                <Text {...(color ? { color } : {})} wrap="truncate">
                  {truncateTerminal(
                    `${label} (d${entry.depth})`,
                    Math.max(16, Math.floor((terminalColumns - 8) * 0.35)),
                  )}
                </Text>
                <Text color="gray" wrap="truncate">
                  {truncateTerminal(
                    `${subagentDuration(entry.startedAt, entry.endedAt, now)}${
                      entry.usage
                        ? ` · ${entry.usage.input}/${entry.usage.output} tok · $${entry.usage.costUSD.toFixed(4)}`
                        : ''
                    }${entry.toolCalls === undefined ? '' : ` · ${entry.toolCalls} tools`}`,
                    Math.max(12, Math.floor((terminalColumns - 8) * 0.25)),
                  )}
                </Text>
                <Text wrap="truncate">
                  {truncateTerminal(
                    entry.promptPreview,
                    Math.max(10, Math.floor((terminalColumns - 8) * 0.4)),
                  )}
                </Text>
              </Box>
            )
          })}
          {filtered.length > PAGE_SIZE ? (
            <Text color="gray">
              {filtered.length} runs · showing {page.length}
            </Text>
          ) : null}
        </Box>
      )}
      {error ? <Text color="red">{truncateTerminal(error, terminalColumns - 6)}</Text> : null}
    </PanelFrame>
  )
}

function detailViewport(terminalRows: number): number {
  return Math.max(3, terminalRows - 10)
}
