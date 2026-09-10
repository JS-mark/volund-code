'use client'

/**
 * 聊天视图：虚拟化消息流（react-virtuoso——变高气泡 + 底部跟随），
 * 消息气泡 memo 化（流式 delta 只重绘最后一条），工具卡/审批卡/提示
 * 固定在输入区上方（不随滚动移出视野），transcript 水合期显示骨架气泡。
 */
import {
  CloseOutlined,
  LoadingOutlined,
  PaperClipOutlined,
  StopOutlined,
  ToolOutlined,
} from '@ant-design/icons'
import { Alert, Badge, Button, Empty, Input, Skeleton, Space, Tag } from 'antd'
import { memo, useEffect, useRef, useState } from 'react'
import Markdown from 'react-markdown'
import { Virtuoso } from 'react-virtuoso'
import remarkGfm from 'remark-gfm'

import type { ChatMessage, ChatMessageImage, ChatState } from '../lib/chat'
import type { StagedAttachment } from '../lib/gateway'

/** 输入区接受的图片 MIME（与网关 /v1/attachments 白名单一致）。 */
const IMAGE_ACCEPT = 'image/png,image/jpeg,image/gif,image/webp'

/** 待发图片 chips 行状态：uploading → ready/error（仅 ready 随提交出站）。 */
export interface PendingImage extends ChatMessageImage {
  /** 输入区 chip 一定有本地预览（选图即建 objectURL）——收窄回必填。 */
  previewUrl: string
  status: 'uploading' | 'ready' | 'error'
  staged?: StagedAttachment
}

/** 提交时传给父级的图片（staged 必在——uploading/error 已被 send 拦住）。 */
export interface SubmitImage extends ChatMessageImage {
  staged: StagedAttachment
}

/** 单条消息：memo 隔离——reducer 不可变更新下旧消息对象身份不变，流式期间不重渲染。 */
const MessageBubble = memo(function MessageBubble({
  entry,
  resolveAttachment,
}: {
  entry: ChatMessage
  resolveAttachment: (handle: string) => Promise<string>
}) {
  if (entry.role === 'user' || entry.role === 'system') {
    return (
      <div className={`bubble-row ${entry.role}`}>
        <div className={`bubble ${entry.role === 'user' ? 'user' : 'system'}`}>
          {entry.images?.length ? (
            <div className="msg-images">
              {entry.images.map((image) => (
                <AttachmentImage
                  key={image.chip}
                  image={image}
                  resolveAttachment={resolveAttachment}
                />
              ))}
            </div>
          ) : null}
          {entry.text}
        </div>
      </div>
    )
  }
  return (
    <div className="bubble-row assistant">
      <div className="bubble assistant">
        {entry.thinking && (
          <details className="thinking">
            <summary>
              思考过程
              {entry.streaming && !entry.text && (
                <LoadingOutlined style={{ fontSize: 11, marginLeft: 4 }} />
              )}
            </summary>
            <div className="thinking-body">{entry.thinking}</div>
          </details>
        )}
        {entry.text && <Markdown remarkPlugins={[remarkGfm]}>{entry.text}</Markdown>}
        {entry.streaming && <LoadingOutlined style={{ fontSize: 12, color: 'rgba(0,0,0,0.35)' }} />}
      </div>
    </div>
  )
})

/**
 * 消息里的图片：本地预览（objectURL）直出；仅 handle 引用时（transcript 水合/跨端
 * 消息）经网关拉字节转 objectURL，组件卸载即回收（字节缓存留在 gateway 层）。
 */
function AttachmentImage({
  image,
  resolveAttachment,
}: {
  image: ChatMessageImage
  resolveAttachment: (handle: string) => Promise<string>
}) {
  const [src, setSrc] = useState<string | undefined>(image.previewUrl)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (image.previewUrl || !image.handle) return
    let alive = true
    let objectUrl: string | undefined
    resolveAttachment(image.handle)
      .then((url) => {
        if (alive) {
          objectUrl = url
          setSrc(url)
        } else {
          URL.revokeObjectURL(url)
        }
      })
      .catch(() => {
        if (alive) setFailed(true)
      })
    return () => {
      alive = false
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [image.previewUrl, image.handle, resolveAttachment])
  // 拉不到字节（已清理/链路断）时退回 chip 文本，与 TUI/Web 的回放面一致。
  if (failed || (!image.previewUrl && !image.handle)) return <span>{image.chip}</span>
  if (src === undefined)
    return (
      <span className="msg-image-loading" aria-label={`加载 ${image.chip}`}>
        <LoadingOutlined />
      </span>
    )
  return <img src={src} alt={image.chip} />
}

function HydratingSkeleton() {
  return (
    <div aria-busy="true" style={{ padding: '16px 12px' }}>
      {[72, 16, 48].map((width, index) => (
        <div key={index} className={index % 2 ? 'bubble-row user' : 'bubble-row assistant'}>
          <div className={`bubble ${index % 2 ? 'user' : 'assistant'}`} style={{ width }}>
            <Skeleton active title={false} paragraph={{ rows: 1 }} style={{ minWidth: width }} />
          </div>
        </div>
      ))}
    </div>
  )
}

export function ChatView({
  state,
  connected,
  loading,
  activeSessionId,
  onEcho,
  onSubmit,
  onStage,
  onInterrupt,
  onDecide,
  resolveAttachment,
  onGoSessions,
}: {
  state: ChatState
  connected: boolean
  /** transcript 水合中（首屏骨架）。 */
  loading: boolean
  activeSessionId: string | undefined
  onEcho(text: string, images: readonly ChatMessageImage[]): void
  /** text 已是出站 prompt（无文本时以 chip 占位）；images 仅含已暂存完成的。 */
  onSubmit(text: string, images: readonly SubmitImage[]): void
  /** 选图即上传暂存（经网关进本机 AttachmentStore）；失败抛错，chip 转 error 态。 */
  onStage(file: File): Promise<StagedAttachment>
  onInterrupt(): void
  onDecide(requestId: string, kind: 'allow' | 'deny'): void
  /** handle 引用图片的字节解析（网关下载 → objectURL；调用方负责稳定引用）。 */
  resolveAttachment(handle: string): Promise<string>
  /** 空态 CTA：跳会话列表选择/新建会话。 */
  onGoSessions(): void
}) {
  const [text, setText] = useState('')
  const [images, setImages] = useState<PendingImage[]>([])
  const chipSeqRef = useRef(0)
  const fileRef = useRef<HTMLInputElement>(null)

  const pickImages = (files: FileList | null) => {
    if (!files) return
    for (const file of Array.from(files)) {
      if (!file.type.startsWith('image/')) continue
      chipSeqRef.current += 1
      const chip = `[image_${chipSeqRef.current}]`
      const previewUrl = URL.createObjectURL(file)
      setImages((current) => [...current, { chip, previewUrl, status: 'uploading' }])
      onStage(file)
        .then((staged) =>
          setImages((current) =>
            current.map((item) =>
              item.chip === chip ? { ...item, status: 'ready', staged } : item,
            ),
          ),
        )
        .catch(() =>
          setImages((current) =>
            current.map((item) => (item.chip === chip ? { ...item, status: 'error' } : item)),
          ),
        )
    }
  }

  const removeImage = (chip: string) => {
    setImages((current) => {
      const target = current.find((item) => item.chip === chip)
      if (target) URL.revokeObjectURL(target.previewUrl)
      return current.filter((item) => item.chip !== chip)
    })
  }

  const send = () => {
    const value = text.trim()
    const ready = images.filter((item) => item.status === 'ready' && item.staged)
    if (!value && !ready.length) return
    // 上传在途时拦下发送，避免漏图（chip 上有转圈，等转完再发）。
    if (images.some((item) => item.status === 'uploading')) return
    onEcho(
      value,
      ready.map((item) => ({
        chip: item.chip,
        previewUrl: item.previewUrl,
        // 顺手带上 handle：本地预览失效（回显被水合替换）时仍有取字节的退路。
        ...(item.staged?.handle ? { handle: item.staged.handle } : {}),
      })),
    )
    onSubmit(value || ready.map((item) => item.chip).join(' '), ready as readonly SubmitImage[])
    setText('')
    setImages([])
  }

  const messages = state.messages
  const showSkeleton = loading && messages.length === 0

  // 无活动会话：整页空态引导（创建/恢复只从会话列表发起，输入区不出现）。
  if (activeSessionId === undefined && !loading) {
    return (
      <div className="chat-empty">
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有进行中的会话">
          <Button type="primary" onClick={onGoSessions}>
            去选择会话
          </Button>
        </Empty>
        {state.notice && (
          <Alert
            type="warning"
            showIcon={false}
            title={state.notice}
            closable
            style={{ fontSize: 12, marginTop: 12 }}
          />
        )}
      </div>
    )
  }

  return (
    <>
      {showSkeleton ? (
        <div className="chat-scroll chat-item">
          <HydratingSkeleton />
        </div>
      ) : (
        <Virtuoso
          className="chat-scroll"
          data={messages}
          initialTopMostItemIndex={Math.max(0, messages.length - 1)}
          followOutput={(isAtBottom) => (isAtBottom ? 'smooth' : false)}
          increaseViewportBy={{ top: 600, bottom: 600 }}
          computeItemKey={(_, entry) => entry.id}
          itemContent={(_, entry) => (
            <div className="chat-item">
              {<MessageBubble entry={entry} resolveAttachment={resolveAttachment} />}
            </div>
          )}
        />
      )}
      <div className="chat-overlay">
        {state.turn === 'running' && !messages.some((message) => message.streaming) && (
          <div className="overlay-hint">
            正在思考…
            <LoadingOutlined style={{ fontSize: 12, marginLeft: 6 }} />
          </div>
        )}
        {state.tools.length > 0 && (
          <div className="overlay-tools">
            {state.tools.slice(-4).map((tool) => (
              <span key={tool.toolUseId} className="tool-chip">
                <ToolOutlined style={{ fontSize: 11 }} />
                {tool.tool}
                {tool.status === 'running' ? (
                  <Badge status="processing" />
                ) : tool.status === 'error' ? (
                  <Tag color="error" style={{ fontSize: 10, lineHeight: '16px', margin: 0 }}>
                    失败
                  </Tag>
                ) : (
                  <Tag style={{ fontSize: 10, lineHeight: '16px', margin: 0 }}>完成</Tag>
                )}
              </span>
            ))}
          </div>
        )}
        {state.notice && (
          <Alert
            type="warning"
            showIcon={false}
            title={state.notice}
            closable
            style={{ fontSize: 12 }}
          />
        )}
        {state.permission && (
          <Alert
            type="warning"
            showIcon
            title={`权限请求：${state.permission.display.toolName}`}
            description={state.permission.display.spec}
            action={
              <Space orientation="vertical">
                <Button
                  size="small"
                  type="primary"
                  onClick={() => onDecide(state.permission!.id, 'allow')}
                >
                  批准
                </Button>
                <Button size="small" danger onClick={() => onDecide(state.permission!.id, 'deny')}>
                  拒绝
                </Button>
              </Space>
            }
          />
        )}
      </div>
      <div className="composer-wrap">
        {images.length > 0 && (
          <div className="chips">
            {images.map((image) => (
              <span key={image.chip} className={`chip ${image.status}`}>
                <img src={image.previewUrl} alt={image.chip} />
                {image.status === 'uploading' && <LoadingOutlined className="chip-status" />}
                {image.status === 'error' && <span className="chip-status">失败</span>}
                <button
                  type="button"
                  className="chip-remove"
                  aria-label={`移除 ${image.chip}`}
                  onClick={() => removeImage(image.chip)}
                >
                  <CloseOutlined style={{ fontSize: 10 }} />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="composer">
          <button
            type="button"
            className="attach-btn"
            aria-label="添加图片"
            disabled={!connected}
            onClick={() => fileRef.current?.click()}
          >
            <PaperClipOutlined style={{ fontSize: 18 }} />
          </button>
          <input
            ref={fileRef}
            type="file"
            accept={IMAGE_ACCEPT}
            multiple
            hidden
            onChange={(event) => {
              pickImages(event.target.files)
              // 允许重选同一文件（值不变不触发 change）。
              event.target.value = ''
            }}
          />
          <Input
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={connected ? '发消息…' : '连接中…'}
            disabled={!connected}
            onPressEnter={send}
            enterKeyHint="send"
            style={{ borderRadius: 18 }}
          />
          {state.turn === 'running' ? (
            <Button type="text" danger icon={<StopOutlined />} onClick={onInterrupt}>
              中断
            </Button>
          ) : (
            <Button
              type="primary"
              disabled={
                !connected ||
                (!text.trim() && !images.some((item) => item.status === 'ready')) ||
                images.some((item) => item.status === 'uploading')
              }
              onClick={send}
              style={{ borderRadius: 18 }}
            >
              发送
            </Button>
          )}
        </div>
      </div>
    </>
  )
}
