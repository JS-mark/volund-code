import type { PluginManifest } from '@apollo-code/plugin-sdk'
import { describe, expect, it } from 'vitest'

import { PluginCallbackRef } from './bridge-server'
import {
  createLocalPluginDispatch,
  type CommandContribution,
  type StatusTabContribution,
} from './local-plugin'

function manifest(permissions: string[]): PluginManifest {
  return {
    name: 'apollo-plugin-test',
    version: '1.0.0',
    type: 'module',
    main: 'index.mjs',
    engines: { apollo: '^0.1.0' },
    permissions: { apollo: permissions },
  }
}

function dispatchFixture(permissions: string[]) {
  const contributions = {
    statusTabs: [] as StatusTabContribution[],
    statusSections: [] as { id: string; title: string; render(): Promise<unknown> }[],
    commands: [] as CommandContribution[],
  }
  const invocations: { callbackId: string; args: readonly unknown[] }[] = []
  const dispatch = createLocalPluginDispatch({
    manifest: manifest(permissions),
    invokeCallback: async (ref, args = []) => {
      invocations.push({ callbackId: ref.callbackId, args })
      return { kind: 'rows', sections: [] }
    },
    services: {
      getSessionUsage: () => ({ inputTokens: 1, outputTokens: 2, cost: 0.5 }),
      getEffectiveEnv: () => [
        {
          key: 'NO_PROXY',
          configured: 'localhost',
          actual: 'localhost',
          status: 'effective' as const,
          sandboxPassthrough: true,
        },
      ],
    },
    contributions,
  })
  return { contributions, dispatch, invocations }
}

describe('createLocalPluginDispatch', () => {
  it('registers status tabs and routes render through the bridge callback', async () => {
    const { contributions, dispatch, invocations } = dispatchFixture(['ui.status'])
    dispatch('apollo.ui.status.registerTab', {
      id: 'demo',
      label: 'Plug',
      render: new PluginCallbackRef('callback-1'),
    })
    expect(contributions.statusTabs).toHaveLength(1)
    await contributions.statusTabs[0]!.render()
    expect(invocations.map(({ callbackId }) => callbackId)).toEqual(['callback-1'])
  })

  it('denies registerTab without the ui.status permission (deny-by-default)', () => {
    const { contributions, dispatch } = dispatchFixture(['session.read'])
    expect(() =>
      dispatch('apollo.ui.status.registerTab', {
        id: 'demo',
        label: 'Plug',
        render: new PluginCallbackRef('callback-1'),
      }),
    ).toThrow(/denied|ui\.status/)
    expect(contributions.statusTabs).toHaveLength(0)
  })

  it('rejects a registerTab spec without a render callback', () => {
    const { dispatch } = dispatchFixture(['ui.status'])
    expect(() =>
      dispatch('apollo.ui.status.registerTab', { id: 'demo', label: 'Plug', render: {} }),
    ).toThrow(/render/)
  })

  it('serves session.getUsage from host services', () => {
    const { dispatch } = dispatchFixture(['session.read'])
    expect(dispatch('apollo.session.getUsage', undefined)).toEqual({
      inputTokens: 1,
      outputTokens: 2,
      cost: 0.5,
    })
  })

  it('registers slash commands and routes run args through the bridge callback', async () => {
    const { contributions, dispatch, invocations } = dispatchFixture(['commands.register'])
    dispatch('apollo.commands.register', {
      name: 'env',
      description: 'Show env',
      handler: new PluginCallbackRef('callback-env'),
    })
    expect(contributions.commands).toHaveLength(1)
    expect(contributions.commands[0]).toMatchObject({ name: 'env', description: 'Show env' })
    await contributions.commands[0]!.run(['--json'])
    expect(invocations).toEqual([{ callbackId: 'callback-env', args: [['--json']] }])
  })

  it('accepts a finite order key and treats malformed values as unset', () => {
    const { contributions, dispatch } = dispatchFixture(['commands.register'])
    dispatch('apollo.commands.register', {
      name: 'alpha',
      order: 5,
      handler: new PluginCallbackRef('callback-alpha'),
    })
    dispatch('apollo.commands.register', {
      name: 'beta',
      order: 'not-a-number',
      handler: new PluginCallbackRef('callback-beta'),
    })
    dispatch('apollo.commands.register', {
      name: 'gamma',
      order: Number.POSITIVE_INFINITY,
      handler: new PluginCallbackRef('callback-gamma'),
    })
    expect(contributions.commands.find((command) => command.name === 'alpha')?.order).toBe(5)
    expect(contributions.commands.find((command) => command.name === 'beta')?.order).toBeUndefined()
    expect(contributions.commands.find((command) => command.name === 'gamma')?.order).toBeUndefined()
  })

  it('denies commands.register without the commands.register permission', () => {
    const { contributions, dispatch } = dispatchFixture(['ui.status'])
    expect(() =>
      dispatch('apollo.commands.register', {
        name: 'env',
        handler: new PluginCallbackRef('callback-env'),
      }),
    ).toThrow(/denied|commands\.register/)
    expect(contributions.commands).toHaveLength(0)
  })

  it('rejects a commands.register spec without a handler callback', () => {
    const { dispatch } = dispatchFixture(['commands.register'])
    expect(() => dispatch('apollo.commands.register', { name: 'env', handler: {} })).toThrow(
      /handler/,
    )
  })

  it('serves env.getEffective from host services', () => {
    const { dispatch } = dispatchFixture(['env.read'])
    expect(dispatch('apollo.env.getEffective', undefined)).toEqual([
      {
        key: 'NO_PROXY',
        configured: 'localhost',
        actual: 'localhost',
        status: 'effective',
        sandboxPassthrough: true,
      },
    ])
  })

  it('denies env.getEffective without env.read', () => {
    const { dispatch } = dispatchFixture(['session.read'])
    expect(() => dispatch('apollo.env.getEffective', undefined)).toThrow(/env\.read/)
  })

  it('denies session.getUsage without session.read', () => {
    const { dispatch } = dispatchFixture(['ui.status'])
    expect(() => dispatch('apollo.session.getUsage', undefined)).toThrow(/session\.read/)
  })

  it('rejects unknown methods', () => {
    const { dispatch } = dispatchFixture(['ui.status'])
    expect(() => dispatch('apollo.provider.stream', {})).toThrow(/denied/)
  })
})
