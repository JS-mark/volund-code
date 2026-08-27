import { Box, Text } from 'ink'

import { welcomeTheme } from './welcomeTheme'

export const VOLUND_LOGO_WIDTH = 24

const mark = [
  ['volund-hammer-crown', '  ████████████████████  '],
  ['volund-hammer-head', '████████████████████████'],
  ['volund-screen-upper', '████                ████'],
  ['volund-terminal', '████     >_         ████'],
  ['volund-screen-lower', '████                ████'],
  ['volund-hammer-base', '  ████████████████████  '],
  ['volund-handle-upper', '          ████          '],
  ['volund-handle-lower', '          ████          '],
] as const

export function VolundLogo() {
  return (
    <Box flexDirection="column" flexShrink={0} marginRight={3} width={VOLUND_LOGO_WIDTH}>
      {mark.map(([id, line]) => (
        <Text bold color={welcomeTheme.brandAccent} key={id}>
          {line}
        </Text>
      ))}
    </Box>
  )
}
