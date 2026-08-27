import { productIdentity } from '@volund/shared'
import { Box, Text } from 'ink'

import { FirstRunChecks } from './FirstRunChecks'
import type { WelcomeScreenProps } from './types'
import { VolundLogo } from './VolundLogo'
import { getWelcomeLayout } from './welcomeLayout'
import { WelcomeStatusBar } from './WelcomeStatusBar'
import { WelcomeStatusGrid } from './WelcomeStatusGrid'
import { welcomeTheme } from './welcomeTheme'

export function WelcomeScreen({
  bottomStatus,
  commandInput,
  state,
  terminalSize,
}: WelcomeScreenProps) {
  const layout = getWelcomeLayout(terminalSize)
  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between" paddingX={1}>
        <Text color={welcomeTheme.brandAccent} bold>
          {productIdentity.commandName}
        </Text>
        <Text color="gray">TERMINAL WELCOME / {layout.toUpperCase()}</Text>
      </Box>
      <Box
        borderColor={welcomeTheme.border}
        borderStyle="round"
        flexDirection="column"
        marginTop={1}
        paddingX={layout === 'full' ? 2 : 1}
        paddingY={layout === 'minimal' ? 0 : 1}
      >
        <Box
          alignItems={layout === 'full' ? 'center' : undefined}
          flexDirection={layout === 'full' ? 'row' : 'column'}
        >
          <VolundLogo />
          <Box flexDirection="column" flexGrow={1}>
            <Box>
              <Text bold>{state.app.name} </Text>
              <Text color="gray"> v{state.app.version}</Text>
            </Box>
            {layout === 'minimal' ? null : <Text color="gray">Local TUI session ready</Text>}
            <Box marginTop={layout === 'minimal' ? 0 : 1}>
              <WelcomeStatusGrid layout={layout} state={state} />
            </Box>
            <FirstRunChecks layout={layout} state={state} />
          </Box>
        </Box>
      </Box>
      <Box marginTop={1} paddingX={1}>
        {bottomStatus}
      </Box>
      <Box>{commandInput}</Box>
      <WelcomeStatusBar layout={layout} state={state} />
    </Box>
  )
}
