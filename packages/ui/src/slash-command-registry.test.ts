import { describe, expect, it, vi } from 'vitest'

import { MutableSlashCommandRegistry, normalizeSlashCommandName } from './slash-command-registry'

const command = (name: string, aliases?: readonly string[]) => ({
  name,
  ...(aliases ? { aliases } : {}),
  description: `${name} command`,
  run: vi.fn(),
})

describe('MutableSlashCommandRegistry', () => {
  it('normalizes names, aliases and sorts builtins before plugins', () => {
    const registry = new MutableSlashCommandRegistry()
    registry.register(command('/Zulu'), { kind: 'plugin', plugin: 'volund-plugin-z' })
    registry.register(command('help', ['/H']), { kind: 'builtin' })

    expect(registry.snapshot().map(({ name }) => name)).toEqual(['help', 'zulu'])
    expect(registry.snapshot()[0]?.aliases).toEqual(['h'])
    expect(normalizeSlashCommandName('///MODEL')).toBe('model')
  })

  it('floats ordered commands above the unordered tail (order is the primary key)', () => {
    const registry = new MutableSlashCommandRegistry()
    registry.register(command('zulu'), { kind: 'plugin', plugin: 'volund-plugin-z' })
    registry.register(command('alpha'), { kind: 'plugin', plugin: 'volund-plugin-a' })
    registry.register(
      { ...command('plugins'), order: 5 },
      {
        kind: 'plugin',
        plugin: 'volund-plugin-manager',
      },
    )
    registry.register(
      { ...command('env'), order: -1 },
      {
        kind: 'plugin',
        plugin: 'volund-plugin-env',
      },
    )

    expect(registry.snapshot().map(({ name }) => name)).toEqual(['env', 'plugins', 'alpha', 'zulu'])
  })

  it('rejects invalid names, aliases and conflicts including builtin aliases', () => {
    const registry = new MutableSlashCommandRegistry()
    registry.register(command('help', ['h']), { kind: 'builtin' })

    expect(() => registry.register(command('/help'), { kind: 'plugin', plugin: 'p' })).toThrow(
      'slash_command_builtin_reserved',
    )
    expect(() =>
      registry.register(command('plugin', ['h']), { kind: 'plugin', plugin: 'p' }),
    ).toThrow('slash_command_builtin_reserved')
    expect(() => normalizeSlashCommandName('../bad')).toThrow('slash_command_invalid_name')
  })

  it('publishes immutable snapshots on register and dispose', () => {
    const registry = new MutableSlashCommandRegistry()
    const listener = vi.fn()
    const unsubscribe = registry.subscribe(listener)
    const dispose = registry.register(command('hello'), {
      kind: 'plugin',
      plugin: 'volund-plugin-example',
    })

    expect(registry.snapshot()).toHaveLength(1)
    expect(Object.isFrozen(registry.snapshot())).toBe(true)
    dispose()
    dispose()
    expect(registry.snapshot()).toEqual([])
    expect(listener).toHaveBeenCalledTimes(2)
    unsubscribe()
  })

  it('dispatches a registered plugin command with parsed arguments', async () => {
    const registry = new MutableSlashCommandRegistry()
    const run = vi.fn()
    registry.register(
      { name: '/greet', description: 'Greet someone', run },
      { kind: 'plugin', plugin: 'volund-plugin-example' },
    )

    await registry.snapshot()[0]?.run({ name: 'greet', args: ['volund'], raw: '/greet volund' })
    expect(run).toHaveBeenCalledWith({ name: 'greet', args: ['volund'], raw: '/greet volund' })
  })
})
