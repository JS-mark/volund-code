import { Box, Text, useInput } from 'ink'
import { useMemo, useState } from 'react'

import type { CommandListEntry } from '../list-picker'
import {
  activeTabEntries,
  createTabbedListState,
  tabbedListKey,
  tabbedListPage,
  type CommandTabsView,
} from '../tabbed-list'

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
 * 插件命令的多页签列表面板（/plugins 风格）：顶部页签行 ←/→ 切换，搜索框即时
 * 过滤当前页签，↑/↓ 选择、PgUp/PgDn 翻页、Enter 选中、Esc 关闭。数据源是插件
 * 经桥返回的纯数据描述符（CommandTabsView）；装载耗时由命令执行期的 spinner
 * 覆盖（面板打开时数据已就绪）。
 */
export function TabbedListView(props: {
  view: CommandTabsView
  pageSize?: number
  onCancel(): void
  onSelect(entry: CommandListEntry): void
}) {
  const { view } = props
  const [state, setState] = useState(() => createTabbedListState())
  const pageSize = props.pageSize ?? 10
  const active = Math.max(0, Math.min(view.tabs.length - 1, state.active))
  const activeTab = view.tabs[active]
  const filtered = useMemo(
    () => activeTabEntries(view.tabs, { ...state, active }),
    [view.tabs, state, active],
  )
  const page = tabbedListPage(view.tabs, { ...state, active }, pageSize)
  useInput((input, key) => {
    const name = key.escape
      ? 'Escape'
      : key.return
        ? 'Enter'
        : key.leftArrow
          ? 'ArrowLeft'
          : key.rightArrow
            ? 'ArrowRight'
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
    const action = tabbedListKey({ ...state, active }, view.tabs, name, pageSize)
    if (action.type === 'cancel') props.onCancel()
    else if (action.type === 'select') props.onSelect(action.entry)
    else setState(action.state)
  })
  return (
    <Box borderStyle="round" flexDirection="column" paddingX={1}>
      <Text bold>{view.title}</Text>
      <Box columnGap={1}>
        {view.tabs.map((tab, index) => {
          const isActive = index === active
          return (
            <Text
              key={tab.id}
              {...(isActive ? { color: 'cyan' as const, bold: true } : { dimColor: true })}
            >
              {isActive ? '[' : ' '}
              {tab.label}
              {isActive ? ']' : ' '}
            </Text>
          )
        })}
      </Box>
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
        ←/→ tab · type to search · ↑/↓ select · PgUp/PgDn page · Enter detail · Esc close
      </Text>
      {!activeTab || !activeTab.entries.length ? <Text>Nothing to show.</Text> : null}
      {activeTab?.entries.length && !filtered.length ? (
        <Text>No entries match “{state.query}”.</Text>
      ) : null}
      {page.items.map((entry, index) => {
        const absoluteIndex = page.start + index
        const isActive = absoluteIndex === state.selected
        const status = entry.status ? `  [${entry.status}]` : ''
        const value = entry.value ? ` = ${truncateMiddle(entry.value, VALUE_COLUMN_CAP)}` : ''
        return (
          <Text key={entry.id} {...(isActive ? { color: 'cyan' as const } : {})}>
            {isActive ? '› ' : '  '}
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
