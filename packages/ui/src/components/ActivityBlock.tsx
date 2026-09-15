import { Box, Text } from 'ink'

import { activityVerbs, formatActivityDuration, type ActivityItem } from '../activity'

export interface ActivityBlockProps {
  item: ActivityItem
  /** 会话 cwd：目标路径命中前缀时显示相对路径，活动行保持短扫读。 */
  cwd?: string
}

/**
 * 工具活动行（截图风格）：`◆ 正在读取 path/to/file` —— 菱形标记列与
 * MessageBlock 的角色标记列同宽对齐；目标值绿色高亮，完成后整行压暗并附
 * 耗时/行级变更，失败转红。
 */
export function ActivityBlock({ item, cwd }: ActivityBlockProps) {
  const verbs = activityVerbs(item.tool)
  const verb =
    item.status === 'running' ? verbs.running : item.status === 'error' ? verbs.error : verbs.done
  const target = item.target && cwd ? relativize(item.target, cwd) : item.target
  const suffix = activitySuffix(item)
  const dim = item.status === 'done'
  const markerColor = item.status === 'error' ? 'red' : 'gray'
  const verbColor = item.status === 'error' ? 'red' : dim ? 'gray' : undefined
  return (
    <Box>
      <Box flexShrink={0} width={2}>
        <Text color={markerColor} dimColor={dim}>
          ◆
        </Text>
      </Box>
      <Text wrap="truncate">
        <Text
          bold={item.status === 'running'}
          dimColor={dim}
          {...(verbColor ? { color: verbColor } : {})}
        >
          {verb}
          {target ? ' ' : ''}
        </Text>
        {target ? (
          <Text color="green" dimColor={dim}>
            {target}
          </Text>
        ) : null}
        {suffix ? (
          <Text color={item.status === 'error' ? 'red' : 'gray'} dimColor={dim}>
            {suffix}
          </Text>
        ) : null}
      </Text>
    </Box>
  )
}

function activitySuffix(item: ActivityItem): string {
  const parts: string[] = []
  if (item.status !== 'running' && item.durationMs !== undefined)
    parts.push(formatActivityDuration(item.durationMs))
  if (item.status === 'done' && (item.linesAdded || item.linesRemoved))
    parts.push(`+${item.linesAdded ?? 0} −${item.linesRemoved ?? 0}`)
  if (item.status === 'error' && item.blocked) parts.push('已被拦截')
  return parts.length ? ` · ${parts.join(' · ')}` : ''
}

function relativize(target: string, cwd: string): string {
  const prefix = cwd.endsWith('/') ? cwd : `${cwd}/`
  return target.startsWith(prefix) ? target.slice(prefix.length) : target
}
