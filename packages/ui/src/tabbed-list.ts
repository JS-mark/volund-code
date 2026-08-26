/**
 * 插件命令的多页签列表视图（/plugins 这类浏览器命令的输出面板）：handler 经桥
 * 返回纯数据描述符（`{ kind: 'tabs', ... }`），UI 渲染成 Claude Code /plugins
 * 风格的面板——顶部页签（←/→ 切换）、搜索框、列表行，选中一条后 detail 进
 * transcript。
 *
 * 与 plugin-sdk 的同名类型结构化一致（桥值是 JSON，两侧各自定义，见
 * list-picker.ts / status.ts 的先例）。复用 list-picker 的条目形状与模糊
 * 过滤：搜索词作用于当前页签的 entries。
 */

import { filterListEntries, type CommandListEntry } from './list-picker'

export interface CommandTabsSection {
  readonly id: string
  /** 页签标题（≤ 12 字符为宜，对齐 TabBar 宽度预算）。 */
  readonly label: string
  readonly entries: readonly CommandListEntry[]
}

export interface CommandTabsView {
  readonly kind: 'tabs'
  readonly title: string
  /** 搜索框占位提示。 */
  readonly placeholder?: string
  readonly tabs: readonly CommandTabsSection[]
}

/** 桥值是任意 JSON：进入渲染前必须过这个守卫，形状不对按无输出处理。 */
export function isCommandTabsView(value: unknown): value is CommandTabsView {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const view = value as Record<string, unknown>
  if (view.kind !== 'tabs' || typeof view.title !== 'string' || !Array.isArray(view.tabs))
    return false
  if (!view.tabs.length) return false
  return view.tabs.every(
    (tab) =>
      tab &&
      typeof tab === 'object' &&
      !Array.isArray(tab) &&
      typeof (tab as { id?: unknown }).id === 'string' &&
      typeof (tab as { label?: unknown }).label === 'string' &&
      Array.isArray((tab as { entries?: unknown }).entries) &&
      (tab as { entries: unknown[] }).entries.every(
        (entry) =>
          entry &&
          typeof entry === 'object' &&
          typeof (entry as { id?: unknown }).id === 'string' &&
          typeof (entry as { label?: unknown }).label === 'string',
      ),
  )
}

export interface TabbedListState {
  /** 激活页签下标（越界时按键处理按 0 对齐）。 */
  readonly active: number
  readonly query: string
  readonly selected: number
}

export interface TabbedListPage {
  readonly end: number
  readonly items: readonly CommandListEntry[]
  readonly start: number
  readonly total: number
}

export type TabbedListAction =
  | { type: 'cancel' }
  | { type: 'select'; entry: CommandListEntry }
  | { type: 'update'; state: TabbedListState }

export function createTabbedListState(): TabbedListState {
  return { active: 0, query: '', selected: 0 }
}

/** 当前页签过滤后的条目（搜索词只作用于激活页签，切页签保留搜索词）。 */
export function activeTabEntries(
  sections: readonly CommandTabsSection[],
  state: TabbedListState,
): CommandListEntry[] {
  const tab = sections[Math.max(0, Math.min(sections.length - 1, state.active))]
  return tab ? filterListEntries(tab.entries, state.query) : []
}

export function tabbedListKey(
  state: TabbedListState,
  sections: readonly CommandTabsSection[],
  key: string,
  pageSize = 10,
): TabbedListAction {
  if (key === 'Escape') return { type: 'cancel' }
  if (key === 'ArrowLeft' || key === 'ArrowRight') {
    if (sections.length < 2) return { type: 'update', state }
    const active = Math.max(
      0,
      Math.min(sections.length - 1, state.active + (key === 'ArrowRight' ? 1 : -1)),
    )
    // 切页签保留搜索词（跨类别连续搜索），选中复位到第一条。
    return { type: 'update', state: { ...state, active, selected: 0 } }
  }
  const filtered = activeTabEntries(sections, state)
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

export function tabbedListPage(
  sections: readonly CommandTabsSection[],
  state: TabbedListState,
  pageSize = 10,
): TabbedListPage {
  const filtered = activeTabEntries(sections, state)
  const size = Math.max(1, pageSize)
  const safeSelected = Math.max(0, Math.min(filtered.length - 1, state.selected))
  const start = filtered.length ? Math.floor(safeSelected / size) * size : 0
  const end = Math.min(filtered.length, start + size)
  return { start, end, total: filtered.length, items: filtered.slice(start, end) }
}
