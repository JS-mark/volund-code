import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi, beforeEach } from 'vitest'

import { astQuery, search } from './search'
import { workerPool } from './worker-pool'

vi.mock('./worker-pool', () => ({
  workerPool: { call: vi.fn(async () => ({ matches: [] })) },
}))

const availability = vi.hoisted(() => ({ search: 'probing' as boolean | 'probing' }))
vi.mock('./probe', () => ({
  nativeProbes: {
    available: {
      get search() {
        return availability.search
      },
    },
  },
}))

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = []
  for await (const item of iterable) items.push(item)
  return items
}

async function fixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'volund-search-'))
  await writeFile(join(dir, 'haystack.txt'), 'keep this needle\nnothing here\n', 'utf8')
  return dir
}

describe('native search reads during probing (r13-P1)', () => {
  beforeEach(() => {
    vi.mocked(workerPool.call).mockReset()
    vi.mocked(workerPool.call).mockResolvedValue({ matches: [] })
  })

  it('answers from the JS fallback without waiting while the search probe is pending', async () => {
    availability.search = 'probing'
    const dir = await fixture()
    const matches = await collect(search({ pattern: 'needle', path: dir }))
    expect(matches).toHaveLength(1)
    expect(matches[0]).toMatchObject({ lineNumber: 1, line: 'keep this needle' })
    expect(workerPool.call).not.toHaveBeenCalled()
  })

  it('keeps the JS fallback after the probe settled unavailable', async () => {
    availability.search = false
    const dir = await fixture()
    await expect(collect(search({ pattern: 'needle', path: dir }))).resolves.toHaveLength(1)
    expect(workerPool.call).not.toHaveBeenCalled()
  })

  it('switches to the native worker after availability backfills true', async () => {
    availability.search = true
    const nativeMatches = [{ path: '/native', lineNumber: 1, line: 'native needle' }]
    vi.mocked(workerPool.call).mockResolvedValueOnce({ matches: nativeMatches })
    const matches = await collect(search({ pattern: 'needle', path: '/anywhere' }))
    expect(matches).toEqual(nativeMatches)
    expect(workerPool.call).toHaveBeenCalledWith('search', 'search.query', {
      pattern: 'needle',
      path: '/anywhere',
    })
  })

  it('rejects AST queries immediately while probing instead of waiting for the worker', async () => {
    availability.search = 'probing'
    await expect(
      collect(astQuery({ query: '(function)', language: 'typescript' })),
    ).rejects.toThrow('AST query requires the native volund-search worker')
    expect(workerPool.call).not.toHaveBeenCalled()
  })
})
