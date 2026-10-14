import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { updateSession, toEventContent } from '@volund/core'
import type { EventBus, Runner, SessionState } from '@volund/core'
import type { ContentPart } from '@volund/provider-kit'
import type { JsonValue } from '@volund/shared'
import type { Locale } from '@volund/shared'
import { SessionStore } from '@volund/storage'
import type { BackgroundShells } from '@volund/tools'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { isTranscriptToolEntry } from '../contracts'
import { Context, createAppKernel } from '../index'
import { SessionController } from '../session-controller'
import type { RunnerFactory, SessionRunOverrides } from '../session-controller'

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

  it('transcript 快照携带 tool 条目：tool_use 导出 + tool_result 配对终态', async () => {
    const controller = new SessionController(new Context(), {
      sessionsDir: await sessionsRoot(),
      createRunner: (initial, events) => {
        let state = initial
        const apply = (mutate: (draft: SessionState) => void) => {
          state = updateSession(state, mutate)
        }
        const appendEvent = async (
          messageId: string,
          role: string,
          content: readonly ContentPart[],
        ) => {
          await events.emit({
            type: 'message.appended',
            version: state.version,
            sessionId: state.id,
            turnId: 'turn-1',
            payload: { messageId, role, content: toEventContent(content) } as unknown as JsonValue,
          })
        }
        return {
          get state() {
            return state
          },
          interrupt: vi.fn(async () => {}),
          run: vi.fn(async (text: string) => {
            await events.emit({
              type: 'turn.started',
              version: state.version,
              sessionId: state.id,
              turnId: 'turn-1',
              payload: { turnId: 'turn-1' },
            })
            await appendEvent('user-1', 'user', [{ type: 'text', text }])
            apply((draft) => {
              draft.messages = [
                ...draft.messages,
                { id: 'user-1', role: 'user', content: [{ type: 'text', text }], createdAt: 1 },
              ]
              draft.turns = [
                ...draft.turns,
                { id: 'turn-1', startMessageId: 'user-1', status: 'streaming', parentDepth: 0 },
              ]
              draft.activeTurn = 'turn-1'
            })
            // assistant：文本 + 两个 tool_use
            const assistant = {
              id: 'asst-1',
              role: 'assistant',
              content: [
                { type: 'text', text: '跑一下' },
                { type: 'tool_use', id: 'tu-1', name: 'Bash', input: { command: 'pnpm test' } },
                {
                  type: 'tool_use',
                  id: 'tu-2',
                  name: 'Write',
                  input: { path: 'a.ts', content: 'x=1' },
                },
              ],
              createdAt: 2,
            } as SessionState['messages'][number]
            await appendEvent('asst-1', 'assistant', assistant.content)
            // user tool_result：tu-1 成功、tu-2 失败
            const results = {
              id: 'user-2',
              role: 'user',
              content: [
                { type: 'tool_result', toolUseId: 'tu-1', content: [] },
                { type: 'tool_result', toolUseId: 'tu-2', content: [], isError: true },
              ],
              createdAt: 3,
            } as SessionState['messages'][number]
            await appendEvent('user-2', 'user', results.content)
            apply((draft) => {
              draft.messages = [...draft.messages, assistant, results]
            })
            return state
          }),
        } as unknown as Runner
      },
    })
    const session = await controller.startInteractive({ cwd: process.cwd() })
    await session.submit('run it')
    const entries = session.transcript ?? []
    const tools = entries.filter(isTranscriptToolEntry)
    expect(tools).toEqual([
      { id: 'tu-1', kind: 'tool', tool: 'Bash', input: { command: 'pnpm test' }, status: 'done' },
      {
        id: 'tu-2',
        kind: 'tool',
        tool: 'Write',
        input: { path: 'a.ts', content: 'x=1' },
        status: 'error',
      },
    ])
    // 文本条目保持消息序；tool_result-only 的 user 消息不产生文本条目。
    expect(
      entries.filter((entry) => !isTranscriptToolEntry(entry)).map((entry) => entry.id),
    ).toEqual(['user-1', 'asst-1'])
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

  it('whenTurnSettled waits for the in-flight turn to release the mutex, then returns', async () => {
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
    let settled = false
    const waiting = controller.whenTurnSettled().then(() => {
      settled = true
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(settled).toBe(false)
    release()
    await first
    await waiting
    expect(settled).toBe(true)
    expect(controller.turnInFlight).toBe(false)
    // 空闲时立即返回（hub submit 的常规路径零开销）。
    await expect(controller.whenTurnSettled()).resolves.toBeUndefined()
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

  it('applies startup constraint overrides to the factory and pins the model (W-17 F1-02)', async () => {
    const sessionsDir = await sessionsRoot()
    const seen: Array<SessionRunOverrides | undefined> = []
    const factory: RunnerFactory = (state, events, _agent, overrides) => {
      seen.push(overrides)
      return fakeFactory()(state, events)
    }
    const controller = new SessionController(new Context(), {
      sessionsDir,
      createRunner: factory,
    })
    const session = await controller.startInteractive({
      cwd: process.cwd(),
      model: 'anthropic/mimo-v2.5',
      budget: { timeMsMax: 600_000 },
      allowedTools: ['Read', 'Bash'],
    })
    // overrides 原样到达 createRunner（第 4 参）。
    expect(seen.at(-1)).toEqual({
      budget: { timeMsMax: 600_000 },
      allowedTools: ['Read', 'Bash'],
    })
    // 启动注入的模型等价 /model 钉住：facade 暴露 + session.model_changed 落盘。
    expect(session.model).toBe('anthropic/mimo-v2.5')
    const stored = await new SessionStore(join(sessionsDir, `${session.id}.jsonl`)).load()
    expect(
      stored
        .filter((entry) => entry.type === 'session.model_changed')
        .map((entry) => entry.payload),
    ).toEqual([{ model: 'anthropic/mimo-v2.5' }])
    await session.end()
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

  it('transcript 收口非活跃回合的孤儿 tool_use；活跃回合内的未配对调用保持 running', async () => {
    let mutate: ((fn: (draft: SessionState) => void) => void) | undefined
    const controller = new SessionController(new Context(), {
      sessionsDir: await sessionsRoot(),
      createRunner: (initial, events) => {
        let state = initial
        const apply = (fn: (draft: SessionState) => void) => {
          state = updateSession(state, fn)
        }
        mutate = apply
        const appendEvent = async (
          messageId: string,
          role: string,
          content: readonly ContentPart[],
        ) => {
          await events.emit({
            type: 'message.appended',
            version: state.version,
            sessionId: state.id,
            turnId: 'turn-1',
            payload: { messageId, role, content: toEventContent(content) } as unknown as JsonValue,
          })
        }
        return {
          get state() {
            return state
          },
          interrupt: vi.fn(async () => {}),
          run: vi.fn(async (text: string) => {
            await events.emit({
              type: 'turn.started',
              version: state.version,
              sessionId: state.id,
              turnId: 'turn-1',
              payload: { turnId: 'turn-1' },
            })
            await appendEvent('user-1', 'user', [{ type: 'text', text }])
            // assistant：两个 tool_use，都无 tool_result（中断/孤儿残留形态）。
            const assistant = {
              id: 'asst-1',
              role: 'assistant',
              content: [
                { type: 'tool_use', id: 'tu-1', name: 'Task', input: { prompt: 'scan' } },
                { type: 'tool_use', id: 'tu-2', name: 'Grep', input: { pattern: 'x' } },
              ],
              createdAt: 2,
            } as SessionState['messages'][number]
            await appendEvent('asst-1', 'assistant', assistant.content)
            apply((draft) => {
              draft.messages = [
                ...draft.messages,
                { id: 'user-1', role: 'user', content: [{ type: 'text', text }], createdAt: 1 },
                assistant,
              ]
              draft.turns = [
                ...draft.turns,
                { id: 'turn-1', startMessageId: 'user-1', status: 'aborted', parentDepth: 0 },
              ]
              draft.activeTurn = null
            })
            return state
          }),
        } as unknown as Runner
      },
    })
    const session = await controller.startInteractive({ cwd: process.cwd() })
    await session.submit('go')
    const statuses = () =>
      (session.transcript ?? []).filter(isTranscriptToolEntry).map((entry) => entry.status)
    // 回合已终结：孤儿 tool_use 收口为 error——resume/刷新不再永恒「运行中」。
    expect(statuses()).toEqual(['error', 'error'])
    // 同一批调用落在活跃回合内时仍是在途语义（边界 = 回合起点锚之后）。
    mutate!((draft) => {
      draft.activeTurn = 'turn-1'
      const turn = draft.turns.find((item) => item.id === 'turn-1')
      if (turn) turn.status = 'streaming'
    })
    expect(statuses()).toEqual(['running', 'running'])
  })

  it('resume 在 turn 中途换 runner：先 interrupt 前任并作废旧航班锁，新会话不被永久拒', async () => {
    let firstInterrupt: ReturnType<typeof vi.fn> | undefined
    let invocations = 0
    const controller = new SessionController(new Context(), {
      sessionsDir: await sessionsRoot(),
      createRunner: (initial) => {
        invocations += 1
        const first = invocations === 1
        let release: (() => void) | undefined
        // 首个 runner 的回合永不自行收尾（挂死形态），interrupt 才解除。
        const flight = first
          ? new Promise<SessionState>((resolve) => {
              release = () => resolve(initial)
            })
          : Promise.resolve(initial)
        const interrupt = vi.fn(() => release?.())
        if (first) firstInterrupt = interrupt
        return {
          get state() {
            return initial
          },
          interrupt,
          run: vi.fn(() => flight),
        } as unknown as Runner
      },
    })
    const first = await controller.startInteractive({ cwd: process.cwd() })
    const pending = first.submit('hang')
    // resume 不被在途回合阻塞，且先 interrupt 前任。
    const resumed = await controller.resumeInteractive(first.id)
    expect(firstInterrupt).toHaveBeenCalled()
    await pending
    // 旧航班已作废：新会话立即提交不再撞 session_turn_in_progress。
    await expect(resumed.submit('next')).resolves.toBeUndefined()
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

  it('resume 尾窗不把子代理冒泡的 turn.started 计入——父会话历史不被挤出窗口', async () => {
    const sessionsDir = await sessionsRoot()
    const controller = new SessionController(new Context(), {
      sessionsDir,
      createRunner: fakeFactory(),
    })
    const session = await controller.startInteractive({ cwd: process.cwd() })
    for (let index = 0; index < 3; index += 1) await session.submit(`turn ${index}`)
    // 一段长子代理工作：30 条冒泡 turn.started（附录 D.3 tag）落在父 JSONL 里。
    // 尾窗若把它们计入，from 会切进冒泡段，父会话 3 个 turn 的消息全被丢掉。
    const store = new SessionStore(join(sessionsDir, `${session.id}.jsonl`))
    for (let index = 0; index < 30; index += 1) {
      await store.append({
        v: 1,
        id: `bubbled-${index}`,
        type: 'turn.started',
        sessionId: 'sub-session-id',
        turnId: `sub-turn-${index}`,
        parentTurnId: 'turn-3',
        parentDepth: 1,
        at: new Date().toISOString(),
        payload: { turnId: `sub-turn-${index}` },
      })
    }
    await session.end()
    const resumed = await controller.resumeInteractive(session.id)
    const texts = (resumed.transcript ?? [])
      .filter((entry) => !isTranscriptToolEntry(entry))
      .map((entry) => ('text' in entry ? entry.text : ''))
    expect(texts).toContain('turn 0')
    await resumed.end()
  })

  it('list() 未命名标题按 [ui].locale 探针取值（i18n-r1：缺省 zh，en 探针回 Untitled session）', async () => {
    let locale: Locale | undefined
    const controller = new SessionController(new Context(), {
      sessionsDir: await sessionsRoot(),
      createRunner: fakeFactory(),
      uiLocale: () => locale,
    })
    const session = await controller.startInteractive({ cwd: process.cwd() })
    await session.submit('hello')
    await session.end()
    // zh（缺省）：未命名标题走中文兜底。
    expect((await controller.list())[0]?.title).toBe('hello')
    // en：探针只在无 summary 时生效——这里首条有 summary，构造无 summary 会话验证。
    const empty = await controller.startInteractive({ cwd: process.cwd() })
    await empty.end()
    expect((await controller.list()).some((entry) => entry.title === '未命名会话')).toBe(true)
    locale = 'en'
    expect((await controller.list()).some((entry) => entry.title === 'Untitled session')).toBe(true)
    locale = undefined
    expect((await controller.list()).some((entry) => entry.title === '未命名会话')).toBe(true)
  })

  it('deletes an inactive session archive (events, attachments, backup hook)', async () => {
    const sessionsDir = await sessionsRoot()
    const onDelete = vi.fn()
    const controller = new SessionController(new Context(), {
      sessionsDir,
      createRunner: fakeFactory(),
      onDelete,
    })
    const first = await controller.startInteractive({ cwd: process.cwd() })
    await first.submit('hello')
    await first.end()
    // 附件目录（内容寻址布局可能不存在的场景也要能删）。
    await mkdir(join(sessionsDir, first.id, 'attachments'), { recursive: true })
    await writeFile(join(sessionsDir, first.id, 'attachments', 'a.png'), 'x')
    // 切到第二个会话，让第一个成为非活动档案。
    const second = await controller.startInteractive({ cwd: process.cwd() })

    const result = await controller.delete(first.id)
    expect(result).toEqual({})
    expect(onDelete).toHaveBeenCalledWith(first.id)
    expect(await new SessionStore(join(sessionsDir, `${first.id}.jsonl`)).load()).toEqual([])
    expect(
      await stat(join(sessionsDir, first.id)).then(
        () => true,
        () => false,
      ),
    ).toBe(false)
    expect((await controller.list()).map((entry) => entry.id)).not.toContain(first.id)
    // 活动会话不受影响。
    expect(controller.getActive()?.id).toBe(second.id)
    await second.end()
  })

  it('deleting the active session ends it and cold-starts a fresh session in the same cwd', async () => {
    const sessionsDir = await sessionsRoot()
    const controller = new SessionController(new Context(), {
      sessionsDir,
      createRunner: fakeFactory(),
    })
    const session = await controller.startInteractive({ cwd: '/tmp/proj' })
    await session.submit('hello')
    const activations: string[] = []
    controller.onActivate((active) => activations.push(active.id))

    const result = await controller.delete(session.id)
    expect(result.next).toBeDefined()
    expect(result.next).not.toBe(session.id)
    expect(activations).toEqual([result.next])
    expect(controller.getActive()?.id).toBe(result.next)
    expect(controller.getActive()?.cwd).toBe('/tmp/proj')
    // 新会话事件流已建立（session.started 落盘），旧档案彻底消失。
    const stored = await new SessionStore(join(sessionsDir, `${result.next}.jsonl`)).load()
    expect(stored.some((entry) => entry.type === 'session.started')).toBe(true)
    await expect(controller.resume(session.id)).rejects.toThrow()
    expect((await controller.list()).map((entry) => entry.id)).not.toContain(session.id)
  })

  it('refuses deleting the active session while a turn is in flight', async () => {
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
    const flight = session.submit('one')
    await expect(controller.delete(session.id)).rejects.toMatchObject({
      code: 'session_turn_in_progress',
    })
    release()
    await flight
    // turn 终态后删除成功（活动会话路径）。
    const result = await controller.delete(session.id)
    expect(result.next).toBeDefined()
  })

  it('maps delete failures to session_id_invalid / session_not_found', async () => {
    const controller = new SessionController(new Context(), {
      sessionsDir: await sessionsRoot(),
      createRunner: fakeFactory(),
    })
    await expect(controller.delete('not-a-session-id')).rejects.toMatchObject({
      code: 'session_id_invalid',
    })
    await expect(controller.delete('01890a5d-ac96-774b-bcce-b302099a8057')).rejects.toMatchObject({
      code: 'session_not_found',
    })
  })
})
