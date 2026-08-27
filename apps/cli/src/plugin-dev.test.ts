import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { probeSandbox, resolveBinary } from '@volund/native-bridge'
import { afterEach, describe, expect, it } from 'vitest'

import type { VolundPorts } from './ports'
import { createProductionPorts } from './runtime'

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function fixtureHome() {
  const home = await mkdtemp(join(tmpdir(), 'volund-dev-plugins-'))
  dirs.push(home)
  return home
}

async function sandboxAvailable(): Promise<boolean> {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
  if (!process.env.VOLUND_NATIVE_SANDBOX_BINARY)
    process.env.VOLUND_NATIVE_SANDBOX_BINARY = join(repoRoot, 'target', 'debug', 'volund-sandbox')
  try {
    const binary = await resolveBinary('sandbox')
    if (!binary) return false
    return (await probeSandbox()).tier !== 'none'
  } catch {
    return false
  }
}

describe('localPlugins dev 发现（~/.volund/plugins-dev）', () => {
  it('discovers plugin dirs with a manifest, skips plain dirs, and isolates failures', async () => {
    const home = await fixtureHome()
    await mkdir(join(home, 'plugins-dev', 'not-a-plugin'), { recursive: true })
    await mkdir(join(home, 'plugins-dev', 'volund-plugin-broken'), { recursive: true })
    await writeFile(
      join(home, 'plugins-dev', 'volund-plugin-broken', 'manifest.json'),
      JSON.stringify({ name: 'wrong-prefix', version: '1.0.0' }),
    )
    const ports: VolundPorts = createProductionPorts({
      volundHome: home,
      identity: { version: '0.1.0' },
    })
    const { loaded, failed } = await ports.localPlugins!.loadDevPlugins()
    expect(loaded).toEqual([])
    expect(failed).toHaveLength(1)
    expect(failed[0]!.dir).toContain('volund-plugin-broken')
    await ports.localPlugins!.deactivateAll()
  })

  it('returns empty results when the plugins-dev directory does not exist', async () => {
    const home = await fixtureHome()
    const ports = createProductionPorts({ volundHome: home, identity: { version: '0.1.0' } })
    const { loaded, failed } = await ports.localPlugins!.loadDevPlugins()
    expect(loaded).toEqual([])
    expect(failed).toEqual([])
  })

  it('discovers and activates the demo plugin from the conventional directory', async () => {
    if (!(await sandboxAvailable())) {
      console.warn('sandbox unavailable; skipping discovery e2e')
      return
    }
    const home = await fixtureHome()
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
    const demoSource = join(repoRoot, 'examples', 'plugin-status-demo')
    const target = join(home, 'plugins-dev', 'volund-plugin-status-demo')
    await mkdir(target, { recursive: true })
    const { copyFile, readFile } = await import('node:fs/promises')
    await copyFile(join(demoSource, 'manifest.json'), join(target, 'manifest.json'))
    await copyFile(join(demoSource, 'index.mjs'), join(target, 'index.mjs'))
    // engines 对齐测试用 volundVersion
    const manifest = JSON.parse(await readFile(join(target, 'manifest.json'), 'utf8'))
    manifest.engines.volund = '^1.0.0'
    await writeFile(join(target, 'manifest.json'), JSON.stringify(manifest))

    const ports = createProductionPorts({ volundHome: home, identity: { version: '1.2.3' } })
    const { loaded, failed } = await ports.localPlugins!.loadDevPlugins()
    expect(failed).toEqual([])
    expect(loaded).toEqual([{ name: 'volund-plugin-status-demo', statusTabs: 2 }])
    // 贡献汇入 status 数据组装
    const data = await ports.config.status!({ cwd: repoRoot, includeStats: false })
    expect(data.pluginTabs?.map((tab) => tab.id)).toEqual(['plugin-demo', 'plugin-demo-pulse'])
    await ports.localPlugins!.deactivateAll()
  }, 30_000)
})
