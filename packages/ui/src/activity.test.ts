import type { TranscriptEntry } from '@volund/app-runtime'
import { describe, expect, it } from 'vitest'

import {
  activityTarget,
  activityVerbs,
  buildTimeline,
  completeActivity,
  formatActivityDuration,
  type ActivityItem,
} from './activity'

describe('activityTarget', () => {
  it('extracts the per-tool display target', () => {
    expect(activityTarget('Read', { path: '/repo/a.ts' })).toBe('/repo/a.ts')
    expect(activityTarget('Grep', { pattern: 'foo', path: '/repo' })).toBe('foo')
    expect(activityTarget('Bash', { command: 'pnpm test' })).toBe('$ pnpm test')
    expect(activityTarget('WebFetch', { url: 'https://example.com' })).toBe('https://example.com')
    expect(activityTarget('Task', { agentType: 'Explore', prompt: 'find x' })).toBe('Explore')
  })

  it('falls back to well-known keys for unknown tools', () => {
    expect(activityTarget('CustomTool', { file_path: 'x.md' })).toBe('x.md')
    expect(activityTarget('CustomTool', { nothing: 1 })).toBeUndefined()
    expect(activityTarget('Todo', { todos: [] })).toBeUndefined()
    expect(activityTarget('Read', 'not-an-object')).toBeUndefined()
    expect(activityTarget('Read', undefined)).toBeUndefined()
  })

  it('never leaks body params and sanitizes control chars', () => {
    expect(activityTarget('Write', { content: 'should-never-show' })).toBeUndefined()
    // bidi 控制字符经 SafeDisplay 转义，换行压成空格
    const target = activityTarget('Bash', { command: 'touch x\u202E\nrm -rf ~' })
    expect(target).not.toContain('\u202E')
    expect(target).not.toContain('\n')
    expect(target).toContain('touch x')
  })

  it('truncates long targets with an ellipsis', () => {
    const target = activityTarget('Read', { path: `/repo/${'a'.repeat(200)}` })
    expect(target).toBeDefined()
    expect(target!.length).toBeLessThanOrEqual(72)
    expect(target!.endsWith('…')).toBe(true)
  })
})

describe('activityVerbs', () => {
  it('has verbs for built-in tools and a named fallback', () => {
    expect(activityVerbs('Read').running).toBe('正在读取')
    expect(activityVerbs('Bash').done).toBe('已运行')
    expect(activityVerbs('Mystery').running).toBe('正在使用 Mystery')
    expect(activityVerbs('Mystery').error).toBe('Mystery 失败')
  })
})

describe('formatActivityDuration', () => {
  it('formats sub-10s with one decimal, then whole seconds, then minutes', () => {
    expect(formatActivityDuration(320)).toBe('0.3s')
    expect(formatActivityDuration(12_400)).toBe('12s')
    expect(formatActivityDuration(125_000)).toBe('2m05s')
  })
})

describe('completeActivity', () => {
  const running: ActivityItem = { id: 'e1', toolUseId: 'tu-1', tool: 'Read', status: 'running' }

  it('patches the matching item only', () => {
    const other: ActivityItem = { id: 'e2', toolUseId: 'tu-2', tool: 'Bash', status: 'running' }
    const result = completeActivity([running, other], 'tu-2', { isError: true, durationMs: 5 })
    expect(result[0]).toBe(running)
    expect(result[1]).toMatchObject({ status: 'error', durationMs: 5 })
  })
})

describe('buildTimeline', () => {
  const message = (id: string): TranscriptEntry => ({ id, role: 'assistant', text: id })
  const activity = (id: string): ActivityItem => ({
    id,
    toolUseId: id,
    tool: 'Read',
    status: 'done',
  })

  it('interleaves messages and activities by event id (uuidv7 ≈ chronological)', () => {
    const items = buildTimeline(
      [
        message('0192c8f4-0000-7000-8000-000000000001'),
        message('0192c8f4-0000-7000-8000-000000000003'),
      ],
      [activity('0192c8f4-0000-7000-8000-000000000002')],
    )
    expect(items.map((item) => (item.kind === 'message' ? item.entry.id : item.item.id))).toEqual([
      '0192c8f4-0000-7000-8000-000000000001',
      '0192c8f4-0000-7000-8000-000000000002',
      '0192c8f4-0000-7000-8000-000000000003',
    ])
  })

  it('pins notices first and the pending stream last', () => {
    const items = buildTimeline(
      [
        message('notice-0'),
        message('0192c8f4-0000-7000-8000-000000000001'),
        message('pending-assistant'),
      ],
      [activity('0192c8f4-0000-7000-8000-000000000002')],
    )
    expect(items.map((item) => (item.kind === 'message' ? item.entry.id : item.item.id))).toEqual([
      'notice-0',
      '0192c8f4-0000-7000-8000-000000000001',
      '0192c8f4-0000-7000-8000-000000000002',
      'pending-assistant',
    ])
  })
})
