// 批量组装全部 standalone target：扫描资产目录里的 volund-sandbox-<triple>
// 确定可构建集合（7 个，win32-arm64-msvc 无 bun 目标自动跳过），逐 target 调
// buildStandalone，最后把每个产物目录打成 volund-standalone-<triple>.tar.gz。
//
// 用法：node scripts/build-all-standalone.mjs <assetsDir> [outDir]
//   assetsDir  平铺的 volund-<kind>-<triple>[.exe]（native.yml 的 release-assets-*）
//   outDir     默认 apps/cli/dist/standalone/；tarball 落在其 archives/ 子目录
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { BUN_TARGETS, buildStandalone } from './build-standalone.mjs'

export async function buildAllStandalone({ root, assetsDirectory, outDirectory }) {
  const entries = await readdir(assetsDirectory)
  const triples = [
    ...new Set(
      entries
        .map((entry) => /^volund-sandbox-(.+?)(?:\.exe)?$/.exec(entry)?.[1])
        .filter((triple) => triple && BUN_TARGETS[triple]),
    ),
  ].toSorted((a, b) => a.localeCompare(b))
  if (triples.length === 0)
    throw new Error(`no volund-sandbox-<triple> assets found in ${assetsDirectory}`)

  const out = outDirectory ?? join(root, 'apps/cli/dist/standalone')
  const archives = join(out, 'archives')
  await mkdir(archives, { recursive: true })
  const sums = []
  for (const triple of triples) {
    console.log(`standalone[${triple}]: building`)
    const built = await buildStandalone({
      root,
      target: triple,
      assetDirectory: assetsDirectory,
      outDirectory: join(out, triple),
    })
    const archive = join(archives, `volund-standalone-${triple}.tar.gz`)
    const tar = spawnSync('tar', ['czf', archive, '-C', built.out, '.'], { stdio: 'inherit' })
    if (tar.status !== 0) throw new Error(`tar failed for ${triple} with status ${tar.status}`)
    sums.push(
      `${createHash('sha256')
        .update(await readFile(archive))
        .digest('hex')}  volund-standalone-${triple}.tar.gz`,
    )
  }
  await writeFile(join(archives, 'checksums.sha256'), `${sums.join('\n')}\n`)
  console.log(`standalone: ${triples.length} targets -> ${archives}`)
  return triples
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const root = resolve(import.meta.dirname, '..')
  const assetsDirectory = process.argv[2]
  if (!assetsDirectory)
    throw new Error('usage: node scripts/build-all-standalone.mjs <assetsDir> [outDir]')
  await buildAllStandalone({
    root,
    assetsDirectory: resolve(assetsDirectory),
    outDirectory: process.argv[3] ? resolve(process.argv[3]) : undefined,
  })
}
