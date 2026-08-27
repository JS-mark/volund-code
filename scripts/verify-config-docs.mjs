import { readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const scriptPath = fileURLToPath(import.meta.url)
const root = resolve(dirname(scriptPath), '..')
const registryRelativePath = 'packages/shared/src/config-schema.ts'
const appendixRelativePath =
  'docs/superpowers/specs/2026-07-31-volund-code-design/APPENDIX-C-config-schema.md'

/**
 * schema 已登记、但附录 C.2 尚无对应行的实现内建 key。每一项必须给出真实来源，
 * 否则等同于绕过附录 C 登记制——verify 会对豁免项本身做"必须在 registry"校验。
 */
export const implementationOnlyKeys = new Map([])

/** 从 config-schema.ts 源文本解析 `export const configKeyRegistry = { ... } as const` 的条目。 */
export function parseKeyRegistry(source) {
  const start = source.indexOf('export const configKeyRegistry = {')
  if (start === -1)
    return { entries: [], errors: ['registry is missing `export const configKeyRegistry = {`'] }
  const end = source.indexOf('} as const', start)
  if (end === -1) return { entries: [], errors: ['registry is missing `} as const`'] }
  const entries = []
  for (const match of source
    .slice(start, end)
    .matchAll(/^\s*'([^']+)': '(allowed|forbidden)',?\s*(?:\/\/.*)?$/gm))
    entries.push({ key: match[1], override: match[2] })
  const errors =
    entries.length < 20 ? ['registry parse produced fewer than 20 entries (format drift?)'] : []
  return { entries, errors }
}

/**
 * 从附录 C markdown 提取 C.2 全量表的行（Section / Key / projectOverride）。
 * 类型列可含转义管道（`"single" \| "fallback"`），故中段用贪婪 `.*` 吞掉、
 * 只锚定首两列与末列（projectOverride）。
 */
export function parseAppendixRows(markdown) {
  const start = markdown.indexOf('## C.2')
  if (start === -1) return { rows: [], errors: ['appendix C is missing `## C.2` heading'] }
  const next = markdown.indexOf('## C.3', start)
  const section = markdown.slice(start, next === -1 ? undefined : next)
  const rows = []
  for (const match of section.matchAll(
    /^\|\s*`?\[([^\]]+)\]`?\s*\|([^|]+)\|.*\|\s*([^|]+?)\s*\|\s*$/gm,
  )) {
    rows.push({
      section: match[1].trim(),
      key: match[2].trim(),
      override: match[3].trim().includes('forbidden') ? 'forbidden' : 'allowed',
    })
  }
  const errors =
    rows.length < 20 ? ['appendix C.2 parse produced fewer than 20 rows (format drift?)'] : []
  return { rows, errors }
}

/**
 * 把 C.2 一行归一化为 registry key id 集合（与 config-schema.ts 的 id 规则一致）：
 * - Key 列的反引号 token 逐个展开（如 `baseUrl` / `endpoint` → 两个 id）；
 * - `<name>` / `<alias>` 等占位段归一为 `*`；
 * - 无反引号 token、或含「等 / （全部）」的开放段行（见 §5.5 / §15 / [auth] 全部）
 *   归一为 `<section>.*`。
 */
export function appendixRowIds(row) {
  if (!row.section) return []
  const tokens = [...row.key.matchAll(/`([^`]+)`/g)].map((match) => match[1].trim()).filter(Boolean)
  if (tokens.length === 0 || /等|（全部）/.test(row.key)) return [`${row.section}.*`]
  return tokens.map((token) => `${row.section}.${token}`.replaceAll(/<[^>]+>/g, '*'))
}

/** 汇总双向校验：registry 与附录 C.2 的 id 集合一致 + projectOverride 标注一致。 */
export function auditConfigDocs({ registryEntries, appendixRows, exempt }) {
  const errors = []
  const registry = new Map()
  for (const { key, override } of registryEntries) {
    if (registry.has(key)) errors.push(`registry: duplicate key '${key}'`)
    registry.set(key, override)
  }
  const appendix = new Map()
  for (const row of appendixRows) {
    for (const id of appendixRowIds(row)) {
      if (appendix.has(id) && appendix.get(id) !== row.override)
        errors.push(`appendix C.2: '${id}' has conflicting projectOverride annotations`)
      appendix.set(id, row.override)
    }
  }
  // 通配登记（如 'preferences.*'）覆盖同段任意 appendix 行——开放段的 registry 以通配表达
  const wildcardOf = (id) => `${id.slice(0, id.indexOf('.'))}.*`
  for (const [id, override] of appendix) {
    const wildcard = wildcardOf(id)
    const covered = registry.has(id) || registry.has(wildcard)
    const registeredOverride = registry.has(id) ? registry.get(id) : registry.get(wildcard)
    if (!covered)
      errors.push(
        `appendix C.2 key '${id}' is missing from ${registryRelativePath} (configKeyRegistry)`,
      )
    else if (registeredOverride !== override)
      errors.push(
        `appendix C.2 key '${id}' is '${override}' but configKeyRegistry says '${registry.get(id)}'`,
      )
  }
  for (const id of registry.keys()) {
    // 通配条目（'段.*'）被该段任意 appendix 行覆盖即视为 documented
    const coveredByWildcard =
      id.endsWith('.*') && [...appendix.keys()].some((a) => wildcardOf(a) === id)
    if (!appendix.has(id) && !coveredByWildcard && !exempt.has(id))
      errors.push(
        `configKeyRegistry key '${id}' is not documented in appendix C.2 (add a row, or exempt with a real source)`,
      )
  }
  for (const id of exempt.keys())
    if (!registry.has(id))
      errors.push(`exemption '${id}' is not in the registry (stale or misspelled exemption)`)
  return errors
}

if (isAbsolute(process.argv[1] ?? '') && resolve(process.argv[1]) === scriptPath) {
  const { entries, errors: parseErrors } = parseKeyRegistry(
    readFileSync(join(root, registryRelativePath), 'utf8'),
  )
  const { rows, errors: appendixParseErrors } = parseAppendixRows(
    readFileSync(join(root, appendixRelativePath), 'utf8'),
  )
  const errors = [
    ...parseErrors,
    ...appendixParseErrors,
    ...auditConfigDocs({
      registryEntries: entries,
      appendixRows: rows,
      exempt: implementationOnlyKeys,
    }),
  ]
  if (errors.length) {
    console.error(errors.join('\n'))
    process.exitCode = 1
  } else {
    const documentedIds = new Set(rows.flatMap((row) => appendixRowIds(row)))
    console.log(
      `Config key registry in sync with appendix C.2: ${entries.length} registered keys, ${rows.length} table rows, ${documentedIds.size} documented ids, ${implementationOnlyKeys.size} implementation-only exemption(s).`,
    )
  }
}
