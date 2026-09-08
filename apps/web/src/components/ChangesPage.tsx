'use client'

import { Typography } from 'antd'

import type { WebApi } from '../lib/api'
import { ChangesPanel } from './ChangesPanel'

/** 变更页（§22 W-08 可观测入口）：活动会话的文件变更聚合 + undo。 */
export function ChangesPage({ api, sessionId }: { api: WebApi; sessionId: string | undefined }) {
  return (
    <section style={{ padding: 24, overflow: 'auto' }}>
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        变更
      </Typography.Title>
      <Typography.Paragraph type="secondary">
        活动会话的文件变更（BackupStore 背书，可逐批撤销）。
      </Typography.Paragraph>
      <ChangesPanel api={api} sessionId={sessionId} />
    </section>
  )
}
