import { Box, Text } from 'ink'

import type { TranscriptEntry } from '../app'
import { collapseSkillInvocation } from '../skills-panel'
import { MarkdownText } from './MarkdownText'

export interface MessageBlockProps {
  entry: TranscriptEntry
}

/**
 * Label-free transcript rendering: a role marker column plus a hanging indent,
 * in the style of modern agent TUIs. `>` echoes user input (matching the input
 * prompt glyph), `⏺` marks assistant output, `·` marks system notes — no
 * YOU/VOLUND headers or boxes.
 *
 * §S3.3a：`/skill-name` 一次性调用的用户消息是 `<skill>` 全文（模型需要），
 * transcript 里折叠成一行摘要 + 行数提示，不刷屏。
 */
export function MessageBlock({ entry }: MessageBlockProps) {
  const marker = roleMarker(entry.role)
  const collapsed = entry.role === 'user' ? collapseSkillInvocation(entry.text) : undefined
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Box flexShrink={0} width={2}>
          <Text bold={entry.role === 'assistant'} color={marker.color}>
            {marker.glyph}
          </Text>
        </Box>
        <Box flexDirection="column" flexGrow={1}>
          {collapsed ? (
            <Box flexDirection="column">
              <Text color="green" wrap="truncate">
                skill {collapsed.name} invoked{collapsed.task ? ` · ${collapsed.task}` : ''}
              </Text>
              <Text color="gray">
                ({collapsed.lines} lines of skill instructions attached; sent to the model in full)
              </Text>
            </Box>
          ) : entry.role === 'assistant' ? (
            <MarkdownText>{entry.text}</MarkdownText>
          ) : (
            <Text color="gray" wrap="wrap">
              {entry.text}
            </Text>
          )}
          {entry.role === 'assistant' && entry.truncated ? (
            <Box flexDirection="column">
              <Text color="yellow">[truncated: max_tokens reached]</Text>
              <Text color="gray">输入 continue 可继续</Text>
            </Box>
          ) : null}
        </Box>
      </Box>
    </Box>
  )
}

function roleMarker(role: TranscriptEntry['role']): { color: string; glyph: string } {
  if (role === 'assistant') return { color: 'cyan', glyph: '⏺' }
  if (role === 'user') return { color: 'green', glyph: '>' }
  return { color: 'gray', glyph: '·' }
}
