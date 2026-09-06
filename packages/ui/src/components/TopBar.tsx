import { basename } from 'node:path'

import { productIdentity } from '@volund/shared'
import { Box, Text } from 'ink'

import { welcomeTheme } from './welcome/welcomeTheme'

export interface TopBarProps {
  cwd: string
  sessionId: string
}

export function TopBar({ cwd, sessionId }: TopBarProps) {
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
      {/* status 只由输入框上方的 StatusLine 展示（含 error）——这里再渲染一遍，
          长错误文案会在顶栏折行成一大块重复红字。 */}
      <Text color="gray">{cwd}</Text>
    </Box>
  )
}

function shortSessionId(sessionId: string) {
  if (sessionId.length <= 12) return sessionId
  return sessionId.slice(0, 12)
}
