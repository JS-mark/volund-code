import { describe, expect, it } from 'vitest'

import { replaySessionState, type ReplayableEvent } from './replay'

function line(input: Omit<ReplayableEvent, 'sessionId' | 'at'> & { at?: string }): ReplayableEvent {
  return { sessionId: 's', at: '2026-08-18T00:00:00.000Z', ...input }
}

const newShapeTurn = (): ReplayableEvent[] => [
  line({ id: '1', type: 'session.started', payload: { cwd: '/repo' } }),
  line({ id: '2', type: 'turn.started', turnId: 't1', payload: { turnId: 't1' } }),
  line({
    id: '3',
    type: 'message.appended',
    turnId: 't1',
    payload: {
      messageId: 'm1',
      role: 'user',
      content: [{ type: 'text', text: 'hello' }],
    },
  }),
  line({
    id: '4',
    type: 'message.appended',
    turnId: 't1',
    payload: {
      messageId: 'm2',
      role: 'assistant',
      content: [{ type: 'text', text: 'world' }],
    },
  }),
  line({
    id: '5',
    type: 'turn.completed',
    turnId: 't1',
    payload: {
      turnId: 't1',
      usage: { input: 2, output: 3, costUSD: 0.01 },
      stopReason: 'end_turn',
    },
  }),
]

describe('replaySessionState', () => {
  it('rebuilds SessionState from appendix D shaped events', () => {
    const { state, found, skippedEventIds } = replaySessionState('s', newShapeTurn())
    expect(found).toBe(true)
    expect(skippedEventIds).toEqual([])
    expect(state.cwd).toBe('/repo')
    expect(state.activeTurn).toBeNull()
    expect(state.messages.map((message) => [message.id, message.role])).toEqual([
      ['m1', 'user'],
      ['m2', 'assistant'],
    ])
    expect(state.messages[1]?.content).toEqual([{ type: 'text', text: 'world' }])
    expect(state.turns).toEqual([
      expect.objectContaining({ id: 't1', status: 'done', parentDepth: 0 }),
    ])
    expect(state.cumulativeUsage).toMatchObject({ input: 2, output: 3, costUSD: 0.01 })
  })

  it('marks an unfinished turn aborted and keeps subagent lineage tags', () => {
    const events = newShapeTurn().slice(0, 3)
    events.push(
      line({
        id: '9',
        type: 'turn.started',
        turnId: 't2',
        parentTurnId: 'p1',
        parentDepth: 1,
        payload: { turnId: 't2', parentTurnId: 'p1', agentType: 'coder' },
      }),
    )
    const { state } = replaySessionState('s', events)
    expect(state.turns.map((turn) => [turn.id, turn.status])).toEqual([
      ['t1', 'aborted'],
      ['t2', 'aborted'],
    ])
    expect(state.turns[1]).toMatchObject({ parentTurnId: 'p1', parentDepth: 1, agentType: 'coder' })
  })

  it('restores the session-pinned model from session.model_changed (last one wins)', () => {
    const events = [
      line({ id: '1', type: 'session.started', payload: { cwd: '/repo' } }),
      line({
        id: '2',
        type: 'session.model_changed',
        payload: { model: 'anthropic/claude-sonnet-4-20250514' },
      }),
      line({ id: '3', type: 'turn.started', turnId: 't1', payload: { turnId: 't1' } }),
      // /model 再次切换：按序重放，最后一条生效。
      line({
        id: '4',
        type: 'session.model_changed',
        payload: { model: 'anthropic/mimo-v2.5' },
      }),
    ]
    const { state } = replaySessionState('s', events)
    expect(state.model).toBe('anthropic/mimo-v2.5')
  })

  it('leaves state.model unset for sessions without a model_changed event', () => {
    const { state } = replaySessionState('s', newShapeTurn())
    expect(state.model).toBeUndefined()
  })

  it('tolerates legacy shapes: skips what it cannot map and marks it', () => {
    const events: ReplayableEvent[] = [
      line({ id: '1', type: 'session.started', payload: { cwd: '/legacy' } }),
      line({ id: '2', type: 'turn.started', turnId: 't1', payload: {} }),
      // r13 之前的 message.appended 只有 {messageId}
      line({ id: '3', type: 'message.appended', turnId: 't1', payload: { messageId: 'old' } }),
      // 旧 error.raised 自创字段
      line({ id: '4', type: 'error.raised', turnId: 't1', payload: { code: 'x', reason: 'y' } }),
      // 旧 turn.completed {status, exitCode} 仍终结 turn
      line({
        id: '5',
        type: 'turn.completed',
        turnId: 't1',
        payload: { status: 'completed', exitCode: 0 },
      }),
    ]
    const { state, found, skippedEventIds } = replaySessionState('s', events)
    expect(found).toBe(true)
    expect(skippedEventIds).toEqual(['3', '4'])
    expect(state.messages).toEqual([])
    expect(state.turns).toEqual([expect.objectContaining({ id: 't1', status: 'done' })])
  })

  it('restores legacy sessions from their last session.snapshot baseline', () => {
    const snapshotState = {
      id: 's',
      cwd: '/legacy',
      createdAt: 1,
      version: 7,
      messages: [
        {
          id: 'm0',
          role: 'user',
          content: [{ type: 'text', text: 'before snapshot' }],
          createdAt: 1,
        },
      ],
      turns: [{ id: 't0', startMessageId: '', status: 'done', parentDepth: 0 }],
      activeTurn: null,
      pendingInterrupt: false,
      cumulativeUsage: { input: 1, output: 1, costUSD: 0 },
      contextBudget: { maxTokens: 100, currentTokens: 2 },
      toolRegistrySnapshot: 'builtin:l1',
      lineage: { depth: 0 },
    }
    // 真实遗留顺序：快照是 turn 完结后的最后一行；其后是下一个 turn 的事件。
    const events: ReplayableEvent[] = [
      line({ id: '90', type: 'session.snapshot', payload: snapshotState as never }),
      line({ id: '91', type: 'turn.started', turnId: 't1', payload: { turnId: 't1' } }),
      line({
        id: '92',
        type: 'message.appended',
        turnId: 't1',
        payload: {
          messageId: 'after',
          role: 'user',
          content: [{ type: 'text', text: 'after snapshot' }],
        },
      }),
      line({
        id: '93',
        type: 'turn.completed',
        turnId: 't1',
        payload: { turnId: 't1', usage: { input: 1, output: 1 } },
      }),
    ]
    const { state, found, skippedEventIds } = replaySessionState('s', events)
    expect(found).toBe(true)
    expect(skippedEventIds).toEqual([])
    expect(state.id).toBe('s')
    expect(state.messages.map((message) => message.id)).toEqual(['m0', 'after'])
    expect(state.contextBudget).toEqual({ maxTokens: 100, currentTokens: 2 })
    expect(state.toolRegistrySnapshot).toBe('builtin:l1')
    expect(state.activeTurn).toBeNull()
    expect(state.turns.map((turn) => [turn.id, turn.status])).toEqual([
      ['t0', 'done'],
      ['t1', 'done'],
    ])
  })

  it('reports nothing found for an empty log', () => {
    const { found } = replaySessionState('s', [])
    expect(found).toBe(false)
  })
})
