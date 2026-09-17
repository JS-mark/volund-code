import { Tag } from 'antd'

import type { PermissionLineage } from '../lib/chat'

/**
 * §2.7bis.5 U4 / §22 W-07 审批归属徽标：子代理会话的权限请求显示
 * 「子代理 · <agentType>」（agentType 缺省时只显示「子代理」）；
 * 主代理请求（无 lineage）不渲染——与 TUI/Web 同语义。
 */
export function PermissionLineageBadge({ lineage }: { lineage: PermissionLineage | undefined }) {
  if (!lineage) return null
  return <Tag color="magenta">{`子代理${lineage.agentType ? ` · ${lineage.agentType}` : ''}`}</Tag>
}
