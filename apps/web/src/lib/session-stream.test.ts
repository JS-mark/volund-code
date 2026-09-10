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
    // at 是到达打点（Date.now()），不参与内容断言。
    expect(state.messages).toEqual([
      { id: 'm1', role: 'assistant', text: '你好', streaming: true, at: expect.any(Number) },
    ])
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

  it('message.appended 只取 text part：thinking 不混进正文', () => {
    const state = reduceChatState(
      initialChatState,
      envelope('core', {
        type: 'message.appended',
        payload: {
          messageId: 'a1',
          role: 'assistant',
          content: [
            { type: 'thinking', text: '让我想想' },
            { type: 'text', text: '# 标题' },
          ],
        },
      }),
    )
    expect(state.messages[0]?.text).toBe('# 标题')
  })

  it('message.appended 跳过无可见内容的消息（tool_use / tool_result 空气泡）', () => {
    let state = reduceChatState(
      initialChatState,
      envelope('core', {
        type: 'message.appended',
        payload: {
          messageId: 'a1',
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: {} }],
        },
      }),
    )
    state = reduceChatState(
      state,
      envelope('core', {
        type: 'message.appended',
        payload: {
          messageId: 'u2',
          role: 'user',
          content: [
            { type: 'tool_result', toolUseId: 'tu1', content: [{ type: 'text', text: 'ok' }] },
          ],
        },
      }),
    )
    expect(state.messages).toHaveLength(0)
  })

  it('error.raised 兼读 context.reason（stream_interrupted 的细节在 reason 键）', () => {
    const state = reduceChatState(
      initialChatState,
      envelope('core', {
        type: 'error.raised',
        payload: { code: 'stream_interrupted', context: { reason: 'read ECONNRESET' } },
      }),
    )
    expect(state.notice).toBe('错误 stream_interrupted: read ECONNRESET')
  })

  it('message.appended 从 content 的 image part 取 handle 引用（跨端/重放消息回显）', () => {
    const handle = `${'a'.repeat(64)}.png`
    const state = reduceChatState(
      initialChatState,
      envelope('core', {
        type: 'message.appended',
        payload: {
          messageId: 'u1',
          role: 'user',
          content: [
            { type: 'image', source: { kind: 'handle', handle }, mime: 'image/png' },
            { type: 'text', text: '看这张图' },
          ],
        },
      }),
    )
    expect(state.messages).toHaveLength(1)
    expect(state.messages[0]).toMatchObject({
      id: 'u1',
      text: '看这张图',
      images: [{ chip: '[image: aaaaaaaa.png]', handle, mime: 'image/png' }],
    })
  })

  it('纯图片无文本的 user 消息不被空气泡守卫吞掉', () => {
    const handle = `${'b'.repeat(64)}.webp`
    const state = reduceChatState(
      initialChatState,
      envelope('core', {
        type: 'message.appended',
        payload: {
          messageId: 'u1',
          role: 'user',
          content: [{ type: 'image', source: { kind: 'handle', handle }, mime: 'image/webp' }],
        },
      }),
    )
    expect(state.messages).toHaveLength(1)
    expect(state.messages[0]?.images?.[0]?.handle).toBe(handle)
  })

  it('user 消息收口：本地回声的图片转交给确认消息（不闪没）', () => {
    const echoed = reduceChatState(initialChatState, {
      type: 'echo',
      text: '看图',
      images: [{ chip: '[image_1]', mime: 'image/png', previewUrl: 'blob:local-preview' }],
    })
    const state = reduceChatState(
      echoed,
      envelope('core', {
        type: 'message.appended',
        payload: {
          messageId: 'real-1',
          role: 'user',
          content: [
            {
              type: 'image',
              source: { kind: 'handle', handle: `${'c'.repeat(64)}.png` },
              mime: 'image/png',
            },
            { type: 'text', text: '看图' },
          ],
        },
      }),
    )
    expect(state.messages).toHaveLength(1)
    // 回声图片（blob 预览）优先于 content 的 handle 引用——已加载的预览不闪烁；
    // id 从 local-* 换成 real-1 即证明回声已被真实消息替换。
    expect(state.messages[0]).toMatchObject({
      id: 'real-1',
      images: [{ chip: '[image_1]', previewUrl: 'blob:local-preview' }],
    })
  })

  it('hydrate 携带 attachments：handle 在 → 渲染真图并剥掉 chip 占位文本', () => {
    const handle = `${'d'.repeat(64)}.jpg`
    const state = reduceChatState(initialChatState, {
      type: 'hydrate',
      transcript: [
        {
          id: 't1',
          role: 'user',
          text: '[image: dddddddd.jpg] 这是什么',
          attachments: [
            { chip: '[image: dddddddd.jpg]', kind: 'image', mime: 'image/jpeg', handle },
          ],
        },
      ],
    })
    expect(state.messages).toHaveLength(1)
    expect(state.messages[0]).toMatchObject({
      id: 't1',
      text: '这是什么',
      images: [{ chip: '[image: dddddddd.jpg]', handle, mime: 'image/jpeg' }],
    })
  })

  it('hydrate 的 path 引用附件（无 handle）保留 chip 文本兜底', () => {
    const state = reduceChatState(initialChatState, {
      type: 'hydrate',
      transcript: [
        {
          id: 't1',
          role: 'user',
          text: '[image: photo.png] 看下',
          attachments: [{ chip: '[image: photo.png]', kind: 'image', mime: 'image/png' }],
        },
      ],
    })
    expect(state.messages[0]?.text).toBe('[image: photo.png] 看下')
    expect(state.messages[0]?.images).toBeUndefined()
  })
})
