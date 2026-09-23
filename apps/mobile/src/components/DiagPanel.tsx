import { ClearOutlined, CopyOutlined } from '@ant-design/icons'
/**
 * 诊断日志面板（「我的」页底部）：把 diag 环形缓冲可视化——手机上没有
 * devtools，远程问题靠这里把最近 300 条连接/水合/turn 事件复制给维护者。
 */
import { Button, List, Typography } from 'antd'
import { useEffect, useState } from 'react'

import { diagClear, diagDump, diagEntries } from '../lib/diag'

export function DiagPanel() {
  const [tick, setTick] = useState(0)
  const [copied, setCopied] = useState(false)
  // 面板打开时轻量轮询刷新（诊断是被动观测面，2s 粒度足够）。
  useEffect(() => {
    const timer = setInterval(() => setTick((value) => value + 1), 2_000)
    return () => clearInterval(timer)
  }, [])
  void tick
  const entries = diagEntries()
  const dump = diagDump()

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(dump)
      setCopied(true)
      setTimeout(() => setCopied(false), 1_500)
    } catch {
      // 剪贴板权限被拒：退化为让用户手动选择文本复制（面板本身就是全文展示）。
    }
  }

  return (
    <div style={{ marginTop: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Typography.Text type="secondary">诊断日志（最近 {entries.length} 条）</Typography.Text>
        <Button size="small" icon={<CopyOutlined />} onClick={() => void copy()}>
          {copied ? '已复制' : '复制全部'}
        </Button>
        <Button size="small" icon={<ClearOutlined />} onClick={() => diagClear()}>
          清空
        </Button>
      </div>
      <List
        size="small"
        dataSource={entries.slice(-30).reverse()}
        locale={{ emptyText: '暂无日志' }}
        renderItem={(entry) => (
          <List.Item style={{ padding: '2px 0' }}>
            <Typography.Text style={{ fontSize: 11 }} code>
              {new Date(entry.t).toLocaleTimeString()} [{entry.tag}] {entry.message}
            </Typography.Text>
          </List.Item>
        )}
      />
    </div>
  )
}
