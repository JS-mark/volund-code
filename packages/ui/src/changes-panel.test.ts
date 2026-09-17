import { describe, expect, it } from 'vitest'

import { changeEntrySummary, diffRowsOf, relativizeChangePath } from './changes-panel'

describe('diffRowsOf (/changes diff 着色行)', () => {
  it('classifies unified diff lines by prefix', () => {
    const rows = diffRowsOf(
      ['--- /tmp/a.ts', '+++ /tmp/a.ts', '@@ -1,2 +1,2 @@', ' ctx', '-old', '+new'].join('\n'),
    )
    expect(rows).toEqual([
      { tone: 'meta', text: '--- /tmp/a.ts' },
      { tone: 'meta', text: '+++ /tmp/a.ts' },
      { tone: 'hunk', text: '@@ -1,2 +1,2 @@' },
      { tone: 'plain', text: 'ctx' },
      { tone: 'del', text: 'old' },
      { tone: 'add', text: 'new' },
    ])
  })

  it('returns no rows for an empty diff', () => {
    expect(diffRowsOf('')).toEqual([])
  })

  it('keeps marker-free lines as plain rows', () => {
    expect(diffRowsOf('loose text')).toEqual([{ tone: 'plain', text: 'loose text' }])
  })
})

describe('relativizeChangePath', () => {
  it('strips the cwd prefix', () => {
    expect(relativizeChangePath('/repo/src/a.ts', '/repo')).toBe('src/a.ts')
  })

  it('keeps paths outside cwd untouched', () => {
    expect(relativizeChangePath('/elsewhere/a.ts', '/repo')).toBe('/elsewhere/a.ts')
  })

  it('returns the path as-is without a cwd', () => {
    expect(relativizeChangePath('/repo/a.ts', undefined)).toBe('/repo/a.ts')
  })
})

describe('changeEntrySummary', () => {
  it('marks created and modified entries', () => {
    expect(
      changeEntrySummary({
        path: 'a',
        created: true,
        batches: 1,
        lastModifiedAt: '',
        allConsumed: false,
      }),
    ).toBe('新建')
    expect(
      changeEntrySummary({
        path: 'a',
        created: false,
        batches: 1,
        lastModifiedAt: '',
        allConsumed: false,
      }),
    ).toBe('修改')
  })

  it('notes batch counts and consumed state', () => {
    expect(
      changeEntrySummary({
        path: 'a',
        created: false,
        batches: 3,
        lastModifiedAt: '',
        allConsumed: false,
      }),
    ).toBe('修改 · 3 批')
    expect(
      changeEntrySummary({
        path: 'a',
        created: true,
        batches: 2,
        lastModifiedAt: '',
        allConsumed: true,
      }),
    ).toBe('已撤销 · 2 批')
  })
})
