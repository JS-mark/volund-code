'use client'

/**
 * 工作台（右侧栏，对齐 CodeBuddy web 的 workbench）：
 * - 空态：「打开工作区工具」五入口（资源管理器/打开文件/搜索/源代码管理/终端⌘J）；
 * - 打开的工具以可关闭标签页承载（全部保活——终端切走不杀 shell）；
 * - 资源管理器是懒加载文件树，点文件开查看器（可编辑保存）；
 * - 终端是 xterm.js + WebSocket 交互式 shell（服务端 expect/script 提供 PTY）；
 * - 左缘拖拽调宽（320..720px）。
 */
import '@xterm/xterm/css/xterm.css'
import {
  CloseOutlined,
  EditOutlined,
  FileOutlined,
  FolderOutlined,
  ForkOutlined,
  PlusOutlined,
  ReloadOutlined,
  SearchOutlined,
} from '@ant-design/icons'
import { App, Button, Dropdown, Empty, Input, Spin, Tabs, Tag, Tooltip, Typography } from 'antd'
import { useCallback, useEffect, useRef, useState } from 'react'

import type { WbGitStatus, WbMatch, WebApi } from '../lib/api'
import { FileTree } from './FileTree'
import { QuickOpenModal } from './QuickOpenModal'

type ToolKind = 'explorer' | 'search' | 'git' | 'terminal'

interface ToolTab {
  key: string
  kind: ToolKind | 'file' | 'diff'
  title: string
  path?: string
  line?: number
}

const TOOL_DEFS: { kind: ToolKind; title: string; icon: React.ReactNode }[] = [
  { kind: 'explorer', title: '资源管理器', icon: <FolderOutlined /> },
  { kind: 'search', title: '搜索', icon: <SearchOutlined /> },
  { kind: 'git', title: '源代码管理', icon: <ForkOutlined /> },
  { kind: 'terminal', title: '终端', icon: <TerminalIcon /> },
]

/** 终端图标（antd 无终端图标，按参考图手绘：显示器 + >_）。 */
function TerminalIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="1em"
      height="1em"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.3}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="1.6" y="2.6" width="12.8" height="10.8" rx="1.6" />
      <path d="M4.4 5.8l2.4 2.2-2.4 2.2M7.8 10.4h3.4" />
    </svg>
  )
}

const wbIconProps = {
  viewBox: '0 0 16 16',
  width: '1em',
  height: '1em',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.3,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const

/** 新建对话图标（气泡 + 加号，对齐参考图）。 */
export function NewChatIcon() {
  return (
    <svg {...wbIconProps}>
      <path d="M8 2.2c-3.5 0-6.2 2.2-6.2 5 0 1.6.9 3 2.3 4l-.5 2.6 2.5-1.2c.6.1 1.2.2 1.9.2" />
      <path d="M11 9.4v4.4M8.8 11.6h4.4" />
      <circle cx="11" cy="11.6" r="3.4" />
    </svg>
  )
}

/** 工作台图标（右侧面板，对齐参考图）。 */
export function WorkbenchIcon() {
  return (
    <svg {...wbIconProps}>
      <rect x="1.6" y="2.8" width="12.8" height="10.4" rx="1.6" />
      <path d="M9.8 2.8v10.4M11.6 6h1M11.6 8h1" />
    </svg>
  )
}

const toolTitle = (kind: ToolKind): string => TOOL_DEFS.find((tool) => tool.kind === kind)!.title

// ── 资源管理器：共享懒加载文件树(见 FileTree.tsx)──────────────────────

// ── 内容搜索 ───────────────────────────────────────────────────────────
function SearchPanel({
  api,
  onOpenFile,
}: {
  api: WebApi
  onOpenFile(path: string, line: number): void
}) {
  const { message } = App.useApp()
  const [query, setQuery] = useState('')
  const [matches, setMatches] = useState<WbMatch[]>([])
  const [truncated, setTruncated] = useState(false)
  const [searched, setSearched] = useState(false)
  const [running, setRunning] = useState(false)

  const run = () => {
    const needle = query.trim()
    if (!needle || running) return
    setRunning(true)
    void api
      .wbSearch(needle)
      .then((result) => {
        setMatches(result.matches)
        setTruncated(result.truncated)
        setSearched(true)
      })
      .catch((cause) => message.error(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setRunning(false))
  }

  // 按文件分组渲染（保持服务端返回顺序）。
  const groups: { path: string; items: WbMatch[] }[] = []
  for (const match of matches) {
    const last = groups.at(-1)
    if (last && last.path === match.path) last.items.push(match)
    else groups.push({ path: match.path, items: [match] })
  }

  return (
    <div className="wb-pane">
      <Input.Search
        placeholder="搜索文件内容"
        enterButton
        loading={running}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onSearch={run}
      />
      {truncated && (
        <Typography.Text type="warning" style={{ display: 'block', fontSize: 12, marginTop: 6 }}>
          结果过多，仅展示前 200 条
        </Typography.Text>
      )}
      {searched && matches.length === 0 && (
        <Empty description="没有匹配内容" style={{ marginTop: 32 }} />
      )}
      {groups.map((group) => (
        <div key={group.path} className="wb-search-group">
          <div className="wb-search-file">{group.path}</div>
          {group.items.map((item) => (
            <div
              key={`${item.path}:${item.line}:${item.text}`}
              className="wb-search-line"
              onClick={() => onOpenFile(item.path, item.line)}
            >
              <span className="wb-search-lineno">{item.line}</span>
              <span className="wb-search-text">{item.text}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

// ── 源代码管理 ─────────────────────────────────────────────────────────
function GitPanel({ api, onOpenDiff }: { api: WebApi; onOpenDiff(path: string): void }) {
  const { message } = App.useApp()
  const [status, setStatus] = useState<WbGitStatus>()
  const refresh = useCallback(() => {
    void api
      .wbGitStatus()
      .then(setStatus)
      .catch((cause) => message.error(cause instanceof Error ? cause.message : String(cause)))
  }, [api, message])
  useEffect(() => refresh(), [refresh])

  const statusLabel = (entry: WbGitStatus['entries'][number]): string => {
    const code = `${entry.x}${entry.y}`.trim()
    return code === '??' ? 'U' : code || '·'
  }

  return (
    <div className="wb-pane">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <ForkOutlined />
        <Typography.Text strong style={{ flex: 1 }}>
          {status?.branch ?? '…'}
        </Typography.Text>
        <Button size="small" type="text" icon={<ReloadOutlined />} onClick={refresh} title="刷新" />
      </div>
      {status === undefined ? (
        <Spin size="small" style={{ display: 'block', margin: '24px auto' }} />
      ) : !status.isRepo ? (
        <Empty description="当前工作区不是 git 仓库" style={{ marginTop: 32 }} />
      ) : status.entries.length === 0 ? (
        <Empty description="工作区干净，没有变更" style={{ marginTop: 32 }} />
      ) : (
        status.entries.map((entry) => (
          <div
            key={`${entry.x}${entry.y}:${entry.path}`}
            className="wb-git-item"
            onClick={() => onOpenDiff(entry.path)}
          >
            <Tag style={{ marginRight: 8 }}>{statusLabel(entry)}</Tag>
            <Typography.Text ellipsis style={{ flex: 1, minWidth: 0, fontSize: 12 }}>
              {entry.origPath ? `${entry.origPath} → ${entry.path}` : entry.path}
            </Typography.Text>
          </div>
        ))
      )}
    </div>
  )
}

// ── git diff 视图 ──────────────────────────────────────────────────────
function DiffPanel({ api, path }: { api: WebApi; path?: string }) {
  const { message } = App.useApp()
  const [diff, setDiff] = useState<string>()
  useEffect(() => {
    void api
      .wbGitDiff(path)
      .then((result) => setDiff(result.diff))
      .catch((cause) => message.error(cause instanceof Error ? cause.message : String(cause)))
  }, [api, path, message])
  if (diff === undefined)
    return <Spin size="small" style={{ display: 'block', margin: '24px auto' }} />
  if (!diff.trim()) return <Empty description="没有可展示的 diff" style={{ marginTop: 32 }} />
  return (
    <pre className="wb-diff">
      {diff.split('\n').map((line, index) => (
        <div
          key={index}
          className={
            line.startsWith('+') && !line.startsWith('+++')
              ? 'wb-diff-add'
              : line.startsWith('-') && !line.startsWith('---')
                ? 'wb-diff-del'
                : line.startsWith('@@')
                  ? 'wb-diff-hunk'
                  : undefined
          }
        >
          {line}
        </div>
      ))}
    </pre>
  )
}

// ── 文件查看器（可编辑保存）─────────────────────────────────────────────
function FilePanel({ api, path, line }: { api: WebApi; path: string; line?: number }) {
  const { message } = App.useApp()
  const [file, setFile] = useState<{ content: string; binary: boolean; truncated: boolean }>()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setEditing(false)
    void api
      .wbReadFile(path)
      .then((result) => {
        setFile(result)
        setDraft(result.content)
      })
      .catch((cause) => {
        setFile(undefined)
        message.error(cause instanceof Error ? cause.message : String(cause))
      })
  }, [api, path, message])

  // 搜索跳转：渲染后滚动到目标行（行高固定 19px 与 css 对齐）。
  useEffect(() => {
    if (!line || !file || editing) return
    const target = bodyRef.current?.querySelector(`[data-line="${line}"]`)
    target?.scrollIntoView({ block: 'center' })
  }, [file, line, editing])

  if (!file) return <Spin size="small" style={{ display: 'block', margin: '24px auto' }} />
  if (file.binary) return <Empty description="二进制文件不支持预览" style={{ marginTop: 32 }} />

  const save = async () => {
    setSaving(true)
    try {
      await api.wbWriteFile(path, draft)
      setFile({ ...file, content: draft })
      setEditing(false)
      message.success('已保存')
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="wb-pane wb-file">
      <div className="wb-file-bar">
        <Typography.Text type="secondary" ellipsis style={{ flex: 1, minWidth: 0, fontSize: 12 }}>
          {path}
          {file.truncated ? '（过大已截断）' : ''}
        </Typography.Text>
        {editing ? (
          <>
            <Button size="small" type="primary" loading={saving} onClick={() => void save()}>
              保存
            </Button>
            <Button size="small" onClick={() => setEditing(false)}>
              取消
            </Button>
          </>
        ) : (
          <Button size="small" type="text" icon={<EditOutlined />} onClick={() => setEditing(true)}>
            编辑
          </Button>
        )}
      </div>
      {editing ? (
        <Input.TextArea
          className="wb-file-editor"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          autoSize={{ minRows: 12 }}
        />
      ) : (
        <div className="wb-file-body" ref={bodyRef}>
          {file.content.split('\n').map((text, index) => (
            <div
              key={index}
              data-line={index + 1}
              className={index + 1 === line ? 'wb-file-line wb-file-line-hit' : 'wb-file-line'}
            >
              <span className="wb-file-lineno">{index + 1}</span>
              <span>{text}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── 终端：xterm.js + WebSocket 交互式 shell（服务端 expect/script 提供 PTY）──
function TerminalPanel({ api }: { api: WebApi }) {
  const hostRef = useRef<HTMLDivElement>(null)
  // 退出/断线后按任意键重开：generation 递增 → effect 重建整个会话。
  const [generation, setGeneration] = useState(0)

  useEffect(() => {
    let disposed = false
    let cleanup: (() => void) | undefined
    void (async () => {
      // 动态导入：xterm 不进主 chunk（本地 loopback 无所谓体积，但首屏更快）。
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
      ])
      if (disposed || !hostRef.current) return
      const host = hostRef.current
      // antd v6 的 cssVar 挂在 .ant-app 作用域类上（不在 :root/body）——
      // 必须从作用域内的元素读，getComputedStyle(body) 拿到的是空串。
      const readTheme = () => {
        const style = getComputedStyle(host)
        return {
          bg: style.getPropertyValue('--ant-color-bg-base').trim(),
          fg: style.getPropertyValue('--ant-color-text-base').trim(),
          font: style.getPropertyValue('--ant-font-family-code').trim(),
        }
      }
      // [web.terminal] 设置（合并配置；未配置/读失败 → 默认）。
      const config = await api.configGet().catch(() => undefined)
      const termCfg = (
        config?.config?.['web'] as { terminal?: Record<string, unknown> } | undefined
      )?.terminal
      const fontSize =
        typeof termCfg?.['font_size'] === 'number' ? (termCfg['font_size'] as number) : 12
      const scrollback =
        typeof termCfg?.['scrollback'] === 'number' ? (termCfg['scrollback'] as number) : 2000

      const theme = readTheme()
      // xterm 默认 cursor 是固定白色：只设 background/foreground 会在浅色主题下
      // 白光标落在白底上不可见——cursor 跟随前景色、cursorAccent 跟随背景色。
      const xtermTheme = (value: { bg: string; fg: string }) => ({
        ...(value.bg ? { background: value.bg, cursorAccent: value.bg } : {}),
        ...(value.fg ? { foreground: value.fg, cursor: value.fg } : {}),
      })
      const term = new Terminal({
        cursorBlink: true,
        fontSize,
        scrollback,
        ...(theme.font ? { fontFamily: theme.font } : {}),
        theme: xtermTheme(theme),
      })
      const fit = new FitAddon()
      term.loadAddon(fit)
      term.open(host)
      fit.fit()
      term.focus()

      // 主题切换（亮/暗）实时跟随：antd 的 cssVar 更新与 data-theme 赋值在同一
      // React commit，立刻读可能拿到旧值——延迟一帧（宏任务，不依赖 rAF）再读。
      const themeObserver = new MutationObserver(() => {
        setTimeout(() => {
          term.options.theme = xtermTheme(readTheme())
        }, 50)
      })
      themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-theme'],
      })

      let exited = false
      const ws = new WebSocket(`ws://${window.location.host}/api/v1/workbench/terminal/ws`)
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
      }
      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(String(event.data)) as { type?: string; data?: string }
          if (msg.type === 'out' && typeof msg.data === 'string') term.write(msg.data)
          else if (msg.type === 'exit') {
            exited = true
            term.write('\r\n\x1b[2m[进程已退出 — 按任意键重开]\x1b[0m\r\n')
          }
        } catch {
          // 非 JSON 帧忽略
        }
      }
      ws.onclose = () => {
        if (!exited) {
          exited = true
          term.write('\r\n\x1b[2m[连接已断开 — 按任意键重连]\x1b[0m\r\n')
        }
      }
      const dataSub = term.onData((data) => {
        if (exited) {
          setGeneration((value) => value + 1)
          return
        }
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'in', data }))
      })
      const observer = new ResizeObserver(() => {
        fit.fit()
        if (ws.readyState === WebSocket.OPEN)
          ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
      })
      observer.observe(host)
      cleanup = () => {
        dataSub.dispose()
        observer.disconnect()
        themeObserver.disconnect()
        ws.close()
        term.dispose()
      }
    })()
    return () => {
      disposed = true
      cleanup?.()
    }
  }, [api, generation])

  return <div className="wb-xterm" ref={hostRef} />
}

// ── 工作台面板本体 ─────────────────────────────────────────────────────
export function WorkbenchPanel({
  api,
  terminalSignal,
  onClose,
}: {
  api: WebApi
  /** AppShell 的 ⌘J 信号：递增即打开/聚焦终端标签页。 */
  terminalSignal: number
  onClose(): void
}) {
  const [tabs, setTabs] = useState<ToolTab[]>([])
  const [activeKey, setActiveKey] = useState<string>()
  const [quickOpen, setQuickOpen] = useState(false)
  const [width, setWidth] = useState(400)

  const activate = useCallback((tab: ToolTab) => {
    setTabs((current) =>
      current.some((item) => item.key === tab.key) ? current : [...current, tab],
    )
    setActiveKey(tab.key)
  }, [])

  const openTool = useCallback(
    (kind: ToolKind) => activate({ key: kind, kind, title: toolTitle(kind) }),
    [activate],
  )
  const openFile = useCallback(
    (path: string, line?: number) =>
      activate({
        key: `file:${path}`,
        kind: 'file',
        title: path.split('/').pop() ?? path,
        path,
        ...(line !== undefined ? { line } : {}),
      }),
    [activate],
  )
  const openDiff = useCallback(
    (path: string) =>
      activate({
        key: `diff:${path}`,
        kind: 'diff',
        title: `diff: ${path.split('/').pop()}`,
        path,
      }),
    [activate],
  )

  // ⌘J（AppShell 全局快捷键）：打开/聚焦终端标签页。
  useEffect(() => {
    if (terminalSignal > 0) openTool('terminal')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminalSignal])

  const closeTab = (key: string) => {
    setTabs((current) => {
      const next = current.filter((tab) => tab.key !== key)
      if (activeKey === key) setActiveKey(next.at(-1)?.key)
      return next
    })
  }

  // 左缘拖拽调宽。
  const startResize = (event: React.MouseEvent) => {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = width
    const onMove = (move: MouseEvent) => {
      const next = Math.min(720, Math.max(320, startWidth + (startX - move.clientX)))
      setWidth(next)
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const active = tabs.find((tab) => tab.key === activeKey)

  return (
    <aside className="workbench" style={{ width }}>
      <div className="workbench-resize" onMouseDown={startResize} title="调整工作台宽度" />
      <div className="workbench-head">
        <Typography.Text strong>工作台</Typography.Text>
        <span style={{ flex: 1 }} />
        <Dropdown
          trigger={['click']}
          placement="bottomRight"
          menu={{
            items: [
              ...TOOL_DEFS.map((tool) => ({ key: tool.kind, label: tool.title, icon: tool.icon })),
              { key: 'open-file', label: '打开文件', icon: <FileOutlined /> },
            ],
            onClick: ({ key }) => {
              if (key === 'open-file') setQuickOpen(true)
              else openTool(key as ToolKind)
            },
          }}
        >
          <Button size="small" type="text" icon={<PlusOutlined />} title="打开工作区工具" />
        </Dropdown>
        <Tooltip title="收起工作台">
          <Button size="small" type="text" icon={<CloseOutlined />} onClick={onClose} />
        </Tooltip>
      </div>
      {tabs.length > 0 && (
        <Tabs
          className="workbench-tabs"
          size="small"
          type="editable-card"
          hideAdd
          {...(activeKey !== undefined ? { activeKey } : {})}
          items={tabs.map((tab) => ({ key: tab.key, label: tab.title, closable: true }))}
          onChange={setActiveKey}
          onEdit={(key, action) => {
            if (action === 'remove' && typeof key === 'string') closeTab(key)
          }}
        />
      )}
      <div className="workbench-body">
        {!active ? (
          <div className="workbench-empty">
            <Typography.Title level={5} style={{ marginBottom: 4 }}>
              打开工作区工具
            </Typography.Title>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              选择资源管理器、文件搜索、源代码管理、文件或终端
            </Typography.Text>
            <div className="workbench-tools">
              {TOOL_DEFS.slice(0, 1).map((tool) => (
                <Button key={tool.kind} icon={tool.icon} onClick={() => openTool(tool.kind)}>
                  {tool.title}
                </Button>
              ))}
              <Button icon={<FileOutlined />} onClick={() => setQuickOpen(true)}>
                打开文件
              </Button>
              {TOOL_DEFS.slice(1).map((tool) => (
                <Button key={tool.kind} icon={tool.icon} onClick={() => openTool(tool.kind)}>
                  {tool.title}
                  {tool.kind === 'terminal' && <span className="wb-kbd">⌘J</span>}
                </Button>
              ))}
            </div>
          </div>
        ) : null}
        {/* 已打开的标签页全部保活（display 隐藏非活跃）——终端切走不能杀 shell。 */}
        {tabs.map((tab) => (
          <div
            key={tab.key}
            style={{
              display: tab.key === activeKey ? 'flex' : 'none',
              flexDirection: 'column',
              flex: 1,
              minHeight: 0,
            }}
          >
            {tab.kind === 'explorer' ? (
              <div className="wb-pane">
                <FileTree api={api} onOpenFile={openFile} />
              </div>
            ) : tab.kind === 'search' ? (
              <SearchPanel api={api} onOpenFile={openFile} />
            ) : tab.kind === 'git' ? (
              <GitPanel api={api} onOpenDiff={openDiff} />
            ) : tab.kind === 'terminal' ? (
              <TerminalPanel api={api} />
            ) : tab.kind === 'diff' ? (
              <DiffPanel api={api} {...(tab.path !== undefined ? { path: tab.path } : {})} />
            ) : (
              <FilePanel
                api={api}
                path={tab.path!}
                {...(tab.line !== undefined ? { line: tab.line } : {})}
              />
            )}
          </div>
        ))}
      </div>
      {quickOpen && (
        <QuickOpenModal api={api} onOpenFile={openFile} onClose={() => setQuickOpen(false)} />
      )}
    </aside>
  )
}
