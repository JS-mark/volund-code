'use client'

import { Alert, Empty, Table, Tabs, Typography } from 'antd'
import { useEffect, useState } from 'react'

import type { WebApi } from '../lib/api'
import { useInventory } from './manage-shared'
import { McpPanel, MemoryPanel, PluginsPanel, SkillsPanel } from './ManagePanels'
import { MarketPanel } from './MarketPanel'

type Tab = 'memory' | 'skill' | 'mcp' | 'plugins' | 'market' | 'telemetry'

const TABS: { id: Tab; label: string }[] = [
  { id: 'memory', label: 'Memory' },
  { id: 'skill', label: 'Skills' },
  { id: 'mcp', label: 'MCP' },
  { id: 'plugins', label: 'Plugins' },
  { id: 'market', label: '市场' },
  { id: 'telemetry', label: 'Telemetry' },
]

/** 管理页（§22 W-11/W-12/W-14 + WEB-EXT-MANAGE-MARKET-r1）：tagged-union actions 端点。 */
export function ManagePage({
  api,
  capabilities,
}: {
  api: WebApi
  capabilities: Record<string, unknown>
}) {
  const mgmt = (capabilities.management ?? {}) as Record<string, boolean>
  // 市场页签复用 skill/mcp/plugins 三域端点（§S3.6），任一装配即可用。
  const available = TABS.filter((tab) =>
    tab.id === 'market' ? mgmt.skill || mgmt.mcp || mgmt.plugins : mgmt[tab.id],
  )

  if (available.length === 0)
    return (
      <section style={{ padding: 24 }}>
        <Typography.Title level={4} style={{ marginTop: 0 }}>
          管理
        </Typography.Title>
        <Empty description="没有已装配的管理域（unavailable）" />
      </section>
    )

  return (
    <section style={{ padding: 24, overflow: 'auto' }}>
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        管理
      </Typography.Title>
      <Tabs
        items={available.map((tab) => ({
          key: tab.id,
          label: tab.label,
          children:
            tab.id === 'market' ? (
              <MarketPanel api={api} available={mgmt} />
            ) : (
              <TabBody api={api} tab={tab.id} />
            ),
        }))}
      />
    </section>
  )
}

function TabBody({ api, tab }: { api: WebApi; tab: Tab }) {
  switch (tab) {
    case 'memory':
      return <MemoryPanel api={api} />
    case 'skill':
      return <SkillsPanel api={api} />
    case 'mcp':
      return <McpPanel api={api} />
    case 'plugins':
      return <PluginsPanel api={api} />
    case 'telemetry':
      return <TelemetryPanel api={api} />
    case 'market':
      return <MarketPanel api={api} available={{}} />
  }
}

function TelemetryPanel({ api }: { api: WebApi }) {
  const [tab, setTab] = useState<'summary' | 'events'>('summary')
  const { data, error, reload } = useInventory<{
    summary: unknown
    health: unknown
  }>(api, 'telemetry')
  const [events, setEvents] = useState<{
    events: { name: string; category?: string; at?: string }[]
    corruptLines: number
    total: number
  }>()
  useEffect(() => {
    if (tab !== 'events') return
    void api
      .managementAction('telemetry', { action: 'events', limit: 200 })
      .then((value) =>
        setEvents(
          value as {
            events: { name: string; category?: string; at?: string }[]
            corruptLines: number
            total: number
          },
        ),
      )
      .catch(() => setEvents(undefined))
  }, [api, tab, reload])
  if (error) return <Alert type="error" showIcon title={error} />
  return (
    <div>
      <Tabs
        size="small"
        activeKey={tab}
        onChange={(key) => setTab(key as 'summary' | 'events')}
        items={[
          { key: 'summary', label: '摘要' },
          { key: 'events', label: '最近事件' },
        ]}
      />
      {tab === 'summary' ? (
        <>
          <Typography.Title level={5}>摘要</Typography.Title>
          <pre style={{ fontSize: 12, overflow: 'auto' }}>
            {JSON.stringify(data?.summary ?? {}, null, 2)}
          </pre>
          <Typography.Title level={5}>健康</Typography.Title>
          <pre style={{ fontSize: 12, overflow: 'auto' }}>
            {JSON.stringify(data?.health ?? {}, null, 2)}
          </pre>
        </>
      ) : (
        <>
          <Typography.Paragraph type="secondary">
            最近 {events?.events.length ?? 0} 条（共 {events?.total ?? 0}，损坏行{' '}
            {events?.corruptLines ?? 0}）
          </Typography.Paragraph>
          <Table
            size="small"
            pagination={false}
            dataSource={(events?.events ?? []).toReversed().map((event, index) => ({
              key: index,
              ...event,
            }))}
            columns={[
              { dataIndex: 'at', key: 'at', width: 200 },
              {
                key: 'name',
                render: (_, event) =>
                  `${event.category ? `[${event.category}] ` : ''}${event.name}`,
              },
            ]}
          />
        </>
      )}
    </div>
  )
}
