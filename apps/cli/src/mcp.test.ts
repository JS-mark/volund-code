import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import type { McpTransport } from '@apollo-code/mcp-client'
import { ToolRegistry } from '@apollo-code/tool-kit'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  expandMcpEnv,
  loadMcpServerConfigs,
  McpManager,
  parseMcpServerEntries,
  removeMcpServerToml,
  resolveSkillSpecToDirectories,
  upsertMcpServerToml,
  type McpServerConfig,
} from './mcp'

const dirs: string[] = []
afterEach(async () =>
  Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))),
)

class FakeTransport implements McpTransport {
  sent: unknown[] = []
  onMessage?: (message: unknown) => void
  closed = false
  constructor(readonly behavior: 'ok' | 'unauthorized' | 'crash' = 'ok') {}
  async start(onMessage: (message: unknown) => void) {
    this.onMessage = onMessage
    if (this.behavior === 'crash') throw new Error('spawn failed ENOENT')
  }
  async send(message: unknown) {
    this.sent.push(message)
    const request = message as { id?: number; method?: string }
    if (this.behavior === 'unauthorized' && request.id && request.method === 'initialize') {
      throw new Error('MCP HTTP request failed: HTTP 401')
    }
    if (request.id && request.method === 'initialize')
      queueMicrotask(() =>
        this.onMessage?.({
          jsonrpc: '2.0',
          id: request.id,
          result: { protocolVersion: '2025-03-26' },
        }),
      )
    if (request.id && request.method === 'tools/list')
      queueMicrotask(() =>
        this.onMessage?.({
          jsonrpc: '2.0',
          id: request.id,
          result: {
            tools: [
              { name: 'read', description: 'reads things', inputSchema: { type: 'object' } },
              { name: 'search:query', description: 'searches' },
            ],
          },
        }),
      )
  }
  async close() {
    this.closed = true
  }
}

function stdioServer(name: string, scope: 'user' | 'project' = 'user'): McpServerConfig {
  return {
    name,
    scope,
    source: 'test',
    transport: { kind: 'stdio', command: 'fake', args: [], env: {} },
  }
}

describe('expandMcpEnv', () => {
  it('expands ${VAR} and ${VAR:-default}; unset without default becomes empty and warns', () => {
    const unresolved: string[] = []
    const env = { SET: 'yes', EMPTY: '' }
    expect(expandMcpEnv('${SET}', env)).toBe('yes')
    expect(expandMcpEnv('${MISSING:-fallback}', env)).toBe('fallback')
    expect(expandMcpEnv('${EMPTY:-fallback}', env)).toBe('')
    expect(expandMcpEnv('prefix ${MISSING} suffix', env, (name) => unresolved.push(name))).toBe(
      'prefix  suffix',
    )
    expect(unresolved).toEqual(['MISSING'])
  })
})

describe('parseMcpServerEntries', () => {
  it('normalizes stdio and http entries and warns on invalid shapes', () => {
    const warnings: string[] = []
    const entries = parseMcpServerEntries(
      {
        std: { command: 'npx', args: ['-y', 'pkg'], env: { TOKEN: 'abc' } },
        remote: { type: 'http', url: 'https://api.example.com/mcp' },
        legacy: { type: 'sse', url: 'https://old.example.com/sse', headers: { 'X-A': 'b' } },
        bad: { type: 'ws', url: 'https://ws.example.com' },
        neither: {},
      },
      { scope: 'project', source: 'x.toml', onWarning: (message) => warnings.push(message) },
    )
    expect(entries.map((entry) => entry.name)).toEqual(['std', 'remote', 'legacy'])
    expect(entries[0]!.transport).toEqual({
      kind: 'stdio',
      command: 'npx',
      args: ['-y', 'pkg'],
      env: { TOKEN: 'abc' },
    })
    expect(entries[1]!.transport).toEqual({
      kind: 'http',
      url: 'https://api.example.com/mcp',
      headers: {},
      legacySse: false,
    })
    expect(entries[2]!.transport).toEqual(
      expect.objectContaining({ kind: 'http', legacySse: true, headers: { 'X-A': 'b' } }),
    )
    expect(warnings).toEqual([
      expect.stringContaining("'ws'"),
      expect.stringContaining("needs 'command' (stdio) or 'url' (http)"),
    ])
  })
})

describe('loadMcpServerConfigs', () => {
  it('merges project mcp.toml, interop .mcp.json and user mcp.toml by priority', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'apollo-mcp-'))
    dirs.push(root)
    const home = join(root, 'home')
    const project = join(root, 'project')
    await mkdir(join(home), { recursive: true })
    await mkdir(join(project, '.apollo'), { recursive: true })
    await writeFile(
      join(home, 'mcp.toml'),
      [
        '[mcp_servers.shared]',
        'command = "user-cmd"',
        '[mcp_servers.useronly]',
        'command = "u"',
        '',
      ].join('\n'),
    )
    await writeFile(
      join(project, '.apollo', 'mcp.toml'),
      ['[mcp_servers.shared]', 'command = "project-cmd"', ''].join('\n'),
    )
    await writeFile(
      join(project, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          shared: { command: 'json-cmd' },
          interop: { type: 'http', url: 'https://interop.example.com/mcp' },
        },
      }),
    )
    const configs = await loadMcpServerConfigs({ apolloHome: home, cwd: project })
    expect(configs.map((config) => `${config.name}:${config.scope}`)).toEqual([
      'interop:project',
      'shared:project',
      'useronly:user',
    ])
    // 同名：project .apollo/mcp.toml > project .mcp.json > user mcp.toml
    const shared = configs.find((config) => config.name === 'shared')!
    expect(shared.transport).toEqual(
      expect.objectContaining({ kind: 'stdio', command: 'project-cmd' }),
    )
    const interop = configs.find((config) => config.name === 'interop')!
    expect(interop.transport).toEqual(
      expect.objectContaining({ kind: 'http', url: 'https://interop.example.com/mcp' }),
    )
  })
  it('expands env vars in command/args/env/url and expands env sections in TOML', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'apollo-mcp-'))
    dirs.push(root)
    const home = join(root, 'home')
    await mkdir(home, { recursive: true })
    process.env.APOLLO_TEST_MCP_CMD = 'resolved-cmd'
    process.env.APOLLO_TEST_MCP_URL = 'https://env.example.com'
    await writeFile(
      join(home, 'mcp.toml'),
      [
        '[mcp_servers.envdriven]',
        'command = "${APOLLO_TEST_MCP_CMD}"',
        'args = ["--flag", "${APOLLO_TEST_MCP_CMD}"]',
        '[mcp_servers.envdriven.env]',
        'TOKEN = "${APOLLO_TEST_MCP_URL:-none}"',
        '[mcp_servers.urlserver]',
        'url = "${APOLLO_TEST_MCP_URL}/mcp"',
        '',
      ].join('\n'),
    )
    const configs = await loadMcpServerConfigs({ apolloHome: home, cwd: root })
    const driven = configs.find((config) => config.name === 'envdriven')!
    expect(driven.transport).toEqual({
      kind: 'stdio',
      command: 'resolved-cmd',
      args: ['--flag', 'resolved-cmd'],
      env: { TOKEN: 'https://env.example.com' },
    })
    const urlServer = configs.find((config) => config.name === 'urlserver')!
    expect(urlServer.transport).toEqual(
      expect.objectContaining({ kind: 'http', url: 'https://env.example.com/mcp' }),
    )
    delete process.env.APOLLO_TEST_MCP_CMD
    delete process.env.APOLLO_TEST_MCP_URL
  })
})

describe('McpManager', () => {
  it('connects, registers mcp__ tools into attached registries, and reports snapshots', async () => {
    const transports: FakeTransport[] = []
    const manager = new McpManager({
      servers: [stdioServer('demo')],
      disabled: new Set(),
      transportFactory: () => {
        const transport = new FakeTransport('ok')
        transports.push(transport)
        return transport
      },
    })
    const registry = new ToolRegistry()
    manager.attach(registry) // attach 先于连接完成
    await manager.connect()
    expect(manager.snapshot()).toEqual([
      expect.objectContaining({
        name: 'demo',
        status: 'connected',
        tools: 2,
        protocolVersion: '2025-03-26',
      }),
    ])
    const read = registry.get('mcp__demo__read')
    expect(read).toBeDefined()
    // 非法字符替换：tool 名含 ':' → '_'
    expect(registry.get('mcp__demo__search_query')).toBeDefined()
    expect(read!.permissionSpec({} as never)).toEqual({
      custom: { mcpServer: 'demo', mcpTool: 'read' },
    })
    await manager.close()
    expect(transports[0]!.closed).toBe(true)
    expect(registry.get('mcp__demo__read')).toBeUndefined()
  })
  it('classifies 401 as needs-auth and other failures as failed', async () => {
    const manager = new McpManager({
      servers: [stdioServer('auth'), stdioServer('dead')],
      disabled: new Set(),
      transportFactory: (config) =>
        new FakeTransport(config.name === 'auth' ? 'unauthorized' : 'crash'),
    })
    await manager.connect()
    const snapshot = manager.snapshot()
    expect(snapshot.find((entry) => entry.name === 'auth')).toEqual(
      expect.objectContaining({ status: 'needs-auth' }),
    )
    expect(snapshot.find((entry) => entry.name === 'dead')).toEqual(
      expect.objectContaining({ status: 'failed', detail: expect.stringContaining('ENOENT') }),
    )
  })
  it('keeps disabled servers disconnected and enable/disable drives live connections', async () => {
    const manager = new McpManager({
      servers: [stdioServer('off'), stdioServer('on')],
      disabled: new Set(['off']),
      transportFactory: () => new FakeTransport('ok'),
    })
    await manager.connect()
    const offEntry = manager.snapshot().find((entry) => entry.name === 'off')!
    expect(offEntry).toEqual(expect.objectContaining({ status: 'disabled' }))
    expect(offEntry).not.toHaveProperty('tools')
    await manager.setEnabled('off', true)
    expect(manager.snapshot().find((entry) => entry.name === 'off')).toEqual(
      expect.objectContaining({ status: 'connected', tools: 2 }),
    )
    await manager.setEnabled('on', false)
    expect(manager.snapshot().find((entry) => entry.name === 'on')).toEqual(
      expect.objectContaining({ status: 'disabled' }),
    )
    await manager.close()
  })
  it('reload reconnects everything and warns through onWarning on failures', async () => {
    const warnings: string[] = []
    const factory = vi.fn(() => new FakeTransport('ok'))
    const manager = new McpManager({
      servers: [stdioServer('demo')],
      disabled: new Set(),
      onWarning: (message) => warnings.push(message),
      transportFactory: factory,
    })
    await manager.connect()
    await manager.reload()
    expect(factory).toHaveBeenCalledTimes(2)
    expect(manager.snapshot()[0]).toEqual(expect.objectContaining({ status: 'connected' }))
    expect(warnings).toEqual([])
    await manager.close()
  })
  it('inspect returns entry plus tool summaries', async () => {
    const manager = new McpManager({
      servers: [stdioServer('demo')],
      disabled: new Set(),
      transportFactory: () => new FakeTransport('ok'),
    })
    await manager.connect()
    const { entry, tools } = await manager.inspect('demo')
    expect(entry.status).toBe('connected')
    expect(tools.map((tool) => tool.name)).toEqual(['read', 'search:query'])
    await expect(manager.inspect('missing')).rejects.toThrow('Unknown MCP server')
    await manager.close()
  })
})

describe('McpManager diagnostics log (§S3.6)', () => {
  it('writes JSONL lifecycle events and server stderr lines to logPath', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'apollo-mcp-'))
    dirs.push(root)
    const logPath = join(root, 'mcp.log')
    const stderrLines: string[] = []
    const stderrTransport = new FakeTransport('ok')
    stderrTransport.start = async (onMessage) => {
      stderrTransport.onMessage = onMessage
      stderrLines.push('booting')
      stderrLines.push('ready')
    }
    const manager = new McpManager({
      servers: [stdioServer('demo')],
      disabled: new Set(),
      logPath,
      transportFactory: () => stderrTransport,
    })
    await manager.connect()
    await manager.logsFlushed()
    await manager.close()
    await manager.logsFlushed()
    const lines = (await readFile(logPath, 'utf8')).split('\n').filter(Boolean)
    const events = lines.map((line) => JSON.parse(line).event)
    expect(events).toContain('manager.init')
    expect(events).toContain('connect.start')
    expect(events).toContain('connect.ok')
    expect(events).toContain('disconnect')
    const ok = lines.map((line) => JSON.parse(line)).find((entry) => entry.event === 'connect.ok')
    expect(ok).toEqual(expect.objectContaining({ server: 'demo', tools: 2 }))
  })
  it('logs failures and needs-auth as structured events', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'apollo-mcp-'))
    dirs.push(root)
    const logPath = join(root, 'mcp.log')
    const manager = new McpManager({
      servers: [stdioServer('auth'), stdioServer('dead')],
      disabled: new Set(),
      logPath,
      transportFactory: (config) =>
        new FakeTransport(config.name === 'auth' ? 'unauthorized' : 'crash'),
    })
    await manager.connect()
    await manager.logsFlushed()
    await manager.close()
    await manager.logsFlushed()
    const events = (await readFile(logPath, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line).event)
    expect(events).toContain('connect.needs-auth')
    expect(events).toContain('connect.failed')
  })
})

describe('mcp.toml write path (§S3.7 apollo mcp add/remove)', () => {
  it('upserts stdio and http servers, round-trips through loadMcpServerConfigs, and removes them', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'apollo-mcp-'))
    dirs.push(root)
    const home = join(root, 'home')
    const file = join(home, 'mcp.toml')
    await upsertMcpServerToml({
      file,
      name: 'demo',
      transport: { kind: 'stdio', command: 'npx', args: ['-y', 'pkg'], env: { TOKEN: 'abc' } },
    })
    await upsertMcpServerToml({
      file,
      name: 'remote',
      transport: {
        kind: 'http',
        url: 'https://api.example.com/mcp',
        headers: { Authorization: 'Bearer x' },
        legacySse: true,
      },
    })
    let configs = await loadMcpServerConfigs({ apolloHome: home, cwd: root })
    expect(configs.map((config) => config.name)).toEqual(['demo', 'remote'])
    expect(configs[0]!.transport).toEqual({
      kind: 'stdio',
      command: 'npx',
      args: ['-y', 'pkg'],
      env: { TOKEN: 'abc' },
    })
    expect(configs[1]!.transport).toEqual({
      kind: 'http',
      url: 'https://api.example.com/mcp',
      headers: { Authorization: 'Bearer x' },
      legacySse: true,
    })
    // 同名 upsert = 整条覆盖
    await upsertMcpServerToml({
      file,
      name: 'demo',
      transport: { kind: 'stdio', command: 'node', args: ['server.js'], env: {} },
    })
    configs = await loadMcpServerConfigs({ apolloHome: home, cwd: root })
    expect(configs.find((config) => config.name === 'demo')!.transport).toEqual(
      expect.objectContaining({ command: 'node' }),
    )
    expect(await removeMcpServerToml({ file, name: 'demo' })).toBe(true)
    expect(await removeMcpServerToml({ file, name: 'demo' })).toBe(false)
    configs = await loadMcpServerConfigs({ apolloHome: home, cwd: root })
    expect(configs.map((config) => config.name)).toEqual(['remote'])
  })
  it('resolveSkillSpecToDirectories passes local paths through untouched', async () => {
    const { directories, cleanup } = await resolveSkillSpecToDirectories('/some/local/dir')
    expect(directories).toEqual(['/some/local/dir'])
    await cleanup()
  })
})

describe('resolveSkillSpecToDirectories nested git repos (SKILLS-MCPS-r1.8)', () => {
  it('installs every SKILL.md in a nested repo structure (plugins/<name>/skills/…)', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'apollo-skill-repo-'))
    dirs.push(root)
    const repo = join(root, 'repo')
    // 复刻 anthropics/claude-plugins-official:plugins/skill-creator/skills/skill-creator
    await mkdir(join(repo, 'plugins', 'skill-creator', 'skills', 'skill-creator'), { recursive: true })
    await writeFile(
      join(repo, 'plugins', 'skill-creator', 'skills', 'skill-creator', 'SKILL.md'),
      '---\nname: skill-creator\ndescription: Create skills\n---\nBody.',
    )
    await mkdir(join(repo, 'plugins', 'other', 'skills', 'pdf-tools'), { recursive: true })
    await writeFile(
      join(repo, 'plugins', 'other', 'skills', 'pdf-tools', 'SKILL.md'),
      '---\nname: pdf-tools\ndescription: PDF\n---\nBody.',
    )
    await execFileAsync('git', ['init', '-q'], { cwd: repo })
    await execFileAsync('git', ['add', '-A'], { cwd: repo })
    await execFileAsync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: repo })
    const { directories, cleanup } = await resolveSkillSpecToDirectories(`file://${repo}`)
    await cleanup()
    const names = directories.map((dir) => dir.split('/').pop()).toSorted((a, b) => a!.localeCompare(b!))
    expect(names).toEqual(['pdf-tools', 'skill-creator'])
  })
})
