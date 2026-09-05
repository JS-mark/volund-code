import { describe, expect, it, vi } from 'vitest'

import { createSignalController } from './signals'

describe('signal controller', () => {
  it('interrupts the current turn on SIGINT without ending the session', async () => {
    const session = {
      startSession: vi.fn(),
      resume: vi.fn(),
      interrupt: vi.fn(async () => {}),
      end: vi.fn(async () => {}),
    }
    const controller = createSignalController(session)
    expect(await controller.handle('SIGINT')).toBe(130)
    expect(session.interrupt).toHaveBeenCalledOnce()
    expect(session.end).not.toHaveBeenCalled()
  })

  it.each(['SIGTERM', 'SIGHUP'] as const)('gracefully ends on %s', async (signal) => {
    const session = {
      startSession: vi.fn(),
      resume: vi.fn(),
      interrupt: vi.fn(async () => {}),
      end: vi.fn(async () => {}),
    }
    const controller = createSignalController(session)
    expect(await controller.handle(signal)).toBe(0)
    expect(session.end).toHaveBeenCalledOnce()
  })
})
