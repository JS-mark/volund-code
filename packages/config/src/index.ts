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
/**
 * TOML 语义的注释剥离：`#` 在引号字符串内不开启注释（config.toml 的 url /
 * permissions.toml 的 bash command 都可能含 `#`）。basic string 支持反斜杠转义，
 * literal string（单引号）无转义。
 */
function stripComment(line: string): string {
  let quoted: '"' | "'" | undefined
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!
    if (quoted) {
      if (quoted === '"' && char === '\\') index += 1
      else if (char === quoted) quoted = undefined
    } else if (char === '"' || char === "'") quoted = char
    else if (char === '#') return line.slice(0, index)
  }
  return line
}
/**
 * TOML 行内单值解析：先按 JSON 解析（历史写入格式 + 标量/数组场景，向后兼容
 * 存量文件），失败再走 TOML 内联表/数组扫描——`{ key = value }` 用 `=` 而非
 * JSON 的 `:`（permissions.toml 的对象数组要能被外部 TOML 工具读）。仅支持
 * 单行值（多行字符串/数组是既有限制）。
 */
function parseTomlValue(text: string): JsonValue {
  try {
    return JSON.parse(text) as JsonValue
  } catch {
    // 非 JSON 语法 → TOML 内联表/数组扫描
  }
  const position = { index: 0 }
  const value = scanTomlValue(text, position)
  skipTomlSeparators(text, position)
  if (position.index !== text.length) throw new Error(`Unsupported TOML value: ${text}`)
  return value
}

function skipTomlSeparators(text: string, position: { index: number }): void {
  while (position.index < text.length && /\s/.test(text[position.index]!)) position.index += 1
}

function scanTomlValue(text: string, position: { index: number }): JsonValue {
  skipTomlSeparators(text, position)
  const start = text[position.index]
  if (start === '{') return scanTomlInlineTable(text, position)
  if (start === '[') return scanTomlArray(text, position)
  if (start === '"' || start === "'") return scanTomlString(text, position)
  let end = position.index
  while (end < text.length && !/[\s,\]}]/.test(text[end]!)) end += 1
  const token = text.slice(position.index, end)
  position.index = end
  return JSON.parse(token) as JsonValue
}

function scanTomlString(text: string, position: { index: number }): string {
  const quote = text[position.index]!
  if (quote === "'") {
    const end = text.indexOf("'", position.index + 1)
    if (end < 0) throw new Error('Unterminated TOML literal string')
    const raw = text.slice(position.index, end + 1)
    position.index = end + 1
    return raw.slice(1, -1)
  }
  // basic string：转义语义与 JSON 一致（\" \\ \n \uXXXX…），整体 JSON.parse。
  let end = position.index + 1
  while (end < text.length) {
    if (text[end] === '\\') end += 2
    else if (text[end] === '"') break
    else end += 1
  }
  if (end >= text.length) throw new Error('Unterminated TOML basic string')
  const raw = text.slice(position.index, end + 1)
  position.index = end + 1
  return JSON.parse(raw) as string
}

function scanTomlKey(text: string, position: { index: number }): string {
  skipTomlSeparators(text, position)
  const start = text[position.index]
  if (start === '"' || start === "'") return scanTomlString(text, position)
  let end = position.index
  while (end < text.length && /[A-Za-z0-9_-]/.test(text[end]!)) end += 1
  if (end === position.index) throw new Error(`Invalid TOML key at: ${text.slice(position.index)}`)
  const key = text.slice(position.index, end)
  position.index = end
  return key
}

function scanTomlInlineTable(text: string, position: { index: number }): Record<string, JsonValue> {
  position.index += 1 // {
  const out: Record<string, JsonValue> = {}
  skipTomlSeparators(text, position)
  if (text[position.index] === '}') {
    position.index += 1
    return out
  }
  while (true) {
    const key = scanTomlKey(text, position)
    skipTomlSeparators(text, position)
    if (text[position.index] !== '=') throw new Error(`Expected = in TOML inline table: ${text}`)
    position.index += 1
    out[key] = scanTomlValue(text, position)
    skipTomlSeparators(text, position)
    if (text[position.index] === ',') {
      position.index += 1
      continue
    }
    if (text[position.index] === '}') {
      position.index += 1
      return out
    }
    throw new Error(`Unterminated TOML inline table: ${text}`)
  }
}

function scanTomlArray(text: string, position: { index: number }): JsonValue[] {
  position.index += 1 // [
  const out: JsonValue[] = []
  skipTomlSeparators(text, position)
  if (text[position.index] === ']') {
    position.index += 1
    return out
  }
  while (true) {
    out.push(scanTomlValue(text, position))
    skipTomlSeparators(text, position)
    if (text[position.index] === ',') {
      position.index += 1
      continue
    }
    if (text[position.index] === ']') {
      position.index += 1
      return out
    }
    throw new Error(`Unterminated TOML array: ${text}`)
  }
}

export async function parseTomlFile(path: string): Promise<Config> {
  const text = await readFile(path, 'utf8'),
    out: Config = {},
    section: string[] = []
  for (const raw of text.split('\n')) {
    const line = stripComment(raw).trim()
    if (!line) continue
    const header = /^\[([^\]]+)\]$/.exec(line)
    if (header) {
      section.splice(0, section.length, ...header[1]!.split('.'))
      continue
    }
    // key 允许引号形态（"quoted key" / 'literal'），引号内可含空格与 =
    const pair = /^("[^"]*"|'[^']*'|[\w.-]+)\s*=\s*(.+)$/.exec(line)
    if (!pair) throw new Error(`Invalid TOML line: ${raw}`)
    const rawKey = pair[1]!
    const pairKey = rawKey.startsWith('"') || rawKey.startsWith("'") ? rawKey.slice(1, -1) : rawKey
    let value: JsonValue
    try {
      value = parseTomlValue(pair[2]!)
    } catch {
      throw new Error(`Unsupported TOML value: ${pair[2]}`)
    }
    assign(out, [...section, pairKey].join('.'), value)
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
