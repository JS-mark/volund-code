import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

/**
 * 附录 D / §2.3 CI 强制（r13-I8）：
 * 1. 02-agent-loop.md §2.3 事件表的每个事件都有对应 per-event schema 文件；
 * 2. packages/shared/src/events/ 下（除 index/envelope/common 与 *.test.ts）每个文件
 *    都对应 §2.3 事件表的一行——双向 diff 非空即 fail；
 * 3. events/index.ts 的 EVENT_SCHEMAS registry 键与 §2.3 事件表完全一致。
 */

const scriptPath = fileURLToPath(import.meta.url)
const root = resolve(dirname(scriptPath), '..')
export const SPEC_EVENT_TABLE_PATH =
  'docs/superpowers/specs/2026-07-31-volund-code-design/02-agent-loop.md'
export const EVENT_SCHEMAS_DIR = 'packages/shared/src/events'
const NON_EVENT_FILES = new Set(['index.ts', 'envelope.ts', 'common.ts'])

/** 提取 markdown 中某个 `### N.N` 小节的正文（到下一个同级/更高级标题为止）。 */
export function extractSection(markdown, sectionId) {
  const start = markdown.search(new RegExp(`^###\\s+${sectionId.replace('.', '\\.')}\\b`, 'm'))
  if (start === -1) return undefined
  const afterHeading = markdown.indexOf('\n', start)
  const rest = markdown.slice(afterHeading + 1)
  const nextHeading = rest.search(/^#{1,3}\s/m)
  return nextHeading === -1 ? rest : rest.slice(0, nextHeading)
}

/** 解析 §2.3 事件表：表格首列为反引号包裹的事件名。 */
export function parseEventNames(markdown) {
  const section = extractSection(markdown, '2.3')
  if (!section) return []
  return [...section.matchAll(/^\|\s*`([a-z][a-z0-9_.]*)`\s*\|/gm)].map((match) => match[1])
}

/** 事件名 ↔ schema 文件名（§2.3 事件名只含一个点 + 下划线，文件名以 `-` 替代点）。 */
export function fileNameForEvent(eventName) {
  return `${eventName.replace('.', '-')}.ts`
}

export function eventNameForFile(fileName) {
  return fileName.replace(/\.ts$/, '').replace('-', '.')
}

/** 从 events/index.ts 源码解析 EVENT_SCHEMAS registry 的事件名键。 */
export function parseRegistryKeys(indexSource) {
  const block = indexSource.match(/export const EVENT_SCHEMAS = \{([\s\S]*?)\} as const/)
  if (!block) return []
  return [...block[1].matchAll(/^\s*'([a-z][a-z0-9_.]*)':/gm)].map((match) => match[1])
}

export function auditEventSchemas({ specEventNames, schemaFileNames, registryKeys }) {
  const errors = []
  const specSet = new Set(specEventNames)
  if (specEventNames.length === 0) errors.push('spec 2.3 event table parsed to zero rows')

  const eventFiles = schemaFileNames.filter(
    (name) => name.endsWith('.ts') && !name.endsWith('.test.ts') && !NON_EVENT_FILES.has(name),
  )
  const fileEvents = eventFiles.map(eventNameForFile)

  for (const event of specEventNames)
    if (!fileEvents.includes(event))
      errors.push(
        `spec event \`${event}\` has no schema file ${EVENT_SCHEMAS_DIR}/${fileNameForEvent(event)}`,
      )
  for (const file of eventFiles) {
    const event = eventNameForFile(file)
    if (!specSet.has(event))
      errors.push(`schema file ${EVENT_SCHEMAS_DIR}/${file} is not a §2.3 event`)
  }

  const registrySet = new Set(registryKeys)
  for (const event of specEventNames)
    if (!registrySet.has(event))
      errors.push(`spec event \`${event}\` missing from EVENT_SCHEMAS registry`)
  for (const key of registryKeys)
    if (!specSet.has(key)) errors.push(`EVENT_SCHEMAS registry key \`${key}\` is not a §2.3 event`)

  return errors
}

export function auditRepository() {
  const markdown = readFileSync(join(root, SPEC_EVENT_TABLE_PATH), 'utf8')
  const indexSource = readFileSync(join(root, EVENT_SCHEMAS_DIR, 'index.ts'), 'utf8')
  return auditEventSchemas({
    specEventNames: parseEventNames(markdown),
    schemaFileNames: readdirSync(join(root, EVENT_SCHEMAS_DIR)),
    registryKeys: parseRegistryKeys(indexSource),
  })
}

if (resolve(process.argv[1] ?? '') === scriptPath) {
  const errors = auditRepository()
  if (errors.length) {
    console.error(errors.join('\n'))
    process.exitCode = 1
  } else {
    console.log(
      'Per-event payload schemas match the §2.3 event table and the EVENT_SCHEMAS registry.',
    )
  }
}
