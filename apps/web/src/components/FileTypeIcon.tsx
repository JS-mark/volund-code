'use client'

/** 文件类型徽章(antd Tree 节点图标位;未命中类型返回 null,走 antd 默认文件图标)。 */
import { fileTypeBadge } from '../lib/file-type-icons'

export function FileTypeIcon({ name }: { name: string }) {
  const badge = fileTypeBadge(name)
  if (!badge) return null
  return (
    <span
      className="ft-icon"
      style={{ color: badge.color, background: `${badge.color}1f` }}
      aria-hidden
    >
      {badge.label}
    </span>
  )
}
