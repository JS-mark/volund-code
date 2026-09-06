import { createSession, EventBus } from '@volund/core'
import { describe, expect, it } from 'vitest'

import { createAppKernel, createAppRuntime, createSessionKernel } from './index'

function sessionState() {
  return createSession({
    id: 'sess-test',
    cwd: '/tmp/volund-app-runtime-test',
    toolRegistrySnapshot: 'snapshot',
    maxTokens: 100_000,
  })
}

describe('createAppKernel', () => {
  it('mounts the ui panel collector', () => {
    const kernel = createAppKernel()
    const controller = { kind: 'panel' }
    kernel.ui.registerPanel('skills', controller)
    expect(kernel.ui.panel('skills')).toBe(controller)
    expect(kernel.ui.ids()).toEqual(['skills'])
  })
})

describe('createSessionKernel', () => {
  it('mounts model/bus/session services synchronously', () => {
    const events = new EventBus()
    const state = sessionState()
    const kernel = createSessionKernel({ events, state })
    expect(kernel.model.registry).toBeDefined()
    expect(kernel.bus.events).toBe(events)
    expect(kernel.session.state).toBe(state)
  })

  it('keeps session kernels independent from the app kernel', async () => {
    const runtime = createAppRuntime()
    const kernel = runtime.createSessionKernel({ events: new EventBus(), state: sessionState() })
    expect(kernel).not.toBe(runtime.app)
    const received: string[] = []
    kernel.bus.events.subscribe((event) => {
      received.push(event.type)
    })
    await kernel.bus.events.emit({
      type: 'session.started',
      version: 1,
      sessionId: 'sess-test',
      payload: { cwd: '/tmp/volund-app-runtime-test' },
    })
    expect(received).toEqual(['session.started'])
  })
})
