import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import {
  VolundError,
  ConfigSchema,
  isProjectOverrideForbidden,
  type JsonValue,
} from '@volund/shared'
export type Config = Record<string, JsonValue>
export type TrustDecision = 'allow-project' | 'allow-once' | 'deny'
export interface ConfigLayerOptions {
  defaults: Config
  global?: Config
  project?: Config
  env?: Config
  flags?: Config
  interactive?: boolean
  trustProjectConfig?: boolean
  previousProjectHash?: string
  promptTrust?: (input: { hash: string; keys: string[] }) => Promise<TrustDecision>
  warning?: (key: string) => void
}
/** §8.3.1 数据流向门：附录 C.2 `projectOverride` 标注 + 通用 baseUrl/endpoint/api_key 模式。 */
const forbidden = (key: string) => isProjectOverrideForbidden(key)
/**
 * 原型污染护栏：魔术 key segment 会让 assign 的游标落到 Object.prototype 并被写入
 * （例如 `[evolution.__proto__] enabled = true`），一律拒绝而不是静默跳过。
 */
const forbiddenKeySegments: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype'])
function flatten(
  input: Config,
  prefix = '',
  out: Record<string, JsonValue> = {},
): Record<string, JsonValue> {
  for (const [k, v] of Object.entries(input)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out)
    else out[key] = v
  }
  return out
}
function assign(out: Config, key: string, value: JsonValue) {
  const parts = key.split('.')
  if (parts.some((part) => forbiddenKeySegments.has(part)))
    throw new VolundError('config_invalid', `forbidden config key segment in '${key}'`)
  let cursor = out
  for (const part of parts.slice(0, -1)) {
    const next = cursor[part]
    cursor = next && typeof next === 'object' && !Array.isArray(next) ? next : (cursor[part] = {})
  }
  cursor[parts.at(-1)!] = value
}
function merge(
  out: Config,
  layer?: Config,
  project = false,
  warning?: (key: string) => void,
): Config {
  for (const [k, v] of Object.entries(flatten(layer ?? {}))) {
    if (project && forbidden(k)) {
      warning?.(k)
      continue
    }
    assign(out, k, v)
  }
  return out
}
export async function loadConfig(
  options: ConfigLayerOptions,
): Promise<{ config: Config; projectHash: string | undefined; trusted: boolean }> {
  const out = merge({}, options.defaults)
  merge(out, options.global)
  let trusted = false,
    hash: string | undefined
  if (options.project) {
    hash = createHash('sha256')
      .update(JSON.stringify(flatten(options.project)))
      .digest('hex')
    if (options.trustProjectConfig) trusted = true
    else if (options.interactive === false) trusted = false
    else if (hash === options.previousProjectHash) trusted = true
    else
      trusted =
        (await options.promptTrust?.({ hash, keys: Object.keys(flatten(options.project)) })) !==
        'deny'
    if (trusted) merge(out, options.project, true, options.warning)
  }
  merge(out, options.env)
  merge(out, options.flags)
  return { config: out, projectHash: hash, trusted }
}
export async function parseTomlFile(path: string): Promise<Config> {
  const text = await readFile(path, 'utf8'),
    out: Config = {},
    section: string[] = []
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*$/, '').trim()
    if (!line) continue
    const header = /^\[([^\]]+)\]$/.exec(line)
    if (header) {
      section.splice(0, section.length, ...header[1]!.split('.'))
      continue
    }
    const pair = /^([\w.-]+)\s*=\s*(.+)$/.exec(line)
    if (!pair) throw new Error(`Invalid TOML line: ${raw}`)
    let value: JsonValue
    try {
      value = JSON.parse(pair[2]!)
    } catch {
      throw new Error(`Unsupported TOML value: ${pair[2]}`)
    }
    assign(out, [...section, pair[1]!].join('.'), value)
  }
  return out
}

export interface ConfigValidationOptions {
  /** 用于警告与报错定位的来源文件路径。 */
  file: string
}
export interface ConfigValidationResult {
  /** 仅含 schema 已知 key 的配置（未知 key 已忽略剔除）。 */
  config: Config
  /** 未知 key 警告（含 key 全名与所在文件），§8.3 / 附录 C.1。 */
  warnings: string[]
}

/**
 * r13-I4 未知 key 策略（§8.3 / 附录 C.1）：
 * - 未知 key（顶层未知 section 与已知 section 内未知 key）→ warn + 忽略（向前兼容）；
 * - 已知 key 类型错 → 抛 `config_invalid`（VolundError，含文件 + key + 期望类型）。
 */
export function validateConfig(
  input: Config,
  options: ConfigValidationOptions,
): ConfigValidationResult {
  const result = ConfigSchema.safeParse(input)
  if (result.success) return { config: result.data as Config, warnings: [] }
  const warnings: string[] = []
  const typeErrors: string[] = []
  const unknownDeletions: { path: PropertyKey[]; keys: PropertyKey[] }[] = []
  for (const issue of result.error.issues) {
    if (issue.code === 'unrecognized_keys') {
      const prefix = issue.path.map(String).join('.')
      for (const key of issue.keys) {
        warnings.push(
          `unknown config key '${prefix ? `${prefix}.${String(key)}` : String(key)}' in ${options.file} ignored`,
        )
      }
      unknownDeletions.push({ path: [...issue.path], keys: [...issue.keys] })
    } else {
      const key = issue.path.map(String).join('.') || '(root)'
      const detail =
        'expected' in issue && 'received' in issue
          ? `expected ${String(issue.expected)}, received ${String(issue.received)}`
          : issue.message
      typeErrors.push(`key '${key}': ${detail}`)
    }
  }
  if (typeErrors.length > 0)
    throw new VolundError(
      'config_invalid',
      `invalid config in ${options.file}: ${typeErrors.join('; ')}`,
    )
  const cleaned = structuredClone(input)
  for (const { path, keys } of unknownDeletions) {
    let cursor: Record<string, JsonValue> | undefined = cleaned
    for (const segment of path) {
      const next: JsonValue | undefined = cursor?.[String(segment)]
      cursor =
        next && typeof next === 'object' && !Array.isArray(next)
          ? (next as Record<string, JsonValue>)
          : undefined
    }
    if (cursor) for (const key of keys) delete cursor[String(key)]
  }
  return { config: cleaned, warnings }
}

export interface TomlLoadOptions {
  /** 未知 key 警告回调（如 logger.warn / 控制台 stderr）。 */
  onWarning?: (message: string) => void
}

/** 解析 + 校验单个 TOML 文件：未知 key warn + 忽略，类型错抛错（§8.3 / 附录 C.1）。 */
export async function loadTomlFile(path: string, options: TomlLoadOptions = {}): Promise<Config> {
  const raw = await parseTomlFile(path)
  const { config, warnings } = validateConfig(raw, { file: path })
  for (const warning of warnings) options.onWarning?.(warning)
  return config
}
