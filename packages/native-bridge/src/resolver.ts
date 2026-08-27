import { createHash } from 'node:crypto'
import { access, chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import nativePackage from '../package.json' with { type: 'json' }

const packageVersion = nativePackage.version
export type BinaryKind = 'sandbox' | 'search' | 'fs'
export interface NativeResolution {
  kind: BinaryKind
  path: string | null
  source: 'override' | 'bundled' | 'cache' | 'download' | 'unavailable'
  target: string | null
  error?: 'unsupported-platform' | 'missing' | 'tampered'
}

const releaseRepository = 'JS-mark/volund-code'

export function packageTriple(
  platform: NodeJS.Platform,
  runtimeArch: string,
  libc?: 'glibc' | 'musl',
): string | null {
  const arch = runtimeArch === 'arm64' ? 'arm64' : runtimeArch === 'x64' ? 'x64' : null
  if (!arch) return null
  if (platform === 'darwin') return `darwin-${arch}`
  if (platform === 'linux') return `linux-${arch}-${libc === 'musl' ? 'musl' : 'gnu'}`
  if (platform === 'win32') return `win32-${arch}-msvc`
  return null
}

function runtimeLibc(): 'glibc' | 'musl' | undefined {
  if (process.platform !== 'linux') return undefined
  const report = process.report.getReport()
  if (!('header' in report) || typeof report.header !== 'object' || report.header === null)
    return 'musl'
  return 'glibcVersionRuntime' in report.header ? 'glibc' : 'musl'
}

export function releaseAssetName(kind: BinaryKind, triple: string): string {
  return `volund-${kind}-${triple}${triple.startsWith('win32-') ? '.exe' : ''}`
}

/**
 * standalone 产物目录。常规 node 运行取 import.meta.url 旁（dist 单文件布局）；
 * bun --compile 后模块内嵌在虚拟 /$bunfs/ 路径下，磁盘上唯一真实锚点是
 * 可执行文件自身（process.execPath），native/ 与 plugins/ 随它分发。
 */
export function standaloneArtifactDir(importMetaUrl: string, execPath: string): string {
  if (importMetaUrl.includes('/$bunfs/')) return dirname(execPath)
  return dirname(fileURLToPath(importMetaUrl))
}

function checksumFor(manifest: string, assetName: string): string | null {
  for (const line of manifest.split('\n')) {
    const match = /^([a-f\d]{64})\s+\*?(.+)$/.exec(line.trim())
    if (match?.[2] === assetName) return match[1] ?? null
  }
  return null
}

async function sha256(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
}

async function verifiedPath(path: string, expected: string): Promise<boolean> {
  try {
    return (await sha256(path)) === expected
  } catch {
    return false
  }
}

async function bundledBinary(kind: BinaryKind, triple: string): Promise<string | null> {
  const root =
    process.env.VOLUND_STANDALONE_ASSET_DIR ??
    join(standaloneArtifactDir(import.meta.url, process.execPath), 'native')
  const manifestPath = join(root, 'manifest.json')
  try {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      schemaVersion: number
      assets: Array<{ kind: BinaryKind; target: string; file: string; sha256: string }>
    }
    if (manifest.schemaVersion !== 1) return null
    const asset = manifest.assets.find((item) => item.kind === kind && item.target === triple)
    if (!asset || asset.file !== releaseAssetName(kind, triple)) return null
    const path = join(root, asset.file)
    if (!(await verifiedPath(path, asset.sha256)))
      throw new Error(`Checksum mismatch for bundled native asset ${asset.file}`)
    await chmod(path, 0o755).catch(() => undefined)
    return path
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Checksum mismatch')) throw error
    return null
  }
}

async function fetchReleaseBinary(
  kind: BinaryKind,
  triple: string,
): Promise<{ path: string; source: 'cache' | 'download' } | null> {
  const version = process.env.VOLUND_VERSION ?? packageVersion
  if (!version || version === '0.0.0') return null

  const tag = version.startsWith('v') ? version : `v${version}`
  const assetName = releaseAssetName(kind, triple)
  const releaseBase =
    process.env.VOLUND_NATIVE_RELEASE_BASE_URL ??
    `https://github.com/${releaseRepository}/releases/download/${tag}`
  const cacheRoot =
    process.env.VOLUND_NATIVE_CACHE_DIR ?? join(homedir(), '.cache', 'volund-code', 'native')
  const targetDirectory = join(cacheRoot, tag, triple)
  const binaryPath = join(targetDirectory, assetName)
  const checksumPath = join(cacheRoot, tag, 'checksums.sha256')
  const checksumUrl = `${releaseBase}/checksums.sha256`

  await mkdir(targetDirectory, { recursive: true })
  try {
    const cachedExpected = checksumFor(await readFile(checksumPath, 'utf8'), assetName)
    if (cachedExpected && (await verifiedPath(binaryPath, cachedExpected)))
      return { path: binaryPath, source: 'cache' }
  } catch {
    // A cache miss is expected on first use.
  }

  let checksumResponse: Response
  try {
    checksumResponse = await fetch(checksumUrl, { signal: AbortSignal.timeout(15_000) })
  } catch {
    return null
  }
  if (!checksumResponse.ok) return null
  const checksumManifest = await checksumResponse.text()
  const expected = checksumFor(checksumManifest, assetName)
  if (!expected) return null
  await writeFile(checksumPath, checksumManifest)

  try {
    if (await verifiedPath(binaryPath, expected)) return { path: binaryPath, source: 'cache' }
    await rm(binaryPath, { force: true })
  } catch {
    // A cache miss is expected on first use.
  }

  let binaryResponse: Response
  try {
    binaryResponse = await fetch(`${releaseBase}/${assetName}`, {
      signal: AbortSignal.timeout(15_000),
    })
  } catch {
    return null
  }
  if (!binaryResponse.ok) return null
  const temporaryPath = `${binaryPath}.${process.pid}.tmp`
  try {
    await writeFile(temporaryPath, Buffer.from(await binaryResponse.arrayBuffer()), { mode: 0o755 })
    if ((await sha256(temporaryPath)) !== expected)
      throw new Error(`Checksum mismatch for native asset ${assetName}`)
    await chmod(temporaryPath, 0o755)
    await rename(temporaryPath, binaryPath)
    return { path: binaryPath, source: 'download' }
  } finally {
    await rm(temporaryPath, { force: true })
  }
}

export async function resolveBinaryDetailed(kind: BinaryKind): Promise<NativeResolution> {
  const override = process.env[`VOLUND_NATIVE_${kind.toUpperCase()}_BINARY`]
  if (override) {
    await access(override)
    return { kind, path: override, source: 'override', target: null }
  }
  const triple = packageTriple(process.platform, process.arch, runtimeLibc())
  if (!triple)
    return { kind, path: null, source: 'unavailable', target: null, error: 'unsupported-platform' }
  const bundled = await bundledBinary(kind, triple)
  if (bundled) return { kind, path: bundled, source: 'bundled', target: triple }
  const fetched = await fetchReleaseBinary(kind, triple)
  if (fetched) return { kind, path: fetched.path, source: fetched.source, target: triple }
  return { kind, path: null, source: 'unavailable', target: triple, error: 'missing' }
}

export async function resolveBinary(kind: BinaryKind): Promise<string | null> {
  return (await resolveBinaryDetailed(kind)).path
}
