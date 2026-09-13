import { describe, expect, it } from 'vitest'

import {
  applySessionEvent,
  createSessionView,
  renderSecurityBanner,
  renderTelemetryPanel,
} from './index'

describe('security disclosure', () => {
  it.each([
    [['skip-permissions'], 'DANGER: PERMISSIONS DISABLED'],
    [['no-sandbox'], 'DANGER: NO SANDBOX'],
  ] as const)('renders a persistent red top bar for %j', (modes, text) => {
    const banner = renderSecurityBanner([...modes], true)
    expect(banner).toContain('\u001B[41m')
    expect(banner).toContain(text)
  })

  it('never renders missing telemetry samples as passing', async () => {
    const output = renderTelemetryPanel({
      samples: 0,
      corruptLines: 0,
      tiers: {},
      escape: { allow: 0, deny: 0, ratio: null },
      probe: null,
    })
    expect(output).toContain('no samples (unknown)')
    expect(output).toContain('no sample (unknown)')
  })
})

describe('session view', () => {
  it('marks interrupted output as withdrawn and records exit', () => {
    const view = createSessionView('session-1')
    applySessionEvent(view, { type: 'stream.delta', text: 'partial' })
    applySessionEvent(view, { type: 'message.interrupted' })
    applySessionEvent(view, { type: 'session.ended' })
    expect(view.transcript).toEqual([])
    expect(view.interruptedText).toBe('partial')
    expect(view.status).toBe('ended')
  })
})
