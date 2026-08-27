import { EVENT_NAMES } from '@volund/shared'
import { describe, expect, it, vi } from 'vitest'

import { EventBus, eventTypes, idempotentSubscriber } from './event-bus'

describe('EventBus', () => {
  it('exposes the appendix D event set (single source: EVENT_NAMES)', () => {
    expect(eventTypes).toBe(EVENT_NAMES)
    expect(eventTypes).toHaveLength(25)
  })
  it('emits ordered UUIDv7 events', async () => {
    const bus = new EventBus()
    const first = await bus.emit({
      type: 'session.started',
      version: 1,
      sessionId: 's',
      payload: { cwd: '/repo' },
    })
    const second = await bus.emit({
      type: 'session.ended',
      version: 2,
      sessionId: 's',
      payload: { reason: 'exit', exitCode: 0 },
    })
    expect(first.id[14]).toBe('7')
    expect(second.id[14]).toBe('7')
    expect(first.id < second.id).toBe(true)
  })
  it('throws on payloads that violate the appendix D contract (r13-I8)', async () => {
    const bus = new EventBus()
    await expect(
      bus.emit({ type: 'session.started', version: 1, sessionId: 's', payload: {} }),
    ).rejects.toThrow('appendix D contract')
    await expect(
      bus.emit({
        type: 'stream.delta',
        version: 1,
        sessionId: 's',
        payload: { chunk: { kind: 'text.delta', text: 'legacy shape' } },
      }),
    ).rejects.toThrow('appendix D contract')
  })
  it('forwards subagent bubbles with the original event.id and envelope tags (D.3, r13-D1)', async () => {
    const bus = new EventBus()
    const original = await new EventBus().emit({
      type: 'turn.started',
      version: 1,
      sessionId: 'child',
      payload: { turnId: 'child-turn' },
    })
    const seen: unknown[] = []
    bus.subscribe((event) => {
      seen.push(event)
    })
    const bubbled = await bus.forward(original, { parentTurnId: 'parent-turn', parentDepth: 2 })
    expect(bubbled.id).toBe(original.id)
    expect(bubbled.at).toBe(original.at)
    expect(bubbled.payload).toEqual(original.payload)
    expect(seen).toEqual([
      expect.objectContaining({
        id: original.id,
        parentTurnId: 'parent-turn',
        parentDepth: 2,
      }),
    ])
  })
  it('deduplicates replayed events per subscriber', async () => {
    const listener = vi.fn()
    const safe = idempotentSubscriber(listener)
    const event = {
      id: 'same',
      type: 'session.started' as const,
      version: 1,
      sessionId: 's',
      payload: { cwd: '/repo' },
      at: 1,
    }
    await safe(event)
    await safe(event)
    expect(listener).toHaveBeenCalledTimes(1)
  })
})
