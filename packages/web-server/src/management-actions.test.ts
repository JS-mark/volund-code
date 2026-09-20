import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createMemoryPanelController,
  createMemoryStack,
  projectMemoryScope,
} from '@volund/app-runtime'
import type { McpAddInput } from '@volund/app-runtime'
import { afterEach, describe, expect, it } from 'vitest'

import { createWebServer } from './index'
import type { WebServerHandle } from './index'

let handle: WebServerHandle | undefined
const dirs: string[] = []
afterEach(async () => {
  await handle?.close()
  handle = undefined
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function authed(base: string) {
  const res = await fetch(`${base}api/v1/bootstrap`)
  expect(res.status).toBe(200)
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0]!
  const body = (await res.json()) as { data: { session: { csrfToken: string } } }
  return {
    headers: {
      Cookie: cookie,
      Origin: new URL(base).origin,
      'X-Volund-Csrf': body.data.session.csrfToken,
      'Content-Type': 'application/json',
    },
  }
}

async function post(
  base: string,
  headers: Record<string, string>,
  domain: string,
  body: Record<string, unknown>,
) {
  const res = await fetch(`${base}api/v1/${domain}/actions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  return {
    status: res.status,
    body: (await res.json()) as { data?: unknown; error?: { code: string; message: string } },
  }
}

function makePorts(home: string) {
  const stack = createMemoryStack(home)
  const memory = createMemoryPanelController(
    stack.memory,
    stack.memoryRecall,
    projectMemoryScope(home),
    stack.memoryTransfer,
  )
  const addedServers: McpAddInput[] = []
  const removed: string[] = []
  const approved: Array<{ name: string; hash: string }> = []
  const entries = [
    {
      name: 'demo-skill',
      description: 'demo',
      scope: 'user' as const,
      status: 'available',
      path: '/x',
    },
  ]
  return {
    memory,
    stack,
    skill: {
      list: async () => entries,
      show: async (name: string) => `---\nname: ${name}\ndescription: demo\n---\n# Body`,
      setEnabled: async () => 'ok',
      install: async () => ({ items: entries }),
      uninstall: async () => ({ ok: true }),
      reload: async () => entries,
      marketList: async () => ({
        source: 'https://market.test/skills.json',
        isDefault: false,
        entries: [{ name: 'demo-skill', source: 'github:acme/demo' }],
      }),
    },
    mcp: {
      list: async () => [{ name: 'added', transport: 'stdio', scope: 'user', status: 'disabled' }],
      inspect: async () => ({ entry: { name: 'added', status: 'disabled' }, tools: [] }),
      setEnabled: async () => 'ok',
      add: async (input: McpAddInput) => {
        addedServers.push(input)
        return { file: '/tmp/mcp.toml', items: [] }
      },
      remove: async (name: string) => {
        removed.push(name)
        return { file: '/tmp/mcp.toml', items: [] }
      },
      reload: async () => [],
      marketList: async () => undefined,
    },
    spy: { addedServers, removed, approved },
    plugins: {
      builtinDomains: async () => [],
      setBuiltinDomain: async () => {},
      availability: async () => ({
        available: false as const,
        code: 'x',
        detail: 'd',
        reopenCondition: 'r',
      }),
      inventory: async () => ({
        builtin: [],
        dev: [],
        market: { installed: [], registry: { error: 'no market' } },
      }),
      installMarketPlugin: async (name: string) => ({
        name,
        version: '1.0.0',
        dir: `/tmp/${name}`,
        approvalRequired: true,
      }),
      inspectPlugin: async (name: string) => ({
        name,
        version: '1.0.0',
        dir: '/tmp',
        source: 'market' as const,
        commands: 0,
        statusTabs: 0,
        lifecycle: {
          permissionHash: 'a'.repeat(64),
          approved: false,
          enabled: false,
          loaded: false,
        },
      }),
      approvePlugin: async (name: string, permissionHash: string) => {
        approved.push({ name, hash: permissionHash })
        return {
          name,
          version: '1.0.0',
          dir: '/tmp',
          source: 'market' as const,
          commands: 0,
          statusTabs: 0,
        }
      },
      enablePlugin: async (name: string) => ({
        name,
        version: '1.0.0',
        dir: '/tmp',
        source: 'market' as const,
        commands: 0,
        statusTabs: 0,
      }),
      disablePlugin: async (name: string) => ({
        name,
        version: '1.0.0',
        dir: '/tmp',
        source: 'market' as const,
        commands: 0,
        statusTabs: 0,
      }),
      uninstallMarketPlugin: async (name: string) => ({ name }),
    },
  }
}

describe('management actions e2e (WEB-EXT-MANAGE-MARKET-r1 §S3)', () => {
  it('memory create/update/export/import roundtrip over HTTP', async () => {
    const home = await mkdtemp(join(tmpdir(), 'web-mgmt-e2e-'))
    dirs.push(home)
    const stack = createMemoryStack(home)
    handle = await createWebServer({
      host: '127.0.0.1',
      port: 0,
      ports: {
        identity: { version: '0.0.0-test' },
        cwd: home,
        session: { list: async () => [] },
      },
      management: {
        memory: createMemoryPanelController(
          stack.memory,
          stack.memoryRecall,
          projectMemoryScope(home),
          stack.memoryTransfer,
        ),
      },
    })
    const base = `http://127.0.0.1:${handle.port}/`
    const { headers } = await authed(base)

    const created = await post(base, headers, 'memory', {
      action: 'create',
      content: '# md',
      tags: ['t1'],
    })
    expect(created.status).toBe(200)
    const record = (created.body.data ?? {}) as {
      id: string
      updatedAt: string
      source: string
      actor?: string
    }
    expect(record.source).toBe('user')
    expect(record.actor).toBe('web')

    const listed = (await post(base, headers, 'memory', { action: 'list', limit: 10 })).body
    expect(JSON.stringify(listed)).toContain('# md')

    const updated = await post(base, headers, 'memory', {
      action: 'update',
      id: record.id,
      content: 'updated',
      tags: [],
      expectedUpdatedAt: record.updatedAt,
    })
    expect(JSON.stringify(updated.body)).toContain('updated')

    const conflict = await post(base, headers, 'memory', {
      action: 'update',
      id: record.id,
      content: 'racer',
      tags: [],
      expectedUpdatedAt: record.updatedAt,
    })
    expect(conflict.body.error?.code).toBe('memory_conflict')

    const exported = await post(base, headers, 'memory', { action: 'export' })
    const document = exported.body.data as { schemaVersion: string; records: unknown[] }
    expect(document.schemaVersion).toBe('volund.memory.export.v1')
    expect(document.records).toHaveLength(1)

    const dry = await post(base, headers, 'memory', {
      action: 'import',
      serialized: JSON.stringify(document),
      strategy: 'overwrite',
      dryRun: true,
    })
    expect((dry.body.data as { dryRun: boolean; total: number }).dryRun).toBe(true)
  })

  it('mcp add dispatches parsed McpAddInput; skill install/show; plugins lifecycle over HTTP', async () => {
    const home = await mkdtemp(join(tmpdir(), 'web-mgmt-e2e-'))
    dirs.push(home)
    const ports = makePorts(home)
    handle = await createWebServer({
      host: '127.0.0.1',
      port: 0,
      ports: {
        identity: { version: '0.0.0-test' },
        cwd: home,
        session: { list: async () => [] },
      },
      management: {
        memory: ports.memory,
        skill: ports.skill,
        mcp: ports.mcp,
        plugins: ports.plugins,
      },
    })
    const base = `http://127.0.0.1:${handle.port}/`
    const { headers } = await authed(base)

    const added = await post(base, headers, 'mcp', {
      action: 'add',
      name: 'files',
      transport: 'sse',
      url: 'https://x/sse',
      scope: 'project',
    })
    expect(added.status).toBe(200)
    expect(ports.spy.addedServers[0]).toEqual({
      name: 'files',
      scope: 'project',
      transport: { kind: 'http', url: 'https://x/sse', headers: {}, legacySse: true },
    })

    const badAdd = await post(base, headers, 'mcp', {
      action: 'add',
      name: 'x',
      transport: 'stdio',
    })
    expect(badAdd.body.error?.code).toBe('web_schema_invalid')

    const skills = await post(base, headers, 'skills', { action: 'list' })
    expect(JSON.stringify(skills.body)).toContain('demo-skill')
    const shown = await post(base, headers, 'skills', { action: 'show', name: 'demo-skill' })
    expect(JSON.stringify(shown.body)).toContain('# Body')
    const market = await post(base, headers, 'skills', { action: 'marketList' })
    expect(JSON.stringify(market.body)).toContain('github:acme/demo')

    const inventory = await post(base, headers, 'plugins', { action: 'inventory' })
    expect(JSON.stringify(inventory.body)).toContain('no market')
    const inspected = await post(base, headers, 'plugins', { action: 'inspect', name: 'demo' })
    expect(
      (inspected.body.data as { lifecycle: { permissionHash: string } }).lifecycle.permissionHash,
    ).toBe('a'.repeat(64))
    const approved = await post(base, headers, 'plugins', {
      action: 'approve',
      name: 'demo',
      permissionHash: 'a'.repeat(64),
    })
    expect(approved.status).toBe(200)
    expect(ports.spy.approved).toEqual([{ name: 'demo', hash: 'a'.repeat(64) }])
  })
})
