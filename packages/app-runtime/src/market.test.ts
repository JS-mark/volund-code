import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  fetchMcpMarketIndex,
  parseMcpMarketDocument,
  parseMcpMarketIndex,
  parseMcpRegistryDocument,
  readMcpMarketSource,
} from './mcp-market'
import { parseGithubTreeSpec } from './skill-install'
import {
  fetchSkillMarketIndex,
  parseClaudeSkillMarketplace,
  parseSkillMarketDocument,
  parseSkillMarketIndex,
  readSkillMarketSource,
} from './skill-market'

const dirs: string[] = []
afterEach(async () =>
  Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))),
)

async function tempHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'volund-market-'))
  dirs.push(home)
  return home
}

describe('skill market index (WEB-EXT-MANAGE-MARKET-r1 §S3.6)', () => {
  it('parses entries and rejects invalid names / oversized indexes', () => {
    const entries = parseSkillMarketIndex({
      version: 1,
      entries: [
        { name: 'pdf-tools', description: 'PDF', source: 'github:acme/pdf-tools' },
        { name: 'a', source: '/local/dir', version: '1.0.0', homepage: 'https://x' },
      ],
    })
    expect(entries).toHaveLength(2)
    expect(entries[0]).toEqual({
      name: 'pdf-tools',
      description: 'PDF',
      source: 'github:acme/pdf-tools',
    })
    expect(parseSkillMarketIndex({ version: 1, entries: [] })).toEqual([])

    expect(() => parseSkillMarketIndex({ version: 2, entries: [] })).toThrow('version')
    expect(() => parseSkillMarketIndex({ version: 1 })).toThrow('entries')
    expect(() =>
      parseSkillMarketIndex({ version: 1, entries: [{ name: 'Bad_Name', source: 'x' }] }),
    ).toThrow('invalid name')
    expect(() =>
      parseSkillMarketIndex({ version: 1, entries: [{ name: 'ok', source: '' }] }),
    ).toThrow('invalid source')
    const oversized = {
      version: 1,
      entries: Array.from({ length: 257 }, () => ({ name: 'a', source: 'b' })),
    }
    expect(() => parseSkillMarketIndex(oversized)).toThrow('too many')
  })

  it('reads [skills] market from user config.toml and rejects untrusted sources', async () => {
    const home = await tempHome()
    expect(await readSkillMarketSource(home)).toBeUndefined()
    await writeFile(
      join(home, 'config.toml'),
      '[skills]\nmarket = "https://market.example.com/skills.json"\n',
    )
    expect(await readSkillMarketSource(home)).toBe('https://market.example.com/skills.json')

    const bad = await tempHome()
    await writeFile(join(bad, 'config.toml'), '[skills]\nmarket = "http://192.168.1.10/x.json"\n')
    await expect(readSkillMarketSource(bad)).rejects.toThrow('config_invalid')
  })

  it('fetchSkillMarketIndex reports config errors instead of throwing', async () => {
    const home = await tempHome()
    await writeFile(home + '/config.toml', '[skills]\nmarket = "not a url"\n')
    const result = await fetchSkillMarketIndex(home)
    expect(result).toEqual({ error: expect.stringContaining('config_invalid') })
  })
})

describe('mcp market index (WEB-EXT-MANAGE-MARKET-r1 §S3.6)', () => {
  it('parses stdio/http entries and enforces per-kind required fields', () => {
    const entries = parseMcpMarketIndex({
      version: 1,
      entries: [
        {
          name: 'files',
          description: 'Filesystem access',
          transport: 'stdio',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem'],
          env: { RUST_LOG: 'info' },
        },
        { name: 'search', transport: 'http', url: 'https://mcp.example.com/sse' },
      ],
    })
    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({ name: 'files', transport: 'stdio', command: 'npx' })

    expect(() => parseMcpMarketIndex({ version: 1, entries: [] })).not.toThrow()
    expect(() =>
      parseMcpMarketIndex({ version: 1, entries: [{ name: 'x', transport: 'stdio' }] }),
    ).toThrow('requires command')
    expect(() =>
      parseMcpMarketIndex({ version: 1, entries: [{ name: 'x', transport: 'http' }] }),
    ).toThrow('requires url')
    expect(() =>
      parseMcpMarketIndex({ version: 1, entries: [{ name: '!bad', transport: 'http', url: 'u' }] }),
    ).toThrow('invalid name')
    expect(() =>
      parseMcpMarketIndex({
        version: 1,
        entries: [{ name: 'x', transport: 'grpc', url: 'u' }],
      }),
    ).toThrow('transport')
  })

  it('reads [mcp] market from user config.toml; loopback http allowed, LAN http rejected', async () => {
    const home = await tempHome()
    await writeFile(
      join(home, 'config.toml'),
      '[mcp]\nmarket = "http://127.0.0.1:8080/index.json"\n',
    )
    expect(await readMcpMarketSource(home)).toBe('http://127.0.0.1:8080/index.json')

    const bad = await tempHome()
    await writeFile(join(bad, 'config.toml'), '[mcp]\nmarket = "http://10.0.0.1/index.json"\n')
    await expect(readMcpMarketSource(bad)).rejects.toThrow('config_invalid')
  })

  it('fetchSkillMarketIndex twin: fetchMcpMarketIndex reports config errors instead of throwing', async () => {
    const home = await tempHome()
    await writeFile(home + '/config.toml', '[mcp]\nmarket = "nope"\n')
    const result = await fetchMcpMarketIndex(home)
    expect(result).toEqual({ error: expect.stringContaining('config_invalid') })
  })
})

describe('default market sources (WEB-EXT-MANAGE-MARKET-r1 r1.3)', () => {
  it('parseMcpRegistryDocument adapts official registry v0: remotes→http, npm→npx, pypi→uvx', () => {
    const entries = parseMcpRegistryDocument({
      servers: [
        {
          server: {
            name: 'acme/edge-mcp',
            title: 'Edge',
            description: 'Edge tools',
            version: '1.0.0',
            remotes: [{ type: 'streamable-http', url: 'https://edge.acme/mcp' }],
          },
          _meta: {
            'io.modelcontextprotocol.registry/official': { status: 'active', isLatest: true },
          },
        },
        {
          server: {
            name: 'agency.kesey/pretrip',
            description: 'Health marketing checks',
            packages: [
              {
                registryType: 'npm',
                identifier: 'pretrip-mcp',
                version: '1.0.1',
                transport: { type: 'stdio' },
              },
            ],
          },
          _meta: {
            'io.modelcontextprotocol.registry/official': { status: 'active' },
          },
        },
        {
          server: {
            name: 'lab/py-tool',
            packages: [
              { registryType: 'pypi', identifier: 'py-tool', transport: { type: 'stdio' } },
            ],
          },
          _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active' } },
        },
        {
          server: { name: 'dead/withdrawn', description: 'x' },
          _meta: { 'io.modelcontextprotocol.registry/official': { status: 'withdrawn' } },
        },
      ],
    })
    expect(entries).toHaveLength(3)
    expect(entries[0]).toEqual({
      name: 'Edge',
      description: 'Edge tools',
      transport: 'http',
      url: 'https://edge.acme/mcp',
    })
    expect(entries[1]).toMatchObject({
      name: 'agency.kesey-pretrip',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'pretrip-mcp'],
    })
    expect(entries[2]).toMatchObject({
      name: 'lab-py-tool',
      transport: 'stdio',
      command: 'uvx',
      args: ['py-tool'],
    })
  })

  it('parseClaudeSkillMarketplace expands plugins[].skills[] into per-skill tree URLs', () => {
    const entries = parseClaudeSkillMarketplace(
      {
        plugins: [
          {
            name: 'document-skills',
            description: 'Document processing suite',
            skills: ['./skills/xlsx', './skills/docx', 'invalid'],
          },
        ],
      },
      'https://github.com/anthropics/skills/tree/main',
    )
    expect(entries).toHaveLength(2)
    expect(entries[0]).toEqual({
      name: 'xlsx',
      description: 'Document processing suite',
      source: 'https://github.com/anthropics/skills/tree/main/skills/xlsx',
    })
  })

  it('parseSkillMarketDocument / parseMcpMarketDocument auto-detect document shape', () => {
    expect(
      parseSkillMarketDocument({ version: 1, entries: [{ name: 'a', source: 'b' }] }),
    ).toHaveLength(1)
    expect(
      parseSkillMarketDocument({ plugins: [{ name: 'p', skills: ['./s/alpha'] }] }, 'https://r'),
    ).toHaveLength(1)
    expect(() => parseSkillMarketDocument({ hello: true })).toThrow('unrecognized')
    expect(
      parseMcpMarketDocument({ version: 1, entries: [{ name: 'a', transport: 'http', url: 'u' }] }),
    ).toHaveLength(1)
    expect(parseMcpMarketDocument({ servers: [] })).toEqual([])
    expect(() => parseMcpMarketDocument({ hello: true })).toThrow('unrecognized')
  })

  it('parseGithubTreeSpec extracts repo/subpath from tree URLs and github: shorthand', () => {
    expect(
      parseGithubTreeSpec('https://github.com/anthropics/skills/tree/main/skills/xlsx'),
    ).toEqual({
      repoUrl: 'https://github.com/anthropics/skills.git',
      subpath: 'skills/xlsx',
    })
    expect(parseGithubTreeSpec('github:anthropics/skills/tree/main/skills/docx')).toEqual({
      repoUrl: 'https://github.com/anthropics/skills.git',
      subpath: 'skills/docx',
    })
    expect(parseGithubTreeSpec('https://github.com/anthropics/skills')).toBeUndefined()
    expect(parseGithubTreeSpec('https://github.com/anthropics/skills.git')).toBeUndefined()
  })

  it('fetch falls back to built-in defaults when config is unset (isDefault=true)', async () => {
    const home = await tempHome()
    const skillFetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ plugins: [{ name: 'p', skills: ['./skills/alpha'] }] }), {
          status: 200,
        }),
    )
    vi.stubGlobal('fetch', skillFetch)
    const skillView = await fetchSkillMarketIndex(home)
    expect(skillView).toMatchObject({ isDefault: true })
    expect((skillView as { entries: { name: string }[] }).entries[0]?.name).toBe('alpha')
    expect((skillFetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toContain(
      'anthropics/skills',
    )
    vi.unstubAllGlobals()

    const mcpFetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            servers: [
              {
                server: {
                  name: 'a/b',
                  description: 'd',
                  remotes: [{ type: 'streamable-http', url: 'https://x/mcp' }],
                },
                _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active' } },
              },
            ],
          }),
          { status: 200 },
        ),
    )
    vi.stubGlobal('fetch', mcpFetch)
    const mcpView = await fetchMcpMarketIndex(home)
    expect(mcpView).toMatchObject({ isDefault: true })
    expect((mcpView as { entries: { name: string }[] }).entries[0]?.name).toBe('a-b')
    vi.unstubAllGlobals()
  })
})
