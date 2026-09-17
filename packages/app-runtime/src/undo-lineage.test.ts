import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { createSession, EventBus, lineageRootSessionId } from '@volund/core'
import type { Runner, SessionState } from '@volund/core'
import { BackupStore } from '@volund/storage'
import { SubagentDispatcher } from '@volund/subagent'
import type { ToolContext } from '@volund/tool-kit'
import { ReadTool, WriteTool } from '@volund/tools'
import { afterEach, describe, expect, it } from 'vitest'

const fixtures: string[] = []
afterEach(async () =>
  Promise.all(fixtures.splice(0).map((path) => rm(path, { force: true, recursive: true }))),
)

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'volund-undo-lineage-'))
  fixtures.push(dir)
  return dir
}

/**
 * Builds the ToolContext exactly the way apps/cli runtime.ts does for every
 * runner (top-level AND subagent): the lineage root session id rides along so
 * file backups archive under the root session's manifest (SAG-06, spec
 * §2.7bis.3 U1).
 */
function toolContext(state: SessionState): ToolContext {
  return {
    abortSignal: new AbortController().signal,
    session: {
      id: state.id,
      cwd: state.cwd,
      turnId: state.activeTurn ?? '',
      rootSessionId: lineageRootSessionId(state),
    },
    native: { execute: async () => '' },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    ui: { requestInput: async () => '' },
  }
}

async function readThenWrite(
  context: ToolContext,
  backups: BackupStore,
  path: string,
  content: string,
) {
  const read = await new ReadTool().invoke({ path }, context)
  expect(read.isError).toBeUndefined()
  const written = await new WriteTool(backups).invoke({ path, content }, context)
  expect(written.isError).toBeUndefined()
}

describe('/undo across the session tree (SAG-06 e2e, spec §2.7bis.3 U1 / §7.11)', () => {
  it('parent+subagent batches share the root manifest; /undo pops one batch per call in global reverse order', async () => {
    const cwd = await workspace()
    const backups = new BackupStore(join(cwd, 'backups'))
    const fileA = resolve(cwd, 'a.txt')
    const fileB = resolve(cwd, 'b.txt')
    const fileC = resolve(cwd, 'c.txt')
    await writeFile(fileA, 'A0')
    await writeFile(fileB, 'B0')
    await writeFile(fileC, 'C0')

    // 顶层会话（自身即 lineage 根）。
    const parentState = createSession({
      id: 'root-session',
      cwd,
      maxTokens: 100_000,
      toolRegistrySnapshot: 'tools',
    })
    const parentContext = toolContext(parentState)

    // ① 父会话改文件 A。
    await readThenWrite(parentContext, backups, fileA, 'A1')

    // ② dispatch 子代理改文件 B——runner 体内用子会话 state 建 ToolContext 写文件，
    //    与生产链路（dispatcher → runnerFactory → executor）同构。
    let childId = ''
    const dispatcher = new SubagentDispatcher({
      runnerFactory: (state) =>
        ({
          interrupt() {},
          run: async () => {
            childId = state.id
            expect(state.lineage.rootSessionId).toBe(parentState.id)
            await readThenWrite(toolContext(state), backups, fileB, 'B1')
            return state
          },
        }) as unknown as Runner,
    })
    const dispatched = await dispatcher.dispatch(
      {
        state: parentState,
        events: new EventBus(),
        turnId: 'turn-1',
        signal: new AbortController().signal,
      },
      { prompt: 'change B' },
    )
    expect(dispatched.status).toBe('completed')

    // ③ 父会话再改文件 C。
    await readThenWrite(parentContext, backups, fileC, 'C1')

    // 备份归根：根目录有对象，子会话目录根本不存在。
    const rootChanges = await backups.changes(parentState.id)
    expect(rootChanges.missing).toBe(false)
    // Web changes 视图（hub.active.id = 根会话）看到父+子全部三个文件。
    expect(rootChanges.paths.map((row) => row.path).toSorted()).toEqual(
      [fileA, fileB, fileC].toSorted(),
    )
    expect((await backups.changes(childId)).missing).toBe(true)

    // 剩余 batch 预览：3 个 batch（C、B、A），逐次递减。
    expect((await backups.previewUndoStep(parentState.id)).remainingBatches).toBe(3)
    expect((await backups.previewUndoStep(parentState.id)).paths).toEqual([fileC])

    // /undo 每次仍只弹一个 batch，按全局逆序：C → B → A。
    const undoC = await backups.undoStep(parentState.id)
    expect(undoC.undone).toBe(true)
    expect(undoC.paths).toEqual([fileC])
    expect(await readFile(fileC, 'utf8')).toBe('C0')
    expect(await readFile(fileB, 'utf8')).toBe('B1') // 子代理改动尚未撤
    expect((await backups.previewUndoStep(parentState.id)).remainingBatches).toBe(2)

    const undoB = await backups.undoStep(parentState.id)
    expect(undoB.undone).toBe(true)
    expect(undoB.paths).toEqual([fileB])
    expect(await readFile(fileB, 'utf8')).toBe('B0') // 子代理改动被根会话 /undo 覆盖
    expect((await backups.previewUndoStep(parentState.id)).remainingBatches).toBe(1)

    const undoA = await backups.undoStep(parentState.id)
    expect(undoA.undone).toBe(true)
    expect(await readFile(fileA, 'utf8')).toBe('A0')

    const exhausted = await backups.undoStep(parentState.id)
    expect(exhausted).toMatchObject({ undone: false, reason: 'no_backup' })
    expect((await backups.previewUndoStep(parentState.id)).remainingBatches).toBe(0)
  })
})
