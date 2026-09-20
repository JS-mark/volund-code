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
  Form,
  Input,
  List,
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
  KeyValueEditor,
  Notice,
  downloadJson,
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
      <Space style={{ marginBottom: 8 }} wrap>
        <Input.Search
          placeholder={data?.searchAvailable ? '搜索 Memory…' : '搜索不可用（recall 未装配）'}
          value={query}
          disabled={!data?.searchAvailable}
          onChange={(event) => setQuery(event.target.value)}
          onSearch={() => void search()}
          style={{ width: 280 }}
        />
        {results && <Button onClick={() => setResults(undefined)}>清除</Button>}
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
                key="edit"
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
              </Button>,
              <Button
                key="pin"
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
              </Button>,
              <Popconfirm
                key="delete"
                title="删除这条记忆？"
                onConfirm={() =>
                  void run(
                    { action: 'delete', id: record.id, expectedUpdatedAt: record.updatedAt },
                    reload,
                  )
                }
              >
                <Button size="small" danger>
                  删除
                </Button>
              </Popconfirm>,
            ]}
          >
            <List.Item.Meta
              title={
                <>
                  {record.pinned && '📌 '}
                  {record.content.slice(0, 120)}
                </>
              }
              description={`${record.id.slice(0, 8)} · ${record.tags.join(', ') || '无标签'} · ${record.updatedAt}`}
            />
          </List.Item>
        )}
      />
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
  return (
    <div>
      <Space style={{ marginBottom: 8 }} wrap>
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
        <Button icon={<ReloadOutlined />} onClick={() => void run({ action: 'reload' }, reload)}>
          重扫描
        </Button>
      </Space>
      <Notice message={notice} />
      <List
        size="small"
        dataSource={data?.items ?? []}
        renderItem={(skill) => (
          <List.Item
            actions={[
              <Button
                key="show"
                size="small"
                onClick={() =>
                  void run({ action: 'show', name: skill.name }, (value) => {
                    setDetail({ name: skill.name, raw: (value as { body: string }).body })
                  })
                }
              >
                详情
              </Button>,
              <Button
                key="toggle"
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
              </Button>,
              ...(skill.scope === 'user' || skill.scope === 'project'
                ? [
                    <Popconfirm
                      key="uninstall"
                      title={`卸载 ${skill.name}？`}
                      onConfirm={() =>
                        void run(
                          { action: 'uninstall', name: skill.name, scope: skill.scope },
                          reload,
                        )
                      }
                    >
                      <Button size="small" danger>
                        卸载
                      </Button>
                    </Popconfirm>,
                  ]
                : []),
            ]}
          >
            <List.Item.Meta
              title={
                <>
                  /{skill.name} <Tag>{skill.scope}</Tag>
                  {skill.status !== 'available' && <Tag color="warning">{skill.status}</Tag>}
                  {skill.version && <Tag>v{skill.version}</Tag>}
                </>
              }
              description={skill.description}
            />
          </List.Item>
        )}
      />
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
      <Space style={{ marginBottom: 8 }} wrap>
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={() => {
            setEditEntry(undefined)
            setFormOpen(true)
          }}
        >
          添加
        </Button>
        <Button icon={<ReloadOutlined />} onClick={() => void run({ action: 'reload' }, reload)}>
          重载（重读 mcp.toml）
        </Button>
      </Space>
      <Notice message={notice} />
      <List
        size="small"
        dataSource={entries}
        renderItem={(entry) => (
          <List.Item
            actions={[
              <Button
                key="inspect"
                size="small"
                onClick={() =>
                  void run({ action: 'inspect', name: entry.name }, (value) =>
                    setInspect(value as { entry: McpEntry; tools: [] }),
                  )
                }
              >
                详情
              </Button>,
              <Button key="edit" size="small" onClick={() => setEditEntry(entry)}>
                编辑
              </Button>,
              <Button
                key="toggle"
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
              </Button>,
              <Popconfirm
                key="remove"
                title={`移除 ${entry.name}（${entry.scope ?? '?'} 作用域）？`}
                onConfirm={() =>
                  void run({ action: 'remove', name: entry.name, scope: entry.scope }, reload)
                }
              >
                <Button size="small" danger>
                  移除
                </Button>
              </Popconfirm>,
            ]}
          >
            <List.Item.Meta
              title={
                <>
                  {entry.name} <Tag>{entry.transport}</Tag>
                  <McpStatusTag status={entry.status} />
                </>
              }
              description={`${entry.scope ?? ''} · ${entry.status ?? 'unknown'}${entry.tools !== undefined ? ` · ${entry.tools} tools` : ''}${entry.detail ? ` · ${entry.detail}` : ''}`}
            />
          </List.Item>
        )}
      />
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

function McpStatusTag({ status }: { status: string | undefined }) {
  const color =
    status === 'connected'
      ? 'success'
      : status === 'failed'
        ? 'error'
        : status === 'needs-auth'
          ? 'warning'
          : 'default'
  return <Tag color={color}>{status ?? 'unknown'}</Tag>
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
          <Button size="small" danger>
            卸载
          </Button>
        </Popconfirm>,
      )
    return actions
  }

  const renderEntries = (entries: PluginEntry[]) => (
    <List
      size="small"
      dataSource={entries}
      renderItem={(entry) => (
        <List.Item actions={entryActions(entry)}>
          <List.Item.Meta
            title={
              <>
                {entry.name} <Tag>v{entry.version}</Tag>
                <PluginLifecycleTag entry={entry} />
              </>
            }
            description={entry.source}
          />
        </List.Item>
      )}
    />
  )

  if (error) return <Notice message={error} />
  const registry = inventory?.market.registry
  return (
    <div>
      <Notice message={notice} />
      <Button icon={<ReloadOutlined />} style={{ marginBottom: 8 }} onClick={() => void combined()}>
        刷新 inventory
      </Button>
      <Tabs
        size="small"
        items={[
          {
            key: 'domains',
            label: '第一方域',
            children: (
              <List
                size="small"
                dataSource={data?.items ?? []}
                renderItem={(domain) => (
                  <List.Item
                    actions={[
                      <Button
                        key="toggle"
                        size="small"
                        onClick={() => void toggleDomain(domain.id, !domain.enabled)}
                      >
                        {domain.enabled ? '禁用' : '启用'}
                      </Button>,
                    ]}
                  >
                    <List.Item.Meta title={domain.label} description={domain.description} />
                  </List.Item>
                )}
              />
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
                  <Typography.Title level={5}>已安装</Typography.Title>
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
                    <List
                      size="small"
                      dataSource={registry.plugins}
                      renderItem={(listing) => {
                        const installed = inventory?.market.installed.some(
                          (entry) => entry.name === listing.name,
                        )
                        return (
                          <List.Item
                            actions={[
                              <Button
                                key="install"
                                size="small"
                                type={installed ? 'default' : 'primary'}
                                disabled={installed}
                                loading={installing === listing.name}
                                onClick={() => void install(listing.name)}
                              >
                                {installed ? '已安装' : '安装'}
                              </Button>,
                            ]}
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
  if (!entry.lifecycle) return <Tag>{entry.source}</Tag>
  const { approved, enabled, loaded } = entry.lifecycle
  if (loaded) return <Tag color="success">loaded</Tag>
  if (enabled) return <Tag color="success">enabled</Tag>
  if (approved) return <Tag color="processing">approved</Tag>
  return <Tag color="warning">approval-required</Tag>
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
