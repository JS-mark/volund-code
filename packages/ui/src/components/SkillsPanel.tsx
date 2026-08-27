import { Box, Text, useInput } from 'ink'
import { useCallback, useEffect, useRef, useState } from 'react'

import { filterListEntries, type CommandListEntry } from '../list-picker'
import { truncateTerminal, wrapTerminalLines } from '../memory-panel'
import type { SkillsPanelController, SkillsPanelEntry } from '../skills-panel'
import { skillsPanelStatusText } from '../skills-panel'
import { PanelFrame } from './PanelFrame'

const PAGE_SIZE = 10

export interface SkillsPanelProps {
  controller: SkillsPanelController
  noColor?: boolean
  terminalColumns: number
  terminalRows: number
  onNotice(text: string): void
  onClose(): void
}

const STATUS_COLOR: Record<SkillsPanelEntry['status'], string | undefined> = {
  active: 'green',
  available: undefined,
  disabled: 'gray',
  shadowed: 'gray',
  broken: 'red',
  incompatible: 'yellow',
}

function statusColorProps(
  entry: SkillsPanelEntry,
  noColor?: boolean,
): { color: string } | Record<string, never> {
  const color = noColor ? undefined : STATUS_COLOR[entry.status]
  return color ? { color } : {}
}

/** 行首开关图标：● 启用 / ○ 停用 / ✘ 损坏 / ◌ 被覆盖。 */
function switchGlyph(entry: SkillsPanelEntry): string {
  if (entry.status === 'broken') return '✘'
  if (entry.status === 'shadowed') return '◌'
  return entry.status === 'disabled' ? '○' : '●'
}

/**
 * SKILLS-MCPS-r1 §S3.3（r1.6）：/skills 管理面板 = 列表 + 开关 + 详情。
 * Enter 进详情（SKILL.md 只读滚动视图），Space 持久启停（config [skills]
 * disabled），a 会话级激活，r 重扫，输入即过滤，Esc 关闭。
 */
export function SkillsPanel({
  controller,
  noColor = false,
  terminalColumns,
  terminalRows,
  onNotice,
  onClose,
}: SkillsPanelProps) {
  const [entries, setEntries] = useState<readonly SkillsPanelEntry[]>()
  const [error, setError] = useState<string>()
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const [detail, setDetail] = useState<string>()
  const [detailScroll, setDetailScroll] = useState(0)
  const [footer, setFooter] = useState<string>()
  const generation = useRef(0)

  const load = useCallback(
    async (mode: 'initial' | 'rescan') => {
      const current = ++generation.current
      if (mode === 'initial') setEntries(undefined)
      setError(undefined)
      try {
        const next = await controller.reload()
        if (generation.current !== current) return
        setEntries(next)
        setSelected(0)
        if (mode === 'rescan') setFooter(`rescanned ${next.length} skill(s)`)
      } catch (cause) {
        if (generation.current !== current) return
        setError(cause instanceof Error ? cause.message : String(cause))
        setEntries([])
      }
    },
    [controller],
  )

  useEffect(() => {
    void load('initial')
    return () => {
      generation.current++
    }
  }, [load])

  const pickable = (entries ?? []).map<CommandListEntry>((entry) => ({
    id: entry.name,
    label: entry.name,
    value: entry.description,
    status: skillsPanelStatusText(entry),
  }))
  const filtered = filterListEntries(pickable, query)
  // 翻页窗口必须含选中行（过滤/重扫后 selected 可能落在窗口外，导致行“消失”）
  const safeSelected = Math.max(0, Math.min(filtered.length - 1, selected))
  const pageStart = Math.floor(safeSelected / PAGE_SIZE) * PAGE_SIZE
  const page = filtered.slice(pageStart, pageStart + PAGE_SIZE)
  const entryById = new Map((entries ?? []).map((entry) => [entry.name, entry]))
  const current = entryById.get(filtered[Math.min(selected, filtered.length - 1)]?.id ?? '')

  const runAction = useCallback(
    async (action: () => Promise<string>) => {
      setError(undefined)
      setFooter('working…')
      try {
        const note = await action()
        setFooter(note)
        if (note) onNotice(note)
        // 启停/激活后拉一次最新状态（entries 的 status 由 controller 重算）。
        const next = await controller.list()
        setEntries(next)
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause)
        setError(message)
        setFooter(undefined)
      }
    },
    [controller, onNotice],
  )

  const toggleEnabled = useCallback(() => {
    if (current && (current.status === 'available' || current.status === 'disabled'))
      void runAction(() => controller.setEnabled(current.name, current.status === 'disabled'))
  }, [controller, current, runAction])

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
      else if (key.pageDown || input === 'd')
        setDetailScroll((value) => Math.min(maxScroll, value + detailViewport(terminalRows)))
      else if (key.pageUp || input === 'u')
        setDetailScroll((value) => Math.max(0, value - detailViewport(terminalRows)))
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
    // r1.6：Enter 进详情（SKILL.md 只读滚动视图），Space = 启停开关。
    else if (key.return) {
      if (current && current.status !== 'broken' && current.status !== 'shadowed')
        void runAction(async () => {
          setDetail(await controller.show(current.name))
          setDetailScroll(0)
          setFooter(undefined)
          return ''
        })
    } else if (input === ' ') toggleEnabled()
    else if (input === 'a') {
      if (current && current.status !== 'broken' && current.status !== 'shadowed')
        void runAction(() => controller.setActive(current.name, current.status !== 'active'))
    } else if (input === 'r') {
      void load('rescan')
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
        title={`Skills · ${current?.name ?? ''}`}
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
        '↑/↓ select · Enter detail · Space on-off · a activate · r rescan · type to filter · Esc close'
      }
      title={`Skills${query ? ` · /${query}` : ''}`}
    >
      {entries === undefined ? (
        <Text color="gray">loading skills…</Text>
      ) : filtered.length === 0 ? (
        <Text color="gray">{query ? 'no skills match the filter' : 'no skills installed'}</Text>
      ) : (
        <Box flexDirection="column">
          {page.map((item) => {
            const entry = entryById.get(item.id)!
            const selectedRow = item.id === current?.name
            const colorProps = statusColorProps(entry, noColor)
            return (
              <Box key={item.id} gap={1}>
                <Text {...(selectedRow ? { color: 'cyan' as const } : {})}>
                  {selectedRow ? '▸' : ' '}
                </Text>
                <Text {...colorProps}>{switchGlyph(entry)}</Text>
                <Text {...colorProps} wrap="truncate">
                  {truncateTerminal(
                    `${entry.name} (${entry.scope})`,
                    Math.max(20, Math.floor((terminalColumns - 8) / 2)),
                  )}
                </Text>
                <Text color="gray" wrap="truncate">
                  {truncateTerminal(
                    entry.description || entry.reason || '',
                    Math.max(10, terminalColumns - 8 - Math.floor((terminalColumns - 8) / 2)),
                  )}
                </Text>
              </Box>
            )
          })}
          {filtered.length > PAGE_SIZE ? (
            <Text color="gray">
              {filtered.length} skills · showing {page.length}
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
