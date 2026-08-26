import { describe, expect, it } from 'vitest'

import {
  activeTabEntries,
  createTabbedListState,
  isCommandTabsView,
  tabbedListKey,
  tabbedListPage,
  type CommandTabsSection,
} from './tabbed-list'

/** 只接受 update 动作的取值器（cancel/select 在对应用例里单独断言）。 */
function nextState(action: ReturnType<typeof tabbedListKey>) {
  expect(action.type).toBe('update')
  if (action.type !== 'update') throw new Error('unreachable')
  return action.state
}

const sections: readonly CommandTabsSection[] = [
  {
    id: 'builtin',
    label: 'Built-in (2)',
    entries: [
      { id: 'env', label: 'env', value: '0.1.0', status: 'loaded' },
      { id: 'manager', label: 'manager', value: '0.1.0', status: 'loaded' },
    ],
  },
  { id: 'dev', label: 'Dev (1)', entries: [{ id: 'demo', label: 'demo', status: 'loaded' }] },
  { id: 'market', label: 'Market (0)', entries: [] },
]

describe('isCommandTabsView（桥值守卫）', () => {
  it('accepts a well-formed tabs view', () => {
    expect(isCommandTabsView({ kind: 'tabs', title: 'Plugins', tabs: sections })).toBe(true)
  })
  it('rejects list views, malformed tabs, and non-objects', () => {
    expect(isCommandTabsView({ kind: 'list', title: 'x', entries: [] })).toBe(false)
    expect(isCommandTabsView({ kind: 'tabs', title: 'x', tabs: [] })).toBe(false)
    expect(
      isCommandTabsView({
        kind: 'tabs',
        title: 'x',
        tabs: [{ id: 'a', label: 'A', entries: [{ id: 1, label: 'bad' }] }],
      }),
    ).toBe(false)
    expect(isCommandTabsView({ kind: 'tabs', title: 'x', tabs: [{ id: 'a', entries: [] }] })).toBe(
      false,
    )
    expect(isCommandTabsView(null)).toBe(false)
    expect(isCommandTabsView('tabs')).toBe(false)
  })
})

describe('tabbedListKey（键盘交互）', () => {
  it('ArrowRight/ArrowLeft switch tabs, keep the query, and reset selection', () => {
    let state = { ...createTabbedListState(), query: 'de' }
    state = nextState(tabbedListKey(state, sections, 'ArrowRight'))
    expect(state.active).toBe(1)
    expect(state.query).toBe('de')
    expect(state.selected).toBe(0)
    state = nextState(tabbedListKey(state, sections, 'ArrowLeft'))
    expect(state.active).toBe(0)
    // 边界钳制
    expect(nextState(tabbedListKey({ ...state, active: 0 }, sections, 'ArrowLeft')).active).toBe(0)
    expect(
      nextState(tabbedListKey({ ...state, active: 2 }, sections, 'ArrowRight')).active,
    ).toBe(2)
  })

  it('Enter selects from the active tab after filtering', () => {
    const state = { ...createTabbedListState(), query: 'man' }
    const action = tabbedListKey(state, sections, 'Enter')
    expect(action).toMatchObject({ type: 'select', entry: { id: 'manager' } })
  })

  it('search only filters the active tab and typing resets selection', () => {
    let state = { ...createTabbedListState(), selected: 1 }
    state = nextState(tabbedListKey(state, sections, 'e'))
    state = nextState(tabbedListKey(state, sections, 'n'))
    expect(state.selected).toBe(0)
    expect(activeTabEntries(sections, state).map((entry) => entry.id)).toEqual(['env'])
    // 同一搜索词切到 dev 页签：无命中
    const devState = nextState(tabbedListKey({ ...state, active: 1 }, sections, 'ArrowRight'))
    expect(activeTabEntries(sections, devState)).toEqual([])
    expect(tabbedListKey(devState, sections, 'Enter').type).toBe('update')
  })

  it('Escape cancels and navigation moves within the active tab', () => {
    expect(tabbedListKey(createTabbedListState(), sections, 'Escape').type).toBe('cancel')
    const down = nextState(tabbedListKey(createTabbedListState(), sections, 'ArrowDown'))
    expect(down.selected).toBe(1)
    const end = nextState(tabbedListKey(createTabbedListState(), sections, 'End'))
    expect(end.selected).toBe(1)
  })

  it('pages the active tab like the flat list picker', () => {
    const page = tabbedListPage(sections, createTabbedListState(), 1)
    expect(page).toMatchObject({ start: 0, end: 1, total: 2 })
    const second = tabbedListPage(sections, { ...createTabbedListState(), selected: 1 }, 1)
    expect(second).toMatchObject({ start: 1, end: 2, total: 2 })
  })
})
