import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createLocalPluginDispatch } from '@volund/plugin-runtime'
import type { PluginManifest } from '@volund/plugin-runtime'
import { afterEach, describe, expect, it } from 'vitest'

import { createMemoryStack, createPluginMemoryHost } from '../memory'

const dirs: string[] = []
afterEach(async () =>
  Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))),
)

function manifest(permissions: string[]): PluginManifest {
  return {
    name: 'volund-plugin-memory-seam',
    version: '1.0.0',
    type: 'module',
    main: 'index.mjs',
    engines: { volund: '^0.2.0' },
    permissions: { volund: permissions },
  }
}

/** 缝合测试：v2 dispatch 的 memory 分支接到 createPluginMemoryHost（生产同构装配）。 */
describe('plugin memory bridge seam', () => {
  it('writes through dispatch into markdown files with audit and denies undeclared writes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'volund-plugin-memory-seam-'))
    dirs.push(root)
    const stack = createMemoryStack(root, { cwd: root })
    const audit: unknown[] = []
    const host = createPluginMemoryHost({
      home: root,
      cwd: root,
      sessionId: () => 'seam-session',
      memory: stack.memory,
      memoryRecall: stack.memoryRecall,
      memoryTransfer: stack.memoryTransfer,
    })
    const dispatch = createLocalPluginDispatch({
      manifest: manifest(['memory.write', 'memory.read']),
      invokeCallback: async () => null,
      services: {
        memory: (plugin, operation, params) => {
          audit.push({ plugin, operation })
          return host(plugin, operation, params)
        },
      },
      contributions: {
        statusTabs: [],
        statusSections: [],
        commands: [],
        tools: [],
        hooks: [],
        prompts: [],
        webSearchProviders: [],
      },
    })

    await dispatch('volund.memory.create', {
      scope: 'workspace',
      id: 'seam-write',
      content: '插件经缝合写入',
      tags: ['seam'],
    })

    const files = (await readdir(join(root, 'memory'))).filter(
      (name) => name.endsWith('.md') && name !== 'MEMORY.md',
    )
    expect(files).toHaveLength(1)
    expect(await readFile(join(root, 'memory', files[0]!), 'utf8')).toContain(
      'actorId: plugin:volund-plugin-memory-seam',
    )

    // Undeclared write: the manifest permission guard rejects before the host.
    const denied = createLocalPluginDispatch({
      manifest: manifest(['memory.read']),
      invokeCallback: async () => null,
      services: {
        memory: (plugin, operation, params) => host(plugin, operation, params),
      },
      contributions: {
        statusTabs: [],
        statusSections: [],
        commands: [],
        tools: [],
        hooks: [],
        prompts: [],
        webSearchProviders: [],
      },
    })
    expect(() =>
      denied('volund.memory.create', { scope: 'workspace', content: 'should not land' }),
    ).toThrowError(/plugin_rpc_method_denied/)
    expect(audit).toEqual([{ plugin: 'volund-plugin-memory-seam', operation: 'create' }])
  })
})
