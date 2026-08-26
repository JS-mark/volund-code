import { Box, Text, useInput } from 'ink'
import { useMemo, useState } from 'react'

import {
  createListPickerState,
  filterListEntries,
  listPickerKey,
  listPickerPage,
  type CommandListEntry,
  type CommandListView,
} from '../list-picker'

/** 行内 value 的显示上限：长值（路径/URL）只给摘要，全文在选中后的 transcript 里看。 */
const VALUE_COLUMN_CAP = 48

function truncateMiddle(value: string, cap: number): string {
  if (value.length <= cap) return value
  if (cap < 8) return value.slice(0, cap)
  // 路径类值截中段比截尾保留更多辨识度（头： scheme/根；尾：文件名）
  const head = Math.ceil((cap - 1) / 2)
  const tail = Math.floor((cap - 1) / 2)
  return `${value.slice(0, head)}…${value.slice(value.length - tail)}`
}

/**
 * 插件命令的通用列表面板（resume 风格）：搜索框即时过滤（label/value/status 模糊
 * 匹配），↑/↓ 选择、PgUp/PgDn 翻页、Enter 选中、Esc 关闭。数据源是插件经桥返回的
 * 纯数据描述符（CommandListView）。
 */
export function ListPicker(props: {
  view: CommandListView
  pageSize?: number
  onCancel(): void
  onSelect(entry: CommandListEntry): void
}) {
  const { view } = props
  const [state, setState] = useState(() => createListPickerState(view.entries))
  const pageSize = props.pageSize ?? 10
  const filtered = useMemo(
    () => filterListEntries(state.entries, state.query),
    [state.entries, state.query],
  )
  const page = listPickerPage(filtered, state.selected, pageSize)
  useInput((input, key) => {
    const name = key.escape
      ? 'Escape'
      : key.return
        ? 'Enter'
        : key.upArrow
          ? 'ArrowUp'
          : key.downArrow
            ? 'ArrowDown'
            : key.pageUp
              ? 'PageUp'
              : key.pageDown
                ? 'PageDown'
                : key.home
                  ? 'Home'
                  : key.end
                    ? 'End'
                    : key.backspace || key.delete
                      ? 'Backspace'
                      : input
    const action = listPickerKey(state, name, pageSize)
    if (action.type === 'cancel') props.onCancel()
    else if (action.type === 'select') props.onSelect(action.entry)
    else setState(action.state)
  })
  return (
    <Box borderStyle="round" flexDirection="column" paddingX={1}>
      <Text bold>{view.title}</Text>
      <Box
        borderBottom
        borderColor="cyan"
        borderLeft={false}
        borderRight={false}
        borderStyle="single"
        borderTop
        paddingX={1}
        width="100%"
      >
        <Text color="green">{'> '}</Text>
        {state.query ? (
          <Text>{state.query}</Text>
        ) : (
          <>
            <Text color="cyan">▌</Text>
            <Text color="gray">{view.placeholder ?? 'Type to filter'}</Text>
          </>
        )}
      </Box>
      <Text dimColor>
        ↑/↓ select · PgUp/PgDn page · Home/End first/last · Enter detail · Esc close
      </Text>
      {!state.entries.length ? <Text>Nothing to show.</Text> : null}
      {state.entries.length && !filtered.length ? (
        <Text>No entries match “{state.query}”.</Text>
      ) : null}
      {page.items.map((entry, index) => {
        const absoluteIndex = page.start + index
        const active = absoluteIndex === state.selected
        const status = entry.status ? `  [${entry.status}]` : ''
        const value = entry.value ? ` = ${truncateMiddle(entry.value, VALUE_COLUMN_CAP)}` : ''
        return (
          <Text key={entry.id} {...(active ? { color: 'cyan' as const } : {})}>
            {active ? '› ' : '  '}
            {entry.label}
            {value}
            <Text dimColor>{status}</Text>
          </Text>
        )
      })}
      {filtered.length ? (
        <Text dimColor>
          Showing {page.start + 1}–{page.end} of {page.total}
        </Text>
      ) : null}
    </Box>
  )
}
