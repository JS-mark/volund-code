import { Box, Text, useInput } from 'ink'
import { useCallback, useEffect, useRef, useState } from 'react'

import { filterListEntries, type CommandListEntry } from '../list-picker'
import type { McpPanelController, McpPanelEntry } from '../mcp-panel'
import { mcpPanelStatusGlyph } from '../mcp-panel'
import { truncateTerminal, wrapTerminalLines } from '../memory-panel'
import { PanelFrame } from './PanelFrame'

const PAGE_SIZE = 10

export interface McpPanelProps {
  controller: McpPanelController
  noColor?: boolean
  terminalColumns: number
  terminalRows: number
  onNotice(text: string): void
  onClose(): void
}

const STATUS_COLOR: Record<McpPanelEntry['status'], string | undefined> = {
  connected: 'green',
  connecting: 'yellow',
  'needs-auth': 'yellow',
  failed: 'red',
  disabled: 'gray',
}

/**
 * SKILLS-MCPS-r1 §S3.6（r1.6）：/mcp 管理面板 = 列表 + 开关 + 详情。
 * Enter 进详情（元数据 + 工具清单），Space 持久启停（断开即注销全部
 * `mcp__<server>__*` 工具），r 重连，输入即过滤，Esc 关闭。
 * tools 数在未连接时保持 undefined（诚实显示，不写 0）。
 */
export function McpPanel({
  controller,
  noColor = false,
  terminalColumns,
  terminalRows,
  onNotice,
  onClose,
}: McpPanelProps) {
  const [entries, setEntries] = useState<readonly McpPanelEntry[]>()
  const [error, setError] = useState<string>()
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const [detail, setDetail] = useState<string>()
  const [detailScroll, setDetailScroll] = useState(0)
  const [footer, setFooter] = useState<string>()
  const generation = useRef(0)

  const refresh = useCallback(
    async (mode: 'list' | 'reload') => {
      const current = ++generation.current
      if (mode === 'reload') setFooter('reconnecting…')
      try {
        const next = mode === 'reload' ? await controller.reload() : await controller.list()
        if (generation.current !== current) return
        setEntries(next)
        setError(undefined)
        if (mode === 'reload') setFooter(`reconnected ${next.length} server(s)`)
      } catch (cause) {
        if (generation.current !== current) return
        setError(cause instanceof Error ? cause.message : String(cause))
        setEntries([])
      }
    },
    [controller],
  )

  useEffect(() => {
    void refresh('list')
    return () => {
      generation.current++
    }
  }, [refresh])

  const runAction = useCallback(
    async (action: () => Promise<string>) => {
      setError(undefined)
      setFooter('working…')
      try {
        const note = await action()
        setFooter(note)
        if (note) onNotice(note)
        await refresh('list')
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause)
        setError(message)
        setFooter(undefined)
      }
    },
    [onNotice, refresh],
  )

  const pickable = (entries ?? []).map<CommandListEntry>((entry) => ({
    id: entry.name,
    label: entry.name,
    value: entry.transport,
    status: entry.status,
  }))
  const filtered = filterListEntries(pickable, query)
  // 翻页窗口必须含选中行（过滤/重扫后 selected 可能落在窗口外，导致行“消失”）
  const safeSelected = Math.max(0, Math.min(filtered.length - 1, selected))
  const pageStart = Math.floor(safeSelected / PAGE_SIZE) * PAGE_SIZE
  const page = filtered.slice(pageStart, pageStart + PAGE_SIZE)
  const entryById = new Map((entries ?? []).map((entry) => [entry.name, entry]))
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
    // r1.6：Enter 进详情（元数据 + 工具清单），Space = 启停开关。
    else if (key.return) {
      if (current)
        void runAction(async () => {
          const { entry, tools } = await controller.inspect(current.name)
          const lines = [
            `server: ${entry.name}`,
            `scope: ${entry.scope}`,
            `transport: ${entry.transport}`,
            `status: ${entry.status}${entry.detail ? ` (${entry.detail})` : ''}`,
            ...(entry.protocolVersion ? [`protocol: ${entry.protocolVersion}`] : []),
            '',
            `tools (${tools.length}):`,
            ...(tools.length
              ? tools.map(
                  (tool) =>
                    `- ${tool.name}${tool.description ? ` — ${truncateSummary(tool.description)}` : ''}`,
                )
              : ['(none exposed)']),
          ]
          setDetail(lines.join('\n'))
          setDetailScroll(0)
          setFooter(undefined)
          return ''
        })
    } else if (input === ' ') {
      if (current)
        void runAction(() => controller.setEnabled(current.name, current.status === 'disabled'))
    } else if (input === 'r') {
      void refresh('reload')
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
        title={`MCP Servers · ${current?.name ?? ''}`}
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
        '↑/↓ select · Enter detail · Space on-off · r reconnect · type to filter · Esc close'
      }
      title={`MCP Servers${query ? ` · /${query}` : ''}`}
    >
      {entries === undefined ? (
        <Text color="gray">loading MCP servers…</Text>
      ) : filtered.length === 0 ? (
        <Text color="gray">
          {query ? 'no servers match the filter' : 'no MCP servers configured'}
        </Text>
      ) : (
        <Box flexDirection="column">
          {page.map((item) => {
            const entry = entryById.get(item.id)!
            const selectedRow = item.id === current?.name
            const glyph = mcpPanelStatusGlyph(entry.status)
            const color = noColor ? undefined : STATUS_COLOR[entry.status]
            return (
              <Box key={item.id} gap={1}>
                <Text {...(selectedRow ? { color: 'cyan' as const } : {})}>
                  {selectedRow ? '▸' : ' '}
                </Text>
                <Text {...(color ? { color } : {})}>{glyph}</Text>
                <Text {...(color ? { color } : {})} wrap="truncate">
                  {truncateTerminal(
                    `${entry.name} (${entry.scope})`,
                    Math.max(20, Math.floor((terminalColumns - 8) * 0.5)),
                  )}
                </Text>
                <Text color="gray" wrap="truncate">
                  {truncateTerminal(
                    `${entry.transport}${entry.tools === undefined ? '' : ` · ${entry.tools} tools`}${entry.detail ? ` · ${entry.detail}` : ''}`,
                    Math.max(10, Math.floor((terminalColumns - 8) * 0.5)),
                  )}
                </Text>
              </Box>
            )
          })}
          {filtered.length > PAGE_SIZE ? (
            <Text color="gray">
              {filtered.length} servers · showing {page.length}
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
function truncateSummary(description: string): string {
  return description.length <= 80 ? description : `${description.slice(0, 79)}…`
}
