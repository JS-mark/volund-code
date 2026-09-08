/**
 * Markdown 渲染（§22 W-04）：react-markdown 默认不渲染原始 HTML（无脚本面）；
 * 远程/本地图片一律降级为文本占位（禁止自动加载外部资源）；链接强制新窗口 noopener。
 */
import { Button, Typography } from 'antd'
import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <Button
      size="small"
      type="text"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        })
      }}
    >
      {copied ? '已复制' : '复制'}
    </Button>
  )
}

function CodeBlock({ language, text }: { language: string; text: string }) {
  return (
    <div
      style={{
        border: '1px solid var(--ant-color-border-secondary, #e2e6ec)',
        borderRadius: 10,
        overflow: 'hidden',
        margin: '10px 0',
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '2px 10px',
          fontSize: 12,
          borderBottom: '1px solid var(--ant-color-border-secondary, #e2e6ec)',
        }}
      >
        <Typography.Text type="secondary">{language}</Typography.Text>
        <CopyButton text={text} />
      </div>
      <pre
        style={{
          padding: '10px 12px',
          overflow: 'auto',
          fontSize: 12.5,
          lineHeight: 1.55,
        }}
      >
        <code>{text}</code>
      </pre>
    </div>
  )
}

export function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // 块级代码走 pre 覆写（fenced 块即使无语言/单行也保持代码块形态）；
          // code 只渲染行内片段。
          pre: ({ children }) => {
            const code = children as React.ReactElement<{
              className?: string
              children?: React.ReactNode
            }>
            const raw = String(code?.props?.children ?? '').replace(/\n$/, '')
            const language = /language-(\w+)/.exec(code?.props?.className ?? '')?.[1] ?? 'text'
            return <CodeBlock language={language} text={raw} />
          },
          code: ({ children }) => <Typography.Text code>{children}</Typography.Text>,
          // 远程图片不自动加载（W-04）：渲染为占位文本。
          img: ({ alt }) => (
            <Typography.Text type="secondary">[图片: {alt ?? '未命名'}]</Typography.Text>
          ),
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer noopener">
              {children}
            </a>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}
