/**
 * PLUGIN-MANAGER-r1 市场链路（宿主侧）：`[plugins] market` 指向市场索引 URL，
 * 索引列出可安装插件（name / version / files[]，每个文件带 sha256 digest）。
 * 安装 = 逐文件下载到 staging（同源校验 + digest 校验 + manifest 校验 +
 * verifyBundle）→ 落盘 `~/.volund/plugins/<name>/`。生命周期由同级
 * `plugin-state.v2.json` 统一管理；legacy `plugins/plugins.json` 保持 deny-only。
 * 沙箱内无网络——市场拉取/安装全部由宿主完成，插件只经 `volund.plugins.*`
 * 桥方法触发。
 *
 * 信任模型：索引浏览允许规范 HTTPS；可执行安装在签名信任根接入前只允许回环
 * http 开发源。HTTPS 只能保证传输完整性，不能替代发布者签名，因此远程未签名
 * 市场必须 fail closed。逐文件 sha256、同源约束和激活期重验仍是纵深防御。
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { loadTomlFile } from '@volund/config'
import { PluginError, validateManifest, verifyBundle } from '@volund/plugin-runtime'
import type { PluginManifest } from '@volund/plugin-sdk'

/** 与 plugin-runtime 的 PLUGIN_NAME 同源约束（模块私有，这里重声明）。 */
const PLUGIN_NAME = /^volund-plugin-[a-z0-9][a-z0-9._-]{0,127}$/
const SAFE_FILE_PATH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/
const DIGEST = /^sha256-[a-f0-9]{64}$/
const MAX_INDEX_BYTES = 1024 * 1024
const MAX_PLUGIN_ENTRIES = 256
const MAX_FILES_PER_PLUGIN = 64
const MAX_FILE_BYTES = 8 * 1024 * 1024
const FETCH_TIMEOUT_MS = 8_000

export interface MarketFileSpec {
  readonly path: string
  readonly digest: `sha256-${string}`
}
export interface MarketPluginEntry {
  readonly name: string
  readonly version: string
  readonly description?: string
  readonly publisher?: string
  readonly files: readonly MarketFileSpec[]
}
export interface MarketIndex {
  readonly schemaVersion: 1
  readonly plugins: readonly MarketPluginEntry[]
}

/** 市场插件安装根：~/.volund/plugins（发现不等于激活，v2 状态决定 eligibility）。 */
export const marketInstallRoot = (home: string) => join(home, 'plugins')

const loopbackHost = (hostname: string) =>
  hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1'

/**
 * 可信市场源：规范 HTTPS URL（无凭据 / query / fragment），或回环 http
 * （localhost / 127.0.0.1 / [::1]，供测试与自建本地源）。LAN http 一律拒绝。
 */
export function isTrustedMarketSource(value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.username || url.password || url.search || url.hash) return false
  if (url.protocol === 'https:') return url.toString() === value
  return url.protocol === 'http:' && loopbackHost(url.hostname) && url.toString() === value
}

/** 当前唯一可执行安装源；远程 HTTPS 等签名/吊销信任根接入后再开放。 */
export function isLocalMarketSource(value: string): boolean {
  if (!isTrustedMarketSource(value)) return false
  const url = new URL(value)
  return url.protocol === 'http:' && loopbackHost(url.hostname)
}

/**
 * 读 `[plugins] market` 配置（用户级 config.toml）。缺省 → undefined（未配置
 * 市场，/plugins 的市场页签给出配置指引）；类型错按 C.1 抛 config_invalid。
 */
export async function readMarketSource(home: string): Promise<string | undefined> {
  let config: Record<string, unknown>
  try {
    config = await loadTomlFile(join(home, 'config.toml'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return undefined
  }
  const plugins = config.plugins
  if (plugins === undefined) return undefined
  if (!plugins || typeof plugins !== 'object' || Array.isArray(plugins))
    throw new Error('config_invalid: [plugins] must be a table')
  const market = (plugins as Record<string, unknown>).market
  if (market === undefined) return undefined
  if (typeof market !== 'string' || !isTrustedMarketSource(market))
    throw new Error(
      'config_invalid: [plugins] market must be an HTTPS URL (or loopback http for local sources)',
    )
  return market
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const safeFilePath = (value: string) =>
  SAFE_FILE_PATH.test(value) && !value.split('/').includes('..')

/** 索引形状校验（防注册源投毒的结构性上限 + 路径安全）。 */
export function parseMarketIndex(value: unknown): MarketIndex {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.plugins))
    throw new PluginError(
      'plugin_market_index_invalid',
      'expected { schemaVersion: 1, plugins: [] }',
    )
  if (value.plugins.length > MAX_PLUGIN_ENTRIES)
    throw new PluginError(
      'plugin_market_index_invalid',
      `too many plugins (>${MAX_PLUGIN_ENTRIES})`,
    )
  const plugins: MarketPluginEntry[] = []
  for (const raw of value.plugins) {
    if (!isRecord(raw)) throw new PluginError('plugin_market_index_invalid', 'plugin entry shape')
    const entry: MarketPluginEntry = {
      name: String(raw.name),
      version: String(raw.version),
      ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
      ...(typeof raw.publisher === 'string' ? { publisher: raw.publisher } : {}),
      files: Array.isArray(raw.files)
        ? raw.files.map((file) => {
            if (!isRecord(file) || typeof file.path !== 'string' || typeof file.digest !== 'string')
              throw new PluginError('plugin_market_index_invalid', 'file entry shape')
            return { path: file.path, digest: file.digest as `sha256-${string}` }
          })
        : [],
    }
    if (!PLUGIN_NAME.test(entry.name))
      throw new PluginError('plugin_market_index_invalid', `unsafe plugin name: ${entry.name}`)
    if (!entry.version || entry.version.length > 128)
      throw new PluginError('plugin_market_index_invalid', `bad version for ${entry.name}`)
    if (!entry.files.length || entry.files.length > MAX_FILES_PER_PLUGIN)
      throw new PluginError('plugin_market_index_invalid', `bad files count for ${entry.name}`)
    const paths = new Set<string>()
    for (const file of entry.files) {
      if (!safeFilePath(file.path) || !DIGEST.test(file.digest))
        throw new PluginError(
          'plugin_market_index_invalid',
          `unsafe file path/digest in ${entry.name}`,
        )
      if (paths.has(file.path))
        throw new PluginError('plugin_market_index_invalid', `duplicate file path in ${entry.name}`)
      paths.add(file.path)
    }
    if (!paths.has('manifest.json'))
      throw new PluginError('plugin_market_index_invalid', `${entry.name} has no manifest.json`)
    plugins.push(entry)
  }
  return { schemaVersion: 1, plugins }
}

/** 拉市场索引（带超时与体积上限；可选外部 deadline 共享给整个安装流程）。 */
export async function fetchMarketIndex(source: string, signal?: AbortSignal): Promise<MarketIndex> {
  const response = await fetch(source, {
    signal: signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { accept: 'application/json' },
  })
  if (!response.ok)
    throw new PluginError(
      'plugin_market_fetch_failed',
      `index ${source} responded ${response.status}`,
    )
  const body = await response.text()
  if (body.length > MAX_INDEX_BYTES)
    throw new PluginError(
      'plugin_market_fetch_failed',
      `index larger than ${MAX_INDEX_BYTES} bytes`,
    )
  try {
    return parseMarketIndex(JSON.parse(body))
  } catch (error) {
    if (error instanceof PluginError) throw error
    throw new PluginError('plugin_market_fetch_failed', `index ${source} is not valid JSON`)
  }
}

/**
 * 文件下载地址：索引 URL 的 origin 下 `<plugin-name>/<path>`（file.path 是
 * 插件目录内相对路径）。解析后强制同源——注册源不得把下载指向第三方。
 */
function fileUrl(source: string, pluginName: string, path: string): string {
  const url = new URL(`${pluginName}/${path}`, source)
  if (url.origin !== new URL(source).origin)
    throw new PluginError(
      'plugin_market_source_pollution',
      `file ${path} escaped the market source`,
    )
  return url.toString()
}

async function fetchVerifiedFile(
  source: string,
  pluginName: string,
  file: MarketFileSpec,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const response = await fetch(fileUrl(source, pluginName, file.path), {
    signal: signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!response.ok)
    throw new PluginError(
      'plugin_market_fetch_failed',
      `file ${file.path} responded ${response.status}`,
    )
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength > MAX_FILE_BYTES)
    throw new PluginError(
      'plugin_market_fetch_failed',
      `file ${file.path} larger than ${MAX_FILE_BYTES} bytes`,
    )
  const actual = createHash('sha256').update(bytes).digest('hex')
  if (actual !== file.digest.slice('sha256-'.length))
    throw new PluginError('plugin_integrity_failed', `digest mismatch: ${file.path}`)
  return bytes
}

/**
 * 市场插件安装元数据（写在插件目录内）：装载时把 files 映射传给 verifyBundle，
 * 每次激活都对已安装文件做完整性重验（本地篡改即拒载）。
 */
export interface MarketInstallMetadata {
  readonly schemaVersion: 1
  readonly name: string
  readonly version: string
  readonly source: string
  readonly installedAt: string
  readonly files: readonly MarketFileSpec[]
}

export async function readMarketMetadata(dir: string): Promise<MarketInstallMetadata | undefined> {
  let serialized: string
  try {
    serialized = await readFile(join(dir, 'volund-market.json'), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return undefined
  }
  const value: unknown = JSON.parse(serialized)
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.files))
    throw new PluginError('plugin_market_metadata_invalid', `${dir}/volund-market.json`)
  const metadata: MarketInstallMetadata = {
    schemaVersion: 1,
    name: String(value.name),
    version: String(value.version),
    source: String(value.source),
    installedAt: String(value.installedAt ?? ''),
    files: value.files.map((file) => {
      if (!isRecord(file) || typeof file.path !== 'string' || typeof file.digest !== 'string')
        throw new PluginError('plugin_market_metadata_invalid', `${dir}/volund-market.json`)
      return { path: file.path, digest: file.digest as `sha256-${string}` }
    }),
  }
  if (!PLUGIN_NAME.test(metadata.name))
    throw new PluginError('plugin_market_metadata_invalid', `unsafe name in ${dir}`)
  return metadata
}

/** 装载期完整性映射（volund-market.json → verifyBundle 的输入形状）。 */
export async function readMarketIntegrity(dir: string): Promise<Record<string, string>> {
  const metadata = await readMarketMetadata(dir)
  if (!metadata) return {}
  return Object.fromEntries(metadata.files.map((file) => [file.path, file.digest]))
}

/**
 * 安装市场插件：staging 下载（digest 逐文件校验）→ manifest/engines 校验 →
 * verifyBundle → 写 volund-market.json → 原子换入 `~/.volund/plugins/<name>/`。
 * 任何失败清理 staging，目标目录不动（旧版本可继续用）。
 */
export async function installFromMarket(options: {
  home: string
  source: string
  entry: MarketPluginEntry
  volundVersion: string
  /** 整个安装流程的共享 deadline（索引 + 全部文件）；缺省每 fetch 独立超时。 */
  signal?: AbortSignal
}): Promise<{ name: string; version: string; dir: string; manifest: PluginManifest }> {
  const { home, source, entry, volundVersion, signal } = options
  if (!isTrustedMarketSource(source)) throw new PluginError('plugin_market_source_invalid', source)
  if (!isLocalMarketSource(source))
    throw new PluginError(
      'plugin_registry_signature_required',
      'remote market installs require a verified publisher signature and trusted key; use a loopback source only for local development',
    )
  const root = marketInstallRoot(home)
  const target = join(root, entry.name)
  const staging = join(root, `.staging-${entry.name}-${process.pid}-${Date.now()}`)
  await mkdir(staging, { recursive: true })
  try {
    for (const file of entry.files) {
      const bytes = await fetchVerifiedFile(source, entry.name, file, signal)
      const path = join(staging, file.path)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, bytes)
    }
    const manifest = validateManifest(
      JSON.parse(await readFile(join(staging, 'manifest.json'), 'utf8')),
      volundVersion,
    )
    if (manifest.name !== entry.name || manifest.version !== entry.version)
      throw new PluginError(
        'plugin_market_metadata_invalid',
        `index says ${entry.name}@${entry.version}, manifest says ${manifest.name}@${manifest.version}`,
      )
    const integrity = Object.fromEntries(entry.files.map((file) => [file.path, file.digest]))
    await verifyBundle(staging, manifest, integrity)
    const metadata: MarketInstallMetadata = {
      schemaVersion: 1,
      name: entry.name,
      version: entry.version,
      source,
      installedAt: new Date().toISOString(),
      files: entry.files,
    }
    await writeFile(join(staging, 'volund-market.json'), `${JSON.stringify(metadata, null, 2)}\n`)
    await mkdir(root, { recursive: true })
    await rm(target, { recursive: true, force: true })
    await rename(staging, target)
    return { name: entry.name, version: entry.version, dir: target, manifest }
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    throw error
  }
}

/** 卸载市场插件：删除 `~/.volund/plugins/<name>/`（停用由调用方先完成）。 */
export async function uninstallMarketDir(home: string, name: string): Promise<void> {
  if (!PLUGIN_NAME.test(name)) throw new PluginError('plugin_not_installed', name)
  const metadata = await readMarketMetadata(join(marketInstallRoot(home), name)).catch(
    () => undefined,
  )
  if (!metadata)
    throw new PluginError('plugin_not_installed', `${name} is not a market-installed plugin`)
  await rm(join(marketInstallRoot(home), name), { recursive: true, force: true })
}

/** 名字规整：允许裸短名（env → volund-plugin-env）与全名两种输入。 */
export function normalizePluginName(input: string): string {
  const trimmed = input.trim()
  return PLUGIN_NAME.test(trimmed) ? trimmed : `volund-plugin-${trimmed}`
}
