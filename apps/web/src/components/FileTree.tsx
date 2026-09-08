'use client'

/**
 * 懒加载工作区文件树(工作台资源管理器与代码页共用):
 * 点目录展开/收起,点文件回调打开;refreshSignal 递增时重载根目录
 * (已展开的子树随之重置,重新展开即拿到最新列表)。
 */
import { App, Empty } from 'antd'
import type { DataNode } from 'antd/es/tree'
import Tree from 'antd/es/tree'
import { useEffect, useState } from 'react'

import type { WbEntry, WebApi } from '../lib/api'
import { fileTypeBadge } from '../lib/file-type-icons'
import { FileTypeIcon } from './FileTypeIcon'

const toNode = (entry: WbEntry): DataNode => ({
  key: entry.path,
  title: entry.name,
  isLeaf: entry.kind === 'file',
  // 文件节点挂类型徽章(命中映射时);未命中/目录走 antd 默认文件/文件夹图标。
  ...(entry.kind === 'file' && fileTypeBadge(entry.name)
    ? { icon: <FileTypeIcon name={entry.name} /> }
    : {}),
})

/** antd 懒加载树的标准回填:按 key 找父节点挂 children。 */
function updateTreeData(list: DataNode[], key: React.Key, children: DataNode[]): DataNode[] {
  return list.map((node) => {
    if (node.key === key) return { ...node, children }
    if (node.children) return { ...node, children: updateTreeData(node.children, key, children) }
    return node
  })
}

interface FileTreeProps {
  api: WebApi
  onOpenFile(path: string): void
  /** 递增触发根目录重载。 */
  refreshSignal?: number
  /** 当前打开的文件(高亮选中)。 */
  selectedPath?: string
}

export function FileTree(props: FileTreeProps) {
  const { api } = props
  const { message } = App.useApp()
  const [treeData, setTreeData] = useState<DataNode[]>([])

  useEffect(() => {
    void api
      .wbListDir()
      .then((result) => setTreeData(result.entries.map(toNode)))
      .catch((cause) => message.error(cause instanceof Error ? cause.message : String(cause)))
  }, [api, message, props.refreshSignal])

  const loadData = (node: DataNode): Promise<void> => {
    if (node.isLeaf) return Promise.resolve()
    return api
      .wbListDir(String(node.key))
      .then((result) => {
        setTreeData((current) => updateTreeData(current, node.key, result.entries.map(toNode)))
      })
      .catch((cause) => {
        message.error(cause instanceof Error ? cause.message : String(cause))
      })
  }

  if (treeData.length === 0) return <Empty description="工作区为空" style={{ marginTop: 32 }} />
  return (
    <Tree
      showIcon
      blockNode
      treeData={treeData}
      loadData={loadData}
      selectedKeys={props.selectedPath ? [props.selectedPath] : []}
      onSelect={(keys, info) => {
        const key = keys[0]
        // 目录点击只展开/收起,不触发打开(避免对目录发 readFile)。
        if (typeof key === 'string' && info.node.isLeaf) props.onOpenFile(key)
      }}
    />
  )
}
