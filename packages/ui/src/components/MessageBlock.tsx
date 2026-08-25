import { Box, Text } from 'ink'

import type { TranscriptEntry } from '../app'
import { MarkdownText } from './MarkdownText'

export interface MessageBlockProps {
  entry: TranscriptEntry
}

/**
 * Label-free transcript rendering: a role marker column plus a hanging indent,
 * in the style of modern agent TUIs. `>` echoes user input (matching the input
 * prompt glyph), `⏺` marks assistant output, `·` marks system notes — no
 * YOU/APOLLO headers or boxes.
 */
export function MessageBlock({ entry }: MessageBlockProps) {
  const marker = roleMarker(entry.role)
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Box flexShrink={0} width={2}>
          <Text bold={entry.role === 'assistant'} color={marker.color}>
            {marker.glyph}
          </Text>
        </Box>
        <Box flexDirection="column" flexGrow={1}>
          {entry.role === 'assistant' ? (
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
