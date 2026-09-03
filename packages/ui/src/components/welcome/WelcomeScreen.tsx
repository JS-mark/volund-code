import { Box, Text } from 'ink'

import type { WelcomeScreenProps } from './types'
import { VolundLogo } from './VolundLogo'
import { getWelcomeLayout, validDimension } from './welcomeLayout'
import { WelcomeStatusBar } from './WelcomeStatusBar'
import { colorForTone, welcomeTheme } from './welcomeTheme'

// 只写 InputBox/REPL 真实支持的按键（InputBox.tsx：/ 建议、Tab 补全、
// Shift+Enter 换行、Ctrl+C 退出；/resume 由会话端口提供）。
const TIPS = [
  'Press / to use commands, Tab to autocomplete.',
  'Shift + Enter to add a new line, Ctrl + C to exit.',
  '/resume to continue a previous session, /help for all commands.',
] as const

export function WelcomeScreen({
  bottomStatus,
  commandInput,
  state,
  terminalSize,
}: WelcomeScreenProps) {
  const layout = getWelcomeLayout(terminalSize)
  // ink 没有边框标题：手绘顶边 ╭─ Title ───╮（宽度 = 终端列数），盒体只画左右下三边。
  const columns = validDimension(terminalSize.columns, 90)
  const title = ` ${state.app.name} v${state.app.version} `
  const topBorder = `╭─${title}${'─'.repeat(Math.max(0, columns - title.length - 3))}╮`
  return (
    <Box flexDirection="column">
      <Box flexDirection="column" marginTop={1}>
        <Text color={welcomeTheme.border}>{topBorder}</Text>
        <Box
          borderColor={welcomeTheme.border}
          borderStyle="round"
          borderTop={false}
          flexDirection="column"
          paddingX={layout === 'full' ? 2 : 1}
          paddingY={layout === 'minimal' ? 0 : 1}
        >
          <Box alignItems="center" flexDirection="row">
            <VolundLogo />
            <Box flexDirection="column" flexGrow={1}>
              {layout === 'minimal' ? null : (
                <>
                  <Text color={welcomeTheme.brandAccent}>Tips for getting started</Text>
                  {TIPS.map((tip) => (
                    <Text key={tip} wrap="truncate-end">
                      {tip}
                    </Text>
                  ))}
                  <Divider />
                  <Text color={welcomeTheme.brandAccent}>Native modules</Text>
                  {state.native.map((module) => (
                    <Text key={module.label} wrap="truncate-end">
                      {`${module.label} `}
                      <Text color={colorForTone(module.tone)}>{module.state}</Text>
                    </Text>
                  ))}
                  <Divider />
                </>
              )}
              <Text color={welcomeTheme.brandAccent} wrap="truncate-end">
                {state.provider.label}
              </Text>
              <Text wrap="truncate-end">
                <Text color="gray">{state.workspace.displayCwd}</Text>
                <Text color={colorForTone(state.workspace.trustTone)}>
                  {` · ${state.workspace.trustLabel}`}
                </Text>
              </Text>
              <Text color="gray" wrap="truncate-end">
                {`${state.session.label} · permission `}
                <Text color={colorForTone(state.permission.tone)}>{state.permission.label}</Text>
              </Text>
            </Box>
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

function Divider() {
  return (
    <Box
      borderBottom
      borderColor="gray"
      borderLeft={false}
      borderRight={false}
      borderStyle="single"
      borderTop={false}
    />
  )
}
