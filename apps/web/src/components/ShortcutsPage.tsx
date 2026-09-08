'use client'

import { Table, Typography } from 'antd'

/** 快捷键页（W-16）：只列 Web 端真实存在的键位，不放占位。 */
export function ShortcutsPage() {
  const rows = [
    { key: '1', keys: 'Enter', action: '发送消息' },
    { key: '2', keys: 'Shift + Enter', action: '换行' },
    { key: '3', keys: 'Cmd/Ctrl + V', action: '粘贴剪贴板图片为附件' },
    { key: '4', keys: '拖拽图片到输入框', action: '添加图片附件' },
    { key: '5', keys: 'Esc', action: '关闭打开的下拉菜单' },
    { key: '6', keys: 'Cmd + J', action: '打开工作台并聚焦终端' },
    { key: '7', keys: 'Cmd + B', action: '收起/展开会话侧栏' },
    { key: '8', keys: 'Cmd + ,', action: '打开设置' },
  ]
  return (
    <section style={{ padding: 24, overflow: 'auto' }}>
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        快捷键
      </Typography.Title>
      <Table
        size="small"
        pagination={false}
        dataSource={rows}
        columns={[
          {
            dataIndex: 'keys',
            key: 'keys',
            width: 220,
            render: (v: string) => <Typography.Text code>{v}</Typography.Text>,
          },
          { dataIndex: 'action', key: 'action' },
        ]}
      />
    </section>
  )
}
