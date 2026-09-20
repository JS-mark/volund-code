/**
 * Skills 市场目录索引（WEB-EXT-MANAGE-MARKET-r1 §S3.6 + r1.3 默认源）：读
 * `[skills] market` 索引 URL → 浏览 → 安装走既有 git 安装通道（SkillPort.install）。
 *
 * 支持两种文档格式（按 body 形状自动识别）：
 * 1. volund v1 index：`{version: 1, entries: [{name, source, ...}]}`；
 * 2. Claude 插件市场清单（.claude-plugin/marketplace.json，业界通用）：
 *    `{plugins: [{name, description, skills: ["./skills/xlsx", ...]}]}` →
 *    展开为 per-skill 条目，source = GitHub 子目录 tree URL（parseGithubTreeSpec 支持）。
 *
 * 未配置时使用内置默认源（D-3 被用户决策推翻，2026-09-20）：anthropics/skills
 * 官方市场清单。信任语义与 caps 对齐 plugin-market：HTTPS（或回环 http）源、
 * 索引 ≤1MiB、条目 ≤256；skill 安装不执行代码，允许远程源直接装。
 */
import { join } from 'node:path'

import { loadTomlFile } from '@volund/config'

import { isTrustedMarketSource } from './plugin-market'

const MAX_INDEX_BYTES = 1024 * 1024
const MAX_ENTRIES = 256
const INDEX_CACHE_TTL_MS = 60_000
const SKILL_NAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/

/**
 * 内置默认源：Anthropic 官方 skills 仓库的市场清单（Claude marketplace 格式）。
 * 走 jsDelivr CDN（raw.githubusercontent 在部分网络不可达；内容同一仓库同一 ref）。
 */
export const DEFAULT_SKILL_MARKET_SOURCE =
  'https://cdn.jsdelivr.net/gh/anthropics/skills@main/.claude-plugin/marketplace.json'
/** 默认源对应的仓库根（拼 per-skill tree URL 用）。 */
export const DEFAULT_SKILL_MARKET_REPO = 'https://github.com/anthropics/skills/tree/main'

export interface SkillMarketEntry {
  readonly name: string
  readonly description?: string
  readonly version?: string
  /** SkillPort.install 的 source 形态：本地目录 | git URL | github tree URL 等。 */
  readonly source: string
  readonly homepage?: string
}

export interface SkillMarketView {
  readonly source: string
  readonly entries: readonly SkillMarketEntry[]
  /** true = 用户未配置，正在用内置默认源（UI 显示「默认源」徽标）。 */
  readonly isDefault: boolean
}

/**
 * 读 `[skills] market` 配置（用户级 config.toml）。缺省 → undefined（由 fetch
 * 回落默认源）；类型错/不信任源按 config_invalid 拒绝（与 plugin-market 同姿态）。
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
      ...(typeof entry.homepage === 'string' && entry.homepage ? { homepage: entry.homepage } : {}),
    })
  }
  return entries
}

/**
 * Claude 插件市场清单适配器（.claude-plugin/marketplace.json）：把
 * `plugins[].skills[]` 相对路径展开为 per-skill 条目。repoUrl 拼单 skill 的
 * tree URL；source 形态可被 parseGithubTreeSpec 解析安装。
 */
export function parseClaudeSkillMarketplace(
  value: unknown,
  repoUrl: string,
): readonly SkillMarketEntry[] {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('claude skill marketplace must be an object')
  const plugins = (value as Record<string, unknown>).plugins
  if (!Array.isArray(plugins)) throw new Error('claude skill marketplace requires plugins[]')
  const entries: SkillMarketEntry[] = []
  for (const raw of plugins) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      throw new Error('claude skill marketplace plugin must be an object')
    const plugin = raw as Record<string, unknown>
    const description = typeof plugin.description === 'string' ? plugin.description : undefined
    const skillPaths = Array.isArray(plugin.skills) ? plugin.skills : []
    for (const skillPath of skillPaths) {
      if (typeof skillPath !== 'string' || !skillPath.startsWith('./')) continue
      const name = skillPath.split('/').filter(Boolean).at(-1)
      if (!name || !SKILL_NAME.test(name) || name.length > 64) continue
      entries.push({
        name,
        ...(description ? { description } : {}),
        source: `${repoUrl}/${skillPath.slice(2)}`,
      })
      if (entries.length >= MAX_ENTRIES) return entries
    }
  }
  return entries
}

/** 按 body 形状自动识别格式并解析（volund v1 index 优先，Claude marketplace 次之）。 */
export function parseSkillMarketDocument(
  value: unknown,
  repoUrl = DEFAULT_SKILL_MARKET_REPO,
): readonly SkillMarketEntry[] {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>
    if (record.version === 1 && Array.isArray(record.entries)) return parseSkillMarketIndex(value)
    if (Array.isArray(record.plugins)) return parseClaudeSkillMarketplace(value, repoUrl)
  }
  throw new Error('unrecognized skill market document shape')
}

let cached: { source: string; view: SkillMarketView; at: number } | undefined

/** 拉取并解析索引（60s 进程内缓存；未配置 → 内置默认源；失败 → { error } 由面板解释）。 */
export async function fetchSkillMarketIndex(
  home: string,
): Promise<SkillMarketView | { error: string } | undefined> {
  let source = DEFAULT_SKILL_MARKET_SOURCE
  let isDefault = true
  try {
    const configured = await readSkillMarketSource(home)
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
      throw new Error(`skill market index larger than ${MAX_INDEX_BYTES} bytes`)
    const repoUrl =
      isDefault || source.includes('claude-plugin/marketplace.json')
        ? DEFAULT_SKILL_MARKET_REPO
        : guessRepoFromSource(source)
    const view: SkillMarketView = {
      source,
      entries: parseSkillMarketDocument(JSON.parse(body), repoUrl),
      isDefault,
    }
    cached = { source, view, at: now }
    return view
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

/** 从 marketplace.json 的 URL 猜仓库根（GitHub raw / jsDelivr 形态 → github tree 根）。 */
function guessRepoFromSource(source: string): string {
  const raw = /^https:\/\/raw\.githubusercontent\.com\/([\w.-]+)\/([\w.-]+)\/([^/]+)\//.exec(source)
  if (raw) {
    const [, owner, repo, ref] = raw
    if (owner && repo && ref) return `https://github.com/${owner}/${repo}/tree/${ref}`
  }
  const jsdelivr = /^https:\/\/cdn\.jsdelivr\.net\/gh\/([\w.-]+)\/([\w.-]+)@([^/]+)\//.exec(source)
  if (jsdelivr) {
    const [, owner, repo, ref] = jsdelivr
    if (owner && repo && ref) return `https://github.com/${owner}/${repo}/tree/${ref}`
  }
  return DEFAULT_SKILL_MARKET_REPO
}
