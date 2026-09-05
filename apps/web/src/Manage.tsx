import { useCallback, useEffect, useState } from 'react'

import type { WebApi } from './api'

type Tab = 'memory' | 'skill' | 'mcp' | 'plugins' | 'telemetry'

const TABS: { id: Tab; label: string }[] = [
  { id: 'memory', label: 'Memory' },
  { id: 'skill', label: 'Skills' },
  { id: 'mcp', label: 'MCP' },
  { id: 'plugins', label: 'Plugins' },
  { id: 'telemetry', label: 'Telemetry' },
]

/** 管理页（§22 W-11/W-12/W-14 首版）：全部走 tagged-union actions 端点。 */
export function Manage({
  api,
  capabilities,
}: {
  api: WebApi
  capabilities: Record<string, unknown>
}) {
  const mgmt = (capabilities.management ?? {}) as Record<string, boolean>
  const available = TABS.filter((tab) => mgmt[tab.id])
  const [tab, setTab] = useState<Tab>(available[0]?.id ?? 'memory')

  return (
    <section>
      <h2>管理</h2>
      {available.length === 0 ? (
        <p className="muted">没有已装配的管理域（unavailable）。</p>
      ) : (
        <>
          <div className="tabs">
            {available.map((item) => (
              <button
                key={item.id}
                className={tab === item.id ? 'active' : ''}
                onClick={() => setTab(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
          {tab === 'memory' && <MemoryPanel api={api} />}
          {tab === 'skill' && <SkillsPanel api={api} />}
          {tab === 'mcp' && <McpPanel api={api} />}
          {tab === 'plugins' && <PluginsPanel api={api} />}
          {tab === 'telemetry' && <TelemetryPanel api={api} />}
        </>
      )}
    </section>
  )
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
  return <p className="warn">{message}</p>
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

  if (error) return <p className="warn">{error}</p>
  const items = results ?? data?.items?.items ?? []
  return (
    <div>
      <div className="row">
        <input
          className="search"
          placeholder={data?.searchAvailable ? '搜索 Memory…' : '搜索不可用（recall 未装配）'}
          value={query}
          disabled={!data?.searchAvailable}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void search()
          }}
        />
        <button onClick={() => void search()} disabled={!data?.searchAvailable}>
          搜索
        </button>
        {results && (
          <button className="ghost" onClick={() => setResults(undefined)}>
            清除
          </button>
        )}
      </div>
      <Notice message={notice} />
      <p className="muted">
        scope: {data?.scopeLabel ?? '…'} · {items.length} 条
      </p>
      <ul className="sessions">
        {items.map((record) => (
          <li key={record.id}>
            <div className="row">
              <div>
                <div>{record.content.slice(0, 120)}</div>
                <div className="muted">
                  {record.id.slice(0, 8)} · {record.pinned ? '📌 ' : ''}
                  {record.updatedAt}
                </div>
              </div>
              <div className="actions">
                <button
                  onClick={() =>
                    void act({
                      action: record.pinned ? 'unpin' : 'pin',
                      id: record.id,
                      expectedUpdatedAt: record.updatedAt,
                    })
                  }
                >
                  {record.pinned ? '取消置顶' : '置顶'}
                </button>
                <button
                  className="danger"
                  onClick={() =>
                    void act({
                      action: 'delete',
                      id: record.id,
                      expectedUpdatedAt: record.updatedAt,
                    })
                  }
                >
                  删除
                </button>
              </div>
            </div>
          </li>
        ))}
      </ul>
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
  if (error) return <p className="warn">{error}</p>
  return (
    <div>
      <Notice message={notice} />
      <ul className="sessions">
        {(data?.items ?? []).map((skill) => (
          <li key={skill.name}>
            <div className="row">
              <div>
                <div className="title">
                  /{skill.name} <span className="muted">{skill.scope}</span>
                </div>
                <div className="muted">{skill.description}</div>
              </div>
              <button onClick={() => void toggle(skill.name, skill.status === 'disabled')}>
                {skill.status === 'disabled' ? '启用' : '禁用'}
              </button>
            </div>
          </li>
        ))}
      </ul>
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
  if (error) return <p className="warn">{error}</p>
  return (
    <div>
      <Notice message={notice} />
      <ul className="sessions">
        {(data?.items ?? []).map((entry) => (
          <li key={entry.name}>
            <div className="row">
              <div>
                <div className="title">
                  {entry.name} <span className="muted">{entry.transport}</span>
                </div>
                <div className="muted">
                  {entry.scope ?? ''} · {entry.status ?? 'unknown'}
                  {entry.tools !== undefined ? ` · ${entry.tools} tools` : ''}
                </div>
              </div>
              <button
                onClick={() => void toggle(entry.name, entry.status === 'disabled')}
                disabled={
                  entry.status !== 'disabled' &&
                  entry.status !== 'connected' &&
                  entry.status !== 'failed'
                }
              >
                {entry.status === 'disabled' ? '启用' : '禁用'}
              </button>
            </div>
          </li>
        ))}
      </ul>
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
  if (error) return <p className="warn">{error}</p>
  return (
    <div>
      {availability && <p className="muted">legacy catalog（deny-only）：{availability}</p>}
      <Notice message={notice} />
      <ul className="sessions">
        {(data?.items ?? []).map((domain) => (
          <li key={domain.id}>
            <div className="row">
              <div>
                <div className="title">{domain.label}</div>
                <div className="muted">{domain.description}</div>
              </div>
              <button onClick={() => void toggle(domain.id, !domain.enabled)}>
                {domain.enabled ? '禁用' : '启用'}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

function TelemetryPanel({ api }: { api: WebApi }) {
  const { data, error } = useInventory<{ summary: unknown; health: unknown }>(api, 'telemetry')
  if (error) return <p className="warn">{error}</p>
  return (
    <div>
      <h3>摘要</h3>
      <pre className="code">{JSON.stringify(data?.summary ?? {}, null, 2)}</pre>
      <h3>健康</h3>
      <pre className="code">{JSON.stringify(data?.health ?? {}, null, 2)}</pre>
    </div>
  )
}
