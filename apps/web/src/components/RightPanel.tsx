'use client'

import { Button, Descriptions, Tag, Typography } from 'antd'
import { useEffect, useState } from 'react'

import type { Bootstrap, WebApi } from '../lib/api'

/** 右侧栏（连接/会话信息，真实数据源；不含伪终端）。 */
export function RightPanel({
  api,
  bootstrap,
  sessionId,
  sessionTitle,
  connected,
  onClose,
}: {
  api: WebApi
  bootstrap: Bootstrap
  sessionId: string | undefined
  sessionTitle: string | undefined
  connected: boolean
  onClose(): void
}) {
  const [permissionMode, setPermissionMode] = useState<string>()
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (bootstrap.capabilities.permissionMode === true)
      void api
        .permissionMode()
        .then((result) => setPermissionMode(result.mode))
        .catch(() => {})
  }, [api, bootstrap.capabilities.permissionMode])

  const url = window.location.origin
  return (
    <aside
      style={{
        width: 300,
        flexShrink: 0,
        borderLeft: '1px solid var(--ant-color-border-secondary, #e2e6ec)',
        padding: 16,
        overflowY: 'auto',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Typography.Text strong>连接</Typography.Text>
        <Button size="small" type="text" onClick={onClose}>
          收起
        </Button>
      </div>
      <Descriptions
        size="small"
        column={1}
        style={{ marginTop: 12 }}
        items={[
          {
            key: 'status',
            label: '状态',
            children: connected ? <Tag color="success">已连接</Tag> : <Tag>连接中</Tag>,
          },
          { key: 'version', label: '版本', children: `v${bootstrap.server.version}` },
          {
            key: 'url',
            label: '地址',
            children: (
              <>
                <Typography.Text code style={{ fontSize: 11 }}>
                  {url}
                </Typography.Text>
                <Button
                  size="small"
                  type="link"
                  onClick={() => {
                    void navigator.clipboard.writeText(url).then(() => {
                      setCopied(true)
                      setTimeout(() => setCopied(false), 1500)
                    })
                  }}
                >
                  {copied ? '已复制' : '复制'}
                </Button>
              </>
            ),
          },
          {
            key: 'cwd',
            label: '工作区',
            children: (
              <Typography.Text style={{ fontSize: 12, wordBreak: 'break-all' }}>
                {bootstrap.workspace.cwd}
              </Typography.Text>
            ),
          },
          {
            key: 'session',
            label: '会话',
            children: sessionTitle ?? sessionId?.slice(0, 8) ?? '未开始',
          },
          ...(permissionMode !== undefined
            ? [
                {
                  key: 'permission',
                  label: '权限模式',
                  children:
                    permissionMode === 'ask' ? '询问' : permissionMode === 'auto' ? '自动' : '放行',
                },
              ]
            : []),
        ]}
      />
    </aside>
  )
}
