import { describe, expect, it } from 'vitest'

import {
  countDiffLines,
  diffLineOps,
  formatUnifiedDiff,
  unifiedDiff,
  unifiedDiffHunks,
} from './diff'

describe('diffLineOps', () => {
  it('returns no ops for identical content', () => {
    expect(diffLineOps('a\nb\n', 'a\nb\n')).toEqual([])
  })

  it('marks a single-line change as del + add', () => {
    const ops = diffLineOps('one\ntwo\nthree', 'one\nTWO\nthree')
    expect(ops).toEqual([
      { type: 'context', text: 'one' },
      { type: 'del', text: 'two' },
      { type: 'add', text: 'TWO' },
      { type: 'context', text: 'three' },
    ])
  })

  it('trims common prefix and suffix before comparing', () => {
    const before = ['head']
      .concat(
        Array.from({ length: 50 }, (_, i) => `x${i}`),
        ['tail'],
      )
      .join('\n')
    const after = ['head']
      .concat(
        Array.from({ length: 50 }, (_, i) => `x${i}`),
        ['TAIL'],
      )
      .join('\n')
    const ops = diffLineOps(before, after)
    expect(ops.filter((op) => op.type !== 'context')).toEqual([
      { type: 'del', text: 'tail' },
      { type: 'add', text: 'TAIL' },
    ])
  })

  it('treats pure insertion as adds only', () => {
    const ops = diffLineOps('a\nb', 'a\ninserted\nb')
    expect(ops).toEqual([
      { type: 'context', text: 'a' },
      { type: 'add', text: 'inserted' },
      { type: 'context', text: 'b' },
    ])
    expect(countDiffLines(ops)).toEqual({ linesAdded: 1, linesRemoved: 0 })
  })

  it('normalizes a trailing-newline-only difference to no change', () => {
    // 末尾换行不构成一行（splitLines 约定）：仅结尾换行差异按无变更处理。
    const ops = diffLineOps('a\nb\n', 'a\nb')
    expect(countDiffLines(ops)).toEqual({ linesAdded: 0, linesRemoved: 0 })
  })

  it('falls back to wholesale replace beyond the LCS guard', () => {
    const midA = Array.from({ length: 2100 }, (_, i) => `a${i}`)
    const midB = Array.from({ length: 2100 }, (_, i) => `b${i}`)
    const ops = diffLineOps(midA.join('\n'), midB.join('\n'))
    expect(countDiffLines(ops)).toEqual({ linesAdded: 2100, linesRemoved: 2100 })
  })
})

describe('unifiedDiffHunks', () => {
  const numbered = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, i) => `line ${from + i}`).join('\n')

  it('emits a single hunk for one change with three context lines', () => {
    const before = numbered(1, 10)
    const after = before.replace('line 5', 'line five')
    const [hunk] = unifiedDiffHunks(diffLineOps(before, after))
    expect(hunk).toBeDefined()
    expect(hunk!.header).toBe('-2,7 +2,7')
    expect(hunk!.lines[0]).toEqual({ type: 'context', text: 'line 2' })
    expect(hunk!.lines.at(-1)).toEqual({ type: 'context', text: 'line 8' })
  })

  it('splits hunks when changes are far apart', () => {
    const before = numbered(1, 30)
    const after = before.replace('line 3', 'x3').replace('line 28', 'x28')
    const hunks = unifiedDiffHunks(diffLineOps(before, after))
    expect(hunks.length).toBe(2)
    expect(hunks[1]!.header.startsWith('-25,')).toBe(true)
  })

  it('anchors pure insertions with a zero-count old range', () => {
    const hunks = unifiedDiffHunks(diffLineOps('a\nb', 'a\nnew\nb'))
    expect(hunks[0]!.header).toBe('-1,2 +1,3')
  })

  it('reports an insertion at the top of an empty file as -0,0', () => {
    const hunks = unifiedDiffHunks(diffLineOps('', 'hello'))
    expect(hunks[0]!.header).toBe('-0,0 +1')
  })

  it('returns no hunks without changes', () => {
    expect(unifiedDiffHunks(diffLineOps('same\nsame', 'same\nsame'))).toEqual([])
  })
})

describe('formatUnifiedDiff', () => {
  it('renders headers, hunks and +/- markers', () => {
    const { hunks } = unifiedDiff('one\ntwo\nthree\nfour\nfive', 'one\n2\nthree\nfour\nfive')
    const text = formatUnifiedDiff('src/a.ts', hunks)
    expect(text.split('\n')).toEqual([
      '--- src/a.ts',
      '+++ src/a.ts',
      '@@ -1,5 +1,5 @@',
      ' one',
      '-two',
      '+2',
      ' three',
      ' four',
      ' five',
    ])
  })

  it('renders an empty string without changes', () => {
    expect(formatUnifiedDiff('a.ts', unifiedDiff('x', 'x').hunks)).toBe('')
  })

  it('unifiedDiff reports both hunks and counts', () => {
    const result = unifiedDiff('a\nb\nc', 'a\nB\nc\nd')
    expect(result.linesAdded).toBe(2)
    expect(result.linesRemoved).toBe(1)
    expect(result.hunks.length).toBe(1)
  })
})
