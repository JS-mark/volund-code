'use client'

/**
 * 代码页：内嵌完整 VS Code workbench（monaco-vscode-api，vscode-web 同源代码的
 * npm 形态）。零子进程零下载，点进来即初始化；文件系统桥到 workbench REST。
 *
 * 生命周期约束：workbench 全页只能初始化一次（vscode 单例服务）——
 * AppShell 让本页常驻挂载（切走只是 display:none），本组件自身不再卸载重建。
 */
import { ReloadOutlined } from '@ant-design/icons'
import { Button, Spin, Typography } from 'antd'
import { useEffect, useRef, useState } from 'react'

import type { WebApi } from '../lib/api'
import { useThemeMode } from '../lib/theme'

export function CodePage({ api, cwd }: { api: WebApi; cwd: string }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [error, setError] = useState<string>()
  const { resolved } = useThemeMode()

  useEffect(() => {
    let cancelled = false
    void import('../lib/vscode-workbench')
      .then((module) => {
        const host = hostRef.current
        if (!host) throw new Error('workbench container is not mounted')
        return module.startVscodeWorkbench({ container: host, cwd, api, dark: resolved === 'dark' })
      })
      .then(() => {
        if (!cancelled) setState('ready')
      })
      .catch((cause) => {
        if (!cancelled) {
          setState('failed')
          setError(cause instanceof Error ? (cause.stack ?? cause.message) : String(cause))
        }
      })
    return () => {
      cancelled = true
    }
    // cwd/api 稳定(AppShell 挂载后不变);dark 只在首次初始化时生效(vscode 主题初始化后跟随自身设置)。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, cwd])

  return (
    <div className="code-page">
      <div ref={hostRef} className="code-vscode-host" />
      {state !== 'ready' && (
        <div className="code-empty">
          {state === 'loading' ? (
            <>
              <Spin />
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                正在加载 VS Code workbench…
              </Typography.Text>
            </>
          ) : (
            <>
              <Typography.Title level={5} style={{ marginBottom: 0 }}>
                workbench 加载失败
              </Typography.Title>
              <Typography.Text
                type="secondary"
                style={{
                  fontSize: 12,
                  maxWidth: 560,
                  maxHeight: 200,
                  overflow: 'auto',
                  whiteSpace: 'pre-wrap',
                  textAlign: 'left',
                }}
              >
                {error}
              </Typography.Text>
              <Button icon={<ReloadOutlined />} onClick={() => window.location.reload()}>
                刷新页面重试
              </Button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
