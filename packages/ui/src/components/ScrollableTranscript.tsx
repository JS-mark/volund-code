import { Box, Text } from 'ink'

import type { TimelineItem } from '../activity'
import { ActivityBlock } from './ActivityBlock'
import { MessageBlock } from './MessageBlock'

export interface ScrollableTranscriptProps {
  /** 时间线条目（消息 + 工具活动），由 buildTimeline 按事件 id 归并。 */
  items: readonly TimelineItem[]
  /** 活动行路径相对化用的会话 cwd。 */
  cwd?: string
  maxItems?: number
}

export function ScrollableTranscript({ items, cwd, maxItems = 16 }: ScrollableTranscriptProps) {
  const visibleItems = items.slice(-maxItems)
  return (
    <Box flexDirection="column" minHeight={1} marginBottom={1}>
      {visibleItems.length === 0 ? (
        <Box borderColor="gray" borderStyle="single" paddingX={1}>
          <Text color="gray">Ready. Start with a message or /help.</Text>
        </Box>
      ) : (
        visibleItems.map((item) =>
          item.kind === 'message' ? (
            <MessageBlock entry={item.entry} key={item.entry.id} />
          ) : (
            <ActivityBlock item={item.item} key={item.item.id} {...(cwd ? { cwd } : {})} />
          ),
        )
      )}
    </Box>
  )
}
