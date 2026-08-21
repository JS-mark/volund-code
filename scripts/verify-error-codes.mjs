import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const scriptPath = fileURLToPath(import.meta.url)
const root = resolve(dirname(scriptPath), '..')
const sourceRoots = ['apps', 'packages']
const sourceExtensions = new Set(['.ts', '.tsx', '.mts', '.cts'])
const registryRelativePath = 'packages/shared/src/error-codes.ts'
const appendixRelativePath =
  'docs/superpowers/specs/2026-07-31-apollo-code-design/APPENDIX-B-error-codes.md'

/**
 * 登记在表、但静态规则扫不到 emit 字面量的码。每一项必须给出真实来源，
 * 否则等同于绕过登记制——verify 会对豁免项本身做"必须在表"校验。
 */
export const emittedWithoutLiteral = new Map([
  ['APOLLO_SUBAGENT_DEPTH_EXCEEDED', 'packages/subagent/src/index.ts resourceError() 实参'],
  ['APOLLO_SUBAGENT_CONCURRENCY_EXCEEDED', 'packages/subagent/src/index.ts resourceError() 实参'],
  ['plugin_internal_error', 'packages/plugin-runtime/src/index.ts safeRpcError 兜底'],
  ['memory_unknown', 'packages/ui/src/memory-panel.ts memoryPanelError 兜底'],
  ['memory_index_corrupt', 'packages/storage/src/memory-index.ts 快照读取三元缺省码'],
  // P0-00 containment removes production legacy plugin composition without deleting the
  // compatibility contracts that Catalog v2/ABI migration must either rewire or retire.
  ['memory_hook_failed', 'P0-00 quarantined legacy production Memory policy runtime'],
  ['memory_hook_reentrant', 'P0-00 quarantined legacy production Memory policy runtime'],
  ['memory_hook_veto', 'P0-00 quarantined legacy production Memory policy runtime'],
  ['plugin_http_not_connected', 'P0-00 removed legacy production session plugin bridge'],
  ['plugin_ui_not_connected', 'P0-00 removed legacy production session plugin bridge'],
  // normalizeError 的 `APOLLO_${category.toUpperCase()}` 动态工厂（shared/src/errors.ts）
  ['APOLLO_NETWORK', 'normalizeError APOLLO_<CATEGORY> 工厂'],
  ['APOLLO_AUTH', 'normalizeError APOLLO_<CATEGORY> 工厂'],
  ['APOLLO_RATE_LIMIT', 'normalizeError APOLLO_<CATEGORY> 工厂'],
  ['APOLLO_QUOTA', 'normalizeError APOLLO_<CATEGORY> 工厂'],
  ['APOLLO_CONTENT_FILTER', 'normalizeError APOLLO_<CATEGORY> 工厂'],
  ['APOLLO_MODEL_NOT_FOUND', 'normalizeError APOLLO_<CATEGORY> 工厂'],
  ['APOLLO_SERVER', 'normalizeError APOLLO_<CATEGORY> 工厂'],
  ['APOLLO_CONTEXT_LENGTH', 'normalizeError APOLLO_<CATEGORY> 工厂'],
  ['APOLLO_STREAM_TRUNCATED', 'normalizeError APOLLO_<CATEGORY> 工厂'],
  ['APOLLO_PROTOCOL', 'normalizeError APOLLO_<CATEGORY> 工厂'],
  ['APOLLO_PERMISSION', 'normalizeError APOLLO_<CATEGORY> 工厂'],
  ['APOLLO_SANDBOX', 'normalizeError APOLLO_<CATEGORY> 工厂'],
  ['APOLLO_TIMEOUT', 'normalizeError APOLLO_<CATEGORY> 工厂'],
  ['APOLLO_CANCELLED', 'normalizeError APOLLO_<CATEGORY> 工厂'],
  ['APOLLO_UNKNOWN', 'normalizeError APOLLO_<CATEGORY> 工厂'],
  // 附录 B.2 契约码：实现尚未接线（worker 崩溃现以 restart 计数降级 / builtin hook 未落地）
  ['hook_priority_out_of_range', '附录 B.2 契约码，实现未接线（§6.11.1）'],
  ['search_worker_crashed', '附录 B.2 契约码，worker-pool 以 restart 计数降级未 emit 码'],
  ['fs_worker_crashed', '附录 B.2 契约码，worker-pool 以 restart 计数降级未 emit 码'],
])

/** 错误码字面量形状：snake_case（≥2 段）或 UPPER_SNAKE（≥2 段）。 */
export function isErrorCodeLiteral(value) {
  return (
    /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(value) || /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(value)
  )
}

/** 从 error-codes.ts 源文本解析 `export const ErrorCodes = { ... } as const` 的条目。 */
export function parseRegistry(source) {
  const start = source.indexOf('export const ErrorCodes = {')
  if (start === -1)
    return { entries: [], errors: ['registry is missing `export const ErrorCodes = {`'] }
  const end = source.indexOf('} as const', start)
  if (end === -1) return { entries: [], errors: ['registry object is missing `} as const`'] }
  const block = source.slice(start, end)
  const entries = []
  for (const match of block.matchAll(
    /^ {2}([A-Za-z_$][A-Za-z0-9_$]*): '([A-Za-z0-9_]+)',\s*(?:\/\/.*)?$/gm,
  ))
    entries.push({ key: match[1], code: match[2] })
  const errors =
    entries.length < 10 ? ['registry parse produced fewer than 10 entries (format drift?)'] : []
  return { entries, errors }
}

/** 从附录 B markdown 提取 B.2 登记表首列错误码（B.3 相邻登记含 `.` / exit code，不匹配）。 */
export function parseAppendixCodes(markdown) {
  const start = markdown.indexOf('## B.2')
  if (start === -1) return []
  const nextSection = markdown.indexOf('## B.3', start)
  const section = markdown.slice(start, nextSection === -1 ? undefined : nextSection)
  return [...section.matchAll(/^\| `([a-z0-9_]+)` \|/gm)].map((match) => match[1])
}

/**
 * 扫描源码文本中 emit 的字面量错误码。四条静态规则（覆盖仓库现有全部 emit 惯用法）：
 * 1. 属性 `code: 'literal'`（含三元兜底 `x.code : 'literal'`）；
 * 2. `new XxxError('code', ...)` 构造首参为纯码形状字面量（整串无空格，排除自然语言 message）；
 * 3. `` `code: ${detail}` `` 码前缀模板（new Error 构造与 error 载荷两处的惯例）；
 * 4. `new XxxError('code: message')` 码前缀引号串（theme_invalid 惯例）。
 */
export function extractEmittedCodes(files) {
  const emits = []
  const patterns = [
    { pattern: /\bcode\s*:\s*['"]([A-Za-z0-9_]+)['"]/g },
    { pattern: /\bnew\s+\w*Error\s*\(\s*['"]([A-Za-z0-9_]+)['"]\s*(?=[,)])/g },
    { pattern: /`([a-z][a-z0-9]*(?:_[a-z0-9]+)+): *\$\{/g },
    { pattern: /\bnew\s+\w*Error\s*\(\s*'([a-z][a-z0-9]*(?:_[a-z0-9]+)+): /g },
  ]
  for (const file of files) {
    for (const { pattern } of patterns) {
      for (const match of file.source.matchAll(pattern)) {
        if (isErrorCodeLiteral(match[1])) emits.push({ path: file.path, code: match[1] })
      }
    }
  }
  return emits
}

/** 汇总四向校验：表内键值合法且唯一 / 附录 B.2 ⊆ 表 / emit ⊆ 表 / 表 − emit − 豁免 = ∅。 */
export function auditErrorCodes({ registryEntries, appendixCodes, emitted, exempt }) {
  const errors = []
  const registry = new Map()
  const seenKeys = new Set()
  for (const { key, code } of registryEntries) {
    if (seenKeys.has(key)) errors.push(`registry: duplicate key ${key}`)
    seenKeys.add(key)
    if (registry.has(code))
      errors.push(`registry: duplicate code '${code}' (${registry.get(code)} vs ${key})`)
    if (!isErrorCodeLiteral(code)) errors.push(`registry: '${code}' is not a code-shaped literal`)
    registry.set(code, key)
  }
  for (const code of appendixCodes)
    if (!registry.has(code))
      errors.push(`appendix B.2 code '${code}' is missing from ${registryRelativePath}`)
  for (const { path, code } of emitted)
    if (!registry.has(code))
      errors.push(
        `${path}: emitted code '${code}' is not registered (add it to ${registryRelativePath})`,
      )
  const emittedCodes = new Set(emitted.map((entry) => entry.code))
  for (const [code, key] of registry)
    if (!emittedCodes.has(code) && !exempt.has(code))
      errors.push(
        `registry: '${code}' (${key}) is never emitted and not exempt (remove it or add an exemption with a real source)`,
      )
  for (const code of exempt.keys())
    if (!registry.has(code))
      errors.push(`exemption '${code}' is not in the registry (stale or misspelled exemption)`)
  return errors
}

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory())
      return entry.name === 'dist' || entry.name === 'node_modules' ? [] : walk(path)
    return sourceExtensions.has(extname(entry.name)) ? [path] : []
  })
}

function isTestFile(path) {
  return /\.(?:test|spec)\.[cm]?tsx?$/.test(path)
}

function repositoryFiles() {
  const files = []
  for (const sourceRoot of sourceRoots) {
    const directory = join(root, sourceRoot)
    if (!existsSync(directory)) continue
    for (const path of walk(directory)) {
      // 漂移检查只覆盖生产源码：测试里的桩码（如 provider_timeout）不代表运行时契约。
      if (isTestFile(path) || relative(root, path) === registryRelativePath) continue
      files.push({ path: relative(root, path), source: readFileSync(path, 'utf8') })
    }
  }
  return files
}

if (isAbsolute(process.argv[1] ?? '') && resolve(process.argv[1]) === scriptPath) {
  const { entries, errors: parseErrors } = parseRegistry(
    readFileSync(join(root, registryRelativePath), 'utf8'),
  )
  const appendixCodes = parseAppendixCodes(readFileSync(join(root, appendixRelativePath), 'utf8'))
  const emitted = extractEmittedCodes(repositoryFiles())
  const errors = [
    ...parseErrors,
    ...auditErrorCodes({
      registryEntries: entries,
      appendixCodes,
      emitted,
      exempt: emittedWithoutLiteral,
    }),
  ]
  if (errors.length) {
    console.error(errors.join('\n'))
    process.exitCode = 1
  } else {
    console.log(
      `Error code registry in sync: ${entries.length} registered, ${new Set(emitted.map((entry) => entry.code)).size} emitted literal codes, ${appendixCodes.length} appendix B.2 codes covered.`,
    )
  }
}
