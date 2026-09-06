import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { PluginManifest } from '@volund/plugin-sdk'
import { afterEach, describe, expect, it } from 'vitest'

import { isPluginApproved, LocalPluginStateStore } from './plugin-state'

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function fixtureHome() {
  const home = await mkdtemp(join(tmpdir(), 'volund-plugin-state-'))
  dirs.push(home)
  return home
}

const manifest = (version = '1.0.0', permissions = ['log.write']): PluginManifest => ({
  name: 'volund-plugin-example' as const,
  version,
  type: 'module' as const,
  main: 'index.mjs',
  engines: { volund: '^0.1.0' },
  permissions: { volund: permissions },
})

describe('LocalPluginStateStore', () => {
  it('keeps market install disabled until the exact version and permission hash are approved', async () => {
    const home = await fixtureHome()
    const store = new LocalPluginStateStore(home)
    const installed = await store.discover(manifest(), 'market', join(home, 'plugins/example'))
    expect(isPluginApproved(installed)).toBe(false)
    expect(installed.enabled).toBe(false)
    await expect(store.setEnabled(installed.name, true)).rejects.toThrow('plugin_approval_required')
    await expect(store.approve(installed.name, '0'.repeat(64))).rejects.toThrow(
      'plugin_approval_stale',
    )
    const approved = await store.approve(installed.name, installed.permissionHash)
    expect(isPluginApproved(approved)).toBe(true)
    await expect(store.setEnabled(installed.name, true)).resolves.toMatchObject({ enabled: true })
  })

  it('revokes approval and disables on a version or permission change', async () => {
    const home = await fixtureHome()
    const store = new LocalPluginStateStore(home)
    const first = await store.discover(manifest(), 'market', join(home, 'plugins/example'))
    await store.approve(first.name, first.permissionHash)
    await store.setEnabled(first.name, true)

    const upgraded = await store.discover(
      manifest('1.1.0', ['log.write']),
      'market',
      join(home, 'plugins/example'),
    )
    expect(isPluginApproved(upgraded)).toBe(false)
    expect(upgraded.enabled).toBe(false)

    const changed = await store.discover(
      manifest('1.1.0', ['log.write', 'env.read']),
      'market',
      join(home, 'plugins/example'),
    )
    expect(changed.permissionHash).not.toBe(first.permissionHash)
    expect(isPluginApproved(changed)).toBe(false)
  })

  it('uses a distinct v2 state file and rejects malformed or symlinked state', async () => {
    const home = await fixtureHome()
    const legacyDir = join(home, 'plugins')
    await mkdir(legacyDir, { recursive: true })
    await writeFile(join(legacyDir, 'plugins.json'), '{"approvals":{}}\n')
    const store = new LocalPluginStateStore(home)
    await store.discover(manifest(), 'builtin', '/artifact/plugins/example')
    expect(JSON.parse(await readFile(store.path, 'utf8')).schemaVersion).toBe(2)
    expect(await readFile(join(legacyDir, 'plugins.json'), 'utf8')).toBe('{"approvals":{}}\n')

    const badHome = await fixtureHome()
    await writeFile(join(badHome, 'plugin-state.v2.json'), '{"schemaVersion":1}')
    await expect(new LocalPluginStateStore(badHome).init()).rejects.toThrow('plugin_state_invalid')
  })
})
