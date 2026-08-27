import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  addDays,
  buildStatsData,
  buildUsageData,
  currentStreak,
  dayKeyFromDate,
  daySpan,
  dayWindow,
  longestStreak,
  scanSessionFile,
  scanSessionsDir,
  type SessionScan,
} from './stats'

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function fixtureDir() {
  const dir = await mkdtemp(join(tmpdir(), 'volund-stats-'))
  dirs.push(dir)
  return dir
}

// 固定一个本地「今天」中午，所有 fixture 都相对它取本地日，避免时区漂移。
const NOW = new Date(2026, 7, 25, 12, 0, 0).getTime() // 2026-08-25 12:00 local
const TODAY = dayKeyFromDate(new Date(NOW))

function at(dayKey: string, hour = 10, minute = 0): string {
  const [year = 2026, month = 1, day = 1] = dayKey.split('-').map(Number)
  return new Date(year, month - 1, day, hour, minute, 0).toISOString()
}

function eventLine(type: string, atIso: string, payload: unknown, sessionId: string): string {
  return JSON.stringify({
    v: 1,
    id: `${type}-${atIso}-${Math.random().toString(36).slice(2)}`,
    type,
    sessionId,
    at: atIso,
    payload,
  })
}

interface FixtureTurn {
  dayOffset: number
  model?: string
  input?: number
  output?: number
  costUSD?: number
  linesAdded?: number
  linesRemoved?: number
  apiMs?: number
}

/** 写一个最小但完整的会话文件：session.started + N 个 turn（stream 对 + turn.completed）。 */
async function writeSession(
  dir: string,
  id: string,
  turns: readonly FixtureTurn[],
): Promise<string> {
  const lines: string[] = []
  const firstDay = addDays(TODAY, -Math.max(0, ...turns.map((turn) => turn.dayOffset)))
  lines.push(eventLine('session.started', at(firstDay, 9), { cwd: '/repo' }, id))
  turns.forEach((turn, index) => {
    const day = addDays(TODAY, -turn.dayOffset)
    const messageId = `m-${id}-${index}`
    const model = turn.model ?? 'kimi-k2.5'
    lines.push(
      eventLine(
        'stream.started',
        at(day, 10, index * 2),
        { messageId, provider: 'anthropic', model },
        id,
      ),
    )
    lines.push(
      eventLine(
        'stream.completed',
        at(day, 10, index * 2 + 1),
        { messageId, usage: { input: turn.input ?? 100, output: turn.output ?? 50 } },
        id,
      ),
    )
    lines.push(
      eventLine(
        'turn.completed',
        at(day, 10, index * 2 + 1),
        {
          turnId: `t-${index}`,
          usage: {
            input: turn.input ?? 100,
            output: turn.output ?? 50,
            ...(turn.costUSD === undefined ? {} : { costUSD: turn.costUSD }),
          },
        },
        id,
      ),
    )
    if (turn.linesAdded !== undefined || turn.linesRemoved !== undefined)
      lines.push(
        eventLine(
          'tool.completed',
          at(day, 10, index * 2 + 1),
          {
            toolUseId: `tu-${index}`,
            tool: 'Edit',
            isError: false,
            linesAdded: turn.linesAdded ?? 0,
            linesRemoved: turn.linesRemoved ?? 0,
          },
          id,
        ),
      )
  })
  const path = join(dir, `${id}.jsonl`)
  await writeFile(path, `${lines.join('\n')}\n`, { mode: 0o600 })
  return path
}

describe('scanSessionFile', () => {
  it('aggregates usage, api time, model tokens and line changes per session', async () => {
    const dir = await fixtureDir()
    const path = await writeSession(dir, '01900000-0000-7000-8000-0000000000a1', [
      { dayOffset: 1, input: 100, output: 50, costUSD: 0.25, linesAdded: 4, linesRemoved: 2 },
      { dayOffset: 0, input: 200, output: 60, costUSD: 0.75, linesAdded: 1 },
    ])
    const scan = await scanSessionFile(path, '01900000-0000-7000-8000-0000000000a1')
    expect(scan.tokens).toMatchObject({ input: 300, output: 110, costUSD: 1 })
    expect(scan.linesAdded).toBe(5)
    expect(scan.linesRemoved).toBe(2)
    // 每个 stream 对 1 分钟 → 2 分钟
    expect(scan.apiDurationMs).toBe(2 * 60_000)
    expect(scan.modelTokens['kimi-k2.5']).toBe(410)
    expect(scan.modelStreams['kimi-k2.5']).toBe(2)
    expect(scan.dayCounts[TODAY]).toBe(4) // 今天的 stream.started/completed + turn.completed + tool.completed
    expect(scan.firstAt).toBe(at(addDays(TODAY, -1), 9))
  })

  it('skips corrupt lines and ignores untracked event types without failing', async () => {
    const dir = await fixtureDir()
    const path = join(dir, '01900000-0000-7000-8000-0000000000a2.jsonl')
    await writeFile(
      path,
      [
        eventLine('session.started', at(TODAY, 9), { cwd: '/repo' }, 'a2'),
        '{"v":1,"type":"turn.completed","at":"not-a-date","payload":{}}',
        'this is not json',
        eventLine(
          'message.appended',
          at(TODAY, 9, 30),
          { messageId: 'm', role: 'user', content: [{ type: 'text', text: 'x'.repeat(10_000) }] },
          'a2',
        ),
      ].join('\n') + '\n',
    )
    const scan = await scanSessionFile(path, 'a2')
    expect(scan.events).toBe(1)
    expect(scan.tokens.input).toBe(0)
  })
})

describe('buildUsageData', () => {
  it('derives session cost, durations, code changes and tokens', async () => {
    const dir = await fixtureDir()
    const id = '01900000-0000-7000-8000-0000000000b1'
    const path = await writeSession(dir, id, [
      { dayOffset: 0, input: 1000, output: 500, costUSD: 0.5, linesAdded: 10, linesRemoved: 3 },
    ])
    const usage = buildUsageData(await scanSessionFile(path, id), NOW)
    expect(usage).toBeDefined()
    expect(usage!.costUSD).toBe(0.5)
    expect(usage!.tokens.input).toBe(1000)
    expect(usage!.linesAdded).toBe(10)
    expect(usage!.linesRemoved).toBe(3)
    expect(usage!.apiDurationMs).toBe(60_000)
    // wall：session.started 是今天 09:00，now 是 12:00
    expect(usage!.wallDurationMs).toBe(3 * 3_600_000)
  })

  it('counts an in-flight stream into API duration (live session)', async () => {
    const dir = await fixtureDir()
    const id = '01900000-0000-7000-8000-0000000000b2'
    const path = join(dir, `${id}.jsonl`)
    await writeFile(
      path,
      [
        eventLine('session.started', at(TODAY, 11), { cwd: '/repo' }, id),
        eventLine(
          'stream.started',
          at(TODAY, 11, 58),
          { messageId: 'm-open', provider: 'anthropic', model: 'kimi-k2.5' },
          id,
        ),
      ].join('\n') + '\n',
    )
    const usage = buildUsageData(await scanSessionFile(path, id), NOW)
    expect(usage!.apiDurationMs).toBe(2 * 60_000) // 11:58 → 12:00 在途
    expect(usage!.wallDurationMs).toBe(3_600_000)
  })

  it('returns undefined for an empty session file', async () => {
    const dir = await fixtureDir()
    const path = join(dir, '01900000-0000-7000-8000-0000000000b3.jsonl')
    await writeFile(path, '')
    expect(buildUsageData(await scanSessionFile(path, 'b3'), NOW)).toBeUndefined()
  })
})

describe('buildStatsData', () => {
  it('builds a 53-week heatmap ending today with per-day event counts', async () => {
    const dir = await fixtureDir()
    await writeSession(dir, '01900000-0000-7000-8000-0000000000c1', [
      { dayOffset: 0 },
      { dayOffset: 2 },
    ])
    const stats = buildStatsData(await scanSessionsDir(dir), NOW)
    const { start, days } = stats.heatmap
    // start 必须是周日，且 days 覆盖到今天
    const [year = 2026, month = 1, day = 1] = start.split('-').map(Number)
    expect(new Date(year, month - 1, day).getDay()).toBe(0)
    expect(addDays(start, days.length - 1)).toBe(TODAY)
    expect(days.length).toBe(52 * 7 + new Date(NOW).getDay() + 1)
    const todayIndex = daySpan(start, TODAY) - 1
    expect(days[todayIndex]).toBe(3)
    // -2 天：session.started + stream.started/completed + turn.completed = 4
    expect(days[daySpan(start, addDays(TODAY, -2)) - 1]).toBe(4)
  })

  it('summarizes all/7d/30d ranges with sessions, tokens and favorite model', async () => {
    const dir = await fixtureDir()
    await writeSession(dir, '01900000-0000-7000-8000-0000000000c2', [
      { dayOffset: 0, model: 'kimi-k2.5', input: 900, output: 100 },
      { dayOffset: 10, model: 'kimi-k2.5', input: 100, output: 50 },
    ])
    await writeSession(dir, '01900000-0000-7000-8000-0000000000c3', [
      { dayOffset: 20, model: 'claude-sonnet-4', input: 500, output: 500 },
    ])
    const stats = buildStatsData(await scanSessionsDir(dir), NOW)

    const all = stats.ranges.all
    expect(all.sessions).toBe(2)
    expect(all.totalTokens).toBe(1000 + 150 + 1000)
    expect(all.favoriteModel).toBe('kimi-k2.5')
    expect(all.models.map((model) => model.model)).toEqual(['kimi-k2.5', 'claude-sonnet-4'])
    expect(all.activeDays).toBe(3)
    expect(all.rangeDays).toBe(21) // 20 天前到今天，含端点

    const last7 = stats.ranges['7d']
    expect(last7.sessions).toBe(1)
    expect(last7.totalTokens).toBe(1000)
    expect(last7.activeDays).toBe(1)
    expect(last7.rangeDays).toBe(7)
    expect(last7.favoriteModel).toBe('kimi-k2.5')

    const last30 = stats.ranges['30d']
    expect(last30.sessions).toBe(2)
    expect(last30.totalTokens).toBe(2150)
  })

  it('computes streaks, most active day and longest session', async () => {
    const dir = await fixtureDir()
    // 连续 3 天（含今天）+ 40 天前一个长会话
    await writeSession(dir, '01900000-0000-7000-8000-0000000000c4', [
      { dayOffset: 0 },
      { dayOffset: 1 },
      { dayOffset: 2 },
    ])
    const longId = '01900000-0000-7000-8000-0000000000c5'
    const longPath = join(dir, `${longId}.jsonl`)
    await writeFile(
      longPath,
      [
        eventLine('session.started', at(addDays(TODAY, -40), 8), { cwd: '/repo' }, longId),
        eventLine(
          'turn.completed',
          at(addDays(TODAY, -40), 10),
          { turnId: 't', usage: { input: 5, output: 5 } },
          longId,
        ),
      ].join('\n') + '\n',
    )
    const stats = buildStatsData(await scanSessionsDir(dir), NOW)
    const all = stats.ranges.all
    expect(all.longestStreakDays).toBe(3)
    expect(all.currentStreakDays).toBe(3)
    expect(all.mostActiveDay).toBeDefined()
    // 最长会话是 c4：session.started（-2 天 09:00）→ 今天最后一条 turn.completed（10:01）
    expect(all.longestSessionMs).toBe(
      Date.parse(at(TODAY, 10, 1)) - Date.parse(at(addDays(TODAY, -2), 9)),
    )
    expect(all.longestSessionMs).toBeGreaterThan(2 * 3_600_000)
    const last7 = stats.ranges['7d']
    expect(last7.currentStreakDays).toBe(3)
    expect(last7.longestSessionMs).toBeGreaterThan(0)
    // 40 天前的会话不进 30 天窗口
    expect(stats.ranges['30d'].sessions).toBe(1)
  })

  it('handles an empty sessions directory', async () => {
    const dir = await fixtureDir()
    const stats = buildStatsData(await scanSessionsDir(dir), NOW)
    expect(stats.ranges.all.sessions).toBe(0)
    expect(stats.ranges.all.totalTokens).toBe(0)
    expect(stats.ranges.all.favoriteModel).toBeUndefined()
    expect(stats.ranges.all.models).toEqual([])
    expect(stats.heatmap.days.reduce((sum, count) => sum + count, 0)).toBe(0)
  })
})

describe('day helpers', () => {
  it('daySpan/addDays/dayWindow are consistent and local-day based', () => {
    expect(daySpan('2026-08-01', '2026-08-01')).toBe(1)
    expect(daySpan('2026-08-01', '2026-08-07')).toBe(7)
    expect(addDays('2026-08-25', -7)).toBe('2026-08-18')
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31')
    expect([...dayWindow('2026-08-25', 3)].toSorted()).toEqual([
      '2026-08-23',
      '2026-08-24',
      '2026-08-25',
    ])
  })

  it('streaks: longest run and current run ending today or yesterday', () => {
    const days = ['2026-08-20', '2026-08-21', '2026-08-23', '2026-08-24', '2026-08-25']
    expect(longestStreak(days)).toBe(3)
    expect(currentStreak(days, '2026-08-25')).toBe(3)
    // 今天还没活动、昨天有 → streak 仍活着
    expect(currentStreak(days.slice(0, -1), '2026-08-25')).toBe(2)
    expect(currentStreak(['2026-08-20'], '2026-08-25')).toBe(0)
    expect(longestStreak([])).toBe(0)
  })
})

// 类型锚点：SessionScan 保持可 JSON 序列化（未来如需缓存到磁盘）。
const _serializable: (scan: SessionScan) => string = (scan) => JSON.stringify(scan)
void _serializable
