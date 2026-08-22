import { createHash, randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
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
const EVOLUTION_RECORD_SCHEMA_VERSION = 2
const EVOLUTION_RECORD_ID_PATTERN = /^[0-9a-f]{32}$/
const EVOLUTION_JOURNAL_SCHEMA_VERSION = 1
const AUDIT_FILE_NAME = 'audit.jsonl'
const JOURNAL_FILE_NAME = '.evolution-txn.json'
const LOCK_FILE_NAME = '.evolution-lock.json'
const LOCK_POLL_INTERVAL_MS = 25
const LOCK_TIMEOUT_MS_DEFAULT = 5_000
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
const versionTwoRecordKeys = ['schemaVersion', 'recordId', 'sequence', ...legacyRecordKeys] as const
const journalKeys = [
  'auditPrefixDigest',
  'auditSizeBefore',
  'namespace',
  'namespaceFile',
  'namespacePrefixDigest',
  'namespaceSizeBefore',
  'recordId',
  'recordLine',
  'schemaVersion',
  'sequence',
  'state',
] as const
function isJournalState(value: unknown): value is EvolutionJournalState {
  return typeof value === 'string' && journalStates.has(value)
}
const journalStates: ReadonlySet<string> = new Set([
  'PREPARED',
  'NAMESPACE_DURABLE',
  'BOTH_DURABLE',
  'RECOVERY_REQUIRED',
])
const lowerHex64 = /^[0-9a-f]{64}$/
const utf8 = new TextDecoder('utf-8', { fatal: true })

export type EvolutionStoreDiagnosticCode =
  | 'evolution_record_invalid'
  | 'evolution_record_line_too_large'
  | 'evolution_record_future_schema'
  | 'evolution_record_cross_constraint'
  | 'evolution_record_continuity'
  | 'evolution_record_time_regression'
  | 'evolution_record_sequence_regression'
  | 'evolution_namespace_apply_unsupported'
  | 'evolution_journal_recovery_aborted'
  | 'evolution_journal_recovery_completed'
  | 'evolution_journal_recovery_required'
  | 'evolution_lock_stolen'

export interface EvolutionStoreDiagnostic {
  readonly code: EvolutionStoreDiagnosticCode
  readonly namespace?: EvolutionNamespace
  readonly param?: ContextTunableParam
}

export interface EvolutionStoreOptions {
  readonly onDiagnostic?: (diagnostic: EvolutionStoreDiagnostic) => void
  /** Cross-process lock acquisition timeout in milliseconds (default 5000). */
  readonly lockTimeoutMs?: number
}

export interface EvolutionStoreHealth {
  readonly journal: 'clean' | 'recovery-required'
  readonly valid: boolean
  readonly detail: string
}

export type EvolutionJournalState =
  | 'PREPARED'
  | 'NAMESPACE_DURABLE'
  | 'BOTH_DURABLE'
  | 'RECOVERY_REQUIRED'

/**
 * T1b crash-recovery journal. Written before either data file is touched and
 * removed only after BOTH durable appends are fsynced, so any crash leaves a
 * state that recovery can prove: either both files carry the exact record
 * identity, or both are restored to their pre-transaction sizes.
 */
export interface EvolutionTransactionJournal {
  readonly auditPrefixDigest: string
  readonly auditSizeBefore: number
  readonly namespace: EvolutionNamespace
  readonly namespaceFile: string
  readonly namespacePrefixDigest: string
  readonly namespaceSizeBefore: number
  readonly recordId: string
  readonly recordLine: string
  readonly schemaVersion: 1
  readonly sequence: number
  readonly state: EvolutionJournalState
}

interface DataRecord {
  readonly value: Record<string, unknown>
  readonly keys: readonly string[]
}

interface DecodedEvolutionRecord {
  readonly record: EvolutionRecord
  readonly provenance: 'legacy-v0' | 'v1' | 'v2'
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

function isSafeCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 2 ** 53 - 1
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
  let recordId: string | undefined
  let sequence: number | undefined
  if (hasSchemaVersion) {
    const schemaVersion = object.value.schemaVersion
    if (
      typeof schemaVersion === 'number' &&
      Number.isInteger(schemaVersion) &&
      schemaVersion > EVOLUTION_RECORD_SCHEMA_VERSION
    )
      return { kind: 'future' }
    if (schemaVersion === EVOLUTION_RECORD_SCHEMA_VERSION) {
      if (!hasExactKeys(object.keys, versionTwoRecordKeys)) return { kind: 'invalid' }
      const rawRecordId = object.value.recordId
      if (typeof rawRecordId !== 'string' || !EVOLUTION_RECORD_ID_PATTERN.test(rawRecordId))
        return { kind: 'invalid' }
      recordId = rawRecordId
      const rawSequence = object.value.sequence
      if (!isSafeCount(rawSequence)) return { kind: 'invalid' }
      sequence = rawSequence
    } else if (schemaVersion === 1) {
      if (!hasExactKeys(object.keys, versionOneRecordKeys)) return { kind: 'invalid' }
    } else {
      return { kind: 'invalid' }
    }
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
      provenance: hasSchemaVersion
        ? object.value.schemaVersion === EVOLUTION_RECORD_SCHEMA_VERSION
          ? 'v2'
          : 'v1'
        : 'legacy-v0',
      record: Object.freeze({
        ...(recordId === undefined || sequence === undefined ? {} : { recordId, sequence }),
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

function decodeJournal(input: string): EvolutionTransactionJournal {
  const object = dataRecord(JSON.parse(input))
  if (!object || !hasExactKeys(object.keys, journalKeys))
    throw new TypeError('invalid evolution journal shape')
  if (object.value.schemaVersion !== EVOLUTION_JOURNAL_SCHEMA_VERSION)
    throw new TypeError('invalid evolution journal schema version')
  const state: unknown = object.value.state
  if (!isJournalState(state)) throw new TypeError('invalid evolution journal state')
  if (!isEvolutionNamespace(object.value.namespace))
    throw new TypeError('invalid evolution journal namespace')
  const namespace = object.value.namespace
  const namespaceFile = object.value.namespaceFile
  if (namespaceFile !== `${namespace}.jsonl`)
    throw new TypeError('invalid evolution journal namespace file')
  const recordId = object.value.recordId
  if (typeof recordId !== 'string' || !EVOLUTION_RECORD_ID_PATTERN.test(recordId))
    throw new TypeError('invalid evolution journal record id')
  const sequence = object.value.sequence
  if (!isSafeCount(sequence)) throw new TypeError('invalid evolution journal sequence')
  const namespaceSizeBefore = object.value.namespaceSizeBefore
  if (!isSafeCount(namespaceSizeBefore)) throw new TypeError('invalid evolution journal size')
  const namespacePrefixDigest = object.value.namespacePrefixDigest
  if (typeof namespacePrefixDigest !== 'string' || !lowerHex64.test(namespacePrefixDigest))
    throw new TypeError('invalid evolution journal digest')
  const auditSizeBefore = object.value.auditSizeBefore
  if (!isSafeCount(auditSizeBefore)) throw new TypeError('invalid evolution journal size')
  const auditPrefixDigest = object.value.auditPrefixDigest
  if (typeof auditPrefixDigest !== 'string' || !lowerHex64.test(auditPrefixDigest))
    throw new TypeError('invalid evolution journal digest')
  const recordLine = object.value.recordLine
  if (
    typeof recordLine !== 'string' ||
    !recordLine.endsWith('\n') ||
    Buffer.byteLength(recordLine, 'utf8') > EVOLUTION_RECORD_LINE_MAX_BYTES + 1
  )
    throw new TypeError('invalid evolution journal record line')
  return Object.freeze({
    auditPrefixDigest,
    auditSizeBefore,
    namespace,
    namespaceFile,
    namespacePrefixDigest,
    namespaceSizeBefore,
    recordId,
    recordLine,
    schemaVersion: EVOLUTION_JOURNAL_SCHEMA_VERSION,
    sequence,
    state,
  })
}

function isPrefixOf(extra: Uint8Array, line: Buffer): boolean {
  return extra.length <= line.length && line.subarray(0, extra.length).equals(extra)
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size
  } catch (error) {
    if (errnoOf(error) === 'ENOENT') return 0
    throw error
  }
}

async function digestPrefix(path: string, size: number): Promise<string> {
  const hash = createHash('sha256')
  if (size === 0) return hash.digest('hex')
  for await (const chunk of createReadStream(path, { start: 0, end: size - 1 })) hash.update(chunk)
  return hash.digest('hex')
}

async function readRange(path: string, start: number, end: number): Promise<Buffer> {
  if (end <= start) return Buffer.alloc(0)
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(end - start)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start)
    if (bytesRead !== buffer.length) throw new Error('evolution file shrank during recovery')
    return buffer
  } finally {
    await handle.close()
  }
}

async function truncateTo(path: string, size: number): Promise<void> {
  const handle = await open(path, 'r+')
  try {
    await handle.truncate(size)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (errnoOf(error) === 'ENOENT') return false
    throw error
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Narrow an fs error to its errno code without unsafe assertions. */
function errnoOf(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined
}

/**
 * Best-effort cross-process advisory lock. Stealing is limited to holders whose
 * process is demonstrably dead (`kill(pid, 0)` → ESRCH), which assumes the
 * same machine and is subject to pid-reuse races; the lock coordinates local
 * writers, it is not a security boundary.
 */
class EvolutionLock {
  #held = false
  readonly #timeoutMs: number
  readonly #onStolen: () => void
  readonly path: string
  // Parameter properties are avoided: this file must stay loadable by Node's
  // strip-only TypeScript mode (see AGENT.md §dev).
  constructor(path: string, options: { lockTimeoutMs?: number; onStolen?: () => void } = {}) {
    this.path = path
    this.#timeoutMs = options.lockTimeoutMs ?? LOCK_TIMEOUT_MS_DEFAULT
    this.#onStolen = options.onStolen ?? (() => {})
  }
  get held(): boolean {
    return this.#held
  }
  async acquire(): Promise<void> {
    if (this.#held) return
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    const deadline = Date.now() + this.#timeoutMs
    for (;;) {
      const payload = this.#payload()
      try {
        const handle = await open(this.path, 'wx', 0o600)
        try {
          await handle.write(payload)
          await handle.sync()
        } finally {
          await handle.close()
        }
        this.#held = true
        return
      } catch (error) {
        if (errnoOf(error) !== 'EEXIST') throw error
        if (!(await this.#holderAlive())) {
          // Atomic replace, then re-verify we still own it (two stealers race).
          const temp = `${this.path}.${process.pid}.tmp`
          await writeFile(temp, payload, { mode: 0o600 })
          await rename(temp, this.path)
          if ((await readFile(this.path, 'utf8')) !== payload) continue
          this.#held = true
          this.#onStolen()
          return
        }
        if (Date.now() >= deadline) throw new TypeError('evolution lock busy', { cause: error })
        await sleep(LOCK_POLL_INTERVAL_MS)
      }
    }
  }
  async release(): Promise<void> {
    if (!this.#held) return
    this.#held = false
    try {
      await unlink(this.path)
    } catch (error) {
      if (errnoOf(error) !== 'ENOENT') throw error
    }
  }
  #payload(): string {
    return `${JSON.stringify({
      acquiredAt: new Date().toISOString(),
      pid: process.pid,
      schemaVersion: 1,
    })}\n`
  }
  async #holderAlive(): Promise<boolean> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path, 'utf8'))
      const pid =
        typeof parsed === 'object' && parsed !== null
          ? (parsed as { pid?: unknown }).pid
          : undefined
      if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false
      try {
        process.kill(pid, 0)
        return true
      } catch (error) {
        // EPERM/EACCES mean the process exists but is not ours to signal.
        return errnoOf(error) !== 'ESRCH'
      }
    } catch {
      return false
    }
  }
}

export class EvolutionStore implements EvolutionPersistence {
  #writeQueue = Promise.resolve()
  readonly #lock: EvolutionLock
  readonly #journalPath: string
  #journalClean = false
  #recoveryRequired: string | undefined
  readonly root: string
  readonly options: EvolutionStoreOptions
  constructor(root: string, options: EvolutionStoreOptions = {}) {
    this.root = root
    this.options = options
    this.#journalPath = join(root, JOURNAL_FILE_NAME)
    this.#lock = new EvolutionLock(join(root, LOCK_FILE_NAME), {
      ...(options.lockTimeoutMs === undefined ? {} : { lockTimeoutMs: options.lockTimeoutMs }),
      onStolen: () => this.diagnostic({ code: 'evolution_lock_stolen' }),
    })
  }
  async current(namespace: EvolutionNamespace): Promise<Record<string, number>> {
    await this.#ensureRecovered()
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
    // Shape validation happens before any lock acquisition or path creation:
    // invalid caller input must leave the filesystem untouched.
    const predecoded = decodeEvolutionRecord(record)
    if (predecoded.kind !== 'valid') throw new TypeError('invalid evolution record')
    const write = this.#writeQueue.then(() =>
      this.#withMutationLock(async () => {
        const prepared = await this.#prepareAppend(record)
        await this.#appendTxnLocked(prepared.enriched, prepared.namespaceSize, prepared.auditSize)
      }),
    )
    this.#writeQueue = write.catch(() => {})
    await write
  }
  async audit(namespace?: string, since?: Date): Promise<EvolutionAuditRecord[]> {
    if (since !== undefined && !validDateInput(since))
      throw new TypeError('invalid evolution audit timestamp')
    await this.#ensureRecovered()
    const history = await this.read(join(this.root, AUDIT_FILE_NAME))
    return history.records
      .map(({ record, provenance }) => Object.freeze({ ...record, provenance }))
      .filter(
        (record) =>
          (!namespace || record.namespace === namespace) &&
          (!since || new Date(record.at).getTime() >= since.getTime()),
      )
  }
  async rollback(namespace: EvolutionNamespace = 'context', to?: Date): Promise<EvolutionRecord[]> {
    // Pre-checks run before the lock so rejected maintenance input never
    // creates the store directory or lock file.
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
    return this.#withMutationLock(async () => {
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
        const prepared = await this.#prepareAppend(record)
        await this.#appendTxnLocked(prepared.enriched, prepared.namespaceSize, prepared.auditSize)
        records.push(prepared.enriched)
        projected[param] = after
      }
      return records
    })
  }
  /**
   * Doctor/upgrade surface (§15.11 T1b). Runs recovery first, then reports
   * whether the journal is clean or requires manual intervention.
   */
  async health(): Promise<EvolutionStoreHealth> {
    await this.#ensureRecovered()
    if (this.#recoveryRequired !== undefined)
      return {
        journal: 'recovery-required',
        valid: false,
        detail: `tuning journal needs manual recovery: ${this.#recoveryRequired} (resolve or remove ${JOURNAL_FILE_NAME} under ${this.root})`,
      }
    return { journal: 'clean', valid: true, detail: 'tuning journal clean' }
  }
  /**
   * Decode/validate caller input, assign the next record identity under the
   * lock, and re-verify continuity against the durable history. Path
   * resolution happens only after this full validation.
   */
  async #prepareAppend(input: EvolutionRecord): Promise<{
    enriched: EvolutionRecord
    namespaceSize: number
    auditSize: number
  }> {
    await this.#ensureRecoveredLocked()
    if (this.#recoveryRequired !== undefined)
      throw new TypeError(`evolution recovery required: ${this.#recoveryRequired}`)
    const decoded = decodeEvolutionRecord(input)
    if (decoded.kind !== 'valid') throw new TypeError('invalid evolution record')
    // Signal values are already finite bounded numbers. Sanitizing the entire object would
    // corrupt legitimate metrics such as `token_count`; only the validated free-text field
    // can contain secret material. Record identity is store-assigned: strip whatever the
    // caller may have carried in and allocate it below under the lock.
    const source = decoded.decoded.record
    const clean = {
      action: source.action,
      at: source.at,
      before: source.before,
      after: source.after,
      namespace: source.namespace,
      param: source.param,
      signal: source.signal,
      schemaVersion: 1 as const,
      reason: sanitize(source.reason),
    }
    const normalized = decodeEvolutionRecord(clean)
    if (normalized.kind !== 'valid') throw new TypeError('invalid sanitized evolution record')
    const record = normalized.decoded.record
    const history = await this.readNamespace(record.namespace)
    if (history.futureSchema) throw new TypeError('future evolution schema blocks append')
    let sequence = 0
    for (const { record: existing } of history.records)
      if (existing.namespace === record.namespace && (existing.sequence ?? 0) > sequence)
        sequence = existing.sequence ?? 0
    const knownIds = new Set(
      history.records
        .map(({ record: existing }) => existing.recordId)
        .filter((value): value is string => value !== undefined),
    )
    let recordId = randomBytes(16).toString('hex')
    while (knownIds.has(recordId)) recordId = randomBytes(16).toString('hex')
    const enriched: EvolutionRecord = Object.freeze({
      ...record,
      recordId,
      sequence: sequence + 1,
    })
    const previous = history.records.at(-1)?.record
    if (previous && new Date(record.at).getTime() < new Date(previous.at).getTime())
      throw new TypeError('evolution record time regression')
    if (record.namespace === 'context' && isContextTunableParam(record.param)) {
      const current = this.projectContext(history.records)
      if (record.before !== current[record.param])
        throw new TypeError('evolution record continuity mismatch')
      const candidate = { ...current, [record.param]: record.after }
      if (!isValidContextTuningSnapshot(candidate))
        throw new TypeError('evolution record violates context bounds')
    }
    return {
      enriched,
      namespaceSize: await fileSize(join(this.root, `${record.namespace}.jsonl`)),
      auditSize: await fileSize(join(this.root, AUDIT_FILE_NAME)),
    }
  }
  /**
   * Journal-guarded dual append. Durability caveat, disclosed per §15.7: file
   * CONTENT is fsynced at every step, but creation of NEW files (journal, lock,
   * first JSONL) cannot be made durable across power loss on Windows, and
   * Node exposes no portable directory fsync; POSIX-only deployments may add
   * one outside this package.
   */
  async #appendTxnLocked(
    enriched: EvolutionRecord,
    namespaceSizeBefore: number,
    auditSizeBefore: number,
  ): Promise<void> {
    const namespacePath = join(this.root, `${enriched.namespace}.jsonl`)
    const auditPath = join(this.root, AUDIT_FILE_NAME)
    // Decoded records are normalized to schemaVersion 1 + optional identity;
    // the durable wire line is always the store-assigned V2 shape.
    const wire = { ...enriched, schemaVersion: 2 as const }
    const recordLine = `${JSON.stringify(wire)}\n`
    if (Buffer.byteLength(recordLine, 'utf8') > EVOLUTION_RECORD_LINE_MAX_BYTES + 1)
      throw new TypeError('evolution record line too large')
    const journal: EvolutionTransactionJournal = {
      auditPrefixDigest: await digestPrefix(auditPath, auditSizeBefore),
      auditSizeBefore,
      namespace: enriched.namespace,
      namespaceFile: `${enriched.namespace}.jsonl`,
      namespacePrefixDigest: await digestPrefix(namespacePath, namespaceSizeBefore),
      namespaceSizeBefore,
      recordId: enriched.recordId!,
      recordLine,
      schemaVersion: EVOLUTION_JOURNAL_SCHEMA_VERSION,
      sequence: enriched.sequence!,
      state: 'PREPARED',
    }
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    await this.#writeJournal(journal, 'PREPARED')
    await this.appendLine(namespacePath, journal.recordLine)
    await this.#writeJournal(journal, 'NAMESPACE_DURABLE')
    await this.appendLine(auditPath, journal.recordLine)
    await this.#writeJournal(journal, 'BOTH_DURABLE')
    await rm(this.#journalPath, { force: true })
    this.#journalClean = true
  }
  async #writeJournal(journal: EvolutionTransactionJournal, state: EvolutionJournalState) {
    const handle = await open(this.#journalPath, 'w', 0o600)
    try {
      await handle.write(`${JSON.stringify({ ...journal, state })}\n`)
      await handle.sync()
    } finally {
      await handle.close()
    }
  }
  async #ensureRecovered(): Promise<void> {
    if (this.#recoveryRequired !== undefined || this.#journalClean) return
    if (!(await pathExists(this.#journalPath))) {
      this.#journalClean = true
      return
    }
    await this.#withMutationLock(() => this.#recoverLocked())
  }
  async #ensureRecoveredLocked(): Promise<void> {
    if (this.#recoveryRequired !== undefined || this.#journalClean) return
    if (!(await pathExists(this.#journalPath))) {
      this.#journalClean = true
      return
    }
    await this.#recoverLocked()
  }
  /**
   * Resolve an in-flight journal. Default outcome for PREPARED /
   * NAMESPACE_DURABLE is abort back to the pre-transaction sizes; BOTH_DURABLE
   * commits only when BOTH files end with the exact journaled record line.
   * Anything unprovable becomes RECOVERY_REQUIRED: files are left untouched
   * and all mutations are refused until manual intervention.
   */
  async #recoverLocked(): Promise<
    'clean' | 'completed' | 'aborted' | 'required' | 'already-required'
  > {
    if (this.#recoveryRequired !== undefined) return 'already-required'
    if (!(await pathExists(this.#journalPath))) {
      this.#journalClean = true
      return 'clean'
    }
    let journal: EvolutionTransactionJournal
    try {
      journal = decodeJournal(await readFile(this.#journalPath, 'utf8'))
    } catch {
      this.#markRecoveryRequired('journal unreadable')
      return 'required'
    }
    if (journal.state === 'RECOVERY_REQUIRED') {
      this.#markRecoveryRequired('journal marked by an earlier recovery')
      return 'required'
    }
    const namespacePath = join(this.root, journal.namespaceFile)
    const auditPath = join(this.root, AUDIT_FILE_NAME)
    const fail = (reason: string): 'required' => {
      this.#markRecoveryRequired(reason, journal)
      return 'required'
    }
    for (const [path, sizeBefore, digest] of [
      [namespacePath, journal.namespaceSizeBefore, journal.namespacePrefixDigest],
      [auditPath, journal.auditSizeBefore, journal.auditPrefixDigest],
    ] as const) {
      const size = await fileSize(path)
      if (size < sizeBefore) return fail(`${path} is shorter than the journalled pre-size`)
      if ((await digestPrefix(path, sizeBefore)) !== digest)
        return fail(`${path} diverged before the journalled pre-size`)
    }
    const namespaceExtra = await readRange(
      namespacePath,
      journal.namespaceSizeBefore,
      await fileSize(namespacePath),
    )
    const auditExtra = await readRange(
      auditPath,
      journal.auditSizeBefore,
      await fileSize(auditPath),
    )
    const line = Buffer.from(journal.recordLine, 'utf8')
    if (journal.state === 'BOTH_DURABLE') {
      if (!namespaceExtra.equals(line) || !auditExtra.equals(line))
        return fail('BOTH_DURABLE bytes do not match the journalled record')
      await rm(this.#journalPath, { force: true })
      this.#journalClean = true
      this.diagnostic({
        code: 'evolution_journal_recovery_completed',
        namespace: journal.namespace,
      })
      return 'completed'
    }
    if (!isPrefixOf(namespaceExtra, line) || !isPrefixOf(auditExtra, line))
      return fail('partial bytes do not belong to the journalled transaction')
    if (namespaceExtra.length > 0) await truncateTo(namespacePath, journal.namespaceSizeBefore)
    if (auditExtra.length > 0) await truncateTo(auditPath, journal.auditSizeBefore)
    await rm(this.#journalPath, { force: true })
    this.#journalClean = true
    this.diagnostic({ code: 'evolution_journal_recovery_aborted', namespace: journal.namespace })
    return 'aborted'
  }
  #markRecoveryRequired(reason: string, journal?: EvolutionTransactionJournal): void {
    this.#recoveryRequired = reason
    this.diagnostic({ code: 'evolution_journal_recovery_required' })
    if (journal === undefined) return
    this.#writeJournal(journal, 'RECOVERY_REQUIRED').catch(() => {
      // The in-memory flag already blocks mutations; a failed marker rewrite
      // must not mask the original reason.
    })
  }
  async #withMutationLock<T>(fn: () => Promise<T>): Promise<T> {
    await this.#lock.acquire()
    try {
      return await fn()
    } finally {
      await this.#lock.release()
    }
  }
  private async appendLine(path: string, value: string) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const file = await open(path, 'a', 0o600)
    try {
      await file.write(value)
      await file.sync()
    } finally {
      await file.close()
    }
  }
  private readNamespace(namespace: EvolutionNamespace) {
    return this.read(join(this.root, `${namespace}.jsonl`), namespace)
  }
  private async read(path: string, expectedNamespace?: EvolutionNamespace): Promise<ReadResult> {
    const records: DecodedEvolutionRecord[] = []
    let futureSchema = false
    let lastAcceptedTime = Number.NEGATIVE_INFINITY
    let lastAcceptedSequence: number | undefined
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
            const sequence = result.decoded.record.sequence
            if (
              expectedNamespace !== undefined &&
              sequence !== undefined &&
              lastAcceptedSequence !== undefined &&
              sequence <= lastAcceptedSequence
            ) {
              this.diagnostic({
                code: 'evolution_record_sequence_regression',
                namespace: expectedNamespace,
                ...(isContextTunableParam(result.decoded.record.param)
                  ? { param: result.decoded.record.param }
                  : {}),
              })
            } else if (expectedNamespace && at < lastAcceptedTime) {
              this.diagnostic({
                code: 'evolution_record_time_regression',
                namespace: expectedNamespace,
                ...(isContextTunableParam(result.decoded.record.param)
                  ? { param: result.decoded.record.param }
                  : {}),
              })
            } else {
              records.push(result.decoded)
              if (expectedNamespace) {
                lastAcceptedTime = at
                if (sequence !== undefined) lastAcceptedSequence = sequence
              }
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

const TUNING_MEMORY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

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
  readonly root: string
  constructor(root: string) {
    this.root = root
  }
  async write(input: {
    id: string
    title: string
    body: string
    tags?: string[]
  }): Promise<TuningMemory> {
    // The id becomes a filename; validate before any path construction.
    if (!TUNING_MEMORY_ID_PATTERN.test(input.id)) throw new TypeError('invalid tuning memory id')
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
    if (!TUNING_MEMORY_ID_PATTERN.test(id)) throw new TypeError('invalid tuning memory id')
    return JSON.parse(await readFile(join(this.root, `${id}.json`), 'utf8')) as TuningMemory
  }
}
