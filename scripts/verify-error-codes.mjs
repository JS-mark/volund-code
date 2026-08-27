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
  'docs/superpowers/specs/2026-07-31-volund-code-design/APPENDIX-B-error-codes.md'

/**
 * 登记在表、但静态规则扫不到 emit 字面量的码。每一项必须给出真实来源，
 * 否则等同于绕过登记制——verify 会对豁免项本身做"必须在表"校验。
 */
export const emittedWithoutLiteral = new Map([
  ['VOLUND_SUBAGENT_DEPTH_EXCEEDED', 'packages/subagent/src/index.ts resourceError() 实参'],
  ['VOLUND_SUBAGENT_CONCURRENCY_EXCEEDED', 'packages/subagent/src/index.ts resourceError() 实参'],
  ['plugin_internal_error', 'apps/cli/src/cli.ts plugin JSON unknown-error fallback'],
  ['memory_unknown', 'packages/ui/src/memory-panel.ts memoryPanelError 兜底'],
  ['memory_index_corrupt', 'packages/storage/src/memory-index.ts 快照读取三元缺省码'],
  // normalizeError 的 `volund_${category.toUpperCase()}` 动态工厂（shared/src/errors.ts）
  ['VOLUND_NETWORK', 'normalizeError volund_<CATEGORY> 工厂'],
  ['VOLUND_AUTH', 'normalizeError volund_<CATEGORY> 工厂'],
  ['VOLUND_RATE_LIMIT', 'normalizeError volund_<CATEGORY> 工厂'],
  ['VOLUND_QUOTA', 'normalizeError volund_<CATEGORY> 工厂'],
  ['VOLUND_CONTENT_FILTER', 'normalizeError volund_<CATEGORY> 工厂'],
  ['VOLUND_MODEL_NOT_FOUND', 'normalizeError volund_<CATEGORY> 工厂'],
  ['VOLUND_SERVER', 'normalizeError volund_<CATEGORY> 工厂'],
  ['VOLUND_CONTEXT_LENGTH', 'normalizeError volund_<CATEGORY> 工厂'],
  ['VOLUND_STREAM_TRUNCATED', 'normalizeError volund_<CATEGORY> 工厂'],
  ['VOLUND_PROTOCOL', 'normalizeError volund_<CATEGORY> 工厂'],
  ['VOLUND_PERMISSION', 'normalizeError volund_<CATEGORY> 工厂'],
  ['VOLUND_SANDBOX', 'normalizeError volund_<CATEGORY> 工厂'],
  ['VOLUND_TIMEOUT', 'normalizeError volund_<CATEGORY> 工厂'],
  ['VOLUND_CANCELLED', 'normalizeError volund_<CATEGORY> 工厂'],
  ['VOLUND_UNKNOWN', 'normalizeError volund_<CATEGORY> 工厂'],
])

const legacyHostRemovalGate = Object.freeze({
  owner: 'ABI-R1',
  removalGate:
    'Verified replacement host transport must reconnect this contract or remove it at ABI review',
})

/**
 * Intentionally dormant cross-module contracts. Unlike `emittedWithoutLiteral`, these codes are
 * not emitted by the current production graph. Every reservation names an owner and the concrete
 * gate that must either reconnect or remove it.
 */
export const reservedContractCodes = new Map([
  ['plugin_activation_cancelled', legacyHostRemovalGate],
  ['plugin_activation_timeout', legacyHostRemovalGate],
  ['plugin_already_loaded', legacyHostRemovalGate],
  ['plugin_callback_cancelled', legacyHostRemovalGate],
  ['plugin_callback_failed', legacyHostRemovalGate],
  ['plugin_callback_timeout', legacyHostRemovalGate],
  ['plugin_deactivated', legacyHostRemovalGate],
  ['plugin_heartbeat_timeout', legacyHostRemovalGate],
  ['plugin_host_exited', legacyHostRemovalGate],
  ['plugin_not_enabled', legacyHostRemovalGate],
  ['plugin_permission_denied', legacyHostRemovalGate],
  ['plugin_rpc_frame_too_large', legacyHostRemovalGate],
  ['plugin_rpc_invalid_json', legacyHostRemovalGate],
  ['plugin_rpc_version', legacyHostRemovalGate],
  [
    'hook_priority_out_of_range',
    { owner: 'HOOK-R1', removalGate: 'Implement manifest priority validation or revise §6.11.1' },
  ],
  [
    'search_worker_crashed',
    { owner: 'NATIVE-R1', removalGate: 'Emit on worker crash or revise the B.2 worker contract' },
  ],
  [
    'fs_worker_crashed',
    { owner: 'NATIVE-R1', removalGate: 'Emit on worker crash or revise the B.2 worker contract' },
  ],
  [
    'memory_hook_failed',
    {
      owner: 'CAT-02',
      removalGate: 'Catalog v2 must reconnect the verified Memory hook ABI or retire this code',
    },
  ],
  [
    'memory_hook_reentrant',
    {
      owner: 'CAT-02',
      removalGate: 'Catalog v2 must reconnect the verified Memory hook ABI or retire this code',
    },
  ],
  [
    'memory_hook_veto',
    {
      owner: 'CAT-02',
      removalGate: 'Catalog v2 must reconnect the verified Memory hook ABI or retire this code',
    },
  ],
  [
    'plugin_http_not_connected',
    {
      owner: 'ABI-R1',
      removalGate: 'Verified replacement session bridge must emit this code or retire its contract',
    },
  ],
  [
    'plugin_ui_not_connected',
    {
      owner: 'ABI-R1',
      removalGate: 'Verified replacement session bridge must emit this code or retire its contract',
    },
  ],
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
  return [...section.matchAll(/^\| `([a-z0-9_]+)`\s+\|/gm)].map((match) => match[1])
}

/**
 * 扫描源码文本中 emit 的字面量错误码。四条静态规则（覆盖仓库现有全部 emit 惯用法）：
 * 1. 属性 `code: 'literal'`（含三元兜底 `x.code : 'literal'`）；
 * 2. `new XxxError('code', ...)` 构造首参为纯码形状字面量（整串无空格，排除自然语言 message）；
 * 3. `` `code: ${detail}` `` 码前缀模板（new Error 构造与 error 载荷两处的惯例）；
 * 4. `new XxxError('code: message')` 码前缀引号串（theme_invalid 惯例）；
 * 5. `jsonFailure(message, exit, 'code')` CLI machine-protocol helper third argument.
 */
export function extractEmittedCodes(files) {
  const emits = []
  const patterns = [
    { pattern: /\bcode\s*:\s*['"]([A-Za-z0-9_]+)['"]/g },
    { pattern: /\bnew\s+\w*Error\s*\(\s*['"]([A-Za-z0-9_]+)['"]\s*(?=[,)])/g },
    { pattern: /`([a-z][a-z0-9]*(?:_[a-z0-9]+)+): *\$\{/g },
    { pattern: /\bnew\s+\w*Error\s*\(\s*'([a-z][a-z0-9]*(?:_[a-z0-9]+)+): /g },
    {
      pattern: /\bjsonFailure\s*\(\s*[^,\n]+,\s*\d+\s*,\s*['"]([A-Za-z0-9_]+)['"]/g,
    },
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

/** 汇总四向校验：表内键值合法且唯一 / 附录 B.2 ⊆ 表 / emit ⊆ 表 / 表 − emit − 豁免 − 保留契约 = ∅。 */
export function auditErrorCodes({
  registryEntries,
  appendixCodes,
  emitted,
  exempt = new Map(),
  reserved = new Map(),
}) {
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
    if (!emittedCodes.has(code) && !exempt.has(code) && !reserved.has(code))
      errors.push(
        `registry: '${code}' (${key}) is never emitted, exempt, or reserved (remove it, identify its real dynamic source, or add an owned removal gate)`,
      )
  for (const [code, source] of exempt) {
    if (!registry.has(code))
      errors.push(`exemption '${code}' is not in the registry (stale or misspelled exemption)`)
    if (typeof source !== 'string' || source.trim() === '')
      errors.push(`exemption '${code}' must identify a real dynamic emission source`)
    if (reserved.has(code))
      errors.push(`code '${code}' cannot be both dynamically emitted and reserved`)
  }
  for (const [code, reservation] of reserved) {
    if (!registry.has(code))
      errors.push(`reserved contract '${code}' is not in the registry (stale reservation)`)
    if (emittedCodes.has(code) || exempt.has(code))
      errors.push(`reserved contract '${code}' is now emitted; remove its reservation`)
    if (
      reservation === null ||
      typeof reservation !== 'object' ||
      typeof reservation.owner !== 'string' ||
      reservation.owner.trim() === ''
    )
      errors.push(`reserved contract '${code}' must have an owner`)
    if (
      reservation === null ||
      typeof reservation !== 'object' ||
      typeof reservation.removalGate !== 'string' ||
      reservation.removalGate.trim() === ''
    )
      errors.push(`reserved contract '${code}' must have a removalGate`)
  }
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
      reserved: reservedContractCodes,
    }),
  ]
  if (errors.length) {
    console.error(errors.join('\n'))
    process.exitCode = 1
  } else {
    console.log(
      `Error code registry in sync: ${entries.length} registered, ${new Set(emitted.map((entry) => entry.code)).size} emitted literal codes, ${reservedContractCodes.size} owned reserved contracts, ${appendixCodes.length} appendix B.2 codes covered.`,
    )
  }
}
