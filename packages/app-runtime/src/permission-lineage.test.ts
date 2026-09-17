import { createSession, EventBus } from '@volund/core'
import type { PermissionRequest } from '@volund/permission'
import { describe, expect, it } from 'vitest'

import type { InteractivePermissionRequest } from './contracts'
import {
  createProductionToolPermissionChain,
  type ProductionPermissionSessionSnapshot,
  requestPermission,
} from './permission'

/** §2.7bis.5 U4：审批归属 lineage——子代理请求带血统（三端徽标），主代理省略（无徽标）。 */

const askSnapshot: ProductionPermissionSessionSnapshot = Object.freeze({
  dangerouslySkip: false,
  interactionMode: 'tui' as const,
  mode: 'ask' as const,
})

function bashRequest(session: { id: string; cwd: string }): PermissionRequest {
  return {
    toolName: 'Bash',
    spec: { bash: { command: 'ls' } },
    input: { command: 'ls' },
    session,
    attempt: 1,
  }
}

function capturePrompt(): {
  prompt: (request: InteractivePermissionRequest) => Promise<{ kind: 'allow-once' }>
  seen: () => InteractivePermissionRequest | undefined
} {
  let seen: InteractivePermissionRequest | undefined
  return {
    prompt: async (request) => {
      seen = request
      return { kind: 'allow-once' }
    },
    seen: () => seen,
  }
}

describe('requestPermission lineage projection（§2.7bis.5 U4）', () => {
  it('attaches lineage to the interactive request when provided', async () => {
    const { prompt, seen } = capturePrompt()
    const decision = await requestPermission({
      events: new EventBus(),
      interactionMode: 'tui',
      interactivePermissionPrompt: prompt,
      request: bashRequest({ id: 'sub-1', cwd: '/tmp/u4' }),
      lineage: { sessionId: 'sub-1', agentType: 'explore', parentTurnId: 'turn-3' },
      version: 1,
    })
    expect(decision).toEqual({ kind: 'allow-once' })
    expect(seen()?.lineage).toEqual({
      sessionId: 'sub-1',
      agentType: 'explore',
      parentTurnId: 'turn-3',
    })
  })

  it('omits the lineage key when not provided（主代理卡面无徽标回归面）', async () => {
    const { prompt, seen } = capturePrompt()
    await requestPermission({
      events: new EventBus(),
      interactionMode: 'tui',
      interactivePermissionPrompt: prompt,
      request: bashRequest({ id: 'root-1', cwd: '/tmp/u4' }),
      version: 1,
    })
    const request = seen()
    expect(request).toBeDefined()
    expect(request && 'lineage' in request).toBe(false)
  })
})

describe('createProductionToolPermissionChain lineage wiring', () => {
  it('subagent sessions（lineage.depth > 0）project lineage into the shared approval queue request', async () => {
    const state = createSession({
      id: 'sub-1',
      cwd: '/tmp/u4',
      toolRegistrySnapshot: 'snapshot',
      maxTokens: 100_000,
      lineage: {
        depth: 1,
        parentSessionId: 'root-1',
        parentTurnId: 'turn-3',
        agentType: 'explore',
      },
    })
    const { prompt, seen } = capturePrompt()
    const chain = createProductionToolPermissionChain({
      state,
      events: new EventBus(),
      permissionSnapshot: askSnapshot,
      interactivePermissionPrompt: () => prompt,
    })
    const decision = await chain.permissionRequests.request(
      bashRequest({ id: state.id, cwd: state.cwd }),
    )
    expect(decision).toEqual({ kind: 'allow-once' })
    expect(seen()?.lineage).toEqual({
      sessionId: 'sub-1',
      agentType: 'explore',
      parentTurnId: 'turn-3',
    })
  })

  it('subagent sessions without agentType still carry sessionId（徽标降级为「子代理」）', async () => {
    const state = createSession({
      id: 'sub-2',
      cwd: '/tmp/u4',
      toolRegistrySnapshot: 'snapshot',
      maxTokens: 100_000,
      lineage: { depth: 1, parentSessionId: 'root-1' },
    })
    const { prompt, seen } = capturePrompt()
    const chain = createProductionToolPermissionChain({
      state,
      events: new EventBus(),
      permissionSnapshot: askSnapshot,
      interactivePermissionPrompt: () => prompt,
    })
    await chain.permissionRequests.request(bashRequest({ id: state.id, cwd: state.cwd }))
    expect(seen()?.lineage).toEqual({ sessionId: 'sub-2' })
  })

  it('main sessions（depth 0）omit lineage——主代理请求无徽标', async () => {
    const state = createSession({
      id: 'root-1',
      cwd: '/tmp/u4',
      toolRegistrySnapshot: 'snapshot',
      maxTokens: 100_000,
    })
    const { prompt, seen } = capturePrompt()
    const chain = createProductionToolPermissionChain({
      state,
      events: new EventBus(),
      permissionSnapshot: askSnapshot,
      interactivePermissionPrompt: () => prompt,
    })
    await chain.permissionRequests.request(bashRequest({ id: state.id, cwd: state.cwd }))
    const request = seen()
    expect(request).toBeDefined()
    expect(request && 'lineage' in request).toBe(false)
  })
})
