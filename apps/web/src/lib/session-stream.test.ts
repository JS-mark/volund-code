import { describe, expect, it } from 'vitest'

import type { ChatState } from './session-stream'
import { initialChatState, reduceChatState } from './session-stream'

/** 构造信封：view 事件的字段（request/message）与 type 平级——与 SessionHub 的实际发射形状一致。 */
function envelope(
  kind: string,
  event: { type: string; payload?: Record<string, unknown> } & Record<string, unknown>,
) {
  const { type, payload, ...rest } = event
  return {
    type: 'envelope' as const,
    envelope: {
      streamVersion: 1,
      cursor: '1',
      kind: kind as 'core' | 'view' | 'control',
      event: { type, payload: payload ?? {}, ...rest },
    },
  }
}

function reduceMany(state: ChatState, actions: Parameters<typeof reduceChatState>[1][]): ChatState {
  return actions.reduce(reduceChatState, state)
}

describe('reduceChatState（SSE 与本地动作合流）', () => {
  it('流式 delta 追加到同一 assistant 消息，completed 后收口', () => {
    const state = reduceMany(initialChatState, [
      envelope('core', { type: 'turn.started' }),
      envelope('core', {
        type: 'stream.delta',
        payload: { kind: 'text', messageId: 'm1', fragment: '你' },
      }),
      envelope('core', {
        type: 'stream.delta',
        payload: { kind: 'text', messageId: 'm1', fragment: '好' },
      }),
    ])
    expect(state.turn).toBe('running')
    expect(state.messages).toEqual([{ id: 'm1', role: 'assistant', text: '你好', streaming: true }])
    const done = reduceChatState(
      state,
      envelope('core', { type: 'stream.completed', payload: { messageId: 'm1' } }),
    )
    expect(done.messages[0]?.streaming).toBe(false)
  })

  it('message.appended 收口同 id 流式消息', () => {
    const streaming = reduceChatState(
      initialChatState,
      envelope('core', {
        type: 'stream.delta',
        payload: { kind: 'text', messageId: 'm1', fragment: '部分' },
      }),
    )
    const state = reduceChatState(
      streaming,
      envelope('core', {
        type: 'message.appended',
        payload: { messageId: 'm1', role: 'assistant', content: [{ type: 'text', text: '完整' }] },
      }),
    )
    expect(state.messages).toHaveLength(1)
    expect(state.messages[0]).toMatchObject({ text: '完整', streaming: false })
  })

  it('user 的 message.appended 到达时清掉本地乐观回显（不回声成双）', () => {
    const echoed = reduceChatState(initialChatState, {
      type: 'echo',
      text: '你好',
      images: [],
    })
    expect(echoed.messages[0]).toMatchObject({ role: 'user', local: true })
    const state = reduceChatState(
      echoed,
      envelope('core', {
        type: 'message.appended',
        payload: { messageId: 'real-1', role: 'user', content: [{ type: 'text', text: '你好' }] },
      }),
    )
    expect(state.messages).toHaveLength(1)
    expect(state.messages[0]).toMatchObject({ id: 'real-1', role: 'user', text: '你好' })
  })

  it('权限请求经 view 信封进卡，resolved 后清卡', () => {
    const requested = reduceChatState(
      initialChatState,
      envelope('view', {
        type: 'permission.request',
        request: {
          id: 'p1',
          attempt: 1,
          display: { approvable: true, spec: 'bash', toolName: 'Bash' },
        },
      }),
    )
    expect(requested.permission?.id).toBe('p1')
    const resolved = reduceChatState(
      requested,
      envelope('view', { type: 'permission.resolved', request: { id: 'p1' } }),
    )
    expect(resolved.permission).toBeUndefined()
  })

  it('hydrate 以 transcript 为准替换消息列表', () => {
    const dirty = reduceChatState(initialChatState, { type: 'echo', text: '旧', images: [] })
    const state = reduceChatState(dirty, {
      type: 'hydrate',
      transcript: [{ id: 't1', role: 'user', text: '持久化' }],
    })
    expect(state.messages).toEqual([{ id: 't1', role: 'user', text: '持久化' }])
  })

  it('hydrate 与 SSE 并发：快照后到达的消息不被冲掉，本地回声被收口', () => {
    // 回归：会话创建即发送时 transcript 水合曾把 user/appended 消息整批擦掉。
    let state = reduceChatState(initialChatState, { type: 'echo', text: '你好', images: [] })
    state = reduceChatState(
      state,
      envelope('core', {
        type: 'message.appended',
        payload: { messageId: 'u1', role: 'user', content: [{ type: 'text', text: '你好' }] },
      }),
    )
    state = reduceChatState(
      state,
      envelope('core', {
        type: 'stream.delta',
        payload: { kind: 'text', messageId: 'a1', fragment: '正在' },
      }),
    )
    // transcript 快照只含 user 消息（assistant 尚未落盘）
    state = reduceChatState(state, {
      type: 'hydrate',
      transcript: [{ id: 'u1', role: 'user', text: '你好' }],
    })
    expect(state.messages.map((m) => m.id)).toEqual(['u1', 'a1'])
    expect(state.messages[1]).toMatchObject({ text: '正在', streaming: true })
  })

  it('error.raised 从 context.message 取详情；turn.aborted(reason=error) 不覆盖', () => {
    let state = reduceChatState(initialChatState, envelope('core', { type: 'turn.started' }))
    state = reduceChatState(
      state,
      envelope('core', {
        type: 'error.raised',
        payload: { code: 'runner_error', context: { message: 'model does not support images' } },
      }),
    )
    expect(state.notice).toBe('错误 runner_error: model does not support images')
    state = reduceChatState(
      state,
      envelope('core', { type: 'turn.aborted', payload: { reason: 'error' } }),
    )
    expect(state.turn).toBe('idle')
    expect(state.notice).toBe('错误 runner_error: model does not support images')
  })

  it('control 帧（hello/heartbeat）不是业务信封：原样返回不抛错', () => {
    // 回归：useReducer 延迟求值，畸形帧曾在 reducer 内抛错炸掉整棵 React 树。
    const heartbeat = {
      type: 'envelope' as const,
      envelope: { kind: 'heartbeat' } as never,
    }
    expect(reduceChatState(initialChatState, heartbeat)).toBe(initialChatState)
  })

  it('turn.failed 回到 idle 并给出提示', () => {
    const running = reduceChatState(initialChatState, envelope('core', { type: 'turn.started' }))
    const state = reduceChatState(
      running,
      envelope('view', { type: 'turn.failed', message: 'boom' }),
    )
    expect(state.turn).toBe('idle')
    expect(state.notice).toBe('boom')
  })
})
