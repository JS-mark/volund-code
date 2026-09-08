'use client'

import { Alert, Button, Card, Empty, List, Modal, Tag, Typography } from 'antd'
import { useCallback, useEffect, useState } from 'react'

import type { WebApi } from '../lib/api'

interface ChangeRow {
  path: string
  created: boolean
  batches: number
  lastModifiedAt: string
  allConsumed: boolean
}

interface UndoPreview {
  undoable: boolean
  reason?: string
  paths: string[]
  warnings: { path: string; kind: string }[]
  stepCreatedAt?: string
}

/**
 * 会话变更聚合 + undo（§22 W-08）：聊天流底部与「变更」页共用。
 * refreshKey 变化（如 turn 结束）时重新拉取；quietWhenEmpty 时无变更不占位。
 */
export function ChangesPanel({
  api,
  sessionId,
  refreshKey,
  quietWhenEmpty = false,
}: {
  api: WebApi
  sessionId: string | undefined
  refreshKey?: unknown
  quietWhenEmpty?: boolean
}) {
  const [changes, setChanges] = useState<ChangeRow[]>()
  const [undoPreview, setUndoPreview] = useState<UndoPreview>()
  const [modalOpen, setModalOpen] = useState(false)

  const reload = useCallback(() => {
    void api
      .changes()
      .then((snapshot) => setChanges(snapshot.paths))
      .catch(() => setChanges(undefined))
  }, [api])

  useEffect(() => {
    setUndoPreview(undefined)
    if (sessionId === undefined) {
      setChanges(undefined)
      return
    }
    reload()
  }, [api, sessionId, refreshKey, reload])

  const openUndo = useCallback(async () => {
    setUndoPreview(await api.undoPreview().catch(() => undefined))
    setModalOpen(true)
  }, [api])

  const runUndo = useCallback(async () => {
    try {
      await api.undo()
      setModalOpen(false)
      setUndoPreview(undefined)
      reload()
    } catch {
      // 失败信息经 Modal 内的 preview 关闭即可；错误留在 console
    }
  }, [api, reload])

  if (sessionId === undefined) {
    return quietWhenEmpty ? null : <Empty description="没有活动会话——先在对话页发一条消息" />
  }
  if (changes === undefined)
    return quietWhenEmpty ? null : <Typography.Text type="secondary">加载变更…</Typography.Text>
  if (changes.length === 0)
    return quietWhenEmpty ? null : <Empty description="本会话暂无文件变更" />

  return (
    <div style={{ margin: '8px 0' }}>
      <Card
        size="small"
        title={`本会话文件变更（${changes.length}）`}
        extra={
          <Button size="small" onClick={() => void openUndo()}>
            撤销上一批…
          </Button>
        }
      >
        <List
          size="small"
          dataSource={changes}
          renderItem={(row) => (
            <List.Item style={{ padding: '4px 0' }}>
              <Typography.Text code={false}>
                <Tag color={row.created ? 'success' : 'default'}>
                  {row.created ? '新建' : '修改'}
                </Tag>
                {row.path}
              </Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {row.batches} 批 · {row.allConsumed ? '已撤销' : row.lastModifiedAt}
              </Typography.Text>
            </List.Item>
          )}
        />
      </Card>
      <Modal
        open={modalOpen}
        title="撤销上一批变更"
        okText="确认撤销"
        okButtonProps={{ danger: true, disabled: !undoPreview?.undoable }}
        cancelText="取消"
        onOk={() => void runUndo()}
        onCancel={() => setModalOpen(false)}
      >
        {undoPreview === undefined ? (
          <Typography.Text type="secondary">加载中…</Typography.Text>
        ) : undoPreview.undoable ? (
          <>
            <Typography.Text>
              将撤销 <strong>{undoPreview.paths.length}</strong> 个文件的上一批变更：
            </Typography.Text>
            <List
              size="small"
              dataSource={undoPreview.paths}
              renderItem={(path) => (
                <List.Item style={{ padding: '2px 0' }}>
                  <Typography.Text type="secondary">{path}</Typography.Text>
                </List.Item>
              )}
            />
            {undoPreview.warnings.map((warning) => (
              <Alert
                key={warning.path}
                type="warning"
                showIcon
                style={{ marginTop: 8 }}
                title={
                  warning.kind === 'target_modified'
                    ? `${warning.path}: 备份后曾被外部修改，撤销可能覆盖手工改动`
                    : `${warning.path}: 备份对象缺失，该文件将跳过`
                }
              />
            ))}
          </>
        ) : (
          <Typography.Text type="secondary">没有可撤销的批次（no_backup）。</Typography.Text>
        )}
      </Modal>
    </div>
  )
}
