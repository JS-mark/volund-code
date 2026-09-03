import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { VolundError } from '@volund/shared'
import { describe, expect, it, vi } from 'vitest'

import { loadConfig, loadTomlFile, parseTomlFile, validateConfig, type Config } from './index'
describe('config layering', () => {
  it('filters project data-flow keys and applies env/flags last', async () => {
    const warning = vi.fn()
    const result = await loadConfig({
      defaults: { model: 'a' },
      global: { model: 'b' },
      project: {
        model: 'c',
        provider: { x: { baseUrl: 'evil', endpoint: 'http://remote.example' } },
      },
      env: { model: 'd' },
      flags: { model: 'e' },
      trustProjectConfig: true,
      warning,
    })
    expect(result.config.model).toBe('e')
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    expect(result.config.provider as object | undefined).toBeUndefined()
    expect(warning).toHaveBeenCalledWith('provider.x.baseUrl')
    expect(warning).toHaveBeenCalledWith('provider.x.endpoint')
  })
  it('denies project config non-interactively by default', async () => {
    const result = await loadConfig({ defaults: { x: 1 }, project: { x: 2 }, interactive: false })
    expect(result.config.x).toBe(1)
  })
  it('aligns project filtering with appendix C.2 projectOverride annotations', async () => {
    const warning = vi.fn()
    const result = await loadConfig({
      defaults: {},
      project: {
        router: { type: 'single', allow_cross_provider_tool_use: true },
        telemetry: { sink: 'otel' },
        auth: { method: 'keychain' },
      },
      trustProjectConfig: true,
      warning,
    })
    // C.2: router.type / telemetry.sink / auth.* forbidden；allow_cross_provider_tool_use allowed
    expect(result.config.router).toEqual({ allow_cross_provider_tool_use: true })
    expect(result.config.telemetry).toBeUndefined()
    expect(result.config.auth).toBeUndefined()
    expect(warning).toHaveBeenCalledWith('router.type')
    expect(warning).toHaveBeenCalledWith('telemetry.sink')
    expect(warning).toHaveBeenCalledWith('auth.method')
  })
})
describe('unknown key policy (§8.3 / appendix C.1, r13-I4)', () => {
  it('warns and ignores an unknown top-level section (e.g. [context] typoed)', () => {
    const { config, warnings } = validateConfig(
      { contex: { policy: 'sliding' }, context: { policy: 'summary' } },
      { file: '/home/u/.volund/config.toml' },
    )
    expect(warnings).toEqual(["unknown config key 'contex' in /home/u/.volund/config.toml ignored"])
    expect(config.contex).toBeUndefined()
    expect(config.context).toEqual({ policy: 'summary' })
  })
  it('warns and ignores unknown keys inside known strict sections', () => {
    const { config, warnings } = validateConfig(
      { tools: { bogus_key: 1 }, ui: { theme: 'dark', colour: false } },
      { file: 'project/config.toml' },
    )
    expect([...warnings].sort()).toEqual([
      "unknown config key 'tools.bogus_key' in project/config.toml ignored",
      "unknown config key 'ui.colour' in project/config.toml ignored",
    ])
    expect(config.tools).toEqual({})
    expect(config.ui).toEqual({ theme: 'dark' })
  })
  it('accepts open-section extras without warnings (context.*, sandbox.*)', () => {
    const { config, warnings } = validateConfig(
      { context: { policy: 'sliding', keep_recent: 20 }, sandbox: { tier: 'restricted' } },
      { file: 'f.toml' },
    )
    expect(warnings).toEqual([])
    expect(config.context).toEqual({ policy: 'sliding', keep_recent: 20 })
  })
  it('types evolution.enabled strictly and ignores unknown evolution keys', () => {
    const { config, warnings } = validateConfig(
      { evolution: { enabled: true, mode: 'apply' } },
      { file: 'f.toml' },
    )
    expect(config.evolution).toEqual({ enabled: true })
    expect(warnings).toEqual(["unknown config key 'evolution.mode' in f.toml ignored"])
    expect(() => validateConfig({ evolution: { enabled: 'true' } }, { file: 'f.toml' })).toThrow(
      /key 'evolution\.enabled'.*expected boolean/,
    )
  })
  it('warns and ignores unknown keys inside a dynamic provider entry', () => {
    const { warnings } = validateConfig(
      { provider: { anthropic: { model: 'claude-sonnet-4-5', oops: 1 } } },
      { file: 'f.toml' },
    )
    expect(warnings).toEqual(["unknown config key 'provider.anthropic.oops' in f.toml ignored"])
  })
  it('fails with file + key + expected type on a known key type error', () => {
    let thrown: unknown
    try {
      validateConfig({ context: { max_tokens: '180000' } }, { file: '/x/config.toml' })
    } catch (error) {
      thrown = error
    }
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const volundError = thrown as VolundError
    expect(thrown).toBeInstanceOf(VolundError)
    expect(volundError.code).toBe('config_invalid')
    expect(volundError.message).toContain('/x/config.toml')
    expect(volundError.message).toContain("key 'context.max_tokens'")
    expect(volundError.message).toContain('expected number, received string')
  })
  it('fails (not warns) when a dynamic provider entry has a non-object value', () => {
    expect(() => validateConfig({ provider: { anthropic: 'claude' } }, { file: 'f.toml' })).toThrow(
      /key 'provider\.anthropic'.*expected object/,
    )
  })
  it('type errors take precedence over unknown-key warnings', () => {
    expect(() => validateConfig({ bogus: true, ui: { color: 'yes' } }, { file: 'f.toml' })).toThrow(
      /key 'ui\.color'/,
    )
  })
})
describe('loadTomlFile', () => {
  it('parses, warns on unknown keys, and strips them from the result', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'volund-config-'))
    const path = join(directory, 'config.toml')
    await writeFile(
      path,
      [
        '[contex]',
        'policy = "sliding"',
        '',
        '[context]',
        'policy = "summary"',
        '',
        '[ui]',
        'theme = "dark"',
        'colour = false',
      ].join('\n'),
      'utf8',
    )
    const warnings: string[] = []
    const config = await loadTomlFile(path, { onWarning: (message) => warnings.push(message) })
    expect([...warnings].sort()).toEqual([
      `unknown config key 'contex' in ${path} ignored`,
      `unknown config key 'ui.colour' in ${path} ignored`,
    ])
    expect(config.contex).toBeUndefined()
    expect(config.context).toEqual({ policy: 'summary' })
    expect(config.ui).toEqual({ theme: 'dark' })
    await rm(directory, { recursive: true, force: true })
  })
  it('keeps # inside quoted strings and strips bare comments (permissions round-trip)', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'volund-config-comment-'))
    const path = join(directory, 'config.toml')
    await writeFile(
      path,
      [
        'basic = "pnpm test --filter \\"#tag\\"" # trailing comment',
        'plain = "v" # note',
        'list = [{"tool":"Bash","spec":{"bash":{"command":"echo #1"}}}]',
      ].join('\n'),
      'utf8',
    )
    const config = await parseTomlFile(path)
    expect(config.basic).toBe('pnpm test --filter "#tag"')
    expect(config.plain).toBe('v')
    expect(config.list).toEqual([{ tool: 'Bash', spec: { bash: { command: 'echo #1' } } }])
    await rm(directory, { recursive: true, force: true })
  })
})
describe('prototype pollution guard', () => {
  it('rejects magic key segments in TOML instead of writing to Object.prototype', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'volund-config-pollution-'))
    const path = join(directory, 'config.toml')
    for (const source of [
      '[__proto__]\nenabled = true\n',
      '[evolution.__proto__]\nenabled = true\n',
      '[evolution]\n__proto__.enabled = true\n',
      '[ui.constructor]\ncolor = true\n',
    ]) {
      await writeFile(path, source, 'utf8')
      await expect(loadTomlFile(path)).rejects.toThrow(/forbidden config key segment/)
    }
    expect(Object.hasOwn(Object.prototype, 'enabled')).toBe(false)
    expect(Object.hasOwn(Object.prototype, 'color')).toBe(false)
    await rm(directory, { recursive: true, force: true })
  })
  it('rejects magic segments in layered merge input', async () => {
    const crafted: Config = {}
    // An own `__proto__` data property is the JSON.parse shape of a crafted config file.
    Object.defineProperty(crafted, '__proto__', {
      value: { enabled: true },
      configurable: true,
      enumerable: true,
      writable: true,
    })
    await expect(loadConfig({ defaults: {}, global: crafted })).rejects.toThrow(
      /forbidden config key segment/,
    )
    expect(Object.hasOwn(Object.prototype, 'enabled')).toBe(false)
  })

  it('parses TOML inline tables with nesting, arrays, quoted keys, and literal strings', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'volund-config-inline-'))
    const path = join(directory, 'inline.toml')
    await writeFile(
      path,
      [
        'doc = { tool = "Bash", spec = { bash = { command = "ls # not a comment" } } }',
        "literal = 'keep # as-is'",
        'items = ["a", "b"]',
        '"quoted key" = { nested = true }',
        'empty = {}',
      ].join('\n'),
    )
    const config = await parseTomlFile(path)
    expect(config.doc).toEqual({
      tool: 'Bash',
      spec: { bash: { command: 'ls # not a comment' } },
    })
    expect(config.literal).toBe('keep # as-is')
    expect(config.items).toEqual(['a', 'b'])
    expect(config['quoted key']).toEqual({ nested: true })
    expect(config.empty).toEqual({})
    await rm(directory, { recursive: true, force: true })
  })
})
