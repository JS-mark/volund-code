'use client'

import { DeleteOutlined, PlusOutlined } from '@ant-design/icons'
/**
 * 管理页共享件（WEB-EXT-MANAGE-MARKET-r1）：inventory hook / 错误条 / 键值对编辑器
 * / 下载工具。字段交互对齐 SettingsPage 的编辑器族（ProvidersEditor 模式）。
 */
import { Button, Alert, Input, Space, Tag, Typography } from 'antd'
import { useCallback, useEffect, useState } from 'react'

import type { WebApi } from '../lib/api'

export function useInventory<T>(
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

export function Notice({ message }: { message: string | undefined }) {
  if (!message) return null
  return <Alert type="warning" showIcon title={message} style={{ marginBottom: 12 }} />
}

/** 页头：标题 + 一句话说明（管理页每域一段自我解释）。 */
export function PanelIntro({ title, description }: { title: string; description: string }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <Typography.Title level={5} style={{ marginTop: 0, marginBottom: 2 }}>
        {title}
      </Typography.Title>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {description}
      </Typography.Text>
    </div>
  )
}

/** 面板工具条：左侧主操作，右侧次要点位；通栏浅底容器。 */
export function PanelToolbar({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: 12,
        flexWrap: 'wrap',
        padding: '10px 12px',
        marginBottom: 12,
        borderRadius: 10,
        background: 'var(--ant-color-fill-quaternary, rgba(128, 128, 128, 0.08))',
      }}
    >
      {children}
    </div>
  )
}

/** 计数徽标：scope + 条数（数据边界可视化）。 */
export function CountBadge({
  scopeLabel,
  count,
  unit = '条',
}: {
  scopeLabel: string
  count: number
  unit?: string
}) {
  const label =
    scopeLabel === 'project'
      ? '项目级'
      : scopeLabel === 'workspace'
        ? '工作区'
        : scopeLabel === 'session'
          ? '会话'
          : scopeLabel
  return (
    <span>
      <Tag color="blue">{label}</Tag>
      <Typography.Text type="secondary">
        {count} {unit}
      </Typography.Text>
    </span>
  )
}

/** ISO 时间 → 本地短格式（09-20 13:08）。 */
export function formatTime(iso: string | undefined): string {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 列表行卡片容器：统一 border/radius/hover。 */
export function ItemCard({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="manage-item-card"
      style={{
        border: '1px solid var(--ant-color-border-secondary, rgba(128,128,128,0.2))',
        borderRadius: 10,
        padding: '10px 14px',
        transition: 'border-color 0.2s',
      }}
    >
      {children}
    </div>
  )
}

/** 状态点：圆形色点 + 文案（MCP 连接态等）。 */
export function StatusDot({ color, text }: { color: string; text: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: color,
          display: 'inline-block',
        }}
      />
      <span style={{ fontSize: 12 }}>{text}</span>
    </span>
  )
}

/** 动作快捷封装：错误转 notice，成功可选回调。 */
export function useAction(api: WebApi, domain: string) {
  const [notice, setNotice] = useState<string>()
  const run = useCallback(
    async (body: Record<string, unknown>, onOk?: (result: unknown) => void) => {
      try {
        const result = await api.managementAction(domain, body)
        setNotice(undefined)
        onOk?.(result)
        return result
      } catch (cause) {
        setNotice(cause instanceof Error ? cause.message : String(cause))
        return undefined
      }
    },
    [api, domain],
  )
  return { notice, setNotice, run }
}

export function KeyValueEditor({
  value,
  onChange,
  keyPlaceholder = '键',
  valuePlaceholder = '值',
  secretValues = false,
}: {
  value: Record<string, string>
  onChange: (next: Record<string, string>) => void
  keyPlaceholder?: string
  valuePlaceholder?: string
  secretValues?: boolean
}) {
  const entries = Object.entries(value)
  return (
    <div style={{ display: 'grid', gap: 4 }}>
      {entries.map(([key, item], index) => (
        <Space key={`${key}:${index}`} style={{ display: 'flex' }}>
          <Input
            style={{ width: 180 }}
            placeholder={keyPlaceholder}
            value={key}
            onChange={(event) => {
              const next = { ...value }
              delete next[key]
              next[event.target.value] = item
              onChange(next)
            }}
          />
          <Input
            style={{
              width: 260,
              ...(secretValues ? { fontFamily: 'ui-monospace, monospace' } : {}),
            }}
            placeholder={secretValues ? '值或 keyref://mcp.<name>.<field>' : valuePlaceholder}
            value={item}
            onChange={(event) => onChange({ ...value, [key]: event.target.value })}
          />
          <Button
            icon={<DeleteOutlined />}
            onClick={() => {
              const next = { ...value }
              delete next[key]
              onChange(next)
            }}
          />
        </Space>
      ))}
      <Button
        type="dashed"
        icon={<PlusOutlined />}
        style={{ width: 'fit-content' }}
        onClick={() => onChange({ ...value, '': '' })}
      >
        添加
      </Button>
    </div>
  )
}

export function downloadJson(name: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  anchor.click()
  URL.revokeObjectURL(url)
}

/** 友好转译市场安装的 fail-closed 错误（§S3.5：远程 HTTPS 等签名信任根）。 */
export function marketErrorMessage(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause)
  if (message.includes('plugin_registry_signature_required'))
    return '远程插件安装需要签名信任根（§19a capability contract）后开放；当前可配置 loopback http 本地源自建市场。'
  return message
}

/** 与 plugin-market isLocalMarketSource 同判定的前端镜像：仅 loopback http 可装（D-1）。 */
export function installableMarketSource(source: string | undefined): boolean {
  if (!source) return false
  try {
    const url = new URL(source)
    return (
      url.protocol === 'http:' &&
      (url.hostname === 'localhost' ||
        url.hostname === '127.0.0.1' ||
        url.hostname === '[::1]' ||
        url.hostname === '::1')
    )
  } catch {
    return false
  }
}
