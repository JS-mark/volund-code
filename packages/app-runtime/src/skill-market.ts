/**
 * Skills 市场目录索引（WEB-EXT-MANAGE-MARKET-r1 §S3.6）：读 `[skills] market`
 * 索引 URL → 浏览 → 安装走既有 git 安装通道（SkillPort.install）。
 * 信任语义与 caps 对齐 plugin-market：HTTPS（或回环 http）源、索引 ≤1MiB、
 * 条目 ≤256；skill 安装不执行代码（提示词 + 资源文件），允许远程源直接装。
 */
import { join } from 'node:path'

import { loadTomlFile } from '@volund/config'

import { isTrustedMarketSource } from './plugin-market'

const MAX_INDEX_BYTES = 1024 * 1024
const MAX_ENTRIES = 256
const INDEX_CACHE_TTL_MS = 60_000
const SKILL_NAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/

export interface SkillMarketEntry {
  readonly name: string
  readonly description?: string
  readonly version?: string
  /** SkillPort.install 的 source 形态：本地目录 | git URL | github:owner/repo | owner/repo。 */
  readonly source: string
  readonly homepage?: string
}

export interface SkillMarketView {
  readonly source: string
  readonly entries: readonly SkillMarketEntry[]
}

/**
 * 读 `[skills] market` 配置（用户级 config.toml）。缺省 → undefined；
 * 类型错/不信任源按 config_invalid 拒绝（与 plugin-market readMarketSource 同姿态）。
 */
export async function readSkillMarketSource(home: string): Promise<string | undefined> {
  let config: Record<string, unknown>
  try {
    config = await loadTomlFile(join(home, 'config.toml'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return undefined
  }
  const skills = config.skills
  if (skills === undefined) return undefined
  if (!skills || typeof skills !== 'object' || Array.isArray(skills))
    throw new Error('config_invalid: [skills] must be a table')
  const market = (skills as Record<string, unknown>).market
  if (market === undefined) return undefined
  if (typeof market !== 'string' || !isTrustedMarketSource(market))
    throw new Error(
      'config_invalid: [skills] market must be an HTTPS URL (or loopback http for local sources)',
    )
  return market
}

/** 索引形状校验（结构性上限 + 命名规则；name 必须能成为 skill 目录名）。 */
export function parseSkillMarketIndex(value: unknown): readonly SkillMarketEntry[] {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('skill market index must be an object')
  const record = value as Record<string, unknown>
  if (record.version !== 1) throw new Error('skill market index version must be 1')
  if (!Array.isArray(record.entries)) throw new Error('skill market index entries must be an array')
  if (record.entries.length > MAX_ENTRIES)
    throw new Error(`too many skill entries (>${MAX_ENTRIES})`)
  const entries: SkillMarketEntry[] = []
  for (const raw of record.entries) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      throw new Error('skill market entry must be an object')
    const entry = raw as Record<string, unknown>
    const name = entry.name
    const source = entry.source
    if (typeof name !== 'string' || !SKILL_NAME.test(name) || name.length > 64)
      throw new Error(`skill market entry has invalid name: ${String(name)}`)
    if (typeof source !== 'string' || !source.trim())
      throw new Error(`skill market entry '${name}' has invalid source`)
    entries.push({
      name,
      source,
      ...(typeof entry.description === 'string' && entry.description
        ? { description: entry.description }
        : {}),
      ...(typeof entry.version === 'string' && entry.version ? { version: entry.version } : {}),
      ...(typeof entry.homepage === 'string' && entry.homepage
        ? { homepage: entry.homepage }
        : {}),
    })
  }
  return entries
}

let cached: { source: string; view: SkillMarketView; at: number } | undefined

/** 拉取并解析索引（60s 进程内缓存；未配置 → undefined；失败 → { error } 由面板解释）。 */
export async function fetchSkillMarketIndex(
  home: string,
): Promise<SkillMarketView | { error: string } | undefined> {
  let source: string | undefined
  try {
    source = await readSkillMarketSource(home)
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
  if (!source) return undefined
  const now = Date.now()
  if (cached && cached.source === source && now - cached.at < INDEX_CACHE_TTL_MS) return cached.view
  try {
    const response = await fetch(source)
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`)
    const body = await response.text()
    if (Buffer.byteLength(body, 'utf8') > MAX_INDEX_BYTES)
      throw new Error(`skill market index larger than ${MAX_INDEX_BYTES} bytes`)
    const view: SkillMarketView = { source, entries: parseSkillMarketIndex(JSON.parse(body)) }
    cached = { source, view, at: now }
    return view
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}
