import { describe, expect, it } from 'vitest'

import type { SessionGroupsView, SessionSummary } from './api'
import {
  buildSidebarGroups,
  GROUP_PAGE_SIZE,
  nextVisibleCount,
  UNGROUPED_KEY,
  visibleCount,
} from './session-groups'

function session(id: string): SessionSummary {
  return { id, cwd: '/tmp/ws', updatedAt: '2026-09-07T00:00:00Z', title: `会话 ${id}` }
}

function view(groups: { id: string; name: string }[], assignments: Record<string, string> = {}) {
  return {
    groups: groups.map((group, index) => ({ ...group, createdAt: index })),
    assignments,
  } satisfies SessionGroupsView
}

describe('buildSidebarGroups', () => {
  it('puts sessions into their groups and keeps group order; ungrouped comes last', () => {
    const groups = buildSidebarGroups(
      [session('s1'), session('s2'), session('s3'), session('s4')],
      view(
        [
          { id: 'g1', name: '工作' },
          { id: 'g2', name: '玩具' },
        ],
        { s1: 'g1', s3: 'g1', s4: 'g2' },
      ),
    )
    expect(groups.map((group) => group.key)).toEqual(['g1', 'g2', UNGROUPED_KEY])
    expect(groups[0]!.sessions.map((item) => item.id)).toEqual(['s1', 's3'])
    expect(groups[1]!.sessions.map((item) => item.id)).toEqual(['s4'])
    expect(groups[2]!.sessions.map((item) => item.id)).toEqual(['s2'])
    expect(groups[2]!.builtin).toBe(true)
  })

  it('falls back to ungrouped when the assignment points at a deleted group', () => {
    const groups = buildSidebarGroups(
      [session('s1')],
      view([{ id: 'g1', name: '工作' }], { s1: 'grp_gone' }),
    )
    expect(groups.at(-1)!.key).toBe(UNGROUPED_KEY)
    expect(groups.at(-1)!.sessions.map((item) => item.id)).toEqual(['s1'])
  })

  it('keeps empty user groups so sessions can be moved into them', () => {
    const groups = buildSidebarGroups([session('s1')], view([{ id: 'g1', name: '空组' }]))
    expect(groups[0]!.sessions).toEqual([])
    expect(groups.map((group) => group.key)).toEqual(['g1', UNGROUPED_KEY])
  })

  it('hides the ungrouped bucket when it is empty and user groups exist', () => {
    const groups = buildSidebarGroups(
      [session('s1')],
      view([{ id: 'g1', name: '工作' }], { s1: 'g1' }),
    )
    expect(groups.map((group) => group.key)).toEqual(['g1'])
  })

  it('yields a single ungrouped bucket when no user groups exist', () => {
    const groups = buildSidebarGroups([session('s1'), session('s2')], view([]))
    expect(groups.map((group) => group.key)).toEqual([UNGROUPED_KEY])
    expect(groups[0]!.sessions).toHaveLength(2)
  })
})

describe('per-group pagination', () => {
  it('defaults to 5 visible items and grows by 5 per 更多 click', () => {
    expect(GROUP_PAGE_SIZE).toBe(5)
    expect(visibleCount(undefined, 12)).toBe(5)
    expect(visibleCount(10, 12)).toBe(10)
    expect(nextVisibleCount(undefined, 12)).toBe(10)
    expect(nextVisibleCount(10, 12)).toBe(12)
    // 封顶：不超过总数
    expect(nextVisibleCount(11, 12)).toBe(12)
    expect(nextVisibleCount(undefined, 3)).toBe(3)
  })
})
