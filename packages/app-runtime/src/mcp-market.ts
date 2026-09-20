/**
 * MCP 目录索引（WEB-EXT-MANAGE-MARKET-r1 §S3.6 + r1.3 默认源）：读 `[mcp] market`
 * 索引 URL → 浏览 → 「安装」= 预填 add 表单、用户确认后落盘（命令注入可见性原则，
 * 不静默安装）。caps 与信任源判定对齐 plugin-market / skill-market。
 *
 * 支持两种文档格式（按 body 形状自动识别）：
 * 1. volund v1 index：`{version: 1, entries: [...]}`；
 * 2. 官方 MCP Registry v0 API（registry.modelcontextprotocol.io，业界通用）：
 *    `{servers: [{server: {name, description, title?, remotes?, packages?}, _meta}]}` →
 *    remotes → http 条目；packages（npm/pypi）→ stdio 条目（npx -y / uvx）。
 *
 * 未配置时使用内置默认源（D-3 被用户决策推翻，2026-09-20）：官方 MCP Registry。
 */
import { join } from 'node:path'

import { loadTomlFile } from '@volund/config'

import { isTrustedMarketSource } from './plugin-market'

const MAX_INDEX_BYTES = 1024 * 1024
const MAX_ENTRIES = 256
const INDEX_CACHE_TTL_MS = 60_000
const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** 内置默认源：官方 MCP Registry v0 API（一页 100 条，registry limit 上限内；够浏览面）。 */
export const DEFAULT_MCP_MARKET_SOURCE =
  'https://registry.modelcontextprotocol.io/v0/servers?limit=100'

export interface McpMarketEntry {
  readonly name: string
  readonly description?: string
  readonly transport: 'stdio' | 'http'
  readonly url?: string
  readonly headers?: Readonly<Record<string, string>>
  readonly command?: string
  readonly args?: readonly string[]
  readonly env?: Readonly<Record<string, string>>
  readonly homepage?: string
}

export interface McpMarketView {
  readonly source: string
  readonly entries: readonly McpMarketEntry[]
  /** true = 用户未配置，正在用内置默认源（UI 显示「默认源」徽标）。 */
  readonly isDefault: boolean
}

/** 读 `[mcp] market` 配置（用户级 config.toml）；缺省 → undefined；不信任源按 config_invalid 拒绝。 */
export async function readMcpMarketSource(home: string): Promise<string | undefined> {
  let config: Record<string, unknown>
  try {
    config = await loadTomlFile(join(home, 'config.toml'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return undefined
  }
  const mcp = config.mcp
  if (mcp === undefined) return undefined
  if (!mcp || typeof mcp !== 'object' || Array.isArray(mcp))
    throw new Error('config_invalid: [mcp] must be a table')
  const market = (mcp as Record<string, unknown>).market
  if (market === undefined) return undefined
  if (typeof market !== 'string' || !isTrustedMarketSource(market))
    throw new Error(
      'config_invalid: [mcp] market must be an HTTPS URL (or loopback http for local sources)',
    )
  return market
}

/** 索引形状校验：stdio 条目必须有 command；http 条目必须有 url。 */
export function parseMcpMarketIndex(value: unknown): readonly McpMarketEntry[] {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('mcp market index must be an object')
  const record = value as Record<string, unknown>
  if (record.version !== 1) throw new Error('mcp market index version must be 1')
  if (!Array.isArray(record.entries)) throw new Error('mcp market index entries must be an array')
  if (record.entries.length > MAX_ENTRIES) throw new Error(`too many mcp entries (>${MAX_ENTRIES})`)
  const entries: McpMarketEntry[] = []
  for (const raw of record.entries) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      throw new Error('mcp market entry must be an object')
    const entry = raw as Record<string, unknown>
    const name = entry.name
    if (typeof name !== 'string' || !SERVER_NAME.test(name))
      throw new Error(`mcp market entry has invalid name: ${String(name)}`)
    const transport = entry.transport
    if (transport !== 'stdio' && transport !== 'http')
      throw new Error(`mcp market entry '${name}' transport must be 'stdio' or 'http'`)
    if (transport === 'stdio' && typeof entry.command !== 'string')
      throw new Error(`mcp market entry '${name}' (stdio) requires command`)
    if (transport === 'http' && typeof entry.url !== 'string')
      throw new Error(`mcp market entry '${name}' (http) requires url`)
    const stringRecord = (value: object, field: string): Record<string, string> => {
      if (Array.isArray(value))
        throw new Error(`mcp market entry '${name}' ${field} must be a table`)
      const out: Record<string, string> = {}
      for (const [key, item] of Object.entries(value)) {
        if (typeof item !== 'string')
          throw new Error(`mcp market entry '${name}' ${field} values must be strings`)
        out[key] = item
      }
      return out
    }
    const isTable = (value: unknown): value is Record<string, unknown> =>
      Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    entries.push({
      name,
      transport,
      ...(typeof entry.description === 'string' && entry.description
        ? { description: entry.description }
        : {}),
      ...(typeof entry.url === 'string' && entry.url ? { url: entry.url } : {}),
      ...(isTable(entry.headers) ? { headers: stringRecord(entry.headers, 'headers') } : {}),
      ...(typeof entry.command === 'string' && entry.command ? { command: entry.command } : {}),
      ...(Array.isArray(entry.args) && entry.args.every((item) => typeof item === 'string')
        ? { args: entry.args as string[] }
        : {}),
      ...(isTable(entry.env) ? { env: stringRecord(entry.env, 'env') } : {}),
      ...(typeof entry.homepage === 'string' && entry.homepage ? { homepage: entry.homepage } : {}),
    })
  }
  return entries
}

/**
 * 官方 MCP Registry v0 适配器（r1.3）：`servers[].server` → v1 entries。
 * 仅收 status=active；remotes → http（取第一个）；packages → stdio
 * （npm → `npx -y <identifier>`，pypi → `uvx <identifier>`）；展示名用 title，
 * 无则 name 里的 `/` 规整为 `-`（须过 SERVER_NAME）；按 name 去重保序。
 */
export function parseMcpRegistryDocument(value: unknown): readonly McpMarketEntry[] {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('mcp registry document must be an object')
  const servers = (value as Record<string, unknown>).servers
  if (!Array.isArray(servers)) throw new Error('mcp registry document requires servers[]')
  const entries: McpMarketEntry[] = []
  const seen = new Set<string>()
  for (const raw of servers) {
    if (entries.length >= MAX_ENTRIES) break
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const wrapper = raw as Record<string, unknown>
    const server = wrapper.server
    if (!server || typeof server !== 'object' || Array.isArray(server)) continue
    const record = server as Record<string, unknown>
    const meta = wrapper._meta
    const official =
      meta && typeof meta === 'object' && !Array.isArray(meta)
        ? (meta as Record<string, Record<string, unknown>>)[
            'io.modelcontextprotocol.registry/official'
          ]
        : undefined
    if (official && official.status !== undefined && official.status !== 'active') continue
    const rawName = typeof record.name === 'string' ? record.name : ''
    if (!rawName) continue
    const display =
      typeof record.title === 'string' && record.title.trim() ? record.title.trim() : rawName
    const name = (SERVER_NAME.test(display) ? display : display.replace(/\//g, '-')).slice(0, 64)
    if (!SERVER_NAME.test(name) || seen.has(name)) continue
    const description = typeof record.description === 'string' ? record.description : undefined
    const remotes = Array.isArray(record.remotes) ? record.remotes : []
    const packages = Array.isArray(record.packages) ? record.packages : []
    const firstRemote = remotes.find(
      (item): item is Record<string, unknown> =>
        Boolean(item) &&
        typeof item === 'object' &&
        !Array.isArray(item) &&
        typeof (item as Record<string, unknown>).url === 'string',
    )
    const firstPackage = packages.find(
      (item): item is Record<string, unknown> =>
        Boolean(item) &&
        typeof item === 'object' &&
        !Array.isArray(item) &&
        typeof (item as Record<string, unknown>).identifier === 'string',
    )
    if (firstRemote?.url) {
      seen.add(name)
      entries.push({
        name,
        ...(description ? { description } : {}),
        transport: 'http',
        url: firstRemote.url as string,
      })
      continue
    }
    if (firstPackage) {
      const registryType = String(firstPackage.registryType ?? 'npm')
      const identifier = firstPackage.identifier as string
      const command = registryType === 'pypi' ? 'uvx' : 'npx'
      const args = registryType === 'pypi' ? [identifier] : ['-y', identifier]
      seen.add(name)
      entries.push({
        name,
        ...(description ? { description } : {}),
        transport: 'stdio',
        command,
        args,
      })
    }
  }
  return entries
}

/** 按 body 形状自动识别格式并解析（volund v1 index 优先，官方 registry 次之）。 */
export function parseMcpMarketDocument(value: unknown): readonly McpMarketEntry[] {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>
    if (record.version === 1 && Array.isArray(record.entries)) return parseMcpMarketIndex(value)
    if (Array.isArray(record.servers)) return parseMcpRegistryDocument(value)
  }
  throw new Error('unrecognized mcp market document shape')
}

let cached: { source: string; view: McpMarketView; at: number } | undefined

/** 拉取并解析索引（60s 进程内缓存；未配置 → 内置默认源；失败 → { error } 由面板解释）。 */
export async function fetchMcpMarketIndex(
  home: string,
): Promise<McpMarketView | { error: string } | undefined> {
  let source = DEFAULT_MCP_MARKET_SOURCE
  let isDefault = true
  try {
    const configured = await readMcpMarketSource(home)
    if (configured) {
      source = configured
      isDefault = false
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
  const now = Date.now()
  if (cached && cached.source === source && now - cached.at < INDEX_CACHE_TTL_MS) return cached.view
  try {
    const response = await fetch(source, { signal: AbortSignal.timeout(15_000) })
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`)
    const body = await response.text()
    if (Buffer.byteLength(body, 'utf8') > MAX_INDEX_BYTES)
      throw new Error(`mcp market index larger than ${MAX_INDEX_BYTES} bytes`)
    const view: McpMarketView = {
      source,
      entries: parseMcpMarketDocument(JSON.parse(body)),
      isDefault,
    }
    cached = { source, view, at: now }
    return view
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}
