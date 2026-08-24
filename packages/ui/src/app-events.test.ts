import type { CoreEvent } from '@apollo-code/core'
import { describe, expect, it } from 'vitest'

import type { InteractiveAppState } from './app'
import { applyInteractiveEvent } from './app'

const baseState: InteractiveAppState = {
  pendingAssistantText: '',
  sessionId: 's',
  status: 'ready',
  statusLevel: 'muted',
  transcript: [],
}

function event(type: CoreEvent['type'], payload: CoreEvent['payload']): CoreEvent {
  return { id: `e-${type}`, type, version: 1, sessionId: 's', payload, at: 0 }
}

describe('applyInteractiveEvent transcript dedup', () => {
  it('renders one assistant entry per turn even though stream.completed precedes message.appended', () => {
    // 回归：runner 对每个 assistant step 先 emit stream.completed 再 emit message.appended
    // （runner.ts 附录 D.2 时序），两者都曾往 transcript 追加同文本 entry → 回复渲染两遍。
    // 定稿只由 message.appended 落 transcript，stream.completed 只清 streaming 暂存。
    let state = applyInteractiveEvent(baseState, event('stream.started', { messageId: 'm-1' }))
    state = applyInteractiveEvent(
      state,
      event('stream.delta', { messageId: 'm-1', kind: 'text', fragment: '你好' }),
    )
    state = applyInteractiveEvent(
      state,
      event('stream.delta', { messageId: 'm-1', kind: 'text', fragment: '，世界' }),
    )
    state = applyInteractiveEvent(state, event('stream.completed', { messageId: 'm-1' }))
    state = applyInteractiveEvent(
      state,
      event('message.appended', {
        messageId: 'm-1',
        role: 'assistant',
        content: [{ type: 'text', text: '你好，世界' }],
      }),
    )
    expect(state.transcript.filter((entry) => entry.role === 'assistant')).toHaveLength(1)
    expect(state.transcript[0]).toMatchObject({ role: 'assistant', text: '你好，世界' })
    expect(state.pendingAssistantText).toBe('')
  })
})

describe('applyInteractiveEvent error visibility', () => {
  it('shows code and context message for error.raised', () => {
    const state = applyInteractiveEvent(
      baseState,
      event('error.raised', {
        code: 'runner_error',
        context: { message: 'Anthropic request failed (401)', provider: 'anthropic' },
      }),
    )
    expect(state.status).toBe('runner_error: Anthropic request failed (401)')
    expect(state.statusLevel).toBe('error')
  })

  it('keeps the specific error status when the turn then aborts with reason=error', () => {
    const errored = applyInteractiveEvent(
      baseState,
      event('error.raised', { code: 'runner_error', context: { message: 'boom' } }),
    )
    const aborted = applyInteractiveEvent(
      errored,
      event('turn.aborted', { turnId: 't', reason: 'error' }),
    )
    expect(aborted.status).toBe('runner_error: boom')
    expect(aborted.statusLevel).toBe('error')
  })

  it('still reports a plain turn abort for user interrupts', () => {
    const aborted = applyInteractiveEvent(
      baseState,
      event('turn.aborted', { turnId: 't', reason: 'user_interrupt' }),
    )
    expect(aborted.status).toBe('turn aborted')
    expect(aborted.statusLevel).toBe('warning')
  })

  it('falls back to the bare code when error.raised has no usable context message', () => {
    const state = applyInteractiveEvent(
      baseState,
      event('error.raised', { code: 'runner_error', context: { message: 42 } }),
    )
    expect(state.status).toBe('runner_error')
    expect(state.statusLevel).toBe('error')
  })
})
