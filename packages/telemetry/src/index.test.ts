import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { LocalTelemetrySink, Telemetry, TelemetryStore, type TelemetryEvent } from './index'
const paths: string[] = []
afterEach(async () => Promise.all(paths.map((path) => rm(path, { force: true, recursive: true }))))
describe('telemetry', () => {
  it('sanitizes every event before the local sink', async () => {
    let event: TelemetryEvent | undefined
    await new Telemetry({
      write: async (value) => {
        event = value
      },
    }).emit('auth.test', 'auth', { token: 'abc', url: 'https://user:pass@example.com' })
    const payload = JSON.stringify(event?.payload)
    expect(payload).not.toContain('abc')
    expect(payload).not.toContain('user:pass')
  })

  it('records the bounded violation schema and aggregates decisions without guessing no-sample success', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'volund-telemetry-'))
    paths.push(dir)
    const path = join(dir, 'events.jsonl')
    const telemetry = new Telemetry(new LocalTelemetrySink(path))
    await telemetry.violation({
      mechanism: 'seatbelt',
      tier: 'full',
      operation: 'escape',
      decision: 'deny',
      reason: 'outside workspace',
    })
    const summary = await new TelemetryStore(path).summary()
    expect(summary.escape).toEqual({ allow: 0, deny: 1, ratio: 1 })
    expect(summary.tiers).toEqual({ full: 1 })
    expect(JSON.stringify(await readFile(path, 'utf8'))).not.toContain(process.cwd())
  })

  it('ignores damaged JSONL and redacts again during export', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'volund-telemetry-'))
    paths.push(dir)
    const path = join(dir, 'events.jsonl')
    const telemetry = new Telemetry(new LocalTelemetrySink(path))
    await telemetry.emit('test', 'test', { token: 'never-export-me' })
    await appendFile(path, '{damaged\n')
    const store = new TelemetryStore(path)
    expect((await store.summary()).corruptLines).toBe(1)
    const target = join(dir, 'export.jsonl')
    expect(await store.export(target)).toBe(1)
    expect(await readFile(target, 'utf8')).not.toContain('never-export-me')
  })
})
