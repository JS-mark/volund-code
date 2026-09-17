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

interface ChangeDiff {
  path: string
  tracked: boolean
  created: boolean
  beforeAvailable: boolean
  deleted: boolean
  truncated?: boolean
  diff: string
  linesAdded: number
  linesRemoved: number
}

/** unified diff 行 → 着色 class（与 WorkbenchPanel 的 git diff 视图同规则）。 */
function diffLineClass(line: string): string | undefined {
  if (line.startsWith('@@')) return 'wb-diff-hunk'
  if (line.startsWith('+')) return 'wb-diff-add'
  if (line.startsWith('-')) return 'wb-diff-del'
  return undefined
}

/** W-08「大 diff 虚拟化」：弹窗首屏渲染上限（其余以计数收口）。 */
const DIFF_RENDER_MAX_LINES = 2000

/**
 * 会话变更聚合 + undo + 单文件 diff（§22 W-08）：聊天流底部与「变更」页共用。
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
  const [diffOf, setDiffOf] = useState<string>()
  const [diff, setDiff] = useState<ChangeDiff>()
  const [fileUndoOf, setFileUndoOf] = useState<string>()
  const [fileUndoPreview, setFileUndoPreview] = useState<UndoPreview>()

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

  // 关闭 diff 弹窗时不立刻清 diff 内容，避免收帧闪烁；下次打开时覆盖。
  useEffect(() => {
    if (diffOf === undefined) {
      setDiff(undefined)
      return
    }
    setDiff(undefined)
    void api
      .changesDiff(diffOf)
      .then(setDiff)
      .catch(() => setDiff(undefined))
  }, [api, diffOf])

  const openUndo = useCallback(async () => {
    setUndoPreview(await api.undoPreview().catch(() => undefined))
    setModalOpen(true)
  }, [api])

  const openFileUndo = useCallback(
    async (path: string) => {
      setFileUndoPreview(await api.changesUndoPreview(path).catch(() => undefined))
      setFileUndoOf(path)
    },
    [api],
  )

  const runFileUndo = useCallback(async () => {
    if (fileUndoOf === undefined) return
    try {
      await api.changesUndo(fileUndoOf)
      setFileUndoOf(undefined)
      setFileUndoPreview(undefined)
      reload()
    } catch {
      // 失败信息经 Modal 关闭即可；错误留在 console
    }
  }, [api, fileUndoOf, reload])

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
            <List.Item
              style={{ padding: '4px 0', cursor: 'pointer' }}
              onClick={() => setDiffOf(row.path)}
              actions={[
                <Button
                  key="undo-file"
                  danger
                  disabled={row.allConsumed}
                  onClick={(event) => {
                    event.stopPropagation()
                    void openFileUndo(row.path)
                  }}
                  size="small"
                  type="text"
                >
                  撤销批次
                </Button>,
              ]}
            >
              <Typography.Text code={false}>
                <Tag color={row.created ? 'success' : 'default'}>
                  {row.created ? '新建' : '修改'}
                </Tag>
                {row.path}
              </Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {row.batches} 批 · {row.allConsumed ? '已撤销' : row.lastModifiedAt} · 点击查看 diff
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
      <Modal
        open={fileUndoOf !== undefined}
        title={`撤销 ${fileUndoOf} 的最近批次`}
        okText="确认撤销"
        okButtonProps={{ danger: true, disabled: !fileUndoPreview?.undoable }}
        cancelText="取消"
        onOk={() => void runFileUndo()}
        onCancel={() => {
          setFileUndoOf(undefined)
          setFileUndoPreview(undefined)
        }}
      >
        {fileUndoPreview === undefined ? (
          <Typography.Text type="secondary">加载中…</Typography.Text>
        ) : fileUndoPreview.undoable ? (
          <>
            <Typography.Text>
              将撤销以下 <strong>{fileUndoPreview.paths.length}</strong> 个文件的最近批次：
            </Typography.Text>
            <List
              size="small"
              dataSource={fileUndoPreview.paths}
              renderItem={(path) => (
                <List.Item style={{ padding: '2px 0' }}>
                  <Typography.Text type="secondary">{path}</Typography.Text>
                </List.Item>
              )}
            />
            {fileUndoPreview.paths.length > 1 ? (
              <Alert
                type="info"
                showIcon
                style={{ marginTop: 8 }}
                title="该批次是一次工具调用产生的多个文件，将一并撤销。"
              />
            ) : null}
            {fileUndoPreview.warnings.map((warning) => (
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
      <Modal
        open={diffOf !== undefined}
        title={diffOf}
        footer={null}
        width="min(920px, 92vw)"
        onCancel={() => setDiffOf(undefined)}
      >
        {diff === undefined ? (
          <Typography.Text type="secondary">加载 diff…</Typography.Text>
        ) : !diff.tracked ? (
          <Empty description="该路径没有本会话的备份记录" />
        ) : diff.truncated ? (
          <Empty description="文件过大，净效果 diff 不做全量渲染（可直接撤销批次）" />
        ) : diff.diff.trim() === '' ? (
          <Empty
            description={
              diff.created ? '会话新建的文件（当前无净变化）' : '与备份起点无差异（可能已撤销）'
            }
          />
        ) : (
          <>
            {!diff.beforeAvailable ? (
              <Alert
                type="warning"
                showIcon
                style={{ marginBottom: 8 }}
                title="备份起点快照缺失，diff 从空文件起算"
              />
            ) : null}
            {diff.deleted ? (
              <Alert
                type="warning"
                showIcon
                style={{ marginBottom: 8 }}
                title="文件已在本会话内删除"
              />
            ) : null}
            {(() => {
              // W-08 大 diff 虚拟化：首屏只渲染上限行，其余以计数收口。
              const allLines = diff.diff.split('\n')
              const visible = allLines.slice(0, DIFF_RENDER_MAX_LINES)
              const hiddenCount = allLines.length - visible.length
              return (
                <>
                  <pre className="wb-diff" style={{ maxHeight: '60vh' }}>
                    {visible.map((line, index) => (
                      <div className={diffLineClass(line)} key={index}>
                        {line === '' ? ' ' : line}
                      </div>
                    ))}
                  </pre>
                  {hiddenCount > 0 ? (
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      已省略其余 {hiddenCount} 行（合计 +{diff.linesAdded} −{diff.linesRemoved}）
                    </Typography.Text>
                  ) : null}
                </>
              )
            })()}
          </>
        )}
      </Modal>
    </div>
  )
}
