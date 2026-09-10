'use client'

/**
 * 配对视图：扫描/输入远程控制页生成的配对码 → POST /pairing/redeem →
 * 存设备 token 进入主界面。URL 带 #pair=CODE（可选 &gw=网关地址）时自动核销。
 * 站点独立部署（与网关不同源）时，先在下方填入网关地址再配对。
 */
import { SoundOutlined } from '@ant-design/icons'
import { Alert, Button, Input, Space, Spin, Typography, message } from 'antd'
import { useCallback, useEffect, useState } from 'react'

import {
  clearPairingHash,
  gatewayBase,
  gatewayLabel,
  pairingCodeFromHash,
  redeemPairing,
  setGatewayBase,
} from '../lib/gateway'

function deviceName(): string {
  const ua = navigator.userAgent
  const platform = /iPhone|iPad/.test(ua)
    ? 'iPhone'
    : /Android/.test(ua)
      ? 'Android'
      : /Macintosh/.test(ua)
        ? 'Mac'
        : '设备'
  const browser =
    /Safari/.test(ua) && !/Chrome/.test(ua) ? 'Safari' : /Chrome/.test(ua) ? 'Chrome' : ''
  return browser ? `${platform}·${browser}` : platform
}

export function PairView({
  onPaired,
  notice,
}: {
  onPaired: () => void
  /** 被撤销/凭证失效回到配对页时展示的提示。 */
  notice?: string | undefined
}) {
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [auto, setAuto] = useState(false)
  const [gateway, setGateway] = useState(() => gatewayBase())
  const [label, setLabel] = useState(() => gatewayLabel())
  const [messageApi, contextHolder] = message.useMessage()

  const redeem = useCallback(
    async (raw: string) => {
      setBusy(true)
      try {
        // 表单里填了网关地址就先存再用（独立部署形态；空 = 同源托管）。
        if (gateway.trim()) setGatewayBase(gateway)
        await redeemPairing(raw, deviceName())
        clearPairingHash()
        onPaired()
      } catch (cause) {
        messageApi.error(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setBusy(false)
      }
    },
    [gateway, messageApi, onPaired],
  )

  useEffect(() => {
    if (auto) return
    const fromHash = pairingCodeFromHash()
    if (fromHash) {
      setAuto(true)
      void redeem(fromHash)
    }
  }, [auto, redeem])

  return (
    <div
      style={{
        display: 'grid',
        placeContent: 'center',
        justifyItems: 'center',
        gap: 16,
        height: '100dvh',
        padding: 24,
      }}
    >
      {contextHolder}
      <SoundOutlined style={{ fontSize: 34, color: '#1677ff' }} />
      <Typography.Title level={4} style={{ margin: 0 }}>
        Volund 远程
      </Typography.Title>
      <Typography.Text type="secondary" style={{ textAlign: 'center' }}>
        在桌面 Web 控制台「远程控制」页生成配对码，扫码或在此输入
      </Typography.Text>
      {notice && (
        <Alert type="warning" showIcon message={notice} style={{ maxWidth: 320 }} closable />
      )}
      {auto && busy ? (
        <Space>
          <Spin size="small" />
          <Typography.Text type="secondary">正在配对…</Typography.Text>
        </Space>
      ) : (
        <Space orientation="vertical" size={8} style={{ alignItems: 'center' }}>
          <Space.Compact style={{ width: 260 }}>
            <Input
              size="large"
              placeholder="8 位配对码"
              value={code}
              maxLength={8}
              onChange={(event) => setCode(event.target.value.toUpperCase())}
              onPressEnter={() => code.length === 8 && void redeem(code)}
              style={{ letterSpacing: 3, textAlign: 'center', fontSize: 18 }}
            />
            <Button
              size="large"
              type="primary"
              loading={busy}
              disabled={code.trim().length !== 8}
              onClick={() => void redeem(code)}
            >
              配对
            </Button>
          </Space.Compact>
          <Space.Compact style={{ width: 260 }}>
            <Input
              size="small"
              placeholder="网关地址（可选）https://…"
              value={gateway}
              onChange={(event) => setGateway(event.target.value)}
            />
            <Button
              size="small"
              onClick={() => {
                try {
                  setGatewayBase(gateway)
                  setGateway(gatewayBase())
                  setLabel(gatewayLabel())
                  messageApi.success('网关地址已保存')
                } catch (cause) {
                  messageApi.error(cause instanceof Error ? cause.message : String(cause))
                }
              }}
            >
              保存
            </Button>
          </Space.Compact>
        </Space>
      )}
      <Alert
        type="info"
        showIcon={false}
        style={{ maxWidth: 300, fontSize: 12 }}
        title={`网关：${label}（独立部署时先填网关地址）`}
      />
    </div>
  )
}
