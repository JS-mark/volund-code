import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { JsonValue } from '@apollo-code/shared'

import {
  assignConfigValue,
  assertConfigKeyValue,
  deleteConfigValue,
  getConfigValue,
  readConfigFileOrEmpty,
  writeConfigFile,
} from './config-edit'

const fixtures: string[] = []
afterEach(async () =>
  Promise.all(fixtures.map((path) => rm(path, { force: true, recursive: true }))),
)

describe('config-edit helpers', () => {
  it('assigns, reads, and deletes dot-path values with empty-parent pruning', () => {
    const config: Record<string, JsonValue> = {}
    assignConfigValue(config, 'provider.anthropic.model', 'claude-sonnet-4-5')
    assignConfigValue(config, 'provider.default', 'anthropic')
    expect(getConfigValue(config, 'provider.anthropic.model')).toBe('claude-sonnet-4-5')
    expect(getConfigValue(config, 'provider.default')).toBe('anthropic')
    expect(getConfigValue(config, 'provider.missing')).toBeUndefined()
    expect(getConfigValue(config, 'provider.default.deeper')).toBeUndefined()

    expect(deleteConfigValue(config, 'provider.anthropic.model')).toBe(true)
    // 空父表被剪掉，非空父表保留
    expect(getConfigValue(config, 'provider.anthropic')).toBeUndefined()
    expect(getConfigValue(config, 'provider.default')).toBe('anthropic')
    expect(deleteConfigValue(config, 'provider.anthropic.model')).toBe(false)
  })

  it('rejects prototype-polluting and malformed keys', () => {
    expect(() => assignConfigValue({}, 'evolution.__proto__.enabled', true)).toThrow(
      /forbidden config key segment/,
    )
    expect(() => assignConfigValue({}, 'a..b', true)).toThrow(/Malformed config key/)
    expect(() => deleteConfigValue({}, 'constructor.prototype.x')).toThrow(
      /forbidden config key segment/,
    )
  })

  it('validates key/value against the config schema', () => {
    expect(() => assertConfigKeyValue('provider.default', 'anthropic')).not.toThrow()
    expect(() => assertConfigKeyValue('provider.acme.model', 'x')).not.toThrow()
    expect(() => assertConfigKeyValue('preferences.theme', 'dark')).not.toThrow()
    expect(() => assertConfigKeyValue('env.MY_VAR', 'value')).not.toThrow()
    expect(() => assertConfigKeyValue('no.such.key', true)).toThrow(/Unknown config key/)
    expect(() => assertConfigKeyValue('evolution.enabled', 'true')).toThrow(/expected boolean/)
  })

  it('round-trips config files atomically and tolerates missing files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'apollo-config-edit-'))
    fixtures.push(root)
    const file = join(root, 'nested', 'config.toml')
    expect(await readConfigFileOrEmpty(file)).toEqual({})
    await writeConfigFile(file, {
      provider: { default: 'anthropic', anthropic: { model: 'claude-sonnet-4-5' } },
      evolution: { enabled: true },
      runner: { maxToolLoopsPerTurn: 40 },
    })
    expect(await readConfigFileOrEmpty(file)).toEqual({
      provider: { default: 'anthropic', anthropic: { model: 'claude-sonnet-4-5' } },
      evolution: { enabled: true },
      runner: { maxToolLoopsPerTurn: 40 },
    })
  })
})
