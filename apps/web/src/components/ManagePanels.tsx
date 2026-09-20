'use client'

/**
 * 管理页四域面板（WEB-EXT-MANAGE-MARKET-r1 §S3.2–§S3.5）：
 * Memory（markdown 编辑/导入导出）/ Skills（安装/卸载/详情/热重扫）/ MCP
 * （add/remove/域级 reload/inspect）/ Plugins（三源 inventory + approve 权限清单）。
 * 全部走 tagged-union actions，零直连文件系统。
 */
import { PlusOutlined, ReloadOutlined } from '@ant-design/icons'
import {
  Button,
  Empty,
  Form,
  Input,
  Modal,
  Popconfirm,
  Segmented,
  Select,
  Space,
  Switch,
  Table,
  Tabs,
  Tag,
  Typography,
} from 'antd'
import { useCallback, useEffect, useMemo, useState } from 'react'

import type { WebApi } from '../lib/api'
import {
  CountBadge,
  ItemCard,
  KeyValueEditor,
  Notice,
  PanelIntro,
  PanelToolbar,
  StatusDot,
  downloadJson,
  formatTime,
  marketErrorMessage,
  useAction,
  useInventory,
} from './manage-shared'
import { Markdown } from './Markdown'
import { MarkdownMemoEditor } from './MarkdownMemoEditor'

// ── Memory（§S3.2）────────────────────────────────────────────────────

type MemoryRecord = {
  id: string
  content: string
  tags: readonly string[]
  pinned: boolean
  source: string
  actor?: string
  updatedAt: string
}

type MemoryEditorState = {
  record?: MemoryRecord
  content: string
  tags: string[]
  pinned: boolean
}

function MemoryPanel({ api }: { api: WebApi }) {
  const { data, error, reload } = useInventory<{
    scopeLabel: string
    searchAvailable: boolean
    items: { items: MemoryRecord[] }
  }>(api, 'memory')
  const { notice, setNotice, run } = useAction(api, 'memory')
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<MemoryRecord[]>()
  const [editor, setEditor] = useState<MemoryEditorState>()
  const [saving, setSaving] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [importText, setImportText] = useState('')
  const [importStrategy, setImportStrategy] = useState<'skip' | 'overwrite' | 'rename'>('skip')
  const [importReport, setImportReport] = useState<string>()

  const items = results ?? data?.items?.items ?? []
  const search = useCallback(async () => {
    const result = await run({ action: 'search', query }, (value) => {
      setResults((value as { items: MemoryRecord[] }).items)
    })
    if (result === undefined) setNotice('搜索失败')
  }, [query, run])

  const saveEditor = useCallback(async () => {
    if (!editor) return
    setSaving(true)
    setNotice(undefined)
    try {
      if (editor.record) {
        await api.managementAction('memory', {
          action: 'update',
          id: editor.record.id,
          content: editor.content,
          tags: editor.tags,
          expectedUpdatedAt: editor.record.updatedAt,
        })
      } else {
        await api.managementAction('memory', {
          action: 'create',
          content: editor.content,
          tags: editor.tags,
          pinned: editor.pinned,
        })
      }
      setEditor(undefined)
      reload()
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      if (message.includes('memory_conflict') || message.includes('changed concurrently')) {
        setEditor(undefined)
        reload()
        setNotice('内容已被他端修改，已刷新列表，请重新打开编辑。')
      } else {
        setNotice(message)
      }
    } finally {
      setSaving(false)
    }
  }, [api, editor, reload])

  const exportAll = useCallback(async () => {
    const doc = await run({ action: 'export' }, undefined)
    if (doc) downloadJson(`volund-memory-export-${new Date().toISOString().slice(0, 10)}.json`, doc)
  }, [run])

  const doImport = useCallback(
    async (dryRun: boolean) => {
      await run(
        { action: 'import', serialized: importText, strategy: importStrategy, dryRun },
        (value) => {
          const report = value as { applied: number; total: number; dryRun: boolean }
          setImportReport(
            `${report.dryRun ? '预览' : '导入'}：${report.applied}/${report.total} 条适用${report.dryRun ? '（未落盘）' : ''}`,
          )
          if (!report.dryRun) reload()
        },
      )
    },
    [importStrategy, importText, reload, run],
  )

  if (error) return <Notice message={error} />
  return (
    <div>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-end',
          flexWrap: 'wrap',
          gap: 8,
        }}
      >
        <PanelIntro
          title="Memory 记忆库"
          description="本项目的长期记忆：agent 会话内自动召回；新建/编辑即时生效，换项目互不可见。"
        />
        <CountBadge scopeLabel={data?.scopeLabel ?? '…'} count={items.length} />
      </div>
      <PanelToolbar>
        <Space wrap>
          <Input.Search
            placeholder={data?.searchAvailable ? '搜索 Memory…' : '搜索不可用（recall 未装配）'}
            value={query}
            disabled={!data?.searchAvailable}
            allowClear
            onChange={(event) => setQuery(event.target.value)}
            onSearch={() => void search()}
            style={{ width: 300 }}
          />
          {results && (
            <Button size="small" onClick={() => setResults(undefined)}>
              清除搜索
            </Button>
          )}
        </Space>
        <Space wrap>
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => setEditor({ content: '', tags: [], pinned: false })}
          >
            新建
          </Button>
          <Button onClick={() => setImportOpen(true)}>导入</Button>
          <Button onClick={() => void exportAll()}>导出</Button>
        </Space>
      </PanelToolbar>
      <Notice message={notice} />
      <div style={{ display: 'grid', gap: 8 }}>
        {items.length === 0 && (
          <div style={{ padding: '36px 0' }}>
            <Empty description={query ? '没有匹配的记忆' : '还没有记忆——点「新建」写第一条'}>
              {!query && (
                <Button
                  type="primary"
                  onClick={() => setEditor({ content: '', tags: [], pinned: false })}
                >
                  新建记忆
                </Button>
              )}
            </Empty>
          </div>
        )}
        {items.map((record) => (
          <ItemCard key={record.id}>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'flex-start',
                gap: 12,
              }}
            >
              <div style={{ minWidth: 0, flex: 1 }}>
                <Typography.Paragraph
                  style={{ marginBottom: 6, whiteSpace: 'pre-wrap' }}
                  ellipsis={{ rows: 3 }}
                >
                  {record.pinned && '📌 '}
                  {record.content.slice(0, 240) || '（空）'}
                </Typography.Paragraph>
                <Space size={6} wrap>
                  {record.tags.map((tag) => (
                    <Tag key={tag} style={{ marginInlineEnd: 0 }}>
                      {tag}
                    </Tag>
                  ))}
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {record.id.slice(0, 8)} · {formatTime(record.updatedAt)}
                  </Typography.Text>
                </Space>
              </div>
              <Space size={0} style={{ flexShrink: 0 }}>
                <Button
                  type="text"
                  size="small"
                  onClick={() =>
                    setEditor({
                      record,
                      content: record.content,
                      tags: [...record.tags],
                      pinned: record.pinned,
                    })
                  }
                >
                  编辑
                </Button>
                <Button
                  type="text"
                  size="small"
                  onClick={() =>
                    void run(
                      {
                        action: record.pinned ? 'unpin' : 'pin',
                        id: record.id,
                        expectedUpdatedAt: record.updatedAt,
                      },
                      reload,
                    )
                  }
                >
                  {record.pinned ? '取消置顶' : '置顶'}
                </Button>
                <Popconfirm
                  title="删除这条记忆？"
                  onConfirm={() =>
                    void run(
                      { action: 'delete', id: record.id, expectedUpdatedAt: record.updatedAt },
                      reload,
                    )
                  }
                >
                  <Button type="text" size="small" danger>
                    删除
                  </Button>
                </Popconfirm>
              </Space>
            </div>
          </ItemCard>
        ))}
      </div>
      <Modal
        title={editor?.record ? '编辑记忆' : '新建记忆'}
        open={editor !== undefined}
        onCancel={() => setEditor(undefined)}
        width={860}
        okText="保存"
        okButtonProps={{ loading: saving }}
        onOk={() => void saveEditor()}
      >
        {editor && (
          <div style={{ display: 'grid', gap: 12 }}>
            <MarkdownMemoEditor
              value={editor.content}
              onChange={(content) => setEditor({ ...editor, content })}
            />
            <Space wrap>
              <Select
                mode="tags"
                tokenSeparators={[',']}
                placeholder="标签（回车添加）"
                style={{ minWidth: 320 }}
                value={editor.tags}
                onChange={(tags) => setEditor({ ...editor, tags })}
                options={[]}
              />
              <Space>
                <Switch
                  checked={editor.pinned}
                  onChange={(pinned) => setEditor({ ...editor, pinned })}
                />
                <Typography.Text>置顶</Typography.Text>
              </Space>
            </Space>
          </div>
        )}
      </Modal>
      <Modal
        title="导入记忆"
        open={importOpen}
        onCancel={() => {
          setImportOpen(false)
          setImportReport(undefined)
        }}
        footer={null}
        width={640}
      >
        <div style={{ display: 'grid', gap: 12 }}>
          <Input.TextArea
            rows={8}
            placeholder="粘贴 volund.memory.export.v1 JSON，或选择文件…"
            value={importText}
            onChange={(event) => setImportText(event.target.value)}
            style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12 }}
          />
          <input
            type="file"
            accept="application/json,.json"
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) void file.text().then(setImportText)
            }}
          />
          <Space wrap>
            <Select
              style={{ width: 160 }}
              value={importStrategy}
              onChange={setImportStrategy}
              options={[
                { value: 'skip', label: '冲突跳过' },
                { value: 'overwrite', label: '冲突覆盖' },
                { value: 'rename', label: '冲突重命名' },
              ]}
            />
            <Button disabled={!importText.trim()} onClick={() => void doImport(true)}>
              预览（不落盘）
            </Button>
            <Button
              type="primary"
              disabled={!importText.trim()}
              onClick={() => void doImport(false)}
            >
              导入
            </Button>
            {importReport && <Typography.Text type="secondary">{importReport}</Typography.Text>}
          </Space>
        </div>
      </Modal>
    </div>
  )
}

// ── Skills（§S3.4）───────────────────────────────────────────────────

type SkillItem = {
  name: string
  description: string
  scope: string
  status: string
  version?: string
  path?: string
}

/** SKILL.md 拆 frontmatter + 正文（正文走 Markdown 渲染）。 */
function splitFrontmatter(raw: string): { frontmatter: string; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw)
  if (!match) return { frontmatter: '', body: raw }
  return { frontmatter: match[1] ?? '', body: match[2] ?? '' }
}

function SkillsPanel({ api }: { api: WebApi }) {
  const { data, error, reload } = useInventory<{ items: SkillItem[] }>(api, 'skill')
  const { notice, setNotice, run } = useAction(api, 'skill')
  const [spec, setSpec] = useState('')
  const [scope, setScope] = useState<'user' | 'project'>('user')
  const [detail, setDetail] = useState<{ name: string; raw: string }>()
  const install = useCallback(async () => {
    const result = await run({ action: 'install', spec, scope }, (value) => {
      const { items } = value as { items: SkillItem[] }
      setNotice(
        `已安装 ${items.length} 个 skill：${items.map((item) => item.name).join(', ') || '无（部分失败见服务日志）'}`,
      )
      setSpec('')
      reload()
    })
    if (result === undefined) setNotice((current) => current ?? '安装失败')
  }, [reload, run, scope, spec])

  if (error) return <Notice message={error} />
  const skills = data?.items ?? []
  return (
    <div>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-end',
          flexWrap: 'wrap',
          gap: 8,
        }}
      >
        <PanelIntro
          title="Skills 技能"
          description="目录 + SKILL.md 的渐进披露技能：安装后自动热重扫，会话内 /斜杠命令或模型自动触发。"
        />
        <CountBadge scopeLabel="skills" count={skills.length} unit="个" />
      </div>
      <PanelToolbar>
        <Space wrap>
          <Input
            style={{ width: 360 }}
            placeholder="安装来源：本地目录 | git URL | github:owner/repo"
            value={spec}
            onChange={(event) => setSpec(event.target.value)}
          />
          <Segmented
            value={scope}
            onChange={(next) => setScope(next as 'user' | 'project')}
            options={[
              { value: 'user', label: '用户级' },
              { value: 'project', label: '项目级' },
            ]}
          />
          <Button type="primary" disabled={!spec.trim()} onClick={() => void install()}>
            安装
          </Button>
        </Space>
        <Button icon={<ReloadOutlined />} onClick={() => void run({ action: 'reload' }, reload)}>
          重扫描
        </Button>
      </PanelToolbar>
      <Notice message={notice} />
      <div style={{ display: 'grid', gap: 8 }}>
        {skills.length === 0 && (
          <div style={{ padding: '36px 0' }}>
            <Empty description="没有已发现的 skill——从上方输入来源安装，或放入 ~/.volund/skills/" />
          </div>
        )}
        {skills.map((skill) => (
          <ItemCard key={`${skill.name}:${skill.scope}`}>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'flex-start',
                gap: 12,
              }}
            >
              <div style={{ minWidth: 0, flex: 1 }}>
                <Space size={6} wrap style={{ marginBottom: 2 }}>
                  <Typography.Text strong>/{skill.name}</Typography.Text>
                  <Tag
                    color={
                      skill.scope === 'user' ? 'blue' : skill.scope === 'plugin' ? 'purple' : 'cyan'
                    }
                  >
                    {skill.scope === 'user'
                      ? '用户级'
                      : skill.scope === 'plugin'
                        ? '插件'
                        : '项目级'}
                  </Tag>
                  {skill.status === 'disabled' && <Tag color="warning">已禁用</Tag>}
                  {skill.status === 'broken' && <Tag color="error">损坏</Tag>}
                  {skill.status === 'shadowed' && <Tag color="default">被覆盖</Tag>}
                  {skill.version && <Tag color="default">v{skill.version}</Tag>}
                </Space>
                <Typography.Paragraph
                  type="secondary"
                  style={{ marginBottom: 0 }}
                  ellipsis={{ rows: 2 }}
                >
                  {skill.description}
                </Typography.Paragraph>
              </div>
              <Space size={0} style={{ flexShrink: 0 }}>
                <Button
                  type="text"
                  size="small"
                  onClick={() =>
                    void run({ action: 'show', name: skill.name }, (value) => {
                      setDetail({ name: skill.name, raw: (value as { body: string }).body })
                    })
                  }
                >
                  详情
                </Button>
                <Button
                  type="text"
                  size="small"
                  onClick={() =>
                    void run(
                      {
                        action: 'setEnabled',
                        name: skill.name,
                        enabled: skill.status === 'disabled',
                      },
                      reload,
                    )
                  }
                >
                  {skill.status === 'disabled' ? '启用' : '禁用'}
                </Button>
                {(skill.scope === 'user' || skill.scope === 'project') && (
                  <Popconfirm
                    title={`卸载 ${skill.name}？`}
                    onConfirm={() =>
                      void run(
                        { action: 'uninstall', name: skill.name, scope: skill.scope },
                        reload,
                      )
                    }
                  >
                    <Button type="text" size="small" danger>
                      卸载
                    </Button>
                  </Popconfirm>
                )}
              </Space>
            </div>
          </ItemCard>
        ))}
      </div>
      <Modal
        title={`/${detail?.name ?? ''} · SKILL.md`}
        open={detail !== undefined}
        onCancel={() => setDetail(undefined)}
        footer={null}
        width={760}
      >
        {detail && <SkillDetail raw={detail.raw} />}
      </Modal>
    </div>
  )
}

function SkillDetail({ raw }: { raw: string }) {
  const { frontmatter, body } = useMemo(() => splitFrontmatter(raw), [raw])
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {frontmatter && (
        <pre
          style={{
            background: 'var(--ant-color-fill-tertiary, #f5f5f5)',
            borderRadius: 8,
            padding: 12,
            fontSize: 12,
            overflow: 'auto',
          }}
        >
          {frontmatter}
        </pre>
      )}
      <Markdown text={body} />
    </div>
  )
}

// ── MCP（§S3.3）──────────────────────────────────────────────────────

type McpEntry = {
  name: string
  transport: string
  scope?: string
  status?: string
  tools?: number
  detail?: string
}

type McpFormState = {
  name: string
  scope: 'user' | 'project'
  kind: 'stdio' | 'http' | 'sse' | 'streamable-http'
  command: string
  args: string[]
  env: Record<string, string>
  url: string
  headers: Record<string, string>
}

const emptyMcpForm = (): McpFormState => ({
  name: '',
  scope: 'user',
  kind: 'stdio',
  command: '',
  args: [],
  env: {},
  url: '',
  headers: {},
})

/** add / 编辑（同名 upsert）共用表单；market 预填走 initialValues。 */
export function McpServerFormModal({
  api,
  open,
  initial,
  onClose,
  onSaved,
}: {
  api: WebApi
  open: boolean
  initial?: Partial<McpFormState>
  onClose: () => void
  onSaved?: () => void
}) {
  const [form, setForm] = useState<McpFormState>({ ...emptyMcpForm(), ...initial })
  const [notice, setNotice] = useState<string>()
  const [saving, setSaving] = useState(false)
  const save = useCallback(async () => {
    setSaving(true)
    setNotice(undefined)
    try {
      await api.managementAction('mcp', {
        action: 'add',
        name: form.name,
        scope: form.scope,
        transport: form.kind,
        ...(form.kind === 'stdio'
          ? { command: form.command, args: form.args, env: form.env }
          : { url: form.url, headers: form.headers }),
      })
      onClose()
      onSaved?.()
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }, [api, form, onClose, onSaved])
  return (
    <Modal
      title={initial?.name ? `编辑 MCP server：${initial.name}` : '添加 MCP server'}
      open={open}
      onCancel={onClose}
      onOk={() => void save()}
      okText="保存并重载"
      okButtonProps={{
        loading: saving,
        disabled:
          !form.name.trim() || (form.kind === 'stdio' ? !form.command.trim() : !form.url.trim()),
      }}
      width={720}
    >
      <Notice message={notice} />
      <Form layout="vertical">
        <Space wrap>
          <Form.Item label="名称">
            <Input
              style={{ width: 200 }}
              value={form.name}
              disabled={Boolean(initial?.name)}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
              placeholder="my-server"
            />
          </Form.Item>
          <Form.Item label="作用域">
            <Segmented
              value={form.scope}
              onChange={(next) => setForm({ ...form, scope: next as 'user' | 'project' })}
              options={[
                { value: 'user', label: '用户级' },
                { value: 'project', label: '项目级' },
              ]}
            />
          </Form.Item>
          <Form.Item label="传输">
            <Select
              style={{ width: 180 }}
              value={form.kind}
              onChange={(kind) => setForm({ ...form, kind })}
              options={[
                { value: 'stdio', label: 'stdio（本地命令）' },
                { value: 'http', label: 'Streamable HTTP' },
                { value: 'sse', label: 'HTTP + SSE（旧）' },
                { value: 'streamable-http', label: 'Streamable HTTP（别名）' },
              ]}
            />
          </Form.Item>
        </Space>
        {form.kind === 'stdio' ? (
          <>
            <Form.Item label="命令">
              <Input
                value={form.command}
                onChange={(event) => setForm({ ...form, command: event.target.value })}
                placeholder="npx"
              />
            </Form.Item>
            <Form.Item label="参数">
              <Select
                mode="tags"
                tokenSeparators={[' ']}
                style={{ width: '100%' }}
                value={form.args}
                onChange={(args) => setForm({ ...form, args })}
                placeholder="-y @modelcontextprotocol/server-filesystem /path"
                open={false}
              />
            </Form.Item>
            <Form.Item label="环境变量">
              <KeyValueEditor value={form.env} onChange={(env) => setForm({ ...form, env })} />
            </Form.Item>
          </>
        ) : (
          <>
            <Form.Item label="URL">
              <Input
                value={form.url}
                onChange={(event) => setForm({ ...form, url: event.target.value })}
                placeholder="https://mcp.example.com/mcp"
              />
            </Form.Item>
            <Form.Item
              label={
                <>
                  请求头（secret 用 <code>keyref://mcp.&lt;name&gt;.&lt;field&gt;</code>{' '}
                  引用凭据存储）
                </>
              }
            >
              <KeyValueEditor
                value={form.headers}
                onChange={(headers) => setForm({ ...form, headers })}
                secretValues
              />
            </Form.Item>
          </>
        )}
      </Form>
    </Modal>
  )
}

function McpPanel({ api }: { api: WebApi }) {
  const { data, error, reload } = useInventory<{ items: McpEntry[] }>(api, 'mcp')
  const { notice, run } = useAction(api, 'mcp')
  const [formOpen, setFormOpen] = useState(false)
  const [editEntry, setEditEntry] = useState<McpEntry>()
  const [inspect, setInspect] = useState<{
    entry: McpEntry
    tools: { name: string; description?: string }[]
  }>()
  if (error) return <Notice message={error} />
  const entries = data?.items ?? []
  return (
    <div>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-end',
          flexWrap: 'wrap',
          gap: 8,
        }}
      >
        <PanelIntro
          title="MCP servers"
          description="外部工具服务器：定义落 mcp.toml / .mcp.json，重载后 `mcp__server__tool` 即时进运行会话。"
        />
        <CountBadge scopeLabel="mcp" count={entries.length} unit="个 server" />
      </div>
      <PanelToolbar>
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={() => {
            setEditEntry(undefined)
            setFormOpen(true)
          }}
        >
          添加 server
        </Button>
        <Button icon={<ReloadOutlined />} onClick={() => void run({ action: 'reload' }, reload)}>
          重载（重读 mcp.toml）
        </Button>
      </PanelToolbar>
      <Notice message={notice} />
      <div style={{ display: 'grid', gap: 8 }}>
        {entries.length === 0 && (
          <div style={{ padding: '36px 0' }}>
            <Empty description="还没有配置 MCP server——点「添加 server」或粘贴 mcpServers JSON" />
          </div>
        )}
        {entries.map((entry) => (
          <ItemCard key={entry.name}>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'flex-start',
                gap: 12,
              }}
            >
              <div style={{ minWidth: 0, flex: 1 }}>
                <Space size={8} wrap style={{ marginBottom: 2 }}>
                  <Typography.Text strong>{entry.name}</Typography.Text>
                  <Tag color="default">
                    {entry.transport.startsWith('stdio') ? 'stdio' : entry.transport}
                  </Tag>
                  <McpStatusDot status={entry.status} />
                </Space>
                <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block' }}>
                  {entry.scope === 'project' ? '项目级' : '用户级'}
                  {entry.tools !== undefined ? ` · ${entry.tools} 个工具` : ''}
                  {entry.detail ? ` · ${entry.detail}` : ''}
                </Typography.Text>
              </div>
              <Space size={0} style={{ flexShrink: 0 }}>
                <Button
                  type="text"
                  size="small"
                  onClick={() =>
                    void run({ action: 'inspect', name: entry.name }, (value) =>
                      setInspect(value as { entry: McpEntry; tools: [] }),
                    )
                  }
                >
                  详情
                </Button>
                <Button type="text" size="small" onClick={() => setEditEntry(entry)}>
                  编辑
                </Button>
                <Button
                  type="text"
                  size="small"
                  disabled={
                    entry.status !== 'disabled' &&
                    entry.status !== 'connected' &&
                    entry.status !== 'failed'
                  }
                  onClick={() =>
                    void run(
                      {
                        action: 'setEnabled',
                        name: entry.name,
                        enabled: entry.status === 'disabled',
                      },
                      reload,
                    )
                  }
                >
                  {entry.status === 'disabled' ? '启用' : '禁用'}
                </Button>
                <Popconfirm
                  title={`移除 ${entry.name}（${entry.scope ?? '?'} 作用域）？`}
                  onConfirm={() =>
                    void run({ action: 'remove', name: entry.name, scope: entry.scope }, reload)
                  }
                >
                  <Button type="text" size="small" danger>
                    移除
                  </Button>
                </Popconfirm>
              </Space>
            </div>
          </ItemCard>
        ))}
      </div>
      <McpServerFormModal
        api={api}
        open={formOpen}
        onClose={() => setFormOpen(false)}
        onSaved={reload}
      />
      {editEntry && (
        <McpServerFormModal
          api={api}
          open
          onClose={() => setEditEntry(undefined)}
          onSaved={reload}
          initial={{
            name: editEntry.name,
            scope: editEntry.scope === 'project' ? 'project' : 'user',
            kind: editEntry.transport.startsWith('stdio') ? 'stdio' : 'http',
          }}
        />
      )}
      <Modal
        title={`MCP server：${inspect?.entry.name ?? ''}`}
        open={inspect !== undefined}
        onCancel={() => setInspect(undefined)}
        footer={null}
        width={680}
      >
        {inspect && (
          <div style={{ display: 'grid', gap: 8 }}>
            <Typography.Text type="secondary">
              {inspect.entry.transport} · {inspect.entry.scope} · {inspect.entry.status}
              {inspect.entry.detail ? ` · ${inspect.entry.detail}` : ''}
            </Typography.Text>
            <Table
              size="small"
              pagination={false}
              dataSource={inspect.tools.map((tool) => ({ key: tool.name, ...tool }))}
              columns={[
                { dataIndex: 'name', title: '工具（mcp__server__tool）', width: 240 },
                { dataIndex: 'description', title: '描述' },
              ]}
            />
          </div>
        )}
      </Modal>
    </div>
  )
}

function McpStatusDot({ status }: { status: string | undefined }) {
  const map: Record<string, { color: string; text: string }> = {
    connected: { color: '#52c41a', text: '已连接' },
    connecting: { color: '#faad14', text: '连接中' },
    'needs-auth': { color: '#fa8c16', text: '需要认证' },
    failed: { color: '#ff4d4f', text: '失败' },
    disabled: { color: '#bfbfbf', text: '已禁用' },
  }
  const state = map[status ?? ''] ?? { color: '#bfbfbf', text: status ?? '未知' }
  return <StatusDot color={state.color} text={state.text} />
}

// ── Plugins（§S3.5）──────────────────────────────────────────────────

type PluginEntry = {
  name: string
  version: string
  source: 'builtin' | 'dev' | 'market'
  lifecycle?: { permissionHash: string; approved: boolean; enabled: boolean; loaded: boolean }
  permissions?: Record<string, unknown>
}

type PluginInventory = {
  domains?: { id: string; label: string; description: string; enabled: boolean }[]
  builtin: PluginEntry[]
  dev: PluginEntry[]
  market: {
    installed: PluginEntry[]
    registry:
      | {
          source: string
          plugins: { name: string; version: string; description?: string; publisher?: string }[]
        }
      | { error: string }
  }
}

function PluginsPanel({ api }: { api: WebApi }) {
  const { data, error, reload } = useInventory<{
    items: { id: string; label: string; description: string; enabled: boolean }[]
  }>(api, 'plugins')
  const { notice, setNotice, run } = useAction(api, 'plugins')
  const [inventory, setInventory] = useState<PluginInventory>()
  const [approve, setApprove] = useState<PluginEntry>()
  const [installing, setInstalling] = useState<string>()
  const loadInventory = useCallback(async () => {
    await run({ action: 'inventory' }, (value) => setInventory(value as PluginInventory))
  }, [run])
  const combined = useCallback(async () => {
    reload()
    await loadInventory()
  }, [loadInventory, reload])
  const toggleDomain = useCallback(
    async (id: string, enabled: boolean) => {
      await run({ action: 'setDomain', id, enabled }, reload)
    },
    [reload, run],
  )
  const install = useCallback(
    async (name: string) => {
      setInstalling(name)
      setNotice(undefined)
      try {
        await api.managementAction('plugins', { action: 'install', name })
      } catch (cause) {
        setNotice(marketErrorMessage(cause))
      } finally {
        setInstalling(undefined)
      }
      await combined()
    },
    [api, combined],
  )

  const entryActions = (entry: PluginEntry) => {
    const actions = []
    if (entry.source === 'market' && entry.lifecycle && !entry.lifecycle.approved)
      actions.push(
        <Button key="approve" size="small" type="primary" onClick={() => setApprove(entry)}>
          批准
        </Button>,
      )
    if (entry.lifecycle?.enabled)
      actions.push(
        <Button
          key="disable"
          size="small"
          type="text"
          onClick={() => void run({ action: 'disable', name: entry.name }, () => void combined())}
        >
          禁用
        </Button>,
      )
    else if (entry.lifecycle?.approved)
      actions.push(
        <Button
          key="enable"
          size="small"
          type="primary"
          onClick={() => void run({ action: 'enable', name: entry.name }, () => void combined())}
        >
          启用
        </Button>,
      )
    if (entry.source === 'market')
      actions.push(
        <Popconfirm
          key="uninstall"
          title={`卸载 ${entry.name}？`}
          onConfirm={() =>
            void run({ action: 'uninstall', name: entry.name }, () => void combined())
          }
        >
          <Button type="text" size="small" danger>
            卸载
          </Button>
        </Popconfirm>,
      )
    return actions
  }

  const renderEntries = (entries: PluginEntry[]) => (
    <div style={{ display: 'grid', gap: 8 }}>
      {entries.length === 0 && <Empty description="无" image={Empty.PRESENTED_IMAGE_SIMPLE} />}
      {entries.map((entry) => (
        <ItemCard key={entry.name}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: 12,
            }}
          >
            <Space size={8} wrap>
              <Typography.Text strong>{entry.name}</Typography.Text>
              <Tag color="default">v{entry.version}</Tag>
              <PluginLifecycleTag entry={entry} />
            </Space>
            <Space size={0}>{entryActions(entry)}</Space>
          </div>
        </ItemCard>
      ))}
    </div>
  )

  if (error) return <Notice message={error} />
  const registry = inventory?.market.registry
  const total =
    (inventory?.builtin.length ?? 0) +
    (inventory?.dev.length ?? 0) +
    (inventory?.market.installed.length ?? 0)
  return (
    <div>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-end',
          flexWrap: 'wrap',
          gap: 8,
        }}
      >
        <PanelIntro
          title="Plugins 插件"
          description="沙箱子进程插件：市场安装 → 批准（权限清单前置）→ 启用 三段状态机，激活前逐文件 digest 重验。"
        />
        <CountBadge scopeLabel="plugins" count={total} unit="个插件" />
      </div>
      <PanelToolbar>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          legacy catalog（deny-only）通道已关闭；管理走下方 v2 状态机
        </Typography.Text>
        <Button icon={<ReloadOutlined />} onClick={() => void combined()}>
          刷新 inventory
        </Button>
      </PanelToolbar>
      <Notice message={notice} />
      <Tabs
        size="small"
        items={[
          {
            key: 'domains',
            label: '第一方域',
            children: (
              <div style={{ display: 'grid', gap: 8 }}>
                {(data?.items ?? []).map((domain) => (
                  <ItemCard key={domain.id}>
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        gap: 12,
                      }}
                    >
                      <div>
                        <Typography.Text strong>{domain.label}</Typography.Text>
                        <Typography.Paragraph
                          type="secondary"
                          style={{ marginBottom: 0, fontSize: 12 }}
                        >
                          {domain.description}
                        </Typography.Paragraph>
                      </div>
                      <Button
                        type="text"
                        size="small"
                        onClick={() => void toggleDomain(domain.id, !domain.enabled)}
                      >
                        {domain.enabled ? '禁用' : '启用'}
                      </Button>
                    </div>
                  </ItemCard>
                ))}
              </div>
            ),
          },
          { key: 'builtin', label: '内置插件', children: renderEntries(inventory?.builtin ?? []) },
          { key: 'dev', label: 'Dev 插件', children: renderEntries(inventory?.dev ?? []) },
          {
            key: 'market',
            label: '市场插件',
            children: (
              <div style={{ display: 'grid', gap: 16 }}>
                <div>
                  <Typography.Title level={5} style={{ marginTop: 0 }}>
                    已安装
                  </Typography.Title>
                  {renderEntries(inventory?.market.installed ?? [])}
                </div>
                <div>
                  <Typography.Title level={5}>市场源</Typography.Title>
                  {!registry && (
                    <Typography.Text type="secondary">点「刷新 inventory」加载…</Typography.Text>
                  )}
                  {registry && 'error' in registry && (
                    <Typography.Text type="warning">{registry.error}</Typography.Text>
                  )}
                  {registry && 'plugins' in registry && (
                    <div style={{ display: 'grid', gap: 8 }}>
                      {registry.plugins.length === 0 && (
                        <Empty description="市场源没有条目" image={Empty.PRESENTED_IMAGE_SIMPLE} />
                      )}
                      {registry.plugins.map((listing) => {
                        const installed = inventory?.market.installed.some(
                          (entry) => entry.name === listing.name,
                        )
                        return (
                          <ItemCard key={listing.name}>
                            <div
                              style={{
                                display: 'flex',
                                justifyContent: 'space-between',
                                alignItems: 'center',
                                gap: 12,
                              }}
                            >
                              <div style={{ minWidth: 0 }}>
                                <Space size={8} wrap>
                                  <Typography.Text strong>{listing.name}</Typography.Text>
                                  <Tag color="default">v{listing.version}</Tag>
                                </Space>
                                <Typography.Paragraph
                                  type="secondary"
                                  style={{ marginBottom: 0, fontSize: 12 }}
                                  ellipsis={{ rows: 2 }}
                                >
                                  {[listing.publisher, listing.description]
                                    .filter(Boolean)
                                    .join(' · ')}
                                </Typography.Paragraph>
                              </div>
                              <Button
                                size="small"
                                type={installed ? 'default' : 'primary'}
                                disabled={installed}
                                loading={installing === listing.name}
                                onClick={() => void install(listing.name)}
                              >
                                {installed ? '已安装' : '安装'}
                              </Button>
                            </div>
                          </ItemCard>
                        )
                      })}
                    </div>
                  )}
                </div>
              </div>
            ),
          },
        ]}
      />
      {approve && (
        <ApproveModal
          api={api}
          entry={approve}
          onClose={() => setApprove(undefined)}
          onApproved={() => {
            setApprove(undefined)
            void combined()
          }}
        />
      )}
    </div>
  )
}

function PluginLifecycleTag({ entry }: { entry: PluginEntry }) {
  if (!entry.lifecycle) return <Tag color="default">{entry.source}</Tag>
  const { approved, enabled, loaded } = entry.lifecycle
  if (loaded) return <StatusDot color="#52c41a" text="已加载" />
  if (enabled) return <StatusDot color="#52c41a" text="已启用" />
  if (approved) return <StatusDot color="#1677ff" text="待启用" />
  return <StatusDot color="#faad14" text="待批准" />
}

/** 批准前强制展示权限清单（§S3.5 不变量：未展示前批准不可用；hash 变更高亮）。 */
function ApproveModal({
  api,
  entry,
  onClose,
  onApproved,
}: {
  api: WebApi
  entry: PluginEntry
  onClose: () => void
  onApproved: () => void
}) {
  const [detail, setDetail] = useState<PluginEntry & { permissions?: Record<string, unknown> }>()
  const [notice, setNotice] = useState<string>()
  useEffect(() => {
    void api
      .managementAction('plugins', { action: 'inspect', name: entry.name })
      .then((value) => setDetail(value as PluginEntry))
      .catch((cause) => setNotice(cause instanceof Error ? cause.message : String(cause)))
  }, [api, entry.name])
  const permissions = detail?.permissions
  return (
    <Modal
      title={`批准插件：${entry.name}`}
      open
      onCancel={onClose}
      footer={[
        <Button key="cancel" onClick={onClose}>
          取消
        </Button>,
        <Button
          key="approve"
          type="primary"
          disabled={!detail || !permissions}
          onClick={() => {
            void api
              .managementAction('plugins', {
                action: 'approve',
                name: entry.name,
                permissionHash:
                  detail?.lifecycle?.permissionHash ?? entry.lifecycle?.permissionHash,
              })
              .then(onApproved)
              .catch((cause) => setNotice(cause instanceof Error ? cause.message : String(cause)))
          }}
        >
          确认批准
        </Button>,
      ]}
      width={640}
    >
      <Notice message={notice} />
      {!detail && <Typography.Text type="secondary">读取 manifest…</Typography.Text>}
      {detail && (
        <div style={{ display: 'grid', gap: 8 }}>
          <Typography.Text>
            v{detail.version} · permissionHash{' '}
            <code>{(detail.lifecycle?.permissionHash ?? '').slice(0, 16)}…</code>
          </Typography.Text>
          <pre
            style={{
              background: 'var(--ant-color-fill-tertiary, #f5f5f5)',
              borderRadius: 8,
              padding: 12,
              fontSize: 12,
              overflow: 'auto',
            }}
          >
            {JSON.stringify(permissions ?? {}, null, 2)}
          </pre>
          <Typography.Text type="secondary">
            批准即允许插件以以上权限运行（市场安装需 批准 → 启用 两步；激活前逐文件 digest 重验）。
          </Typography.Text>
        </div>
      )}
    </Modal>
  )
}

export { MemoryPanel, SkillsPanel, McpPanel, PluginsPanel }
