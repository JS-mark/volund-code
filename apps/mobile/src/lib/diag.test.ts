/** 诊断环形缓冲：容量有界、dump 格式、清空。 */
import { describe, expect, it } from 'vitest'

import { diag, diagClear, diagDump, diagEntries } from './diag'

describe('diag ring buffer', () => {
  it('keeps entries, caps at 300, and dumps readable lines', () => {
    diagClear()
    for (let index = 0; index < 310; index += 1) diag('t', `m${index}`)
    expect(diagEntries()).toHaveLength(300)
    // 最老的 10 条被挤掉（FIFO 环形）。
    expect(diagDump()).not.toContain('[t] m0\n')
    expect(diagDump()).toContain('[t] m309')
    const first = diagEntries()[0]!
    expect(first.tag).toBe('t')
    expect(first.message).toBe('m10')
    expect(new Date(first.t).toISOString()).toBeTruthy()

    diagClear()
    expect(diagEntries()).toHaveLength(0)
    expect(diagDump()).toBe('')
  })
})
