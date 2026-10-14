/** 聊天 reducer：thinking/text 双流、message.appended 收口、水合合并。 */
import { describe, expect, it } from 'vitest'

import type { EnvelopeEvent } from '../chat'
import {
  chatFeed,
  chatFeedGrouped,
  initialChatState,
  mcpToolParts,
  reduceChatState,
  toolBodyLabel,
  toolLabel,
  toolTargetLabel,
} from '../chat'

const envelope = (kind: string, event: EnvelopeEvent, sessionId = 's1') => ({
  kind,
  sessionId,
  event,
})

describe('发送排队（queue actions）', () => {
  const base = initialChatState

  it('queue-push 追加 / queue-remove 删除', () => {
    let state = reduceChatState(base, { type: 'queue-push', id: 'a', text: 'first' })
    state = reduceChatState(state, { type: 'queue-push', id: 'b', text: 'second' })
    expect(state.sendQueue.map((item) => item.id)).toEqual(['a', 'b'])
    state = reduceChatState(state, { type: 'queue-remove', id: 'a' })
    expect(state.sendQueue.map((item) => item.id)).toEqual(['b'])
  })

  it('queue-reorder 按给定 id 顺序重排（触摸拖拽的状态面）', () => {
    let state = base
    for (const id of ['a', 'b', 'c'])
      state = reduceChatState(state, { type: 'queue-push', id, text: id })
    state = reduceChatState(state, { type: 'queue-reorder', order: ['c', 'a', 'b'] })
    expect(state.sendQueue.map((item) => item.id)).toEqual(['c', 'a', 'b'])
  })

  it('reset 清空排队（断线重连不串队列）', () => {
    let state = reduceChatState(base, { type: 'queue-push', id: 'a', text: 'x' })
    state = reduceChatState(state, { type: 'reset' })
    expect(state.sendQueue).toEqual([])
  })
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

  it('回合终态清扫仍 running 的工具卡为 error（中断/异常残留不再永恒运行中）', () => {
    const drive = (state: ReturnType<typeof reduceChatState>, event: EnvelopeEvent) =>
      reduceChatState(state, { type: 'envelope', envelope: envelope('core', event) })
    let state = initialChatState
    state = drive(state, {
      type: 'tool.requested',
      payload: { toolUseId: 't1', tool: 'Task', input: { prompt: 'scan' } },
    } as EnvelopeEvent)
    state = drive(state, {
      type: 'tool.started',
      payload: { toolUseId: 't1', tool: 'Task' },
    } as EnvelopeEvent)
    state = drive(state, {
      type: 'tool.requested',
      payload: { toolUseId: 't2', tool: 'Grep', input: { pattern: 'x' } },
    } as EnvelopeEvent)
    expect(state.tools.map((tool) => tool.status)).toEqual(['running', 'running'])
    const aborted = drive(state, { type: 'turn.aborted', payload: { reason: 'user_interrupt' } })
    expect(aborted.tools.map((tool) => tool.status)).toEqual(['error', 'error'])
    expect(aborted.interrupted).toBe(true)
    // 正常完成：已收口的卡保持原状态，残留 running 才清扫。
    const mixed = drive(state, {
      type: 'tool.completed',
      payload: { toolUseId: 't2', isError: false },
    })
    const completed = drive(mixed, {
      type: 'turn.completed',
      payload: { usage: { input: 1, output: 1, costUSD: 0 } },
    })
    expect(completed.tools.map((tool) => tool.status)).toEqual(['error', 'done'])
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

  it('permission.request 的 lineage 经 gateway 盲转透传进卡面状态；主代理请求无 lineage（§2.7bis.5 U4）', () => {
    const lineage = { sessionId: 'sub-1', agentType: 'explore', parentTurnId: 'turn-9' }
    let state = reduceChatState(initialChatState, {
      type: 'envelope',
      envelope: envelope('view', {
        type: 'permission.request',
        request: {
          id: 'p-sub',
          attempt: 1,
          display: { approvable: true, spec: 'bash', toolName: 'Bash' },
          lineage,
        },
      }),
    })
    expect(state.permissions[0]?.lineage).toEqual(lineage)
    state = reduceChatState(initialChatState, {
      type: 'envelope',
      envelope: envelope('view', {
        type: 'permission.request',
        request: {
          id: 'p-main',
          attempt: 1,
          display: { approvable: true, spec: 'bash', toolName: 'Bash' },
        },
      }),
    })
    expect(state.permissions[0]?.lineage).toBeUndefined()
  })

  it('permission.request 优先收完整队列（requests）；旧网关单卡（request）降级为单项数组', () => {
    const card = (id: string) => ({
      id,
      attempt: 1,
      display: { approvable: true, spec: '{}', toolName: 'Bash' },
    })
    let state = reduceChatState(initialChatState, {
      type: 'envelope',
      envelope: envelope('view', { type: 'permission.request', requests: [card('a'), card('b')] }),
    })
    expect(state.permissions.map((permission) => permission.id)).toEqual(['a', 'b'])
    state = reduceChatState(initialChatState, {
      type: 'envelope',
      envelope: envelope('view', { type: 'permission.request', request: card('solo') }),
    })
    expect(state.permissions.map((permission) => permission.id)).toEqual(['solo'])
    // 空投影（requests 空数组且无 request）：不吞掉已有卡面，也不造空数组噪音。
    state = reduceChatState(state, {
      type: 'envelope',
      envelope: envelope('view', { type: 'permission.request', requests: [] }),
    })
    expect(state.permissions.map((permission) => permission.id)).toEqual(['solo'])
  })

  it('permission.request 的 expiresAt 摊给队列每张卡；旧网关缺省不添字段', () => {
    const card = (id: string) => ({
      id,
      attempt: 1,
      display: { approvable: true, spec: '{}', toolName: 'Bash' },
    })
    let state = reduceChatState(initialChatState, {
      type: 'envelope',
      envelope: envelope('view', {
        type: 'permission.request',
        requests: [card('a'), card('b')],
        expiresAt: 1_700_000_000_000,
      }),
    })
    expect(state.permissions.map((permission) => permission.expiresAt)).toEqual([
      1_700_000_000_000, 1_700_000_000_000,
    ])
    // 旧网关：帧上无 expiresAt → 卡面不添噪音字段（不渲染倒计时）。
    state = reduceChatState(initialChatState, {
      type: 'envelope',
      envelope: envelope('view', { type: 'permission.request', request: card('solo') }),
    })
    expect(state.permissions[0]?.expiresAt).toBeUndefined()
  })

  it('ask.request 的 expiresAt 摊给队列每张卡；旧网关缺省不添字段', () => {
    const ask = (id: string) => ({
      id,
      question: '继续吗？',
      options: [{ label: 'A' }, { label: 'B' }],
    })
    let state = reduceChatState(initialChatState, {
      type: 'envelope',
      envelope: envelope('view', {
        type: 'ask.request',
        requests: [ask('a'), ask('b')],
        expiresAt: 1_700_000_000_000,
      }),
    })
    expect(state.asks.map((entry) => entry.expiresAt)).toEqual([
      1_700_000_000_000, 1_700_000_000_000,
    ])
    // 旧网关：帧上无 expiresAt → 卡面不添噪音字段（不渲染倒计时）。
    state = reduceChatState(initialChatState, {
      type: 'envelope',
      envelope: envelope('view', { type: 'ask.request', request: ask('solo') }),
    })
    expect(state.asks[0]?.expiresAt).toBeUndefined()
  })

  it('permission.resolved 清空待审批队列', () => {
    let state = reduceChatState(initialChatState, {
      type: 'envelope',
      envelope: envelope('view', {
        type: 'permission.request',
        request: {
          id: 'p-1',
          attempt: 1,
          display: { approvable: true, spec: '{}', toolName: 'Bash' },
        },
      }),
    })
    expect(state.permissions).toHaveLength(1)
    state = reduceChatState(state, {
      type: 'envelope',
      envelope: envelope('view', { type: 'permission.resolved' }),
    })
    expect(state.permissions).toHaveLength(0)
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
    expect(state.tools).toEqual([{ toolUseId: 'tu1', tool: 'bash', status: 'done', seq: 1 }])
  })

  it('tool.requested 为非 Task 工具建卡：单行目标 + 展开正文，started 不冲掉', () => {
    let state = initialChatState
    state = reduceChatState(state, {
      type: 'envelope',
      envelope: envelope('core', {
        type: 'tool.requested',
        payload: {
          toolUseId: 'tu2',
          tool: 'Bash',
          input: { command: 'pnpm --filter @volund/mobile build 2>&1 | tail -15' },
        },
      }),
    })
    expect(state.tools[0]).toMatchObject({
      toolUseId: 'tu2',
      tool: 'Bash',
      status: 'running',
      seq: 1,
      target: 'pnpm --filter @volund/mobile build 2>&1 | tail -15',
      body: 'pnpm --filter @volund/mobile build 2>&1 | tail -15',
    })
    expect(state.nextSeq).toBe(2)
    state = reduceChatState(state, {
      type: 'envelope',
      envelope: envelope('core', {
        type: 'tool.started',
        payload: { toolUseId: 'tu2', tool: 'Bash' },
      }),
    })
    // started 不带 input：不冲掉 requested 帧落下的 target/body。
    expect(state.tools[0]).toMatchObject({
      status: 'running',
      target: 'pnpm --filter @volund/mobile build 2>&1 | tail -15',
      body: 'pnpm --filter @volund/mobile build 2>&1 | tail -15',
    })
    state = reduceChatState(state, {
      type: 'envelope',
      envelope: envelope('core', {
        type: 'tool.completed',
        payload: { toolUseId: 'tu2', isError: true },
      }),
    })
    expect(state.tools[0]).toMatchObject({ status: 'error' })
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
    expect(state.notice).toBe('runner_error: read ECONNRESET')
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

  it('turn.aborted 用户中断：走 interrupted 友好位不污染 notice，turn.started 清除', () => {
    let state = reduceChatState(initialChatState, {
      type: 'envelope',
      envelope: envelope('core', { type: 'turn.started', payload: { turnId: 't1' } }),
    })
    state = reduceChatState(state, {
      type: 'envelope',
      envelope: envelope('core', {
        type: 'turn.aborted',
        payload: { turnId: 't', reason: 'user_interrupt' },
      }),
    })
    expect(state.turn).toBe('idle')
    expect(state.interrupted).toBe(true)
    expect(state.notice).toBeUndefined()
    state = reduceChatState(state, {
      type: 'envelope',
      envelope: envelope('core', { type: 'turn.started', payload: { turnId: 't2' } }),
    })
    expect(state.interrupted).toBe(false)
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
    expect(state.notice).toBe('stream_interrupted: read ECONNRESET')
  })

  it('turn-stalled 收口流式气泡并提示；turn 态保持 running（中断按钮仍在）', () => {
    let state = initialChatState
    state = reduceChatState(state, {
      type: 'envelope',
      envelope: envelope('core', { type: 'turn.started', payload: { turnId: 't1' } }),
    })
    state = reduceChatState(state, {
      type: 'envelope',
      envelope: envelope('core', {
        type: 'stream.delta',
        payload: { messageId: 'a1', kind: 'text', fragment: '半截回复' },
      }),
    })
    expect(state.messages[0]?.streaming).toBe(true)
    const stalled = reduceChatState(state, { type: 'turn-stalled' })
    expect(stalled.messages[0]?.streaming).toBe(false)
    expect(stalled.turn).toBe('running')
    expect(stalled.notice).toBe('长时间未收到新事件，本轮可能已中断；可点「中断」结束')
    // 重复触发幂等：无流式可收口且提示已在 → 原引用返回（不触发渲染）。
    expect(reduceChatState(stalled, { type: 'turn-stalled' })).toBe(stalled)
    // 真终态到达后照常收回。
    const done = reduceChatState(stalled, {
      type: 'envelope',
      envelope: envelope('core', { type: 'turn.completed', payload: {} }),
    })
    expect(done.turn).toBe('idle')
  })

  it('lastEventAt 随信封刷新、turn-stalled 不刷新（停摆计时基准不被兜底本身拨动）', () => {
    let state = reduceChatState(initialChatState, {
      type: 'envelope',
      envelope: envelope('core', { type: 'turn.started', payload: { turnId: 't1' } }),
    })
    expect(state.lastEventAt).toBeGreaterThan(0)
    const at = state.lastEventAt
    state = reduceChatState(state, { type: 'turn-stalled' })
    expect(state.lastEventAt).toBe(at)
    state = reduceChatState(initialChatState, { type: 'turn-restored' })
    expect(state.lastEventAt).toBeGreaterThan(0)
    expect(state.turn).toBe('running')
  })

  // §2.7bis.5 U3：子代理冒泡事件（附录 D.3 parentTurnId/parentDepth tag）不混进
  // 主聊天流，只聚合进 Task 折叠行；主会话事件（无 tag）不受影响。
  describe('U3 子代理冒泡过滤与 Task 折叠行聚合', () => {
    it('filters bubbled stream/message/turn events out of the main chat flow', () => {
      let state = initialChatState
      state = reduceChatState(state, {
        type: 'envelope',
        envelope: envelope('core', { type: 'turn.started', payload: { turnId: 't1' } }),
      })
      const before = state
      // 子代理流式文本 / 持久化消息 / turn 终态——全部不得进主聊天流。
      state = reduceChatState(state, {
        type: 'envelope',
        envelope: envelope('core', {
          type: 'stream.delta',
          payload: { messageId: 'sub-m1', kind: 'text', fragment: '子代理正文' },
          parentTurnId: 't1',
          parentDepth: 1,
        }),
      })
      state = reduceChatState(state, {
        type: 'envelope',
        envelope: envelope('core', {
          type: 'message.appended',
          payload: {
            messageId: 'sub-m1',
            role: 'assistant',
            content: [{ type: 'text', text: '子代理正文' }],
          },
          parentTurnId: 't1',
          parentDepth: 1,
        }),
      })
      state = reduceChatState(state, {
        type: 'envelope',
        envelope: envelope('core', {
          type: 'turn.completed',
          payload: { turnId: 'sub-turn' },
          parentTurnId: 't1',
          parentDepth: 1,
        }),
      })
      expect(state.messages).toHaveLength(0)
      // 子代理 turn.completed 不得把主会话 turn 拨回 idle。
      expect(state.turn).toBe('running')
      // 无聚合载体的冒泡事件原样返回（state 引用不变）。
      expect(state).toBe(before)
    })

    it('aggregates bubbled tool events onto the Task card instead of flat tool chips', () => {
      let state = initialChatState
      // 父会话 Task 派发：requested 带 input（agentType），started 带 event.turnId。
      state = reduceChatState(state, {
        type: 'envelope',
        envelope: envelope('core', {
          type: 'tool.requested',
          payload: {
            toolUseId: 'task-1',
            tool: 'Task',
            input: { agentType: 'explore', prompt: '查一下事件链路' },
          },
          turnId: 't1',
        }),
      })
      state = reduceChatState(state, {
        type: 'envelope',
        envelope: envelope('core', {
          type: 'tool.started',
          payload: { toolUseId: 'task-1', tool: 'Task' },
          turnId: 't1',
        }),
      })
      // 子代理工具活动冒泡：parentTurnId 归属到 Task 卡，自身不进 tools 列表。
      state = reduceChatState(state, {
        type: 'envelope',
        envelope: envelope('core', {
          type: 'tool.started',
          payload: { toolUseId: 'sub-tu1', tool: 'bash' },
          parentTurnId: 't1',
          parentDepth: 1,
        }),
      })
      state = reduceChatState(state, {
        type: 'envelope',
        envelope: envelope('core', {
          type: 'tool.started',
          payload: { toolUseId: 'sub-tu2', tool: 'grep' },
          parentTurnId: 't1',
          parentDepth: 1,
        }),
      })
      state = reduceChatState(state, {
        type: 'envelope',
        envelope: envelope('core', {
          type: 'tool.completed',
          payload: { toolUseId: 'sub-tu1', isError: false },
          parentTurnId: 't1',
          parentDepth: 1,
        }),
      })
      // 平铺面只有 Task 一张卡；子代理的 bash/grep 不进 tools。
      expect(state.tools).toHaveLength(1)
      expect(state.tools[0]).toMatchObject({
        toolUseId: 'task-1',
        tool: 'Task',
        status: 'running',
        turnId: 't1',
        task: { agentType: 'explore', prompt: '查一下事件链路' },
      })
      // 折叠行聚合：2 次调用、1 个仍在跑、当前工具 = 最近启动的 grep；轨迹按序收口。
      expect(state.subagents['t1']).toEqual({
        toolCalls: 2,
        running: 1,
        lastTool: 'grep',
        runs: [
          { toolUseId: 'sub-tu1', tool: 'bash', status: 'done' },
          { toolUseId: 'sub-tu2', tool: 'grep', status: 'running' },
        ],
      })
      // Task 自己 completed → 卡收口，聚合保留（折叠行展示「完成 · N 次调用」）。
      state = reduceChatState(state, {
        type: 'envelope',
        envelope: envelope('core', {
          type: 'tool.completed',
          payload: { toolUseId: 'task-1', isError: false },
        }),
      })
      expect(state.tools[0]?.status).toBe('done')
      expect(state.subagents['t1']?.toolCalls).toBe(2)
    })

    it('builds the Task trail from bubbled requested→started→completed（target 提取/失败收口）', () => {
      let state = initialChatState
      state = reduceChatState(state, {
        type: 'envelope',
        envelope: envelope('core', {
          type: 'tool.started',
          payload: { toolUseId: 'task-1', tool: 'Task' },
          turnId: 't1',
        }),
      })
      // requested 先到（带 input → 单行目标进轨迹）；started 同 id 不重复计数。
      state = reduceChatState(state, {
        type: 'envelope',
        envelope: envelope('core', {
          type: 'tool.requested',
          payload: {
            toolUseId: 'sub-r1',
            tool: 'Read',
            input: { path: '/repo/packages/core/src/index.ts' },
          },
          parentTurnId: 't1',
          parentDepth: 1,
        }),
      })
      state = reduceChatState(state, {
        type: 'envelope',
        envelope: envelope('core', {
          type: 'tool.started',
          payload: { toolUseId: 'sub-r1', tool: 'Read' },
          parentTurnId: 't1',
          parentDepth: 1,
        }),
      })
      expect(state.subagents['t1']).toMatchObject({ toolCalls: 1, running: 1 })
      expect(state.subagents['t1']?.runs).toEqual([
        {
          toolUseId: 'sub-r1',
          tool: 'Read',
          status: 'running',
          target: '/repo/packages/core/src/index.ts',
        },
      ])
      // 失败收口 → error 状态、running 归零；轨迹行原位更新。
      state = reduceChatState(state, {
        type: 'envelope',
        envelope: envelope('core', {
          type: 'tool.completed',
          payload: { toolUseId: 'sub-r1', isError: true },
          parentTurnId: 't1',
          parentDepth: 1,
        }),
      })
      expect(state.subagents['t1']).toMatchObject({ running: 0 })
      expect(state.subagents['t1']?.runs[0]?.status).toBe('error')
    })

    it('轨迹上限 50 条：最旧被丢，计数保留总数', () => {
      let state = initialChatState
      state = reduceChatState(state, {
        type: 'envelope',
        envelope: envelope('core', {
          type: 'tool.started',
          payload: { toolUseId: 'task-1', tool: 'Task' },
          turnId: 't1',
        }),
      })
      for (let index = 0; index < 60; index += 1) {
        state = reduceChatState(state, {
          type: 'envelope',
          envelope: envelope('core', {
            type: 'tool.started',
            payload: { toolUseId: `sub-${index}`, tool: 'Grep' },
            parentTurnId: 't1',
            parentDepth: 1,
          }),
        })
      }
      const activity = state.subagents['t1']
      expect(activity?.toolCalls).toBe(60)
      expect(activity?.runs).toHaveLength(50)
      expect(activity?.runs[0]?.toolUseId).toBe('sub-10')
      expect(activity?.runs.at(-1)?.toolUseId).toBe('sub-59')
    })

    it('keeps main-session events (no parent tags) unaffected', () => {
      let state = initialChatState
      state = reduceChatState(state, {
        type: 'envelope',
        envelope: envelope('core', {
          type: 'stream.delta',
          payload: { messageId: 'm1', kind: 'text', fragment: '主会话' },
        }),
      })
      state = reduceChatState(state, {
        type: 'envelope',
        envelope: envelope('core', {
          type: 'tool.started',
          payload: { toolUseId: 'tu1', tool: 'bash' },
          turnId: 't1',
        }),
      })
      state = reduceChatState(state, {
        type: 'envelope',
        envelope: envelope('core', {
          type: 'tool.completed',
          payload: { toolUseId: 'tu1', isError: false },
        }),
      })
      expect(state.messages).toHaveLength(1)
      expect(state.messages[0]).toMatchObject({ id: 'm1', text: '主会话' })
      expect(state.tools).toEqual([
        { toolUseId: 'tu1', tool: 'bash', status: 'done', turnId: 't1', seq: 2 },
      ])
      expect(state.subagents).toEqual({})
    })
  })
})

describe('多设备共用会话的 session.attached 语义', () => {
  it('does not wipe context when another device re-attaches the same session', () => {
    let state = initialChatState
    state = reduceChatState(state, {
      type: 'hydrate',
      transcript: [
        { id: 't1', role: 'user', text: '第一条' },
        { id: 't2', role: 'assistant', text: '第一条的回复' },
      ],
    })
    expect(state.messages).toHaveLength(2)
    // 其他设备 resume 同一会话 → 网关对全员广播 session.attached：
    // reducer 不得清空视图（旧实现 {...initialChatState} 会把上下文打空）。
    const after = reduceChatState(state, {
      type: 'envelope',
      envelope: envelope('view', {
        type: 'session.attached',
        id: 's1',
      } as unknown as EnvelopeEvent),
    })
    expect(after.messages).toHaveLength(2)
    expect(after.messages.map((message) => message.text)).toEqual(['第一条', '第一条的回复'])
  })
})

describe('迟到者运行态恢复', () => {
  it('restores the running turn from hello.turnRunning so the interrupt button shows', () => {
    const state = reduceChatState(initialChatState, { type: 'turn-restored' })
    expect(state.turn).toBe('running')
  })
})

describe('chatFeed 会话流混排（工具卡进消息流）', () => {
  it('消息与工具卡按到达 seq 混排；状态更新不挪位置', async () => {
    const { chatFeed } = await import('../chat')
    let state = reduceChatState(initialChatState, {
      type: 'envelope',
      envelope: envelope('core', {
        type: 'message.appended',
        payload: { messageId: 'm1', role: 'user', content: [{ type: 'text', text: '读文件' }] },
      }),
    })
    state = reduceChatState(state, {
      type: 'envelope',
      envelope: envelope('core', {
        type: 'tool.started',
        payload: { toolUseId: 't1', tool: 'Read' },
      }),
    })
    state = reduceChatState(state, {
      type: 'envelope',
      envelope: envelope('core', {
        type: 'tool.started',
        payload: { toolUseId: 't2', tool: 'Write' },
      }),
    })
    state = reduceChatState(state, {
      type: 'envelope',
      envelope: envelope('core', {
        type: 'message.appended',
        payload: {
          messageId: 'm2',
          role: 'assistant',
          content: [{ type: 'text', text: '已完成' }],
        },
      }),
    })
    const feed = chatFeed(state)
    expect(feed.map((entry) => entry.key)).toEqual(['m1', 't1', 't2', 'm2'])
    // 工具完成：位置不变，状态原地更新。
    state = reduceChatState(state, {
      type: 'envelope',
      envelope: envelope('core', {
        type: 'tool.completed',
        payload: { toolUseId: 't1', isError: false },
      }),
    })
    const after = chatFeed(state)
    expect(after.map((entry) => entry.key)).toEqual(['m1', 't1', 't2', 'm2'])
    const t1 = after.find((entry) => entry.key === 't1')
    expect(t1?.kind).toBe('tool')
    if (t1?.kind === 'tool') expect(t1.tool.status).toBe('done')
  })

  it('水合消息带 seq（transcript 顺序），乐观回显的 seq 让回声钉在末尾', () => {
    let state = reduceChatState(initialChatState, {
      type: 'hydrate',
      transcript: [
        { id: 'h1', role: 'user', text: '一' },
        { id: 'h2', role: 'assistant', text: '二' },
      ],
    })
    state = reduceChatState(state, { type: 'echo', text: '三' })
    expect(state.messages.map((message) => message.seq)).toEqual([1, 2, 3])
    expect(state.nextSeq).toBe(4)
  })

  it('工具卡在消息前的时序：tool.started 先于 stream.delta 也保持序', async () => {
    const { chatFeed } = await import('../chat')
    let state = reduceChatState(initialChatState, {
      type: 'envelope',
      envelope: envelope('core', {
        type: 'tool.started',
        payload: { toolUseId: 't1', tool: 'Bash' },
      }),
    })
    state = reduceChatState(state, {
      type: 'envelope',
      envelope: envelope('core', {
        type: 'stream.delta',
        payload: { messageId: 'm1', kind: 'text', fragment: '输出' },
      }),
    })
    expect(chatFeed(state).map((entry) => entry.key)).toEqual(['t1', 'm1'])
  })

  it('toolTargetLabel/toolBodyLabel：折叠行单行目标 + 展开正文', () => {
    expect(toolTargetLabel('Bash', { command: 'pnpm test' })).toBe('pnpm test')
    expect(toolTargetLabel('Read', { path: 'a/b.ts' })).toBe('a/b.ts')
    // 正文参数绝不成为目标；input 非对象省略。
    expect(toolTargetLabel('Edit', { old_string: 'secret', new_string: 's' })).toBeUndefined()
    expect(toolTargetLabel('Read', 'not-an-object')).toBeUndefined()
    expect(toolBodyLabel('Bash', { command: 'a\nb' })).toBe('a\nb')
    expect(toolBodyLabel('Write', { path: 'a.ts', content: 'x=1' })).toBe('a.ts\n\nx=1')
    expect(toolBodyLabel('Edit', { path: 'a.ts', old_string: 'o', new_string: 'n' })).toBe(
      'a.ts\n\n【旧】\no\n\n【新】\nn',
    )
    expect(toolBodyLabel('Bash', {})).toBeUndefined()
    // 未知工具：入参 JSON 全量；超长截断（BODY_MAX=4000）。
    expect(toolBodyLabel('Mystery', { k: 'v' })).toBe('{\n  "k": "v"\n}')
    expect(toolBodyLabel('Bash', { command: 'x'.repeat(5000) })?.length).toBe(
      4000 + '\n…（已截断）'.length,
    )
    // 折叠行中文标签；未知工具原样。
    expect(toolLabel('Bash')).toBe('终端')
    expect(toolLabel('Mystery')).toBe('Mystery')
  })

  it('hydrate：快照 tool 条目重建工具卡且与消息保序', () => {
    const state = reduceChatState(initialChatState, {
      type: 'hydrate',
      transcript: [
        { id: 'm-1', role: 'user', text: '跑' },
        {
          id: 'tu-1',
          kind: 'tool',
          tool: 'Bash',
          input: { command: 'pnpm test' },
          status: 'done',
        },
        { id: 'm-2', role: 'assistant', text: '完成' },
      ],
    })
    expect(state.nextSeq).toBe(4)
    expect(chatFeed(state).map((entry) => entry.key)).toEqual(['m-1', 'tu-1', 'm-2'])
    expect(state.tools[0]).toMatchObject({
      status: 'done',
      seq: 2,
      target: 'pnpm test',
      body: 'pnpm test',
    })
  })

  it('hydrate 重排 seq：活体工具卡按快照序归位，多波工具不再被挤成一个分组', () => {
    // 活体阶段：m1 → t1/t2 → m2 → t3（Task，live 卡带 turnId）。
    const live = [
      {
        type: 'envelope' as const,
        envelope: envelope('core', {
          type: 'message.appended',
          payload: {
            messageId: 'm1',
            role: 'assistant',
            content: [{ type: 'text', text: '第一段' }],
          },
        }),
      },
      {
        type: 'envelope' as const,
        envelope: envelope('core', {
          type: 'tool.started',
          payload: { toolUseId: 't1', tool: 'Bash' },
        }),
      },
      {
        type: 'envelope' as const,
        envelope: envelope('core', {
          type: 'tool.started',
          payload: { toolUseId: 't2', tool: 'Grep' },
        }),
      },
      {
        type: 'envelope' as const,
        envelope: envelope('core', {
          type: 'message.appended',
          payload: {
            messageId: 'm2',
            role: 'assistant',
            content: [{ type: 'text', text: '第二段' }],
          },
        }),
      },
      {
        type: 'envelope' as const,
        envelope: envelope('core', {
          type: 'tool.started',
          payload: { toolUseId: 't3', tool: 'Task' },
          turnId: 'turn-9',
        }),
      },
      {
        type: 'envelope' as const,
        envelope: envelope('core', {
          type: 'tool.completed',
          payload: { toolUseId: 't3', isError: true },
        }),
      },
    ].reduce(reduceChatState, initialChatState)
    // 活体混排本来是对的：消息把工具波切开。
    expect(chatFeedGrouped(live).map((entry) => entry.key)).toEqual(['m1', 'grp:t1', 'm2', 't3'])

    // 重连水合（手机后台/前台一切换就触发）：完整快照按同 id 回来。
    const state = reduceChatState(live, {
      type: 'hydrate',
      transcript: [
        { id: 'm1', role: 'assistant', text: '第一段' },
        { id: 't1', kind: 'tool', tool: 'Bash', input: { command: 'ls' }, status: 'done' },
        { id: 't2', kind: 'tool', tool: 'Grep', input: { pattern: 'x' }, status: 'done' },
        { id: 'm2', role: 'assistant', text: '第二段' },
        {
          id: 't3',
          kind: 'tool',
          tool: 'Task',
          input: { agentType: 'explore', prompt: '查链路' },
          status: 'error',
        },
      ],
    })
    // 快照序为权威：混排保持，工具不浮到消息前面（旧实现这里是 [grp:t1..t3, m1, m2]）。
    expect(chatFeed(state).map((entry) => entry.key)).toEqual(['m1', 't1', 't2', 'm2', 't3'])
    expect(chatFeedGrouped(state).map((entry) => entry.key)).toEqual(['m1', 'grp:t1', 'm2', 't3'])
    // live 卡内容优先（turnId 保留 → 子代理轨迹归属不丢）；快照的 task 摘要补位。
    const taskCard = state.tools.find((tool) => tool.toolUseId === 't3')
    expect(taskCard).toMatchObject({
      status: 'error',
      turnId: 'turn-9',
      task: { agentType: 'explore', prompt: '查链路' },
    })
    expect(state.nextSeq).toBe(6)
  })

  it('hydrate：快照后到达的增量（live 独有）按原到达序接尾', () => {
    const live = [
      {
        type: 'envelope' as const,
        envelope: envelope('core', {
          type: 'message.appended',
          payload: { messageId: 'm1', role: 'user', content: [{ type: 'text', text: '在快照里' }] },
        }),
      },
      {
        type: 'envelope' as const,
        envelope: envelope('core', {
          type: 'tool.started',
          payload: { toolUseId: 't1', tool: 'Bash' },
        }),
      },
      {
        type: 'envelope' as const,
        envelope: envelope('core', {
          type: 'tool.completed',
          payload: { toolUseId: 't1', isError: false },
        }),
      },
      {
        type: 'envelope' as const,
        envelope: envelope('core', {
          type: 'message.appended',
          payload: {
            messageId: 'm2',
            role: 'assistant',
            content: [{ type: 'text', text: '快照后到达' }],
          },
        }),
      },
    ].reduce(reduceChatState, initialChatState)
    const state = reduceChatState(live, {
      type: 'hydrate',
      transcript: [
        { id: 'm1', role: 'user', text: '在快照里' },
        { id: 't1', kind: 'tool', tool: 'Bash', input: { command: 'ls' }, status: 'done' },
      ],
    })
    // m2 不在快照里（快照后到达）：排尾，不冲掉。
    expect(chatFeed(state).map((entry) => entry.key)).toEqual(['m1', 't1', 'm2'])
    expect(state.nextSeq).toBe(4)
  })
})

describe('chatFeedGrouped 连续工具行分组折叠', () => {
  /** 两工具一消息的最小混排态（t1/t2 相邻，m1/m2 切在两侧）。 */
  function mixedState() {
    return [
      {
        type: 'envelope' as const,
        envelope: envelope('core', {
          type: 'message.appended',
          payload: { messageId: 'm1', role: 'user', content: [{ type: 'text', text: '开工' }] },
        }),
      },
      {
        type: 'envelope' as const,
        envelope: envelope('core', {
          type: 'tool.started',
          payload: { toolUseId: 't1', tool: 'Read' },
        }),
      },
      {
        type: 'envelope' as const,
        envelope: envelope('core', {
          type: 'tool.started',
          payload: { toolUseId: 't2', tool: 'Edit' },
        }),
      },
      {
        type: 'envelope' as const,
        envelope: envelope('core', {
          type: 'message.appended',
          payload: {
            messageId: 'm2',
            role: 'assistant',
            content: [{ type: 'text', text: '完成' }],
          },
        }),
      },
    ]
  }

  it('相邻 ≥2 的工具卡合并成组（key = grp:首卡），单条与被消息切断的不成组', async () => {
    const { chatFeedGrouped } = await import('../chat')
    const feed = chatFeedGrouped(mixedState().reduce(reduceChatState, initialChatState))
    expect(feed.map((entry) => entry.key)).toEqual(['m1', 'grp:t1', 'm2'])
    const group = feed[1]
    if (group?.kind !== 'tool-group') throw new Error('expected tool-group')
    expect(group.tools.map((tool) => tool.toolUseId)).toEqual(['t1', 't2'])

    const single = reduceChatState(initialChatState, {
      type: 'envelope',
      envelope: envelope('core', {
        type: 'tool.started',
        payload: { toolUseId: 't1', tool: 'Bash' },
      }),
    })
    expect(chatFeedGrouped(single).map((entry) => entry.key)).toEqual(['t1'])
  })

  it('运行中追加新卡并入组且 key 不变；组内状态随事件流动', async () => {
    const { chatFeedGrouped } = await import('../chat')
    let state = mixedState().reduce(reduceChatState, initialChatState)
    expect(chatFeedGrouped(state).map((entry) => entry.key)).toEqual(['m1', 'grp:t1', 'm2'])
    state = reduceChatState(state, {
      type: 'envelope',
      envelope: envelope('core', {
        type: 'tool.completed',
        payload: { toolUseId: 't1', isError: true },
      }),
    })
    const feed = chatFeedGrouped(state)
    expect(feed.map((entry) => entry.key)).toEqual(['m1', 'grp:t1', 'm2'])
    const group = feed[1]
    if (group?.kind !== 'tool-group') throw new Error('expected tool-group')
    expect(group.tools.find((tool) => tool.toolUseId === 't1')?.status).toBe('error')
    expect(group.tools.find((tool) => tool.toolUseId === 't2')?.status).toBe('running')
  })
})

describe('ask.request / ask.resolved（AskUserQuestion 问答卡）与 MCP 标签', () => {
  const ask = {
    id: 'ask-1',
    question: '用哪个方案？',
    options: [{ label: '方案 A', description: '快但糙' }, { label: '方案 B' }],
  }

  it('ask.request 全队列投影进卡，ask.resolved 清卡', () => {
    const asked = reduceChatState(initialChatState, {
      type: 'envelope',
      envelope: envelope('view', { type: 'ask.request', request: ask, requests: [ask] }),
    })
    expect(asked.asks).toEqual([ask])
    // 旧网关只带队首的降级路径。
    const legacy = reduceChatState(initialChatState, {
      type: 'envelope',
      envelope: envelope('view', { type: 'ask.request', request: ask }),
    })
    expect(legacy.asks).toEqual([ask])
    const resolved = reduceChatState(asked, {
      type: 'envelope',
      envelope: envelope('view', { type: 'ask.resolved' }),
    })
    expect(resolved.asks).toEqual([])
  })

  it('mcpToolParts/toolLabel：mcp__server__tool 拆解展示；MCP 工具不产 target', () => {
    expect(mcpToolParts('mcp__github__search_repos')).toEqual({
      server: 'github',
      name: 'search_repos',
    })
    expect(mcpToolParts('mcp__bad')).toBeUndefined()
    expect(mcpToolParts('Bash')).toBeUndefined()
    expect(toolLabel('mcp__github__search_repos')).toBe('MCP · github/search_repos')

    const state = reduceChatState(initialChatState, {
      type: 'envelope',
      envelope: envelope('core', {
        type: 'tool.requested',
        payload: {
          toolUseId: 'tu-mcp',
          tool: 'mcp__github__search_repos',
          input: { query: 'volund', path: '/tmp/x' },
        },
      }),
    })
    expect(state.tools[0]?.target).toBeUndefined()
    expect(state.tools[0]?.body).toContain('volund')
  })
})

describe('streamedChars（状态提示 ↑ tokens 估算的数据源）', () => {
  it('text delta 累计、thinking 不计、turn.started 清零', () => {
    let state = reduceChatState(initialChatState, {
      type: 'envelope',
      envelope: envelope('core', { type: 'turn.started' }),
    })
    for (const fragment of ['1234', '5678']) {
      state = reduceChatState(state, {
        type: 'envelope',
        envelope: envelope('core', {
          type: 'stream.delta',
          payload: { kind: 'text', messageId: 'm1', fragment },
        }),
      })
    }
    state = reduceChatState(state, {
      type: 'envelope',
      envelope: envelope('core', {
        type: 'stream.delta',
        payload: { kind: 'thinking', messageId: 'm1', fragment: '思考不算' },
      }),
    })
    expect(state.streamedChars).toBe(8)
    state = reduceChatState(state, {
      type: 'envelope',
      envelope: envelope('core', { type: 'turn.started' }),
    })
    expect(state.streamedChars).toBe(0)
  })
})
