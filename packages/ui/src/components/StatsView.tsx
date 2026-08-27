import { productIdentity } from '@volund/shared'
import { Box, Text, useInput } from 'ink'
import { useState } from 'react'

import type { StatsRangeId, StatusStatsData } from '../status'
import { annaKareninaLine, formatCompactCount, formatDurationMs, STATS_RANGES } from '../status'
import { StatusHeatmap } from './StatusHeatmap'

export interface StatsViewProps {
  stats?: StatusStatsData
  /** 终端列宽，用于截断热力图到可视周数。 */
  columns: number
}

type StatsSubview = 'overview' | 'models'

const STATS_VALUE_COLOR = '#f08c3c'

/** /status → Stats：Overview（热力图 + 汇总）与 Models（按模型拆分）两个子视图。 */
export function StatsView({ stats, columns }: StatsViewProps) {
  const [view, setView] = useState<StatsSubview>('overview')
  const [range, setRange] = useState<StatsRangeId>('all')

  useInput((input, key) => {
    if (key.upArrow || key.downArrow) {
      setView((current) => (current === 'overview' ? 'models' : 'overview'))
      return
    }
    if (input === 'r') {
      setRange((current) => {
        const index = STATS_RANGES.findIndex((entry) => entry.id === current)
        return STATS_RANGES[(index + 1) % STATS_RANGES.length]!.id
      })
    }
  })

  if (!stats)
    return (
      <Box flexDirection="column" minHeight={7}>
        <StatsSubviewTabs view={view} />
        <Text dimColor>
          No session history found yet — stats build up as you use {productIdentity.shortName}
        </Text>
      </Box>
    )
  const overview = stats.ranges[range]
  return (
    <Box flexDirection="column">
      <StatsSubviewTabs view={view} />
      {view === 'overview' ? (
        <Box flexDirection="column">
          <StatusHeatmap columns={columns} heatmap={stats.heatmap} />
          <RangeSelector range={range} />
          <OverviewStats range={range} stats={overview} />
        </Box>
      ) : (
        <ModelsStats range={range} stats={overview} />
      )}
    </Box>
  )
}

function StatsSubviewTabs({ view }: { view: StatsSubview }) {
  return (
    <Box marginBottom={1}>
      <Text {...(view === 'overview' ? { inverse: true } : {})}>
        {view === 'overview' ? '[Overview]' : ' Overview '}
      </Text>
      <Text>{'  '}</Text>
      <Text {...(view === 'models' ? { inverse: true } : {})}>
        {view === 'models' ? '[Models]' : ' Models '}
      </Text>
    </Box>
  )
}

function RangeSelector({ range }: { range: StatsRangeId }) {
  return (
    <Box marginBottom={1}>
      <Text>
        {STATS_RANGES.map((entry, index) => (
          <Text key={entry.id}>
            {index > 0 ? <Text dimColor>{' · '}</Text> : null}
            <Text
              {...(entry.id === range
                ? { bold: true, color: STATS_VALUE_COLOR }
                : { dimColor: true })}
            >
              {entry.label}
            </Text>
          </Text>
        ))}
      </Text>
    </Box>
  )
}

function OverviewStats({
  range,
  stats,
}: {
  range: StatsRangeId
  stats: StatusStatsData['ranges'][StatsRangeId]
}) {
  const pairs: readonly (readonly [readonly [string, string], readonly [string, string]])[] = [
    [
      ['Favorite model:', stats.favoriteModel ?? 'not available'],
      ['Total tokens:', formatCompactCount(stats.totalTokens)],
    ],
    [
      ['Sessions:', formatCompactCount(stats.sessions)],
      ['Longest session:', formatDurationMs(stats.longestSessionMs)],
    ],
    [
      ['Active days:', `${stats.activeDays}/${stats.rangeDays}`],
      ['Longest streak:', `${stats.longestStreakDays} days`],
    ],
    [
      ['Most active day:', stats.mostActiveDay ?? 'not available'],
      ['Current streak:', `${stats.currentStreakDays} days`],
    ],
  ]
  const funFact = range === 'all' ? annaKareninaLine(stats.totalTokens) : undefined
  return (
    <Box flexDirection="column">
      {pairs.map(([left, right]) => (
        <Box key={left[0]}>
          <Box width={18}>
            <Text dimColor>{left[0]}</Text>
          </Box>
          <Box width={24}>
            <Text color={STATS_VALUE_COLOR} wrap="truncate-end">
              {left[1]}
            </Text>
          </Box>
          <Box width={18}>
            <Text dimColor>{right[0]}</Text>
          </Box>
          <Text color={STATS_VALUE_COLOR} wrap="truncate-end">
            {right[1]}
          </Text>
        </Box>
      ))}
      {funFact ? (
        <Box marginTop={1}>
          <Text color="cyan">{funFact}</Text>
        </Box>
      ) : null}
    </Box>
  )
}

function ModelsStats({
  range,
  stats,
}: {
  range: StatsRangeId
  stats: StatusStatsData['ranges'][StatsRangeId]
}) {
  const label = STATS_RANGES.find((entry) => entry.id === range)?.label ?? range
  if (stats.models.length === 0)
    return <Text dimColor>No model usage recorded in this range ({label})</Text>
  const barWidth = 20
  return (
    <Box flexDirection="column" minHeight={7}>
      {stats.models.map((entry) => {
        const filled = Math.max(1, Math.round(entry.share * barWidth))
        return (
          <Box key={entry.model}>
            <Box width={28}>
              <Text wrap="truncate-end">{entry.model}</Text>
            </Box>
            <Box width={10}>
              <Text color={STATS_VALUE_COLOR}>{formatCompactCount(entry.tokens)}</Text>
            </Box>
            <Text color={STATS_VALUE_COLOR}>{'█'.repeat(filled)}</Text>
            <Text dimColor>{'░'.repeat(barWidth - filled)}</Text>
            <Text dimColor> {Math.round(entry.share * 100)}%</Text>
          </Box>
        )
      })}
    </Box>
  )
}
