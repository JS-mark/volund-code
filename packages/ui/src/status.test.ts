import { describe, expect, it } from 'vitest'

import {
  buildStatusSections,
  statusPanelFromWelcome,
  validateStatusConfigValue,
  type StatusViewModel,
} from './status'
import type { WelcomePanelData } from './welcome'

describe('status panel adapter', () => {
  it('uses honest unavailable values and never includes credential values', () => {
    const data = statusPanelFromWelcome(welcomeFixture())
    expect(data.status).toEqual(
      expect.arrayContaining([
        { label: 'Auth method', value: 'not available' },
        { label: 'Skills', value: 'not available' },
        { label: 'Plugins', value: 'not available' },
      ]),
    )
    expect(JSON.stringify(data)).not.toMatch(/sk-secret|token-value/)
  })

  it('rejects readonly, invalid enum, and out-of-range edits', () => {
    expect(() =>
      validateStatusConfigValue(
        { id: 'authMethod', label: 'Auth method', value: 'keychain', editable: false },
        'env',
      ),
    ).toThrow('read-only')
    expect(() =>
      validateStatusConfigValue(
        {
          id: 'reasoningEffort',
          label: 'Reasoning',
          value: 'low',
          editable: true,
          kind: 'enum',
          choices: ['low', 'high'],
        },
        'extreme',
      ),
    ).toThrow('Allowed values')
    expect(() =>
      validateStatusConfigValue(
        {
          id: 'cleanupPeriod',
          label: 'Cleanup',
          value: 30,
          editable: true,
          kind: 'number',
          min: 1,
          max: 365,
        },
        0,
      ),
    ).toThrow('Minimum')
  })
})

describe('status view model formatter', () => {
  it('builds stable JSON-safe Status, Settings, and Config sections', () => {
    const view: StatusViewModel = {
      identity: {
        version: '1.2.3',
        sessionId: 'session-1',
        createdAt: '2026-08-09T00:00:00.000Z',
        cwd: '/repo',
        workspace: { status: 'available', value: '/repo' },
        project: { status: 'not_available', reason: { code: 'project_not_available' } },
      },
      model: {
        status: 'available',
        provider: 'anthropic',
        model: 'claude',
        liteModel: { status: 'disabled' },
        reasoningModel: { status: 'not_available', reason: { code: 'reasoning_unknown' } },
        source: 'session',
      },
      runtime: {
        sandbox: { status: 'available', value: { tier: 'full', mechanism: 'sandbox-exec' } },
        filesystem: { status: 'available', value: 'isolated' },
        network: { status: 'blocked', reason: { code: 'network_blocked' } },
        permission: { status: 'available', value: { mode: 'ask', source: 'default' } },
        memory: { status: 'not_available', reason: { code: 'memory_adapter_unavailable' } },
      },
      auth: {
        configured: { status: 'available', value: true },
        method: { status: 'not_available', reason: { code: 'auth_method_unavailable' } },
      },
      settings: [
        { key: 'language', effectiveValue: 'en', source: 'user', readonly: false, locked: false },
        { key: 'model', effectiveValue: 'claude', source: 'flag', readonly: true, locked: true },
      ],
      config: {
        sources: { status: 'available', value: ['default', 'user', 'flag'] },
      },
      capabilities: {
        mcpServers: { status: 'available', value: { count: 1, names: ['local'] } },
        skills: { status: 'not_available', reason: { code: 'skills_adapter_unavailable' } },
        plugins: { status: 'disabled' },
      },
      usage: {
        tokens: { input: 4, output: 6 },
        context: { currentTokens: 10, maxTokens: 100 },
        costUSD: 0.01,
      },
    }

    const sections = buildStatusSections(view)

    expect(sections.map((section) => section.id)).toEqual(['status', 'settings', 'config'])
    expect(sections[1]?.items).toContainEqual({
      key: 'language',
      label: 'language',
      value: 'en',
      source: 'user',
      readonly: false,
      locked: false,
    })
    expect(sections[2]?.items).toContainEqual(
      expect.objectContaining({ key: 'config.sources', value: 'default, user, flag' }),
    )
    expect(JSON.stringify(sections)).not.toContain(String.fromCharCode(27))
    expect(JSON.parse(JSON.stringify(sections))).toEqual(sections)
  })

  it('preserves not_available reason codes without leaking secret-like settings', () => {
    const view = minimalView({
      settings: [
        {
          key: 'authorization_header',
          effectiveValue: 'Bearer secret',
          source: 'env',
          readonly: true,
          locked: true,
        },
      ],
    })

    const output = JSON.stringify(buildStatusSections(view))
    expect(output).toContain('model_source_unreliable')
    expect(output).not.toContain('authorization')
    expect(output).not.toContain('secret')
  })
})

function welcomeFixture(): WelcomePanelData {
  return {
    version: '1.2.3',
    sessionId: 'session',
    cwd: '/repo',
    model: { status: 'available', provider: 'anthropic', model: 'sonnet', source: 'default' },
    sandbox: {
      status: 'available',
      tier: 'full',
      mechanism: 'test',
      filesystem: 'workspace',
      network: 'restricted',
    },
    permission: { mode: 'ask', dangerous: false, source: 'default' },
    config: {
      effectiveSources: ['defaults'],
      user: { status: 'disabled' },
      project: { status: 'disabled' },
    },
    mcp: { status: 'unavailable', reason: { code: 'missing', message: 'missing' } },
    history: { status: 'disabled' },
  }
}

function minimalView(overrides: Partial<StatusViewModel> = {}): StatusViewModel {
  return {
    identity: {
      version: '0.0.0',
      sessionId: 'session',
      createdAt: '2026-08-09T00:00:00.000Z',
      cwd: '/repo',
      workspace: { status: 'not_available', reason: { code: 'workspace_not_available' } },
      project: { status: 'not_available', reason: { code: 'project_not_available' } },
    },
    model: {
      status: 'not_available',
      reason: { code: 'model_source_unreliable' },
      source: 'derived_unreliable',
    },
    runtime: {
      sandbox: { status: 'not_available', reason: { code: 'sandbox_not_available' } },
      filesystem: { status: 'not_available', reason: { code: 'filesystem_not_available' } },
      network: { status: 'not_available', reason: { code: 'network_not_available' } },
      permission: { status: 'not_available', reason: { code: 'permission_not_available' } },
      memory: { status: 'not_available', reason: { code: 'memory_not_available' } },
    },
    auth: {
      configured: { status: 'available', value: false },
      method: { status: 'not_available', reason: { code: 'auth_method_unavailable' } },
    },
    settings: [],
    config: {
      sources: { status: 'not_available', reason: { code: 'config_sources_unavailable' } },
    },
    capabilities: {
      mcpServers: { status: 'not_available', reason: { code: 'mcp_not_available' } },
      skills: { status: 'not_available', reason: { code: 'skills_not_available' } },
      plugins: { status: 'not_available', reason: { code: 'plugins_not_available' } },
    },
    usage: {
      tokens: { input: 0, output: 0 },
      context: { currentTokens: 0, maxTokens: 0 },
      costUSD: 0,
    },
    ...overrides,
  }
}

describe('status usage/stats formatting helpers', () => {
  it('formatCompactCount compacts with k/m/b and trims trailing .0', async () => {
    const { formatCompactCount } = await import('./status')
    expect(formatCompactCount(0)).toBe('0')
    expect(formatCompactCount(999)).toBe('999')
    expect(formatCompactCount(2100)).toBe('2.1k')
    expect(formatCompactCount(2000)).toBe('2k')
    expect(formatCompactCount(1_100_000)).toBe('1.1m')
    expect(formatCompactCount(1_100_000_000)).toBe('1.1b')
    expect(formatCompactCount(250_000_000)).toBe('250m')
  })

  it('formatDurationMs picks the largest two units', async () => {
    const { formatDurationMs } = await import('./status')
    expect(formatDurationMs(0)).toBe('0s')
    expect(formatDurationMs(37_000)).toBe('37s')
    expect(formatDurationMs(3 * 60_000 + 12_000)).toBe('3m 12s')
    expect(formatDurationMs(18 * 3_600_000 + 5 * 60_000)).toBe('18h 5m')
    expect(formatDurationMs((13 * 24 + 18) * 3_600_000 + 5 * 60_000)).toBe('13d 18h 5m')
  })

  it('formatCostUSD keeps four decimals under one dollar', async () => {
    const { formatCostUSD } = await import('./status')
    expect(formatCostUSD(0)).toBe('$0.0000')
    expect(formatCostUSD(0.0123)).toBe('$0.0123')
    expect(formatCostUSD(42.5)).toBe('$42.50')
  })

  it('heatmapLevel buckets by quartile of the max day', async () => {
    const { heatmapLevel } = await import('./status')
    expect(heatmapLevel(0, 100)).toBe(0)
    expect(heatmapLevel(5, 100)).toBe(1)
    expect(heatmapLevel(25, 100)).toBe(1)
    expect(heatmapLevel(50, 100)).toBe(2)
    expect(heatmapLevel(75, 100)).toBe(3)
    expect(heatmapLevel(100, 100)).toBe(4)
    expect(heatmapLevel(3, 0)).toBe(0)
  })

  it('formatShortDay renders YYYY-MM-DD as a short month label', async () => {
    const { formatShortDay } = await import('./status')
    expect(formatShortDay('2026-03-03')).toBe('Mar 3')
    expect(formatShortDay('2026-12-31')).toBe('Dec 31')
    expect(formatShortDay('bogus')).toBe('bogus')
  })

  it('annaKareninaLine only appears once total tokens pass one novel', async () => {
    const { annaKareninaLine, ANNA_KARENINA_TOKENS } = await import('./status')
    expect(annaKareninaLine(ANNA_KARENINA_TOKENS - 1)).toBeUndefined()
    expect(annaKareninaLine(ANNA_KARENINA_TOKENS)).toContain('~1x')
    expect(annaKareninaLine(ANNA_KARENINA_TOKENS * 2311)).toBe(
      "You've used ~2311x more tokens than Anna Karenina",
    )
  })
})

describe('sanitizePluginTabs (PLUGIN-STATUS-UI-r1 §S3.3)', () => {
  const rowsTab = (id: string, label: string, rows: [string, string | number | boolean][]) => ({
    schemaVersion: 1 as const,
    id,
    label,
    body: { kind: 'rows' as const, sections: [{ title: 'S', rows }] },
  })

  it('passes a clean rows tab through, stripping control characters', async () => {
    const { sanitizePluginTabs } = await import('./status')
    const [tab] = sanitizePluginTabs([
      rowsTab('demo', 'Demo', [
        ['engine', 'kimi\u001B[31m-x'],
        ['events', 42],
      ]),
    ])
    expect(tab && 'error' in tab).toBe(false)
    if (tab && !('error' in tab) && tab.body.kind === 'rows') {
      expect(tab.body.sections[0]?.rows).toEqual([
        ['engine', 'kimi-x'],
        ['events', '42'],
      ])
    }
  })

  it('rejects reserved and duplicate ids with an error placeholder', async () => {
    const { sanitizePluginTabs } = await import('./status')
    const tabs = sanitizePluginTabs([
      rowsTab('status', 'Mine', [['a', 'b']]),
      rowsTab('demo', 'One', [['a', 'b']]),
      rowsTab('demo', 'Two', [['a', 'b']]),
    ])
    expect(tabs.map((tab) => ('error' in tab ? `error:${tab.id}` : tab.id))).toEqual([
      'error:status',
      'demo',
      'error:demo',
    ])
  })

  it('rejects the whole descriptor when any value hits the credential pattern', async () => {
    const { sanitizePluginTabs } = await import('./status')
    const [tab] = sanitizePluginTabs([rowsTab('demo', 'Demo', [['note', 'api_key = sk-1']])])
    expect(tab && 'error' in tab).toBe(true)
  })

  it('truncates oversized sections and marks the truncation', async () => {
    const { sanitizePluginTabs } = await import('./status')
    const rows: [string, string][] = Array.from({ length: 25 }, (_, i) => [`k${i}`, `v${i}`])
    const [tab] = sanitizePluginTabs([rowsTab('demo', 'Demo', rows)])
    if (tab && !('error' in tab) && tab.body.kind === 'rows') {
      const out = tab.body.sections[0]!.rows
      expect(out).toHaveLength(20)
      expect(out[19]![1]).toContain('… (truncated)')
    } else {
      throw new Error('expected rows tab')
    }
  })

  it('validates heatmap start and coerces day counts', async () => {
    const { sanitizePluginTabs } = await import('./status')
    const [bad] = sanitizePluginTabs([
      { id: 'h1', label: 'Pulse', body: { kind: 'heatmap', heatmap: { start: 'Aug', days: [] } } },
    ])
    expect(bad && 'error' in bad).toBe(true)
    const [good] = sanitizePluginTabs([
      {
        id: 'h2',
        label: 'Pulse',
        body: { kind: 'heatmap', heatmap: { start: '2026-08-23', days: [1, -2, 3.7, Number.NaN] } },
      },
    ])
    if (good && !('error' in good) && good.body.kind === 'heatmap') {
      expect(good.body.heatmap.days).toEqual([1, 0, 3, 0])
    } else {
      throw new Error('expected heatmap tab')
    }
  })

  it('caps tables at 4 columns and 20 rows', async () => {
    const { sanitizePluginTabs } = await import('./status')
    const [tab] = sanitizePluginTabs([
      {
        id: 't1',
        label: 'Grid',
        body: {
          kind: 'table',
          columns: ['a', 'b', 'c', 'd', 'e'],
          rows: Array.from({ length: 25 }, (_, i) => [`r${i}`, '1', '2', '3', '4']),
        },
      },
    ])
    if (tab && !('error' in tab) && tab.body.kind === 'table') {
      expect(tab.body.columns).toEqual(['a', 'b', 'c', 'd'])
      expect(tab.body.rows).toHaveLength(20)
      expect(tab.body.rows[0]).toEqual(['r0', '1', '2', '3'])
    } else {
      throw new Error('expected table tab')
    }
  })
})
