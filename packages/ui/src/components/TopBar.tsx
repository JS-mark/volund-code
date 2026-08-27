import { basename } from 'node:path'

import { productIdentity } from '@volund/shared'
import { Box, Text } from 'ink'

import { welcomeTheme } from './welcome/welcomeTheme'

export interface TopBarProps {
  cwd: string
  sessionId: string
  status: string
}

export function TopBar({ cwd, sessionId, status }: TopBarProps) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box justifyContent="space-between">
        <Text>
          <Text bold color={welcomeTheme.brandAccent}>
            {productIdentity.shortName}
          </Text>{' '}
          <Text color="gray">{productIdentity.category}</Text>
        </Text>
        <Text color="gray">
          {shortSessionId(sessionId)} | {basename(cwd) || cwd}
        </Text>
      </Box>
      <Box justifyContent="space-between">
        <Text color="gray">{cwd}</Text>
        <Text color={statusColor(status)}>{status}</Text>
      </Box>
    </Box>
  )
}

function shortSessionId(sessionId: string) {
  if (sessionId.length <= 12) return sessionId
  return sessionId.slice(0, 12)
}

function statusColor(status: string) {
  if (status.includes('error')) return 'red'
  if (status.includes('permission') || status.includes('aborted')) return 'yellow'
  if (status.includes('streaming') || status.startsWith('running ')) return 'cyan'
  return 'gray'
}
