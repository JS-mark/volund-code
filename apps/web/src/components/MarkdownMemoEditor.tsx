'use client'

/**
 * Markdown 记忆编辑器（WEB-EXT-MANAGE-MARKET-r1 MG-02）：编辑 / 预览 / 分屏三模式
 * + 常用排版工具条。零新依赖——编辑区用 TextArea（等宽字体），预览复用 W-04 的
 * Markdown 渲染组件（不渲染原始 HTML，安全姿态与聊天一致）。monaco 单文件编辑
 * 列 V2（workbench 单例不可复用）。
 */
import { Button, Input, Segmented, Space, Tooltip, Typography } from 'antd'
import { useRef, useState } from 'react'

import { Markdown } from './Markdown'

type EditorMode = 'edit' | 'split' | 'preview'

/** 在光标处包裹选区（或插入模板）并归还焦点。 */
function wrapSelection(
  area: HTMLTextAreaElement,
  before: string,
  after = before,
  placeholder = '',
): string {
  const { selectionStart, selectionEnd, value } = area
  const selected = value.slice(selectionStart, selectionEnd) || placeholder
  const next = `${value.slice(0, selectionStart)}${before}${selected}${after}${value.slice(selectionEnd)}`
  requestAnimationFrame(() => {
    area.focus()
    area.setSelectionRange(
      selectionStart + before.length,
      selectionStart + before.length + selected.length,
    )
  })
  return next
}

function linePrefix(area: HTMLTextAreaElement, prefix: string): string {
  const { selectionStart, value } = area
  const lineStart = value.lastIndexOf('\n', selectionStart - 1) + 1
  return `${value.slice(0, lineStart)}${prefix}${value.slice(lineStart)}`
}

const MONO: React.CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  fontSize: 13,
}

export function MarkdownMemoEditor({
  value,
  onChange,
  minHeight = 220,
}: {
  value: string
  onChange: (next: string) => void
  minHeight?: number
}) {
  const [mode, setMode] = useState<EditorMode>('edit')
  const areaRef = useRef<React.ComponentRef<typeof Input.TextArea> | null>(null)
  const apply = (next: string) => {
    onChange(next)
  }
  const withArea = (fn: (area: HTMLTextAreaElement) => string) => {
    const area = areaRef.current?.nativeElement as HTMLTextAreaElement | null | undefined
    if (area) apply(fn(area))
  }
  const tools: {
    key: string
    label: string
    title: string
    run: (area: HTMLTextAreaElement) => string
  }[] = [
    { key: 'bold', label: 'B', title: '粗体', run: (a) => wrapSelection(a, '**', '**', '粗体') },
    { key: 'italic', label: 'I', title: '斜体', run: (a) => wrapSelection(a, '*', '*', '斜体') },
    {
      key: 'code',
      label: '</>',
      title: '行内代码',
      run: (a) => wrapSelection(a, '`', '`', 'code'),
    },
    {
      key: 'block',
      label: '```',
      title: '代码块',
      run: (a) => wrapSelection(a, '\n```\n', '\n```\n', 'code'),
    },
    {
      key: 'link',
      label: '🔗',
      title: '链接',
      run: (a) => wrapSelection(a, '[', '](https://)', '文字'),
    },
    { key: 'ul', label: '• List', title: '无序列表', run: (a) => linePrefix(a, '- ') },
    { key: 'ol', label: '1. List', title: '有序列表', run: (a) => linePrefix(a, '1. ') },
    { key: 'quote', label: '❝', title: '引用', run: (a) => linePrefix(a, '> ') },
  ]
  return (
    <div>
      <Space style={{ marginBottom: 8, display: 'flex', justifyContent: 'space-between' }}>
        <Space size={2} wrap>
          {mode !== 'preview' &&
            tools.map((tool) => (
              <Tooltip key={tool.key} title={tool.title}>
                <Button
                  size="small"
                  style={{ minWidth: 30, fontWeight: tool.key === 'bold' ? 700 : 400 }}
                  onClick={() => withArea(tool.run)}
                >
                  {tool.label}
                </Button>
              </Tooltip>
            ))}
        </Space>
        <Segmented
          size="small"
          value={mode}
          onChange={(next) => setMode(next as EditorMode)}
          options={[
            { value: 'edit', label: '编辑' },
            { value: 'split', label: '分屏' },
            { value: 'preview', label: '预览' },
          ]}
        />
      </Space>
      <div
        style={{
          display: mode === 'split' ? 'grid' : 'block',
          gridTemplateColumns: '1fr 1fr',
          gap: 12,
        }}
      >
        {mode !== 'preview' && (
          <Input.TextArea
            ref={areaRef}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            style={{ ...MONO, minHeight }}
            placeholder="支持 Markdown：**粗体**、`代码`、列表、引用…"
          />
        )}
        {mode !== 'edit' && (
          <div
            style={{
              border: '1px solid var(--ant-color-border-secondary, #e2e6ec)',
              borderRadius: 10,
              padding: '4px 12px',
              minHeight,
              overflow: 'auto',
            }}
          >
            {value.trim() ? (
              <Markdown text={value} />
            ) : (
              <Typography.Text type="secondary">（空）</Typography.Text>
            )}
          </div>
        )}
      </div>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {value.length} 字符
      </Typography.Text>
    </div>
  )
}
