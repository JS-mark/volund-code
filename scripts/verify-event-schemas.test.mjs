import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  auditEventSchemas,
  auditRepository,
  EVENT_SCHEMAS_DIR,
  eventNameForFile,
  extractSection,
  fileNameForEvent,
  parseEventNames,
  parseRegistryKeys,
  SPEC_EVENT_TABLE_PATH,
} from './verify-event-schemas.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const fixtureMarkdown = `# spec

### 2.2 其他小节

| \`not.an.event\` | 不在 2.3 表内 |

### 2.3 事件总线 (core)

正文行里的 \`inline.token\` 不算表格行。

| 事件 | 触发时机 |
|---|---|
| \`session.started\` | Runner 启动 |
| \`stream.delta\` | 增量 fragment |
| \`error.raised\` | 任何异常 |

### 2.4 下一个小节

| \`later.section\` | 不应被解析 |
`

void test('extractSection scopes markdown parsing to the requested heading', () => {
  const section = extractSection(fixtureMarkdown, '2.3')
  assert.ok(section)
  assert.match(section, /session\.started/)
  assert.doesNotMatch(section, /not\.an\.event/)
  assert.doesNotMatch(section, /later\.section/)
  assert.equal(extractSection(fixtureMarkdown, '9.9'), undefined)
})

void test('parseEventNames reads only backticked first-column table rows', () => {
  assert.deepEqual(parseEventNames(fixtureMarkdown), [
    'session.started',
    'stream.delta',
    'error.raised',
  ])
})

void test('event name and schema file name map both ways', () => {
  assert.equal(fileNameForEvent('tool.permission_asked'), 'tool-permission_asked.ts')
  assert.equal(eventNameForFile('shell-background_exited.ts'), 'shell.background_exited')
  for (const event of ['session.started', 'context.compacted', 'error.raised'])
    assert.equal(eventNameForFile(fileNameForEvent(event)), event)
})

void test('parseRegistryKeys extracts quoted keys from the EVENT_SCHEMAS literal', () => {
  const source = `export const other = { nope: 1 }
export const EVENT_SCHEMAS = {
  'session.started': sessionStartedPayloadSchema,
  'error.raised': errorRaisedPayloadSchema,
} as const satisfies Record<EventName, z.ZodType>`
  assert.deepEqual(parseRegistryKeys(source), ['session.started', 'error.raised'])
  assert.deepEqual(parseRegistryKeys('export const MISSING = {}'), [])
})

void test('auditEventSchemas reports missing files, stray files, and registry drift', () => {
  const specEventNames = ['session.started', 'stream.delta']
  assert.deepEqual(
    auditEventSchemas({
      specEventNames,
      schemaFileNames: [
        'session-started.ts',
        'stream-delta.ts',
        'index.ts',
        'common.ts',
        'events.test.ts',
      ],
      registryKeys: ['session.started', 'stream.delta'],
    }),
    [],
  )

  const missing = auditEventSchemas({
    specEventNames,
    schemaFileNames: ['session-started.ts'],
    registryKeys: specEventNames,
  })
  assert.equal(missing.length, 1)
  assert.match(missing[0], /stream\.delta.*stream-delta\.ts/)

  const stray = auditEventSchemas({
    specEventNames,
    schemaFileNames: ['session-started.ts', 'stream-delta.ts', 'session-snapshot.ts'],
    registryKeys: specEventNames,
  })
  assert.equal(stray.length, 1)
  assert.match(stray[0], /session-snapshot\.ts.*§2\.3 event/)

  const registry = auditEventSchemas({
    specEventNames,
    schemaFileNames: ['session-started.ts', 'stream-delta.ts'],
    registryKeys: ['session.started'],
  })
  assert.equal(registry.length, 1)
  assert.match(registry[0], /stream\.delta.*EVENT_SCHEMAS registry/)

  assert.notEqual(
    auditEventSchemas({ specEventNames: [], schemaFileNames: [], registryKeys: [] }),
    [],
  )
})

void test('repository: every §2.3 event has a schema file and a registry entry (附录 D CI 强制)', async () => {
  const [markdown, files, indexSource] = await Promise.all([
    readFile(resolve(root, SPEC_EVENT_TABLE_PATH), 'utf8'),
    readdir(resolve(root, EVENT_SCHEMAS_DIR)),
    readFile(resolve(root, EVENT_SCHEMAS_DIR, 'index.ts'), 'utf8'),
  ])
  const specEventNames = parseEventNames(markdown)
  assert.equal(specEventNames.length, 25, '§2.3 event table must stay at the 25 registered events')
  assert.deepEqual(
    auditEventSchemas({
      specEventNames,
      schemaFileNames: files,
      registryKeys: parseRegistryKeys(indexSource),
    }),
    [],
  )
  assert.deepEqual(auditRepository(), [])
})
