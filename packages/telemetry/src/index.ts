import { open, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { sanitize, type JsonValue, type Logger } from '@volund/shared'
import { v7 as uuidv7 } from 'uuid'

export interface TelemetryEvent {
  v: 1
  id: string
  at: string
  name: string
  source: string
  payload: Record<string, JsonValue>
}
export type SandboxDecision = 'allow' | 'deny'
export interface SandboxViolation {
  mechanism: string
  tier: 'full' | 'partial' | 'weak' | 'none'
  operation: string
  decision: SandboxDecision
  reason: string
}
export interface ProbeSnapshot {
  tier: SandboxViolation['tier']
  mechanism: string
  abi?: string
  version?: string
  probedAt: string
}
export interface TelemetrySummary {
  samples: number
  corruptLines: number
  tiers: Record<string, number>
  escape: { allow: number; deny: number; ratio: number | null }
  probe: ProbeSnapshot | null
}
export interface TelemetryHealth {
  exists: boolean
  writable: boolean
  corruptLines: number
  samples: number
  detail: string
}
export interface TelemetrySink {
  write(event: TelemetryEvent): Promise<void>
}

/** Append-only, process-safe local sink. Each event is emitted with one write call. */
export class LocalTelemetrySink implements TelemetrySink {
  constructor(readonly path: string) {}
  async write(event: TelemetryEvent) {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    const file = await open(this.path, 'a', 0o600)
    try {
      await file.write(`${JSON.stringify(event)}\n`)
      await file.sync()
    } finally {
      await file.close()
    }
  }
}

export class TelemetryStore {
  constructor(readonly path: string) {}
  async read(): Promise<{ events: TelemetryEvent[]; corruptLines: number }> {
    let raw = ''
    try {
      raw = await readFile(this.path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { events: [], corruptLines: 0 }
      throw error
    }
    const events: TelemetryEvent[] = []
    let corruptLines = 0
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        const value = JSON.parse(line) as TelemetryEvent
        if (value.v !== 1 || typeof value.name !== 'string' || typeof value.at !== 'string')
          throw new Error()
        events.push(value)
      } catch {
        corruptLines += 1
      }
    }
    return { events, corruptLines }
  }
  async summary(): Promise<TelemetrySummary> {
    const { events, corruptLines } = await this.read()
    const tiers: Record<string, number> = {}
    let allow = 0
    let deny = 0
    let probe: ProbeSnapshot | null = null
    for (const event of events) {
      const tier = event.payload.tier
      if (typeof tier === 'string') tiers[tier] = (tiers[tier] ?? 0) + 1
      if (event.name === 'sandbox.violation') {
        if (event.payload.decision === 'allow') allow += 1
        if (event.payload.decision === 'deny') deny += 1
      }
      if (event.name === 'sandbox.probe') probe = event.payload as unknown as ProbeSnapshot
    }
    const total = allow + deny
    return {
      samples: events.length,
      corruptLines,
      tiers,
      escape: { allow, deny, ratio: total === 0 ? null : deny / total },
      probe,
    }
  }
  async export(target: string): Promise<number> {
    const { events } = await this.read()
    await mkdir(dirname(target), { recursive: true, mode: 0o700 })
    await writeFile(
      target,
      events.map((event) => JSON.stringify(sanitize(event))).join('\n') +
        (events.length ? '\n' : ''),
      { mode: 0o600 },
    )
    return events.length
  }
  async clear(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    await writeFile(this.path, '', { mode: 0o600 })
  }
  async health(): Promise<TelemetryHealth> {
    const { events, corruptLines } = await this.read()
    try {
      const info = await stat(this.path)
      const file = await open(this.path, 'a')
      await file.close()
      return {
        exists: info.isFile(),
        writable: true,
        corruptLines,
        samples: events.length,
        detail: corruptLines ? `${corruptLines} corrupt line(s) ignored` : 'local sink healthy',
      }
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException).code === 'ENOENT'
      return {
        exists: !missing,
        writable: missing,
        corruptLines,
        samples: events.length,
        detail: missing ? 'local sink not created yet' : 'local sink is not writable',
      }
    }
  }
}

export class Telemetry {
  constructor(readonly sink: TelemetrySink) {}
  async emit(name: string, source: string, payload: Record<string, unknown> = {}): Promise<void> {
    const clean = sanitize(payload) as Record<string, JsonValue>
    await this.sink.write({
      v: 1,
      id: uuidv7(),
      at: new Date().toISOString(),
      name,
      source,
      payload: clean,
    })
  }
  violation(value: SandboxViolation): Promise<void> {
    return this.emit('sandbox.violation', 'sandbox', {
      ...value,
      mechanism: redactViolationText(value.mechanism),
      operation: redactViolationText(value.operation),
      reason: redactViolationText(value.reason),
    })
  }
}

function redactViolationText(value: string): string {
  return value
    .replace(/(?:[A-Za-z]:\\|\/)(?:[^\s"']+[\\/])*[^\s"']*/g, '[PATH]')
    .replace(/(?:^|\s)(?:sh|bash|zsh|cmd|powershell)(?:\.exe)?\s+[^\n]+/gi, ' [COMMAND REDACTED]')
}

export class TelemetryLogger implements Logger {
  constructor(
    readonly telemetry: Telemetry,
    readonly source: string,
  ) {}
  debug(m: string, c = {}) {
    void this.telemetry.emit('log.debug', this.source, { message: m, ...c })
  }
  info(m: string, c = {}) {
    void this.telemetry.emit('log.info', this.source, { message: m, ...c })
  }
  warn(m: string, c = {}) {
    void this.telemetry.emit('log.warn', this.source, { message: m, ...c })
  }
  error(m: string, c = {}) {
    void this.telemetry.emit('log.error', this.source, { message: m, ...c })
  }
}
