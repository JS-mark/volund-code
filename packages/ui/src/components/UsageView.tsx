import { Box, Text } from 'ink'

import type { StatusUsageData } from '../status'
import { formatCompactCount, formatCostUSD, formatDurationMs } from '../status'

export interface UsageViewProps {
  usage?: StatusUsageData
}

/** /status → Usage：当前会话的成本、耗时、代码变更与 token 用量。 */
export function UsageView({ usage }: UsageViewProps) {
  if (!usage)
    return (
      <Box flexDirection="column" minHeight={7}>
        <Text bold>Session</Text>
        <Text dimColor>Usage data is not available in this session</Text>
      </Box>
    )
  const rows: readonly { label: string; value: string }[] = [
    { label: 'Total cost:', value: formatCostUSD(usage.costUSD) },
    { label: 'Total duration (API):', value: formatDurationMs(usage.apiDurationMs) },
    { label: 'Total duration (wall):', value: formatDurationMs(usage.wallDurationMs) },
    {
      label: 'Total code changes:',
      value: `${usage.linesAdded} lines added, ${usage.linesRemoved} lines removed`,
    },
    {
      label: 'Usage:',
      value:
        `${formatCompactCount(usage.tokens.input)} input, ` +
        `${formatCompactCount(usage.tokens.output)} output, ` +
        `${formatCompactCount(usage.tokens.cacheRead)} cache read, ` +
        `${formatCompactCount(usage.tokens.cacheWrite)} cache write`,
    },
  ]
  return (
    <Box flexDirection="column" minHeight={7}>
      <Text bold>Session</Text>
      <Box marginTop={1} flexDirection="column">
        {rows.map((row) => (
          <Box key={row.label}>
            <Box width={24}>
              <Text dimColor>{row.label}</Text>
            </Box>
            <Text wrap="truncate-end">{row.value}</Text>
          </Box>
        ))}
      </Box>
    </Box>
  )
}
