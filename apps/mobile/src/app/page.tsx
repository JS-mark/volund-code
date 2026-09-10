'use client'

/**
 * Volund 远程（移动站）：配对 → 欢迎页（连接就绪自动进入）→ 会话/对话/我的
 * 三个底栏视图，默认落会话列表。WS /v1/ws 是唯一实时通道：hello 带活动会话与
 * 待审批，event 帧进聊天 reducer；发消息 = 乐观回显 + turn.submit。创建会话只
 * 由显式「新会话」触发，不再有首条消息自动补建。
 */
import { CommentOutlined, HistoryOutlined, UserOutlined, WifiOutlined } from '@ant-design/icons'
import { App as AntApp, Badge, Select, Typography } from 'antd'
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'

import { ChatView, type SubmitImage } from '../components/ChatView'
import { MineView } from '../components/MineView'
import { PairView } from '../components/PairView'
import { SessionsView } from '../components/SessionsView'
import { WelcomeView } from '../components/WelcomeView'
import {
  initialChatState,
  MACHINE_OFFLINE_NOTICE,
  reduceChatState,
  type ChatMessageImage,
} from '../lib/chat'
import {
  clearSession,
  GatewayApi,
  GatewayWs,
  loadModelOverride,
  loadSession,
  saveModelOverride,
  setUnauthorizedHandler,
  type MobileSession,
  type SessionSummary,
  type StagedAttachment,
} from '../lib/gateway'

type Tab = 'sessions' | 'chat' | 'mine'

export default function MobileApp() {
  const [session, setSession] = useState<MobileSession | undefined>()
  const [booted, setBooted] = useState(false)
  const [tab, setTab] = useState<Tab>('sessions')
  /** 欢迎页：连接就绪自动进入；跳过/进入后为 true，本次运行内不再回闪。 */
  const [welcomed, setWelcomed] = useState(false)
  const [connected, setConnected] = useState(false)
  const [activeSessionId, setActiveSessionId] = useState<string>()
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [sessionsLoading, setSessionsLoading] = useState(false)
  const [hydrating, setHydrating] = useState(false)
  const [state, dispatch] = useReducer(reduceChatState, initialChatState)
  /** 本机模型面（hello 后拉取）；override 持久化在设备 localStorage。 */
  const [modelsView, setModelsView] = useState<{
    current?: string
    options: { id: string; label: string }[]
  }>()
  const [modelOverride, setModelOverride] = useState<string>()
  /** 凭证被撤销/失效时回到配对页并展示的提示。 */
  const [revokedNotice, setRevokedNotice] = useState<string>()
  const wsRef = useRef<GatewayWs | undefined>(undefined)
  const sessionRef = useRef(session)
  sessionRef.current = session
  // onEvent 的事件过滤须读最新 activeSessionId（WS 闭包只在 token 变化时重建）。
  const activeSessionRef = useRef(activeSessionId)
  activeSessionRef.current = activeSessionId
  // 显式「新会话」的 session.start 在途标记：附件暂存等在 session.attached 上。
  const pendingStartRef = useRef(false)
  // 附件上传须等活动会话就绪（本机 AttachmentStore 挂在会话上）：session.attached 到达时统一放行。
  const sessionWaitersRef = useRef<((id: string) => void)[]>([])

  useEffect(() => {
    setSession(loadSession())
    setModelOverride(loadModelOverride())
    setBooted(true)
  }, [])

  const refreshSessions = useCallback(async () => {
    const current = sessionRef.current
    if (!current) return
    setSessionsLoading(true)
    try {
      const view = await new GatewayApi(current.token).sessions()
      setSessions(view.sessions)
    } catch {
      // 链路/凭证失败静默（ MineView / PairView 会给出明确态）。
    } finally {
      setSessionsLoading(false)
    }
  }, [])

  const refreshModels = useCallback(async () => {
    const current = sessionRef.current
    if (!current) return
    try {
      const view = await new GatewayApi(current.token).models()
      setModelsView({
        ...(view.current ? { current: view.current } : {}),
        options: view.data.map((model) => ({ id: model.id, label: model.label ?? model.id })),
      })
    } catch {
      // 拉不到（链路未就绪/本机离线）就藏起选择器。
      setModelsView(undefined)
    }
  }, [])

  const hydrate = useCallback(async (targetSessionId?: string) => {
    const current = sessionRef.current
    if (!current) return
    setHydrating(true)
    try {
      const snapshot = await new GatewayApi(current.token).transcript()
      if (snapshot.transcript?.length)
        dispatch({ type: 'hydrate', transcript: snapshot.transcript })
      // resume 时 targetSessionId 优先（WS 应答里的 id 是最新的，setState 还没同步）。
      if (targetSessionId) setActiveSessionId(targetSessionId)
      else if (snapshot.id) setActiveSessionId(snapshot.id)
    } catch {
      // 无会话或链路未就绪：聊天视图提示即可。
    } finally {
      setHydrating(false)
    }
  }, [])

  // WS 生命周期（token 变化即重建）。
  useEffect(() => {
    if (!session) return
    const ws = new GatewayWs(session.token, {
      onOpenChange: (open) => {
        setConnected(open)
        if (open) return
        // WS 断开：探测一次 REST——凭证已被撤销/过期（401）时回配对页；
        // 瞬时断网/本机离线（非 401）不进此分支，交给自动重连。
        const current = sessionRef.current
        if (current) void new GatewayApi(current.token).sessions().catch(() => {})
      },
      onHello: (hello) => {
        setActiveSessionId(hello.session?.id)
        void hydrate()
        void refreshSessions()
        void refreshModels()
      },
      onEvent: (envelope) => {
        // 本机重连上线：uplink 断开期间的流式/终态事件已丢失，重新水合 transcript 收口，
        // 否则断线期的半截回复会一直卡在 streaming 或干脆缺失。
        const viewEvent = envelope.event as { type?: string } | undefined
        if (envelope.kind === 'view' && viewEvent?.type === 'machine.online') void hydrate()
        // 单活动会话模型：过滤非当前会话的残留信封（activeSessionId 读 ref，避免陈旧闭包）。
        const active = activeSessionRef.current
        if (active && envelope.sessionId && envelope.sessionId !== active) return
        dispatch({ type: 'envelope', envelope })
      },
      onFrame: (frame) => {
        if (frame.type === 'session.attached' && typeof frame.id === 'string') {
          setActiveSessionId(frame.id)
          pendingStartRef.current = false
          const waiters = sessionWaitersRef.current
          sessionWaitersRef.current = []
          for (const resolve of waiters) resolve(frame.id)
          // resume/start 成功后重新水合：transcript 拉新会话的历史消息。
          void hydrate(frame.id)
          void refreshSessions()
          return
        }
        // 命令应答错误帧（turn.submit/session.start 等）：落到提示条，别静默吞掉。
        if (frame.type === 'error') {
          if (typeof frame.ref === 'string') {
            // 显式新建/恢复失败：收掉在途标记与水合骨架，视图退回可操作的空态。
            if (frame.ref === 'new-chat') pendingStartRef.current = false
            if (frame.ref === 'new-chat' || frame.ref.startsWith('resume-')) setHydrating(false)
          }
          const code = typeof frame.code === 'string' ? frame.code : ''
          const message = typeof frame.message === 'string' ? frame.message : ''
          dispatch({
            type: 'notice',
            notice:
              code === 'gateway_uplink_offline'
                ? MACHINE_OFFLINE_NOTICE
                : `错误 ${code || 'unknown'}: ${message}`,
          })
        }
      },
      onRevoked: () => unpair('设备已被桌面端撤销，请重新配对'),
    })
    ws.connect()
    wsRef.current = ws
    return () => {
      ws.close()
      wsRef.current = undefined
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session])

  useEffect(() => {
    if (!connected) return
    const timer = setInterval(() => void refreshSessions(), 30_000)
    return () => clearInterval(timer)
  }, [connected, refreshSessions])

  /** 等活动会话就绪（附件暂存的会话依赖）：显式新建在途时等 session.attached，否则拒绝。 */
  const ensureActiveSession = useCallback((): Promise<string> => {
    if (activeSessionId) return Promise.resolve(activeSessionId)
    if (!pendingStartRef.current) return Promise.reject(new Error('请先创建会话'))
    return new Promise<string>((resolve, reject) => {
      const settled = (id: string) => {
        clearTimeout(timer)
        resolve(id)
      }
      const timer = setTimeout(() => {
        sessionWaitersRef.current = sessionWaitersRef.current.filter((waiter) => waiter !== settled)
        reject(new Error('会话建立超时，请重试'))
      }, 30_000)
      sessionWaitersRef.current.push(settled)
    })
  }, [activeSessionId])

  /** 选图即暂存：等会话 → POST /v1/attachments（字节直传，handle 随 turn.submit 引用）。 */
  const stageImage = useCallback(
    async (file: File): Promise<StagedAttachment> => {
      const current = sessionRef.current
      if (!current) throw new Error('未配对')
      await ensureActiveSession()
      return new GatewayApi(current.token).uploadAttachment(file, file.type)
    },
    [ensureActiveSession],
  )

  const submitTurn = useCallback(
    (text: string, images: readonly SubmitImage[] = []) => {
      const ws = wsRef.current
      // 无活动会话不允许出站（对话页空态已拦住输入区，这里兜底）。
      if (!ws || !activeSessionId) return
      const attachments = images.map((image) => ({
        kind: image.staged.kind,
        chip: image.chip,
        mime: image.staged.mime,
        size: image.staged.size,
        ...(image.staged.handle ? { handle: image.staged.handle } : {}),
      }))
      ws.send({
        type: 'turn.submit',
        prompt: text,
        ...(attachments.length ? { attachments } : {}),
        // 模型覆盖随每次提交显式携带（本机侧按 [models.aliases] 解析）。
        ...(modelOverride ? { model: modelOverride } : {}),
        ref: `turn-${Date.now()}`,
      })
    },
    [activeSessionId, modelOverride],
  )

  const resumeSession = useCallback((id: string) => {
    setHydrating(true)
    dispatch({ type: 'reset' })
    wsRef.current?.send({ type: 'session.resume', id, ref: `resume-${id}` })
    setTab('chat')
  }, [])

  const newChat = useCallback(() => {
    // 单 runner：先收掉当前会话，再开新的（TUI 跟随切换）。
    wsRef.current?.send({ type: 'session.end', ref: 'end-before-new' })
    setActiveSessionId(undefined)
    dispatch({ type: 'reset' })
    setTab('chat')
    // 显式新建：立即 session.start，session.attached 到达前聊天页走水合骨架。
    setHydrating(true)
    pendingStartRef.current = true
    wsRef.current?.send({ type: 'session.start', ref: 'new-chat' })
  }, [])

  const decide = useCallback((requestId: string, kind: 'allow' | 'deny') => {
    wsRef.current?.send({ type: 'permission.decide', requestId, kind })
  }, [])

  /** handle 引用图片 → objectURL（字节缓存留在 gateway 层；objectURL 生命周期归组件）。 */
  const resolveAttachment = useCallback(async (handle: string): Promise<string> => {
    const current = sessionRef.current
    if (!current) throw new Error('未配对')
    const blob = await new GatewayApi(current.token).downloadAttachment(handle)
    return URL.createObjectURL(blob)
  }, [])

  const interrupt = useCallback(() => {
    wsRef.current?.send({ type: 'turn.interrupt' })
  }, [])

  const unpair = useCallback((notice?: string) => {
    wsRef.current?.close()
    clearSession()
    setRevokedNotice(notice)
    setSession(undefined)
    setWelcomed(false)
    dispatch({ type: 'reset' })
  }, [])

  // REST 401（凭证被撤销/过期）→ 统一回配对页；WS 侧被策略关闭走 onRevoked。
  useEffect(() => {
    setUnauthorizedHandler(() => unpair('凭证已失效或被撤销，请重新配对'))
    return () => setUnauthorizedHandler(undefined)
  }, [unpair])

  // 欢迎页：WS 就绪即自动进入主界面（仅首次连接触发，重连不回闪）。
  useEffect(() => {
    if (connected) setWelcomed(true)
  }, [connected])

  const header = useMemo(() => {
    if (!session) return null
    const title = tab === 'chat' ? '对话' : tab === 'sessions' ? '会话' : '我的'
    // 模型选择器只在对话页露出；选中默认模型 = 清掉 override（跟随本机配置变化）。
    const picker =
      tab === 'chat' && modelsView && modelsView.options.length > 0 ? (
        <Select
          size="small"
          variant="borderless"
          className="model-picker"
          value={modelOverride ?? modelsView.current ?? null}
          placeholder="模型"
          options={modelsView.options.map((option) => ({
            value: option.id,
            label: option.label,
          }))}
          onChange={(key: string) => {
            const next = key === modelsView.current ? undefined : key
            setModelOverride(next)
            saveModelOverride(next)
          }}
          popupMatchSelectWidth={false}
        />
      ) : null
    return (
      <header className="app-header">
        <Badge dot status={connected ? 'success' : 'warning'} offset={[2, 0]}>
          <WifiOutlined style={{ fontSize: 16 }} />
        </Badge>
        <div className="app-header-title">
          <Typography.Text strong>{title}</Typography.Text>
        </div>
        {activeSessionId && (
          <Typography.Text
            type="secondary"
            className="app-header-sub"
            style={{ fontSize: 11 }}
            ellipsis={{
              tooltip:
                sessions.find((entry) => entry.id === activeSessionId)?.title ?? activeSessionId,
            }}
          >
            {sessions.find((entry) => entry.id === activeSessionId)?.title ?? activeSessionId}
          </Typography.Text>
        )}
        {picker}
      </header>
    )
  }, [session, tab, connected, activeSessionId, sessions, modelsView, modelOverride])

  if (!booted) return null
  if (!session)
    return (
      <AntApp>
        <PairView
          notice={revokedNotice}
          onPaired={() => {
            setRevokedNotice(undefined)
            setSession(loadSession())
          }}
        />
      </AntApp>
    )
  if (!welcomed)
    return (
      <AntApp>
        <WelcomeView connected={connected} onSkip={() => setWelcomed(true)} />
      </AntApp>
    )

  return (
    <AntApp>
      <div className="app">
        {header}
        <div className="app-body">
          {tab === 'chat' ? (
            <ChatView
              state={state}
              connected={connected}
              loading={hydrating}
              activeSessionId={activeSessionId}
              onEcho={(text, images: readonly ChatMessageImage[]) =>
                dispatch({ type: 'echo', text, ...(images.length ? { images } : {}) })
              }
              onSubmit={submitTurn}
              onStage={stageImage}
              onInterrupt={interrupt}
              onDecide={decide}
              resolveAttachment={resolveAttachment}
              onGoSessions={() => {
                void refreshSessions()
                setTab('sessions')
              }}
            />
          ) : tab === 'sessions' ? (
            <SessionsView
              sessions={sessions}
              loading={sessionsLoading}
              activeId={activeSessionId}
              onRefresh={() => void refreshSessions()}
              onResume={resumeSession}
              onNewChat={newChat}
            />
          ) : (
            <MineView
              session={session}
              connected={connected}
              activeSessionId={activeSessionId}
              onUnpair={unpair}
            />
          )}
        </div>
        <nav className="tabbar">
          {(
            [
              ['sessions', '会话', <HistoryOutlined key="icon" style={{ fontSize: 20 }} />],
              ['chat', '对话', <CommentOutlined key="icon" style={{ fontSize: 20 }} />],
              ['mine', '我的', <UserOutlined key="icon" style={{ fontSize: 20 }} />],
            ] as const
          ).map(([key, label, icon]) => (
            <button
              key={key}
              type="button"
              className={`tabbar-item${tab === key ? ' active' : ''}`}
              onClick={() => {
                if (key === 'sessions') void refreshSessions()
                setTab(key)
              }}
            >
              {icon}
              <span>{label}</span>
            </button>
          ))}
        </nav>
      </div>
    </AntApp>
  )
}
