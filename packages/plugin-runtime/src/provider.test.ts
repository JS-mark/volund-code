import { InMemoryProviderRegistry, type ProviderCapabilities } from '@volund/provider-kit'
import { describe, expect, it, vi } from 'vitest'

import {
  BufferedProviderStream,
  PluginError,
  redactSigningValues,
  registerProviderPlugin,
  renderAuthHeaders,
  validateManifest,
} from './index'

const manifest = {
  kind: 'provider' as const,
  name: 'volund-plugin-provider-vllm' as const,
  version: '1.0.0',
  engines: { volund: '^1.0.0' },
  main: 'index.js',
  type: 'module' as const,
  provider: {
    name: 'plugin-vllm',
    displayName: 'vLLM',
    auth: {
      mode: 'header-template' as const,
      credentialScope: 'vllm',
      headerTemplate: 'Authorization: Bearer {{key}}',
    },
  },
  permissions: {
    net: { allowlist: ['localhost:8000'] },
    volund: ['provider.register', 'auth.getAuthHeaders'],
  },
}
const capabilities: ProviderCapabilities = {
  maxContextTokens: 8192,
  maxOutputTokens: 1024,
  toolUse: 'none',
  toolResultSchema: 'openai',
  vision: false,
  files: false,
  thinking: false,
  streaming: true,
  streamingReasoning: false,
  cache: 'none',
  jsonMode: true,
  structuredOutput: false,
  systemPromptLocation: 'system-field',
  toolChoiceRequired: false,
  interleavedThinking: false,
}
const signingManifest = {
  ...manifest,
  name: 'volund-plugin-provider-bedrock' as const,
  provider: {
    name: 'plugin-bedrock',
    displayName: 'Bedrock fixture',
    auth: {
      mode: 'signing' as const,
      credentialScope: 'bedrock-fixture',
      signing: {
        algorithm: 'aws-sigv4' as const,
        envKeys: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'] as const,
      },
    },
  },
  permissions: {
    ...manifest.permissions,
    volund: ['provider.register', 'auth.getSigningEnvKeys'],
  },
}

describe('provider plugin boundary', () => {
  it('requires provider permissions and a network allowlist', () => {
    expect(validateManifest(manifest, '1.2.0').kind).toBe('provider')
    expect(() =>
      validateManifest(
        { ...manifest, permissions: { ...manifest.permissions, net: false } },
        '1.2.0',
      ),
    ).toThrow('provider requires a net allowlist')
    expect(() =>
      validateManifest(
        {
          ...signingManifest,
          provider: {
            ...signingManifest.provider,
            auth: { ...signingManifest.provider.auth, mode: 'unknown' },
          },
        },
        '1.2.0',
      ),
    ).toThrow('invalid provider authentication')
  })
  it('rejects header injection', () => {
    expect(renderAuthHeaders('Authorization: Bearer {{key}}', 'secret')).toEqual({
      Authorization: 'Bearer secret',
    })
    expect(() => renderAuthHeaders('Authorization: {{key}}', 'x\r\nX-Leak: yes')).toThrow(
      PluginError,
    )
  })
  it('injects only rendered headers into the child transport', async () => {
    const registry = new InMemoryProviderRegistry(),
      seen: unknown[] = []
    registerProviderPlugin({
      manifest,
      capabilities,
      registry,
      credentials: async () => 'raw-secret',
      transport: {
        async *stream(_name, request, signal) {
          seen.push(request, signal)
          yield { kind: 'text.delta', text: 'ok' }
        },
        dispose: vi.fn(async () => {}),
      },
    })
    const request = { model: 'llama', messages: [] }
    const chunks = []
    for await (const chunk of registry
      .get('plugin-vllm')!
      .stream(request, new AbortController().signal))
      chunks.push(chunk)
    expect(chunks).toEqual([{ kind: 'text.delta', text: 'ok' }])
    expect(seen[0]).toEqual({ ...request, authHeaders: { Authorization: 'Bearer raw-secret' } })
    expect(JSON.stringify(seen[0])).not.toContain('credentialScope')
  })
  it('requires explicit signing approval before reading fixture credentials', async () => {
    const credentials = vi.fn(async () => ({
      AWS_ACCESS_KEY_ID: 'fixture-access',
      AWS_SECRET_ACCESS_KEY: 'fixture-secret',
    }))
    const registry = new InMemoryProviderRegistry()
    registerProviderPlugin({
      manifest: signingManifest,
      capabilities,
      registry,
      credentials: vi.fn(),
      signing: {
        approve: async () => false,
        credentials,
        environment: { open: vi.fn() },
      },
      transport: {
        async *stream() {
          yield { kind: 'text.delta', text: 'unexpected' }
        },
        dispose: vi.fn(async () => {}),
      },
    })
    await expect(async () => {
      for await (const _chunk of registry
        .get('plugin-bedrock')!
        .stream({ model: 'fixture', messages: [] }, new AbortController().signal)) {
        // The approval gate rejects before iteration produces a chunk.
      }
    }).rejects.toThrow('plugin_signing_approval_required')
    expect(credentials).not.toHaveBeenCalled()
  })
  it('scopes declared signing fixture values and always cleans them up', async () => {
    const registry = new InMemoryProviderRegistry(),
      childEnvironment = new Map<string, string>(),
      dispose = vi.fn(() => childEnvironment.clear())
    registerProviderPlugin({
      manifest: signingManifest,
      capabilities,
      registry,
      credentials: vi.fn(),
      signing: {
        approve: async () => true,
        credentials: async (_scope, keys) => ({
          [keys[0]!]: 'fixture-access',
          [keys[1]!]: 'fixture-secret',
          UNDECLARED_SECRET: 'must-not-be-injected',
        }),
        environment: {
          async open(environment) {
            for (const [key, value] of Object.entries(environment)) childEnvironment.set(key, value)
            return { dispose }
          },
        },
      },
      transport: {
        async *stream() {
          expect(Object.fromEntries(childEnvironment)).toEqual({
            AWS_ACCESS_KEY_ID: 'fixture-access',
            AWS_SECRET_ACCESS_KEY: 'fixture-secret',
          })
          yield { kind: 'text.delta', text: 'ok' }
          throw new Error('fixture transport failure')
        },
        dispose: vi.fn(async () => {}),
      },
    })
    await expect(async () => {
      for await (const _chunk of registry
        .get('plugin-bedrock')!
        .stream({ model: 'fixture', messages: [] }, new AbortController().signal)) {
        // Consume the fixture stream so its failure exercises finally cleanup.
      }
    }).rejects.toThrow('fixture transport failure')
    expect(dispose).toHaveBeenCalledOnce()
    expect(childEnvironment.size).toBe(0)
  })
  it('redacts declared signing keys and values from structured logs', () => {
    const environment = {
      AWS_ACCESS_KEY_ID: 'fixture-access',
      AWS_SECRET_ACCESS_KEY: 'fixture-secret',
    }
    expect(
      redactSigningValues(
        {
          AWS_SECRET_ACCESS_KEY: 'fixture-secret',
          message: 'signing with fixture-access / fixture-secret',
          safe: 'fixture',
        },
        environment,
      ),
    ).toEqual({
      AWS_SECRET_ACCESS_KEY: '[REDACTED]',
      message: 'signing with [REDACTED] / [REDACTED]',
      safe: 'fixture',
    })
  })
  it('fails explicitly instead of dropping chunks on overflow', () => {
    try {
      new BufferedProviderStream(10).accept({ kind: 'text.delta', text: 'too large' })
      throw new Error('expected overflow')
    } catch (error) {
      expect(error).toMatchObject({ code: 'stream_truncated' })
    }
  })
})
