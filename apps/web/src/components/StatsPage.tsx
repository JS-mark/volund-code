'use client'

import { Descriptions, Empty, Typography } from 'antd'
import { useEffect, useState } from 'react'

import type { WebApi } from '../lib/api'

function flatten(value: unknown, prefix = ''): { key: string; label: string; value: string }[] {
  if (value === null || value === undefined) return []
  if (typeof value !== 'object') return [{ key: prefix, label: prefix, value: String(value) }]
  if (Array.isArray(value)) return [{ key: prefix, label: prefix, value: `${value.length} 项` }]
  return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) =>
    flatten(item, prefix ? `${prefix}.${key}` : key),
  )
}

/** 统计页（可观测）：telemetry 汇总 + 健康（管理面 telemetry 域的只读投影）。 */
export function StatsPage({ api }: { api: WebApi }) {
  const [data, setData] = useState<{ summary?: unknown; health?: unknown }>()
  const [error, setError] = useState<string>()
  useEffect(() => {
    void api
      .managementList('telemetry')
      .then((result) => setData(result as { summary?: unknown; health?: unknown }))
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
  }, [api])

  const rows = [
    ...flatten(data?.summary).map((row) => ({
      ...row,
      label: `summary.${row.label}`,
      key: `s.${row.key}`,
    })),
    ...flatten(data?.health).map((row) => ({
      ...row,
      label: `health.${row.label}`,
      key: `h.${row.key}`,
    })),
  ]
  return (
    <section style={{ padding: 24, overflow: 'auto' }}>
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        统计
      </Typography.Title>
      {error ? (
        <Typography.Text type="warning">{error}</Typography.Text>
      ) : rows.length === 0 ? (
        <Empty description="暂无遥测数据（本地事件日志为空）" />
      ) : (
        <Descriptions
          size="small"
          column={1}
          bordered
          items={rows.map((row) => ({
            key: row.key,
            label: <Typography.Text type="secondary">{row.label}</Typography.Text>,
            children: row.value,
          }))}
        />
      )}
    </section>
  )
}
