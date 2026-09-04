import type { PluginManifest } from '@volund/plugin-sdk'
import { describe, expect, it } from 'vitest'

import { PluginCallbackRef } from './bridge-server'
import {
  createLocalPluginDispatch,
  type CommandContribution,
  type StatusTabContribution,
  type ToolContribution,
  type HookContribution,
} from './local-plugin'

function manifest(permissions: string[]): PluginManifest {
  return {
    name: 'volund-plugin-test',
    version: '1.0.0',
    type: 'module',
    main: 'index.mjs',
    engines: { volund: '^0.1.0' },
    permissions: { volund: permissions },
  }
}

function dispatchFixture(permissions: string[]) {
  const contributions = {
    statusTabs: [] as StatusTabContribution[],
    statusSections: [] as { id: string; title: string; render(): Promise<unknown> }[],
    commands: [] as CommandContribution[],
    tools: [] as ToolContribution[],
    hooks: [] as HookContribution[],
  }
  const invocations: { callbackId: string; args: readonly unknown[] }[] = []
  const managed: { method: string; value: unknown }[] = []
  const inventoryEntry = {
    name: 'volund-plugin-example',
    version: '1.0.0',
    dir: '/plugins/example',
    source: 'market' as const,
    commands: 0,
    statusTabs: 0,
    lifecycle: {
      permissionHash: 'a'.repeat(64),
      approved: false,
      enabled: false,
      loaded: false,
    },
  }
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
      listPlugins: async () => ({
        builtin: [],
        dev: [],
        market: { installed: [inventoryEntry], registry: { error: 'offline' } },
      }),
      inspectPlugin: async (name) => {
        managed.push({ method: 'inspect', value: name })
        return inventoryEntry
      },
      approvePlugin: async (name, permissionHash) => {
        managed.push({ method: 'approve', value: { name, permissionHash } })
        return inventoryEntry
      },
      enablePlugin: async (name) => {
        managed.push({ method: 'enable', value: name })
        return inventoryEntry
      },
      disablePlugin: async (name) => {
        managed.push({ method: 'disable', value: name })
        return inventoryEntry
      },
    },
    contributions,
  })
  return { contributions, dispatch, invocations, managed }
}

describe('createLocalPluginDispatch', () => {
  it('registers status tabs and routes render through the bridge callback', async () => {
    const { contributions, dispatch, invocations } = dispatchFixture(['ui.status'])
    dispatch('volund.ui.status.registerTab', {
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
      dispatch('volund.ui.status.registerTab', {
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
      dispatch('volund.ui.status.registerTab', { id: 'demo', label: 'Plug', render: {} }),
    ).toThrow(/render/)
  })

  it('serves session.getUsage from host services', () => {
    const { dispatch } = dispatchFixture(['session.read'])
    expect(dispatch('volund.session.getUsage', undefined)).toEqual({
      inputTokens: 1,
      outputTokens: 2,
      cost: 0.5,
    })
  })

  it('registers slash commands and routes run args through the bridge callback', async () => {
    const { contributions, dispatch, invocations } = dispatchFixture(['commands.register'])
    dispatch('volund.commands.register', {
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
    dispatch('volund.commands.register', {
      name: 'alpha',
      order: 5,
      handler: new PluginCallbackRef('callback-alpha'),
    })
    dispatch('volund.commands.register', {
      name: 'beta',
      order: 'not-a-number',
      handler: new PluginCallbackRef('callback-beta'),
    })
    dispatch('volund.commands.register', {
      name: 'gamma',
      order: Number.POSITIVE_INFINITY,
      handler: new PluginCallbackRef('callback-gamma'),
    })
    expect(contributions.commands.find((command) => command.name === 'alpha')?.order).toBe(5)
    expect(contributions.commands.find((command) => command.name === 'beta')?.order).toBeUndefined()
    expect(
      contributions.commands.find((command) => command.name === 'gamma')?.order,
    ).toBeUndefined()
  })

  it('denies commands.register without the commands.register permission', () => {
    const { contributions, dispatch } = dispatchFixture(['ui.status'])
    expect(() =>
      dispatch('volund.commands.register', {
        name: 'env',
        handler: new PluginCallbackRef('callback-env'),
      }),
    ).toThrow(/denied|commands\.register/)
    expect(contributions.commands).toHaveLength(0)
  })

  it('rejects a commands.register spec without a handler callback', () => {
    const { dispatch } = dispatchFixture(['commands.register'])
    expect(() => dispatch('volund.commands.register', { name: 'env', handler: {} })).toThrow(
      /handler/,
    )
  })

  it('serves env.getEffective from host services', () => {
    const { dispatch } = dispatchFixture(['env.read'])
    expect(dispatch('volund.env.getEffective', undefined)).toEqual([
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
    expect(() => dispatch('volund.env.getEffective', undefined)).toThrow(/env\.read/)
  })

  it('routes v2 inspect/approve/enable/disable through explicit plugins permissions', async () => {
    const { dispatch, managed } = dispatchFixture(['plugins.read', 'plugins.manage'])
    await dispatch('volund.plugins.inspect', 'example')
    await dispatch('volund.plugins.approve', ['example', 'a'.repeat(64)])
    await dispatch('volund.plugins.enable', 'example')
    await dispatch('volund.plugins.disable', 'example')
    expect(managed).toEqual([
      { method: 'inspect', value: 'example' },
      {
        method: 'approve',
        value: { name: 'example', permissionHash: 'a'.repeat(64) },
      },
      { method: 'enable', value: 'example' },
      { method: 'disable', value: 'example' },
    ])
  })

  it('rejects malformed approval parameters before the host service', () => {
    const { dispatch, managed } = dispatchFixture(['plugins.manage'])
    expect(() => dispatch('volund.plugins.approve', ['example'])).toThrow(
      'plugin_rpc_params_invalid',
    )
    expect(managed).toEqual([])
  })

  it('denies session.getUsage without session.read', () => {
    const { dispatch } = dispatchFixture(['ui.status'])
    expect(() => dispatch('volund.session.getUsage', undefined)).toThrow(/session\.read/)
  })

  it('rejects unknown methods', () => {
    const { dispatch } = dispatchFixture(['ui.status'])
    expect(() => dispatch('volund.provider.stream', {})).toThrow(/denied/)
  })
})
