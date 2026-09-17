import { Box, Text, useInput } from 'ink'
import { useCallback, useEffect, useRef, useState } from 'react'

import {
  changeEntrySummary,
  diffRowsOf,
  relativizeChangePath,
  type ChangesPanelController,
  type ChangesPanelEntry,
  type DiffRowTone,
} from '../changes-panel'
import { filterListEntries, type CommandListEntry } from '../list-picker'
import { truncateTerminal } from '../memory-panel'
import { PanelFrame } from './PanelFrame'

const PAGE_SIZE = 10

const TONE_COLOR: Record<DiffRowTone, string | undefined> = {
  add: 'green',
  del: 'red',
  hunk: 'cyan',
  meta: 'gray',
  plain: undefined,
}

export interface ChangesPanelProps {
  controller: ChangesPanelController
  sessionId: string
  /** 路径相对化用的会话 cwd。 */
  cwd?: string
  terminalColumns: number
  terminalRows: number
  onClose(): void
  /** 撤销结果提示（回到 transcript 状态行）。 */
  onNotice(text: string): void
}

/**
 * /changes 会话变更面板：列表（新建/修改/已撤销）+ Enter 看单文件净效果 diff。
 * x 撤销选中文件的最新批次（preview → 确认 → 执行；批次含多个文件时整批
 * 撤销并在确认前列出）。只读浏览与撤销同源（BackupStore）。
 */
export function ChangesPanel({
  controller,
  sessionId,
  cwd,
  terminalColumns,
  terminalRows,
  onClose,
  onNotice,
}: ChangesPanelProps) {
  const [entries, setEntries] = useState<readonly ChangesPanelEntry[]>()
  const [missing, setMissing] = useState(false)
  const [error, setError] = useState<string>()
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const [detail, setDetail] = useState<readonly { tone: DiffRowTone; text: string }[]>()
  const [detailTitle, setDetailTitle] = useState('')
  const [detailScroll, setDetailScroll] = useState(0)
  const [undoing, setUndoing] = useState<{ path: string; paths: string[] }>()
  const generation = useRef(0)

  const refresh = useCallback(async () => {
    const current = ++generation.current
    try {
      const next = await controller.list(sessionId)
      if (generation.current !== current) return
      setEntries(next.paths)
      setMissing(next.missing)
      setError(undefined)
    } catch (cause) {
      if (generation.current !== current) return
      setError(cause instanceof Error ? cause.message : String(cause))
      setEntries([])
    }
  }, [controller, sessionId])

  useEffect(() => {
    void refresh()
    return () => {
      generation.current++
    }
  }, [refresh])

  const pickable = (entries ?? []).map<CommandListEntry>((entry) => ({
    id: entry.path,
    label: relativizeChangePath(entry.path, cwd),
    value: entry.path,
  }))
  const filtered = filterListEntries(pickable, query)
  const safeSelected = Math.max(0, Math.min(filtered.length - 1, selected))
  const pageStart = Math.floor(safeSelected / PAGE_SIZE) * PAGE_SIZE
  const page = filtered.slice(pageStart, pageStart + PAGE_SIZE)
  const entryById = new Map((entries ?? []).map((entry) => [entry.path, entry]))
  const current = entryById.get(filtered[Math.min(selected, filtered.length - 1)]?.id ?? '')

  const openDetail = useCallback(async () => {
    if (!current) return
    setError(undefined)
    try {
      const diff = await controller.fileDiff(sessionId, current.path)
      setDetailTitle(relativizeChangePath(diff.path, cwd))
      if (!diff.tracked) setDetail([{ tone: 'meta', text: '该路径没有本会话的备份记录' }])
      else if (diff.truncated)
        setDetail([{ tone: 'meta', text: '文件过大，净效果 diff 不做全量渲染（可按 x 撤销批次）' }])
      else if (diff.diff === '')
        setDetail([
          {
            tone: 'meta',
            text: diff.created ? '会话新建的文件（当前无净变化）' : '与备份起点无差异',
          },
        ])
      else {
        const notes: { tone: DiffRowTone; text: string }[] = []
        if (!diff.beforeAvailable)
          notes.push({ tone: 'meta', text: '（备份起点快照缺失，diff 从空文件起算）' })
        if (diff.deleted) notes.push({ tone: 'meta', text: '（文件已在本会话内删除）' })
        setDetail([...notes, ...diffRowsOf(diff.diff)])
      }
      setDetailScroll(0)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [controller, current, cwd, sessionId])

  useInput(
    (input, key) => {
      if (detail !== undefined) {
        const maxScroll = Math.max(0, detail.length - detailViewport(terminalRows))
        if (key.escape || key.return) {
          setDetail(undefined)
          return
        }
        if (key.downArrow || input === 'j')
          setDetailScroll((value) => Math.min(maxScroll, value + 1))
        else if (key.upArrow || input === 'k') setDetailScroll((value) => Math.max(0, value - 1))
        return
      }
      if (key.escape) {
        onClose()
        return
      }
      if (entries === undefined) return
      if (undoing !== undefined) {
        // 撤销确认模态：Enter/y 确认执行，Esc/n 取消。
        if (key.return || input === 'y' || input === 'Y') {
          const target = undoing
          setUndoing(undefined)
          void (async () => {
            try {
              const result = await controller.undoPath?.(sessionId, target.path)
              if (result?.undone) {
                const warningsNote = result.warnings.length
                  ? `（${result.warnings.length} 条警告）`
                  : ''
                onNotice(`已撤销 ${result.paths.length} 个文件${warningsNote}`)
                await refresh()
              } else {
                setError('撤销失败：没有可撤销的批次')
              }
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : String(cause))
            }
          })()
          return
        }
        if (key.escape || input === 'n' || input === 'N') setUndoing(undefined)
        return
      }
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
      else if (key.return) void openDetail()
      else if (input === 'x' && controller.previewUndo && controller.undoPath && current) {
        // P4：按路径撤销——先 preview 拿批次涉及的全量路径（MultiEdit 一批
        // 可能动多个文件），确认后执行。
        const target = current
        void (async () => {
          try {
            const preview = await controller.previewUndo?.(sessionId, target.path)
            if (!preview?.undoable) {
              setError('该文件没有可撤销的批次')
              return
            }
            setUndoing({ path: target.path, paths: preview.paths })
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause))
          }
        })()
      } else if (input === 'r') void refresh()
      else if (key.backspace || key.delete) {
        setQuery((value) => value.slice(0, -1))
        setSelected(0)
      } else if (input && !key.ctrl && input !== ' ') {
        setQuery((value) => value + input)
        setSelected(0)
      }
    },
    { isActive: true },
  )

  if (detail !== undefined) {
    // 逐行着色滚动：行本身不 wrap（diff 行长即源行长），超出终端宽截断。
    const viewport = detailViewport(terminalRows)
    const visible = detail.slice(detailScroll, detailScroll + viewport)
    return (
      <PanelFrame footer="↑/↓ scroll · Enter/Esc back to list" title={`Changes · ${detailTitle}`}>
        <Box flexDirection="column">
          {visible.map((row, index) => (
            <Text
              key={index}
              {...(TONE_COLOR[row.tone] ? { color: TONE_COLOR[row.tone]! } : {})}
              wrap="truncate"
            >
              {truncateTerminal(
                `${row.tone === 'add' ? '+ ' : row.tone === 'del' ? '- ' : '  '}${row.text}` || ' ',
                terminalColumns - 6,
              )}
            </Text>
          ))}
        </Box>
      </PanelFrame>
    )
  }
  if (undoing !== undefined) {
    return (
      <PanelFrame
        footer="Enter/y 确认撤销 · Esc/n 取消"
        title={`撤销 ${relativizeChangePath(undoing.path, cwd)} 的最近批次`}
      >
        <Box flexDirection="column">
          <Text>将撤销以下 {undoing.paths.length} 个文件的最近批次：</Text>
          {undoing.paths.map((path) => (
            <Text color="gray" key={path}>
              {'  '}
              {relativizeChangePath(path, cwd)}
            </Text>
          ))}
          {undoing.paths.length > 1 ? (
            <Text color="yellow">批次含多个文件（同一工具调用），将一并撤销。</Text>
          ) : null}
        </Box>
      </PanelFrame>
    )
  }
  return (
    <PanelFrame
      footer={
        error ??
        (missing
          ? '本会话尚无备份记录（写操作后生成）'
          : controller.previewUndo && controller.undoPath
            ? '↑/↓ select · Enter diff · x 撤销该文件批次 · r refresh · type to filter · Esc close'
            : '↑/↓ select · Enter diff · r refresh · type to filter · Esc close')
      }
      title={`Changes${query ? ` · /${query}` : ''}`}
    >
      {entries === undefined ? (
        <Text color="gray">loading session changes…</Text>
      ) : filtered.length === 0 ? (
        <Text color="gray">{query ? 'no files match the filter' : '本会话暂无文件变更'}</Text>
      ) : (
        <Box flexDirection="column">
          {page.map((item) => {
            const entry = entryById.get(item.id)!
            const selectedRow = item.id === current?.path
            const glyph = entry.allConsumed ? '·' : entry.created ? '+' : '~'
            const color = entry.allConsumed ? 'gray' : entry.created ? 'green' : 'yellow'
            return (
              <Box key={item.id} gap={1}>
                <Text {...(selectedRow ? { color: 'cyan' as const } : {})}>
                  {selectedRow ? '▸' : ' '}
                </Text>
                <Text color={color}>{glyph}</Text>
                <Text wrap="truncate">
                  {truncateTerminal(item.label, Math.max(16, terminalColumns - 8 - 16))}
                </Text>
                <Text color="gray" wrap="truncate">
                  {truncateTerminal(changeEntrySummary(entry), 14)}
                </Text>
              </Box>
            )
          })}
          {filtered.length > PAGE_SIZE ? (
            <Text color="gray">
              {filtered.length} files · showing {page.length}
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
