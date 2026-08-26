import { randomUUID } from 'node:crypto'

/**
 * 后台 shell 注册表（spec §4.3.1「后台任务（G2）」，r13-G2）。
 *
 * 后台语义 = 复用前台同一条沙箱化执行路径（native.execute，同 profile），只是
 * **不 await**：调用方立即拿 shellId，注册表持有 promise 与 AbortController。
 * - 跨 turn 存活；`killAll('session_ended')` 由 composition root 在 session.ended 时调用
 * - `timeoutMs` 对后台模式不生效（abort 只来自 KillShell / session 结束）
 * - 输出环形上限 10MB：完成时截尾 + 头部 `[... dropped N bytes ...]` 标注
 */
export const MAX_BACKGROUND_BUFFER_BYTES = 10 * 1024 * 1024

export interface BackgroundShellStarted {
  shellId: string
  command: string
  cwd: string
}
export interface BackgroundShellExited {
  shellId: string
  exitCode: number
  reason: 'exit' | 'killed' | 'session_ended'
  droppedBytes?: number
}
export interface BackgroundShellEvents {
  started?: (payload: BackgroundShellStarted) => void
  exited?: (payload: BackgroundShellExited) => void
}

interface Entry {
  shellId: string
  command: string
  cwd: string
  startedAt: number
  controller: AbortController
  output: string
  droppedBytes: number
  exitCode: number | undefined
  reason: BackgroundShellExited['reason'] | undefined
  done: boolean
}

export interface SpawnOptions {
  command: string
  cwd: string
  /** 沙箱化执行 thunk（前台同款 native.execute 调用），signal 由注册表控制。 */
  run: (signal: AbortSignal) => Promise<unknown>
}

export class BackgroundShells {
  readonly #shells = new Map<string, Entry>()
  events: BackgroundShellEvents = {}

  spawn(options: SpawnOptions): { shellId: string; done: Promise<void> } {
    const shellId = `shell-${randomUUID().slice(0, 8)}`
    const controller = new AbortController()
    const entry: Entry = {
      shellId,
      command: options.command,
      cwd: options.cwd,
      startedAt: Date.now(),
      controller,
      output: '',
      droppedBytes: 0,
      exitCode: undefined,
      reason: undefined,
      done: false,
    }
    this.#shells.set(shellId, entry)
    this.events.started?.({ shellId, command: options.command, cwd: options.cwd })
    const done = options
      .run(controller.signal)
      .then(
        (out) => {
          entry.output = capBuffer(typeof out === 'string' ? out : JSON.stringify(out), entry)
          entry.exitCode = 0
          entry.reason = 'exit'
        },
        (error) => {
          // abort（kill / session 结束）走 killed 语义；其余按非零退出呈现
          const aborted =
            controller.signal.aborted || (error as { name?: string })?.name === 'AbortError'
          entry.output = capBuffer(aborted ? '' : String((error as Error)?.message ?? error), entry)
          entry.exitCode = aborted ? (entry.reason === 'session_ended' ? undefined : 137) : 1
          entry.reason = aborted ? (entry.reason ?? 'killed') : 'exit'
        },
      )
      .then(() => {
        entry.done = true
        this.events.exited?.({
          shellId,
          exitCode: entry.exitCode ?? 0,
          reason: entry.reason ?? 'exit',
          ...(entry.droppedBytes > 0 ? { droppedBytes: entry.droppedBytes } : {}),
        })
      })
    return { shellId, done }
  }

  list(): Array<{ shellId: string; command: string; runningForMs: number; done: boolean }> {
    return [...this.#shells.values()].map((e) => ({
      shellId: e.shellId,
      command: e.command,
      runningForMs: Date.now() - e.startedAt,
      done: e.done,
    }))
  }

  view(shellId: string): string {
    const entry = this.#shells.get(shellId)
    if (!entry) return `unknown shellId: ${shellId}`
    if (!entry.done)
      return `(still running for ${Math.round((Date.now() - entry.startedAt) / 1000)}s — output arrives on exit; use ShellOutput {action:'wait'} to block)`
    return withExit(entry)
  }

  async wait(shellId: string, timeoutMs?: number): Promise<string> {
    const entry = this.#shells.get(shellId)
    if (!entry) return `unknown shellId: ${shellId}`
    const finished = waitFor(() => entry.done, timeoutMs ?? 60_000)
    await finished
    if (!entry.done)
      return `(still running after timeout — output so far is empty until exit; shellId ${shellId} remains alive)`
    return withExit(entry)
  }

  kill(shellId: string): string {
    const entry = this.#shells.get(shellId)
    if (!entry) return `unknown shellId: ${shellId}`
    if (entry.done) return `shell ${shellId} already exited`
    entry.reason = 'killed'
    entry.controller.abort()
    return `killed shell ${shellId}`
  }

  killAll(reason: BackgroundShellExited['reason'] = 'session_ended'): number {
    let killed = 0
    for (const entry of this.#shells.values()) {
      if (entry.done) continue
      entry.reason = reason
      entry.controller.abort()
      killed += 1
    }
    return killed
  }
}

function withExit(entry: Entry): string {
  const head = entry.droppedBytes > 0 ? `[... dropped ${entry.droppedBytes} bytes ...]\n` : ''
  return `${head}${entry.output}\n[exitCode: ${entry.exitCode ?? 'n/a'} (${entry.reason})]`
}

function capBuffer(text: string, entry: Entry): string {
  const bytes = Buffer.byteLength(text)
  if (bytes <= MAX_BACKGROUND_BUFFER_BYTES) return text
  const kept = Buffer.from(text)
    .subarray(bytes - MAX_BACKGROUND_BUFFER_BYTES)
    .toString('utf8')
  entry.droppedBytes = bytes - MAX_BACKGROUND_BUFFER_BYTES
  return kept
}

function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const started = Date.now()
    const tick = () => {
      if (predicate()) resolve(true)
      else if (Date.now() - started >= timeoutMs) resolve(false)
      else setTimeout(tick, 25)
    }
    tick()
  })
}
