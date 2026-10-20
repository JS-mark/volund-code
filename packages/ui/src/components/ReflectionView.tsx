import { Box, Text } from 'ink'

import type { StatusReflectionData } from '../status'
import { formatCompactCount } from '../status'

export interface ReflectionViewProps {
  reflection?: StatusReflectionData
}

/** /status → Reflection（§21）：触发面、预算与最近一次反思的快照。 */
export function ReflectionView({ reflection }: ReflectionViewProps) {
  if (!reflection)
    return (
      <Box flexDirection="column" minHeight={7}>
        <Text bold>Reflection</Text>
        <Text dimColor>Reflection is not assembled in this session</Text>
      </Box>
    )
  const triggers = [
    ...(reflection.triggers.onError ? ['on_error'] : []),
    ...(reflection.triggers.onCompact ? ['on_compact'] : []),
    ...(reflection.triggers.everyNTurns > 0
      ? [`every_${reflection.triggers.everyNTurns}_turns`]
      : []),
    'manual',
  ]
  const rows: readonly { label: string; value: string }[] = [
    { label: 'Enabled:', value: reflection.enabled ? 'yes' : 'no (/reflect on to enable)' },
    { label: 'Triggers:', value: triggers.join(', ') },
    { label: 'Cooldown:', value: `${reflection.cooldownSeconds}s` },
    {
      label: 'Token budget:',
      value:
        `${formatCompactCount(reflection.budget.usedTokens)} used / ` +
        `${formatCompactCount(reflection.budget.totalTokens)} total`,
    },
    { label: 'Lessons:', value: `${reflection.lessonCount} in this session (/reflect list)` },
    {
      label: 'Last run:',
      value: reflection.lastRun
        ? `${reflection.lastRun.trigger} · ${reflection.lastRun.lessonCount} lesson(s) · ${reflection.lastRun.durationMs}ms`
        : 'n/a',
    },
    { label: 'State:', value: reflection.running ? 'reflecting…' : 'idle' },
  ]
  return (
    <Box flexDirection="column" minHeight={7}>
      <Text bold>Reflection</Text>
      <Box marginTop={1} flexDirection="column">
        {rows.map((row) => (
          <Box key={row.label}>
            <Box width={16}>
              <Text dimColor>{row.label}</Text>
            </Box>
            <Text wrap="truncate-end">{row.value}</Text>
          </Box>
        ))}
      </Box>
    </Box>
  )
}
