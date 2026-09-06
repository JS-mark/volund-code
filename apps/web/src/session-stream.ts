/**
 * 会话事件流 reducer（§22.8.3）：SSE 信封 → 聊天视图状态。
 * 幂等去重以 (cursor) 为键；stream.delta 只追加（不落盘，刷新以 transcript 为准）。
 */
import { useEffect, useRef, useState } from 'react'

export interface ChatMessage {
  id: string
  role: 'assistant' | 'system' | 'user'
  text: string
  streaming?: boolean
}

export interface ToolCard {
  toolUseId: string
  tool: string
  status: 'running' | 'done' | 'error'
}

export interface PermissionCard {
  id: string
  attempt: number
  display: { approvable: boolean; spec: string; toolName: string }
}

export interface ChatState {
  messages: ChatMessage[]
  tools: ToolCard[]
  turn: 'idle' | 'running'
  usage: { inputTokens: number; outputTokens: number; costUSD: number | null } | undefined
  permission: PermissionCard | undefined
  notice: string | undefined
}

export const initialChatState: ChatState = {
  messages: [],
  tools: [],
  turn: 'idle',
  usage: undefined,
  permission: undefined,
  notice: undefined,
}

type Envelope = {
  streamVersion: number
  cursor: string
  kind: 'core' | 'view' | 'control'
  event: {
    type: string
    payload: Record<string, unknown>
  }
}

function textOfContent(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .map((part) =>
      typeof part === 'object' && part !== null && (part as { text?: unknown }).text
        ? String((part as { text: unknown }).text)
        : '',
    )
    .join('')
}

export function reduceEnvelope(state: ChatState, envelope: Envelope): ChatState {
  const { event } = envelope
  const payload = event.payload ?? {}
  switch (event.type) {
    case 'message.appended': {
      const id = String(payload.messageId)
      const text = textOfContent(payload.content)
      const role = payload.role as ChatMessage['role']
      // 流式中已存在的同 id 流式消息：以持久化完整消息收口。
      const messages = state.messages.some((message) => message.id === id)
        ? state.messages.map((message) =>
            message.id === id ? { ...message, text, streaming: false } : message,
          )
        : [...state.messages, { id, role, text }]
      return { ...state, messages }
    }
    case 'stream.delta': {
      if (payload.kind !== 'text') return state
      const id = String(payload.messageId)
      const fragment = String(payload.fragment)
      const messages = state.messages.some((message) => message.id === id)
        ? state.messages.map((message) =>
            message.id === id
              ? { ...message, text: message.text + fragment, streaming: true }
              : message,
          )
        : [...state.messages, { id, role: 'assistant' as const, text: fragment, streaming: true }]
      return { ...state, messages }
    }
    case 'stream.completed': {
      const id = String(payload.messageId)
      return {
        ...state,
        messages: state.messages.map((message) =>
          message.id === id ? { ...message, streaming: false } : message,
        ),
      }
    }
    case 'turn.started':
      return { ...state, turn: 'running', usage: undefined }
    case 'turn.completed':
      return {
        ...state,
        turn: 'idle',
        usage: payload.usage as ChatState['usage'],
      }
    case 'turn.aborted':
      return { ...state, turn: 'idle', notice: '本轮已中断' }
    case 'tool.started':
      return {
        ...state,
        tools: [
          ...state.tools.filter((tool) => tool.toolUseId !== payload.toolUseId),
          { toolUseId: String(payload.toolUseId), tool: String(payload.tool), status: 'running' },
        ],
      }
    case 'tool.completed': {
      const id = String(payload.toolUseId)
      const failed = payload.isError === true
      return {
        ...state,
        tools: state.tools.map((tool) =>
          tool.toolUseId === id ? { ...tool, status: failed ? 'error' : 'done' } : tool,
        ),
      }
    }
    case 'error.raised':
      return {
        ...state,
        notice: `错误 ${String(payload.code ?? '')}: ${String(payload.message ?? '')}`,
      }
    default:
      break
  }
  if (envelope.kind === 'view') {
    const view = event as unknown as { type: string; request?: PermissionCard; message?: string }
    if (view.type === 'permission.request' && view.request)
      return { ...state, permission: view.request }
    if (view.type === 'permission.resolved') return { ...state, permission: undefined }
    if (view.type === 'turn.failed')
      return { ...state, turn: 'idle', notice: view.message ?? 'turn 失败' }
    if (view.type === 'session.attached') return { ...initialChatState, notice: '已连接会话' }
  }
  return state
}

/** 从 transcript 快照恢复（刷新场景），再叠加 SSE 增量。 */
export function hydrateFromTranscript(state: ChatState, transcript: readonly unknown[]): ChatState {
  const messages: ChatMessage[] = []
  for (const entry of transcript) {
    const item = entry as { id?: string; role?: string; text?: string }
    if (item.id && item.role && item.text)
      messages.push({ id: item.id, role: item.role as ChatMessage['role'], text: item.text })
  }
  return { ...state, messages }
}

/** 订阅 /api/v1/events；返回最新状态（ 引用稳定：仅在事件到达时更新）。 */
export function useSessionStream(enabled: boolean): ChatState {
  const [state, setState] = useState<ChatState>(initialChatState)
  const stateRef = useRef(state)
  stateRef.current = state

  useEffect(() => {
    if (!enabled) return
    const source = new EventSource('/api/v1/events')
    const handler = (raw: MessageEvent) => {
      try {
        const envelope = JSON.parse(raw.data as string) as Envelope
        setState(reduceEnvelope(stateRef.current, envelope))
      } catch {
        // 心跳/无法解析的信封忽略。
      }
    }
    source.addEventListener('core', handler as EventListener)
    source.addEventListener('view', handler as EventListener)
    source.addEventListener('control', handler as EventListener)
    return () => source.close()
  }, [enabled])

  return state
}
