import type { InteractivePermissionDecision, InteractiveSession } from '@volund/app-runtime'
import { afterEach, describe, expect, it } from 'vitest'

import { SessionHub } from './session-hub'

let cleanup: (() => Promise<void>) | undefined
afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
})

interface FakeSession extends InteractiveSession<unknown> {
  emit(event: unknown): void
  askPermission(request: {
    id: string
    attempt: number
    display: { approvable: boolean; spec: string; toolName: string }
  }): Promise<InteractivePermissionDecision>
}

/** 可控的假会话：事件总线 + 权限请求挂起由测试驱动。 */
function fakeSession(
  overrides: {
    setPermissionPromptHandler?(handler: unknown): void
    end?(): Promise<void>
  } = {},
): FakeSession {
  const listeners = new Set<(event: unknown) => void>()
  let permissionHandler: ((request: never) => Promise<InteractivePermissionDecision>) | undefined
  const session = {
    id: 'sess-hub-1',
    cwd: '/tmp/hub',
    events: {
      subscribe(listener: (event: unknown) => void) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
    transcript: [{ id: 'm1', role: 'user', text: 'hello' }],
    setPermissionPromptHandler(handler: unknown) {
      permissionHandler = handler as never
      overrides.setPermissionPromptHandler?.(handler)
    },
    async submit() {},
    async end() {
      await overrides.end?.()
    },
    emit(event: unknown) {
      for (const listener of listeners) listener(event)
    },
    async askPermission(request: {
      id: string
      attempt: number
      display: { approvable: boolean; spec: string; toolName: string }
    }) {
      return permissionHandler!(request as never)
    },
  }
  return session as unknown as FakeSession
}

function hubWith(session: FakeSession): SessionHub {
  return new SessionHub({
    session: {
      async startInteractive() {
        return session
      },
      async interrupt() {},
      async end() {},
    },
  })
}

const permissionRequest = {
  id: 'perm-1',
  attempt: 1,
  display: { approvable: true, spec: 'bash', toolName: 'Bash' },
  input: {},
  spec: {},
  toolName: 'Bash',
} as never

describe('SessionHub', () => {
  it('forwards core events as envelopes with a monotonic cursor', async () => {
    const session = fakeSession()
    const hub = hubWith(session)
    const seen: string[] = []
    hub.subscribe((envelope) => seen.push(`${envelope.kind}:${envelope.cursor}`))
    await hub.start({ cwd: '/tmp/hub' })
    session.emit({ type: 'turn.started', payload: {} })
    session.emit({ type: 'stream.delta', payload: {} })
    // start 发一条 view（session.attached），之后两条 core——cursor 单调递增。
    expect(seen).toEqual(['view:1', 'core:2', 'core:3'])
  })

  it('permission requests park until decide() resolves them', async () => {
    const session = fakeSession()
    const hub = hubWith(session)
    await hub.start({ cwd: '/tmp/hub' })
    const promise = session.askPermission(permissionRequest)
    expect(hub.pendingPermissionIds()).toEqual(['perm-1'])
    expect(hub.decide('perm-1', 'allow-once')).toBe(true)
    expect(hub.decide('perm-1', 'allow-once')).toBe(false)
    await expect(promise).resolves.toEqual({ kind: 'allow-once' })
  })

  it('close denies pending permissions and detaches the handler', async () => {
    const detachments: unknown[] = []
    const session = fakeSession({
      setPermissionPromptHandler(handler) {
        if (handler === undefined) detachments.push(handler)
      },
      async end() {
        cleanup = async () => {}
      },
    })
    const hub = hubWith(session)
    await hub.start({ cwd: '/tmp/hub' })
    const promise = session.askPermission(permissionRequest)
    await hub.closeActive()
    await expect(promise).resolves.toEqual({ kind: 'deny' })
    expect(detachments).toHaveLength(1)
    expect(hub.active).toBeUndefined()
  })
})
