import { createReadStream } from 'node:fs'
import { mkdir, open, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { TextDecoder, types as utilTypes } from 'node:util'

import type {
  ContextTunableParam,
  EvolutionAuditRecord,
  EvolutionNamespace,
  EvolutionPersistence,
  EvolutionRecord,
} from '@apollo-code/core'
import {
  CONTEXT_TUNABLE_DEFAULTS,
  CONTEXT_TUNABLE_PARAMS,
  EVOLUTION_DEFAULTS,
  isContextTunableParam,
  isContextTunableValue,
  isValidContextTuningSnapshot,
} from '@apollo-code/core'
import { sanitize } from '@apollo-code/shared'

const EVOLUTION_RECORD_LINE_MAX_BYTES = 16 * 1024
const EVOLUTION_REASON_MAX_BYTES = 1024
const EVOLUTION_SIGNAL_MAX_ENTRIES = 32
const EVOLUTION_SIGNAL_KEY_MAX_BYTES = 64
const EVOLUTION_SIGNAL_ABS_MAX = 1_000_000
const EVOLUTION_NUMBER_ABS_MAX = 1_000_000_000
const evolutionNamespaces: ReadonlySet<string> = new Set([
  'context',
  'router',
  'retry',
  'tool-timeout',
])
const evolutionActions: ReadonlySet<string> = new Set([
  'adjusted',
  'rolled_back',
  'stopped',
  'confirmation_rejected',
])
const legacyRecordKeys = [
  'namespace',
  'param',
  'before',
  'after',
  'at',
  'reason',
  'signal',
  'action',
] as const
const versionOneRecordKeys = ['schemaVersion', ...legacyRecordKeys] as const
const utf8 = new TextDecoder('utf-8', { fatal: true })

export type EvolutionStoreDiagnosticCode =
  | 'evolution_record_invalid'
  | 'evolution_record_line_too_large'
  | 'evolution_record_future_schema'
  | 'evolution_record_cross_constraint'
  | 'evolution_record_continuity'
  | 'evolution_record_time_regression'
  | 'evolution_namespace_apply_unsupported'

export interface EvolutionStoreDiagnostic {
  readonly code: EvolutionStoreDiagnosticCode
  readonly namespace?: EvolutionNamespace
  readonly param?: ContextTunableParam
}

export interface EvolutionStoreOptions {
  readonly onDiagnostic?: (diagnostic: EvolutionStoreDiagnostic) => void
}

interface DataRecord {
  readonly value: Record<string, unknown>
  readonly keys: readonly string[]
}

interface DecodedEvolutionRecord {
  readonly record: EvolutionRecord
  readonly provenance: 'legacy-v0' | 'v1'
}

type DecodeResult =
  | { readonly kind: 'valid'; readonly decoded: DecodedEvolutionRecord }
  | { readonly kind: 'invalid'; readonly param?: ContextTunableParam }
  | { readonly kind: 'future' }

interface ReadResult {
  readonly records: readonly DecodedEvolutionRecord[]
  readonly futureSchema: boolean
}

interface BoundedLine {
  readonly bytes?: Uint8Array
  readonly oversized: boolean
}

function dataRecord(input: unknown): DataRecord | undefined {
  try {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined
    if (utilTypes.isProxy(input)) return undefined
    const prototype = Object.getPrototypeOf(input)
    if (prototype !== Object.prototype && prototype !== null) return undefined
    const ownKeys = Reflect.ownKeys(input)
    const keys: string[] = []
    const value: Record<string, unknown> = {}
    for (const key of ownKeys) {
      if (typeof key !== 'string') return undefined
      const descriptor = Object.getOwnPropertyDescriptor(input, key)
      if (!descriptor?.enumerable || !('value' in descriptor)) return undefined
      Object.defineProperty(value, key, {
        configurable: true,
        enumerable: true,
        value: descriptor.value,
        writable: true,
      })
      keys.push(key)
    }
    return { value, keys }
  } catch {
    return undefined
  }
}

function isEvolutionNamespace(value: unknown): value is EvolutionNamespace {
  return typeof value === 'string' && evolutionNamespaces.has(value)
}

function isEvolutionAction(value: unknown): value is EvolutionRecord['action'] {
  return typeof value === 'string' && evolutionActions.has(value)
}

function hasExactKeys(keys: readonly string[], expected: readonly string[]): boolean {
  return keys.length === expected.length && expected.every((key) => keys.includes(key))
}

function validIsoInstant(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 20 || value.length > 24) return false
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return false
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime())) return false
  const canonical = parsed.toISOString()
  return canonical === value || canonical.replace('.000Z', 'Z') === value
}

function validDateInput(value: unknown): value is Date {
  try {
    return value instanceof Date && Number.isFinite(Date.prototype.getTime.call(value))
  } catch {
    return false
  }
}

function validFiniteNumber(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    Math.abs(value) <= EVOLUTION_NUMBER_ABS_MAX
  )
}

function decodeSignal(input: unknown): Readonly<Record<string, number>> | undefined {
  const record = dataRecord(input)
  if (!record || record.keys.length > EVOLUTION_SIGNAL_MAX_ENTRIES) return undefined
  const signal: Record<string, number> = {}
  for (const key of record.keys) {
    if (
      Buffer.byteLength(key, 'utf8') > EVOLUTION_SIGNAL_KEY_MAX_BYTES ||
      !/^[a-z][a-z0-9_.:-]*$/.test(key)
    )
      return undefined
    const value = record.value[key]
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      Math.abs(value) > EVOLUTION_SIGNAL_ABS_MAX
    )
      return undefined
    signal[key] = value
  }
  return Object.freeze(signal)
}

function decodeEvolutionRecord(
  input: unknown,
  expectedNamespace?: EvolutionNamespace,
): DecodeResult {
  const object = dataRecord(input)
  if (!object) return { kind: 'invalid' }
  const hasSchemaVersion = Object.hasOwn(object.value, 'schemaVersion')
  if (hasSchemaVersion) {
    const schemaVersion = object.value.schemaVersion
    if (typeof schemaVersion === 'number' && Number.isInteger(schemaVersion) && schemaVersion > 1)
      return { kind: 'future' }
    if (schemaVersion !== 1 || !hasExactKeys(object.keys, versionOneRecordKeys))
      return { kind: 'invalid' }
  } else if (!hasExactKeys(object.keys, legacyRecordKeys)) return { kind: 'invalid' }

  const namespace = object.value.namespace
  if (
    !isEvolutionNamespace(namespace) ||
    (expectedNamespace !== undefined && namespace !== expectedNamespace)
  )
    return { kind: 'invalid' }
  const typedNamespace = namespace
  const param = object.value.param
  if (typeof param !== 'string') return { kind: 'invalid' }
  const contextParam =
    typedNamespace === 'context' && isContextTunableParam(param) ? param : undefined
  const knownParam =
    contextParam !== undefined ||
    (typedNamespace !== 'context' && Object.hasOwn(EVOLUTION_DEFAULTS[typedNamespace], param))
  if (!knownParam) return { kind: 'invalid' }

  const before = object.value.before
  const after = object.value.after
  if (!validFiniteNumber(before) || !validFiniteNumber(after))
    return { kind: 'invalid', ...(contextParam ? { param: contextParam } : {}) }
  if (
    contextParam &&
    (!isContextTunableValue(contextParam, before) || !isContextTunableValue(contextParam, after))
  )
    return { kind: 'invalid', param: contextParam }
  if (!validIsoInstant(object.value.at))
    return { kind: 'invalid', ...(contextParam ? { param: contextParam } : {}) }
  const reason = object.value.reason
  if (typeof reason !== 'string' || Buffer.byteLength(reason, 'utf8') > EVOLUTION_REASON_MAX_BYTES)
    return { kind: 'invalid', ...(contextParam ? { param: contextParam } : {}) }
  const safeReason = sanitize(reason)
  if (typeof safeReason !== 'string')
    return { kind: 'invalid', ...(contextParam ? { param: contextParam } : {}) }
  const signal = decodeSignal(object.value.signal)
  if (!signal) return { kind: 'invalid', ...(contextParam ? { param: contextParam } : {}) }
  const action = object.value.action
  if (!isEvolutionAction(action))
    return { kind: 'invalid', ...(contextParam ? { param: contextParam } : {}) }
  if (
    (action === 'stopped' && before !== after) ||
    ((action === 'adjusted' || action === 'rolled_back') && before === after)
  )
    return { kind: 'invalid', ...(contextParam ? { param: contextParam } : {}) }

  return {
    kind: 'valid',
    decoded: {
      provenance: hasSchemaVersion ? 'v1' : 'legacy-v0',
      record: Object.freeze({
        schemaVersion: 1,
        namespace: typedNamespace,
        param,
        before,
        after,
        at: object.value.at,
        reason: safeReason,
        signal,
        action,
      }),
    },
  }
}

export class EvolutionStore implements EvolutionPersistence {
  #writeQueue = Promise.resolve()
  constructor(
    readonly root: string,
    readonly options: EvolutionStoreOptions = {},
  ) {}
  async current(namespace: EvolutionNamespace): Promise<Record<string, number>> {
    if (!isEvolutionNamespace(namespace)) {
      this.diagnostic({ code: 'evolution_namespace_apply_unsupported' })
      return {}
    }
    if (namespace !== 'context') {
      this.diagnostic({ code: 'evolution_namespace_apply_unsupported', namespace })
      return { ...EVOLUTION_DEFAULTS[namespace] }
    }
    const history = await this.readNamespace(namespace)
    if (history.futureSchema) return { ...CONTEXT_TUNABLE_DEFAULTS }
    return this.projectContext(history.records)
  }
  async append(record: EvolutionRecord): Promise<void> {
    const decoded = decodeEvolutionRecord(record)
    if (decoded.kind !== 'valid') throw new TypeError('invalid evolution record')
    // Signal values are already finite bounded numbers. Sanitizing the entire object would
    // corrupt legitimate metrics such as `token_count`; only the validated free-text field
    // can contain secret material.
    const clean = {
      ...decoded.decoded.record,
      schemaVersion: 1 as const,
      reason: sanitize(decoded.decoded.record.reason),
    }
    const normalized = decodeEvolutionRecord(clean)
    if (normalized.kind !== 'valid') throw new TypeError('invalid sanitized evolution record')
    const write = this.#writeQueue.then(async () => {
      await this.assertAppend(normalized.decoded.record)
      await this.appendLine(
        join(this.root, `${normalized.decoded.record.namespace}.jsonl`),
        normalized.decoded.record,
      )
      await this.appendLine(join(this.root, 'audit.jsonl'), normalized.decoded.record)
    })
    this.#writeQueue = write.catch(() => {})
    await write
  }
  async audit(namespace?: string, since?: Date): Promise<EvolutionAuditRecord[]> {
    if (since !== undefined && !validDateInput(since))
      throw new TypeError('invalid evolution audit timestamp')
    const history = await this.read(join(this.root, 'audit.jsonl'))
    return history.records
      .map(({ record, provenance }) => Object.freeze({ ...record, provenance }))
      .filter(
        (record) =>
          (!namespace || record.namespace === namespace) &&
          (!since || new Date(record.at).getTime() >= since.getTime()),
      )
  }
  async rollback(namespace: EvolutionNamespace = 'context', to?: Date): Promise<EvolutionRecord[]> {
    if (!isEvolutionNamespace(namespace)) {
      this.diagnostic({ code: 'evolution_namespace_apply_unsupported' })
      return []
    }
    if (namespace !== 'context') {
      this.diagnostic({ code: 'evolution_namespace_apply_unsupported', namespace })
      return []
    }
    if (to !== undefined && !validDateInput(to))
      throw new TypeError('invalid evolution rollback timestamp')
    const history = await this.readNamespace(namespace)
    if (history.futureSchema) return []
    const eligible = to
      ? history.records.filter(({ record }) => new Date(record.at).getTime() <= to.getTime())
      : history.records.slice(0, -1)
    const current = this.projectContext(history.records)
    const target = this.projectContext(eligible)
    const records: EvolutionRecord[] = []
    const projected = { ...current }
    const pending = CONTEXT_TUNABLE_PARAMS.filter((param) => target[param] !== projected[param])
    while (pending.length > 0) {
      const safeIndex = pending.findIndex((param) =>
        isValidContextTuningSnapshot({ ...projected, [param]: target[param] }),
      )
      if (safeIndex < 0) throw new TypeError('no safe context rollback order')
      const param = pending[safeIndex]!
      pending.splice(safeIndex, 1)
      const before = projected[param]
      const after = target[param]
      const record: EvolutionRecord = {
        schemaVersion: 1,
        namespace,
        param,
        before,
        after,
        at: new Date().toISOString(),
        reason: 'manual rollback',
        signal: {},
        action: 'rolled_back',
      }
      await this.append(record)
      records.push(record)
      projected[param] = after
    }
    return records
  }
  private async appendLine(path: string, value: EvolutionRecord) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const file = await open(path, 'a', 0o600)
    try {
      await file.write(`${JSON.stringify(value)}\n`)
      await file.sync()
    } finally {
      await file.close()
    }
  }
  private readNamespace(namespace: EvolutionNamespace) {
    return this.read(join(this.root, `${namespace}.jsonl`), namespace)
  }
  private async assertAppend(record: EvolutionRecord): Promise<void> {
    const history = await this.readNamespace(record.namespace)
    if (history.futureSchema) throw new TypeError('future evolution schema blocks append')
    const previous = history.records.at(-1)?.record
    if (previous && new Date(record.at).getTime() < new Date(previous.at).getTime())
      throw new TypeError('evolution record time regression')
    if (record.namespace !== 'context' || !isContextTunableParam(record.param)) return
    const current = this.projectContext(history.records)
    if (record.before !== current[record.param])
      throw new TypeError('evolution record continuity mismatch')
    const candidate = { ...current, [record.param]: record.after }
    if (!isValidContextTuningSnapshot(candidate))
      throw new TypeError('evolution record violates context bounds')
  }
  private async read(path: string, expectedNamespace?: EvolutionNamespace): Promise<ReadResult> {
    const records: DecodedEvolutionRecord[] = []
    let futureSchema = false
    let lastAcceptedTime = Number.NEGATIVE_INFINITY
    try {
      for await (const line of this.boundedLines(path)) {
        if (line.oversized) {
          this.diagnostic({
            code: 'evolution_record_line_too_large',
            ...(expectedNamespace ? { namespace: expectedNamespace } : {}),
          })
          continue
        }
        try {
          const text = utf8.decode(line.bytes)
          if (!text.trim()) continue
          const result = decodeEvolutionRecord(JSON.parse(text), expectedNamespace)
          if (result.kind === 'future') {
            futureSchema = true
            this.diagnostic({
              code: 'evolution_record_future_schema',
              ...(expectedNamespace ? { namespace: expectedNamespace } : {}),
            })
          } else if (result.kind === 'invalid') {
            this.diagnostic({
              code: 'evolution_record_invalid',
              ...(expectedNamespace ? { namespace: expectedNamespace } : {}),
              ...(result.param ? { param: result.param } : {}),
            })
          } else {
            const at = new Date(result.decoded.record.at).getTime()
            if (expectedNamespace && at < lastAcceptedTime) {
              this.diagnostic({
                code: 'evolution_record_time_regression',
                namespace: expectedNamespace,
                ...(isContextTunableParam(result.decoded.record.param)
                  ? { param: result.decoded.record.param }
                  : {}),
              })
            } else {
              records.push(result.decoded)
              if (expectedNamespace) lastAcceptedTime = at
            }
          }
        } catch {
          this.diagnostic({
            code: 'evolution_record_invalid',
            ...(expectedNamespace ? { namespace: expectedNamespace } : {}),
          })
        }
      }
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    }
    return { records, futureSchema }
  }
  private projectContext(
    history: readonly DecodedEvolutionRecord[],
  ): Record<ContextTunableParam, number> {
    let values: Record<ContextTunableParam, number> = { ...CONTEXT_TUNABLE_DEFAULTS }
    for (const { record } of history) {
      if (record.namespace !== 'context' || !isContextTunableParam(record.param)) continue
      if (record.before !== values[record.param]) {
        this.diagnostic({
          code: 'evolution_record_continuity',
          namespace: 'context',
          param: record.param,
        })
        continue
      }
      const candidate = { ...values, [record.param]: record.after }
      if (!isValidContextTuningSnapshot(candidate)) {
        this.diagnostic({
          code: 'evolution_record_cross_constraint',
          namespace: 'context',
          param: record.param,
        })
        continue
      }
      values = candidate
    }
    return values
  }
  private async *boundedLines(path: string): AsyncGenerator<BoundedLine> {
    const parts: Buffer[] = []
    let bytes = 0
    let oversized = false
    const finish = (): BoundedLine => {
      if (oversized) return { oversized: true }
      const line = Buffer.concat(parts, bytes)
      const end = line.at(-1) === 13 ? line.length - 1 : line.length
      return { bytes: line.subarray(0, end), oversized: false }
    }
    const reset = () => {
      parts.length = 0
      bytes = 0
      oversized = false
    }
    for await (const raw of createReadStream(path)) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
      let start = 0
      while (start <= chunk.length) {
        const newline = chunk.indexOf(10, start)
        const end = newline === -1 ? chunk.length : newline
        const segment = chunk.subarray(start, end)
        if (!oversized && bytes + segment.length <= EVOLUTION_RECORD_LINE_MAX_BYTES) {
          if (segment.length > 0) parts.push(segment)
          bytes += segment.length
        } else if (segment.length > 0) {
          oversized = true
          parts.length = 0
          bytes = 0
        }
        if (newline === -1) break
        yield finish()
        reset()
        start = newline + 1
      }
    }
    if (oversized || bytes > 0) yield finish()
  }
  private diagnostic(diagnostic: EvolutionStoreDiagnostic): void {
    try {
      this.options.onDiagnostic?.(Object.freeze({ ...diagnostic }))
    } catch {
      // Diagnostics are advisory and cannot change persistence safety semantics.
    }
  }
}

export interface TuningMemory {
  id: string
  scope: 'tuning'
  source: 'evolution'
  title: string
  body: string
  tags: string[]
  created: string
  updated: string
}
export class TuningMemoryStore {
  constructor(readonly root: string) {}
  async write(input: {
    id: string
    title: string
    body: string
    tags?: string[]
  }): Promise<TuningMemory> {
    const now = new Date().toISOString()
    const memory = sanitize({
      ...input,
      tags: input.tags ?? [],
      scope: 'tuning' as const,
      source: 'evolution' as const,
      created: now,
      updated: now,
    })
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    await writeFile(join(this.root, `${input.id}.json`), JSON.stringify(memory, null, 2), {
      mode: 0o600,
    })
    return memory
  }
  async read(id: string): Promise<TuningMemory> {
    return JSON.parse(await readFile(join(this.root, `${id}.json`), 'utf8')) as TuningMemory
  }
}
