/**
 * 纯行级 diff（unified diff 语义）：Edit 审批预览、会话变更 diff、Web 变更面板
 * 共用。算法 = 前后缀裁剪 + LCS DP（规模护栏内），超限退化为「整段删+整段加」
 * ——仍是合法 diff，只是非最小，保证大文件（整文件重写）有界。
 */

export interface DiffLineOp {
  type: 'add' | 'del' | 'context'
  text: string
}

export interface DiffHunk {
  /** `@@` 头内的范围对：`-oldStart,oldCount +newStart,newCount`（不含 @@）。 */
  header: string
  lines: readonly DiffLineOp[]
}

/** LCS 表条目上限（(m+1)*(n+1) ≤ 该值才走 DP；Uint32Array 也随之有界）。 */
const LCS_CELL_LIMIT = 4_000_000

function splitLines(content: string): string[] {
  if (content === '') return []
  const lines = content.split('\n')
  // 末尾换行产生的空元素不是一行：git diff 同样不把它计为一行。
  if (lines.length > 1 && lines.at(-1) === '') lines.pop()
  return lines
}

export function diffLineOps(before: string, after: string): readonly DiffLineOp[] {
  if (before === after) return []
  const a = splitLines(before)
  const b = splitLines(after)
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  const midA = a.slice(start, endA)
  const midB = b.slice(start, endB)
  const ops: DiffLineOp[] = []
  for (let index = 0; index < start; index++) ops.push({ type: 'context', text: a[index]! })
  if (midA.length * midB.length <= LCS_CELL_LIMIT) appendLcsOps(ops, midA, midB)
  else {
    for (const line of midA) ops.push({ type: 'del', text: line })
    for (const line of midB) ops.push({ type: 'add', text: line })
  }
  for (let index = endA; index < a.length; index++) ops.push({ type: 'context', text: a[index]! })
  return ops
}

function appendLcsOps(ops: DiffLineOp[], a: readonly string[], b: readonly string[]): void {
  const width = b.length + 1
  const table = new Uint32Array((a.length + 1) * width)
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * width + j] =
        a[i] === b[j]
          ? table[(i + 1) * width + j + 1]! + 1
          : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!)
    }
  }
  let i = 0
  let j = 0
  const middle: DiffLineOp[] = []
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      middle.push({ type: 'context', text: a[i]! })
      i++
      j++
    } else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) {
      middle.push({ type: 'del', text: a[i]! })
      i++
    } else {
      middle.push({ type: 'add', text: b[j]! })
      j++
    }
  }
  while (i < a.length) middle.push({ type: 'del', text: a[i++]! })
  while (j < b.length) middle.push({ type: 'add', text: b[j++]! })
  ops.push(...middle)
}

export function countDiffLines(ops: readonly DiffLineOp[]): {
  linesAdded: number
  linesRemoved: number
} {
  let linesAdded = 0
  let linesRemoved = 0
  for (const op of ops)
    if (op.type === 'add') linesAdded++
    else if (op.type === 'del') linesRemoved++
  return { linesAdded, linesRemoved }
}

function rangeHeader(start: number, count: number): string {
  // unified 惯例（对齐 git）：count=1 省略计数；0 行时起点记为范围前一行的行号。
  if (count === 0) return `${Math.max(0, start - 1)},0`
  return count === 1 ? `${start}` : `${start},${count}`
}

/** 把连续（间隔 ≤ 2*context）的变更合并为 hunk；无变更返回空。 */
export function unifiedDiffHunks(ops: readonly DiffLineOp[], context = 3): readonly DiffHunk[] {
  const changes: number[] = []
  for (const [index, op] of ops.entries()) if (op.type !== 'context') changes.push(index)
  if (changes.length === 0) return []
  const hunks: DiffHunk[] = []
  let oldLine = 1
  let newLine = 1
  let cursor = 0
  for (let index = 0; index < changes.length;) {
    const groupStart = changes[index]!
    let groupEnd = groupStart
    let last = index
    while (last + 1 < changes.length && changes[last + 1]! - groupEnd <= context * 2) {
      last++
      groupEnd = changes[last]!
    }
    const from = Math.max(0, groupStart - context)
    const to = Math.min(ops.length, groupEnd + 1 + context)
    while (cursor < from) {
      const op = ops[cursor]!
      if (op.type === 'add') newLine++
      else if (op.type === 'del') oldLine++
      else {
        oldLine++
        newLine++
      }
      cursor++
    }
    const oldStart = oldLine
    const newStart = newLine
    let oldCount = 0
    let newCount = 0
    const lines: DiffLineOp[] = []
    for (let scan = from; scan < to; scan++) {
      const op = ops[scan]!
      lines.push(op)
      if (op.type === 'add') newCount++
      else if (op.type === 'del') oldCount++
      else {
        oldCount++
        newCount++
      }
    }
    cursor = to
    oldLine = oldStart + oldCount
    newLine = newStart + newCount
    hunks.push({
      header: `-${rangeHeader(oldStart, oldCount)} +${rangeHeader(newStart, newCount)}`,
      lines,
    })
    index = last + 1
  }
  return hunks
}

/** 一次性算出 hunks 与增删行数（展示层两个都要，避免二次遍历）。 */
export function unifiedDiff(
  before: string,
  after: string,
  context = 3,
): { hunks: readonly DiffHunk[]; linesAdded: number; linesRemoved: number } {
  const ops = diffLineOps(before, after)
  return { hunks: unifiedDiffHunks(ops, context), ...countDiffLines(ops) }
}

export function formatUnifiedDiff(path: string, hunks: readonly DiffHunk[]): string {
  if (hunks.length === 0) return ''
  const lines: string[] = [`--- ${path}`, `+++ ${path}`]
  for (const hunk of hunks) {
    lines.push(`@@ ${hunk.header} @@`)
    for (const op of hunk.lines)
      lines.push(`${op.type === 'add' ? '+' : op.type === 'del' ? '-' : ' '}${op.text}`)
  }
  return lines.join('\n')
}
