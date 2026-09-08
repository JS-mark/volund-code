'use client'

import { Alert, Button, Empty, Input, List, Space, Table, Tabs, Tag, Typography } from 'antd'
import { useCallback, useEffect, useState } from 'react'

import type { WebApi } from '../lib/api'

type Tab = 'memory' | 'skill' | 'mcp' | 'plugins' | 'telemetry'

const TABS: { id: Tab; label: string }[] = [
  { id: 'memory', label: 'Memory' },
  { id: 'skill', label: 'Skills' },
  { id: 'mcp', label: 'MCP' },
  { id: 'plugins', label: 'Plugins' },
  { id: 'telemetry', label: 'Telemetry' },
]

/** 管理页（§22 W-11/W-12/W-14）：全部走 tagged-union actions 端点。 */
export function ManagePage({
  api,
  capabilities,
}: {
  api: WebApi
  capabilities: Record<string, unknown>
}) {
  const mgmt = (capabilities.management ?? {}) as Record<string, boolean>
  const available = TABS.filter((tab) => mgmt[tab.id])

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
          children: <TabBody api={api} tab={tab.id} />,
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
  }
}

function useInventory<T>(
  api: WebApi,
  domain: string,
  deps: unknown[] = [],
): {
  data: T | undefined
  error: string | undefined
  reload: () => void
} {
  const [data, setData] = useState<T>()
  const [error, setError] = useState<string>()
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let cancelled = false
    void api
      .managementList(domain)
      .then((data) => {
        if (!cancelled) setData(data as T)
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, domain, tick, ...deps])
  const reload = useCallback(() => setTick((value) => value + 1), [])
  return { data, error, reload }
}

function Notice({ message }: { message: string | undefined }) {
  if (!message) return null
  return <Alert type="warning" showIcon title={message} style={{ marginBottom: 8 }} />
}

type MemoryRecord = { id: string; content: string; pinned: boolean; updatedAt: string }

function MemoryPanel({ api }: { api: WebApi }) {
  const { data, error, reload } = useInventory<{
    scopeLabel: string
    searchAvailable: boolean
    items: { items: MemoryRecord[] }
  }>(api, 'memory')
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<MemoryRecord[]>()
  const [notice, setNotice] = useState<string>()

  const search = useCallback(async () => {
    try {
      const body = (await api.managementAction('memory', { action: 'search', query })) as {
        items: MemoryRecord[]
      }
      setResults(body.items)
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : String(cause))
    }
  }, [api, query])

  const act = useCallback(
    async (body: Record<string, unknown>) => {
      try {
        await api.managementAction('memory', body)
        reload()
      } catch (cause) {
        setNotice(cause instanceof Error ? cause.message : String(cause))
      }
    },
    [api, reload],
  )

  if (error) return <Alert type="error" showIcon title={error} />
  const items = results ?? data?.items?.items ?? []
  return (
    <div>
      <Space style={{ marginBottom: 8 }}>
        <Input.Search
          placeholder={data?.searchAvailable ? '搜索 Memory…' : '搜索不可用（recall 未装配）'}
          value={query}
          disabled={!data?.searchAvailable}
          onChange={(event) => setQuery(event.target.value)}
          onSearch={() => void search()}
          style={{ width: 320 }}
        />
        {results && <Button onClick={() => setResults(undefined)}>清除</Button>}
      </Space>
      <Notice message={notice} />
      <Typography.Text type="secondary">
        scope: {data?.scopeLabel ?? '…'} · {items.length} 条
      </Typography.Text>
      <List
        size="small"
        dataSource={items}
        renderItem={(record) => (
          <List.Item
            actions={[
              <Button
                key="pin"
                size="small"
                onClick={() =>
                  void act({
                    action: record.pinned ? 'unpin' : 'pin',
                    id: record.id,
                    expectedUpdatedAt: record.updatedAt,
                  })
                }
              >
                {record.pinned ? '取消置顶' : '置顶'}
              </Button>,
              <Button
                key="delete"
                size="small"
                danger
                onClick={() =>
                  void act({
                    action: 'delete',
                    id: record.id,
                    expectedUpdatedAt: record.updatedAt,
                  })
                }
              >
                删除
              </Button>,
            ]}
          >
            <List.Item.Meta
              title={
                <>
                  {record.pinned && '📌 '}
                  {record.content.slice(0, 120)}
                </>
              }
              description={`${record.id.slice(0, 8)} · ${record.updatedAt}`}
            />
          </List.Item>
        )}
      />
    </div>
  )
}

type SkillItem = {
  name: string
  description: string
  scope: string
  status: string
  version?: string
}

function SkillsPanel({ api }: { api: WebApi }) {
  const { data, error, reload } = useInventory<{ items: SkillItem[] }>(api, 'skill')
  const [notice, setNotice] = useState<string>()
  const toggle = useCallback(
    async (name: string, enabled: boolean) => {
      try {
        await api.managementAction('skill', { action: 'setEnabled', name, enabled })
        reload()
      } catch (cause) {
        setNotice(cause instanceof Error ? cause.message : String(cause))
      }
    },
    [api, reload],
  )
  if (error) return <Alert type="error" showIcon title={error} />
  return (
    <div>
      <Notice message={notice} />
      <List
        size="small"
        dataSource={data?.items ?? []}
        renderItem={(skill) => (
          <List.Item
            actions={[
              <Button
                key="toggle"
                size="small"
                onClick={() => void toggle(skill.name, skill.status === 'disabled')}
              >
                {skill.status === 'disabled' ? '启用' : '禁用'}
              </Button>,
            ]}
          >
            <List.Item.Meta
              title={
                <>
                  /{skill.name} <Tag>{skill.scope}</Tag>
                </>
              }
              description={skill.description}
            />
          </List.Item>
        )}
      />
    </div>
  )
}

type McpEntry = { name: string; transport: string; scope?: string; status?: string; tools?: number }

function McpPanel({ api }: { api: WebApi }) {
  const { data, error, reload } = useInventory<{ items: McpEntry[] }>(api, 'mcp')
  const [notice, setNotice] = useState<string>()
  const toggle = useCallback(
    async (name: string, enabled: boolean) => {
      try {
        await api.managementAction('mcp', { action: 'setEnabled', name, enabled })
        reload()
      } catch (cause) {
        setNotice(cause instanceof Error ? cause.message : String(cause))
      }
    },
    [api, reload],
  )
  if (error) return <Alert type="error" showIcon title={error} />
  return (
    <div>
      <Notice message={notice} />
      <List
        size="small"
        dataSource={data?.items ?? []}
        renderItem={(entry) => (
          <List.Item
            actions={[
              <Button
                key="toggle"
                size="small"
                onClick={() => void toggle(entry.name, entry.status === 'disabled')}
                disabled={
                  entry.status !== 'disabled' &&
                  entry.status !== 'connected' &&
                  entry.status !== 'failed'
                }
              >
                {entry.status === 'disabled' ? '启用' : '禁用'}
              </Button>,
            ]}
          >
            <List.Item.Meta
              title={
                <>
                  {entry.name} <Tag>{entry.transport}</Tag>
                </>
              }
              description={`${entry.scope ?? ''} · ${entry.status ?? 'unknown'}${entry.tools !== undefined ? ` · ${entry.tools} tools` : ''}`}
            />
          </List.Item>
        )}
      />
    </div>
  )
}

type BuiltinDomain = { id: string; label: string; description: string; enabled: boolean }

function PluginsPanel({ api }: { api: WebApi }) {
  const { data, error, reload } = useInventory<{ items: BuiltinDomain[] }>(api, 'plugins')
  const [availability, setAvailability] = useState<string>()
  const [notice, setNotice] = useState<string>()
  useEffect(() => {
    void api
      .managementAction('plugins', { action: 'availability' })
      .then((value) => {
        const item = value as { detail: string; reopenCondition: string }
        setAvailability(`${item.detail}（${item.reopenCondition}）`)
      })
      .catch(() => setAvailability(undefined))
  }, [api])
  const toggle = useCallback(
    async (id: string, enabled: boolean) => {
      try {
        await api.managementAction('plugins', { action: 'setDomain', id, enabled })
        reload()
      } catch (cause) {
        setNotice(cause instanceof Error ? cause.message : String(cause))
      }
    },
    [api, reload],
  )
  if (error) return <Alert type="error" showIcon title={error} />
  return (
    <div>
      {availability && (
        <Typography.Paragraph type="secondary">
          legacy catalog（deny-only）：{availability}
        </Typography.Paragraph>
      )}
      <Notice message={notice} />
      <List
        size="small"
        dataSource={data?.items ?? []}
        renderItem={(domain) => (
          <List.Item
            actions={[
              <Button
                key="toggle"
                size="small"
                onClick={() => void toggle(domain.id, !domain.enabled)}
              >
                {domain.enabled ? '禁用' : '启用'}
              </Button>,
            ]}
          >
            <List.Item.Meta title={domain.label} description={domain.description} />
          </List.Item>
        )}
      />
    </div>
  )
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
