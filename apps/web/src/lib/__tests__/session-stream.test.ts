import { describe, expect, it } from 'vitest'

import type { ChatState } from '../session-stream'
import {
  chatFeed,
  chatFeedGrouped,
  initialChatState,
  reduceChatState,
  toolBodyLabel,
  toolLabel,
  toolTargetLabel,
} from '../session-stream'

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

describe('发送排队（queue actions）', () => {
  const base = initialChatState

  it('queue-push 追加 / queue-remove 删除', () => {
    let state = reduceChatState(base, { type: 'queue-push', id: 'a', text: 'first' })
    state = reduceChatState(state, { type: 'queue-push', id: 'b', text: 'second' })
    expect(state.sendQueue.map((item) => item.id)).toEqual(['a', 'b'])
    state = reduceChatState(state, { type: 'queue-remove', id: 'a' })
    expect(state.sendQueue.map((item) => item.id)).toEqual(['b'])
  })

  it('queue-reorder 按给定 id 顺序重排（拖拽排序的状态面）', () => {
    let state = base
    for (const id of ['a', 'b', 'c'])
      state = reduceChatState(state, { type: 'queue-push', id, text: id })
    state = reduceChatState(state, { type: 'queue-reorder', order: ['c', 'a', 'b'] })
    expect(state.sendQueue.map((item) => item.id)).toEqual(['c', 'a', 'b'])
  })

  it('session.attached 清空排队（切会话不串队列）', () => {
    let state = reduceChatState(base, { type: 'queue-push', id: 'a', text: 'x' })
    state = reduceChatState(state, {
      type: 'envelope',
      envelope: {
        kind: 'view',
        event: { type: 'session.attached', payload: {} },
        sessionId: 's1',
        streamVersion: 1,
        cursor: '0',
      },
    })
    expect(state.sendQueue).toEqual([])
  })
})

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
      {
        id: 'm1',
        role: 'assistant',
        text: '你好',
        streaming: true,
        at: expect.any(Number),
        seq: 1,
      },
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

  it('回合终态清扫仍 running 的工具卡为 error（中断/异常残留不再永恒运行中）', () => {
    const running = reduceMany(initialChatState, [
      envelope('core', {
        type: 'tool.requested',
        payload: { toolUseId: 't1', tool: 'Task', input: { prompt: 'scan' } },
      }),
      envelope('core', { type: 'tool.started', payload: { toolUseId: 't1', tool: 'Task' } }),
      envelope('core', {
        type: 'tool.requested',
        payload: { toolUseId: 't2', tool: 'Grep', input: { pattern: 'x' } },
      }),
    ])
    expect(running.tools.map((tool) => tool.status)).toEqual(['running', 'running'])
    // 中断：全部按失败收口。
    const aborted = reduceChatState(
      running,
      envelope('core', { type: 'turn.aborted', payload: { reason: 'user_interrupt' } }),
    )
    expect(aborted.tools.map((tool) => tool.status)).toEqual(['error', 'error'])
    expect(aborted.interrupted).toBe(true)
    // 正常完成：已收口的卡保持原状态，残留 running 才清扫。
    const mixed = reduceChatState(
      running,
      envelope('core', { type: 'tool.completed', payload: { toolUseId: 't2', isError: false } }),
    )
    const completed = reduceChatState(
      mixed,
      envelope('core', {
        type: 'turn.completed',
        payload: { usage: { input: 1, output: 1, costUSD: 0 } },
      }),
    )
    expect(completed.tools.map((tool) => tool.status)).toEqual(['error', 'done'])
    // turn.failed（hub 对并发提交的拒绝投影）同样清扫。
    const failed = reduceChatState(
      running,
      envelope('view', { type: 'turn.failed', message: 'busy' }),
    )
    expect(failed.tools.map((tool) => tool.status)).toEqual(['error', 'error'])
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

  it('permission.request 的 lineage 透传进卡面状态；主代理请求无 lineage（§2.7bis.5 U4）', () => {
    const lineage = { sessionId: 'sub-1', agentType: 'explore', parentTurnId: 'turn-9' }
    const requested = reduceChatState(
      initialChatState,
      envelope('view', {
        type: 'permission.request',
        request: {
          id: 'p-sub',
          attempt: 1,
          display: { approvable: true, spec: 'bash', toolName: 'Bash' },
          lineage,
        },
      }),
    )
    expect(requested.permission?.lineage).toEqual(lineage)
    const main = reduceChatState(
      initialChatState,
      envelope('view', {
        type: 'permission.request',
        request: {
          id: 'p-main',
          attempt: 1,
          display: { approvable: true, spec: 'bash', toolName: 'Bash' },
        },
      }),
    )
    expect(main.permission?.lineage).toBeUndefined()
  })

  it('tool.requested 落目标列，started 不冲掉，completed 合并 +n −m', () => {
    const requested = reduceChatState(
      initialChatState,
      envelope('core', {
        type: 'tool.requested',
        payload: { toolUseId: 'tu-1', tool: 'Edit', input: { path: 'src/a.ts' } },
      }),
    )
    expect(requested.tools[0]).toMatchObject({
      tool: 'Edit',
      target: 'src/a.ts',
      status: 'running',
    })
    const started = reduceChatState(
      requested,
      envelope('core', {
        type: 'tool.started',
        payload: { toolUseId: 'tu-1', tool: 'Edit' },
      }),
    )
    expect(started.tools[0]).toMatchObject({ target: 'src/a.ts', status: 'running' })
    const completed = reduceChatState(
      started,
      envelope('core', {
        type: 'tool.completed',
        payload: {
          toolUseId: 'tu-1',
          tool: 'Edit',
          isError: false,
          linesAdded: 3,
          linesRemoved: 1,
        },
      }),
    )
    expect(completed.tools[0]).toMatchObject({ status: 'done', linesAdded: 3, linesRemoved: 1 })
  })

  it('tool.requested 落展开正文 body：Bash 存完整命令，started 保留', () => {
    const requested = reduceChatState(
      initialChatState,
      envelope('core', {
        type: 'tool.requested',
        payload: {
          toolUseId: 'tu-2',
          tool: 'Bash',
          input: { command: 'pnpm build 2>&1\n| tail -15' },
        },
      }),
    )
    expect(requested.tools[0]?.body).toBe('pnpm build 2>&1\n| tail -15')
    const started = reduceChatState(
      requested,
      envelope('core', { type: 'tool.started', payload: { toolUseId: 'tu-2', tool: 'Bash' } }),
    )
    expect(started.tools[0]?.body).toBe('pnpm build 2>&1\n| tail -15')
  })

  it('toolTargetLabel：取辨识度最高的参数并压成单行', () => {
    expect(toolTargetLabel('Bash', { command: 'pnpm test' })).toBe('pnpm test')
    expect(toolTargetLabel('Read', { path: 'a/b.ts' })).toBe('a/b.ts')
    expect(toolTargetLabel('Grep', { pattern: 'foo' })).toBe('foo')
    expect(toolTargetLabel('unknown.Tool', { file_path: 'x' })).toBe('x')
    // 正文参数绝不成为目标；无候选键时省略。
    expect(toolTargetLabel('Edit', { old_string: 'secret', new_string: 's' })).toBeUndefined()
    expect(toolTargetLabel('Read', 'not-an-object')).toBeUndefined()
    // 超长截断。
    expect(toolTargetLabel('Read', { path: 'x'.repeat(100) })?.length).toBe(72)
  })

  it('toolBodyLabel：按工具拼展开正文，未知工具退回 JSON，超长截断', () => {
    expect(toolBodyLabel('Bash', { command: 'a\nb' })).toBe('a\nb')
    expect(toolBodyLabel('Write', { path: 'a.ts', content: 'x=1' })).toBe('a.ts\n\nx=1')
    expect(toolBodyLabel('Edit', { path: 'a.ts', old_string: 'o', new_string: 'n' })).toBe(
      'a.ts\n\n【旧】\no\n\n【新】\nn',
    )
    expect(toolBodyLabel('Read', { path: 'a.ts', offset: 2, limit: 10 })).toBe(
      'a.ts\n\noffset: 2 · limit: 10',
    )
    expect(toolBodyLabel('WebFetch', { url: 'https://x', prompt: '摘要' })).toBe(
      'https://x\n\n摘要',
    )
    // 正文参数缺失时不出空段；input 非对象省略。
    expect(toolBodyLabel('Bash', {})).toBeUndefined()
    expect(toolBodyLabel('Read', 'not-an-object')).toBeUndefined()
    // 未知工具：入参 JSON 全量。
    expect(toolBodyLabel('Mystery', { k: 'v' })).toBe('{\n  "k": "v"\n}')
    // 超长截断（BODY_MAX=4000）。
    const huge = toolBodyLabel('Bash', { command: 'x'.repeat(5000) })
    expect(huge?.length).toBe(4000 + '\n…（已截断）'.length)
    // 折叠行中文标签；未知工具原样。
    expect(toolLabel('Bash')).toBe('终端')
    expect(toolLabel('Mystery')).toBe('Mystery')
  })

  it('hydrate：快照 tool 条目重建工具卡（target/body），live 卡不被冲掉', () => {
    const live = reduceChatState(
      initialChatState,
      envelope('core', {
        type: 'tool.requested',
        payload: { toolUseId: 'tu-live', tool: 'Bash', input: { command: 'live-cmd' } },
      }),
    )
    const state = reduceChatState(live, {
      type: 'hydrate',
      transcript: [
        { id: 'm-1', role: 'user', text: '跑' },
        { id: 'tu-1', kind: 'tool', tool: 'Bash', input: { command: 'pnpm test' }, status: 'done' },
        {
          id: 'tu-2',
          kind: 'tool',
          tool: 'Write',
          input: { path: 'a.ts', content: 'x=1' },
          status: 'error',
        },
        { id: 'tu-live', kind: 'tool', tool: 'Bash', input: { command: 'stale' }, status: 'done' },
      ],
    })
    expect(state.messages.map((message) => message.id)).toEqual(['m-1'])
    // 快照卡在前、live 卡保留在后；同 id 的快照条目被丢弃（live 优先）。
    expect(state.tools.map((tool) => tool.toolUseId)).toEqual(['tu-1', 'tu-2', 'tu-live'])
    expect(state.tools[0]).toMatchObject({
      tool: 'Bash',
      status: 'done',
      target: 'pnpm test',
      body: 'pnpm test',
    })
    expect(state.tools[1]).toMatchObject({ status: 'error', body: 'a.ts\n\nx=1' })
    expect(state.tools[2]?.target).toBe('live-cmd')
  })

  it('permission.mode 帧更新档位：非法值忽略，本地动作同写一处', () => {
    // 回归：composer 档位曾只挂载拉取一次，TUI /mode / g 授权后 UI 脱钩。
    const seeded = reduceChatState(initialChatState, { type: 'permission-mode', mode: 'ask' })
    expect(seeded.permissionMode).toBe('ask')
    const pushed = reduceChatState(
      seeded,
      envelope('view', { type: 'permission.mode', mode: 'full' }),
    )
    expect(pushed.permissionMode).toBe('full')
    // 非法档位（畸形帧/坏响应）不落状态
    expect(
      reduceChatState(pushed, envelope('view', { type: 'permission.mode', mode: 'yolo' }))
        .permissionMode,
    ).toBe('full')
    expect(
      reduceChatState(pushed, { type: 'permission-mode', mode: 42 as never }).permissionMode,
    ).toBe('full')
  })

  it('session.attached 重挂会话时保留进程级权限档位（选择器不闪没）', () => {
    const seeded = reduceChatState(initialChatState, { type: 'permission-mode', mode: 'auto' })
    const state = reduceChatState(seeded, envelope('view', { type: 'session.attached', id: 's2' }))
    expect(state.messages).toHaveLength(0)
    expect(state.permissionMode).toBe('auto')
  })

  it('hydrate 以 transcript 为准替换消息列表', () => {
    const dirty = reduceChatState(initialChatState, { type: 'echo', text: '旧', images: [] })
    const state = reduceChatState(dirty, {
      type: 'hydrate',
      transcript: [{ id: 't1', role: 'user', text: '持久化' }],
    })
    expect(state.messages).toEqual([{ id: 't1', role: 'user', text: '持久化', seq: 2 }])
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
    expect(state.notice).toBe('runner_error: model does not support images')
    state = reduceChatState(
      state,
      envelope('core', { type: 'turn.aborted', payload: { reason: 'error' } }),
    )
    expect(state.turn).toBe('idle')
    expect(state.notice).toBe('runner_error: model does not support images')
  })

  it('turn.aborted 用户中断：走 interrupted 友好位不污染 notice，turn.started 清除', () => {
    let state = reduceChatState(initialChatState, envelope('core', { type: 'turn.started' }))
    state = reduceChatState(
      state,
      envelope('core', { type: 'turn.aborted', payload: { reason: 'user_interrupt' } }),
    )
    expect(state.turn).toBe('idle')
    expect(state.interrupted).toBe(true)
    expect(state.notice).toBeUndefined()
    state = reduceChatState(state, envelope('core', { type: 'turn.started' }))
    expect(state.interrupted).toBe(false)
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
    expect(state.notice).toBe('stream_interrupted: read ECONNRESET')
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

  // §2.7bis.5 U3：子代理冒泡事件（附录 D.3 parentTurnId/parentDepth tag）不混进
  // 主聊天流，只聚合进 Task 折叠行；主会话事件（无 tag）不受影响。
  describe('U3 子代理冒泡过滤与 Task 折叠行聚合', () => {
    it('冒泡 stream/message/turn 事件不进主聊天流（对齐 TUI 过滤）', () => {
      let state = reduceChatState(
        initialChatState,
        envelope('core', { type: 'turn.started', payload: { turnId: 't1' } }),
      )
      const before = state
      state = reduceChatState(
        state,
        envelope('core', {
          type: 'stream.delta',
          payload: { kind: 'text', messageId: 'sub-m1', fragment: '子代理正文' },
          parentTurnId: 't1',
          parentDepth: 1,
        }),
      )
      state = reduceChatState(
        state,
        envelope('core', {
          type: 'message.appended',
          payload: {
            messageId: 'sub-m1',
            role: 'assistant',
            content: [{ type: 'text', text: '子代理正文' }],
          },
          parentTurnId: 't1',
          parentDepth: 1,
        }),
      )
      state = reduceChatState(
        state,
        envelope('core', {
          type: 'turn.completed',
          payload: { turnId: 'sub-turn' },
          parentTurnId: 't1',
          parentDepth: 1,
        }),
      )
      expect(state.messages).toHaveLength(0)
      // 子代理 turn.completed 不得把主会话 turn 拨回 idle。
      expect(state.turn).toBe('running')
      // 无聚合载体的冒泡事件原样返回（state 引用不变）。
      expect(state).toBe(before)
    })

    it('冒泡 tool.* 聚合到 Task 折叠行，不平铺进工具卡列表', () => {
      let state = initialChatState
      // 父会话 Task 派发：requested 带 input（agentType/prompt），started 带 event.turnId。
      state = reduceChatState(
        state,
        envelope('core', {
          type: 'tool.requested',
          payload: {
            toolUseId: 'task-1',
            tool: 'Task',
            input: { agentType: 'explore', prompt: '查一下事件链路' },
          },
          turnId: 't1',
        }),
      )
      state = reduceChatState(
        state,
        envelope('core', {
          type: 'tool.started',
          payload: { toolUseId: 'task-1', tool: 'Task' },
          turnId: 't1',
        }),
      )
      // 子代理工具活动冒泡：parentTurnId 归属到 Task 卡，自身不进 tools 列表。
      state = reduceChatState(
        state,
        envelope('core', {
          type: 'tool.started',
          payload: { toolUseId: 'sub-tu1', tool: 'bash' },
          parentTurnId: 't1',
          parentDepth: 1,
        }),
      )
      state = reduceChatState(
        state,
        envelope('core', {
          type: 'tool.started',
          payload: { toolUseId: 'sub-tu2', tool: 'grep' },
          parentTurnId: 't1',
          parentDepth: 1,
        }),
      )
      state = reduceChatState(
        state,
        envelope('core', {
          type: 'tool.completed',
          payload: { toolUseId: 'sub-tu1', isError: false },
          parentTurnId: 't1',
          parentDepth: 1,
        }),
      )
      // 平铺面只有 Task 一张卡；子代理的 bash/grep 不进 tools。
      expect(state.tools).toHaveLength(1)
      expect(state.tools[0]).toMatchObject({
        toolUseId: 'task-1',
        tool: 'Task',
        status: 'running',
        turnId: 't1',
        task: { agentType: 'explore', prompt: '查一下事件链路' },
      })
      // 折叠行聚合：2 次调用、1 个仍在跑、当前工具 = 最近启动的 grep。
      expect(state.subagents['t1']).toEqual({ toolCalls: 2, running: 1, lastTool: 'grep' })
      // Task 自己 completed → 卡收口，聚合保留（折叠行展示「完成 · N 次调用」）。
      state = reduceChatState(
        state,
        envelope('core', {
          type: 'tool.completed',
          payload: { toolUseId: 'task-1', isError: false },
        }),
      )
      expect(state.tools[0]?.status).toBe('done')
      expect(state.subagents['t1']?.toolCalls).toBe(2)
    })

    it('对照：主会话事件（无 parent tag）照常进消息流与工具卡', () => {
      let state = initialChatState
      state = reduceChatState(
        state,
        envelope('core', {
          type: 'stream.delta',
          payload: { kind: 'text', messageId: 'm1', fragment: '主会话' },
        }),
      )
      state = reduceChatState(
        state,
        envelope('core', {
          type: 'tool.started',
          payload: { toolUseId: 'tu1', tool: 'bash' },
          turnId: 't1',
        }),
      )
      state = reduceChatState(
        state,
        envelope('core', { type: 'tool.completed', payload: { toolUseId: 'tu1', isError: false } }),
      )
      expect(state.messages).toHaveLength(1)
      expect(state.messages[0]).toMatchObject({ id: 'm1', text: '主会话' })
      expect(state.tools).toEqual([
        { toolUseId: 'tu1', tool: 'bash', status: 'done', turnId: 't1', seq: 2 },
      ])
      expect(state.subagents).toEqual({})
    })
  })
})

describe('ask.request / ask.resolved（AskUserQuestion 提问卡）', () => {
  const ask = {
    id: 'ask-1',
    question: '用哪个方案？',
    options: [{ label: '方案 A', description: '快但糙' }, { label: '方案 B' }],
  }

  it('ask.request 进卡（web 只读队首），ask.resolved 清卡', () => {
    const asked = reduceChatState(
      initialChatState,
      envelope('view', { type: 'ask.request', request: ask, requests: [ask] }),
    )
    expect(asked.ask).toEqual(ask)
    const resolved = reduceChatState(asked, envelope('view', { type: 'ask.resolved' }))
    expect(resolved.ask).toBeUndefined()
  })

  it('mcpToolParts/toolLabel：mcp__server__tool 拆解展示，非 MCP 不受影响', async () => {
    const { mcpToolParts } = await import('../session-stream')
    expect(mcpToolParts('mcp__github__search_repos')).toEqual({
      server: 'github',
      name: 'search_repos',
    })
    expect(mcpToolParts('mcp__bad')).toBeUndefined()
    expect(mcpToolParts('Bash')).toBeUndefined()
    expect(toolLabel('mcp__github__search_repos')).toBe('MCP · github/search_repos')
    expect(toolLabel('Bash')).toBe('终端')
  })

  it('MCP 工具的 tool.requested 不产 target（入参无统一语义），body 保留 JSON', () => {
    const state = reduceChatState(
      initialChatState,
      envelope('core', {
        type: 'tool.requested',
        payload: {
          toolUseId: 'tu-mcp',
          tool: 'mcp__github__search_repos',
          input: { query: 'volund', path: '/tmp/x' },
        },
      }),
    )
    expect(state.tools).toHaveLength(1)
    expect(state.tools[0]?.target).toBeUndefined()
    expect(state.tools[0]?.body).toContain('volund')
  })
})

describe('streamedChars（状态行 ↑ tokens 估算的数据源）', () => {
  it('text delta 累计、turn.started 清零；非 text/工具事件不计数', () => {
    let state = reduceMany(initialChatState, [
      envelope('core', { type: 'turn.started' }),
      envelope('core', {
        type: 'stream.delta',
        payload: { kind: 'text', messageId: 'm1', fragment: '12345678' },
      }),
      envelope('core', {
        type: 'stream.delta',
        payload: { kind: 'thinking', messageId: 'm1', fragment: '思考不算' },
      }),
      envelope('core', {
        type: 'tool.started',
        payload: { toolUseId: 'tu1', tool: 'Bash' },
      }),
    ])
    expect(state.streamedChars).toBe(8)
    state = reduceMany(state, [
      envelope('core', { type: 'turn.completed', payload: {} }),
      envelope('core', { type: 'turn.started' }),
    ])
    expect(state.streamedChars).toBe(0)
  })
})

describe('chatFeed 会话流混排（工具卡跟随其发生的时点）', () => {
  it('消息与工具卡按到达 seq 混排；完成/失败只拨状态不挪位置', () => {
    let state = reduceMany(initialChatState, [
      envelope('core', {
        type: 'message.appended',
        payload: { messageId: 'm1', role: 'user', content: [{ type: 'text', text: '读文件' }] },
      }),
      envelope('core', { type: 'tool.started', payload: { toolUseId: 't1', tool: 'Read' } }),
      envelope('core', { type: 'tool.started', payload: { toolUseId: 't2', tool: 'Write' } }),
      envelope('core', {
        type: 'message.appended',
        payload: { messageId: 'm2', role: 'assistant', content: [{ type: 'text', text: '完成' }] },
      }),
    ])
    expect(chatFeed(state).map((entry) => entry.key)).toEqual(['m1', 't1', 't2', 'm2'])
    // 工具完成：位置不变，状态原地更新。
    state = reduceChatState(
      state,
      envelope('core', { type: 'tool.completed', payload: { toolUseId: 't1', isError: false } }),
    )
    const after = chatFeed(state)
    expect(after.map((entry) => entry.key)).toEqual(['m1', 't1', 't2', 'm2'])
    const t1 = after.find((entry) => entry.key === 't1')
    if (t1?.kind === 'tool') expect(t1.tool.status).toBe('done')
  })

  it('tool 卡先于消息到达也保序；重复 requested 原位补参不挪尾', () => {
    let state = reduceMany(initialChatState, [
      envelope('core', { type: 'tool.started', payload: { toolUseId: 't1', tool: 'Bash' } }),
      envelope('core', {
        type: 'stream.delta',
        payload: { kind: 'text', messageId: 'm1', fragment: '输出' },
      }),
    ])
    expect(chatFeed(state).map((entry) => entry.key)).toEqual(['t1', 'm1'])
    // 迟到的 requested 补 target/body：卡不得挪到列表尾。
    state = reduceChatState(
      state,
      envelope('core', {
        type: 'tool.requested',
        payload: { toolUseId: 't1', tool: 'Bash', input: { command: 'pnpm test' } },
      }),
    )
    const feed = chatFeed(state)
    expect(feed.map((entry) => entry.key)).toEqual(['t1', 'm1'])
    const t1 = feed.find((entry) => entry.key === 't1')
    if (t1?.kind === 'tool') expect(t1.tool.target).toBe('pnpm test')
  })

  it('hydrate：快照条目按顺序分配 seq，工具卡与消息保序混排', () => {
    const state = reduceChatState(initialChatState, {
      type: 'hydrate',
      transcript: [
        { id: 'm-1', role: 'user', text: '跑' },
        { id: 'tu-1', kind: 'tool', tool: 'Bash', input: { command: 'pnpm test' }, status: 'done' },
        { id: 'm-2', role: 'assistant', text: '完成' },
      ],
    })
    expect(state.nextSeq).toBe(4)
    expect(chatFeed(state).map((entry) => entry.key)).toEqual(['m-1', 'tu-1', 'm-2'])
    expect(state.tools[0]).toMatchObject({ status: 'done', seq: 2, target: 'pnpm test' })
  })

  it('水合后乐观回显钉在末尾（seq 单调递增）', () => {
    let state = reduceChatState(initialChatState, {
      type: 'hydrate',
      transcript: [
        { id: 'h1', role: 'user', text: '一' },
        { id: 'h2', role: 'assistant', text: '二' },
      ],
    })
    state = reduceChatState(state, { type: 'echo', text: '三', images: [] })
    expect(state.messages.map((message) => message.seq)).toEqual([1, 2, 3])
    expect(state.nextSeq).toBe(4)
  })
})

describe('chatFeedGrouped 连续工具行分组折叠', () => {
  /** 两工具一消息的最小混排态（t1/t2 相邻，m1/m2 切在两侧）。 */
  function mixedState() {
    return reduceMany(initialChatState, [
      envelope('core', {
        type: 'message.appended',
        payload: { messageId: 'm1', role: 'user', content: [{ type: 'text', text: '开工' }] },
      }),
      envelope('core', { type: 'tool.started', payload: { toolUseId: 't1', tool: 'Read' } }),
      envelope('core', { type: 'tool.started', payload: { toolUseId: 't2', tool: 'Edit' } }),
      envelope('core', {
        type: 'message.appended',
        payload: { messageId: 'm2', role: 'assistant', content: [{ type: 'text', text: '完成' }] },
      }),
    ])
  }

  it('相邻 ≥2 的工具卡合并成组（key = grp:首卡），消息原样保留', () => {
    const feed = chatFeedGrouped(mixedState())
    expect(feed.map((entry) => entry.key)).toEqual(['m1', 'grp:t1', 'm2'])
    const group = feed[1]
    if (group?.kind !== 'tool-group') throw new Error('expected tool-group')
    expect(group.tools.map((tool) => tool.toolUseId)).toEqual(['t1', 't2'])
  })

  it('单条工具不分组（保持平铺 key）；消息切断不相邻的工具', () => {
    const single = reduceMany(initialChatState, [
      envelope('core', { type: 'tool.started', payload: { toolUseId: 't1', tool: 'Bash' } }),
      envelope('core', {
        type: 'message.appended',
        payload: { messageId: 'm1', role: 'assistant', content: [{ type: 'text', text: '好' }] },
      }),
    ])
    expect(chatFeedGrouped(single).map((entry) => entry.key)).toEqual(['t1', 'm1'])

    // t1 与 t2 之间隔着 m2：两个平铺卡，不成组。
    const split = reduceMany(initialChatState, [
      envelope('core', { type: 'tool.started', payload: { toolUseId: 't1', tool: 'Bash' } }),
      envelope('core', {
        type: 'message.appended',
        payload: { messageId: 'm2', role: 'assistant', content: [{ type: 'text', text: '中' }] },
      }),
      envelope('core', { type: 'tool.started', payload: { toolUseId: 't3', tool: 'Read' } }),
    ])
    expect(chatFeedGrouped(split).map((entry) => entry.key)).toEqual(['t1', 'm2', 't3'])
  })

  it('运行中追加新卡并入组且 key 不变（展开态跨重渲染保持的前提）', () => {
    let state = reduceMany(initialChatState, [
      envelope('core', { type: 'tool.started', payload: { toolUseId: 't1', tool: 'Read' } }),
    ])
    expect(chatFeedGrouped(state).map((entry) => entry.key)).toEqual(['t1'])
    state = reduceChatState(
      state,
      envelope('core', { type: 'tool.started', payload: { toolUseId: 't2', tool: 'Edit' } }),
    )
    const feed = chatFeedGrouped(state)
    expect(feed.map((entry) => entry.key)).toEqual(['grp:t1'])
    const group = feed[0]
    if (group?.kind !== 'tool-group') throw new Error('expected tool-group')
    expect(group.tools).toHaveLength(2)
  })

  it('组内状态随事件流动（完成/失败在组内卡上原地更新）', () => {
    let state = mixedState()
    state = reduceChatState(
      state,
      envelope('core', { type: 'tool.completed', payload: { toolUseId: 't1', isError: true } }),
    )
    const feed = chatFeedGrouped(state)
    const group = feed[1]
    if (group?.kind !== 'tool-group') throw new Error('expected tool-group')
    expect(group.tools.find((tool) => tool.toolUseId === 't1')?.status).toBe('error')
    expect(group.tools.find((tool) => tool.toolUseId === 't2')?.status).toBe('running')
  })
})
