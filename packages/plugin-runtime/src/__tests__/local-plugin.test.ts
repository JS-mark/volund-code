import type { PluginManifest } from '@volund/plugin-sdk'
import { describe, expect, it } from 'vitest'

import { PluginCallbackRef } from '../bridge-server'
import {
  createLocalPluginDispatch,
  HOOK_EVENTS,
  type CommandContribution,
  type StatusTabContribution,
  type ToolContribution,
  type HookContribution,
  type PromptContribution,
  type WebSearchProviderContribution,
} from '../local-plugin'

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

function dispatchFixture(
  permissions: string[],
  net?: PluginManifest['permissions']['net'],
  memory?: (plugin: string, operation: string, params: unknown) => Promise<unknown>,
) {
  const contributions = {
    statusTabs: [] as StatusTabContribution[],
    statusSections: [] as { id: string; title: string; render(): Promise<unknown> }[],
    commands: [] as CommandContribution[],
    tools: [] as ToolContribution[],
    hooks: [] as HookContribution[],
    prompts: [] as PromptContribution[],
    webSearchProviders: [] as WebSearchProviderContribution[],
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
    manifest: {
      ...manifest(permissions),
      ...(net ? { permissions: { ...manifest(permissions).permissions, net } } : {}),
    },
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
      webSearchConfigStatus: () => ({ backend: 'tavily', tavily: { configured: true } }),
      httpFetch: async (url, init) => {
        managed.push({ method: 'httpFetch', value: { url, init } })
        return { status: 200, headers: {}, body: 'ok' }
      },
      ...(memory ? { memory } : {}),
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

  it('registers a WebSearch provider and routes search through the bridge callback with (request, config)', async () => {
    const { contributions, dispatch, invocations } = dispatchFixture(['webSearch.provide'])
    dispatch('volund.webSearch.provide', {
      id: 'web-search',
      search: new PluginCallbackRef('callback-search'),
    })
    expect(contributions.webSearchProviders).toHaveLength(1)
    const provider = contributions.webSearchProviders[0]!
    expect(provider.plugin).toBe('volund-plugin-test')
    expect(provider.id).toBe('web-search')
    await provider.invoke({ query: 'weather', limit: 5 }, { backend: 'tavily' })
    expect(invocations).toEqual([
      {
        callbackId: 'callback-search',
        args: [{ query: 'weather', limit: 5 }, { backend: 'tavily' }],
      },
    ])
  })

  it('replaces a same-id WebSearch provider registration (hot update)', () => {
    const { contributions, dispatch } = dispatchFixture(['webSearch.provide'])
    for (const callbackId of ['callback-1', 'callback-2'])
      dispatch('volund.webSearch.provide', {
        id: 'web-search',
        search: new PluginCallbackRef(callbackId),
      })
    expect(contributions.webSearchProviders).toHaveLength(1)
    expect(contributions.webSearchProviders.map((provider) => provider.id)).toEqual(['web-search'])
  })

  it('denies webSearch.provide without the webSearch.provide permission', () => {
    const { dispatch, contributions } = dispatchFixture(['session.read'])
    expect(() =>
      dispatch('volund.webSearch.provide', {
        id: 'web-search',
        search: new PluginCallbackRef('callback-1'),
      }),
    ).toThrow(/denied/)
    expect(contributions.webSearchProviders).toHaveLength(0)
  })

  it('rejects a webSearch.provide spec without a search callback', () => {
    const { dispatch } = dispatchFixture(['webSearch.provide'])
    expect(() => dispatch('volund.webSearch.provide', { id: 'web-search' })).toThrow(
      /search function/,
    )
  })

  it('serves webSearch.configStatus from host services', () => {
    const { dispatch } = dispatchFixture(['webSearch.provide'])
    expect(dispatch('volund.webSearch.configStatus', undefined)).toEqual({
      backend: 'tavily',
      tavily: { configured: true },
    })
  })

  it('routes allowlisted HTTPS http.fetch through the host service', async () => {
    const { managed, dispatch } = dispatchFixture(['http.fetch'], {
      allowlist: ['api.tavily.com', '*.example.com'],
    })
    const response = (await dispatch('volund.http.fetch', [
      'https://api.tavily.com/search',
      { method: 'POST', body: { query: 'q' } },
    ])) as { status: number }
    expect(response.status).toBe(200)
    expect(managed.at(-1)).toEqual({
      method: 'httpFetch',
      value: {
        url: 'https://api.tavily.com/search',
        init: { method: 'POST', body: { query: 'q' } },
      },
    })
    await dispatch('volund.http.fetch', ['https://sub.example.com/v1', {}])
    expect(() => dispatch('volund.http.fetch', ['http://api.tavily.com/search', {}])).toThrow(
      /denied/,
    )
    await expect(dispatch('volund.http.fetch', ['https://evil.example.net/x', {}])).rejects.toThrow(
      /denied/,
    )
  })

  it('allows extra hosts beyond the manifest allowlist via extraAllowedHosts (custom backend)', async () => {
    const contributions = {
      statusTabs: [] as StatusTabContribution[],
      statusSections: [] as { id: string; title: string; render(): Promise<unknown> }[],
      commands: [] as CommandContribution[],
      tools: [] as ToolContribution[],
      hooks: [] as HookContribution[],
      prompts: [] as PromptContribution[],
      webSearchProviders: [] as WebSearchProviderContribution[],
    }
    const fetched: string[] = []
    // manifest allowlist 只有 tavily；custom 搜索端点（用户级配置点名）走动态放行。
    const dispatch = createLocalPluginDispatch({
      manifest: manifest(['http.fetch']),
      invokeCallback: async () => null,
      services: {
        extraAllowedHosts: () => ['search.internal.example'],
        httpFetch: async (url) => {
          fetched.push(url)
          return { status: 200, headers: {}, body: '[]' }
        },
      },
      contributions,
    })
    await dispatch('volund.http.fetch', ['https://search.internal.example/q', {}])
    expect(fetched).toEqual(['https://search.internal.example/q'])
    await expect(
      dispatch('volund.http.fetch', ['https://other.internal.example/q', {}]),
    ).rejects.toThrow(/denied/)
  })

  it('rejects unknown methods', () => {
    const { dispatch } = dispatchFixture(['ui.status'])
    expect(() => dispatch('volund.provider.stream', {})).toThrow(/denied/)
  })
})

describe('HOOK_EVENTS', () => {
  it('admits the W-17 task terminal events and SDK-named memory.deleted', () => {
    for (const event of ['task.started', 'task.completed', 'task.failed', 'memory.deleted'])
      expect(HOOK_EVENTS.has(event)).toBe(true)
    // 历史笔误（'deleted'）已对齐 SDK 的 'memory.deleted'，不得回潮。
    expect(HOOK_EVENTS.has('deleted')).toBe(false)
  })
})

describe('local plugin memory service', () => {
  it('forwards volund.memory.* to the host with the plugin name and stripped operation', async () => {
    const calls: { plugin: string; operation: string; params: unknown }[] = []
    const { dispatch } = dispatchFixture(
      ['memory.write', 'memory.read'],
      undefined,
      async (plugin, operation, params) => {
        calls.push({ plugin, operation, params })
        return { ok: true, operation }
      },
    )
    await expect(
      dispatch('volund.memory.create', { scope: 'workspace', content: 'note' }),
    ).resolves.toEqual({ ok: true, operation: 'create' })
    await expect(dispatch('volund.memory.get', { scope: 'project', id: 'x' })).resolves.toEqual({
      ok: true,
      operation: 'get',
    })
    expect(calls.map((call) => call.operation)).toEqual(['create', 'get'])
    expect(calls.every((call) => call.plugin === 'volund-plugin-test')).toBe(true)
  })

  it('denies operations the manifest did not declare', async () => {
    const { dispatch } = dispatchFixture(['memory.read'], undefined, async () => ({ ok: true }))
    expect(() =>
      dispatch('volund.memory.create', { scope: 'workspace', content: 'note' }),
    ).toThrowError(/plugin_rpc_method_denied/)
  })

  it('reports plugin_memory_unavailable when the host has no memory service', async () => {
    const { dispatch } = dispatchFixture(['memory.write'])
    expect(() =>
      dispatch('volund.memory.create', { scope: 'workspace', content: 'note' }),
    ).toThrowError(/plugin_memory_unavailable/)
  })
})
