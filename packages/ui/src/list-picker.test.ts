import { describe, expect, it } from 'vitest'

import {
  createListPickerState,
  filterListEntries,
  isCommandListView,
  listPickerKey,
  listPickerPage,
  type CommandListEntry,
} from './list-picker'

const entries: readonly CommandListEntry[] = [
  { id: 'NO_PROXY', label: 'NO_PROXY', value: 'localhost', status: 'effective' },
  { id: 'HTTP_PROXY', label: 'HTTP_PROXY', value: 'http://127.0.0.1:7890', status: 'effective' },
  { id: 'TZ', label: 'TZ', value: 'Asia/Shanghai', status: 'pending' },
]

describe('isCommandListView', () => {
  it('accepts a well-formed view and rejects anything else', () => {
    expect(isCommandListView({ kind: 'list', title: 'Env', entries })).toBe(true)
    expect(isCommandListView({ kind: 'list', title: 'Env', entries: [] })).toBe(true)
    expect(isCommandListView({ kind: 'list', entries })).toBe(false) // 缺 title
    expect(isCommandListView({ kind: 'list', title: 'Env', entries: [{ id: 'A' }] })).toBe(false) // 缺 label
    expect(isCommandListView({ kind: 'table', title: 'Env', entries })).toBe(false)
    expect(isCommandListView('list')).toBe(false)
    expect(isCommandListView(null)).toBe(false)
  })
})

describe('filterListEntries', () => {
  it('returns all entries in order for an empty query', () => {
    expect(filterListEntries(entries, '').map((entry) => entry.id)).toEqual([
      'NO_PROXY',
      'HTTP_PROXY',
      'TZ',
    ])
  })

  it('matches case-insensitively across label, value, and status', () => {
    expect(filterListEntries(entries, 'no_proxy').map((entry) => entry.id)).toEqual(['NO_PROXY'])
    expect(filterListEntries(entries, '7890').map((entry) => entry.id)).toEqual(['HTTP_PROXY'])
    expect(filterListEntries(entries, 'pending').map((entry) => entry.id)).toEqual(['TZ'])
    expect(filterListEntries(entries, 'nothing-matches')).toEqual([])
  })
})

describe('listPickerKey', () => {
  it('types into the query, moves the selection, and selects on Enter', () => {
    const initial = createListPickerState(entries)
    const typed = listPickerKey(initial, 't')
    expect(typed).toEqual({ type: 'update', state: { entries, query: 't', selected: 0 } })

    const down = listPickerKey(initial, 'ArrowDown')
    expect(down).toEqual({ type: 'update', state: { entries, query: '', selected: 1 } })

    const selected = listPickerKey(initial, 'Enter')
    expect(selected).toEqual({ type: 'select', entry: entries[0] })
    expect(listPickerKey(initial, 'Escape')).toEqual({ type: 'cancel' })
  })

  it('clamps the selection at both ends and pages by pageSize', () => {
    const initial = createListPickerState(entries)
    expect(listPickerKey(initial, 'ArrowUp')).toEqual({ type: 'update', state: initial })
    const end = listPickerKey(initial, 'End')
    expect(end).toEqual({ type: 'update', state: { entries, query: '', selected: 2 } })
  })
})

describe('listPickerPage', () => {
  it('pages by selection block', () => {
    const many: CommandListEntry[] = Array.from({ length: 25 }, (_, index) => ({
      id: `K${index}`,
      label: `K${index}`,
    }))
    const page = listPickerPage(many, 12, 10)
    expect(page.start).toBe(10)
    expect(page.end).toBe(20)
    expect(page.total).toBe(25)
    expect(page.items).toHaveLength(10)
  })
})
