'use client'

import {
  ArrowUpOutlined,
  CloseOutlined,
  DownOutlined,
  FolderOutlined,
  HistoryOutlined,
  LinkOutlined,
  LoadingOutlined,
  PlusOutlined,
  SafetyCertificateOutlined,
  SearchOutlined,
  StopOutlined,
} from '@ant-design/icons'
import { Alert, Button, Dropdown, Popover, Tooltip, Typography } from 'antd'
import { useCallback, useEffect, useRef, useState } from 'react'

import type { ModelsView, SessionSummary, StagedAttachment, WebApi } from '../lib/api'
import type { ChatImage, ChatMessage } from '../lib/session-stream'
import { chatImageSrc, useSessionStream } from '../lib/session-stream'
import { BrandMark } from './BrandMark'
import { ChangesPanel } from './ChangesPanel'
import { Markdown } from './Markdown'
import { NewChatIcon, WorkbenchIcon } from './WorkbenchPanel'

/** composer 里待提交的图片：先本地预览（objectURL），上传完成得 handle 才可发送。 */
interface PendingImage {
  chip: string
  mime: string
  previewUrl: string
  status: 'uploading' | 'ready' | 'error'
  staged?: StagedAttachment
}

const IMAGE_ACCEPT = 'image/png,image/jpeg,image/gif,image/webp'

const PERMISSION_MODES = [
  { id: 'ask', label: '询问' },
  { id: 'auto', label: '自动' },
  { id: 'full', label: '放行' },
] as const

/** 时间分隔行：相邻消息间隔超过该阈值才再出一次（对齐 IM 惯例）。 */
const TIME_GAP_MS = 5 * 60_000

const formatHHMM = (at: number): string => {
  const date = new Date(at)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

/**
 * 聊天视图（§22 W-04/W-05/W-07；布局对齐 CodeBuddy 参考：欢迎屏 + 居中会话头 +
 * 用户气泡右置/助手全文 + 思考行 + 圆角 composer 卡片）。
 * 状态唯一来源是 useSessionStream 的 reducer——SSE 增量、transcript 水合、
 * 本地乐观回显全走同一管道（历史上双轨并行导致流式消息不可见）。
 */
export function ChatPanel({
  api,
  cwd,
  sessionId,
  sessionTitle,
  embedded,
  connected,
  capabilities,
  sessions,
  connectOpen,
  workbenchOpen,
  onToggleConnect,
  onToggleWorkbench,
  onResumeSession,
  onFocusSessionSearch,
  onSessionChange,
  onSessionsChanged,
}: {
  api: WebApi
  cwd: string
  sessionId: string | undefined
  sessionTitle: string | undefined
  embedded: boolean
  connected: boolean
  capabilities: Record<string, unknown>
  /** 全部会话（最近会话弹层数据源；按 updatedAt 倒序展示本工作区的）。 */
  sessions: readonly SessionSummary[]
  connectOpen: boolean
  workbenchOpen: boolean
  onToggleConnect(): void
  onToggleWorkbench(): void
  /** 恢复历史会话（resume + 切路由由 AppShell 统一做）。 */
  onResumeSession(id: string): void
  /** 最近会话弹层底部「搜索并管理全部对话」：聚焦侧栏搜索框。 */
  onFocusSessionSearch(): void
  onSessionChange(id: string | undefined): void
  onSessionsChanged(): void
}) {
  const stream = useSessionStream(sessionId !== undefined, sessionId)
  const chat = stream.state
  const [draft, setDraft] = useState(() => localStorage.getItem(`volund-web-draft:${cwd}`) ?? '')
  const [images, setImages] = useState<PendingImage[]>([])
  const [busy, setBusy] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const nearBottomRef = useRef(true)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const chipSeqRef = useRef(0)
  const [models, setModels] = useState<ModelsView>()
  const [modelOverride, setModelOverride] = useState<string>()
  const [permissionMode, setPermissionMode] = useState<string>()
  const [recentOpen, setRecentOpen] = useState(false)

  // 回合计时：turn.started 打点、idle 时结算出「已思考 · X 秒 · N 个步骤」。
  const [elapsed, setElapsed] = useState(0)
  const [turnStats, setTurnStats] = useState<{ seconds: number; steps: number }>()
  const turnStartRef = useRef<number | undefined>(undefined)
  const toolBaseRef = useRef(0)
  const toolsLenRef = useRef(0)
  toolsLenRef.current = chat.tools.length

  // ⌘⇧H：切换「最近会话」弹层（对齐 CodeBuddy web 的快捷键）。
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey && event.shiftKey && event.key.toLowerCase() === 'h') {
        event.preventDefault()
        setRecentOpen((value) => !value)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // 回合计时器：running 期间每秒跳动；转 idle 结算统计（步骤=本回合工具数）。
  useEffect(() => {
    if (chat.turn === 'running') {
      turnStartRef.current = Date.now()
      toolBaseRef.current = toolsLenRef.current
      setTurnStats(undefined)
      setElapsed(0)
      const timer = setInterval(() => {
        if (turnStartRef.current !== undefined)
          setElapsed(Math.floor((Date.now() - turnStartRef.current) / 1000))
      }, 500)
      return () => clearInterval(timer)
    }
    if (turnStartRef.current !== undefined) {
      setTurnStats({
        seconds: Math.max(1, Math.round((Date.now() - turnStartRef.current) / 1000)),
        steps: toolsLenRef.current - toolBaseRef.current,
      })
      turnStartRef.current = undefined
    }
  }, [chat.turn])

  // 最近会话：本工作区、按更新时间倒序、取前 8 条（对齐参考弹层）。
  const recentSessions = sessions
    .filter((session) => session.cwd === cwd && session.id !== sessionId)
    .toSorted((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, 8)
  const projectName = cwd.split('/').filter(Boolean).pop() ?? cwd

  // W-06/§4.4：模型候选与权限模式（能力门控——未接线不渲染）。
  useEffect(() => {
    if (capabilities.models === true)
      void api
        .models()
        .then(setModels)
        .catch(() => setModels(undefined))
    if (capabilities.permissionMode === true)
      void api
        .permissionMode()
        .then((result) => setPermissionMode(result.mode))
        .catch(() => setPermissionMode(undefined))
  }, [api, capabilities.models, capabilities.permissionMode])

  // 会话切换：重置后按 transcript 水合（SSE 增量叠加其上）。
  // 注意：undefined → 新建id 是「首条消息自动建会话」路径——composer 里正在
  // 上传/待发的图片 chip 必须保留，不能当作会话切换清掉。
  const prevSessionRef = useRef<string | undefined>(undefined)
  useEffect(() => {
    const leavingRealSession = prevSessionRef.current !== undefined
    prevSessionRef.current = sessionId
    stream.reset()
    if (leavingRealSession) setImages([])
    if (sessionId === undefined) return
    void api
      .transcript()
      .then((snapshot) => stream.hydrate(snapshot.transcript))
      .catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, sessionId])

  // 草稿自动保存（W-05）：按 cwd 隔离，发送后清空。
  useEffect(() => {
    localStorage.setItem(`volund-web-draft:${cwd}`, draft)
  }, [cwd, draft])

  // textarea 随内容自动长高（上限 200px，超出内部滚动）。
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  }, [draft])

  // 消息列表自动滚底（用户上翻时不打断）。
  useEffect(() => {
    if (nearBottomRef.current) listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [chat.messages, chat.tools])

  const ensureSession = useCallback(async (): Promise<string> => {
    if (sessionId) return sessionId
    const { id } = await api.startSession(cwd)
    onSessionChange(id)
    onSessionsChanged()
    return id
  }, [api, cwd, sessionId, onSessionChange, onSessionsChanged])

  const addImages = useCallback(
    (files: Iterable<File>) => {
      for (const file of files) {
        if (!file.type.startsWith('image/')) continue
        chipSeqRef.current += 1
        const chip = `[image_${chipSeqRef.current}]`
        const previewUrl = URL.createObjectURL(file)
        setImages((current) => [
          ...current,
          { chip, mime: file.type, previewUrl, status: 'uploading' },
        ])
        void (async () => {
          try {
            await ensureSession()
            const staged = await api.stageAttachment(file, file.type)
            setImages((current) =>
              current.map((item) =>
                item.chip === chip ? { ...item, status: 'ready', staged } : item,
              ),
            )
          } catch (cause) {
            setImages((current) =>
              current.map((item) => (item.chip === chip ? { ...item, status: 'error' } : item)),
            )
            stream.setNotice(cause instanceof Error ? cause.message : String(cause))
          }
        })()
      }
    },
    [api, ensureSession, stream],
  )

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim()
      const ready = images.filter((item) => item.status === 'ready' && item.staged)
      if ((!trimmed && ready.length === 0) || chat.turn === 'running') return
      if (images.some((item) => item.status === 'uploading')) return
      setBusy(true)
      setDraft('')
      stream.setNotice(undefined)
      nearBottomRef.current = true
      try {
        // 无活动会话时先创建（runner 激活要数秒）——busy 期间 composer 给出明确反馈。
        await ensureSession()
        const echoImages: ChatImage[] = ready.map((item) => ({
          chip: item.chip,
          mime: item.mime,
          previewUrl: item.previewUrl,
          // 兜底：blob 预览失效（如收口后被 React 重挂载）时经字节端点加载。
          ...(item.staged!.handle ? { handle: item.staged!.handle } : {}),
        }))
        stream.echo(trimmed, echoImages)
        setImages([])
        // prompt 为空但带图时以 chip 占位（server 要求非空 prompt；提交时 chip 会被剥离）。
        const prompt = trimmed || ready.map((item) => item.chip).join(' ')
        await api.submitTurn(prompt, {
          ...(modelOverride ? { model: modelOverride } : {}),
          attachments: ready.map((item) => ({
            kind: 'image',
            chip: item.chip,
            mime: item.mime,
            size: item.staged!.size,
            ...(item.staged!.handle ? { handle: item.staged!.handle } : {}),
          })),
        })
      } catch (cause) {
        stream.setNotice(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setBusy(false)
        textareaRef.current?.focus()
      }
    },
    [api, chat.turn, ensureSession, images, modelOverride, stream],
  )

  const decide = useCallback(
    async (kind: string) => {
      if (!chat.permission) return
      try {
        await api.decidePermission(chat.permission.id, kind)
      } catch (cause) {
        stream.setNotice(cause instanceof Error ? cause.message : String(cause))
      }
    },
    [api, chat.permission, stream],
  )

  const end = useCallback(async () => {
    setBusy(true)
    try {
      await api.endSession()
      onSessionChange(undefined)
      onSessionsChanged()
    } finally {
      setBusy(false)
    }
  }, [api, onSessionChange, onSessionsChanged])

  const running = chat.turn === 'running'
  const lastMessage = chat.messages.at(-1)
  const streamingReply = lastMessage?.role === 'assistant' && lastMessage.streaming === true
  const canSend =
    !busy && !running && (draft.trim().length > 0 || images.some((item) => item.status === 'ready'))

  // 「已思考」摘要行的插入点：最后一个 user 消息之后的首条 assistant（即本回合回复）。
  const lastUserIndex = chat.messages.findLastIndex((message) => message.role === 'user')
  const turnReplyIndex = chat.messages.findIndex(
    (message, index) => index > lastUserIndex && message.role === 'assistant',
  )
  const showTurnStats = turnStats !== undefined && turnReplyIndex !== -1 && !running

  /** 时间分隔行是否在该条目前渲染（首条/与上一条带时间的消息间隔超阈值）。 */
  const timeBreaks: boolean[] = []
  let lastShownAt = 0
  chat.messages.forEach((message, index) => {
    const at = message.at
    if (at === undefined) {
      timeBreaks[index] = false
      return
    }
    const show = at - lastShownAt > TIME_GAP_MS
    timeBreaks[index] = show
    if (show) lastShownAt = at
  })

  const renderMessage = (message: ChatMessage, index: number) => {
    const at = message.at
    const timeRow = timeBreaks[index] && at !== undefined && (
      <div key={`${message.id}-time`} className="msg-time">
        {formatHHMM(at)}
      </div>
    )
    const statsRow = index === turnReplyIndex && showTurnStats && turnStats !== undefined && (
      <div key={`${message.id}-stats`} className="think-row settled">
        已思考 · {turnStats.seconds} 秒 · {turnStats.steps} 个步骤
      </div>
    )
    if (message.role === 'user')
      return [
        timeRow,
        <div key={message.id} className="msg-row user">
          <div className="msg-bubble">
            {message.images?.map((image) => {
              const src = chatImageSrc(image)
              if (!src) return null
              return <img key={image.chip} className="msg-image" src={src} alt={image.chip} />
            })}
            {message.text}
          </div>
        </div>,
      ]
    if (message.role === 'system')
      return [
        timeRow,
        <div key={message.id} className="msg-row system">
          {message.text}
        </div>,
      ]
    return [
      timeRow,
      statsRow,
      <div key={message.id} className="msg-row asst">
        <Markdown text={message.text} />
        {message.streaming && <span className="msg-caret" />}
      </div>,
    ]
  }

  /** 最近会话条目的时间副标：今天 HH:MM，更早 M月D日 HH:MM。 */
  const recentTimeLabel = (updatedAt: string): string => {
    const time = Date.parse(updatedAt)
    if (Number.isNaN(time)) return ''
    const date = new Date(time)
    const hhmm = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
    const today = date.toDateString() === new Date().toDateString()
    return today ? hhmm : `${date.getMonth() + 1}月${date.getDate()}日 ${hhmm}`
  }

  // 最近会话弹层（对齐 CodeBuddy web：标题带项目名 + X；空态；底部管理入口）。
  const recentPanel = (
    <div className="recent-panel">
      <div className="recent-head">
        <Typography.Text strong>最近会话 · {projectName}</Typography.Text>
        <Button
          size="small"
          type="text"
          icon={<CloseOutlined />}
          onClick={() => setRecentOpen(false)}
        />
      </div>
      <div className="recent-body">
        {recentSessions.length === 0 ? (
          <div className="recent-empty">
            <HistoryOutlined style={{ fontSize: 32 }} />
            <Typography.Text strong>没有历史对话</Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              当前项目还没有可继续的对话
            </Typography.Text>
          </div>
        ) : (
          recentSessions.map((session) => (
            <div
              key={session.id}
              className="recent-item"
              onClick={() => {
                setRecentOpen(false)
                onResumeSession(session.id)
              }}
            >
              <Typography.Text strong ellipsis style={{ display: 'block', fontSize: 13 }}>
                {session.title}
              </Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                {recentTimeLabel(session.updatedAt)}
              </Typography.Text>
            </div>
          ))
        )}
      </div>
      <button
        type="button"
        className="recent-footer"
        onClick={() => {
          setRecentOpen(false)
          onFocusSessionSearch()
        }}
      >
        <SearchOutlined style={{ marginRight: 8 }} />
        搜索并管理全部对话
      </button>
    </div>
  )

  // ── composer 卡片（欢迎屏与会话底栏共用同一节点结构）─────────────────────
  const composer = (
    <div
      className={`composer${dragOver ? ' composer-drag' : ''}`}
      onDragOver={(event) => {
        event.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(event) => {
        event.preventDefault()
        setDragOver(false)
        if (event.dataTransfer.files.length > 0) addImages(event.dataTransfer.files)
      }}
      onClick={() => textareaRef.current?.focus()}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept={IMAGE_ACCEPT}
        multiple
        hidden
        onChange={(event) => {
          if (event.target.files) addImages(event.target.files)
          event.target.value = ''
        }}
      />
      <div className="composer-chips">
        <span className="composer-chip" title={cwd}>
          <FolderOutlined />
          {projectName}
        </span>
      </div>
      {images.length > 0 && (
        <div className="composer-thumbs">
          {images.map((image, index) => (
            <span
              key={image.chip}
              className={`composer-thumb${image.status === 'error' ? ' error' : ''}`}
            >
              <img src={image.previewUrl} alt={image.chip} />
              {image.status === 'uploading' && (
                <span className="composer-thumb-mask">
                  <LoadingOutlined />
                </span>
              )}
              <button
                type="button"
                className="composer-thumb-x"
                aria-label={`移除 ${image.chip}`}
                onClick={(event) => {
                  event.stopPropagation()
                  setImages((current) => current.filter((_, i) => i !== index))
                }}
              >
                <CloseOutlined />
              </button>
            </span>
          ))}
        </div>
      )}
      <textarea
        ref={textareaRef}
        className="composer-input"
        rows={1}
        value={draft}
        placeholder={
          busy && sessionId === undefined
            ? '正在创建会话…'
            : '给智能体发消息（Enter 发送，Shift+Enter 换行）'
        }
        disabled={busy}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault()
            void send(draft)
          }
        }}
        onPaste={(event) => {
          if (event.clipboardData.files.length > 0) {
            event.preventDefault()
            addImages(event.clipboardData.files)
          }
        }}
        onClick={(event) => event.stopPropagation()}
      />
      <div className="composer-bar">
        <Tooltip title="添加图片">
          <button
            type="button"
            className="composer-btn"
            aria-label="添加图片"
            onClick={(event) => {
              event.stopPropagation()
              fileInputRef.current?.click()
            }}
          >
            <PlusOutlined />
          </button>
        </Tooltip>
        {permissionMode !== undefined && (
          <Dropdown
            trigger={['click']}
            menu={{
              items: PERMISSION_MODES.map((mode) => ({ key: mode.id, label: mode.label })),
              selectedKeys: [permissionMode],
              onClick: ({ key }) => {
                void api.setPermissionMode(key).then((result) => setPermissionMode(result.mode))
              },
            }}
          >
            <button
              type="button"
              className="composer-btn text"
              onClick={(e) => e.stopPropagation()}
            >
              <SafetyCertificateOutlined />
              {PERMISSION_MODES.find((mode) => mode.id === permissionMode)?.label ?? '询问'}
              <DownOutlined className="composer-caret" />
            </button>
          </Dropdown>
        )}
        <span style={{ flex: 1 }} />
        {models && models.options.length > 0 && (
          <Dropdown
            trigger={['click']}
            menu={{
              items: models.options.map((option) => ({ key: option.id, label: option.label })),
              selectedKeys: [modelOverride ?? models.current ?? ''],
              onClick: ({ key }) => setModelOverride(key === models.current ? undefined : key),
            }}
          >
            <button
              type="button"
              className="composer-btn text"
              onClick={(e) => e.stopPropagation()}
            >
              {models.options.find((option) => option.id === (modelOverride ?? models.current))
                ?.label ?? '模型'}
              <DownOutlined className="composer-caret" />
            </button>
          </Dropdown>
        )}
        {running && <LoadingOutlined className="composer-spin" />}
        <Tooltip title={running ? '中断本轮' : '发送'}>
          <button
            type="button"
            className={`composer-send${running ? ' stop' : ''}`}
            aria-label={running ? '中断本轮' : '发送'}
            disabled={!running && !canSend}
            onClick={(event) => {
              event.stopPropagation()
              if (running) void api.interrupt()
              else void send(draft)
            }}
          >
            {running ? <StopOutlined /> : <ArrowUpOutlined />}
          </button>
        </Tooltip>
      </div>
    </div>
  )

  const empty = chat.messages.length === 0
  const headerStatus = !connected ? '离线' : running ? '运行中' : '空闲'

  return (
    <div className="chat-wrap">
      {/* 顶栏：左留白 / 居中标题+副标 / 右侧图标按钮（对齐 CodeBuddy 会话头）。 */}
      <div className="chat-head">
        <div className="chat-head-side" />
        {!empty && (
          <div className="chat-head-center">
            <div className="chat-head-title">{sessionTitle ?? '新对话'}</div>
            <div className="chat-head-sub">
              {projectName} · 主智能体 · {headerStatus}
            </div>
          </div>
        )}
        <div className="chat-head-side actions">
          <Tooltip title="在当前智能体中新建对话">
            <Button
              size="small"
              type="text"
              icon={<NewChatIcon />}
              disabled={sessionId === undefined && chat.messages.length === 0}
              onClick={() => onSessionChange(undefined)}
            />
          </Tooltip>
          <Popover
            open={recentOpen}
            onOpenChange={setRecentOpen}
            trigger="click"
            placement="bottomRight"
            arrow={false}
            classNames={{ root: 'recent-popover' }}
            content={recentPanel}
          >
            <Tooltip title="最近会话 (⌘⇧H)">
              <Button
                size="small"
                type={recentOpen ? 'primary' : 'text'}
                icon={<HistoryOutlined />}
              />
            </Tooltip>
          </Popover>
          <Tooltip title="工作台">
            <Button
              size="small"
              type={workbenchOpen ? 'primary' : 'text'}
              icon={<WorkbenchIcon />}
              onClick={onToggleWorkbench}
            />
          </Tooltip>
          <Tooltip title="连接面板">
            <Button
              size="small"
              type={connectOpen ? 'primary' : 'text'}
              icon={<LinkOutlined />}
              onClick={onToggleConnect}
            />
          </Tooltip>
          {sessionId !== undefined && !embedded && (
            <Button size="small" onClick={() => void end()} disabled={busy}>
              结束会话
            </Button>
          )}
        </div>
      </div>

      {empty ? (
        /* 欢迎屏：品牌标 + 标语 + cwd + composer 卡片垂直居中。 */
        <div className="chat-hero">
          <BrandMark size={84} />
          <div className="chat-hero-tag">锻造灵感 · 化为现实</div>
          <div className="chat-hero-cwd">{cwd}</div>
          <div className="chat-hero-composer">{composer}</div>
          {chat.notice && (
            <Alert type="warning" showIcon title={chat.notice} style={{ marginTop: 12 }} />
          )}
        </div>
      ) : (
        <div className="chat-column">
          {/* 消息流 */}
          <div
            className="chat-scroll"
            ref={listRef}
            onScroll={() => {
              const el = listRef.current
              if (el) nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
            }}
          >
            <div className="chat-disclaimer">回答由 AI 生成，仅供参考</div>
            {chat.messages.map(renderMessage)}
            {chat.tools.map((tool) => (
              <div key={tool.toolUseId} className="tool-row">
                <span className={`tool-dot ${tool.status}`} />
                <span className="tool-name">{tool.tool}</span>
                <span className="tool-status">
                  {tool.status === 'running'
                    ? '运行中…'
                    : tool.status === 'error'
                      ? '失败'
                      : '完成'}
                </span>
              </div>
            ))}
            {running && !streamingReply && (
              <div className="think-row">
                <LoadingOutlined />
                {elapsed < 2 ? '准备中' : `思考中 · ${elapsed} 秒`}
              </div>
            )}
            {chat.permission && (
              <div className="perm-card">
                <Typography.Text strong>
                  权限请求：{chat.permission.display.toolName}
                </Typography.Text>
                <pre className="perm-spec">{chat.permission.display.spec}</pre>
                <div className="perm-actions">
                  {chat.permission.display.approvable ? (
                    <>
                      <Button size="small" type="primary" onClick={() => void decide('allow-once')}>
                        允许一次
                      </Button>
                      <Button size="small" onClick={() => void decide('allow-session')}>
                        本会话允许
                      </Button>
                    </>
                  ) : null}
                  <Button size="small" danger onClick={() => void decide('deny')}>
                    拒绝
                  </Button>
                </div>
              </div>
            )}
            {chat.notice && (
              <Alert type="warning" showIcon title={chat.notice} style={{ margin: '8px 0' }} />
            )}
            {chat.usage && (
              <div className="chat-usage">
                用量：in {chat.usage.input} / out {chat.usage.output}
                {chat.usage.costUSD ? ` · $${chat.usage.costUSD.toFixed(4)}` : ''}
              </div>
            )}
            {sessionId !== undefined && (
              <ChangesPanel api={api} sessionId={sessionId} refreshKey={chat.turn} quietWhenEmpty />
            )}
          </div>

          {/* composer */}
          <div className="chat-composer">{composer}</div>
        </div>
      )}
    </div>
  )
}
