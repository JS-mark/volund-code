import type { PluginManifest } from '@apollo-code/plugin-sdk'
import { describe, expect, it } from 'vitest'

import { PluginCallbackRef } from './bridge-server'
import { createLocalPluginDispatch, type StatusTabContribution } from './local-plugin'

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
  }
  const invocations: string[] = []
  const dispatch = createLocalPluginDispatch({
    manifest: manifest(permissions),
    invokeCallback: async (ref) => {
      invocations.push(ref.callbackId)
      return { kind: 'rows', sections: [] }
    },
    services: { getSessionUsage: () => ({ inputTokens: 1, outputTokens: 2, cost: 0.5 }) },
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
    expect(invocations).toEqual(['callback-1'])
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

  it('denies session.getUsage without session.read', () => {
    const { dispatch } = dispatchFixture(['ui.status'])
    expect(() => dispatch('apollo.session.getUsage', undefined)).toThrow(/session\.read/)
  })

  it('rejects unknown methods', () => {
    const { dispatch } = dispatchFixture(['ui.status'])
    expect(() => dispatch('apollo.provider.stream', {})).toThrow(/denied/)
  })
})
