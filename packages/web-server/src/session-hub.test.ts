import type { InteractiveSession } from '@volund/app-runtime'
import { PermissionPromptController } from '@volund/app-runtime'
import { afterEach, describe, expect, it } from 'vitest'

import { SessionHub } from './session-hub'

let cleanup: (() => Promise<void>) | undefined
afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
})

interface FakeSession extends InteractiveSession<unknown> {
  emit(event: unknown): void
}

/** 可控的假会话：事件总线由测试驱动；权限走共享 PermissionPromptController。 */
function fakeSession(
  overrides: {
    end?(): Promise<void>
  } = {},
): FakeSession {
  const listeners = new Set<(event: unknown) => void>()
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
    async submit() {},
    async end() {
      await overrides.end?.()
    },
    emit(event: unknown) {
      for (const listener of listeners) listener(event)
    },
  }
  return session as unknown as FakeSession
}

function hubWith(
  session: FakeSession,
  options: { embedded?: boolean; permissions?: PermissionPromptController } = {},
): { hub: SessionHub; permissions: PermissionPromptController } {
  const permissions = options.permissions ?? new PermissionPromptController()
  const hub = new SessionHub(
    {
      permissions,
      session: {
        async startInteractive() {
          return session
        },
        async resumeInteractive() {
          return session
        },
        getActive: () => session,
        onActivate: () => () => {},
        async interrupt() {},
        async end() {},
      },
    },
    options.embedded !== undefined ? { embedded: options.embedded } : {},
  )
  return { hub, permissions }
}

const permissionRequest = {
  id: 'perm-1',
  attempt: 1,
  display: { approvable: true, spec: 'bash', toolName: 'Bash' },
  input: {},
  spec: {},
  toolName: 'Bash',
}

describe('SessionHub', () => {
  it('forwards core events as envelopes with a monotonic cursor', async () => {
    const session = fakeSession()
    const { hub } = hubWith(session)
    const seen: string[] = []
    hub.subscribe((envelope) => seen.push(`${envelope.kind}:${envelope.cursor}`))
    await hub.start({ cwd: '/tmp/hub' })
    session.emit({ type: 'turn.started', payload: {} })
    session.emit({ type: 'stream.delta', payload: {} })
    // start 发一条 view（session.attached），之后两条 core——cursor 单调递增。
    expect(seen).toEqual(['view:1', 'core:2', 'core:3'])
  })

  it('permission requests come from the shared queue; decide resolves them', async () => {
    const session = fakeSession()
    const { hub, permissions } = hubWith(session)
    await hub.start({ cwd: '/tmp/hub' })
    const seen: unknown[] = []
    hub.subscribe((envelope) => seen.push(envelope.event))
    // 共享队列进请求 → SSE 推卡
    const pending = permissions.request(permissionRequest)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(hub.pendingPermissionIds()).toEqual(['perm-1'])
    expect(seen).toContainEqual({
      type: 'permission.request',
      request: { id: 'perm-1', attempt: 1, display: permissionRequest.display },
    })
    // decide 解析 → 队列清空 → SSE 清卡
    expect(hub.decide('perm-1', 'allow-once')).toBe(true)
    expect(hub.decide('perm-1', 'allow-once')).toBe(false)
    await expect(pending).resolves.toEqual({ kind: 'allow-once' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(seen).toContainEqual({ type: 'permission.resolved' })
  })

  it('close on an owned session ends it; queued requests stay decidable by other surfaces', async () => {
    let ended = false
    const session = fakeSession({
      async end() {
        ended = true
        cleanup = async () => {}
      },
    })
    const { hub, permissions } = hubWith(session)
    await hub.start({ cwd: '/tmp/hub' })
    const pending = permissions.request(permissionRequest)
    await hub.closeActive()
    expect(ended).toBe(true)
    expect(hub.active).toBeUndefined()
    // 共享队列不被 hub 关闭连坐（TUI 仍可决策）
    permissions.decide('perm-1', { kind: 'deny' })
    await expect(pending).resolves.toEqual({ kind: 'deny' })
  })

  it('embedded mode allows start/resume（经 controller 激活，TUI 经 onActivate 跟随）but never owns the session', async () => {
    let ended = false
    const session = fakeSession({
      async end() {
        ended = true
      },
    })
    const { hub } = hubWith(session, { embedded: true })
    // 嵌入式 start/resume 放行：切换到 controller 激活的会话，hub 不拥有（owned=false）
    const started = await hub.start({ cwd: '/tmp/hub' })
    expect(started.id).toBe('sess-hub-1')
    expect(hub.active?.id).toBe('sess-hub-1')
    const resumed = await hub.resume('sess-x')
    expect(resumed.id).toBe('sess-hub-1')
    // closeActive 只摘挂不结束（会话归宿主进程）
    await hub.closeActive()
    expect(ended).toBe(false)
    expect(hub.active).toBeUndefined()
  })

  it('submit passes attachments through to the interactive session', async () => {
    const session = fakeSession()
    const submissions: { prompt: string; options: unknown }[] = []
    session.submit = async (prompt: string, options?: unknown) => {
      submissions.push({ prompt, options })
    }
    const { hub } = hubWith(session)
    await hub.start({ cwd: '/tmp/hub' })
    const attachments = [
      {
        kind: 'image' as const,
        mime: 'image/png',
        size: 4,
        handle: 'a'.repeat(64) + '.png',
        chip: '[image_1]',
      },
    ]
    await hub.submit({ prompt: '看图', attachments })
    expect(submissions).toEqual([{ prompt: '看图', options: { attachments } }])
  })

  it('stageAttachment delegates to the session and surfaces honest errors', async () => {
    const session = fakeSession()
    const { hub } = hubWith(session)
    // 无活动会话 → web_session_invalid
    await expect(hub.stageAttachment(new Uint8Array([1]), 'image/png')).rejects.toMatchObject({
      code: 'web_session_invalid',
    })
    await hub.start({ cwd: '/tmp/hub' })
    // 会话未实现 stageAttachment → web_capability_unavailable
    await expect(hub.stageAttachment(new Uint8Array([1]), 'image/png')).rejects.toMatchObject({
      code: 'web_capability_unavailable',
    })
    // 装配后：attached 直通；unavailable 映射 web_attachment_rejected
    session.stageAttachment = async () => ({
      kind: 'attached',
      attachment: { kind: 'image' as const, mime: 'image/png', size: 1, handle: 'h.png' },
    })
    await expect(hub.stageAttachment(new Uint8Array([1]), 'image/png')).resolves.toMatchObject({
      handle: 'h.png',
    })
    session.stageAttachment = async () => ({ kind: 'unavailable', reason: 'bad bytes' })
    await expect(hub.stageAttachment(new Uint8Array([1]), 'image/png')).rejects.toMatchObject({
      code: 'web_attachment_rejected',
    })
  })
})
