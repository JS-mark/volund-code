/**
 * 插件命令的通用列表视图（/env 这类查询命令的输出面板）：handler 经桥返回纯数据
 * 描述符，UI 渲染成 resume 风格的可搜索选择器。行显示 label + 状态徽标 +
 * 截断的 value，选中一条后 detail 全文进 transcript。
 *
 * 与 plugin-sdk 的同名类型结构化一致（桥值是 JSON，两侧各自定义，见 status.ts
 * 里 PluginStatusTab 的先例）。
 */

export interface CommandListEntry {
  readonly id: string
  /** 主行标题（env 场景 = 变量名）。 */
  readonly label: string
  /** 行内摘要值（长值截断显示；全文放 detail）。 */
  readonly value?: string
  /** 状态徽标文本（如 effective · sandbox）。 */
  readonly status?: string
  /** 选中后进入 transcript 的完整文本（默认回退 label/value 的拼接）。 */
  readonly detail?: string
}

export interface CommandListView {
  readonly kind: 'list'
  readonly title: string
  /** 搜索框占位提示。 */
  readonly placeholder?: string
  readonly entries: readonly CommandListEntry[]
}

/** 桥值是任意 JSON：进入渲染前必须过这个守卫，形状不对按无输出处理。 */
export function isCommandListView(value: unknown): value is CommandListView {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const view = value as Record<string, unknown>
  if (view.kind !== 'list' || typeof view.title !== 'string' || !Array.isArray(view.entries))
    return false
  return view.entries.every(
    (entry) =>
      entry &&
      typeof entry === 'object' &&
      typeof (entry as { id?: unknown }).id === 'string' &&
      typeof (entry as { label?: unknown }).label === 'string',
  )
}

export interface ListPickerState {
  readonly entries: readonly CommandListEntry[]
  readonly query: string
  readonly selected: number
}

export interface ListPickerPage {
  readonly end: number
  readonly items: readonly CommandListEntry[]
  readonly start: number
  readonly total: number
}

export type ListPickerAction =
  | { type: 'cancel' }
  | { type: 'select'; entry: CommandListEntry }
  | { type: 'update'; state: ListPickerState }

export function createListPickerState(entries: readonly CommandListEntry[]): ListPickerState {
  return { entries, query: '', selected: 0 }
}

/** 多关键词模糊过滤：label 权重最高，value/status 次之；无关键词时原序。 */
export function filterListEntries(
  entries: readonly CommandListEntry[],
  query: string,
): CommandListEntry[] {
  const terms = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean)
  if (!terms.length) return [...entries]
  return [...entries]
    .map((entry) => ({ entry, score: entryScore(entry, terms) }))
    .filter(
      (result): result is { entry: CommandListEntry; score: number } => result.score !== undefined,
    )
    .toSorted((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id))
    .map(({ entry }) => entry)
}

export function listPickerKey(
  state: ListPickerState,
  key: string,
  pageSize = 10,
): ListPickerAction {
  const filtered = filterListEntries(state.entries, state.query)
  if (key === 'Escape') return { type: 'cancel' }
  if (key === 'Enter') {
    const entry = filtered[state.selected]
    return entry ? { type: 'select', entry } : { type: 'update', state }
  }
  if (
    key === 'ArrowUp' ||
    key === 'ArrowDown' ||
    key === 'PageUp' ||
    key === 'PageDown' ||
    key === 'Home' ||
    key === 'End'
  ) {
    if (!filtered.length) return { type: 'update', state: { ...state, selected: 0 } }
    const last = filtered.length - 1
    const selected =
      key === 'Home'
        ? 0
        : key === 'End'
          ? last
          : Math.max(
              0,
              Math.min(
                last,
                state.selected +
                  (key === 'ArrowUp'
                    ? -1
                    : key === 'ArrowDown'
                      ? 1
                      : key === 'PageUp'
                        ? -pageSize
                        : pageSize),
              ),
            )
    return { type: 'update', state: { ...state, selected } }
  }
  if (key === 'Backspace' || key === 'Delete')
    return { type: 'update', state: { ...state, query: state.query.slice(0, -1), selected: 0 } }
  const code = key.codePointAt(0)
  if (code !== undefined && key.length <= 2 && code >= 32 && code !== 127)
    return { type: 'update', state: { ...state, query: state.query + key, selected: 0 } }
  return { type: 'update', state }
}

export function listPickerPage(
  entries: readonly CommandListEntry[],
  selected: number,
  pageSize = 10,
): ListPickerPage {
  const size = Math.max(1, pageSize)
  const safeSelected = Math.max(0, Math.min(entries.length - 1, selected))
  const start = entries.length ? Math.floor(safeSelected / size) * size : 0
  const end = Math.min(entries.length, start + size)
  return { start, end, total: entries.length, items: entries.slice(start, end) }
}

function entryScore(entry: CommandListEntry, terms: readonly string[]): number | undefined {
  const fields = [
    [entry.label, 80],
    [entry.value ?? '', 40],
    [entry.status ?? '', 20],
  ] as const
  let score = 0
  for (const term of terms) {
    let best: number | undefined
    for (const [rawValue, weight] of fields) {
      const value = rawValue.toLocaleLowerCase()
      const match = fuzzyScore(value, term)
      if (match !== undefined) best = Math.max(best ?? -Infinity, weight + match)
    }
    if (best === undefined) return undefined
    score += best
  }
  return score
}

function fuzzyScore(value: string, term: string): number | undefined {
  if (!term) return 0
  if (value === term) return 100
  const contiguous = value.indexOf(term)
  if (contiguous >= 0) return 70 - Math.min(contiguous, 30)
  let position = -1
  let gap = 0
  for (const character of term) {
    const next = value.indexOf(character, position + 1)
    if (next < 0) return undefined
    if (position >= 0) gap += next - position - 1
    position = next
  }
  return 30 - Math.min(gap, 30)
}
