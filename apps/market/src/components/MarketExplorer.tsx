'use client'

import { ReloadOutlined, SearchOutlined } from '@ant-design/icons'
import { Button, Input, Segmented, Space, Spin } from 'antd'
import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useState } from 'react'

import { useI18n } from './Providers'

type Kind = 'plugins' | 'skills' | 'mcp'

interface EntryItem {
  name: string
  version?: string
  description?: string
  publisher?: string
  downloads?: number
  updatedAt?: string
  addedAt?: string
  transport?: string
  source?: string
}

const hostOf = (url: string | undefined) => {
  try {
    return url ? new URL(url).host : undefined
  } catch {
    return undefined
  }
}

export default function MarketExplorer() {
  const router = useRouter()
  const { t } = useI18n()
  const [kind, setKind] = useState<Kind>('plugins')
  const [items, setItems] = useState<readonly EntryItem[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')

  const kindOptions = [
    { value: 'plugins' as const, label: t['kind.plugins'] },
    { value: 'skills' as const, label: t['kind.skills'] },
    { value: 'mcp' as const, label: t['kind.mcp'] },
  ]

  const load = useCallback(async (nextKind: Kind, nextQuery: string) => {
    setLoading(true)
    try {
      const response = await fetch(
        `/api/v1/${nextKind}?pageSize=48&q=${encodeURIComponent(nextQuery)}`,
      )
      const data = (await response.json()) as { items?: EntryItem[]; total?: number }
      setItems(data.items ?? [])
      setTotal(data.total ?? 0)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load(kind, query)
  }, [load, kind, query])

  return (
    <div>
      <p className="mk-eyebrow">
        <span className="mk-dot" />
        plugin registry · {total} {total === 1 ? 'entry' : 'entries'}
      </p>
      <h1 className="mk-display">{t['home.title']}</h1>
      <p className="mk-lede">{t['home.lede']}</p>
      <div className="mk-toolbar">
        <Space wrap>
          <Segmented
            options={kindOptions}
            value={kind}
            onChange={(value) => setKind(value as Kind)}
          />
          <Input.Search
            allowClear
            placeholder={t[`home.search.${kind}` as const]}
            prefix={<SearchOutlined />}
            style={{ width: 280 }}
            onSearch={(value) => setQuery(value)}
          />
        </Space>
        <Button icon={<ReloadOutlined />} onClick={() => void load(kind, query)}>
          {t['common.refresh']}
        </Button>
      </div>
      {loading ? (
        <div className="mk-loading">
          <Spin />
        </div>
      ) : items.length === 0 ? (
        <div className="mk-empty">{t['common.empty']}</div>
      ) : (
        <div className="mk-grid">
          {items.map((item) => (
            <article
              key={item.name}
              className="mk-card"
              onClick={() => router.push(`/entries/${kind}/${item.name}`)}
            >
              <div className="mk-card-head">
                <h3>{item.name}</h3>
                {item.version ? <span className="mk-chip">v{item.version}</span> : undefined}
                {!item.version && item.transport ? (
                  <span className="mk-chip neutral">{item.transport}</span>
                ) : undefined}
              </div>
              <p className="mk-desc">{item.description ?? '—'}</p>
              <div className="mk-meta">
                {item.publisher ? <span>{item.publisher}</span> : undefined}
                {kind === 'plugins' && item.downloads !== undefined ? (
                  <span>↓ {item.downloads}</span>
                ) : undefined}
                {kind === 'skills' && item.source ? (
                  <span>{hostOf(item.source) ?? 'git'}</span>
                ) : undefined}
                {kind === 'mcp' && item.transport ? <span>{item.transport}</span> : undefined}
                {item.updatedAt ?? item.addedAt ? (
                  <span>{(item.updatedAt ?? item.addedAt ?? '').slice(0, 10)}</span>
                ) : undefined}
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  )
}
