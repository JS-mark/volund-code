'use client'

import {
  CloseOutlined,
  HistoryOutlined,
  LinkOutlined,
  LoadingOutlined,
  SearchOutlined,
} from '@ant-design/icons'
import { Attachments, Bubble, Sender } from '@ant-design/x'
import type { AttachmentsProps } from '@ant-design/x'
import { Alert, Button, Card, Dropdown, Popover, Space, Tag, Tooltip, Typography } from 'antd'
import { useCallback, useEffect, useRef, useState } from 'react'

import type { ModelsView, SessionSummary, StagedAttachment, WebApi } from '../lib/api'
import type { ChatImage } from '../lib/session-stream'
import { useSessionStream } from '../lib/session-stream'
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

/**
 * 聊天视图（§22 W-04/W-05/W-07；antd-x Bubble/Sender/Attachments）。
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
  onNavigate,
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
  onNavigate(route: 'manage' | 'status' | 'changes'): void
}) {
  const stream = useSessionStream(sessionId !== undefined, sessionId)
  const chat = stream.state
  const [draft, setDraft] = useState(() => localStorage.getItem(`volund-web-draft:${cwd}`) ?? '')
  const [images, setImages] = useState<PendingImage[]>([])
  const [busy, setBusy] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const nearBottomRef = useRef(true)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const chipSeqRef = useRef(0)
  const [models, setModels] = useState<ModelsView>()
  const [modelOverride, setModelOverride] = useState<string>()
  const [permissionMode, setPermissionMode] = useState<string>()
  const [recentOpen, setRecentOpen] = useState(false)

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

  // 消息列表自动滚底（用户上翻时不打断；Bubble.List 自带 autoScroll 也不依赖它）。
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
      try {
        // 无活动会话时先创建（runner 激活要数秒）——busy 期间 composer 给出明确反馈。
        await ensureSession()
        const echoImages: ChatImage[] = ready.map((item) => ({
          chip: item.chip,
          mime: item.mime,
          previewUrl: item.previewUrl,
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

  const lastMessage = chat.messages.at(-1)
  const thinking =
    chat.turn === 'running' && !(lastMessage?.role === 'assistant' && lastMessage.streaming)

  // Bubble.List 的消息项：user 右置气泡，assistant 全宽 markdown，system 淡提示。
  const bubbleItems = chat.messages.map((message) => ({
    key: message.id,
    role: message.role,
    content: message,
  }))

  const attachmentItems: NonNullable<AttachmentsProps['items']> = images.map((image, index) => ({
    uid: String(index),
    name: image.chip,
    status:
      image.status === 'error' ? 'error' : image.status === 'uploading' ? 'uploading' : 'done',
    thumbUrl: image.previewUrl,
    url: image.previewUrl,
  }))

  const onRemoveAttachment = useCallback((item: { uid: string }) => {
    const index = Number(item.uid)
    setImages((current) => current.filter((_, i) => i !== index))
  }, [])

  const headerNode = images.length > 0 && (
    <Sender.Header title="图片附件">
      <Attachments items={attachmentItems} onRemove={onRemoveAttachment} />
    </Sender.Header>
  )

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

  return (
    <div className="chat-wrap">
      {/* 顶栏：通栏，标题 + cwd 在左，状态 + 图标按钮 + 结束会话 在最右 */}
      <div className="chat-head">
        <Typography.Text strong ellipsis style={{ maxWidth: 320 }}>
          {sessionTitle ?? '新对话'}
        </Typography.Text>
        <Typography.Text type="secondary" ellipsis style={{ maxWidth: 260, fontSize: 12 }}>
          {cwd}
        </Typography.Text>
        <span style={{ flex: 1 }} />
        <Tag color={connected ? 'success' : 'default'}>{connected ? '已连接' : '连接中'}</Tag>
        {sessionId !== undefined && (
          <Tag color={chat.turn === 'running' ? 'processing' : 'default'}>
            {chat.turn === 'running' ? '运行中' : '空闲'}
          </Tag>
        )}
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

      <div className="chat-column">
        {/* 消息流 */}
        <div className="chat-scroll" ref={listRef}>
          {chat.messages.length === 0 ? (
            <div className="hero">
              <Typography.Title level={3} style={{ marginBottom: 4 }}>
                把想法变成代码
              </Typography.Title>
              <Typography.Text type="secondary">{cwd}</Typography.Text>
              <div className="hero-tiles">
                <Button size="large" onClick={() => fileInputRef.current?.click()}>
                  🖼 图片
                </Button>
                <Button size="large" onClick={() => onSessionChange(undefined)}>
                  ＋ 新对话
                </Button>
                <Button
                  size="large"
                  disabled={sessionId === undefined}
                  onClick={() => onNavigate('changes')}
                >
                  🗂 变更
                </Button>
                <Button size="large" onClick={() => onNavigate('manage')}>
                  ⊞ 管理面板
                </Button>
              </div>
            </div>
          ) : (
            <Bubble.List
              autoScroll={false}
              items={bubbleItems}
              role={{
                user: {
                  placement: 'end',
                  variant: 'filled',
                  contentRender: (content) => {
                    const message = content as (typeof chat.messages)[number]
                    return (
                      <div>
                        {message.images?.map((image) => (
                          <img
                            key={image.chip}
                            className="msg-image"
                            src={image.previewUrl}
                            alt={image.chip}
                          />
                        ))}
                        {message.text}
                      </div>
                    )
                  },
                },
                assistant: {
                  placement: 'start',
                  variant: 'borderless',
                  contentRender: (content) => {
                    const message = content as (typeof chat.messages)[number]
                    return (
                      <div>
                        <Markdown text={message.text} />
                        {message.streaming && <LoadingOutlined />}
                      </div>
                    )
                  },
                },
                system: {
                  placement: 'start',
                  variant: 'borderless',
                  contentRender: (content) => (
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {String((content as { text?: string }).text ?? '')}
                    </Typography.Text>
                  ),
                },
              }}
            />
          )}
          {chat.tools.map((tool) => (
            <div key={tool.toolUseId} style={{ padding: '2px 0 2px 8px' }}>
              <Tag
                color={
                  tool.status === 'running'
                    ? 'processing'
                    : tool.status === 'error'
                      ? 'error'
                      : 'success'
                }
              >
                {tool.tool}
              </Tag>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {tool.status === 'running' ? '运行中…' : tool.status === 'error' ? '失败' : '完成'}
              </Typography.Text>
            </div>
          ))}
          {thinking && (
            <Typography.Text type="secondary" style={{ padding: '4px 8px', display: 'block' }}>
              正在思考…
            </Typography.Text>
          )}
          {chat.permission && (
            <Card
              size="small"
              style={{ borderColor: 'var(--ant-color-warning, #d9a13b)', margin: '8px 0' }}
            >
              <Typography.Text strong>权限请求：{chat.permission.display.toolName}</Typography.Text>
              <pre
                style={{
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                  fontSize: 12,
                  margin: '8px 0',
                }}
              >
                {chat.permission.display.spec}
              </pre>
              <Space>
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
              </Space>
            </Card>
          )}
          {chat.notice && (
            <Alert type="warning" showIcon title={chat.notice} style={{ margin: '8px 0' }} />
          )}
          {chat.usage && (
            <Typography.Text
              type="secondary"
              style={{ fontSize: 12, display: 'block', textAlign: 'right' }}
            >
              用量：in {chat.usage.input} / out {chat.usage.output}
              {chat.usage.costUSD ? ` · $${chat.usage.costUSD.toFixed(4)}` : ''}
            </Typography.Text>
          )}
          {sessionId !== undefined && (
            <ChangesPanel api={api} sessionId={sessionId} refreshKey={chat.turn} quietWhenEmpty />
          )}
        </div>

        {/* composer */}
        <div style={{ padding: '4px 0 16px' }}>
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
          <Sender
            value={draft}
            placeholder={
              busy && sessionId === undefined
                ? '正在创建会话…'
                : '给智能体发消息（Enter 发送，Shift+Enter 换行；支持粘贴或拖入图片）'
            }
            loading={chat.turn === 'running'}
            disabled={busy}
            submitType="enter"
            header={headerNode}
            onChange={setDraft}
            onSubmit={(message) => void send(message)}
            onCancel={() => void api.interrupt()}
            onPasteFile={(files) => addImages(files)}
            footer={
              <Space size={4} style={{ width: '100%', justifyContent: 'flex-start' }}>
                <Button size="small" type="text" onClick={() => fileInputRef.current?.click()}>
                  ＋ 图片
                </Button>
                {permissionMode !== undefined && (
                  <Dropdown
                    trigger={['click']}
                    menu={{
                      items: PERMISSION_MODES.map((mode) => ({ key: mode.id, label: mode.label })),
                      selectedKeys: [permissionMode],
                      onClick: ({ key }) => {
                        void api
                          .setPermissionMode(key)
                          .then((result) => setPermissionMode(result.mode))
                      },
                    }}
                  >
                    <Button size="small" type="text">
                      {PERMISSION_MODES.find((mode) => mode.id === permissionMode)?.label ?? '询问'}{' '}
                      ▾
                    </Button>
                  </Dropdown>
                )}
                {models && models.options.length > 0 && (
                  <Dropdown
                    trigger={['click']}
                    menu={{
                      items: models.options.map((option) => ({
                        key: option.id,
                        label: option.label,
                      })),
                      selectedKeys: [modelOverride ?? models.current ?? ''],
                      onClick: ({ key }) =>
                        setModelOverride(key === models.current ? undefined : key),
                    }}
                  >
                    <Button size="small" type="text">
                      {models.options.find(
                        (option) => option.id === (modelOverride ?? models.current),
                      )?.label ?? '模型'}{' '}
                      ▾
                    </Button>
                  </Dropdown>
                )}
              </Space>
            }
          />
        </div>
      </div>
    </div>
  )
}
