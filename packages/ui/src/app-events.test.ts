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
