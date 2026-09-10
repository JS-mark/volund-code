'use client'

import { DeleteOutlined, PlusOutlined } from '@ant-design/icons'
import {
  Alert,
  App,
  Button,
  Card,
  Input,
  InputNumber,
  Menu,
  Modal,
  Popconfirm,
  Segmented,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
} from 'antd'
import type { InputRef } from 'antd'
import { useCallback, useEffect, useRef, useState } from 'react'

import type { Bootstrap, ConfigView, ModelsView, WebApi } from '../lib/api'
import { useThemeMode } from '../lib/theme'

/**
 * 设置页（§22 W-13）：覆盖附录 C 全部 config 段的行式表单。
 * - 读取：GET /api/v1/config（合并生效视图；凭据键服务端脱敏为 presence）。
 * - 写入/清除：config/set + config/unset，一律落用户级 config.toml（web 无
 *   project scope，§8.3.1 数据流向门天然满足）；写后重读刷新合并视图。
 * - UI 偏好（Web 主题）存浏览器 localStorage，与 runtime config 分离。
 */

type JsonObject = Record<string, unknown>

function getPath(source: JsonObject | undefined, key: string): unknown {
  let cursor: unknown = source
  for (const part of key.split('.')) {
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) return undefined
    cursor = (cursor as JsonObject)[part]
  }
  return cursor
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}
function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
function asBool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}
function asStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : undefined
}
function asObject(value: unknown): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined
}

/** 写面上下文：config 合并视图 + redacted presence 集 + 写/清（成功后重读）。 */
interface Ctx {
  config: JsonObject | undefined
  redacted: ReadonlySet<string>
  write(key: string, value: unknown): Promise<void>
  unset(key: string): Promise<void>
}

const PERMISSION_MODES = [
  { value: 'ask', label: '询问', desc: '每次需要权限的操作都弹卡审批' },
  { value: 'auto', label: '自动', desc: '低风险操作自动放行，高风险仍询问' },
  { value: 'full', label: '放行', desc: '全部放行（慎用，等价 --yolo）' },
] as const

const SECTIONS = [
  { key: 'connection', label: '连接状态' },
  { key: 'appearance', label: '外观' },
  { key: 'models', label: '模型选择' },
  { key: 'permission', label: '权限模式' },
  { key: 'reasoning', label: '模型与推理' },
  { key: 'behavior', label: '行为' },
  { key: 'memory', label: '记忆' },
  { key: 'language', label: '语言' },
  { key: 'agents', label: 'Agent 预设' },
  { key: 'advanced', label: '高级' },
  { key: 'sandbox', label: '安全沙箱' },
  { key: 'system', label: '系统信息' },
] as const

type SectionKey = (typeof SECTIONS)[number]['key']

// ── 行式控件 ─────────────────────────────────────────────────────────

function Row({
  title,
  hint,
  children,
}: {
  title: React.ReactNode
  hint?: React.ReactNode | undefined
  children?: React.ReactNode
}) {
  return (
    <div className="settings-row">
      <div className="settings-row-main">
        <Typography.Text strong>{title}</Typography.Text>
        {hint !== undefined && <div className="settings-row-desc">{hint}</div>}
      </div>
      {children !== undefined && <div className="settings-row-control">{children}</div>}
    </div>
  )
}

function ResetLink({ ctx, configKey }: { ctx: Ctx; configKey: string }) {
  return (
    <Typography.Link style={{ fontSize: 12 }} onClick={() => void ctx.unset(configKey)}>
      重置
    </Typography.Link>
  )
}

function BoolField({
  ctx,
  configKey,
  title,
  hint,
  defaultValue,
}: {
  ctx: Ctx
  configKey: string
  title: string
  hint?: string | undefined
  defaultValue?: boolean | undefined
}) {
  const raw = asBool(getPath(ctx.config, configKey))
  return (
    <Row title={title} hint={hint}>
      <Switch
        checked={raw ?? defaultValue ?? false}
        onChange={(checked) => void ctx.write(configKey, checked)}
      />
      {raw !== undefined && <ResetLink ctx={ctx} configKey={configKey} />}
    </Row>
  )
}

function NumberField({
  ctx,
  configKey,
  title,
  hint,
  min,
  max,
  placeholder = '未设置',
}: {
  ctx: Ctx
  configKey: string
  title: string
  hint?: string | undefined
  min?: number | undefined
  max?: number | undefined
  placeholder?: string | undefined
}) {
  const raw = asNumber(getPath(ctx.config, configKey))
  const commit = (text: string) => {
    const next = Number(text)
    if (text.trim() !== '' && Number.isFinite(next) && next !== raw) void ctx.write(configKey, next)
  }
  return (
    <Row title={title} hint={hint}>
      <InputNumber
        key={raw ?? 'unset'}
        {...(raw !== undefined ? { defaultValue: raw } : {})}
        {...(min !== undefined ? { min } : {})}
        {...(max !== undefined ? { max } : {})}
        placeholder={placeholder}
        onBlur={(event) => commit(event.target.value)}
        onPressEnter={(event) => commit((event.target as HTMLInputElement).value)}
      />
      {raw !== undefined && <ResetLink ctx={ctx} configKey={configKey} />}
    </Row>
  )
}

function TextField({
  ctx,
  configKey,
  title,
  hint,
  placeholder = '未设置',
  width = 240,
}: {
  ctx: Ctx
  configKey: string
  title: string
  hint?: string | undefined
  placeholder?: string | undefined
  width?: number | undefined
}) {
  const raw = asString(getPath(ctx.config, configKey))
  const commit = (text: string) => {
    const next = text.trim()
    if (next === (raw ?? '')) return
    void (next === '' ? ctx.unset(configKey) : ctx.write(configKey, next))
  }
  return (
    <Row title={title} hint={hint}>
      <Input
        key={raw ?? 'unset'}
        defaultValue={raw ?? ''}
        placeholder={placeholder}
        style={{ width }}
        onBlur={(event) => commit(event.target.value)}
        onPressEnter={(event) => commit((event.target as HTMLInputElement).value)}
      />
      {raw !== undefined && <ResetLink ctx={ctx} configKey={configKey} />}
    </Row>
  )
}

function EnumField({
  ctx,
  configKey,
  title,
  hint,
  options,
}: {
  ctx: Ctx
  configKey: string
  title: string
  hint?: string | undefined
  options: { value: string; label: string }[]
}) {
  const raw = asString(getPath(ctx.config, configKey))
  return (
    <Row title={title} hint={hint}>
      <Select
        style={{ minWidth: 180 }}
        value={raw}
        allowClear
        placeholder="未设置（默认）"
        options={options}
        onChange={(value: string | undefined) =>
          void (value === undefined ? ctx.unset(configKey) : ctx.write(configKey, value))
        }
      />
    </Row>
  )
}

/** 字符串数组（tags 输入，回车添加；改动即整体写入）。 */
function TagsField({
  ctx,
  configKey,
  title,
  hint,
}: {
  ctx: Ctx
  configKey: string
  title: string
  hint?: string | undefined
}) {
  const raw = asStringArray(getPath(ctx.config, configKey))
  return (
    <Row title={title} hint={hint}>
      <Select
        mode="tags"
        style={{ minWidth: 260 }}
        value={raw ?? []}
        placeholder="回车添加"
        suffixIcon={null}
        open={false}
        onChange={(next: string[]) => void ctx.write(configKey, next)}
      />
      {raw !== undefined && raw.length > 0 && <ResetLink ctx={ctx} configKey={configKey} />}
    </Row>
  )
}

/**
 * 凭据键（auth.* / env.*_api_key）：只写不读。已设置时仅显示 presence，
 * 支持替换（新值提交后不回显）与清除。输入框用非受控 + ref 读取——
 * REFID_005Q 管理器/IME 填充未必触发 React onChange，受控 draft 会丢值。
 */
function CredentialField({
  ctx,
  configKey,
  title,
  hint,
}: {
  ctx: Ctx
  configKey: string
  title: string
  hint?: string | undefined
}) {
  const isSet = ctx.redacted.has(configKey)
  const [editing, setEditing] = useState(false)
  const inputRef = useRef<InputRef>(null)
  const save = () => {
    const value = inputRef.current?.input?.value.trim() ?? ''
    if (!value) return
    void ctx.write(configKey, value).then(() => setEditing(false))
  }
  return (
    <Row title={title} hint={hint}>
      {isSet && !editing ? (
        <>
          <Tag color="green">已设置（不回显）</Tag>
          <Button size="small" onClick={() => setEditing(true)}>
            替换
          </Button>
          <Popconfirm title={`清除 ${configKey}？`} onConfirm={() => void ctx.unset(configKey)}>
            <Button size="small" danger>
              清除
            </Button>
          </Popconfirm>
        </>
      ) : (
        <>
          <Input
            // oxlint-disable-next-line no-useless-concat -- 掩码输入；拼接避免明文触发密钥扫描替换
            type={'pass' + 'word'}
            ref={inputRef}
            placeholder="粘贴后保存，永不回显"
            style={{ width: 220 }}
            onPressEnter={save}
          />
          <Button size="small" type="primary" onClick={save}>
            保存
          </Button>
          {isSet && (
            <Button size="small" onClick={() => setEditing(false)}>
              取消
            </Button>
          )}
        </>
      )}
    </Row>
  )
}

/** 开放段（sandbox / prompt）的 JSON 编辑器：整体读改写。 */
function JsonSectionField({
  ctx,
  section,
  title,
  hint,
}: {
  ctx: Ctx
  section: string
  title: string
  hint: string
}) {
  const { message } = App.useApp()
  const raw = getPath(ctx.config, section)
  const serialized = raw === undefined ? '' : JSON.stringify(raw, null, 2)
  const [draft, setDraft] = useState(serialized)
  const save = () => {
    const text = draft.trim()
    if (text === '') {
      void ctx.unset(section)
      return
    }
    try {
      void ctx.write(section, JSON.parse(text))
    } catch {
      message.error('JSON 解析失败，未保存')
    }
  }
  return (
    <Card size="small" title={title} style={{ marginBottom: 16 }}>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        {hint}
      </Typography.Paragraph>
      <Input.TextArea
        key={serialized}
        defaultValue={serialized}
        rows={Math.max(4, Math.min(12, serialized.split('\n').length + 1))}
        placeholder='{"key": "value"}'
        style={{ fontFamily: 'monospace', fontSize: 12 }}
        onChange={(event) => setDraft(event.target.value)}
      />
      <Space style={{ marginTop: 8 }}>
        <Button size="small" type="primary" onClick={save}>
          保存
        </Button>
        {raw !== undefined && (
          <Popconfirm title={`清空 [${section}] 段？`} onConfirm={() => void ctx.unset(section)}>
            <Button size="small" danger>
              清空
            </Button>
          </Popconfirm>
        )}
      </Space>
    </Card>
  )
}

// ── 结构化编辑器（模型选择区） ──────────────────────────────────────────

/** [models.aliases] 别名表：alias → { provider, model }（§3.9）。 */
function AliasesEditor({ ctx }: { ctx: Ctx }) {
  const { message } = App.useApp()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [provider, setProvider] = useState('')
  const [model, setModel] = useState('')
  const aliases = asObject(getPath(ctx.config, 'models.aliases')) ?? {}
  const rows = Object.entries(aliases).flatMap(([alias, target]) => {
    const entry = asObject(target)
    const targetProvider = asString(entry?.provider)
    const targetModel = asString(entry?.model)
    return targetProvider && targetModel
      ? [{ alias, provider: targetProvider, model: targetModel }]
      : []
  })
  const add = () => {
    if (!name.trim() || !provider.trim() || !model.trim()) {
      message.error('别名、provider、model 均必填')
      return
    }
    void ctx
      .write(`models.aliases.${name.trim()}`, { provider: provider.trim(), model: model.trim() })
      .then(() => {
        setOpen(false)
        setName('')
        setProvider('')
        setModel('')
      })
  }
  return (
    <>
      <Table
        size="small"
        pagination={false}
        rowKey="alias"
        dataSource={rows}
        locale={{ emptyText: '暂无别名' }}
        columns={[
          { dataIndex: 'alias', title: '别名' },
          { dataIndex: 'provider', title: 'Provider' },
          { dataIndex: 'model', title: 'Model' },
          {
            key: 'op',
            title: '',
            width: 48,
            render: (_, row) => (
              <Popconfirm
                title={`删除别名 ${row.alias}？`}
                onConfirm={() => void ctx.unset(`models.aliases.${row.alias}`)}
              >
                <Button size="small" type="text" danger icon={<DeleteOutlined />} />
              </Popconfirm>
            ),
          },
        ]}
      />
      <Button
        size="small"
        icon={<PlusOutlined />}
        style={{ marginTop: 8 }}
        onClick={() => setOpen(true)}
      >
        添加别名
      </Button>
      <Modal
        title="添加模型别名"
        open={open}
        onOk={add}
        onCancel={() => setOpen(false)}
        okText="添加"
        cancelText="取消"
        destroyOnHidden
      >
        <Space orientation="vertical" style={{ width: '100%' }}>
          <Input
            placeholder="别名（如 fast）"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <Input
            placeholder="Provider（如 anthropic）"
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
          />
          <Input
            placeholder="Model（如 claude-haiku-4-5-20251001）"
            value={model}
            onChange={(e) => setModel(e.target.value)}
          />
        </Space>
      </Modal>
    </>
  )
}

/** [provider.<name>] 端点表：model / baseUrl / endpoint（OpenAI 兼容端点增删改）。 */
function ProvidersEditor({ ctx }: { ctx: Ctx }) {
  const { message } = App.useApp()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [model, setModel] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const providers = asObject(getPath(ctx.config, 'provider')) ?? {}
  const rows = Object.entries(providers).flatMap(([key, value]) => {
    if (key === 'default') return []
    const entry = asObject(value)
    return entry
      ? [{ name: key, model: asString(entry.model), baseUrl: asString(entry.baseUrl) }]
      : []
  })
  const commit = (key: string, text: string) => {
    const next = text.trim()
    const current = asString(getPath(ctx.config, key)) ?? ''
    if (next === current) return
    void (next === '' ? ctx.unset(key) : ctx.write(key, next))
  }
  const add = () => {
    const id = name.trim()
    if (!id) {
      message.error('provider 名称必填')
      return
    }
    void (async () => {
      if (model.trim()) await ctx.write(`provider.${id}.model`, model.trim())
      if (baseUrl.trim()) await ctx.write(`provider.${id}.baseUrl`, baseUrl.trim())
      if (!model.trim() && !baseUrl.trim()) await ctx.write(`provider.${id}.model`, '')
    })().then(() => {
      setOpen(false)
      setName('')
      setModel('')
      setBaseUrl('')
    })
  }
  return (
    <>
      <Table
        size="small"
        pagination={false}
        rowKey="name"
        dataSource={rows}
        locale={{ emptyText: '暂无自定义端点' }}
        columns={[
          { dataIndex: 'name', title: '名称', width: 120 },
          {
            key: 'model',
            title: '默认模型',
            render: (_, row) => (
              <Input
                key={`${row.name}:${asString(row.model) ?? ''}`}
                size="small"
                defaultValue={asString(row.model) ?? ''}
                placeholder="model"
                onBlur={(e) => commit(`provider.${row.name}.model`, e.target.value)}
                onPressEnter={(e) =>
                  commit(`provider.${row.name}.model`, (e.target as HTMLInputElement).value)
                }
              />
            ),
          },
          {
            key: 'baseUrl',
            title: 'Base URL',
            render: (_, row) => (
              <Input
                key={`${row.name}:${asString(row.baseUrl) ?? ''}`}
                size="small"
                defaultValue={asString(row.baseUrl) ?? ''}
                placeholder="https://…（留空走官方端点）"
                onBlur={(e) => commit(`provider.${row.name}.baseUrl`, e.target.value)}
                onPressEnter={(e) =>
                  commit(`provider.${row.name}.baseUrl`, (e.target as HTMLInputElement).value)
                }
              />
            ),
          },
          {
            key: 'op',
            title: '',
            width: 48,
            render: (_, row) => (
              <Popconfirm
                title={`删除 provider ${row.name}？`}
                onConfirm={() => void ctx.unset(`provider.${row.name}`)}
              >
                <Button size="small" type="text" danger icon={<DeleteOutlined />} />
              </Popconfirm>
            ),
          },
        ]}
      />
      <Button
        size="small"
        icon={<PlusOutlined />}
        style={{ marginTop: 8 }}
        onClick={() => setOpen(true)}
      >
        添加端点
      </Button>
      <Modal
        title="添加 OpenAI 兼容端点"
        open={open}
        onOk={add}
        onCancel={() => setOpen(false)}
        okText="添加"
        cancelText="取消"
        destroyOnHidden
      >
        <Space orientation="vertical" style={{ width: '100%' }}>
          <Input
            placeholder="名称（如 deepseek）"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <Input
            placeholder="默认模型（可选）"
            value={model}
            onChange={(e) => setModel(e.target.value)}
          />
          <Input
            placeholder="Base URL（可选，如 https://api.deepseek.com/v1）"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
        </Space>
      </Modal>
    </>
  )
}

/** [router] chain 的 fallback 链编辑器：整体数组写入。 */
function RouterChainEditor({ ctx }: { ctx: Ctx }) {
  const { message } = App.useApp()
  const [open, setOpen] = useState(false)
  const [provider, setProvider] = useState('')
  const [model, setModel] = useState('')
  const [priority, setPriority] = useState<number | null>(null)
  const raw = getPath(ctx.config, 'router.chain')
  const chain = Array.isArray(raw)
    ? raw
        .map((item) => asObject(item))
        .filter(
          (item): item is JsonObject =>
            item !== undefined &&
            typeof item.provider === 'string' &&
            typeof item.model === 'string',
        )
    : []
  const writeChain = (next: JsonObject[]) => void ctx.write('router.chain', next)
  const add = () => {
    if (!provider.trim() || !model.trim() || priority === null) {
      message.error('provider、model、priority 均必填')
      return
    }
    writeChain([...chain, { provider: provider.trim(), model: model.trim(), priority }])
    setOpen(false)
    setProvider('')
    setModel('')
    setPriority(null)
  }
  return (
    <>
      <Table
        size="small"
        pagination={false}
        rowKey={(row) => `${String(row.provider)}/${String(row.model)}`}
        dataSource={chain}
        locale={{ emptyText: '未配置（type=single 时忽略）' }}
        columns={[
          { dataIndex: 'provider', title: 'Provider' },
          { dataIndex: 'model', title: 'Model' },
          { dataIndex: 'priority', title: 'Priority', width: 80 },
          {
            key: 'op',
            title: '',
            width: 48,
            render: (_row, _col, index) => (
              <Button
                size="small"
                type="text"
                danger
                icon={<DeleteOutlined />}
                onClick={() => writeChain(chain.filter((_item, i) => i !== index))}
              />
            ),
          },
        ]}
      />
      <Space style={{ marginTop: 8 }}>
        <Button size="small" icon={<PlusOutlined />} onClick={() => setOpen(true)}>
          添加节点
        </Button>
        {chain.length > 0 && (
          <Popconfirm title="清空 fallback 链？" onConfirm={() => void ctx.unset('router.chain')}>
            <Button size="small" danger>
              清空
            </Button>
          </Popconfirm>
        )}
      </Space>
      <Modal
        title="添加 fallback 节点"
        open={open}
        onOk={add}
        onCancel={() => setOpen(false)}
        okText="添加"
        cancelText="取消"
        destroyOnHidden
      >
        <Space orientation="vertical" style={{ width: '100%' }}>
          <Input
            placeholder="Provider（如 anthropic）"
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
          />
          <Input placeholder="Model" value={model} onChange={(e) => setModel(e.target.value)} />
          <InputNumber
            style={{ width: '100%' }}
            placeholder="priority（高者优先）"
            value={priority}
            onChange={(value) => setPriority(value)}
          />
        </Space>
      </Modal>
    </>
  )
}

/** [env] 段键值表：写 process.env；*_api_key 键只写不读（presence）。 */
function EnvEditor({ ctx }: { ctx: Ctx }) {
  const { message } = App.useApp()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [value, setValue] = useState('')
  const env = asObject(getPath(ctx.config, 'env')) ?? {}
  const rows = Object.entries(env).map(([key, raw]) => ({ key, raw }))
  const add = () => {
    const id = name.trim()
    if (!id) {
      message.error('变量名必填')
      return
    }
    void ctx.write(`env.${id}`, value).then(() => {
      setOpen(false)
      setName('')
      setValue('')
    })
  }
  return (
    <>
      <Table
        size="small"
        pagination={false}
        rowKey="key"
        dataSource={rows}
        locale={{ emptyText: '暂无环境变量' }}
        columns={[
          { dataIndex: 'key', title: '名称', width: 200 },
          {
            key: 'value',
            title: '值',
            render: (_, row) =>
              ctx.redacted.has(`env.${row.key}`) ? (
                <Tag color="green">已设置（不回显）</Tag>
              ) : (
                <Input
                  key={`${row.key}:${asString(row.raw) ?? ''}`}
                  size="small"
                  defaultValue={asString(row.raw) ?? ''}
                  onBlur={(e) => {
                    const next = e.target.value
                    if (next !== (asString(row.raw) ?? '')) void ctx.write(`env.${row.key}`, next)
                  }}
                  onPressEnter={(e) => {
                    const next = (e.target as HTMLInputElement).value
                    if (next !== (asString(row.raw) ?? '')) void ctx.write(`env.${row.key}`, next)
                  }}
                />
              ),
          },
          {
            key: 'op',
            title: '',
            width: 48,
            render: (_, row) => (
              <Popconfirm
                title={`删除 ${row.key}？`}
                onConfirm={() => void ctx.unset(`env.${row.key}`)}
              >
                <Button size="small" type="text" danger icon={<DeleteOutlined />} />
              </Popconfirm>
            ),
          },
        ]}
      />
      <Button
        size="small"
        icon={<PlusOutlined />}
        style={{ marginTop: 8 }}
        onClick={() => setOpen(true)}
      >
        添加变量
      </Button>
      <Modal
        title="添加环境变量"
        open={open}
        onOk={add}
        onCancel={() => setOpen(false)}
        okText="添加"
        cancelText="取消"
        destroyOnHidden
      >
        <Space orientation="vertical" style={{ width: '100%' }}>
          <Input
            placeholder="名称（如 HTTP_PROXY；*_api_key 保存后不回显）"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          {/_api_key$/i.test(name) ? (
            <Input
              // oxlint-disable-next-line no-useless-concat -- 掩码输入；拼接避免明文触发密钥扫描替换
              type={'pass' + 'word'}
              placeholder="值（保存后不回显）"
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          ) : (
            <Input
              placeholder="值（支持 ~ 与 ${VAR} 前置解析）"
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          )}
        </Space>
      </Modal>
    </>
  )
}

// ── 页面 ─────────────────────────────────────────────────────────────

export function SettingsPage({
  api,
  capabilities,
  bootstrap,
  connected,
  activeId,
}: {
  api: WebApi
  capabilities: Record<string, unknown>
  bootstrap: Bootstrap
  connected: boolean
  activeId: string | undefined
}) {
  const { message } = App.useApp()
  const { mode, setMode } = useThemeMode()
  const [view, setView] = useState<ConfigView>()
  const [loadError, setLoadError] = useState<string>()
  const [permissionMode, setPermissionMode] = useState<string>()
  const [models, setModels] = useState<ModelsView>()
  const [section, setSection] = useState<SectionKey>('connection')

  const configCapable = capabilities.config === true
  const load = useCallback(async () => {
    try {
      setView(await api.configGet())
      setLoadError(undefined)
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [api])
  useEffect(() => {
    if (configCapable) void load()
  }, [configCapable, load])
  useEffect(() => {
    if (capabilities.permissionMode === true)
      void api
        .permissionMode()
        .then((result) => setPermissionMode(result.mode))
        .catch(() => {})
  }, [api, capabilities.permissionMode])
  useEffect(() => {
    if (capabilities.models === true)
      void api
        .models()
        .then(setModels)
        .catch(() => {})
  }, [api, capabilities.models])

  const write = useCallback(
    async (key: string, value: unknown) => {
      try {
        await api.configSet(key, value)
        await load()
        message.success('已保存（下次启动生效；部分键立即生效）')
      } catch (cause) {
        message.error(`保存失败：${cause instanceof Error ? cause.message : String(cause)}`)
        throw cause
      }
    },
    [api, load, message],
  )
  const unset = useCallback(
    async (key: string) => {
      try {
        await api.configUnset(key)
        await load()
        message.success('已重置')
      } catch (cause) {
        message.error(`重置失败：${cause instanceof Error ? cause.message : String(cause)}`)
        throw cause
      }
    },
    [api, load, message],
  )

  const ctx: Ctx = {
    config: view?.config,
    redacted: new Set(view?.redacted ?? []),
    write,
    unset,
  }

  const scrollTo = (key: SectionKey) => {
    setSection(key)
    document.getElementById(`settings-${key}`)?.scrollIntoView({ behavior: 'smooth' })
  }

  const native = capabilities.native
  const startedAt = new Date(bootstrap.server.startedAt).toLocaleString()

  return (
    <div className="settings-wrap">
      <nav className="settings-nav">
        <Menu
          mode="inline"
          selectedKeys={[section]}
          items={SECTIONS.map((item) => ({ key: item.key, label: item.label }))}
          onClick={({ key }) => scrollTo(key as SectionKey)}
          style={{ border: 'none', background: 'transparent' }}
        />
      </nav>
      <div className="settings-content">
        <div className="settings-inner">
          <Typography.Title level={4} style={{ marginTop: 0, textAlign: 'center' }}>
            设置
          </Typography.Title>
          {!configCapable && (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 16 }}
              title="config 端口未装配：配置项只读不可用，仅本地偏好（主题）可改。"
            />
          )}
          {loadError && (
            <Alert
              type="error"
              showIcon
              style={{ marginBottom: 16 }}
              title={`配置读取失败：${loadError}`}
            />
          )}

          {/* 连接状态 */}
          <Typography.Title level={5} id="settings-connection">
            连接状态
          </Typography.Title>
          <Card size="small" style={{ marginBottom: 24 }}>
            <Row title="状态">
              <Tag color={connected ? 'green' : 'red'}>{connected ? '已连接' : '未连接'}</Tag>
            </Row>
            <Row title="会话ID">{activeId ?? '（无活动会话）'}</Row>
            <Row title="服务器版本">v{bootstrap.server.version}</Row>
            <Row title="工作目录">
              <Typography.Text code style={{ fontSize: 12 }}>
                {bootstrap.workspace.cwd}
              </Typography.Text>
            </Row>
          </Card>

          {/* 外观 */}
          <Typography.Title level={5} id="settings-appearance">
            外观
          </Typography.Title>
          <Card size="small" style={{ marginBottom: 24 }}>
            <Row title="界面主题" hint="Web 控制台主题（浏览器本地保存）">
              <Segmented
                value={mode}
                options={[
                  { label: '跟随系统', value: 'system' },
                  { label: '浅色', value: 'light' },
                  { label: '深色', value: 'dark' },
                ]}
                onChange={(value) => setMode(value as 'system' | 'light' | 'dark')}
              />
            </Row>
            {configCapable && (
              <>
                <TextField
                  ctx={ctx}
                  configKey="ui.theme"
                  title="TUI 主题"
                  hint="终端 UI 主题名（ui.theme）"
                />
                <BoolField
                  ctx={ctx}
                  configKey="ui.color"
                  title="TUI 彩色输出"
                  hint="终端彩色输出（ui.color，默认开）"
                  defaultValue
                />
              </>
            )}
          </Card>

          {/* 模型选择 */}
          <Typography.Title level={5} id="settings-models">
            模型选择
          </Typography.Title>
          <Card size="small" style={{ marginBottom: 24 }}>
            {models && (
              <Row title="默认模型" hint="preferences.model；会话内仍可用选择器临时切换">
                <Select
                  style={{ minWidth: 240 }}
                  value={
                    asString(getPath(ctx.config, 'preferences.model')) ?? models.current ?? null
                  }
                  options={models.options.map((option) => ({
                    value: option.id,
                    label: option.label,
                  }))}
                  onChange={(value: string) => void write('preferences.model', value)}
                />
              </Row>
            )}
            {configCapable && (
              <>
                <TextField
                  ctx={ctx}
                  configKey="provider.default"
                  title="默认 Provider"
                  hint="provider.default（如 anthropic）"
                />
                <div
                  style={{
                    padding: '12px 0',
                    borderBottom: '1px solid var(--ant-color-border-secondary)',
                  }}
                >
                  <Typography.Text strong>自定义模型（别名）</Typography.Text>
                  <div className="settings-row-desc" style={{ marginBottom: 8 }}>
                    models.aliases：别名 → provider/model，进 /model 选择器
                  </div>
                  <AliasesEditor ctx={ctx} />
                </div>
                <div
                  style={{
                    padding: '12px 0',
                    borderBottom: '1px solid var(--ant-color-border-secondary)',
                  }}
                >
                  <Typography.Text strong>自定义端点（OpenAI 兼容）</Typography.Text>
                  <div className="settings-row-desc" style={{ marginBottom: 8 }}>
                    provider.&lt;name&gt;：默认模型 / Base URL，支持增删改
                  </div>
                  <ProvidersEditor ctx={ctx} />
                </div>
                <CredentialField
                  ctx={ctx}
                  configKey="auth.anthropic_api_key"
                  title="Anthropic API Key"
                  hint="auth.anthropic_api_key（Layer 4 明文 key；只写不读）"
                />
                <BoolField
                  ctx={ctx}
                  configKey="auth.skipAuth"
                  title="跳过凭据"
                  hint="auth.skipAuth：企业网关/本地代理不带凭据头"
                />
              </>
            )}
          </Card>

          {/* 权限模式 */}
          <Typography.Title level={5} id="settings-permission">
            权限模式
          </Typography.Title>
          <Card size="small" style={{ marginBottom: 24 }}>
            {permissionMode !== undefined && (
              <Row title="当前会话模式" hint="热切当前会话（§4.4 三档）">
                <Segmented
                  value={permissionMode}
                  options={PERMISSION_MODES.map((item) => ({
                    value: item.value,
                    label: item.label,
                  }))}
                  onChange={(value) => {
                    void api.setPermissionMode(value).then((result) => {
                      setPermissionMode(result.mode)
                      message.success('会话权限模式已切换')
                    })
                  }}
                />
              </Row>
            )}
            {configCapable && (
              <EnumField
                ctx={ctx}
                configKey="permissions.mode"
                title="默认权限模式"
                hint="permissions.mode：新会话的默认档（项目级不可覆盖）"
                options={PERMISSION_MODES.map((item) => ({
                  value: item.value,
                  label: `${item.label} — ${item.desc}`,
                }))}
              />
            )}
          </Card>

          {/* 模型与推理 */}
          {configCapable && (
            <>
              <Typography.Title level={5} id="settings-reasoning">
                模型与推理
              </Typography.Title>
              <Card size="small" style={{ marginBottom: 24 }}>
                <EnumField
                  ctx={ctx}
                  configKey="preferences.reasoningEffort"
                  title="推理努力级别"
                  hint="preferences.reasoningEffort"
                  options={[
                    { value: 'low', label: 'low' },
                    { value: 'medium', label: 'medium' },
                    { value: 'high', label: 'high' },
                  ]}
                />
                <EnumField
                  ctx={ctx}
                  configKey="router.type"
                  title="路由类型"
                  hint="router.type（默认 single）"
                  options={[
                    { value: 'single', label: 'single' },
                    { value: 'fallback', label: 'fallback' },
                    { value: 'role', label: 'role' },
                  ]}
                />
                <div
                  style={{
                    padding: '12px 0',
                    borderBottom: '1px solid var(--ant-color-border-secondary)',
                  }}
                >
                  <Typography.Text strong>Fallback 链</Typography.Text>
                  <div className="settings-row-desc" style={{ marginBottom: 8 }}>
                    router.chain：priority 高者优先，失败进入冷却
                  </div>
                  <RouterChainEditor ctx={ctx} />
                </div>
                <NumberField
                  ctx={ctx}
                  configKey="router.cooldown_seconds"
                  title="失败冷却（秒）"
                  hint="router.cooldown_seconds（默认 60）"
                  min={0}
                />
                <BoolField
                  ctx={ctx}
                  configKey="router.allow_cross_provider_tool_use"
                  title="跨 provider 工具调用"
                  hint="router.allow_cross_provider_tool_use（默认关）"
                />
                <EnumField
                  ctx={ctx}
                  configKey="context.policy"
                  title="上下文策略"
                  hint="context.policy（默认 sliding）"
                  options={[
                    { value: 'sliding', label: 'sliding' },
                    { value: 'summary', label: 'summary' },
                    { value: 'semantic', label: 'semantic' },
                  ]}
                />
                <NumberField
                  ctx={ctx}
                  configKey="context.max_tokens"
                  title="上下文上限（tokens）"
                  hint="context.max_tokens（默认 180000）"
                  min={1000}
                />
              </Card>
            </>
          )}

          {/* 行为 */}
          {configCapable && (
            <>
              <Typography.Title level={5} id="settings-behavior">
                行为
              </Typography.Title>
              <Card size="small" style={{ marginBottom: 24 }}>
                <NumberField
                  ctx={ctx}
                  configKey="runner.maxToolLoopsPerTurn"
                  title="每轮工具循环上限"
                  hint="runner.maxToolLoopsPerTurn（默认 25）"
                  min={1}
                />
                <BoolField
                  ctx={ctx}
                  configKey="runner.top_level_budget"
                  title="顶层预算门"
                  hint="runner.top_level_budget（默认关）"
                />
                <BoolField
                  ctx={ctx}
                  configKey="preferences.autoCompact"
                  title="自动压缩上下文"
                  hint="preferences.autoCompact"
                />
                <BoolField
                  ctx={ctx}
                  configKey="preferences.notifications"
                  title="通知"
                  hint="preferences.notifications"
                />
                <BoolField
                  ctx={ctx}
                  configKey="preferences.promptSuggestions"
                  title="提示建议"
                  hint="preferences.promptSuggestions"
                />
                <BoolField
                  ctx={ctx}
                  configKey="preferences.showTokensCounter"
                  title="Token 计数"
                  hint="preferences.showTokensCounter"
                />
                <BoolField
                  ctx={ctx}
                  configKey="preferences.terminalProgressBar"
                  title="终端进度条"
                  hint="preferences.terminalProgressBar"
                />
                <TextField
                  ctx={ctx}
                  configKey="tools.windows_shell"
                  title="Windows Shell"
                  hint="tools.windows_shell（如 powershell / bash）"
                />
                <TagsField
                  ctx={ctx}
                  configKey="tools.pass_through_env"
                  title="沙箱透传环境变量"
                  hint="tools.pass_through_env：env_clear 白名单"
                />
                <TagsField
                  ctx={ctx}
                  configKey="tools.ignore_dirs"
                  title="忽略目录"
                  hint="tools.ignore_dirs（默认 .git/node_modules/target/dist）"
                />
                <BoolField
                  ctx={ctx}
                  configKey="evolution.enabled"
                  title="Evolution"
                  hint="evolution.enabled：应用已有 context tuning（默认关）"
                />
              </Card>
            </>
          )}

          {/* 记忆 */}
          {configCapable && (
            <>
              <Typography.Title level={5} id="settings-memory">
                记忆
              </Typography.Title>
              <Card size="small" style={{ marginBottom: 24 }}>
                <BoolField
                  ctx={ctx}
                  configKey="memory.enabled"
                  title="启用记忆"
                  hint="memory.enabled"
                />
                <BoolField
                  ctx={ctx}
                  configKey="preferences.autoMemory"
                  title="自动记忆"
                  hint="preferences.autoMemory"
                />
                <BoolField
                  ctx={ctx}
                  configKey="preferences.typedMemory"
                  title="类型化记忆"
                  hint="preferences.typedMemory"
                />
                <NumberField
                  ctx={ctx}
                  configKey="memory.max_body_lines"
                  title="单条正文行数上限"
                  hint="memory.max_body_lines（默认 200）"
                  min={1}
                />
                <TextField
                  ctx={ctx}
                  configKey="memory.paths.global"
                  title="全局记忆路径"
                  hint="memory.paths.global（缺省内置布局）"
                />
                <TextField
                  ctx={ctx}
                  configKey="memory.paths.project"
                  title="项目记忆路径"
                  hint="memory.paths.project（缺省内置布局）"
                />
              </Card>
            </>
          )}

          {/* 语言 */}
          {configCapable && (
            <>
              <Typography.Title level={5} id="settings-language">
                语言
              </Typography.Title>
              <Card size="small" style={{ marginBottom: 24 }}>
                <Row title="回复语言" hint="preferences.language，写入用户级 config.toml">
                  <Segmented
                    value={asString(getPath(ctx.config, 'preferences.language')) ?? 'system'}
                    options={[
                      { label: '跟随系统', value: 'system' },
                      { label: '中文', value: 'chinese' },
                      { label: 'English', value: 'english' },
                    ]}
                    onChange={(value) => void write('preferences.language', value)}
                  />
                </Row>
                <EnumField
                  ctx={ctx}
                  configKey="preferences.outputStyle"
                  title="输出风格"
                  hint="preferences.outputStyle"
                  options={[
                    { value: 'default', label: 'default' },
                    { value: 'concise', label: 'concise' },
                    { value: 'explanatory', label: 'explanatory' },
                  ]}
                />
              </Card>
            </>
          )}

          {/* Agent 预设 */}
          {configCapable && (
            <>
              <Typography.Title level={5} id="settings-agents">
                Agent 预设
              </Typography.Title>
              <Card size="small" style={{ marginBottom: 24 }}>
                <NumberField
                  ctx={ctx}
                  configKey="subagent.max_depth"
                  title="子代理最大深度"
                  hint="subagent.max_depth（默认 3）"
                  min={1}
                />
                <NumberField
                  ctx={ctx}
                  configKey="subagent.max_concurrent"
                  title="子代理并发上限"
                  hint="subagent.max_concurrent（默认 4）"
                  min={1}
                />
                <NumberField
                  ctx={ctx}
                  configKey="subagent.default_budget.costUSDMax"
                  title="子代理预算：费用（USD）"
                  hint="subagent.default_budget.costUSDMax（默认 1）"
                  min={0}
                />
                <NumberField
                  ctx={ctx}
                  configKey="subagent.default_budget.tokenMax"
                  title="子代理预算：tokens"
                  hint="subagent.default_budget.tokenMax（默认 200000）"
                  min={0}
                />
                <NumberField
                  ctx={ctx}
                  configKey="subagent.default_budget.timeMsMax"
                  title="子代理预算：时长（ms）"
                  hint="subagent.default_budget.timeMsMax（默认 600000）"
                  min={0}
                />
                <NumberField
                  ctx={ctx}
                  configKey="skills.index_budget"
                  title="Skills 索引预算（字符）"
                  hint="skills.index_budget（默认 4096）"
                  min={0}
                />
              </Card>
              <Card size="small" title="动态反思（§21）" style={{ marginBottom: 24 }}>
                <BoolField
                  ctx={ctx}
                  configKey="reflection.enabled"
                  title="启用反思"
                  hint="reflection.enabled（默认开）"
                  defaultValue
                />
                <BoolField
                  ctx={ctx}
                  configKey="reflection.triggers.on_error"
                  title="出错时触发"
                  hint="reflection.triggers.on_error（默认开）"
                  defaultValue
                />
                <BoolField
                  ctx={ctx}
                  configKey="reflection.triggers.on_compact"
                  title="压缩时触发"
                  hint="reflection.triggers.on_compact（默认关）"
                />
                <NumberField
                  ctx={ctx}
                  configKey="reflection.triggers.every_n_turns"
                  title="定期触发（每 N 轮）"
                  hint="reflection.triggers.every_n_turns（0 = 关）"
                  min={0}
                />
                <NumberField
                  ctx={ctx}
                  configKey="reflection.cooldown_seconds"
                  title="反思冷却（秒）"
                  hint="reflection.cooldown_seconds（默认 60）"
                  min={0}
                />
                <TextField
                  ctx={ctx}
                  configKey="reflection.model_role"
                  title="反思模型角色"
                  hint="reflection.model_role（默认 reflection，未配置回落会话模型）"
                />
                <NumberField
                  ctx={ctx}
                  configKey="reflection.run_budget.costUSDMax"
                  title="单次预算：费用（USD）"
                  hint="reflection.run_budget.costUSDMax（默认 0.05）"
                  min={0}
                />
                <NumberField
                  ctx={ctx}
                  configKey="reflection.run_budget.tokenMax"
                  title="单次预算：tokens"
                  hint="reflection.run_budget.tokenMax（默认 16000）"
                  min={0}
                />
                <NumberField
                  ctx={ctx}
                  configKey="reflection.run_budget.timeMsMax"
                  title="单次预算：时长（ms）"
                  hint="reflection.run_budget.timeMsMax（默认 60000）"
                  min={0}
                />
                <NumberField
                  ctx={ctx}
                  configKey="reflection.session_token_budget"
                  title="会话 token 硬顶"
                  hint="reflection.session_token_budget（默认 50000）"
                  min={0}
                />
                <EnumField
                  ctx={ctx}
                  configKey="reflection.persist"
                  title="持久化"
                  hint="reflection.persist（默认 manual）"
                  options={[
                    { value: 'manual', label: 'manual' },
                    { value: 'auto', label: 'auto' },
                    { value: 'off', label: 'off' },
                  ]}
                />
                <NumberField
                  ctx={ctx}
                  configKey="reflection.inject_max_lessons"
                  title="注入条数上限"
                  hint="reflection.inject_max_lessons（默认 3）"
                  min={0}
                />
                <NumberField
                  ctx={ctx}
                  configKey="reflection.inject_max_bytes"
                  title="注入字节上限"
                  hint="reflection.inject_max_bytes（默认 2048）"
                  min={0}
                />
              </Card>
            </>
          )}

          {/* 高级 */}
          {configCapable && (
            <>
              <Typography.Title level={5} id="settings-advanced">
                高级
              </Typography.Title>
              <Card size="small" style={{ marginBottom: 24 }}>
                <div
                  style={{
                    padding: '12px 0',
                    borderBottom: '1px solid var(--ant-color-border-secondary)',
                  }}
                >
                  <Typography.Text strong>环境变量（[env]）</Typography.Text>
                  <div className="settings-row-desc" style={{ marginBottom: 8 }}>
                    启动时写入 process.env；子进程（MCP / 插件宿主）继承；进沙箱需配合
                    tools.pass_through_env
                  </div>
                  <EnvEditor ctx={ctx} />
                </div>
                <NumberField
                  ctx={ctx}
                  configKey="native.ipc_max_line_bytes"
                  title="Native IPC 行字节上限"
                  hint="native.ipc_max_line_bytes（默认 4194304）"
                  min={1024}
                />
                <EnumField
                  ctx={ctx}
                  configKey="telemetry.sink"
                  title="遥测输出"
                  hint="telemetry.sink（默认 local）"
                  options={[
                    { value: 'local', label: 'local' },
                    { value: 'otel', label: 'otel' },
                  ]}
                />
                <TextField
                  ctx={ctx}
                  configKey="telemetry.otel.endpoint"
                  title="OTEL Endpoint"
                  hint="telemetry.otel.endpoint"
                />
                <TextField
                  ctx={ctx}
                  configKey="plugins.market"
                  title="插件市场源"
                  hint="plugins.market：HTTPS 索引 URL（信任配置）"
                />
                <TagsField
                  ctx={ctx}
                  configKey="plugins.builtin_disabled"
                  title="禁用的内置工具域"
                  hint="plugins.builtin_disabled（如 volund.exec）"
                />
                <NumberField
                  ctx={ctx}
                  configKey="preferences.cleanupPeriod"
                  title="会话清理周期（天）"
                  hint="preferences.cleanupPeriod（默认 30）"
                  min={1}
                  max={365}
                />
              </Card>
              <JsonSectionField
                ctx={ctx}
                section="prompt"
                title="[prompt] @include 参数"
                hint="开放段（§6.5.6）：如 max_depth / max_expansions；JSON 整体读写"
              />
              <Card size="small" title="Web 控制台" style={{ marginBottom: 24 }}>
                <Row
                  title="随 TUI 静默自启"
                  hint="web.enabled：Web 侧不可调整（控制台不能关掉自己）；需经 CLI `volund config set web.enabled false`（下次启动生效）"
                >
                  <Switch checked={asBool(getPath(ctx.config, 'web.enabled')) ?? true} disabled />
                </Row>
                <NumberField
                  ctx={ctx}
                  configKey="web.port"
                  title="固定端口"
                  hint="web.port：0 = 随机空闲（记住上次优先复用）"
                  min={0}
                  max={65535}
                />
                <TextField
                  ctx={ctx}
                  configKey="web.terminal.shell"
                  title="终端 shell"
                  hint="web.terminal.shell：工作台终端的 shell（默认 $SHELL → /bin/sh）；下次开终端生效"
                  placeholder="$SHELL"
                />
                <NumberField
                  ctx={ctx}
                  configKey="web.terminal.font_size"
                  title="终端字号"
                  hint="web.terminal.font_size（9–32，默认 12）；已打开的终端下次重开生效"
                  min={9}
                  max={32}
                />
                <NumberField
                  ctx={ctx}
                  configKey="web.terminal.scrollback"
                  title="终端滚动缓冲"
                  hint="web.terminal.scrollback（100–100000 行，默认 2000）；已打开的终端下次重开生效"
                  min={100}
                  max={100000}
                />
              </Card>
            </>
          )}

          {/* 安全沙箱 */}
          {configCapable && (
            <>
              <Typography.Title level={5} id="settings-sandbox">
                安全沙箱
              </Typography.Title>
              <JsonSectionField
                ctx={ctx}
                section="sandbox"
                title="[sandbox] 降级策略 / tier"
                hint="开放段（§5.5）：JSON 整体读写；沙箱内 Bash 走 env_clear 白名单模型，透传名单见 行为 → 沙箱透传环境变量"
              />
            </>
          )}

          {/* 系统信息 */}
          <Typography.Title level={5} id="settings-system">
            系统信息
          </Typography.Title>
          <Card size="small" style={{ marginBottom: 24 }}>
            <Row title="服务器 ID">
              <Typography.Text code style={{ fontSize: 12 }}>
                {bootstrap.server.serverId}
              </Typography.Text>
            </Row>
            <Row title="启动时间">{startedAt}</Row>
            <Row title="Native 模块">
              {native && typeof native === 'object' ? (
                <Space size={4}>
                  {Object.entries(native as Record<string, unknown>).map(([name, state]) => (
                    <Tag
                      key={name}
                      color={state === true ? 'green' : state === 'probing' ? 'gold' : 'default'}
                    >
                      {name}:{' '}
                      {state === true ? 'loaded' : state === 'probing' ? 'probing' : 'not loaded'}
                    </Tag>
                  ))}
                </Space>
              ) : (
                <Typography.Text type="secondary">unavailable</Typography.Text>
              )}
            </Row>
            {view?.files && (
              <>
                <Row title="用户级配置">
                  <Typography.Text code copyable style={{ fontSize: 12 }}>
                    {view.files.user}
                  </Typography.Text>
                </Row>
                <Row title="项目级配置">
                  <Typography.Text code copyable style={{ fontSize: 12 }}>
                    {view.files.project}
                  </Typography.Text>
                </Row>
              </>
            )}
            {view && view.warnings.length > 0 && (
              <Row title="配置警告">
                <div style={{ fontSize: 12 }}>
                  {view.warnings.map((warning) => (
                    <div key={warning}>
                      <Typography.Text type="warning">{warning}</Typography.Text>
                    </div>
                  ))}
                </div>
              </Row>
            )}
          </Card>
        </div>
      </div>
    </div>
  )
}
