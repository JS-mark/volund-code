'use client'

/**
 * 欢迎页：配对后每次启动的连接过渡页——WS 连接就绪自动进入会话列表；
 * 弱网/本机离线时不把用户困在启动页，保留「直接进入」出口（主界面各视图
 * 自行承担离线/重连状态展示）。
 */
import { SoundOutlined } from '@ant-design/icons'
import { Button, Spin, Typography } from 'antd'

export function WelcomeView({ connected, onSkip }: { connected: boolean; onSkip(): void }) {
  return (
    <div
      style={{
        display: 'grid',
        placeContent: 'center',
        justifyItems: 'center',
        gap: 14,
        height: '100dvh',
        padding: 24,
      }}
    >
      <SoundOutlined style={{ fontSize: 40, color: '#1677ff' }} />
      <Typography.Title level={3} style={{ margin: 0 }}>
        Volund 远程
      </Typography.Title>
      <Typography.Text type="secondary" style={{ textAlign: 'center' }}>
        远程控制你的 Volund 桌面端
      </Typography.Text>
      {!connected && <Spin size="small" style={{ marginTop: 6 }} />}
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {connected ? '已连接，正在进入…' : `正在连接网关 ${window.location.host}…`}
      </Typography.Text>
      {!connected && (
        <Button type="link" size="small" onClick={onSkip}>
          暂不连接，直接进入
        </Button>
      )}
    </div>
  )
}
