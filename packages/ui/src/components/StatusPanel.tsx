import { Box, Text, useInput, useStdout } from 'ink'
import { useEffect, useMemo, useState } from 'react'

import type { StatusPanelController, StatusPanelData, StatusTabId, StatusValue } from '../status'
import { sanitizePluginTabs, validateStatusConfigValue } from '../status'
import { PanelFrame } from './PanelFrame'
import { PluginTabView } from './PluginTabView'
import { StatsView } from './StatsView'
import { TabBar } from './TabBar'
import { UsageView } from './UsageView'

export interface StatusPanelProps {
  controller?: StatusPanelController
  data: StatusPanelData
  onClose?: () => void
}

const CORE_TABS = [
  { id: 'settings', label: 'Settings' },
  { id: 'status', label: 'Status' },
  { id: 'config', label: 'Config' },
  { id: 'usage', label: 'Usage' },
  { id: 'stats', label: 'Stats' },
] as const

const TAB_HINTS: Record<StatusTabId, string> = {
  settings: 'Tab/←/→ switch  ↑/↓ move  Esc close',
  status: 'Tab/←/→ switch  ↑/↓ move  Esc close',
  config: 'Tab/←/→ switch  ↑/↓ move  Enter edit  Esc close',
  usage: 'Tab/←/→ switch  Esc close',
  stats: 'Tab/←/→ switch  ↑/↓ switch view  r cycle range  Esc close',
}

const PLUGIN_TAB_HINT = 'Tab/←/→ switch  Esc close'

type StatusRow = StatusPanelData['config'][number] | { label: string; value: string }

export function StatusPanel({ controller, data: initialData, onClose }: StatusPanelProps) {
  const [data, setData] = useState(initialData)
  const [active, setActive] = useState<string>('status')
  const [selected, setSelected] = useState(0)
  const [editing, setEditing] = useState<{ id: string; value: string }>()
  const [message, setMessage] = useState(TAB_HINTS.status)
  const { stdout } = useStdout()
  // PLUGIN-STATUS-UI-r1：契约式扩展页签。sanitize 在渲染前强制执行（§S3.3）；
  // 被拒绝的描述符降级为一行 section error，不影响内核页签。
  const pluginTabs = useMemo(() => sanitizePluginTabs(data.pluginTabs ?? []), [data.pluginTabs])
  const tabs = useMemo(
    () => [...CORE_TABS, ...pluginTabs.map((tab) => ({ id: tab.id, label: tab.label }))],
    [pluginTabs],
  )
  const activePluginTab = pluginTabs.find((tab) => tab.id === active)
  const isRowTab = active === 'settings' || active === 'status' || active === 'config'
  const rows: readonly StatusRow[] =
    active === 'config'
      ? data.config
      : active === 'settings' || active === 'status'
        ? data[active]
        : []
  const height = Math.max(3, Math.min(12, (stdout.rows ?? 24) - 10))
  const offset = Math.max(0, Math.min(selected - height + 1, rows.length - height))
  const visible = rows.slice(offset, offset + height)

  // 面板数据是 REPL 启动时的快照；打开 /status 时刷新一次，
  // Usage/Stats 页签因此显示的是打开时刻的会话与历史统计。
  useEffect(() => {
    if (!controller?.refresh) return
    let disposed = false
    void controller.refresh().then(
      (fresh) => {
        if (!disposed) setData(fresh)
      },
      () => undefined,
    )
    return () => {
      disposed = true
    }
  }, [controller])

  useInput((input, key) => {
    if (editing) {
      if (key.escape) {
        setEditing(undefined)
        setMessage('Edit cancelled')
        return
      }
      if (key.return) {
        const item = data.config.find((candidate) => candidate.id === editing.id)
        if (item) void save(item, item.kind === 'number' ? Number(editing.value) : editing.value)
        return
      }
      if (key.backspace || key.delete) setEditing({ ...editing, value: editing.value.slice(0, -1) })
      else if (input && !key.ctrl && !key.meta)
        setEditing({ ...editing, value: editing.value + input })
      return
    }
    if (key.escape) return onClose?.()
    // Usage/Stats 页签没有可选行；↑/↓ 在 Stats 内由 StatsView 用来切换子视图。
    if (isRowTab && (key.upArrow || key.downArrow)) {
      const step = key.upArrow ? -1 : 1
      setSelected((value) => Math.max(0, Math.min(rows.length - 1, value + step)))
      return
    }
    if (key.return && active === 'config') void editSelected(data.config[selected])

    async function editSelected(item = data.config[selected]) {
      if (!item) return
      if (!item.editable) return setMessage(item.readonlyReason ?? `${item.label} is read-only`)
      if (!controller) return setMessage('Configuration persistence is not available')
      if (item.kind === 'string') {
        setEditing({ id: item.id, value: String(item.value) })
        setMessage(`Editing ${item.label}: type, Enter save, Esc cancel`)
        return
      }
      try {
        const value = nextValue(item, input)
        await save(item, value)
      } catch (error) {
        setMessage(error instanceof Error ? error.message : 'Unable to save configuration')
      }
    }

    async function save(item: StatusPanelData['config'][number], value: StatusValue) {
      try {
        validateStatusConfigValue(item, value)
        setData(await controller!.update(item.id, value))
        setEditing(undefined)
        setMessage(`${item.label} saved`)
      } catch (error) {
        setMessage(error instanceof Error ? error.message : 'Unable to save configuration')
      }
    }
  })

  const renderedRows = useMemo(
    () => visible.map((row, index) => ({ row, selected: offset + index === selected })),
    [offset, selected, visible],
  )
  return (
    <PanelFrame footer={message} title="> /status">
      <TabBar
        activeId={active}
        onActiveChange={(id) => {
          setActive(id)
          setSelected(0)
          setMessage(TAB_HINTS[id as StatusTabId] ?? PLUGIN_TAB_HINT)
        }}
        tabs={tabs}
      />
      {active === 'usage' ? (
        <UsageView {...(data.usage ? { usage: data.usage } : {})} />
      ) : active === 'stats' ? (
        <StatsView columns={stdout.columns ?? 80} {...(data.stats ? { stats: data.stats } : {})} />
      ) : activePluginTab ? (
        <PluginTabView columns={stdout.columns ?? 80} tab={activePluginTab} />
      ) : (
        <Box flexDirection="column" minHeight={height}>
          {renderedRows.map(({ row, selected: isSelected }) => (
            <Box key={'id' in row ? row.id : row.label}>
              <Text {...(isSelected ? { color: 'cyan' } : {})}>{isSelected ? '› ' : '  '}</Text>
              <Box width={24}>
                <Text bold={isSelected}>{row.label}</Text>
              </Box>
              <Text
                {...('editable' in row && !row.editable ? { color: 'gray' } : {})}
                wrap="truncate-end"
              >
                {String(row.value)}
                {'editable' in row ? (row.editable ? '  [editable]' : '  [read-only]') : ''}
              </Text>
            </Box>
          ))}
        </Box>
      )}
      {editing ? <Text color="cyan">Value: {editing.value}▌</Text> : null}
      {isRowTab && rows.length > height ? (
        <Text dimColor>
          {offset + 1}–{Math.min(offset + height, rows.length)} / {rows.length}
        </Text>
      ) : null}
    </PanelFrame>
  )
}

function nextValue(item: StatusPanelData['config'][number], typed: string): StatusValue {
  if (item.kind === 'boolean') return !item.value
  if (item.kind === 'enum') {
    const choices = item.choices ?? []
    return choices[(choices.indexOf(String(item.value)) + 1) % choices.length] ?? item.value
  }
  if (item.kind === 'number') return Math.min(item.max ?? Infinity, Number(item.value) + 1)
  return typed.trim() || item.value
}
