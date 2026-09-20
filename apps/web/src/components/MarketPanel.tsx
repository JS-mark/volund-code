'use client'

/**
 * 市场页签（WEB-EXT-MANAGE-MARKET-r1 §S3.6 / MG-13）：Plugins（复用
 * `[plugins] market` 既有链）/ Skills（`[skills] market` git 目录索引，远程可装）/
 * MCP（`[mcp] market` 目录，「安装」= 预填表单确认落盘，不静默安装）。
 * 已装回标分段：Plugins = installed/approval-required/enabled；Skills = 仅已装；
 * MCP = 已配置。
 */
import { ReloadOutlined } from '@ant-design/icons'
import { Alert, Button, Empty, List, Segmented, Space, Tag, Typography } from 'antd'
import { useCallback, useEffect, useState } from 'react'

import type { WebApi } from '../lib/api'
import { Notice, installableMarketSource, marketErrorMessage, useAction } from './manage-shared'
import { McpServerFormModal } from './ManagePanels'

type MarketKind = 'plugins' | 'skills' | 'mcp'

export function MarketPanel({
  api,
  available,
}: {
  api: WebApi
  available: Record<string, boolean>
}) {
  const [kind, setKind] = useState<MarketKind>(
    available.plugins ? 'plugins' : available.skills ? 'skills' : 'mcp',
  )
  return (
    <div>
      <Space style={{ marginBottom: 12 }}>
        <Segmented
          value={kind}
          onChange={(next) => setKind(next as MarketKind)}
          options={[
            ...(available.plugins ? [{ value: 'plugins', label: 'Plugins' }] : []),
            ...(available.skills ? [{ value: 'skills', label: 'Skills' }] : []),
            ...(available.mcp ? [{ value: 'mcp', label: 'MCP' }] : []),
          ]}
        />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          索引源：<code>[plugins|skills|mcp] market</code>（~/.volund/config.toml；项目级覆盖禁止）
        </Typography.Text>
      </Space>
      {kind === 'plugins' && <PluginsMarket api={api} />}
      {kind === 'skills' && <SkillsMarket api={api} />}
      {kind === 'mcp' && <McpMarket api={api} />}
    </div>
  )
}

// ── Plugins 段：复用 plugins domain registry ──────────────────────────

type PluginRegistry =
  | {
      source: string
      plugins: { name: string; version: string; description?: string; publisher?: string }[]
    }
  | { error: string }

function PluginsMarket({ api }: { api: WebApi }) {
  const { notice, setNotice, run } = useAction(api, 'plugins')
  const [registry, setRegistry] = useState<PluginRegistry>()
  const [installed, setInstalled] =
    useState<{ name: string; lifecycle?: { approved: boolean; enabled: boolean } }[]>()
  const [busy, setBusy] = useState<string>()
  const load = useCallback(async () => {
    const result = (await run({ action: 'inventory' }, undefined)) as
      | {
          market: {
            installed: { name: string; lifecycle?: { approved: boolean; enabled: boolean } }[]
            registry: PluginRegistry
          }
        }
      | undefined
    if (result) {
      setInstalled(result.market.installed)
      setRegistry(result.market.registry)
    }
  }, [run])
  const installListing = useCallback(
    async (name: string) => {
      setBusy(name)
      try {
        await api.managementAction('plugins', { action: 'install', name })
        await load()
      } catch (cause) {
        setNotice(marketErrorMessage(cause))
      } finally {
        setBusy(undefined)
      }
    },
    [api, load],
  )
  useEffect(() => {
    void load()
  }, [load])
  return (
    <div>
      <Space style={{ marginBottom: 8 }}>
        <Button icon={<ReloadOutlined />} onClick={() => void load()}>
          刷新
        </Button>
      </Space>
      <Notice message={notice} />
      {!registry && <Empty description="未配置 [plugins] market（~/.volund/config.toml）" />}
      {registry && 'error' in registry && <Alert type="warning" showIcon title={registry.error} />}
      {registry && 'plugins' in registry && (
        <>
          <Typography.Paragraph type="secondary">
            源：{registry.source} · {registry.plugins.length} 个条目 ·{' '}
            {installableMarketSource(registry.source)
              ? '本地源，可安装'
              : '远程 HTTPS 安装需签名信任根（§19a），当前置灰'}
          </Typography.Paragraph>
          <List
            size="small"
            dataSource={registry.plugins}
            renderItem={(listing) => {
              const record = installed?.find((entry) => entry.name === listing.name)
              const badge = record
                ? record.lifecycle?.enabled
                  ? 'enabled'
                  : record.lifecycle?.approved
                    ? 'approved'
                    : 'approval-required'
                : undefined
              const canInstall = !badge && installableMarketSource(registry.source)
              return (
                <List.Item
                  actions={
                    badge
                      ? [
                          <Tag key="state" color={badge === 'enabled' ? 'success' : 'processing'}>
                            {badge}
                          </Tag>,
                        ]
                      : [
                          <Button
                            key="install"
                            size="small"
                            type="primary"
                            disabled={!canInstall}
                            loading={busy === listing.name}
                            title={
                              canInstall
                                ? undefined
                                : '等待签名信任根（§19a）；loopback http 本地源可装'
                            }
                            onClick={() => void installListing(listing.name)}
                          >
                            安装
                          </Button>,
                        ]
                  }
                >
                  <List.Item.Meta
                    title={
                      <>
                        {listing.name} <Tag>v{listing.version}</Tag>
                      </>
                    }
                    description={[listing.publisher, listing.description]
                      .filter(Boolean)
                      .join(' · ')}
                  />
                </List.Item>
              )
            }}
          />
        </>
      )}
    </div>
  )
}

// ── Skills 段：`[skills] market` 目录（git 安装通道）───────────────────

type SkillMarketEntry = { name: string; description?: string; version?: string; source: string }

function SkillsMarket({ api }: { api: WebApi }) {
  const { notice, setNotice, run } = useAction(api, 'skills')
  const [entries, setEntries] = useState<SkillMarketEntry[]>()
  const [installedNames, setInstalledNames] = useState<string[]>()
  const [busy, setBusy] = useState<string>()
  const [scope, setScope] = useState<'user' | 'project'>('user')
  const load = useCallback(async () => {
    await run({ action: 'marketList' }, (value) => {
      const view = value as { entries?: SkillMarketEntry[]; error?: string } | undefined
      if (!view) setNotice('未配置 [skills] market')
      else if ('error' in view) setNotice(view.error ?? '索引拉取失败')
      else setEntries(view.entries ?? [])
    })
    await run({ action: 'list' }, (value) => {
      setInstalledNames(
        ((value as { items: { name: string }[] }).items ?? []).map((item) => item.name),
      )
    })
  }, [run])
  const installSkill = useCallback(
    async (entry: SkillMarketEntry) => {
      setBusy(entry.name)
      try {
        await api.managementAction('skill', { action: 'install', spec: entry.source, scope })
        await load()
      } catch (cause) {
        setNotice(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setBusy(undefined)
      }
    },
    [api, load, scope],
  )
  useEffect(() => {
    void load()
  }, [load])
  return (
    <div>
      <Space style={{ marginBottom: 8 }} wrap>
        <Button icon={<ReloadOutlined />} onClick={() => void load()}>
          刷新
        </Button>
        <Segmented
          value={scope}
          onChange={(next) => setScope(next as 'user' | 'project')}
          options={[
            { value: 'user', label: '装到用户级' },
            { value: 'project', label: '装到项目级' },
          ]}
        />
      </Space>
      <Notice message={notice} />
      {entries !== undefined && entries.length === 0 && <Empty description="目录为空" />}
      <List
        size="small"
        dataSource={entries ?? []}
        renderItem={(entry) => {
          const isInstalled = installedNames?.includes(entry.name)
          return (
            <List.Item
              actions={[
                isInstalled ? (
                  <Tag key="state" color="success">
                    已装
                  </Tag>
                ) : (
                  <Button
                    key="install"
                    size="small"
                    type="primary"
                    loading={busy === entry.name}
                    onClick={() => void installSkill(entry)}
                  >
                    安装
                  </Button>
                ),
              ]}
            >
              <List.Item.Meta
                title={
                  <>
                    /{entry.name} {entry.version && <Tag>v{entry.version}</Tag>}
                  </>
                }
                description={[entry.source, entry.description].filter(Boolean).join(' · ')}
              />
            </List.Item>
          )
        }}
      />
    </div>
  )
}

// ── MCP 段：目录条目 → 预填 add 表单（不静默安装）──────────────────────

type McpMarketEntry = {
  name: string
  description?: string
  transport: 'stdio' | 'http'
  url?: string
  headers?: Record<string, string>
  command?: string
  args?: string[]
  env?: Record<string, string>
}

function McpMarket({ api }: { api: WebApi }) {
  const { notice, setNotice, run } = useAction(api, 'mcp')
  const [entries, setEntries] = useState<McpMarketEntry[]>()
  const [configured, setConfigured] = useState<string[]>()
  const [prefill, setPrefill] = useState<McpMarketEntry>()
  const load = useCallback(async () => {
    await run({ action: 'marketList' }, (value) => {
      const view = value as { entries?: McpMarketEntry[]; error?: string } | undefined
      if (!view) setNotice('未配置 [mcp] market')
      else if ('error' in view) setNotice(view.error ?? '索引拉取失败')
      else setEntries(view.entries ?? [])
    })
    await run({ action: 'list' }, (value) => {
      setConfigured(((value as { items: { name: string }[] }).items ?? []).map((item) => item.name))
    })
  }, [run])
  useEffect(() => {
    void load()
  }, [load])
  return (
    <div>
      <Space style={{ marginBottom: 8 }}>
        <Button icon={<ReloadOutlined />} onClick={() => void load()}>
          刷新
        </Button>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          目录条目只预填表单——command/env 全文可见，确认后才写入 mcp.toml
        </Typography.Text>
      </Space>
      <Notice message={notice} />
      <List
        size="small"
        dataSource={entries ?? []}
        renderItem={(entry) => {
          const isConfigured = configured?.includes(entry.name)
          return (
            <List.Item
              actions={[
                isConfigured ? (
                  <Tag key="state" color="success">
                    已配置
                  </Tag>
                ) : (
                  <Button key="prefill" size="small" onClick={() => setPrefill(entry)}>
                    预填安装…
                  </Button>
                ),
              ]}
            >
              <List.Item.Meta
                title={
                  <>
                    {entry.name} <Tag>{entry.transport}</Tag>
                  </>
                }
                description={
                  entry.transport === 'stdio'
                    ? [entry.command, (entry.args ?? []).join(' ')].filter(Boolean).join(' ')
                    : entry.url
                }
              />
            </List.Item>
          )
        }}
      />
      {prefill && (
        <McpServerFormModal
          api={api}
          open
          onClose={() => setPrefill(undefined)}
          onSaved={() => void load()}
          initial={{
            name: prefill.name,
            kind: prefill.transport,
            ...(prefill.transport === 'stdio'
              ? {
                  command: prefill.command ?? '',
                  args: prefill.args ?? [],
                  env: { ...prefill.env },
                }
              : { url: prefill.url ?? '', headers: { ...prefill.headers } }),
          }}
        />
      )}
    </div>
  )
}
