'use client'

import { DeleteOutlined, FolderOpenOutlined, UploadOutlined } from '@ant-design/icons'
import {
  App,
  Button,
  Form,
  Input,
  Popconfirm,
  Select,
  Space,
  Table,
  Tabs,
  Typography,
} from 'antd'
import { useEffect, useRef, useState } from 'react'

import { useI18n } from './Providers'

const TOKEN_STORAGE_KEY = 'apollo-market-admin-token'

function useToken() {
  const [token, setToken] = useState('')
  useEffect(() => {
    setToken(window.localStorage.getItem(TOKEN_STORAGE_KEY) ?? '')
  }, [])
  const save = (value: string) => {
    setToken(value)
    window.localStorage.setItem(TOKEN_STORAGE_KEY, value)
  }
  return { token, save }
}

const authHeaders = (token: string): HeadersInit =>
  token ? { authorization: `Bearer ${token}` } : {}

async function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result)
      resolve(result.slice(result.indexOf(',') + 1))
    }
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

/** 发布插件：webkitdirectory 目录选择 → 相对路径 + base64 → POST /api/v1/plugins。 */
function PluginPublishTab({ token }: { token: string }) {
  const { message } = App.useApp()
  const { t } = useI18n()
  const inputRef = useRef<HTMLInputElement>(null)
  const [publisher, setPublisher] = useState('')
  const [readme, setReadme] = useState('')
  const [files, setFiles] = useState<readonly { path: string; contentBase64: string }[]>([])
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const input = inputRef.current
    if (input) input.setAttribute('webkitdirectory', '')
  }, [])

  const onPickFolder = async (fileList: FileList) => {
    const picked: { path: string; contentBase64: string }[] = []
    for (const file of Array.from(fileList)) {
      const relative = (file.webkitRelativePath || '').split('/').slice(1).join('/')
      if (!relative) continue
      if (/(^|\/)(node_modules|\.git|dist|\.next)(\/|$)/.test(relative)) continue
      picked.push({ path: relative, contentBase64: await readAsBase64(file) })
    }
    setFiles(picked)
  }

  const publish = async () => {
    if (files.length === 0) {
      message.warning(t['admin.selectFolder'])
      return
    }
    setBusy(true)
    try {
      const response = await fetch('/api/v1/plugins', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders(token) },
        body: JSON.stringify({
          files,
          ...(publisher ? { publisher } : {}),
          ...(readme ? { readme } : {}),
        }),
      })
      const data = (await response.json()) as {
        ok?: boolean
        name?: string
        version?: string
        error?: string
      }
      if (response.ok) message.success(`${data.name}@${data.version}`)
      else message.error(`${t['admin.publishFailed']}：${data.error ?? response.status}`)
    } catch (error) {
      message.error(`${t['admin.publishFailed']}：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Space orientation="vertical" size={16} style={{ width: '100%' }}>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
        {t['admin.publishHint']}
      </Typography.Paragraph>
      <Space wrap>
        <input
          ref={inputRef}
          type="file"
          multiple
          style={{ display: 'none' }}
          onChange={(event) => {
            if (event.target.files) void onPickFolder(event.target.files)
          }}
        />
        <Button icon={<FolderOpenOutlined />} onClick={() => inputRef.current?.click()}>
          {t['admin.selectFolder']}
        </Button>
        <Typography.Text type="secondary">
          {files.length} {t['admin.fileUnit']}
        </Typography.Text>
      </Space>
      {files.length > 0 ? (
        <Table
          size="small"
          rowKey="path"
          pagination={{ pageSize: 8 }}
          dataSource={files.map((file) => ({ ...file }))}
          columns={[
            { title: t['admin.table.path'], dataIndex: 'path' },
            {
              title: t['admin.table.size'],
              dataIndex: 'contentBase64',
              width: 120,
              render: (value: string) => `${Math.round((value.length * 3) / 4 / 1024)} KB`,
            },
          ]}
        />
      ) : undefined}
      <Space wrap>
        <Input
          placeholder={t['admin.publisher']}
          style={{ width: 200 }}
          value={publisher}
          onChange={(event) => setPublisher(event.target.value)}
        />
        <Button
          type="primary"
          icon={<UploadOutlined />}
          loading={busy}
          onClick={() => void publish()}
        >
          {t['admin.publish']}
        </Button>
      </Space>
      <Input.TextArea
        placeholder={t['admin.readme']}
        autoSize={{ minRows: 3, maxRows: 10 }}
        value={readme}
        onChange={(event) => setReadme(event.target.value)}
      />
    </Space>
  )
}

interface CatalogItem {
  name: string
  description?: string
  version?: string
  source?: string
  transport?: string
  addedAt?: string
}

function CatalogTab({
  kind,
  token,
  formFields,
}: {
  kind: 'skills' | 'mcp'
  token: string
  formFields: React.ReactNode
}) {
  const { message } = App.useApp()
  const { t } = useI18n()
  const [form] = Form.useForm()
  const [items, setItems] = useState<readonly CatalogItem[]>([])

  const load = async () => {
    const response = await fetch(`/api/v1/${kind}?pageSize=50`)
    const data = (await response.json()) as { items?: CatalogItem[] }
    setItems(data.items ?? [])
  }
  useEffect(() => {
    void load()
  }, [])

  const submit = async (values: Record<string, unknown>) => {
    const body: Record<string, unknown> = { ...values }
    if (typeof body.args === 'string')
      body.args = String(body.args)
        .split(/\s+/)
        .filter(Boolean)
    const response = await fetch(`/api/v1/${kind}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(token) },
      body: JSON.stringify(body),
    })
    const data = (await response.json()) as { error?: string; updated?: boolean }
    if (response.ok) {
      message.success(data.updated ? t['admin.updated'] : t['admin.added'])
      form.resetFields()
      await load()
    } else message.error(`${t['admin.addFailed']}：${data.error ?? response.status}`)
  }

  const remove = async (name: string) => {
    const response = await fetch(`/api/v1/${kind}/${name}`, {
      method: 'DELETE',
      headers: authHeaders(token),
    })
    const data = (await response.json()) as { error?: string }
    if (response.ok) {
      message.success(t['admin.deleted'])
      await load()
    } else message.error(`${t['admin.deleteFailed']}：${data.error ?? response.status}`)
  }

  return (
    <Space orientation="vertical" size={24} style={{ width: '100%' }}>
      <Form
        form={form}
        layout="vertical"
        style={{ maxWidth: 640 }}
        onFinish={(values) => void submit(values)}
      >
        {formFields}
        <Button type="primary" htmlType="submit">
          {t['admin.add']}
        </Button>
      </Form>
      <Table
        size="small"
        rowKey="name"
        pagination={false}
        dataSource={items.map((item) => ({ ...item }))}
        columns={[
          { title: t['admin.name'], dataIndex: 'name' },
          { title: t['admin.version'], dataIndex: 'version', width: 90 },
          { title: t['admin.desc'], dataIndex: 'description', ellipsis: true },
          kind === 'skills'
            ? { title: t['admin.table.source'], dataIndex: 'source', ellipsis: true }
            : {
                title: 'transport',
                dataIndex: 'transport',
                width: 100,
                render: (value: string) => <Typography.Text code>{value}</Typography.Text>,
              },
          {
            title: t['admin.table.actions'],
            width: 80,
            render: (_, record: CatalogItem) => (
              <Popconfirm
                title={`${t['admin.table.delete']} ${record.name}?`}
                onConfirm={() => void remove(record.name)}
              >
                <Button danger size="small" icon={<DeleteOutlined />} />
              </Popconfirm>
            ),
          },
        ]}
      />
    </Space>
  )
}

export default function AdminPanel() {
  const { token, save } = useToken()
  const { t } = useI18n()
  const skillForm = (
    <>
      <Form.Item
        name="name"
        label={t['admin.name']}
        rules={[
          { required: true },
          { pattern: /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, message: t['admin.nameRule'] },
        ]}
      >
        <Input placeholder="xlsx" />
      </Form.Item>
      <Form.Item name="source" label={t['admin.source']} rules={[{ required: true }]}>
        <Input placeholder="https://github.com/anthropics/skills/tree/main/skills/xlsx" />
      </Form.Item>
      <Form.Item name="version" label={t['admin.versionSkill']}>
        <Input placeholder="1.0.0" />
      </Form.Item>
      <Form.Item name="description" label={t['admin.desc']}>
        <Input placeholder="Excel 电子表格处理" />
      </Form.Item>
      <Form.Item name="homepage" label={t['admin.homepage']}>
        <Input placeholder="https://github.com/…" />
      </Form.Item>
    </>
  )
  const mcpForm = (
    <>
      <Form.Item name="name" label={t['admin.name']} rules={[{ required: true }]}>
        <Input placeholder="filesystem" />
      </Form.Item>
      <Form.Item name="transport" label={t['admin.transport']} rules={[{ required: true }]} initialValue="stdio">
        <Select
          options={[
            { value: 'stdio', label: 'stdio（本地进程）' },
            { value: 'http', label: 'http（远程 URL）' },
          ]}
        />
      </Form.Item>
      <Form.Item noStyle shouldUpdate={(prev, next) => prev.transport !== next.transport}>
        {({ getFieldValue }) =>
          getFieldValue('transport') === 'http' ? (
            <Form.Item name="url" label="URL" rules={[{ required: true }]}>
              <Input placeholder="https://mcp.example.com/mcp" />
            </Form.Item>
          ) : (
            <>
              <Form.Item name="command" label={t['admin.command']} rules={[{ required: true }]}>
                <Input placeholder="npx" />
              </Form.Item>
              <Form.Item name="args" label={t['admin.args']}>
                <Input placeholder="-y @modelcontextprotocol/server-filesystem ." />
              </Form.Item>
            </>
          )
        }
      </Form.Item>
      <Form.Item name="version" label={t['admin.versionPlain']}>
        <Input placeholder="1.0.0" />
      </Form.Item>
      <Form.Item name="description" label={t['admin.desc']}>
        <Input placeholder="官方文件系统 MCP" />
      </Form.Item>
    </>
  )

  return (
    <div>
      <p className="mk-eyebrow">
        <span className="mk-dot" />
        publisher console
      </p>
      <h1 className="mk-display">{t['admin.title']}</h1>
      <Space orientation="vertical" size={8} style={{ width: '100%', marginBottom: 20 }}>
        <Input.Password
          placeholder={t['admin.tokenPlaceholder']}
          style={{ maxWidth: 420 }}
          value={token}
          onChange={(event) => save(event.target.value)}
        />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {t['admin.tokenNote']}
        </Typography.Text>
      </Space>
      <Tabs
        items={[
          { key: 'plugins', label: t['admin.tab.plugin'], children: <PluginPublishTab token={token} /> },
          { key: 'skills', label: t['admin.tab.skills'], children: <CatalogTab kind="skills" token={token} formFields={skillForm} /> },
          { key: 'mcp', label: t['admin.tab.mcp'], children: <CatalogTab kind="mcp" token={token} formFields={mcpForm} /> },
        ]}
      />
    </div>
  )
}
