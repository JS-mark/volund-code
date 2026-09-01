import { createSession, EventBus, type Runner } from '@volund/core'
import { describe, expect, it, vi } from 'vitest'

import { AgentDefinitionRegistry } from './agent-registry'
import { SubagentDispatcher } from './index'

const parent = (depth = 0, signal = new AbortController().signal) => ({
  state: createSession({
    id: `parent-${depth}`,
    cwd: '/workspace',
    maxTokens: 100,
    toolRegistrySnapshot: 'tools',
    lineage: { depth },
  }),
  events: new EventBus(),
  turnId: 'parent-turn',
  signal,
})

function fakeRunner(run: Runner['run']): Runner {
  return { run, interrupt: vi.fn() } as unknown as Runner
}

describe('SubagentDispatcher', () => {
  it('creates an isolated child and bubbles envelope-tagged events with the original id (D.3)', async () => {
    let childState: ReturnType<typeof createSession> | undefined
    const seen: Array<{
      id: string
      payload: unknown
      parentTurnId?: string
      parentDepth?: number
    }> = []
    const p = parent()
    p.events.subscribe((event) => {
      seen.push({
        id: event.id,
        payload: event.payload,
        ...(event.parentTurnId ? { parentTurnId: event.parentTurnId } : {}),
        ...(event.parentDepth === undefined ? {} : { parentDepth: event.parentDepth }),
      })
    })
    const dispatcher = new SubagentDispatcher({
      runnerFactory(state, events) {
        childState = state
        return fakeRunner(async () => {
          const emitted = await events.emit({
            type: 'turn.started',
            version: 1,
            sessionId: state.id,
            payload: { turnId: 'child-turn' },
          })
          // r13-D1：冒泡保留原 event.id；payload 不被 childPayload 包装（附录 D.3）。
          seen.push({ id: `original:${emitted.id}`, payload: emitted.payload })
          return {
            ...state,
            messages: [
              {
                id: 'm',
                role: 'assistant',
                createdAt: 1,
                content: [{ type: 'text', text: 'done' }],
              },
            ],
          }
        })
      },
    })
    await expect(dispatcher.dispatch(p, { prompt: 'work' })).resolves.toMatchObject({
      text: 'done',
    })
    expect(childState?.messages).toEqual([])
    expect(childState?.id).not.toBe(p.state.id)
    expect(childState?.lineage).toMatchObject({ depth: 1, parentSessionId: p.state.id })
    const bubbled = seen.find((event) => event.parentTurnId === 'parent-turn')
    expect(bubbled).toBeDefined()
    expect(bubbled).toMatchObject({ parentDepth: 1, payload: { turnId: 'child-turn' } })
    expect(seen.some((event) => event.id === `original:${bubbled!.id}`)).toBe(true)
    expect(JSON.stringify(seen)).not.toContain('childPayload')
  })

  it('allows depths one through three and rejects depth four', async () => {
    const dispatcher = new SubagentDispatcher({
      runnerFactory: (state) => fakeRunner(async () => state),
    })
    for (const depth of [0, 1, 2])
      await expect(dispatcher.dispatch(parent(depth), { prompt: 'ok' })).resolves.toBeDefined()
    await expect(dispatcher.dispatch(parent(3), { prompt: 'no' })).rejects.toMatchObject({
      code: 'VOLUND_SUBAGENT_DEPTH_EXCEEDED',
    })
  })

  it('cascades cancellation and leaves no orphan', async () => {
    const controller = new AbortController()
    let release!: () => void
    const pending = new Promise<void>((resolve) => (release = resolve))
    const runner = fakeRunner(async () => {
      await pending
      return parent().state
    })
    const dispatcher = new SubagentDispatcher({ runnerFactory: () => runner })
    const result = dispatcher.dispatch(parent(0, controller.signal), { prompt: 'wait' })
    await vi.waitFor(() => expect(dispatcher.activeCount).toBe(1))
    controller.abort()
    release()
    await expect(result).resolves.toMatchObject({ status: 'cancelled' })
    expect(runner.interrupt).toHaveBeenCalledOnce()
    expect(dispatcher.activeCount).toBe(0)
  })

  it('bounds fan-out concurrency', async () => {
    let release!: () => void
    const pending = new Promise<void>((resolve) => (release = resolve))
    const dispatcher = new SubagentDispatcher({
      maxConcurrency: 1,
      runnerFactory: (state) =>
        fakeRunner(async () => {
          await pending
          return state
        }),
    })
    const first = dispatcher.dispatch(parent(), { prompt: 'one' })
    await vi.waitFor(() => expect(dispatcher.activeCount).toBe(1))
    await expect(dispatcher.dispatch(parent(), { prompt: 'two' })).rejects.toMatchObject({
      code: 'VOLUND_SUBAGENT_CONCURRENCY_EXCEEDED',
    })
    release()
    await first
  })

  it('resolves a registered agentType to its definition and rejects unknown names (§2.7.1)', async () => {
    const helper = {
      definition: { name: 'helper', description: 'helps', tools: ['Read'], maxTurns: 3 },
      path: '/agents/helper.md',
      scope: 'project' as const,
      trusted: false,
    }
    const registry = new AgentDefinitionRegistry({ volundHome: '/nonexistent', cwd: '/nonexistent' })
    vi.spyOn(registry, 'get').mockImplementation((name: string) =>
      name === 'helper' ? helper : undefined,
    )
    vi.spyOn(registry, 'list').mockReturnValue([helper])
    const seen: Array<unknown> = []
    const dispatcher = new SubagentDispatcher({
      agents: registry,
      runnerFactory: (state, _events, agent) => {
        seen.push(agent)
        return fakeRunner(async () => state)
      },
    })
    expect(dispatcher.agentTypeNames()).toContain('helper')
    expect(dispatcher.agentTypeNames()).toContain('reviewer')

    await dispatcher.dispatch(parent(), { prompt: 'ok', agentType: 'helper' })
    expect(seen[0]).toMatchObject({
      trusted: false,
      definition: { name: 'helper', maxTurns: 3 },
    })
    await expect(dispatcher.dispatch(parent(), { prompt: 'x', agentType: 'ghost' })).rejects.toMatchObject(
      { code: 'VOLUND_SUBAGENT_UNKNOWN_AGENT' },
    )
    // 内置名无需定义即可用（RouterHint role 词汇维持原行为）。
    await expect(dispatcher.dispatch(parent(), { prompt: 'x', agentType: 'planner' })).resolves.toBeDefined()
  })

  it('stays permissive when no agent registry is configured', async () => {
    const dispatcher = new SubagentDispatcher({
      runnerFactory: (state) => fakeRunner(async () => state),
    })
    await expect(dispatcher.dispatch(parent(), { prompt: 'x', agentType: 'anything' })).resolves.toBeDefined()
  })
})
