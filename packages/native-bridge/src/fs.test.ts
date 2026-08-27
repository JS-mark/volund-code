import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi, beforeEach } from 'vitest'

import { computeDiff, countTokens, readLarge } from './fs'
import { workerPool } from './worker-pool'

vi.mock('./worker-pool', () => ({
  workerPool: { call: vi.fn(async () => 'native-result') },
}))

const availability = vi.hoisted(() => ({ fs: 'probing' as boolean | 'probing' }))
vi.mock('./probe', () => ({
  nativeProbes: {
    available: {
      get fs() {
        return availability.fs
      },
    },
  },
}))

describe('native fs reads during probing (r13-P1)', () => {
  beforeEach(() => {
    vi.mocked(workerPool.call).mockClear()
  })

  it('uses the JS fallback without waiting while the fs probe is pending', async () => {
    availability.fs = 'probing'
    const diff = await computeDiff('a\nb\n', 'a\nc\n')
    expect(diff).toContain('b')
    expect(diff).toContain('c')
    expect(workerPool.call).not.toHaveBeenCalled()
    await expect(countTokens('hello world', 'claude-sonnet-4-20250514')).resolves.toBeGreaterThan(0)
    expect(workerPool.call).not.toHaveBeenCalled()
  })

  it('uses the JS fallback when the fs probe settled unavailable', async () => {
    availability.fs = false
    await expect(computeDiff('same', 'same')).resolves.toBe('')
    expect(workerPool.call).not.toHaveBeenCalled()
  })

  it('switches to the native worker after availability backfills true', async () => {
    availability.fs = true
    await expect(computeDiff('a', 'b')).resolves.toBe('native-result')
    expect(workerPool.call).toHaveBeenCalledWith('fs', 'fs.diff', { before: 'a', after: 'b' })
  })

  it('readLarge serves local files through the JS fallback while probing', async () => {
    availability.fs = 'probing'
    const dir = await mkdtemp(join(tmpdir(), 'volund-fs-'))
    const path = join(dir, 'note.txt')
    await writeFile(path, 'hello probing', 'utf8')
    await expect(readLarge(path)).resolves.toBe('hello probing')
    expect(workerPool.call).not.toHaveBeenCalled()
  })
})
