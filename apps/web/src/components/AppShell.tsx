'use client'

import {
  ApiOutlined,
  AppstoreOutlined,
  BarChartOutlined,
  CodeOutlined,
  CloudServerOutlined,
  CommentOutlined,
  ControlOutlined,
  ForkOutlined,
  LogoutOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  ReadOutlined,
  SettingOutlined,
} from '@ant-design/icons'
import { Button, Dropdown, Tooltip, Typography } from 'antd'
import type { InputRef } from 'antd'
import { useCallback, useEffect, useRef, useState } from 'react'

import type { Bootstrap, SessionGroupsView, SessionSummary, StatusView } from '../lib/api'
import { openBrowserSession, WebApi } from '../lib/api'
import { BrandMark } from './BrandMark'
import { ChangesPage } from './ChangesPage'
import { ChatPanel } from './ChatPanel'
import { CodePage } from './CodePage'
import { ManagePage } from './ManagePage'
import { RemotePage } from './RemotePage'
import { RightPanel } from './RightPanel'
import { SessionSidebar } from './SessionSidebar'
import { SettingsPage } from './SettingsPage'
import { ShortcutsPage } from './ShortcutsPage'
import { StatsPage } from './StatsPage'
import { StatusPage } from './StatusPage'
import { WorkbenchPanel } from './WorkbenchPanel'

type Route =
  | 'chat'
  | 'code'
  | 'status'
  | 'manage'
  | 'settings'
  | 'shortcuts'
  | 'changes'
  | 'stats'
  | 'remote'

interface Loaded {
  api: WebApi
  bootstrap: Bootstrap
  sessions: readonly SessionSummary[]
  groupsView: SessionGroupsView
  status: StatusView | undefined
  activeId: string | undefined
}

const DOCS_URL = 'https://github.com/JS-mark/volund-code#readme'

/** 从图标轨菜单进入的路由：这些页面打开时齿轮按钮保持选中态。 */
const MENU_ROUTES: ReadonlySet<Route> = new Set(['settings', 'shortcuts', 'changes', 'stats'])

/** 分组能力未接线（旧 server）时的空视图：平铺展示。 */
const EMPTY_GROUPS: SessionGroupsView = { groups: [], assignments: {} }

const svgIconProps = {
  viewBox: '0 0 16 16',
  width: '1em',
  height: '1em',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.3,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const

/** 键盘图标（antd 图标库无键盘，按参考图手绘）。 */
function KeyboardIcon() {
  return (
    <svg {...svgIconProps}>
      <rect x="1.4" y="3.6" width="13.2" height="8.8" rx="1.8" />
      <path d="M4 6.3h1.1M6.8 6.3h1.1M9.6 6.3h1.1M4.8 8.6h1.1M7.6 8.6h1.1M10.4 8.6h1.1M5.4 10.7h5.2" />
    </svg>
  )
}

/** 芯片图标（实例）。 */
function ChipIcon() {
  return (
    <svg {...svgIconProps}>
      <rect x="4.2" y="4.2" width="7.6" height="7.6" rx="1.2" />
      <rect x="6.6" y="6.6" width="2.8" height="2.8" rx="0.5" />
      <path d="M6 2.2v2M8 2.2v2M10 2.2v2M6 11.8v2M8 11.8v2M10 11.8v2M2.2 6h2M2.2 8h2M2.2 10h2M11.8 6h2M11.8 8h2M11.8 10h2" />
    </svg>
  )
}

/** 链路图标：两个圆角方块折线相连。 */
function TraceIcon() {
  return (
    <svg {...svgIconProps}>
      <rect x="2" y="2.6" width="4.4" height="4.4" rx="1" />
      <rect x="9.4" y="9" width="4.4" height="4.4" rx="1" />
      <path d="M6.4 4.8H10.1A1.5 1.5 0 0 1 11.6 6.3V9" />
    </svg>
  )
}

/** 监控图标：心跳波形。 */
function PulseIcon() {
  return (
    <svg {...svgIconProps}>
      <path d="M1.8 8h2.8l1.5-3.6 2.6 7.2 1.7-3.6h3.8" />
    </svg>
  )
}

export function AppShell() {
  const [loaded, setLoaded] = useState<Loaded>()
  const [error, setError] = useState<{ code: string; message: string }>()
  const [route, setRoute] = useState<Route>('chat')
  const [connected, setConnected] = useState(false)
  // 右侧面板互斥：连接信息 / 工作台（CodeBuddy 布局只有一个右栏）。
  const [rightPanel, setRightPanel] = useState<'connect' | 'workbench' | null>(null)
  // ⌘J 信号：打开工作台并聚焦终端标签页（递增值触发 WorkbenchPanel 的 effect）。
  const [terminalSignal, setTerminalSignal] = useState(0)
  const [loggedOut, setLoggedOut] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  // 会话侧栏可收起(⌘B / 图标轨底部按钮);收起后由图标轨按钮恢复。
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  // 代码页首次进入后才挂载,之后常驻(workbench 不能二次初始化)。
  const [codeVisited, setCodeVisited] = useState(false)
  useEffect(() => {
    if (route === 'code') setCodeVisited(true)
  }, [route])
  const sidebarSearchRef = useRef<InputRef>(null)

  // 全局快捷键:⌘J 打开工作台并聚焦终端(对齐 CodeBuddy web);⌘B 收起/展开侧栏(对齐 VS Code,
  // 侧栏仅会话页存在,故只在该路由生效,避免其他 tab 上暗改状态);⌘, 打开设置(macOS 惯例;Safari 会拦截给自身偏好设置,无法 preventDefault)。
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey && !event.shiftKey && event.key.toLowerCase() === 'j') {
        event.preventDefault()
        setRightPanel('workbench')
        setTerminalSignal((value) => value + 1)
      } else if (
        route === 'chat' &&
        event.metaKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === 'b'
      ) {
        event.preventDefault()
        setSidebarCollapsed((collapsed) => !collapsed)
      } else if (event.metaKey && !event.shiftKey && event.key === ',') {
        event.preventDefault()
        setRoute('settings')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [route])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        // 进入即用（无 token 门）：bootstrap 自动签发 browser session，
        // 刷新/重开/多窗口同一条路径。
        const { session, bootstrap } = await openBrowserSession()
        const api = new WebApi(session)
        const sessions = await api.sessions().catch(() => [] as const)
        // 分组能力未接线（旧 server）时端点 503 → 空视图平铺展示。
        const groupsView =
          bootstrap.capabilities.sessionGroups === false
            ? EMPTY_GROUPS
            : await api.sessionGroups().catch(() => EMPTY_GROUPS)
        const status = await api.status().catch(() => undefined)
        const active = await api.activeSession().catch(() => undefined)
        const activeId = active?.active?.id
        api.events((kind) => {
          if (kind === 'control') setConnected(true)
        })
        if (!cancelled) setLoaded({ api, bootstrap, sessions, groupsView, status, activeId })
      } catch (cause) {
        if (!cancelled)
          setError({
            code: (cause as { code?: string }).code ?? 'unknown',
            message: cause instanceof Error ? cause.message : String(cause),
          })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const refreshSessions = useCallback(async () => {
    if (!loaded) return
    const sessions = await loaded.api.sessions().catch(() => undefined)
    if (sessions) setLoaded((current) => (current ? { ...current, sessions } : current))
  }, [loaded])

  const refreshGroups = useCallback(async () => {
    if (!loaded) return
    const groupsView = await loaded.api.sessionGroups().catch(() => undefined)
    if (groupsView) setLoaded((current) => (current ? { ...current, groupsView } : current))
  }, [loaded])

  const setActiveId = useCallback((id: string | undefined) => {
    setLoaded((current) => (current ? { ...current, activeId: id } : current))
  }, [])

  const resume = useCallback(
    async (id: string) => {
      if (!loaded) return
      try {
        await loaded.api.resumeSession(id)
        setActiveId(id)
        setRoute('chat')
      } catch (cause) {
        setError({
          code: (cause as { code?: string }).code ?? 'unknown',
          message: cause instanceof Error ? cause.message : String(cause),
        })
      }
    },
    [loaded, setActiveId],
  )

  const logout = useCallback(async () => {
    if (!loaded) return
    await loaded.api.logout().catch(() => {})
    setLoggedOut(true)
  }, [loaded])

  if (loggedOut)
    return (
      <main
        className="shell"
        style={{
          display: 'grid',
          placeContent: 'center',
          justifyItems: 'center',
          gap: 16,
          textAlign: 'center',
        }}
      >
        <BrandMark size={56} />
        <Typography.Title level={3}>已退出</Typography.Title>
        <Typography.Text type="secondary">浏览器会话已销毁。</Typography.Text>
        <Button type="primary" onClick={() => window.location.reload()}>
          重新进入
        </Button>
      </main>
    )
  if (error)
    return (
      <main
        className="shell"
        style={{
          display: 'grid',
          placeContent: 'center',
          justifyItems: 'center',
          gap: 16,
          textAlign: 'center',
        }}
      >
        <BrandMark size={56} />
        <Typography.Title level={3}>无法连接 Volund Web</Typography.Title>
        <Typography.Text type="secondary">
          {error.code}: {error.message}
        </Typography.Text>
        <Typography.Text type="secondary">
          请确认 TUI 正在运行（Web 控制台随 TUI 静默自启），然后刷新重试。
        </Typography.Text>
      </main>
    )
  if (!loaded)
    return (
      <main
        className="shell"
        style={{ display: 'grid', placeContent: 'center', justifyItems: 'center', gap: 16 }}
      >
        <BrandMark size={56} />
        <Typography.Text type="secondary">正在与本地运行时建立会话…</Typography.Text>
      </main>
    )

  const { bootstrap, status, activeId } = loaded
  const embedded = bootstrap.capabilities.embedded === true
  const activeTitle = loaded.sessions.find((session) => session.id === activeId)?.title

  // 选中态对齐 CodeBuddy：左侧蓝色指示条 + 图标提亮，不用实心圆底。
  const railButton = (key: Route, title: string, icon: React.ReactNode) => (
    <Tooltip key={key} title={title} placement="right">
      <button
        type="button"
        className={`rail-btn${route === key ? ' active' : ''}`}
        aria-label={title}
        onClick={() => setRoute(key)}
      >
        {icon}
      </button>
    </Tooltip>
  )

  // 左下角菜单项（对齐参考图：暗色分组弹层）。disabled 项保留悬念但不可点。
  const railMenuItem = (
    key: string,
    label: string,
    icon: React.ReactNode,
    options: { route?: Route; href?: string; disabled?: boolean; onSelect?: () => void } = {},
  ) => {
    const active = options.route !== undefined && route === options.route
    const disabled = options.disabled === true
    return (
      <button
        key={key}
        type="button"
        className={`rail-menu-item${active ? ' active' : ''}${disabled ? ' disabled' : ''}`}
        aria-disabled={disabled || undefined}
        title={disabled ? '即将上线' : undefined}
        onClick={() => {
          if (disabled) return
          setMenuOpen(false)
          if (options.route) setRoute(options.route)
          else if (options.href) window.open(options.href, '_blank', 'noopener')
          else options.onSelect?.()
        }}
      >
        <span className="rail-menu-icon">{icon}</span>
        {label}
      </button>
    )
  }

  const railMenu = (
    <div className="rail-menu">
      <div className="rail-menu-group">配置</div>
      {railMenuItem('settings', '设置', <ControlOutlined />, { route: 'settings' })}
      {railMenuItem('shortcuts', '快捷键', <KeyboardIcon />, { route: 'shortcuts' })}
      {railMenuItem('docs', '文档', <ReadOutlined />, { href: DOCS_URL })}
      <div className="rail-menu-divider" />
      <div className="rail-menu-group">可观测</div>
      {railMenuItem('changes', '变更', <ForkOutlined />, { route: 'changes' })}
      {railMenuItem('status', '实例', <ChipIcon />, { route: 'status' })}
      {railMenuItem('stats', '统计', <BarChartOutlined />, { route: 'stats' })}
      {railMenuItem('tracing', '链路', <TraceIcon />, { disabled: true })}
      {railMenuItem('monitoring', '监控', <PulseIcon />, { disabled: true })}
      <div className="rail-menu-divider" />
      {railMenuItem('logout', '退出登录', <LogoutOutlined />, { onSelect: () => void logout() })}
    </div>
  )

  return (
    <div className="shell">
      {/* 图标轨 */}
      <div className="rail">
        <div className="rail-logo">
          <BrandMark />
        </div>
        {railButton('chat', '对话', <CommentOutlined />)}
        {railButton('code', '代码编辑器', <CodeOutlined />)}
        {railButton(
          'manage',
          '管理（Memory / Skills / MCP / Plugins / Telemetry）',
          <AppstoreOutlined />,
        )}
        {railButton('status', '状态', <ApiOutlined />)}
        {railButton('remote', '远程控制', <CloudServerOutlined />)}
        <span style={{ flex: 1 }} />
        {/* 侧栏属于会话页,收起/展开按钮也只在会话 tab 出现。 */}
        {route === 'chat' && (
          <Tooltip title={sidebarCollapsed ? '展开侧栏（⌘B）' : '收起侧栏（⌘B）'} placement="right">
            <button
              type="button"
              className="rail-btn"
              aria-label={sidebarCollapsed ? '展开侧栏' : '收起侧栏'}
              onClick={() => setSidebarCollapsed((collapsed) => !collapsed)}
            >
              {sidebarCollapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
            </button>
          </Tooltip>
        )}
        <Dropdown
          trigger={['click']}
          placement="topLeft"
          open={menuOpen}
          onOpenChange={setMenuOpen}
          popupRender={() => railMenu}
        >
          <button
            type="button"
            className={`rail-btn${menuOpen || MENU_ROUTES.has(route) ? ' active' : ''}`}
            aria-label="设置与更多"
          >
            <SettingOutlined />
          </button>
        </Dropdown>
      </div>
      {/* 二栏：搜索 + 会话分组列表（可收起，⌘B / 图标轨按钮切换）。
          会话列表属于对话页,只在 chat 路由渲染;切到其他 tab 隐藏,切回恢复。 */}
      {!sidebarCollapsed && route === 'chat' && (
        <div className="column">
          <SessionSidebar
            api={loaded.api}
            sessions={loaded.sessions}
            groups={loaded.groupsView}
            groupingEnabled={bootstrap.capabilities.sessionGroups === true}
            activeId={activeId}
            searchRef={sidebarSearchRef}
            onSelect={(id) => {
              if (id === activeId) {
                setRoute('chat')
                return
              }
              // 嵌入式同样允许切换：controller 激活后 TUI 经 onActivate 跟随。
              void resume(id)
            }}
            onNewChat={() => {
              setActiveId(undefined)
              setRoute('chat')
            }}
            onGroupsChanged={() => void refreshGroups()}
          />
          <Typography.Text
            type="secondary"
            style={{
              fontSize: 11,
              padding: '6px 10px',
              borderTop: '1px solid var(--ant-color-border-secondary)',
            }}
            ellipsis={{ tooltip: bootstrap.workspace.cwd }}
          >
            v{bootstrap.server.version} · {bootstrap.workspace.cwd}
          </Typography.Text>
        </div>
      )}
      {/* 主区 + 可选右侧栏 */}
      <div className="main-col">
        <div className="main-body">
          {/* 代码页常驻:vscode workbench 全页只能初始化一次,切走仅隐藏(display:none)。 */}
          {codeVisited && (
            <div style={route === 'code' ? { display: 'contents' } : { display: 'none' }}>
              <CodePage api={loaded.api} cwd={bootstrap.workspace.cwd} />
            </div>
          )}
          {route !== 'code' &&
            (route === 'manage' ? (
              <ManagePage api={loaded.api} capabilities={bootstrap.capabilities} />
            ) : route === 'status' ? (
              <StatusPage status={status} />
            ) : route === 'remote' ? (
              <RemotePage api={loaded.api} />
            ) : route === 'settings' ? (
              <SettingsPage
                api={loaded.api}
                capabilities={bootstrap.capabilities}
                bootstrap={bootstrap}
                connected={connected}
                activeId={activeId}
              />
            ) : route === 'shortcuts' ? (
              <ShortcutsPage />
            ) : route === 'changes' ? (
              <ChangesPage api={loaded.api} sessionId={activeId} />
            ) : route === 'stats' ? (
              <StatsPage api={loaded.api} />
            ) : (
              <ChatPanel
                api={loaded.api}
                cwd={bootstrap.workspace.cwd}
                sessionId={activeId}
                sessionTitle={activeTitle}
                embedded={embedded}
                connected={connected}
                capabilities={bootstrap.capabilities}
                sessions={loaded.sessions}
                connectOpen={rightPanel === 'connect'}
                workbenchOpen={rightPanel === 'workbench'}
                onToggleConnect={() =>
                  setRightPanel((current) => (current === 'connect' ? null : 'connect'))
                }
                onToggleWorkbench={() =>
                  setRightPanel((current) => (current === 'workbench' ? null : 'workbench'))
                }
                onResumeSession={(id) => void resume(id)}
                onFocusSessionSearch={() => {
                  // 侧栏收起时先展开,等挂载后再聚焦搜索框。
                  setSidebarCollapsed(false)
                  requestAnimationFrame(() => sidebarSearchRef.current?.focus({ cursor: 'end' }))
                }}
                onSessionChange={setActiveId}
                onSessionsChanged={() => void refreshSessions()}
              />
            ))}
        </div>
        {rightPanel === 'connect' && (
          <RightPanel
            api={loaded.api}
            bootstrap={bootstrap}
            sessionId={activeId}
            sessionTitle={activeTitle}
            connected={connected}
            onClose={() => setRightPanel(null)}
          />
        )}
        {rightPanel === 'workbench' && (
          <WorkbenchPanel
            api={loaded.api}
            terminalSignal={terminalSignal}
            onClose={() => setRightPanel(null)}
          />
        )}
      </div>
    </div>
  )
}
