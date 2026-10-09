import { randomUUID } from 'node:crypto'
import { open, mkdir, readFile, rm, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { MemoryError } from './memory-runtime'

export interface FileLockOptions {
  /**
   * Maximum time a writer or consistent reader waits for the transaction lock.
   * The budget also bounds retries of transient lock access errors (LL-7), so
   * contention-heavy callers (e.g. tests) can widen it without changing code.
   */
  lockTimeoutMs?: number
  /** Delay between lock attempts. Kept configurable to make contention tests deterministic. */
  lockRetryMs?: number
}

/**
 * Cross-process advisory lock held in a lock file next to the protected state.
 * A stale lock left behind by a crashed process is recovered once its owner is
 * no longer alive, so a hard kill cannot wedge memory writes forever.
 */
export async function acquireMemoryFileLock(
  lockPath: string,
  options: FileLockOptions = {},
): Promise<() => Promise<void>> {
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 })
  const token = randomUUID()
  const timeoutMs = options.lockTimeoutMs ?? 10_000
  const retryMs = options.lockRetryMs ?? 10
  const deadline = Date.now() + timeoutMs

  for (;;) {
    try {
      const file = await open(lockPath, 'wx', 0o600)
      try {
        await file.writeFile(
          JSON.stringify({ pid: process.pid, token, at: new Date().toISOString() }),
        )
        await file.sync()
      } catch (error) {
        await file.close().catch(() => undefined)
        await rm(lockPath, { force: true }).catch(() => undefined)
        throw error
      }
      await file.close()
      return async () => {
        try {
          const owner = JSON.parse(await readFile(lockPath, 'utf8')) as {
            token?: unknown
          }
          if (owner.token !== token) return
          await rm(lockPath, { force: true }).catch((removeError: NodeJS.ErrnoException) => {
            // A racing Windows unlink can report a transient error for a
            // lock that is already delete-pending; the file disappears
            // once the competing handle closes, so treat the lock as
            // released instead of failing a committed write.
            if (!isTransientLockErrorCode(removeError.code)) throw removeError
          })
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (!isTransientLockErrorCode(code)) throw error
      if (code === 'EEXIST' && !(await lockOwnerAlive(lockPath))) {
        await rm(lockPath, { force: true }).catch((removeError: NodeJS.ErrnoException) => {
          // Another writer can win the stale-lock recovery race; the next
          // open attempt decides, so only non-transient failures escape.
          if (!isTransientLockErrorCode(removeError.code)) throw removeError
        })
        continue
      }
      if (Date.now() >= deadline)
        throw new MemoryError('memory_io', 'Timed out waiting for the memory transaction lock', {
          cause: error,
        })
      await delay(retryMs)
    }
  }
}

function isTransientLockErrorCode(code: string | undefined): boolean {
  return code === 'EEXIST' || code === 'EPERM' || code === 'EACCES' || code === 'EBUSY'
}

async function lockOwnerAlive(path: string): Promise<boolean> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as { pid?: unknown }
    if (!Number.isSafeInteger(value.pid) || Number(value.pid) < 1) {
      // A competing process can observe the file between exclusive creation and
      // metadata fsync. Give that live acquisition a short grace period.
      return Date.now() - (await stat(path)).mtimeMs < 1_000
    }
    try {
      process.kill(Number(value.pid), 0)
      return true
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM'
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    try {
      return Date.now() - (await stat(path)).mtimeMs < 1_000
    } catch {
      return false
    }
  }
}
