'use client'

/** 按名快开(⌘P):输入防抖 200ms 走 workbench findFiles,回车/点击打开。 */
import { FileOutlined, SearchOutlined } from '@ant-design/icons'
import { Input, Modal, Spin, Typography } from 'antd'
import { useEffect, useState } from 'react'

import type { WebApi } from '../lib/api'

export function QuickOpenModal({
  api,
  onOpenFile,
  onClose,
}: {
  api: WebApi
  onOpenFile(path: string): void
  onClose(): void
}) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<{ path: string; name: string }[]>([])
  const [searching, setSearching] = useState(false)

  useEffect(() => {
    const needle = query.trim()
    if (!needle) {
      setResults([])
      return
    }
    setSearching(true)
    const timer = setTimeout(() => {
      void api
        .wbFindFiles(needle)
        .then((result) => setResults(result.results))
        .catch(() => setResults([]))
        .finally(() => setSearching(false))
    }, 200)
    return () => clearTimeout(timer)
  }, [api, query])

  return (
    <Modal title="打开文件" open footer={null} onCancel={onClose} destroyOnHidden>
      <Input
        autoFocus
        allowClear
        prefix={<SearchOutlined />}
        placeholder="输入文件名或路径片段"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <div style={{ marginTop: 8, maxHeight: 320, overflowY: 'auto' }}>
        {searching && <Spin size="small" style={{ display: 'block', margin: '12px auto' }} />}
        {!searching && query.trim() && results.length === 0 && (
          <Typography.Text type="secondary" style={{ display: 'block', padding: '8px 2px' }}>
            没有匹配的文件
          </Typography.Text>
        )}
        {results.map((item) => (
          <div
            key={item.path}
            className="wb-quick-item"
            onClick={() => {
              onOpenFile(item.path)
              onClose()
            }}
          >
            <FileOutlined style={{ marginRight: 8 }} />
            <Typography.Text ellipsis style={{ flex: 1, minWidth: 0 }}>
              {item.path}
            </Typography.Text>
          </div>
        ))}
      </div>
    </Modal>
  )
}
