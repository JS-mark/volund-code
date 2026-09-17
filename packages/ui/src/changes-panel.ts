/**
 * /changes 面板（W-08 对齐 Web 变更页）：会话文件变更列表 + 单文件净效果 diff。
 * 数据源 = BackupStore（经 apps/cli 端口）；面板只读，撤销仍走 /undo。
 */

export interface ChangesPanelEntry {
  path: string
  /** 首个备份时文件不存在 = 会话新建。 */
  created: boolean
  batches: number
  lastModifiedAt: string
  /** 全部批次已被 /undo 消费。 */
  allConsumed: boolean
}

export interface ChangesPanelFileDiff {
  path: string
  tracked: boolean
  created: boolean
  beforeAvailable: boolean
  deleted: boolean
  /** W-08：单端超 4MB 不做全量 diff——面板显示截断提示而非正文。 */
  truncated?: boolean
  /** unified diff 文本；无净变化为空串。 */
  diff: string
  linesAdded: number
  linesRemoved: number
}

export interface ChangesPanelController {
  list(sessionId: string): Promise<{ paths: ChangesPanelEntry[]; missing: boolean }>
  fileDiff(sessionId: string, path: string): Promise<ChangesPanelFileDiff>
  /** 撤销「指定路径」的最新批次（preview → 确认 → 执行 走面板内的确认流）。 */
  previewUndo?(sessionId: string, path: string): Promise<ChangesPanelUndoPreview>
  undoPath?(sessionId: string, path: string): Promise<ChangesPanelUndoResult>
}

export interface ChangesPanelUndoPreview {
  undoable: boolean
  reason?: string
  paths: string[]
  warnings: { path: string; kind: string }[]
}

export interface ChangesPanelUndoResult {
  undone: boolean
  paths: string[]
  warnings: { path: string; kind: string }[]
}

export type DiffRowTone = 'add' | 'del' | 'hunk' | 'meta' | 'plain'

export interface DiffRow {
  tone: DiffRowTone
  text: string
}

/**
 * unified diff 文本 → 着色行。`---`/`+++` 头与元信息是 meta，`@@` 是 hunk，
 * 其余按首字符分（空格开头是上下文行，保留原首空格外的内容）。
 */
export function diffRowsOf(diff: string): readonly DiffRow[] {
  if (!diff) return []
  return diff.split('\n').map((line, index) => {
    if (index < 2 && (line.startsWith('--- ') || line.startsWith('+++ ')))
      return { tone: 'meta' as const, text: line }
    if (line.startsWith('@@')) return { tone: 'hunk' as const, text: line }
    if (line.startsWith('+')) return { tone: 'add' as const, text: line.slice(1) }
    if (line.startsWith('-')) return { tone: 'del' as const, text: line.slice(1) }
    if (line.startsWith(' ')) return { tone: 'plain' as const, text: line.slice(1) }
    return { tone: 'plain' as const, text: line }
  })
}

/** 绝对路径在 cwd 下显示相对路径（与 ActivityBlock 的活动行同规则）。 */
export function relativizeChangePath(path: string, cwd: string | undefined): string {
  if (!cwd) return path
  const prefix = cwd.endsWith('/') ? cwd : `${cwd}/`
  return path.startsWith(prefix) ? path.slice(prefix.length) : path
}

/** 列表行摘要：`+ 新建 · 2 批` / `~ 修改` / `· 已撤销`。 */
export function changeEntrySummary(entry: ChangesPanelEntry): string {
  const parts: string[] = []
  if (entry.allConsumed) parts.push('已撤销')
  else parts.push(entry.created ? '新建' : '修改')
  if (entry.batches > 1) parts.push(`${entry.batches} 批`)
  return parts.join(' · ')
}
