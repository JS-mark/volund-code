/** 聊天 reducer：thinking/text 双流、message.appended 收口、水合合并。 */
import { describe, expect, it } from 'vitest'

import { initialChatState, reduceChatState } from './chat'

const envelope = (kind: string, event: unknown, sessionId = 's1') => ({
  kind,
  sessionId,
  event,
})

describe('mobile chat reducer', () => {
  it('accumulates thinking deltas before text arrives', () => {
    let state = initialChatState
    state = reduceChatState(state, {
      type: 'envelope',
      envelope: envelope('core', {
        type: 'stream.delta',
        payload: { messageId: 'm1', kind: 'thinking', fragment: '用户' },
      }),
    })
    state = reduceChatState(state, {
      type: 'envelope',
      envelope: envelope('core', {
        type: 'stream.delta',
        payload: { messageId: 'm1', kind: 'thinking', fragment: '想要…' },
      }),
    })
    expect(state.messages).toHaveLength(1)
    expect(state.messages[0]).toMatchObject({
      id: 'm1',
      thinking: '用户想要…',
      text: '',
      streaming: true,
    })
  })

  it('streams text into the same message and finalizes via message.appended', () => {
    let state = initialChatState
    state = reduceChatState(state, {
      type: 'envelope',
      envelope: envelope('core', {
        type: 'stream.delta',
        payload: { messageId: 'm1', kind: 'text', fragment: '你好' },
      }),
    })
    state = reduceChatState(state, {
      type: 'envelope',
      envelope: envelope('core', {
        type: 'stream.delta',
        payload: { messageId: 'm1', kind: 'text', fragment: '，世界' },
      }),
    })
    state = reduceChatState(state, {
      type: 'envelope',
      envelope: envelope('core', {
        type: 'message.appended',
        payload: {
          messageId: 'm1',
          role: 'assistant',
          content: [{ type: 'text', text: '你好，世界' }],
        },
      }),
    })
    expect(state.messages).toHaveLength(1)
    expect(state.messages[0]).toMatchObject({ id: 'm1', text: '你好，世界', streaming: false })
  })

  it('replaces the local echo when the real user message arrives', () => {
    let state = initialChatState
    state = reduceChatState(state, { type: 'echo', text: '在吗' })
    state = reduceChatState(state, {
      type: 'envelope',
      envelope: envelope('core', {
        type: 'message.appended',
        payload: { messageId: 'u1', role: 'user', content: [{ type: 'text', text: '在吗' }] },
      }),
    })
    expect(state.messages).toHaveLength(1)
    expect(state.messages[0]?.local).toBeUndefined()
  })

  it('echo carries image thumbnails for the local bubble', () => {
    const state = reduceChatState(initialChatState, {
      type: 'echo',
      text: '看图',
      images: [{ chip: '[image_1]', previewUrl: 'blob:local/1' }],
    })
    expect(state.messages[0]).toMatchObject({
      role: 'user',
      text: '看图',
      local: true,
      images: [{ chip: '[image_1]', previewUrl: 'blob:local/1' }],
    })
  })

  it('keeps echo images on the confirmed user message', () => {
    let state = initialChatState
    state = reduceChatState(state, {
      type: 'echo',
      text: '分析下图片内容',
      images: [{ chip: '[image_1]', previewUrl: 'blob:local/1', handle: 'a'.repeat(64) + '.png' }],
    })
    state = reduceChatState(state, {
      type: 'envelope',
      envelope: envelope('core', {
        type: 'message.appended',
        payload: {
          messageId: 'u1',
          role: 'user',
          content: [
            {
              type: 'image',
              source: { kind: 'handle', handle: 'a'.repeat(64) + '.png' },
              mime: 'image/png',
            },
            { type: 'text', text: '分析下图片内容' },
          ],
        },
      }),
    })
    expect(state.messages).toHaveLength(1)
    // 回声已收口（local 清除），但图片预览转移到确认消息上，不闪没。
    expect(state.messages[0]?.local).toBeUndefined()
    expect(state.messages[0]).toMatchObject({
      id: 'u1',
      text: '分析下图片内容',
      images: [{ chip: '[image_1]', previewUrl: 'blob:local/1' }],
    })
  })

  it('derives images from content image parts when no echo exists (cross-client)', () => {
    const handle = 'b'.repeat(64) + '.jpg'
    const state = reduceChatState(initialChatState, {
      type: 'envelope',
      envelope: envelope('core', {
        type: 'message.appended',
        payload: {
          messageId: 'u2',
          role: 'user',
          content: [
            { type: 'image', source: { kind: 'handle', handle }, mime: 'image/jpeg' },
            { type: 'text', text: '这张呢' },
          ],
        },
      }),
    })
    expect(state.messages[0]).toMatchObject({
      id: 'u2',
      text: '这张呢',
      images: [{ chip: '[image: bbbbbbbb.jpg]', handle, mime: 'image/jpeg' }],
    })
  })

  it('hydrate renders transcript attachments as images and strips chip text', () => {
    const handle = 'c'.repeat(64) + '.webp'
    const state = reduceChatState(initialChatState, {
      type: 'hydrate',
      transcript: [
        {
          id: 'h1',
          role: 'user',
          text: '[image: cccccccc.webp] 分析下图片内容',
          attachments: [
            { chip: '[image: cccccccc.webp]', kind: 'image', mime: 'image/webp', handle },
          ],
        },
      ],
    })
    expect(state.messages[0]).toMatchObject({
      id: 'h1',
      text: '分析下图片内容',
      images: [{ chip: '[image: cccccccc.webp]', handle, mime: 'image/webp' }],
    })
  })

  it('hydrate keeps chip text for attachments without a handle', () => {
    const state = reduceChatState(initialChatState, {
      type: 'hydrate',
      transcript: [
        {
          id: 'h2',
          role: 'user',
          text: '[image: note.png] 看图',
          attachments: [{ chip: '[image: note.png]', kind: 'image', mime: 'image/png' }],
        },
      ],
    })
    expect(state.messages[0]).toMatchObject({ id: 'h2', text: '[image: note.png] 看图' })
    expect(state.messages[0]?.images).toBeUndefined()
  })

  it('shows an offline notice on machine.offline and clears only it on machine.online', () => {
    let state = initialChatState
    state = reduceChatState(state, {
      type: 'envelope',
      envelope: envelope('view', { type: 'machine.offline' }),
    })
    expect(state.notice).toContain('本机离线')
    // 上线只清离线条，不动其他提示。
    state = reduceChatState(state, { type: 'notice', notice: '别的错误' })
    state = reduceChatState(state, {
      type: 'envelope',
      envelope: envelope('view', { type: 'machine.online' }),
    })
    expect(state.notice).toBe('别的错误')
    state = reduceChatState(state, {
      type: 'envelope',
      envelope: envelope('view', { type: 'machine.offline' }),
    })
    state = reduceChatState(state, {
      type: 'envelope',
      envelope: envelope('view', { type: 'machine.online' }),
    })
    expect(state.notice).toBeUndefined()
  })

  it('hydrates from transcript keeping post-snapshot streaming tail', () => {
    let state = initialChatState
    state = reduceChatState(state, {
      type: 'envelope',
      envelope: envelope('core', {
        type: 'stream.delta',
        payload: { messageId: 'live', kind: 'text', fragment: '流式尾巴' },
      }),
    })
    state = reduceChatState(state, {
      type: 'hydrate',
      transcript: [
        { id: 'a', role: 'user', text: '历史1' },
        { id: 'b', role: 'assistant', text: '历史2' },
      ],
    })
    expect(state.messages.map((message) => message.id)).toEqual(['a', 'b', 'live'])
  })

  it('ignores tool_use deltas and keeps tool cards running→done', () => {
    let state = initialChatState
    state = reduceChatState(state, {
      type: 'envelope',
      envelope: envelope('core', {
        type: 'stream.delta',
        payload: { messageId: 't1', kind: 'tool_use', fragment: 'x' },
      }),
    })
    expect(state.messages).toHaveLength(0)
    state = reduceChatState(state, {
      type: 'envelope',
      envelope: envelope('core', {
        type: 'tool.started',
        payload: { toolUseId: 'tu1', tool: 'bash' },
      }),
    })
    state = reduceChatState(state, {
      type: 'envelope',
      envelope: envelope('core', {
        type: 'tool.completed',
        payload: { toolUseId: 'tu1', isError: false },
      }),
    })
    expect(state.tools).toEqual([{ toolUseId: 'tu1', tool: 'bash', status: 'done' }])
  })

  it('does not leak thinking into the visible text on message.appended', () => {
    let state = initialChatState
    state = reduceChatState(state, {
      type: 'envelope',
      envelope: envelope('core', {
        type: 'stream.delta',
        payload: { messageId: 'a1', kind: 'thinking', fragment: '让我想想' },
      }),
    })
    state = reduceChatState(state, {
      type: 'envelope',
      envelope: envelope('core', {
        type: 'stream.delta',
        payload: { messageId: 'a1', kind: 'text', fragment: '# 标题' },
      }),
    })
    state = reduceChatState(state, {
      type: 'envelope',
      envelope: envelope('core', {
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
    })
    const message = state.messages.find((item) => item.id === 'a1')
    // 正文只含 text part——thinking 混入会把 `# 标题` 粘到非行首，破坏 markdown 渲染。
    expect(message?.text).toBe('# 标题')
    expect(message?.thinking).toBe('让我想想')
    expect(message?.streaming).toBe(false)
  })

  it('skips contentless bubbles: tool_use-only assistant and tool_result user messages', () => {
    let state = initialChatState
    state = reduceChatState(state, {
      type: 'envelope',
      envelope: envelope('core', {
        type: 'message.appended',
        payload: {
          messageId: 'a1',
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: {} }],
        },
      }),
    })
    state = reduceChatState(state, {
      type: 'envelope',
      envelope: envelope('core', {
        type: 'message.appended',
        payload: {
          messageId: 'u2',
          role: 'user',
          content: [
            { type: 'tool_result', toolUseId: 'tu1', content: [{ type: 'text', text: 'ok' }] },
          ],
        },
      }),
    })
    // 两者都不产生空气泡；工具活动由工具卡承担。
    expect(state.messages).toHaveLength(0)
  })

  it('keeps a user message that carries only images', () => {
    let state = initialChatState
    state = reduceChatState(state, {
      type: 'envelope',
      envelope: envelope('core', {
        type: 'message.appended',
        payload: {
          messageId: 'u1',
          role: 'user',
          content: [
            {
              type: 'image',
              source: { kind: 'handle', handle: `${'a'.repeat(64)}.png` },
              mime: 'image/png',
            },
          ],
        },
      }),
    })
    expect(state.messages).toHaveLength(1)
    expect(state.messages[0]?.images?.[0]?.handle).toBe(`${'a'.repeat(64)}.png`)
  })

  it('finalizes a superseded stream when a retry starts a new messageId', () => {
    let state = initialChatState
    state = reduceChatState(state, {
      type: 'envelope',
      envelope: envelope('core', {
        type: 'stream.delta',
        payload: { messageId: 'a1', kind: 'text', fragment: '半截' },
      }),
    })
    expect(state.messages[0]?.streaming).toBe(true)
    // 重试：新的 stream.started 带新 messageId → 旧气泡收口为静态。
    state = reduceChatState(state, {
      type: 'envelope',
      envelope: envelope('core', {
        type: 'stream.started',
        payload: { messageId: 'a2', provider: 'p', model: 'm' },
      }),
    })
    expect(state.messages[0]?.streaming).toBe(false)
  })

  it('finalizes streaming messages on turn.aborted so the spinner does not stick', () => {
    let state = initialChatState
    state = reduceChatState(state, {
      type: 'envelope',
      envelope: envelope('core', {
        type: 'stream.delta',
        payload: { messageId: 'a1', kind: 'text', fragment: '半截回复' },
      }),
    })
    state = reduceChatState(state, {
      type: 'envelope',
      envelope: envelope('core', {
        type: 'error.raised',
        payload: { code: 'runner_error', context: { message: 'read ECONNRESET' } },
      }),
    })
    expect(state.notice).toBe('错误 runner_error: read ECONNRESET')
    state = reduceChatState(state, {
      type: 'envelope',
      envelope: envelope('core', {
        type: 'turn.aborted',
        payload: { turnId: 't', reason: 'error' },
      }),
    })
    expect(state.messages[0]?.streaming).toBe(false)
    expect(state.turn).toBe('idle')
  })

  it('surfaces context.reason for stream_interrupted errors', () => {
    let state = initialChatState
    state = reduceChatState(state, {
      type: 'envelope',
      envelope: envelope('core', {
        type: 'error.raised',
        payload: { code: 'stream_interrupted', context: { reason: 'read ECONNRESET' } },
      }),
    })
    expect(state.notice).toBe('错误 stream_interrupted: read ECONNRESET')
  })
})
