'use client'

/**
 * 市场页签（WEB-EXT-MANAGE-MARKET-r1 §S3.6 / MG-13）：Plugins（复用
 * `[plugins] market` 既有链）/ Skills（`[skills] market` git 目录索引，远程可装）/
 * MCP（`[mcp] market` 目录，「安装」= 预填表单确认落盘，不静默安装）。
 * 已装回标分段：Plugins = installed/approval-required/enabled；Skills = 仅已装；
 * MCP = 已配置。
 */
import { ReloadOutlined } from '@ant-design/icons'
import {
  Alert,
  Button,
  Descriptions,
  Empty,
  Input,
  Modal,
  Segmented,
  Space,
  Spin,
  Tag,
  Typography,
} from 'antd'
import { useCallback, useEffect, useState } from 'react'

import type { WebApi } from '../lib/api'
import {
  ItemCard,
  Notice,
  PanelToolbar,
  StatusDot,
  installableMarketSource,
  marketErrorMessage,
  useAction,
} from './manage-shared'
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
    available.plugins ? 'plugins' : available.skill ? 'skills' : 'mcp',
  )
  return (
    <div>
      <div style={{ marginBottom: 10 }}>
        <Typography.Title level={5} style={{ marginTop: 0, marginBottom: 2 }}>
          市场
        </Typography.Title>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          索引源：
          <code>[plugins|skills|mcp] market</code>
          （~/.volund/config.toml；项目级覆盖禁止，供应链面不变）
        </Typography.Text>
      </div>
      <Segmented
        value={kind}
        onChange={(next) => setKind(next as MarketKind)}
        style={{ marginBottom: 12 }}
        options={[
          ...(available.plugins ? [{ value: 'plugins', label: 'Plugins' }] : []),
          ...(available.skill ? [{ value: 'skills', label: 'Skills' }] : []),
          ...(available.mcp ? [{ value: 'mcp', label: 'MCP' }] : []),
        ]}
      />
      {kind === 'plugins' && <PluginsMarket api={api} />}
      {kind === 'skills' && <SkillsMarket api={api} />}
      {kind === 'mcp' && <McpMarket api={api} />}
    </div>
  )
}

/** 条目卡片：名称/版本行 + 描述行 + 右侧动作；左侧区域可点开详情抽屉。 */
function MarketItemCard({
  title,
  version,
  meta,
  action,
  onDetail,
}: {
  title: string
  version?: string
  meta?: string
  action: React.ReactNode
  onDetail?: () => void
}) {
  return (
    <ItemCard>
      <div
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}
      >
        <div
          style={{ minWidth: 0, cursor: onDetail ? 'pointer' : undefined }}
          onClick={onDetail}
          title={onDetail ? '查看详情' : undefined}
        >
          <Space size={8} wrap>
            <Typography.Text strong>{title}</Typography.Text>
            {version && <Tag color="default">v{version}</Tag>}
          </Space>
          {meta && (
            <Typography.Paragraph
              type="secondary"
              style={{ marginBottom: 0, fontSize: 12 }}
              ellipsis={{ rows: 2 }}
            >
              {meta}
            </Typography.Paragraph>
          )}
          {onDetail && (
            <Typography.Link
              onClick={(event) => {
                event.stopPropagation()
                onDetail()
              }}
              style={{ fontSize: 12 }}
            >
              详情
            </Typography.Link>
          )}
        </div>
        <div style={{ flexShrink: 0 }}>{action}</div>
      </div>
    </ItemCard>
  )
}

function RefreshButton({ onClick, loading }: { onClick: () => void; loading: boolean }) {
  return (
    <Button icon={<ReloadOutlined />} size="small" loading={loading} onClick={onClick}>
      刷新
    </Button>
  )
}

function Grid({ children }: { children: React.ReactNode }) {
  return <div style={{ display: 'grid', gap: 8 }}>{children}</div>
}

/** 首次加载占位（拉远端索引秒级耗时；有数据后的刷新走按钮 loading，不闪列表）。 */
function LoadingBlock({ text }: { text: string }) {
  return (
    <div style={{ display: 'grid', placeItems: 'center', gap: 10, padding: '56px 0' }}>
      <Spin />
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {text}
      </Typography.Text>
    </div>
  )
}

// ── Plugins 段：复用 plugins domain registry ──────────────────────────

type PluginListing = {
  name: string
  version: string
  description?: string
  publisher?: string
}

type PluginRegistry = { source: string; plugins: PluginListing[] } | { error: string }

function PluginsMarket({ api }: { api: WebApi }) {
  const { notice, setNotice, run } = useAction(api, 'plugins')
  const [registry, setRegistry] = useState<PluginRegistry>()
  const [installed, setInstalled] =
    useState<{ name: string; lifecycle?: { approved: boolean; enabled: boolean } }[]>()
  const [busy, setBusy] = useState<string>()
  const [detail, setDetail] = useState<PluginListing>()
  const [loading, setLoading] = useState(true)
  const load = useCallback(async () => {
    setLoading(true)
    try {
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
    } finally {
      setLoading(false)
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
      <PanelToolbar>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {registry && 'plugins' in registry
            ? `源：${registry.source} · ${installableMarketSource(registry.source) ? '本地源，可安装' : '远程 HTTPS 安装需签名信任根（§19a），当前置灰'}`
            : '远程 HTTPS 安装需签名信任根（§19a）；loopback http 本地源可装'}
        </Typography.Text>
        <RefreshButton loading={loading} onClick={() => void load()} />
      </PanelToolbar>
      <Notice message={notice} />
      {loading && !registry && <LoadingBlock text="正在加载市场 inventory…" />}
      {!loading && !registry && (
        <Empty description="未配置 [plugins] market（~/.volund/config.toml）" />
      )}
      {registry && 'error' in registry && <Alert type="warning" showIcon title={registry.error} />}
      {registry && 'plugins' in registry && (
        <Grid>
          {registry.plugins.length === 0 && (
            <Empty description="市场源没有条目" image={Empty.PRESENTED_IMAGE_SIMPLE} />
          )}
          {registry.plugins.map((listing) => {
            const record = installed?.find((entry) => entry.name === listing.name)
            const badge = record
              ? record.lifecycle?.enabled
                ? { color: '#52c41a', text: '已启用' }
                : record.lifecycle?.approved
                  ? { color: '#1677ff', text: '待启用' }
                  : { color: '#faad14', text: '待批准' }
              : undefined
            const canInstall = !badge && installableMarketSource(registry.source)
            return (
              <MarketItemCard
                key={listing.name}
                title={listing.name}
                version={listing.version}
                meta={[listing.publisher, listing.description].filter(Boolean).join(' · ')}
                onDetail={() => setDetail(listing)}
                action={
                  badge ? (
                    <StatusDot color={badge.color} text={badge.text} />
                  ) : (
                    <Button
                      size="small"
                      type="primary"
                      disabled={!canInstall}
                      loading={busy === listing.name}
                      title={
                        canInstall ? undefined : '等待签名信任根（§19a）；loopback http 本地源可装'
                      }
                      onClick={() => void installListing(listing.name)}
                    >
                      安装
                    </Button>
                  )
                }
              />
            )
          })}
        </Grid>
      )}
      <Modal
        open={Boolean(detail)}
        onCancel={() => setDetail(undefined)}
        centered
        title={detail ? `${detail.name} v${detail.version}` : undefined}
        width={640}
        footer={null}
      >
        {detail && (
          <>
            <Descriptions size="small" column={1} bordered>
              <Descriptions.Item label="版本">{detail.version}</Descriptions.Item>
              <Descriptions.Item label="发布者">{detail.publisher ?? '—'}</Descriptions.Item>
              <Descriptions.Item label="描述">{detail.description ?? '—'}</Descriptions.Item>
              <Descriptions.Item label="索引源">
                <Typography.Text copyable code style={{ fontSize: 12 }}>
                  {registry && 'source' in registry ? registry.source : ''}
                </Typography.Text>
              </Descriptions.Item>
              <Descriptions.Item label="安装资格">
                {registry && 'source' in registry && installableMarketSource(registry.source)
                  ? '本地源，可安装'
                  : '远程 HTTPS 安装需签名信任根（§19a）'}
              </Descriptions.Item>
            </Descriptions>
            <Typography.Paragraph type="secondary" style={{ marginTop: 16, fontSize: 12 }}>
              安装由宿主逐文件下载并做 sha256 完整性校验，落盘 ~/.volund/plugins/ 后等待权限批准。
            </Typography.Paragraph>
            {installed?.some((entry) => entry.name === detail.name) ? (
              <Typography.Text type="secondary">
                已安装（在 Plugins 页签管理生命周期）
              </Typography.Text>
            ) : (
              <Button
                type="primary"
                block
                disabled={
                  !(registry && 'source' in registry && installableMarketSource(registry.source))
                }
                loading={busy === detail.name}
                onClick={() => void installListing(detail.name)}
              >
                安装 v{detail.version}
              </Button>
            )}
          </>
        )}
      </Modal>
    </div>
  )
}

// ── Skills 段：`[skills] market` 目录（git 安装通道）───────────────────

type SkillMarketEntry = {
  name: string
  description?: string
  version?: string
  source: string
  homepage?: string
}

function SkillsMarket({ api }: { api: WebApi }) {
  const { notice, setNotice, run } = useAction(api, 'skills')
  const [view, setView] = useState<{
    entries: SkillMarketEntry[]
    isDefault: boolean
    source: string
  }>()
  const [installedNames, setInstalledNames] = useState<string[]>()
  const [busy, setBusy] = useState<string>()
  const [scope, setScope] = useState<'user' | 'project'>('user')
  const [filter, setFilter] = useState('')
  const [detail, setDetail] = useState<SkillMarketEntry>()
  const [loading, setLoading] = useState(true)
  const load = useCallback(async () => {
    setLoading(true)
    try {
      await run({ action: 'marketList' }, (value) => {
        const result = value as
          | { entries?: SkillMarketEntry[]; error?: string; isDefault?: boolean; source?: string }
          | undefined
        if (!result) setNotice('未配置 [skills] market')
        else if ('error' in result) setNotice(result.error ?? '索引拉取失败')
        else
          setView({
            entries: result.entries ?? [],
            isDefault: result.isDefault ?? false,
            source: result.source ?? '',
          })
      })
      await run({ action: 'list' }, (value) => {
        setInstalledNames(
          ((value as { items: { name: string }[] }).items ?? []).map((item) => item.name),
        )
      })
    } finally {
      setLoading(false)
    }
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
  const entries = (view?.entries ?? []).filter((entry) =>
    filter.trim()
      ? `${entry.name} ${entry.description ?? ''} ${entry.source}`
          .toLowerCase()
          .includes(filter.trim().toLowerCase())
      : true,
  )
  return (
    <div>
      <PanelToolbar>
        <Space wrap>
          <Segmented
            value={scope}
            onChange={(next) => setScope(next as 'user' | 'project')}
            options={[
              { value: 'user', label: '装到用户级' },
              { value: 'project', label: '装到项目级' },
            ]}
          />
          <Input.Search
            allowClear
            placeholder="过滤 skill…"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            style={{ width: 220 }}
          />
        </Space>
        <Space>
          {view?.isDefault && <Tag color="blue">默认源 · anthropics/skills</Tag>}
          <RefreshButton loading={loading} onClick={() => void load()} />
        </Space>
      </PanelToolbar>
      <Notice message={notice} />
      {loading && !view && <LoadingBlock text="正在拉取 skills 市场索引…" />}
      {!loading && view && entries.length === 0 && (
        <Empty description={filter ? '没有匹配的条目' : '目录为空'} />
      )}
      <Grid>
        {entries.map((entry) => {
          const isInstalled = installedNames?.includes(entry.name)
          return (
            <MarketItemCard
              key={entry.name}
              title={`/${entry.name}`}
              {...(entry.version !== undefined ? { version: entry.version } : {})}
              {...(entry.source || entry.description
                ? { meta: [entry.source, entry.description].filter(Boolean).join(' · ') }
                : {})}
              onDetail={() => setDetail(entry)}
              action={
                isInstalled ? (
                  <StatusDot color="#52c41a" text="已装" />
                ) : (
                  <Button
                    size="small"
                    type="primary"
                    loading={busy === entry.name}
                    onClick={() => void installSkill(entry)}
                  >
                    安装
                  </Button>
                )
              }
            />
          )
        })}
      </Grid>
      <Modal
        open={Boolean(detail)}
        onCancel={() => setDetail(undefined)}
        centered
        title={detail ? `/${detail.name}${detail.version ? ` v${detail.version}` : ''}` : undefined}
        width={640}
        footer={null}
      >
        {detail && (
          <>
            <Descriptions size="small" column={1} bordered>
              <Descriptions.Item label="版本">{detail.version ?? '—'}</Descriptions.Item>
              <Descriptions.Item label="描述">{detail.description ?? '—'}</Descriptions.Item>
              <Descriptions.Item label="安装源">
                <Typography.Text copyable code style={{ fontSize: 12 }}>
                  {detail.source}
                </Typography.Text>
              </Descriptions.Item>
              <Descriptions.Item label="主页">
                {detail.homepage ? (
                  <Typography.Link href={detail.homepage} target="_blank">
                    {detail.homepage}
                  </Typography.Link>
                ) : (
                  '—'
                )}
              </Descriptions.Item>
            </Descriptions>
            <Typography.Paragraph type="secondary" style={{ marginTop: 16, fontSize: 12 }}>
              安装走 git 通道（skill 不执行代码，远程源可装），当前装到
              {scope === 'user' ? '用户级' : '项目级'}目录。
            </Typography.Paragraph>
            {installedNames?.includes(detail.name) ? (
              <Typography.Text type="secondary">已安装</Typography.Text>
            ) : (
              <Button
                type="primary"
                block
                loading={busy === detail.name}
                onClick={() => void installSkill(detail)}
              >
                安装到{scope === 'user' ? '用户级' : '项目级'}
              </Button>
            )}
          </>
        )}
      </Modal>
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
  homepage?: string
}

function McpMarket({ api }: { api: WebApi }) {
  const { notice, setNotice, run } = useAction(api, 'mcp')
  const [view, setView] = useState<{ entries: McpMarketEntry[]; isDefault: boolean }>()
  const [configured, setConfigured] = useState<string[]>()
  const [prefill, setPrefill] = useState<McpMarketEntry>()
  const [detail, setDetail] = useState<McpMarketEntry>()
  const [filter, setFilter] = useState('')
  const [loading, setLoading] = useState(true)
  const load = useCallback(async () => {
    setLoading(true)
    try {
      await run({ action: 'marketList' }, (value) => {
        const result = value as
          | { entries?: McpMarketEntry[]; error?: string; isDefault?: boolean }
          | undefined
        if (!result) setNotice('未配置 [mcp] market')
        else if ('error' in result) setNotice(result.error ?? '索引拉取失败')
        else
          setView({
            entries: result.entries ?? [],
            isDefault: result.isDefault ?? false,
          })
      })
      await run({ action: 'list' }, (value) => {
        setConfigured(
          ((value as { items: { name: string }[] }).items ?? []).map((item) => item.name),
        )
      })
    } finally {
      setLoading(false)
    }
  }, [run])
  useEffect(() => {
    void load()
  }, [load])
  const entries = (view?.entries ?? []).filter((entry) =>
    filter.trim()
      ? `${entry.name} ${entry.description ?? ''}`
          .toLowerCase()
          .includes(filter.trim().toLowerCase())
      : true,
  )
  return (
    <div>
      <PanelToolbar>
        <Space wrap>
          <Input.Search
            allowClear
            placeholder="搜索 MCP server（如 github、filesystem）…"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            style={{ width: 300 }}
          />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            目录条目只预填表单——command/env 全文可见，确认后才写入 mcp.toml
          </Typography.Text>
        </Space>
        <Space>
          {view?.isDefault && <Tag color="blue">默认源 · 官方 MCP Registry</Tag>}
          <RefreshButton loading={loading} onClick={() => void load()} />
        </Space>
      </PanelToolbar>
      <Notice message={notice} />
      {loading && !view && <LoadingBlock text="正在拉取官方 MCP Registry…" />}
      {!loading && view && entries.length === 0 && (
        <Empty description={filter ? '没有匹配的 server' : '目录为空'} />
      )}
      <Grid>
        {entries.map((entry) => {
          const isConfigured = configured?.includes(entry.name)
          return (
            <MarketItemCard
              key={entry.name}
              title={entry.name}
              {...(entry.transport === 'stdio'
                ? { meta: [entry.command, (entry.args ?? []).join(' ')].filter(Boolean).join(' ') }
                : entry.url !== undefined
                  ? { meta: entry.url }
                  : {})}
              onDetail={() => setDetail(entry)}
              action={
                isConfigured ? (
                  <StatusDot color="#52c41a" text="已配置" />
                ) : (
                  <Button size="small" onClick={() => setPrefill(entry)}>
                    预填安装…
                  </Button>
                )
              }
            />
          )
        })}
      </Grid>
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
      <Modal
        open={Boolean(detail)}
        onCancel={() => setDetail(undefined)}
        centered
        title={detail?.name}
        width={640}
        footer={null}
      >
        {detail && (
          <>
            <Descriptions size="small" column={1} bordered>
              <Descriptions.Item label="描述">{detail.description ?? '—'}</Descriptions.Item>
              <Descriptions.Item label="传输">
                <Tag>{detail.transport}</Tag>
              </Descriptions.Item>
              {detail.url && (
                <Descriptions.Item label="URL">
                  <Typography.Text copyable code style={{ fontSize: 12 }}>
                    {detail.url}
                  </Typography.Text>
                </Descriptions.Item>
              )}
              {detail.command && (
                <Descriptions.Item label="启动命令">
                  <Typography.Text code>
                    {detail.command} {(detail.args ?? []).join(' ')}
                  </Typography.Text>
                </Descriptions.Item>
              )}
              {detail.env && Object.keys(detail.env).length > 0 && (
                <Descriptions.Item label="env">
                  <Typography.Text code style={{ fontSize: 12 }}>
                    {JSON.stringify(detail.env)}
                  </Typography.Text>
                </Descriptions.Item>
              )}
              {detail.headers && Object.keys(detail.headers).length > 0 && (
                <Descriptions.Item label="headers">
                  <Typography.Text code style={{ fontSize: 12 }}>
                    {JSON.stringify(detail.headers)}
                  </Typography.Text>
                </Descriptions.Item>
              )}
              {detail.homepage && (
                <Descriptions.Item label="主页">
                  <Typography.Link href={detail.homepage} target="_blank">
                    {detail.homepage}
                  </Typography.Link>
                </Descriptions.Item>
              )}
            </Descriptions>
            <Typography.Paragraph type="secondary" style={{ marginTop: 16, fontSize: 12 }}>
              「安装」只预填表单——command/env 全文可见，确认后才写入 mcp.toml。
            </Typography.Paragraph>
            <Button
              block
              onClick={() => {
                setPrefill(detail)
                setDetail(undefined)
              }}
            >
              预填安装…
            </Button>
          </>
        )}
      </Modal>
    </div>
  )
}
