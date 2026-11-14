import { createSession, EventBus, type SessionState } from '@volund/core'
import { describe, expect, it, vi } from 'vitest'

import {
  CHECKPOINTS_DEFAULTS,
  CheckpointController,
  resolveCheckpointsConfig,
} from '../checkpoints'

function baseState(): SessionState {
  return createSession({ id: 's1', cwd: '/repo', maxTokens: 100, toolRegistrySnapshot: '' })
}

function controllerOf(
  overrides: Partial<{
    state: SessionState
    config: Partial<{ enabled: boolean; maxPerSession: number; retentionDays: number }>
  }> = {},
): { controller: CheckpointController; events: EventBus; emitted: Array<Record<string, unknown>> } {
  const state = overrides.state ?? baseState()
  const events = new EventBus()
  const emitted: Array<Record<string, unknown>> = []
  events.subscribe((event) => {
    if (event.type === 'checkpoint.created')
      emitted.push(event as unknown as Record<string, unknown>)
  })
  const controller = new CheckpointController({
    state: () => state,
    events,
    config: { ...CHECKPOINTS_DEFAULTS, ...overrides.config },
  })
  return { controller, events, emitted }
}

/** 模拟 runner 的 turn.started（冒泡副本按附录 D.3 走 forward 带 parentTurnId）。 */
function emitTurnStarted(events: EventBus, turnId: string, bubbled = false): void {
  const input = {
    type: 'turn.started' as const,
    version: 1,
    sessionId: 's1',
    turnId,
    payload: { turnId },
  }
  if (bubbled) {
    void events.forward(
      { ...input, id: `ev_${turnId}`, at: Date.now() },
      {
        parentTurnId: 'parent-turn',
        parentDepth: 1,
      },
    )
    return
  }
  void events.emit(input)
}

describe('resolveCheckpointsConfig', () => {
  it('defaults on garbage sections and floors positive numbers', () => {
    expect(resolveCheckpointsConfig(undefined)).toEqual(CHECKPOINTS_DEFAULTS)
    expect(resolveCheckpointsConfig('nope')).toEqual(CHECKPOINTS_DEFAULTS)
    expect(resolveCheckpointsConfig(['array'])).toEqual(CHECKPOINTS_DEFAULTS)
    expect(resolveCheckpointsConfig({ max_per_session: 3.9, retention_days: -2 })).toEqual({
      enabled: true,
      maxPerSession: 3,
      retentionDays: 7,
    })
    expect(
      resolveCheckpointsConfig({ enabled: false, max_per_session: 10, retention_days: 30 }),
    ).toEqual({ enabled: false, maxPerSession: 10, retentionDays: 30 })
  })
})

describe('CheckpointController', () => {
  it('emits one turn-boundary checkpoint per non-bubbled turn.started', async () => {
    const { controller, events, emitted } = controllerOf()
    controller.attach()
    emitTurnStarted(events, 't1')
    emitTurnStarted(events, 't2')
    await vi.waitFor(() => expect(emitted).toHaveLength(2))
    expect(emitted[0]).toMatchObject({
      type: 'checkpoint.created',
      sessionId: 's1',
      turnId: 't1',
    })
    const payload = emitted[0]!.payload as {
      checkpointId: string
      trigger: string
      batchCount: number
    }
    expect(payload).toMatchObject({ trigger: 'turn-boundary', batchCount: 0 })
    expect(payload.checkpointId).toMatch(/^cp_/)
  })

  it('ignores bubbled subagent turn.started copies (附录 D.3)', async () => {
    const { controller, events, emitted } = controllerOf()
    controller.attach()
    emitTurnStarted(events, 'child-turn', true)
    await vi.waitFor(() => expect(emitted).toHaveLength(0))
    emitTurnStarted(events, 't1')
    await vi.waitFor(() => expect(emitted).toHaveLength(1))
  })

  it('config.enabled=false silences turn-boundary but manual still fires', async () => {
    const { controller, events, emitted } = controllerOf({ config: { enabled: false } })
    controller.attach()
    emitTurnStarted(events, 't1')
    await vi.waitFor(() => expect(emitted).toHaveLength(0))
    const id = await controller.createManual()
    await vi.waitFor(() => expect(emitted).toHaveLength(1))
    expect((emitted[0]!.payload as { checkpointId: string }).checkpointId).toBe(id)
    expect((emitted[0]!.payload as { trigger: string }).trigger).toBe('manual')
  })

  it('stops turn-boundary at maxPerSession but keeps manual/pre-mutation', async () => {
    const { controller, events, emitted } = controllerOf({ config: { maxPerSession: 2 } })
    controller.attach()
    emitTurnStarted(events, 't1')
    emitTurnStarted(events, 't2')
    await vi.waitFor(() => expect(emitted).toHaveLength(2))
    expect(controller.emittedCount).toBe(2)
    emitTurnStarted(events, 't3')
    await vi.waitFor(() => expect(emitted).toHaveLength(2))
    const manualId = await controller.createManual()
    await vi.waitFor(() => expect(emitted).toHaveLength(3))
    expect((emitted[2]!.payload as { checkpointId: string }).checkpointId).toBe(manualId)
    controller.onBeforeMutation('s1')
    await vi.waitFor(() => expect(emitted).toHaveLength(4))
    expect((emitted[3]!.payload as { trigger: string }).trigger).toBe('pre-mutation')
  })

  it('onBeforeMutation only fires for the bound session id', async () => {
    const { controller, emitted } = controllerOf()
    controller.onBeforeMutation('other-session')
    await vi.waitFor(() => expect(emitted).toHaveLength(0))
    controller.onBeforeMutation('s1')
    await vi.waitFor(() => expect(emitted).toHaveLength(1))
    expect((emitted[0]!.payload as { trigger: string }).trigger).toBe('pre-mutation')
  })

  it('noteMutationBatch advances the chain and later checkpoints carry batchHead/batchCount', async () => {
    const { controller, emitted } = controllerOf()
    controller.noteMutationBatch('other', 'b_other')
    expect(controller.chain()).toEqual({ count: 0 })
    const firstId = await controller.createManual()
    await vi.waitFor(() => expect(emitted).toHaveLength(1))
    expect((emitted[0]!.payload as { batchHead?: string }).batchHead).toBeUndefined()
    controller.noteMutationBatch('s1', 'batch-1')
    controller.noteMutationBatch('s1', 'batch-2')
    expect(controller.chain()).toEqual({ count: 2, head: 'batch-2' })
    const secondId = await controller.createManual()
    await vi.waitFor(() => expect(emitted).toHaveLength(2))
    expect((emitted[1]!.payload as { checkpointId: string }).checkpointId).toBe(secondId)
    expect((emitted[1]!.payload as { batchCount: number; batchHead?: string }).batchCount).toBe(2)
    expect((emitted[1]!.payload as { batchHead?: string }).batchHead).toBe('batch-2')
    expect(firstId).toMatch(/^cp_/)
  })

  it('dispose detaches the bus subscription', async () => {
    const { controller, events, emitted } = controllerOf()
    controller.attach()
    controller.dispose()
    emitTurnStarted(events, 't1')
    await vi.waitFor(() => expect(emitted).toHaveLength(0))
    expect(await controller.createManual()).toBeUndefined()
    expect(emitted).toHaveLength(0)
  })
})
