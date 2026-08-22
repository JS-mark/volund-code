import { types as utilTypes } from 'node:util'

export const EVOLUTION_DEFAULTS = Object.freeze({
  context: Object.freeze({
    compaction_threshold: 0.85,
    target_ratio: 0.6,
    keep_recent: 20,
    summary_keep_recent: 20,
  }),
  router: Object.freeze({ cooldown_ms: 60_000, max_attempts: 6 }),
  retry: Object.freeze({ max_retries: 2, backoff_factor: 4 }),
  'tool-timeout': Object.freeze({ default_timeout_ms: 60_000 }),
})

export const CONTEXT_TUNABLE_DEFAULTS = EVOLUTION_DEFAULTS.context
export type EvolutionNamespace = keyof typeof EVOLUTION_DEFAULTS
export type ContextTunableParam = keyof typeof CONTEXT_TUNABLE_DEFAULTS
export interface ContextTunableBound {
  readonly min: number
  readonly max: number
  readonly integer: boolean
}
export const CONTEXT_TUNABLE_BOUNDS = Object.freeze({
  compaction_threshold: Object.freeze({ min: 0.65, max: 0.95, integer: false }),
  target_ratio: Object.freeze({ min: 0.45, max: 0.75, integer: false }),
  keep_recent: Object.freeze({ min: 15, max: 25, integer: true }),
  summary_keep_recent: Object.freeze({ min: 15, max: 25, integer: true }),
}) satisfies Readonly<Record<ContextTunableParam, ContextTunableBound>>
export const CONTEXT_TUNABLE_PARAMS: readonly ContextTunableParam[] = Object.freeze([
  'compaction_threshold',
  'target_ratio',
  'keep_recent',
  'summary_keep_recent',
])

export function isContextTunableParam(value: string): value is ContextTunableParam {
  return Object.hasOwn(CONTEXT_TUNABLE_BOUNDS, value)
}

export function isContextTunableValue(param: ContextTunableParam, value: unknown): value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return false
  const bound = CONTEXT_TUNABLE_BOUNDS[param]
  return value >= bound.min && value <= bound.max && (!bound.integer || Number.isInteger(value))
}

export function isValidContextTuningSnapshot(
  value: Readonly<Record<ContextTunableParam, number>>,
): boolean {
  return (
    CONTEXT_TUNABLE_PARAMS.every((param) => isContextTunableValue(param, value[param])) &&
    value.target_ratio + 0.1 <= value.compaction_threshold
  )
}

/**
 * Atomically projects an untrusted persistence result onto the complete context snapshot.
 * Any accessor, Proxy, unknown key, invalid scalar, or cross-field violation rejects the whole
 * projection. I/O rejection is deliberately handled by the caller and is not converted here.
 */
export function projectContextTuningSnapshot(
  input: unknown,
): Readonly<Record<ContextTunableParam, number>> | undefined {
  try {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined
    if (utilTypes.isProxy(input)) return undefined
    const prototype = Object.getPrototypeOf(input)
    if (prototype !== Object.prototype && prototype !== null) return undefined
    const keys = Reflect.ownKeys(input)
    const candidate: Record<ContextTunableParam, number> = { ...CONTEXT_TUNABLE_DEFAULTS }
    for (const key of keys) {
      if (typeof key !== 'string' || !isContextTunableParam(key)) return undefined
      const descriptor = Object.getOwnPropertyDescriptor(input, key)
      if (!descriptor?.enumerable || !('value' in descriptor)) return undefined
      if (!isContextTunableValue(key, descriptor.value)) return undefined
      candidate[key] = descriptor.value
    }
    if (!isValidContextTuningSnapshot(candidate)) return undefined
    return Object.freeze(candidate)
  } catch {
    return undefined
  }
}

export type EvolutionParam = string
export type EvolutionSignal = Record<string, number>
export type EvolutionAction = 'adjusted' | 'rolled_back' | 'stopped' | 'confirmation_rejected'
export interface EvolutionRecord {
  schemaVersion: 1
  namespace: EvolutionNamespace
  param: EvolutionParam
  before: number
  after: number
  at: string
  reason: string
  signal: EvolutionSignal
  action: EvolutionAction
}
export type EvolutionRecordProvenance = 'legacy-v0' | 'v1'
export interface EvolutionAuditRecord extends EvolutionRecord {
  provenance: EvolutionRecordProvenance
}
export interface EvolutionPersistence {
  current(namespace: EvolutionNamespace): Promise<unknown>
  append(record: EvolutionRecord): Promise<void>
  audit?(namespace?: EvolutionNamespace): Promise<EvolutionAuditRecord[]>
}
export interface EvolutionConfirmation {
  namespace: EvolutionNamespace
  param: string
  before: number
  proposed: number
  defaultValue: number
  deviationPct: number
  reason: string
}
export interface EvolutionOptions {
  enabled?: boolean
  namespaces?: readonly EvolutionNamespace[]
  sampleWindow?: number
  worsenStreakLimit?: number
  confirmationDeviation?: number
  confirm?: (request: EvolutionConfirmation) => Promise<boolean>
  toolTimeoutDefaults?: Readonly<Record<string, number>>
  now?: () => Date
}

const STATIC_PARAMS: Readonly<Record<EvolutionNamespace, ReadonlySet<string>>> = {
  context: new Set(Object.keys(EVOLUTION_DEFAULTS.context)),
  router: new Set(Object.keys(EVOLUTION_DEFAULTS.router)),
  retry: new Set(Object.keys(EVOLUTION_DEFAULTS.retry)),
  'tool-timeout': new Set(['default_timeout_ms']),
}
const allowed = (namespace: EvolutionNamespace, param: string) =>
  STATIC_PARAMS[namespace].has(param) ||
  (namespace === 'tool-timeout' && /^tool:[a-zA-Z0-9_.:-]+:timeout_ms$/.test(param))

const fixedStep = (namespace: EvolutionNamespace, param: string) => {
  if (namespace === 'tool-timeout') return 10_000
  if (namespace === 'retry' && param === 'max_retries') return 1
  if (namespace === 'router' && param === 'max_attempts') return 1
  if (param.endsWith('recent')) return 2
  if (param.includes('threshold') || param.includes('ratio')) return 0.05
  return Number.POSITIVE_INFINITY
}
const clamp = (namespace: EvolutionNamespace, param: string, before: number, proposed: number) => {
  const max = Math.min(fixedStep(namespace, param), Math.abs(before * 0.1))
  const delta = Math.max(-max, Math.min(max, proposed - before))
  const value = Number((before + delta).toFixed(4))
  return namespace === 'tool-timeout' ? Math.min(300_000, Math.max(1_000, value)) : value
}

function clampContextValue(
  param: ContextTunableParam,
  value: number,
  snapshot: Readonly<Record<ContextTunableParam, number>>,
): number {
  const bound = CONTEXT_TUNABLE_BOUNDS[param]
  let min: number = bound.min
  let max: number = bound.max
  if (param === 'compaction_threshold') min = Math.max(min, snapshot.target_ratio + 0.1)
  if (param === 'target_ratio') max = Math.min(max, snapshot.compaction_threshold - 0.1)
  const bounded = Math.max(min, Math.min(max, value))
  return bound.integer ? Math.round(bounded) : Number(bounded.toFixed(4))
}

export class EvolutionEngine {
  readonly #windows = new Map<EvolutionNamespace, EvolutionSignal[]>()
  readonly #last = new Map<string, EvolutionRecord>()
  readonly #worsen = new Map<string, number>()
  readonly #stopped = new Set<string>()
  readonly #options: Required<Omit<EvolutionOptions, 'toolTimeoutDefaults'>> & {
    toolTimeoutDefaults: Readonly<Record<string, number>>
  }
  #restored = false
  constructor(
    readonly persistence: EvolutionPersistence,
    options: EvolutionOptions = {},
  ) {
    this.#options = {
      namespaces: ['context', 'router', 'retry', 'tool-timeout'],
      sampleWindow: 20,
      worsenStreakLimit: 3,
      confirmationDeviation: 0.25,
      confirm: async () => false,
      toolTimeoutDefaults: {},
      now: () => new Date(),
      ...options,
      // This is a runtime authority boundary, not merely a TypeScript convenience.
      // Callers crossing JS/config/plugin boundaries must opt in with the literal boolean true.
      enabled: options.enabled === true,
    }
  }
  isEnabled(namespace: EvolutionNamespace) {
    return this.#options.enabled === true && this.#options.namespaces.includes(namespace)
  }
  async values(): Promise<Record<ContextTunableParam, number>>
  async values(namespace: EvolutionNamespace): Promise<Record<string, number>>
  async values(namespace: EvolutionNamespace = 'context'): Promise<Record<string, number>> {
    const defaults = this.#defaults(namespace)
    if (!this.isEnabled(namespace) || namespace !== 'context') return defaults
    return projectContextTuningSnapshot(await this.persistence.current(namespace)) ?? defaults
  }
  async observe(
    namespace: EvolutionNamespace,
    signal: EvolutionSignal,
  ): Promise<EvolutionRecord | undefined>
  async observe(signal: EvolutionSignal): Promise<EvolutionRecord | undefined>
  async observe(first: EvolutionNamespace | EvolutionSignal, second?: EvolutionSignal) {
    const namespace = typeof first === 'string' ? first : 'context'
    const signal = typeof first === 'string' ? second! : first
    if (!this.isEnabled(namespace)) return
    const bucket = this.#windows.get(namespace) ?? []
    bucket.push(signal)
    this.#windows.set(namespace, bucket)
    if (bucket.length < this.#options.sampleWindow) return
    this.#windows.set(namespace, [])
    const aggregate = Object.fromEntries(
      [...new Set(bucket.flatMap(Object.keys))].map((key) => [
        key,
        bucket.reduce((sum, item) => sum + (item[key] ?? 0), 0) / bucket.length,
      ]),
    )
    return this.#evaluate(namespace, aggregate)
  }
  async propose(
    namespace: EvolutionNamespace,
    param: string,
    proposed: number,
    reason: string,
    signal: EvolutionSignal,
  ): Promise<EvolutionRecord | undefined>
  async propose(
    param: ContextTunableParam,
    proposed: number,
    reason: string,
    signal: EvolutionSignal,
  ): Promise<EvolutionRecord | undefined>
  async propose(
    first: EvolutionNamespace | ContextTunableParam,
    second: string | number,
    third: number | string,
    fourth: string | EvolutionSignal,
    fifth?: EvolutionSignal,
  ) {
    const namespace: EvolutionNamespace =
      first in EVOLUTION_DEFAULTS ? (first as EvolutionNamespace) : 'context'
    const param = namespace === first ? String(second) : String(first)
    const proposed = Number(namespace === first ? third : second)
    const reason = String(namespace === first ? fourth : third)
    const signal = (namespace === first ? fifth : fourth) as EvolutionSignal
    if (!this.isEnabled(namespace) || !allowed(namespace, param)) return
    await this.#restore()
    const key = `${namespace}:${param}`
    if (this.#stopped.has(key)) return
    const defaults = this.#defaults(namespace)
    const defaultValue = defaults[param]
    if (defaultValue === undefined) return
    const values = await this.values(namespace)
    const before = values[param] ?? defaultValue
    let after = clamp(namespace, param, before, proposed)
    if (namespace === 'context' && isContextTunableParam(param)) {
      after = clampContextValue(param, after, values as Record<ContextTunableParam, number>)
      const candidate = { ...values, [param]: after } as Record<ContextTunableParam, number>
      if (!isValidContextTuningSnapshot(candidate)) return
    }
    if (after === before) return
    const deviationPct =
      defaultValue === 0 ? 0 : Math.abs(after - defaultValue) / Math.abs(defaultValue)
    if (deviationPct > this.#options.confirmationDeviation) {
      const accepted = await this.#options.confirm({
        namespace,
        param,
        before,
        proposed: after,
        defaultValue,
        deviationPct,
        reason,
      })
      if (!accepted) {
        const rejected = this.#record(
          namespace,
          param,
          before,
          defaultValue,
          `${reason}; cumulative deviation rejected; parameter restored and frozen`,
          signal,
          'confirmation_rejected',
        )
        await this.persistence.append(rejected)
        this.#stopped.add(key)
        return rejected
      }
    }
    const record = this.#record(namespace, param, before, after, reason, signal, 'adjusted')
    await this.persistence.append(record)
    this.#last.set(key, record)
    return record
  }
  async validate(
    namespace: EvolutionNamespace,
    param: string,
    worsened: boolean,
    signal: EvolutionSignal,
  ): Promise<EvolutionRecord | undefined>
  async validate(
    param: ContextTunableParam,
    worsened: boolean,
    signal: EvolutionSignal,
  ): Promise<EvolutionRecord | undefined>
  async validate(
    first: EvolutionNamespace | ContextTunableParam,
    second: string | boolean,
    third: boolean | EvolutionSignal,
    fourth?: EvolutionSignal,
  ) {
    const namespace: EvolutionNamespace =
      first in EVOLUTION_DEFAULTS ? (first as EvolutionNamespace) : 'context'
    const param = namespace === first ? String(second) : String(first)
    const worsened = Boolean(namespace === first ? third : second)
    const signal = (namespace === first ? fourth : third) as EvolutionSignal
    if (!this.isEnabled(namespace) || !allowed(namespace, param)) return
    await this.#restore()
    const key = `${namespace}:${param}`
    const prior = this.#last.get(key)
    if (!prior || !worsened) {
      if (!worsened) this.#worsen.set(key, 0)
      return
    }
    const streak = (this.#worsen.get(key) ?? 0) + 1
    this.#worsen.set(key, streak)
    const rollback = this.#record(
      namespace,
      param,
      prior.after,
      prior.before,
      'validation window worsened; automatic rollback',
      signal,
      'rolled_back',
    )
    await this.persistence.append(rollback)
    if (streak >= this.#options.worsenStreakLimit) {
      this.#stopped.add(key)
      await this.persistence.append(
        this.#record(
          namespace,
          param,
          rollback.after,
          rollback.after,
          'three consecutive worsening validations; automatic tuning stopped',
          signal,
          'stopped',
        ),
      )
    }
    return rollback
  }
  #defaults(namespace: EvolutionNamespace): Record<string, number> {
    return namespace === 'tool-timeout'
      ? {
          ...EVOLUTION_DEFAULTS['tool-timeout'],
          ...Object.fromEntries(
            Object.entries(this.#options.toolTimeoutDefaults).map(([name, value]) => [
              `tool:${name}:timeout_ms`,
              value,
            ]),
          ),
        }
      : { ...EVOLUTION_DEFAULTS[namespace] }
  }
  #record(
    namespace: EvolutionNamespace,
    param: string,
    before: number,
    after: number,
    reason: string,
    signal: EvolutionSignal,
    action: EvolutionAction,
  ): EvolutionRecord {
    return {
      schemaVersion: 1,
      namespace,
      param,
      before,
      after,
      at: this.#options.now().toISOString(),
      reason,
      signal,
      action,
    }
  }
  async #restore() {
    if (this.#restored || !this.persistence.audit) return
    const records = await this.persistence.audit()
    for (const record of records) {
      // Bounds-unfrozen namespaces retain rule skeletons but receive no persisted authority.
      if (record.namespace !== 'context') continue
      const key = `${record.namespace}:${record.param}`
      if (record.action === 'adjusted') this.#last.set(key, record)
      if (record.action === 'rolled_back') this.#worsen.set(key, (this.#worsen.get(key) ?? 0) + 1)
      if (record.action === 'stopped' || record.action === 'confirmation_rejected')
        this.#stopped.add(key)
    }
    this.#restored = true
  }
  async #evaluate(namespace: EvolutionNamespace, signal: EvolutionSignal) {
    const values = await this.values(namespace)
    if (namespace === 'context') {
      if ((signal.post_compact_repeat_rate ?? 0) > 0.2)
        return this.propose(
          namespace,
          'compaction_threshold',
          values.compaction_threshold! + 0.05,
          'post-compaction repeat rate exceeded 0.2',
          signal,
        )
      if ((signal.context_length_error_rate ?? 0) > 0.1)
        return this.propose(
          namespace,
          'compaction_threshold',
          values.compaction_threshold! - 0.05,
          'context length error rate exceeded 0.1',
          signal,
        )
      if ((signal.immediate_recompact_rate ?? 0) > 0.2)
        return this.propose(
          namespace,
          'target_ratio',
          values.target_ratio! - 0.05,
          'immediate recompaction rate exceeded 0.2',
          signal,
        )
      if ((signal.keep_outside_window_rate ?? 0) > 0.2)
        return this.propose(
          namespace,
          'keep_recent',
          values.keep_recent! + 2,
          'kept messages frequently fell outside the recent window',
          signal,
        )
      if ((signal.summary_recent_loss_rate ?? 0) > 0.2)
        return this.propose(
          namespace,
          'summary_keep_recent',
          values.summary_keep_recent! + 2,
          'recent context was frequently lost after summary',
          signal,
        )
    }
    if (namespace === 'router' && (signal.fallback_success_rate ?? 0) > 0.5)
      return this.propose(
        namespace,
        'cooldown_ms',
        values.cooldown_ms! - 10_000,
        'fallback frequently succeeds; reduce cooldown',
        signal,
      )
    if (namespace === 'retry' && (signal.retry_success_rate ?? 0) > 0.5)
      return this.propose(
        namespace,
        'max_retries',
        values.max_retries! + 1,
        'retries frequently succeed',
        signal,
      )
    if (namespace === 'retry' && (signal.retry_failure_rate ?? 0) > 0.5)
      return this.propose(
        namespace,
        'max_retries',
        values.max_retries! - 1,
        'retries frequently fail',
        signal,
      )
    if (
      namespace === 'tool-timeout' &&
      (signal.timeout_rate ?? 0) > 0.2 &&
      (signal.user_retry_rate ?? 0) > 0.2
    )
      return this.propose(
        namespace,
        'default_timeout_ms',
        values.default_timeout_ms! + 10_000,
        'tool timeouts are frequently retried by the user',
        signal,
      )
  }
}
