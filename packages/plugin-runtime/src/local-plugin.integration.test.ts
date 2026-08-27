import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { probeSandbox, resolveBinary } from '@volund/native-bridge'
import { afterEach, describe, expect, it } from 'vitest'

import { activateLocalPlugin, type ActivatedLocalPlugin } from './local-plugin'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(packageRoot, '../..')
const demoPluginDir = join(repoRoot, 'examples', 'plugin-status-demo')

const dirs: string[] = []
const handles: ActivatedLocalPlugin[] = []
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.deactivate()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function sandboxAvailable(): Promise<boolean> {
  // 本地 cargo 构建兜底（开发机）；CI 无沙箱时跳过。
  const debugBinary = join(repoRoot, 'target', 'debug', 'volund-sandbox')
  if (!process.env.VOLUND_NATIVE_SANDBOX_BINARY)
    process.env.VOLUND_NATIVE_SANDBOX_BINARY = debugBinary
  try {
    const binary = await resolveBinary('sandbox')
    if (!binary) return false
    const info = await probeSandbox()
    return info.tier !== 'none'
  } catch {
    return false
  }
}

describe('activateLocalPlugin（沙箱插件宿主端到端）', () => {
  it('loads the demo plugin through volund-sandbox and renders its status tabs', async () => {
    if (!(await sandboxAvailable())) {
      console.warn('sandbox unavailable; skipping plugin host e2e')
      return
    }
    const dataDir = await mkdtemp(join(tmpdir(), 'volund-plugin-data-'))
    dirs.push(dataDir)
    const activated = await activateLocalPlugin({
      dir: demoPluginDir,
      volundVersion: '0.1.0',
      dataDirRoot: dataDir,
      services: { getSessionUsage: () => ({ inputTokens: 12, outputTokens: 34, cost: 0.5 }) },
    })
    handles.push(activated)
    expect(activated.manifest.name).toBe('volund-plugin-status-demo')
    expect(activated.statusTabs.map((tab) => tab.id)).toEqual(['plugin-demo', 'plugin-demo-pulse'])

    // render 经 callback.invoke 回到沙箱进程取值
    const rowsBody = (await activated.statusTabs[0]!.render()) as {
      kind: string
      sections: { rows: [string, string | number | boolean][] }[]
    }
    expect(rowsBody.kind).toBe('rows')
    const flat = rowsBody.sections.flatMap((section) => section.rows)
    expect(flat).toContainEqual(['Plugin', 'volund-plugin-status-demo@0.1.0'])
    expect(flat).toContainEqual(['Session tokens', '12 in / 34 out'])

    const heatmapBody = (await activated.statusTabs[1]!.render()) as {
      kind: string
      heatmap: { start: string; days: number[] }
    }
    expect(heatmapBody.kind).toBe('heatmap')
    expect(heatmapBody.heatmap.days).toHaveLength(14)
    expect(heatmapBody.heatmap.start).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  }, 30_000)

  it('surfaces a clear error when the plugin entry throws during activation', async () => {
    if (!(await sandboxAvailable())) return
    const dir = await mkdtemp(join(tmpdir(), 'volund-plugin-bad-'))
    dirs.push(dir)
    const { writeFile } = await import('node:fs/promises')
    await writeFile(
      join(dir, 'manifest.json'),
      JSON.stringify({
        name: 'volund-plugin-bad',
        version: '1.0.0',
        type: 'module',
        main: 'index.mjs',
        engines: { volund: '^0.1.0' },
        permissions: { volund: ['ui.status'] },
      }),
    )
    await writeFile(join(dir, 'index.mjs'), 'throw new Error("boom")')
    await expect(
      activateLocalPlugin({
        dir,
        volundVersion: '0.1.0',
        dataDirRoot: join(dir, 'data-root'),
        services: {},
        handshakeTimeoutMs: 5_000,
      }),
    ).rejects.toThrow()
  }, 30_000)
})
