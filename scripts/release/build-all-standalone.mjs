// 批量组装全部 standalone target：扫描资产目录里的 volund-sandbox-<triple>
// 确定可构建集合（7 个，win32-arm64-msvc 无 bun 目标自动跳过），逐 target 调
// buildStandalone，最后把每个产物目录打成 volund-standalone-<triple>.tar.gz。
//
// 用法：node scripts/release/build-all-standalone.mjs <assetsDir> <metadataDir> [outDir]
//   assetsDir  平铺的 volund-<kind>-<triple>[.exe]（native.yml 的 release-assets-*）
//   metadataDir 包含 LICENSE、NOTICE、sbom.cdx.json 三个 release 元数据文件
//   outDir     默认 apps/cli/dist/standalone/；tarball 落在其 archives/ 子目录
import { createHash } from 'node:crypto'
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

import { BUN_TARGETS, buildStandalone } from './build-standalone.mjs'
import {
  archiveNameForTarget,
  createCanonicalStandaloneArchive,
  createCanonicalStandaloneArchiveBuffer,
  REQUIRED_STANDALONE_METADATA_FILES,
} from './standalone-archive.mjs'

export const STANDALONE_TARGETS = Object.freeze(Object.keys(BUN_TARGETS))
export const STANDALONE_OUTPUT_MARKER = '.volund-standalone-output.json'
const OUTPUT_MARKER = Object.freeze({
  schemaVersion: 1,
  product: 'volund',
  kind: 'standalone-build-output',
})

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

function formatTargetSet(targets) {
  return targets.length === 0 ? '(none)' : targets.join(', ')
}

export function discoverStandaloneTargets(entries, { allowPartialTargets = false } = {}) {
  const candidates = new Map()
  for (const entry of entries.toSorted((left, right) => {
    const leftName = typeof left === 'string' ? left : left.name
    const rightName = typeof right === 'string' ? right : right.name
    return compareText(leftName, rightName)
  })) {
    const entryName = typeof entry === 'string' ? entry : entry.name
    if (!entryName.startsWith('volund-sandbox-')) continue
    if (typeof entry !== 'string' && !entry.isFile())
      throw new Error(`standalone sandbox asset must be a regular file: ${entryName}`)
    const suffixedTarget = entryName.slice('volund-sandbox-'.length)
    const hasExecutableSuffix = suffixedTarget.endsWith('.exe')
    const target = hasExecutableSuffix ? suffixedTarget.slice(0, -4) : suffixedTarget
    if (!target) throw new Error(`invalid standalone sandbox asset filename: ${entryName}`)
    if (hasExecutableSuffix !== target.startsWith('win32-'))
      throw new Error(`invalid target-specific standalone sandbox filename: ${entryName}`)
    const previous = candidates.get(target)
    if (previous)
      throw new Error(`duplicate standalone target '${target}' from ${previous} and ${entryName}`)
    candidates.set(target, entryName)
  }

  const discovered = [...candidates.keys()]
  const unexpected = discovered
    .filter((target) => !STANDALONE_TARGETS.includes(target))
    .toSorted(compareText)
  const missing = STANDALONE_TARGETS.filter((target) => !candidates.has(target))
  if (unexpected.length > 0 || (!allowPartialTargets && missing.length > 0))
    throw new Error(
      `standalone target set mismatch; missing: ${formatTargetSet(missing)}; ` +
        `unexpected: ${formatTargetSet(unexpected)}; expected exactly: ${STANDALONE_TARGETS.join(', ')}`,
    )
  if (discovered.length === 0)
    throw new Error('no volund-sandbox-<triple> assets found in the supplied asset directory')

  return STANDALONE_TARGETS.filter((target) => candidates.has(target))
}

async function pathExists(path) {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

function containsPath(ancestor, candidate) {
  const pathFromAncestor = relative(ancestor, candidate)
  return (
    pathFromAncestor === '' || (!pathFromAncestor.startsWith('..') && !isAbsolute(pathFromAncestor))
  )
}

async function canonicalizePotentialPath(path) {
  let cursor = resolve(path)
  const missingSegments = []
  while (true) {
    try {
      return join(await realpath(cursor), ...missingSegments.toReversed())
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      const parent = dirname(cursor)
      if (parent === cursor) throw error
      missingSegments.push(basename(cursor))
      cursor = parent
    }
  }
}

async function assertSafeOutputDirectory({
  outDirectory,
  root,
  assetsDirectory,
  metadataDirectory,
}) {
  const output = await canonicalizePotentialPath(outDirectory)
  if (dirname(output) === output) throw new Error(`unsafe standalone output directory: ${output}`)
  const protectedRoots = await Promise.all(
    [root, process.cwd(), assetsDirectory, metadataDirectory].map((path) =>
      realpath(resolve(path)),
    ),
  )
  for (const protectedRoot of new Set(protectedRoots)) {
    if (containsPath(output, protectedRoot))
      throw new Error(
        `unsafe standalone output directory '${outDirectory}' would contain protected root '${protectedRoot}'`,
      )
  }
}

async function preflightMetadataDirectory(metadataDirectory) {
  for (const file of REQUIRED_STANDALONE_METADATA_FILES) {
    const path = join(metadataDirectory, file)
    let metadata
    try {
      metadata = await lstat(path)
    } catch (error) {
      if (error?.code === 'ENOENT')
        throw new Error(`required standalone metadata file is missing: ${path}`, { cause: error })
      throw error
    }
    if (!metadata.isFile() || metadata.isSymbolicLink())
      throw new Error(`required standalone metadata must be a regular file: ${path}`)
  }
}

async function assertReplaceableOutput(outDirectory, triples) {
  let outputMetadata
  try {
    outputMetadata = await lstat(outDirectory)
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
  if (!outputMetadata.isDirectory() || outputMetadata.isSymbolicLink())
    throw new Error(`standalone output destination must be an owned directory: ${outDirectory}`)
  const entries = await readdir(outDirectory, { withFileTypes: true })
  if (entries.length === 0) return

  const expectedNames = new Set([STANDALONE_OUTPUT_MARKER, 'archives', ...triples])
  const actualNames = new Set(entries.map((entry) => entry.name))
  const missing = [...expectedNames].filter((name) => !actualNames.has(name))
  const unexpected = [...actualNames].filter((name) => !expectedNames.has(name))
  if (missing.length > 0 || unexpected.length > 0)
    throw new Error(
      `refusing to replace unowned standalone output; missing: ${formatTargetSet(missing)}; ` +
        `unexpected: ${formatTargetSet(unexpected)}`,
    )

  const markerEntry = entries.find((entry) => entry.name === STANDALONE_OUTPUT_MARKER)
  if (!markerEntry?.isFile())
    throw new Error('refusing to replace standalone output with an invalid ownership marker')
  let marker
  try {
    marker = JSON.parse(await readFile(join(outDirectory, STANDALONE_OUTPUT_MARKER), 'utf8'))
  } catch {
    throw new Error('refusing to replace standalone output with an invalid ownership marker')
  }
  if (JSON.stringify(marker) !== JSON.stringify(OUTPUT_MARKER))
    throw new Error('refusing to replace standalone output with an invalid ownership marker')

  for (const directory of ['archives', ...triples]) {
    const entry = entries.find((candidate) => candidate.name === directory)
    if (!entry?.isDirectory())
      throw new Error(`refusing to replace standalone output with invalid '${directory}' entry`)
  }
  const expectedArchives = new Set([
    'standalone-checksums.sha256',
    ...triples.map(archiveNameForTarget),
  ])
  const archiveEntries = await readdir(join(outDirectory, 'archives'), { withFileTypes: true })
  if (
    archiveEntries.some((entry) => !entry.isFile() || !expectedArchives.has(entry.name)) ||
    archiveEntries.length !== expectedArchives.size
  )
    throw new Error('refusing to replace standalone output with an invalid archives allowlist')

  const expectedChecksums = []
  for (const triple of triples) {
    const archiveName = archiveNameForTarget(triple)
    const archivedBody = await readFile(join(outDirectory, 'archives', archiveName))
    const rebuiltBody = await createCanonicalStandaloneArchiveBuffer({
      sourceDirectory: join(outDirectory, triple),
      target: triple,
    })
    if (!archivedBody.equals(rebuiltBody))
      throw new Error(`refusing to replace standalone output with modified '${triple}' contents`)
    expectedChecksums.push(
      `${createHash('sha256').update(archivedBody).digest('hex')}  ${archiveName}`,
    )
  }
  const checksumContents = await readFile(
    join(outDirectory, 'archives', 'standalone-checksums.sha256'),
    'utf8',
  )
  if (checksumContents !== `${expectedChecksums.join('\n')}\n`)
    throw new Error('refusing to replace standalone output with modified archive checksums')
}

async function promoteFreshStandaloneSet(stagingDirectory, outDirectory, triples) {
  const parent = dirname(outDirectory)
  let backupDirectory
  await assertReplaceableOutput(outDirectory, triples)
  if (await pathExists(outDirectory)) {
    backupDirectory = await mkdtemp(join(parent, '.standalone-backup-'))
    await rm(backupDirectory, { recursive: true })
    await rename(outDirectory, backupDirectory)
  }
  try {
    await rename(stagingDirectory, outDirectory)
  } catch (error) {
    if (backupDirectory) await rename(backupDirectory, outDirectory)
    throw error
  }
  if (backupDirectory) await rm(backupDirectory, { recursive: true, force: true })
}

export async function buildAllStandalone({
  root,
  assetsDirectory,
  metadataDirectory,
  outDirectory,
  allowPartialTargets = false,
  buildStandaloneFn = buildStandalone,
}) {
  if (!metadataDirectory) throw new Error('metadataDirectory is required for standalone builds')
  await preflightMetadataDirectory(metadataDirectory)
  const entries = await readdir(assetsDirectory, { withFileTypes: true })
  const triples = discoverStandaloneTargets(entries, { allowPartialTargets })

  const out = resolve(outDirectory ?? join(root, 'apps/cli/dist/standalone'))
  await assertSafeOutputDirectory({ outDirectory: out, root, assetsDirectory, metadataDirectory })
  await assertReplaceableOutput(out, triples)
  const parent = dirname(out)
  await mkdir(parent, { recursive: true })
  const stagingDirectory = await mkdtemp(join(parent, '.standalone-staging-'))
  try {
    const archives = join(stagingDirectory, 'archives')
    await mkdir(archives)
    const sums = []
    for (const triple of triples) {
      console.log(`standalone[${triple}]: building`)
      const built = await buildStandaloneFn({
        root,
        target: triple,
        assetDirectory: assetsDirectory,
        outDirectory: join(stagingDirectory, triple),
      })
      const expectedBuiltOut = join(stagingDirectory, triple)
      if (resolve(built.out) !== resolve(expectedBuiltOut))
        throw new Error(`standalone builder returned an unexpected output directory for ${triple}`)
      const builtMetadata = await lstat(built.out)
      if (!builtMetadata.isDirectory() || builtMetadata.isSymbolicLink())
        throw new Error(`standalone builder output must be a regular directory for ${triple}`)
      for (const file of REQUIRED_STANDALONE_METADATA_FILES)
        await copyFile(join(metadataDirectory, file), join(built.out, file))
      const archiveName = archiveNameForTarget(triple)
      const archive = join(archives, archiveName)
      const archiveBody = await createCanonicalStandaloneArchive({
        sourceDirectory: built.out,
        archivePath: archive,
        target: triple,
      })
      sums.push(`${createHash('sha256').update(archiveBody).digest('hex')}  ${archiveName}`)
    }
    await writeFile(join(archives, 'standalone-checksums.sha256'), `${sums.join('\n')}\n`)
    await writeFile(
      join(stagingDirectory, STANDALONE_OUTPUT_MARKER),
      `${JSON.stringify(OUTPUT_MARKER, null, 2)}\n`,
    )
    await promoteFreshStandaloneSet(stagingDirectory, out, triples)
    console.log(`standalone: ${triples.length} targets -> ${join(out, 'archives')}`)
    return triples
  } catch (error) {
    await rm(stagingDirectory, { recursive: true, force: true })
    throw error
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const root = resolve(import.meta.dirname, '../..')
  const assetsDirectory = process.argv[2]
  const metadataDirectory = process.argv[3]
  if (!assetsDirectory || !metadataDirectory)
    throw new Error(
      'usage: node scripts/release/build-all-standalone.mjs <assetsDir> <metadataDir> [outDir]',
    )
  await buildAllStandalone({
    root,
    assetsDirectory: resolve(assetsDirectory),
    metadataDirectory: resolve(metadataDirectory),
    outDirectory: process.argv[4] ? resolve(process.argv[4]) : undefined,
  })
}
