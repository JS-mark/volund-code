import { Box, Text } from 'ink'
import type { PropsWithChildren } from 'react'

export type StatusLevel = 'active' | 'error' | 'muted' | 'warning' | 'info'

export interface StatusLineProps extends PropsWithChildren {
  level?: StatusLevel
}

export function StatusLine({ children, level = 'muted' }: StatusLineProps) {
  return (
    <Box marginBottom={1}>
      <Text color={statusColor(level)}>
        {statusIcon(level)} {children}
      </Text>
    </Box>
  )
}

function statusColor(level: StatusLevel) {
  if (level === 'active') return 'cyan'
  if (level === 'error') return 'red'
  if (level === 'warning') return 'yellow'
  return 'gray'
}

function statusIcon(level: StatusLevel) {
  if (level === 'active') return '*'
  if (level === 'error') return '!'
  if (level === 'warning') return '!'
  return '-'
}
