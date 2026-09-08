/**
 * §22 W-01 嵌入式 Web 控制台：startEmbedded 挂 TUI 活动会话、共享审批队列、
 * start/resume 拒绝（web_state_conflict）、健康检查可达。
 */
import { PermissionPromptController } from '@volund/app-runtime'
import { afterEach, describe, expect, it } from 'vitest'

import type { VolundPorts } from './ports'
import { createWebPort } from './web'

let close: (() => Promise<void>) | undefined
afterEach(async () => {
  await close?.()
  close = undefined
})

function fakeInteractive(id: string) {
  const listeners = new Set<(event: unknown) => void>()
  return {
    id,
    cwd: '/tmp/web-embedded-test',
    events: {
      subscribe(listener: (event: unknown) => void) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      emit(event: unknown) {
        for (const listener of listeners) listener(event)
      },
    },
    transcript: [],
    async submit() {},
    async end() {},
  }
}

function fakePorts() {
  const active = fakeInteractive('sess-embedded-1')
  const permissionPrompts = new PermissionPromptController()
  const ports = {
    identity: { version: '0.0.0-test', name: 'volund-test' },
    version: '0.0.0-test',
    session: {
      getActive: () => active,
      onActivate: () => () => {},
      async startInteractive() {
        return active
      },
      async resumeInteractive() {
        return active
      },
      async interrupt() {},
      async end() {},
    },
    permissionPrompts,
    config: {
      async listMerged() {
        return { config: {}, warnings: [] }
      },
      async status() {
        return { status: [{ label: 'Model', value: 'anthropic/test-model' }] }
      },
    },
    permissionMode: {
      current: () => 'ask' as const,
      set() {},
    },
  }
  return { ports: ports as unknown as VolundPorts, active, permissionPrompts }
}

describe('web startEmbedded（§22 W-01）', () => {
  it('静默启动并挂载 TUI 活动会话；start/resume 被拒；审批经共享队列闭环', async () => {
    const { ports, permissionPrompts } = fakePorts()
    const web = createWebPort(ports)
    const handle = await web.startEmbedded?.({ cwd: '/tmp/web-embedded-test' })
    expect(handle).toBeDefined()
    close = handle!.close

    const { hostname, port } = new URL(handle!.url)
    const base = `http://${hostname}:${port}`
    // 健康检查公开
    const health = await fetch(`${base}/api/v1/health`)
    expect(health.status).toBe(200)

    // bootstrap 自动签发 browser session（进入无 token 门，地址无凭据 fragment）
    expect(new URL(handle!.url).hash).toBe('')
    const boot = await fetch(`${base}/api/v1/bootstrap`)
    expect(boot.status).toBe(200)
    const cookie = (boot.headers.get('set-cookie') ?? '').split(';')[0]!
    const bootBody = (await boot.json()) as {
      data: { session: { csrfToken: string }; capabilities: Record<string, unknown> }
    }
    const { csrfToken } = bootBody.data.session
    const auth = { Cookie: cookie, Origin: base, 'X-Volund-Csrf': csrfToken }

    // bootstrap 声明嵌入式能力
    expect(bootBody.data.capabilities.embedded).toBe(true)
    expect(bootBody.data.capabilities.models).toBe(true)

    // 活动会话 = TUI 会话（挂载，不自建）
    const activeBody = (await (
      await fetch(`${base}/api/v1/sessions/active`, { headers: auth })
    ).json()) as { data: { active: { id: string } | null } }
    expect(activeBody.data.active?.id).toBe('sess-embedded-1')

    // 嵌入模式 start/resume 放行（经 controller 激活；TUI 经 onActivate 跟随）
    const started = await fetch(`${base}/api/v1/sessions`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: '/tmp' }),
    })
    expect(started.status).toBe(200)

    // 共享审批队列：请求 → pendingIds → decide 闭环
    const pending = permissionPrompts.request({
      id: 'perm-emb-1',
      attempt: 1,
      display: { approvable: true, spec: 'bash', toolName: 'Bash' },
      input: {},
      spec: {},
      toolName: 'Bash',
    } as never)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const activeBody2 = (await (
      await fetch(`${base}/api/v1/sessions/active`, { headers: auth })
    ).json()) as { data: { pendingPermissions: string[] } }
    expect(activeBody2.data.pendingPermissions).toEqual(['perm-emb-1'])
    const decided = await fetch(`${base}/api/v1/permissions/decide`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: 'perm-emb-1', kind: 'allow-once' }),
    })
    expect(decided.status).toBe(200)
    await expect(pending).resolves.toEqual({ kind: 'allow-once' })
  })

  it('[web] enabled=false 时静默关闭（undefined）', async () => {
    const { ports } = fakePorts()
    ports.config = {
      async listMerged() {
        return { config: { web: { enabled: false } }, warnings: [] }
      },
      async status() {
        return { status: [] }
      },
    } as never
    const web = createWebPort(ports)
    await expect(web.startEmbedded?.({ cwd: '/tmp' })).resolves.toBeUndefined()
  })

  it('地址跨重启稳定：端口记忆；端口被占时回退随机；残留 launch token 被清理', async () => {
    const { mkdtemp, mkdir, writeFile, access } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const home = await mkdtemp(join(tmpdir(), 'volund-web-home-'))
    const prevHome = process.env.VOLUND_HOME
    process.env.VOLUND_HOME = home
    try {
      const { ports } = fakePorts()
      // 旧版本残留的 launch token 文件：启动时顺手清掉（进入已无 token 门）
      await mkdir(join(home, 'web'), { recursive: true })
      await writeFile(join(home, 'web', 'token'), 'stale-token')
      // 第一次启动：随机端口
      const first = await createWebPort(ports).startEmbedded?.({ cwd: '/tmp/web-embedded-test' })
      expect(first).toBeDefined()
      await expect(access(join(home, 'web', 'token'))).rejects.toThrow()
      // 关闭后重开：同端口（记忆）→ 同一地址（无 token，地址即裸 origin）
      await first!.close()
      const second = await createWebPort(ports).startEmbedded?.({ cwd: '/tmp/web-embedded-test' })
      expect(second!.url).toBe(first!.url)
      // 端口被占用时回退随机端口（地址仍无凭据 fragment）
      const third = await createWebPort(ports).startEmbedded?.({ cwd: '/tmp/web-embedded-test' })
      expect(third!.port).not.toBe(second!.port)
      expect(new URL(third!.url).hash).toBe('')
      await second!.close()
      await third!.close()
      close = undefined
    } finally {
      if (prevHome === undefined) delete process.env.VOLUND_HOME
      else process.env.VOLUND_HOME = prevHome
    }
  })
})
