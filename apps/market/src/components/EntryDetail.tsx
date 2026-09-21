'use client'

import { ArrowLeftOutlined } from '@ant-design/icons'
import { Button, Card, Descriptions, Empty, Spin, Table, Typography } from 'antd'
import { useParams, useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'

import { useI18n } from './Providers'

type Kind = 'plugins' | 'skills' | 'mcp'

const KIND_LABEL: Record<Kind, string> = {
  plugins: 'plugin',
  skills: 'skill',
  mcp: 'mcp server',
}

interface FileSpec {
  path: string
  digest: string
}
interface PluginDetail {
  name: string
  description?: string
  publisher?: string
  downloads: number
  updatedAt: string
  versions: readonly {
    version: string
    publishedAt: string
    manifest: Record<string, unknown>
    files: readonly FileSpec[]
    readme?: string
  }[]
}
interface SkillDetail {
  name: string
  description?: string
  version?: string
  source: string
  homepage?: string
  addedAt: string
}
interface McpDetail {
  name: string
  description?: string
  version?: string
  transport: 'stdio' | 'http'
  url?: string
  headers?: Record<string, string>
  command?: string
  args?: readonly string[]
  env?: Record<string, string>
  homepage?: string
  addedAt: string
}

const MARKET_PATH: Record<Kind, string> = {
  plugins: '/api/plugins/index.json',
  skills: '/api/skills/index.json',
  mcp: '/api/mcp/index.json',
}
const CONFIG_SECTION: Record<Kind, string> = { plugins: 'plugins', skills: 'skills', mcp: 'mcp' }

export default function EntryDetail() {
  const params = useParams<{ kind: string; name: string }>()
  const router = useRouter()
  const { t } = useI18n()
  const kind = (['plugins', 'skills', 'mcp'] as const).includes(params.kind as Kind)
    ? (params.kind as Kind)
    : 'plugins'
  const name = params.name
  const [detail, setDetail] = useState<PluginDetail | SkillDetail | McpDetail | undefined>()
  const [missing, setMissing] = useState(false)

  useEffect(() => {
    const run = async () => {
      const response = await fetch(`/api/v1/${kind}/${name}`)
      if (!response.ok) {
        setMissing(true)
        return
      }
      setDetail((await response.json()) as PluginDetail | SkillDetail | McpDetail)
    }
    void run()
  }, [kind, name])

  if (missing)
    return (
      <Empty description={t['common.notFound']}>
        <Button onClick={() => router.push('/')}>{t['common.back']}</Button>
      </Empty>
    )
  if (!detail)
    return (
      <div className="mk-loading">
        <Spin />
      </div>
    )

  const origin = typeof window === 'undefined' ? 'http://127.0.0.1:4315' : window.location.origin
  const installHint = `# ~/.volund/config.toml\n[${CONFIG_SECTION[kind]}]\nmarket = "${origin}${MARKET_PATH[kind]}"`

  return (
    <div>
      <Button
        className="mk-back"
        icon={<ArrowLeftOutlined />}
        type="text"
        onClick={() => router.push('/')}
      >
        {t['common.back']}
      </Button>
      <p className="mk-eyebrow" style={{ marginTop: 10 }}>
        <span className="mk-dot" />
        {KIND_LABEL[kind]} entry
      </p>
      <h1 className="mk-display">{name}</h1>

      {kind === 'plugins' ? (
        <PluginSections detail={detail as PluginDetail} installHint={installHint} />
      ) : undefined}
      {kind === 'skills' ? (
        <SkillSections detail={detail as SkillDetail} installHint={installHint} />
      ) : undefined}
      {kind === 'mcp' ? (
        <McpSections detail={detail as McpDetail} installHint={installHint} />
      ) : undefined}
    </div>
  )
}

function InstallHint({ hint }: { hint: string }) {
  const { t } = useI18n()
  return (
    <Card size="small" className="mk-panel" title={t['detail.clientSetup']} style={{ marginTop: 24 }}>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
        {t['detail.clientSetupHint']}
      </Typography.Paragraph>
      <pre className="mk-codeblock">{hint}</pre>
    </Card>
  )
}

function PluginSections({ detail, installHint }: { detail: PluginDetail; installHint: string }) {
  const { t } = useI18n()
  const latest = detail.versions.at(-1)
  return (
    <>
      <Descriptions size="small" column={2} bordered style={{ marginTop: 20 }}>
        <Descriptions.Item label={t['detail.latest']}>{latest?.version ?? '—'}</Descriptions.Item>
        <Descriptions.Item label={t['detail.publisher']}>{detail.publisher ?? '—'}</Descriptions.Item>
        <Descriptions.Item label={t['detail.downloads']}>{detail.downloads}</Descriptions.Item>
        <Descriptions.Item label={t['detail.updated']}>
          {detail.updatedAt.slice(0, 19).replace('T', ' ')}
        </Descriptions.Item>
      </Descriptions>
      {latest ? (
        <>
          <Card size="small" className="mk-panel" title={t['detail.filesTitle']} style={{ marginTop: 24 }}>
            <Table
              size="small"
              rowKey="path"
              pagination={false}
              dataSource={latest.files.map((file) => ({ ...file }))}
              columns={[
                {
                  title: t['admin.table.path'],
                  dataIndex: 'path',
                  render: (value: string) => (
                    <Typography.Text code>{value}</Typography.Text>
                  ),
                },
                {
                  title: 'digest',
                  dataIndex: 'digest',
                  render: (value: string) => (
                    <Typography.Text copyable style={{ fontSize: 12 }}>
                      {value}
                    </Typography.Text>
                  ),
                },
              ]}
            />
          </Card>
          <Card
            size="small"
            className="mk-panel"
            title={`${t['detail.versionsTitle']} · ${detail.versions.length}`}
            style={{ marginTop: 24 }}
          >
            <Table
              size="small"
              rowKey="version"
              pagination={false}
              dataSource={detail.versions.map((version) => ({ ...version }))}
              columns={[
                {
                  title: t['detail.version'],
                  dataIndex: 'version',
                  render: (value: string) => <span className="mk-chip">v{value}</span>,
                },
                {
                  title: t['detail.publishedAt'],
                  dataIndex: 'publishedAt',
                  render: (value: string) => value.slice(0, 19).replace('T', ' '),
                },
                {
                  title: t['detail.fileCount'],
                  dataIndex: 'files',
                  render: (value: readonly FileSpec[]) => value.length,
                },
              ]}
            />
          </Card>
          {latest.readme ? (
            <Card size="small" className="mk-panel" title="README" style={{ marginTop: 24 }}>
              <pre className="mk-codeblock">{latest.readme}</pre>
            </Card>
          ) : undefined}
        </>
      ) : undefined}
      <InstallHint hint={installHint} />
    </>
  )
}

function SkillSections({ detail, installHint }: { detail: SkillDetail; installHint: string }) {
  const { t } = useI18n()
  return (
    <>
      <Descriptions size="small" column={1} bordered style={{ marginTop: 20 }}>
        <Descriptions.Item label={t['detail.version']}>
          {detail.version ? <span className="mk-chip">{detail.version}</span> : '—'}
        </Descriptions.Item>
        <Descriptions.Item label={t['detail.desc']}>{detail.description ?? '—'}</Descriptions.Item>
        <Descriptions.Item label={t['detail.source']}>
          <Typography.Text copyable code>
            {detail.source}
          </Typography.Text>
        </Descriptions.Item>
        <Descriptions.Item label={t['detail.homepage']}>
          {detail.homepage ? (
            <Typography.Link href={detail.homepage} target="_blank">
              {detail.homepage}
            </Typography.Link>
          ) : (
            '—'
          )}
        </Descriptions.Item>
        <Descriptions.Item label={t['detail.added']}>
          {detail.addedAt.slice(0, 19).replace('T', ' ')}
        </Descriptions.Item>
      </Descriptions>
      <InstallHint hint={installHint} />
    </>
  )
}

function McpSections({ detail, installHint }: { detail: McpDetail; installHint: string }) {
  const { t } = useI18n()
  return (
    <>
      <Descriptions size="small" column={1} bordered style={{ marginTop: 20 }}>
        <Descriptions.Item label={t['detail.version']}>
          {detail.version ? <span className="mk-chip">{detail.version}</span> : '—'}
        </Descriptions.Item>
        <Descriptions.Item label={t['detail.desc']}>{detail.description ?? '—'}</Descriptions.Item>
        <Descriptions.Item label={t['detail.transport']}>
          <span className="mk-chip neutral">{detail.transport}</span>
        </Descriptions.Item>
        {detail.url ? (
          <Descriptions.Item label="URL">
            <Typography.Text copyable code>
              {detail.url}
            </Typography.Text>
          </Descriptions.Item>
        ) : undefined}
        {detail.command ? (
          <Descriptions.Item label={t['detail.command']}>
            <Typography.Text code>
              {detail.command} {(detail.args ?? []).join(' ')}
            </Typography.Text>
          </Descriptions.Item>
        ) : undefined}
        {detail.env ? (
          <Descriptions.Item label="env">
            <Typography.Text code>{JSON.stringify(detail.env)}</Typography.Text>
          </Descriptions.Item>
        ) : undefined}
        <Descriptions.Item label={t['detail.homepage']}>
          {detail.homepage ? (
            <Typography.Link href={detail.homepage} target="_blank">
              {detail.homepage}
            </Typography.Link>
          ) : (
            '—'
          )}
        </Descriptions.Item>
        <Descriptions.Item label={t['detail.added']}>
          {detail.addedAt.slice(0, 19).replace('T', ' ')}
        </Descriptions.Item>
      </Descriptions>
      <InstallHint hint={installHint} />
    </>
  )
}
