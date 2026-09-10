import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { updateSession } from '@volund/core'
import type { EventBus, Runner, SessionState } from '@volund/core'
import { SessionStore } from '@volund/storage'
import type { BackgroundShells } from '@volund/tools'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Context, createAppKernel } from './index'
import { SessionController } from './session-controller'
import type { RunnerFactory } from './session-controller'

const fixtures: string[] = []
afterEach(async () =>
  Promise.all(fixtures.splice(0).map((path) => rm(path, { force: true, recursive: true }))),
)

async function sessionsRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'volund-sessions-'))
  fixtures.push(root)
  return root
}

/** 与真实 Runner 对齐的最小附录 D session 事件序列（turn.started → message.appended）。 */
function fakeFactory(
  observe: (state: SessionState, events: EventBus) => void = () => {},
): RunnerFactory {
  return (initial, events) => {
    let state = initial
    observe(state, events)
    return {
      get state() {
        return state
      },
      interrupt: vi.fn(() => {
        state = updateSession(state, (draft) => {
          draft.pendingInterrupt = true
        })
      }),
      run: vi.fn(async (text: string) => {
        const turnId = `turn-${state.turns.length + 1}`
        const messageId = `user-${state.turns.length + 1}`
        await events.emit({
          type: 'turn.started',
          version: state.version,
          sessionId: state.id,
          turnId,
          payload: { turnId },
        })
        await events.emit({
          type: 'message.appended',
          version: state.version,
          sessionId: state.id,
          turnId,
          payload: { messageId, role: 'user', content: [{ type: 'text', text }] },
        })
        state = updateSession(state, (draft) => {
          draft.messages = [
            ...draft.messages,
            { id: messageId, role: 'user', content: [{ type: 'text', text }], createdAt: 1 },
          ]
          draft.turns = [
            ...draft.turns,
            { id: turnId, startMessageId: messageId, status: 'streaming', parentDepth: 0 },
          ]
          draft.activeTurn = turnId
        })
        return state
      }),
    } as unknown as Runner
  }
}

describe('SessionController', () => {
  it('mounts on the app kernel as the sessions service', async () => {
    const app = createAppKernel()
    app.plugin(SessionController, {
      sessionsDir: await sessionsRoot(),
      createRunner: fakeFactory(),
    })
    expect(app.sessions).toBeInstanceOf(SessionController)
  })

  it('rejects a concurrent submit with session_turn_in_progress and recovers after the turn', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let runs = 0
    const controller = new SessionController(new Context(), {
      sessionsDir: await sessionsRoot(),
      createRunner: (state, events) => {
        const base = fakeFactory()(state, events) as Runner
        return {
          ...base,
          get state() {
            return state
          },
          run: vi.fn(async (text: string) => {
            runs += 1
            if (runs === 1) await gate
            return base.run(text)
          }),
        } as unknown as Runner
      },
    })
    const session = await controller.startInteractive({ cwd: process.cwd() })
    const first = session.submit('one')
    await expect(session.submit('two')).rejects.toMatchObject({
      code: 'session_turn_in_progress',
    })
    expect(controller.turnInFlight).toBe(true)
    release()
    await first
    expect(controller.turnInFlight).toBe(false)
    await session.submit('three')
    expect(runs).toBe(2)
  })

  it('double end is a no-op and kills background shells exactly once', async () => {
    const killAll = vi.fn()
    const background = { events: {}, killAll } as unknown as BackgroundShells
    const controller = new SessionController(new Context(), {
      sessionsDir: await sessionsRoot(),
      createRunner: fakeFactory(),
      background,
    })
    const session = await controller.startInteractive({ cwd: process.cwd() })
    await session.end()
    await session.end()
    expect(killAll).toHaveBeenCalledTimes(1)
    expect(killAll).toHaveBeenCalledWith('session_ended')
  })

  it('rejects resume with an invalid session id', async () => {
    const controller = new SessionController(new Context(), {
      sessionsDir: await sessionsRoot(),
      createRunner: fakeFactory(),
    })
    await expect(controller.resume('not-a-session-id')).rejects.toThrow('Invalid session id')
  })

  it('refuses an interactive start without a terminal host', async () => {
    const controller = new SessionController(new Context(), {
      sessionsDir: await sessionsRoot(),
      createRunner: fakeFactory(),
    })
    await expect(controller.startSession({ cwd: process.cwd() })).rejects.toThrow(
      'Interactive chat requires a TTY or a prompt',
    )
  })

  it('pins the /model selection: persists session.model_changed and restores it on resume', async () => {
    const sessionsDir = await sessionsRoot()
    const hints: Array<{ explicitModel?: string } | undefined> = []
    const factory: RunnerFactory = (state, events) => {
      const base = fakeFactory()(state, events) as Runner
      return {
        ...base,
        get state() {
          return state
        },
        run: vi.fn(async (text: string, hint?: { explicitModel?: string }) => {
          hints.push(hint)
          return base.run(text)
        }),
      } as unknown as Runner
    }
    const controller = new SessionController(new Context(), {
      sessionsDir,
      createRunner: factory,
    })
    const session = await controller.startInteractive({ cwd: process.cwd() })
    expect(session.model).toBeUndefined()

    await controller.setModel('anthropic/mimo-v2.5')
    // 钉住后：未显式指定模型的 submit 以钉住值为 explicitModel。
    await session.submit('hello')
    expect(hints.at(-1)?.explicitModel).toBe('anthropic/mimo-v2.5')
    // 当轮显式覆盖优先于钉住值。
    await session.submit('hi', { model: 'anthropic/claude-opus-4-20250514' })
    expect(hints.at(-1)?.explicitModel).toBe('anthropic/claude-opus-4-20250514')
    // 落盘：jsonl 里有且只有一条 session.model_changed。
    const stored = await new SessionStore(join(sessionsDir, `${session.id}.jsonl`)).load()
    expect(
      stored
        .filter((entry) => entry.type === 'session.model_changed')
        .map((entry) => entry.payload),
    ).toEqual([{ model: 'anthropic/mimo-v2.5' }])
    await session.end()

    // resume：replay 还原钉住模型 → facade 暴露 + submit 继续使用。
    const resumed = await controller.resumeInteractive(session.id)
    expect(resumed.model).toBe('anthropic/mimo-v2.5')
    await resumed.submit('again')
    expect(hints.at(-1)?.explicitModel).toBe('anthropic/mimo-v2.5')
    await resumed.end()
  })

  it('restores the pinned model even when it was pinned outside the 20-turn replay window', async () => {
    const sessionsDir = await sessionsRoot()
    const controller = new SessionController(new Context(), {
      sessionsDir,
      createRunner: fakeFactory(),
    })
    const session = await controller.startInteractive({ cwd: process.cwd() })
    await controller.setModel('anthropic/mimo-v2.5')
    // 25 个 turn 把 model_changed 挤出尾部 20-turn 回放窗口。
    for (let index = 0; index < 25; index += 1) await session.submit(`turn ${index}`)
    await session.end()

    const resumed = await controller.resumeInteractive(session.id)
    expect(resumed.model).toBe('anthropic/mimo-v2.5')
    await resumed.end()
  })
})
