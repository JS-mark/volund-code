import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { PluginError, permissionHash } from '@apollo-code/plugin-runtime'
import type { PluginManifest } from '@apollo-code/plugin-sdk'

export type LocalPluginSource = 'builtin' | 'dev' | 'market'

export interface LocalPluginStateEntry {
  readonly name: string
  readonly version: string
  readonly source: LocalPluginSource
  readonly dir: string
  readonly permissionHash: string
  readonly approvedVersion?: string
  readonly approvedPermissionHash?: string
  readonly enabled: boolean
  readonly failures: number
}

interface LocalPluginStateFile {
  readonly schemaVersion: 2
  readonly plugins: Record<string, LocalPluginStateEntry>
}

const PLUGIN_NAME = /^apollo-plugin-[a-z0-9][a-z0-9._-]{0,127}$/
const SHA256 = /^[a-f0-9]{64}$/
const MAX_STATE_BYTES = 1024 * 1024
const MAX_PLUGINS = 1024

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

function parseEntry(name: string, value: unknown): LocalPluginStateEntry {
  if (
    !PLUGIN_NAME.test(name) ||
    !isRecord(value) ||
    value.name !== name ||
    typeof value.version !== 'string' ||
    !['builtin', 'dev', 'market'].includes(String(value.source)) ||
    typeof value.dir !== 'string' ||
    !value.dir ||
    typeof value.permissionHash !== 'string' ||
    !SHA256.test(value.permissionHash) ||
    typeof value.enabled !== 'boolean' ||
    !Number.isSafeInteger(value.failures) ||
    Number(value.failures) < 0 ||
    (value.approvedVersion !== undefined && typeof value.approvedVersion !== 'string') ||
    (value.approvedPermissionHash !== undefined &&
      (typeof value.approvedPermissionHash !== 'string' || !SHA256.test(value.approvedPermissionHash)))
  )
    throw new PluginError('plugin_state_invalid', `invalid v2 lifecycle entry: ${name}`)
  return {
    name,
    version: value.version,
    source: value.source as LocalPluginSource,
    dir: value.dir,
    permissionHash: value.permissionHash,
    ...(typeof value.approvedVersion === 'string'
      ? { approvedVersion: value.approvedVersion }
      : {}),
    ...(typeof value.approvedPermissionHash === 'string'
      ? { approvedPermissionHash: value.approvedPermissionHash }
      : {}),
    enabled: value.enabled,
    failures: Number(value.failures),
  }
}

function parseState(value: unknown): LocalPluginStateFile {
  if (!isRecord(value) || value.schemaVersion !== 2 || !isRecord(value.plugins))
    throw new PluginError('plugin_state_invalid', 'expected plugin lifecycle schemaVersion 2')
  const entries = Object.entries(value.plugins)
  if (entries.length > MAX_PLUGINS)
    throw new PluginError('plugin_state_invalid', `too many plugins (>${MAX_PLUGINS})`)
  const plugins: Record<string, LocalPluginStateEntry> = Object.create(null)
  for (const [name, entry] of entries) plugins[name] = parseEntry(name, entry)
  return { schemaVersion: 2, plugins }
}

const emptyState = (): LocalPluginStateFile => ({
  schemaVersion: 2,
  plugins: Object.create(null) as Record<string, LocalPluginStateEntry>,
})

/**
 * Local/builtin/market 插件唯一的 v2 生命周期状态源。
 *
 * legacy Catalog 的 `plugins/plugins.json` 保持 deny-only，且永远不在这里读取或写入。
 * 市场插件的安装、批准、启用和装载是四个不同状态；版本或权限哈希变化会撤销批准。
 */
export class LocalPluginStateStore {
  readonly path: string
  private state: LocalPluginStateFile = emptyState()
  private ready?: Promise<void>

  constructor(home: string) {
    this.path = join(home, 'plugin-state.v2.json')
  }

  init(): Promise<void> {
    return (this.ready ??= this.load())
  }

  private async load(): Promise<void> {
    try {
      const stat = await lstat(this.path)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_STATE_BYTES)
        throw new PluginError('plugin_state_invalid', this.path)
      this.state = parseState(JSON.parse(await readFile(this.path, 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') this.state = emptyState()
      else throw error
    }
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.tmp-${process.pid}-${Date.now()}`
    await writeFile(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 })
    await rename(temporary, this.path)
  }

  async list(): Promise<readonly LocalPluginStateEntry[]> {
    await this.init()
    return Object.values(this.state.plugins).map((entry) => ({ ...entry }))
  }

  async get(name: string): Promise<LocalPluginStateEntry | undefined> {
    await this.init()
    const entry = Object.hasOwn(this.state.plugins, name) ? this.state.plugins[name] : undefined
    return entry ? { ...entry } : undefined
  }

  async discover(
    manifest: PluginManifest,
    source: LocalPluginSource,
    dir: string,
  ): Promise<LocalPluginStateEntry> {
    await this.init()
    const hash = permissionHash(manifest)
    const previous = this.state.plugins[manifest.name]
    const trustedLocal = source === 'builtin' || source === 'dev'
    const approvalStillValid =
      previous?.source === source &&
      previous.version === manifest.version &&
      previous.approvedVersion === manifest.version &&
      previous.approvedPermissionHash === hash
    const entry: LocalPluginStateEntry = {
      name: manifest.name,
      version: manifest.version,
      source,
      dir,
      permissionHash: hash,
      ...(trustedLocal || approvalStillValid
        ? { approvedVersion: manifest.version, approvedPermissionHash: hash }
        : {}),
      enabled: trustedLocal ? (previous?.enabled ?? true) : approvalStillValid && previous.enabled,
      failures: previous?.failures ?? 0,
    }
    this.state.plugins[manifest.name] = entry
    await this.persist()
    return { ...entry }
  }

  async approve(name: string, expectedPermissionHash: string): Promise<LocalPluginStateEntry> {
    const entry = await this.require(name)
    if (entry.permissionHash !== expectedPermissionHash)
      throw new PluginError(
        'plugin_approval_stale',
        `${name} permission hash changed; inspect the plugin and approve ${entry.permissionHash}`,
      )
    const approved: LocalPluginStateEntry = {
      ...entry,
      approvedVersion: entry.version,
      approvedPermissionHash: entry.permissionHash,
    }
    this.state.plugins[name] = approved
    await this.persist()
    return { ...approved }
  }

  async setEnabled(name: string, enabled: boolean): Promise<LocalPluginStateEntry> {
    const entry = await this.require(name)
    if (
      enabled &&
      (entry.approvedVersion !== entry.version ||
        entry.approvedPermissionHash !== entry.permissionHash)
    )
      throw new PluginError(
        'plugin_approval_required',
        `${name} requires approval for ${entry.version} / ${entry.permissionHash}`,
      )
    const next = { ...entry, enabled }
    this.state.plugins[name] = next
    await this.persist()
    return { ...next }
  }

  async remove(name: string): Promise<void> {
    await this.init()
    if (Object.hasOwn(this.state.plugins, name)) {
      delete this.state.plugins[name]
      await this.persist()
    }
  }

  private async require(name: string): Promise<LocalPluginStateEntry> {
    const entry = await this.get(name)
    if (!entry) throw new PluginError('plugin_not_installed', name)
    return entry
  }
}

export const isPluginApproved = (entry: LocalPluginStateEntry): boolean =>
  entry.approvedVersion === entry.version &&
  entry.approvedPermissionHash === entry.permissionHash

