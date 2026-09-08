/**
 * 侧栏会话分组的纯逻辑（组件外可测）：分组视图组装 + 每分组分页（默认 5 条，
 * 「更多」每次 +5）。
 */
import type { SessionGroupsView, SessionSummary } from './api'

export const GROUP_PAGE_SIZE = 5
/** 内置「未分组」分组的 key（不与服务端分组 id 冲突）。 */
export const UNGROUPED_KEY = '__ungrouped__'

export interface SidebarGroup {
  key: string
  name: string
  /** 内置分组（未分组）：无重命名/删除入口。 */
  builtin: boolean
  sessions: SessionSummary[]
}

/**
 * 组装侧栏分组视图：用户分组按创建序在前，未分组殿后。
 * 归属指向已删除分组的会话回未分组；空的用户分组保留（便于移入会话）。
 */
export function buildSidebarGroups(
  sessions: readonly SessionSummary[],
  view: SessionGroupsView,
): SidebarGroup[] {
  const known = new Set(view.groups.map((group) => group.id))
  const byGroup = new Map<string, SessionSummary[]>()
  const ungrouped: SessionSummary[] = []
  for (const session of sessions) {
    const groupId = view.assignments[session.id]
    if (groupId && known.has(groupId)) {
      const list = byGroup.get(groupId) ?? []
      list.push(session)
      byGroup.set(groupId, list)
    } else {
      ungrouped.push(session)
    }
  }
  const groups: SidebarGroup[] = view.groups.map((group) => ({
    key: group.id,
    name: group.name,
    builtin: false,
    sessions: byGroup.get(group.id) ?? [],
  }))
  // 未分组为空且存在用户分组时不占位；没有任何用户分组时由组件走平铺列表。
  if (ungrouped.length > 0 || groups.length === 0)
    groups.push({ key: UNGROUPED_KEY, name: '未分组', builtin: true, sessions: ungrouped })
  return groups
}

/** 分组当前可见条数：默认 5，「更多」每次 +5，封顶总数。 */
export function nextVisibleCount(current: number | undefined, total: number): number {
  return Math.min((current ?? GROUP_PAGE_SIZE) + GROUP_PAGE_SIZE, total)
}

/** 当前应展示的条数（未展开过分组 = 默认 5）。 */
export function visibleCount(current: number | undefined, total: number): number {
  return Math.min(current ?? GROUP_PAGE_SIZE, total)
}
