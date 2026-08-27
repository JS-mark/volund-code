import { describe, expect, it, vi } from 'vitest'

import {
  applyPickerSelection,
  createPickerCandidates,
  PermissionPromptQueue,
  resumeSessionView,
  renderContextPanel,
  contextPanelKey,
  createSessionView,
  BUILTIN_THEMES,
  PluginUiRegistry,
  parseTheme,
  resolveTheme,
  validateTheme,
} from './index'

describe('themes and declarative plugin UI', () => {
  it('validates schema v1 and falls back deterministically', () => {
    expect(validateTheme(BUILTIN_THEMES.dark)).toEqual(BUILTIN_THEMES.dark)
    expect(() => validateTheme({ ...BUILTIN_THEMES.dark, schemaVersion: 2 })).toThrow('version')
    expect(() =>
      validateTheme({
        ...BUILTIN_THEMES.dark,
        tokens: { ...BUILTIN_THEMES.dark.tokens, accent: 'red' },
      }),
    ).toThrow('accent')
    expect(resolveTheme(null, 'light')).toMatchObject({
      theme: BUILTIN_THEMES.light,
      fallback: true,
    })
    expect(parseTheme('{broken', 'dark')).toMatchObject({
      theme: BUILTIN_THEMES.dark,
      fallback: true,
    })
  })

  it('isolates, orders, cleans up, and headlessly ignores contributions', () => {
    const registry = new PluginUiRegistry()
    const low = registry.register('volund-plugin-a', {
      id: 'branch',
      surface: 'status-bar',
      text: 'main',
    })
    registry.register('volund-plugin-b', {
      id: 'cost',
      surface: 'status-bar',
      text: '$0.01',
      priority: 10,
    })
    expect(registry.list('status-bar').map((item) => item.plugin)).toEqual([
      'volund-plugin-b',
      'volund-plugin-a',
    ])
    low.dispose()
    expect(registry.list('status-bar')).toHaveLength(1)
    const headless = new PluginUiRegistry(true)
    headless.register('volund-plugin-a', { id: 'x', surface: 'status-bar', text: 'ignored' })
    expect(headless.list('status-bar')).toEqual([])
  })
})

describe('unified picker', () => {
  it('puts an alias before a same-named file and supports explicit file mode', () => {
    const aliases = [{ alias: 'sonnet', model: 'claude-sonnet-4' }]
    expect(
      createPickerCandidates('@son', aliases, ['sonnet', 'src/a.ts']).map((item) => item.kind),
    ).toEqual(['model', 'file'])
    expect(createPickerCandidates('@@son', aliases, ['sonnet']).map((item) => item.kind)).toEqual([
      'file',
    ])
    expect(
      applyPickerSelection(
        '@sonnet fix it',
        createPickerCandidates('@son', aliases, ['sonnet'])[0]!,
      ),
    ).toEqual({ hint: { explicitModel: 'claude-sonnet-4' }, text: 'fix it' })
  })
})

it('renders and controls the /context panel', () => {
  const output = renderContextPanel({
    strategy: 'summary',
    currentTokens: 80,
    maxTokens: 100,
    threshold: 0.85,
    sources: { messages: 60, system: 20 },
    recentCompactions: [{ at: '12:34', removed: 5 }],
  })
  expect(output).toContain('Strategy: summary')
  expect(output).toContain('removed 5 msgs')
  expect(contextPanelKey('k', 'm1')).toEqual({ type: 'keep', messageId: 'm1' })
  expect(contextPanelKey('c')).toEqual({ type: 'compact' })
})

it('serializes permission prompts', async () => {
  let active = 0
  const show = vi.fn(async () => {
    active += 1
    expect(active).toBe(1)
    await Promise.resolve()
    active -= 1
    return 'allow-once' as const
  })
  const queue = new PermissionPromptQueue(show)
  await Promise.all([
    queue.request({ id: '1', description: 'write', risk: 'medium' }),
    queue.request({ id: '2', description: 'bash', risk: 'high' }),
  ])
  expect(show).toHaveBeenCalledTimes(2)
})

it('restores a transcript without reviving withdrawn output', () => {
  const view = createSessionView('s1')
  view.pendingText = 'partial'
  view.interruptedText = 'old'
  resumeSessionView(view, ['user: hello', 'assistant: hi'])
  expect(view).toMatchObject({
    status: 'active',
    pendingText: '',
    interruptedText: null,
    transcript: ['user: hello', 'assistant: hi'],
  })
})
