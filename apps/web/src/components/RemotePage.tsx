'use client'

/**
 * 远程控制页（REM-r1）：渠道管理。
 * 顶部总开关（uplink 拨出状态 + 网关凭证配置）；已连渠道卡（一期只有移动端
 * 网站，微信/企微占位「即将上线」）；配对卡（二维码 + 配对码 + 有效期倒计时）；
 * 设备管理（已配对手机 / 撤销）。
 */
import {
  CheckCircleOutlined,
  DisconnectOutlined,
  LinkOutlined,
  MobileOutlined,
  PlusOutlined,
  ReloadOutlined,
  StopOutlined,
} from '@ant-design/icons'
import {
  Alert,
  Badge,
  Button,
  Card,
  Empty,
  Input,
  List,
  Popconfirm,
  Space,
  Tag,
  Typography,
  message,
} from 'antd'
import QRCode from 'qrcode'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { ConfigView, PairingInvitation, RemoteView, WebApi } from '../lib/api'

interface FieldState {
  value: string
  saving: boolean
}

function useStateField(
  initial = '',
): [FieldState, (value: string) => void, () => void, () => void] {
  const [state, setState] = useState<FieldState>({ value: initial, saving: false })
  const setValue = useCallback(
    (value: string) => setState((current) => ({ ...current, value })),
    [],
  )
  const beginSave = useCallback(() => setState((current) => ({ ...current, saving: true })), [])
  const endSave = useCallback(() => setState((current) => ({ ...current, saving: false })), [])
  return [state, setValue, beginSave, endSave]
}

const STATE_TEXT: Record<
  RemoteView['status']['state'],
  { label: string; status: 'success' | 'processing' | 'default' | 'error' }
> = {
  online: { label: '已连接', status: 'success' },
  connecting: { label: '连接中', status: 'processing' },
  off: { label: '未开启', status: 'default' },
}

export function RemotePage({ api }: { api: WebApi }) {
  const [view, setView] = useState<RemoteView>()
  const [config, setConfig] = useState<ConfigView>()
  const [pairing, setPairing] = useState<PairingInvitation>()
  const [pairingQr, setPairingQr] = useState<string>()
  const [now, setNow] = useState(Date.now())
  const [actionBusy, setActionBusy] = useState(false)
  const [gatewayUrl, setGatewayUrl, saveGatewayUrl, endSaveGatewayUrl] = useStateField()
  const [clientId, setClientId, saveClientId, endSaveClientId] = useStateField()
  const [clientSecret, setClientSecret, saveClientSecret, endSaveClientSecret] = useStateField()
  const [messageApi, contextHolder] = message.useMessage()
  const configRef = useRef(config)
  configRef.current = config

  const refresh = useCallback(async () => {
    const [remoteView, configView] = await Promise.all([
      api.remote().catch(() => undefined),
      api.configGet().catch(() => undefined),
    ])
    if (remoteView) setView(remoteView)
    if (configView) {
      setConfig(configView)
      const remote = configView.config.remote as
        | { gateway_url?: string; client_id?: string }
        | undefined
      if (remote?.gateway_url && !gatewayUrl.value) setGatewayUrl(remote.gateway_url)
      if (remote?.client_id && !clientId.value) setClientId(remote.client_id)
    }
  }, [api, gatewayUrl.value, clientId.value])

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => {
      void refresh()
      setNow(Date.now())
    }, 3_000)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!pairing) return
    void QRCode.toDataURL(pairing.url, { width: 240, margin: 1 }).then(setPairingQr)
  }, [pairing])

  const runAction = useCallback(
    async (body: Parameters<WebApi['remoteAction']>[0]) => {
      setActionBusy(true)
      try {
        return await api.remoteAction(body)
      } catch (cause) {
        messageApi.error(cause instanceof Error ? cause.message : String(cause))
        return undefined
      } finally {
        setActionBusy(false)
      }
    },
    [api, messageApi],
  )

  const remoteConfig = config?.config.remote as
    | {
        enabled?: boolean
        gateway_url?: string
        client_id?: string
        client_secret?: boolean | string
      }
    | undefined
  const secretSet =
    remoteConfig?.client_secret === true || typeof remoteConfig?.client_secret === 'string'
  const status = view?.status
  const stateMeta = STATE_TEXT[status?.state ?? 'off']

  const toggle = useCallback(
    async (enabled: boolean) => {
      await runAction({ type: enabled ? 'start' : 'stop' })
      await refresh()
    },
    [runAction, refresh],
  )

  const saveField = useCallback(
    async (
      key: 'gateway_url' | 'client_id' | 'client_secret',
      value: string,
      begin: () => void,
      end: () => void,
    ) => {
      if (!value.trim()) return
      begin()
      try {
        await api.configSet(`remote.${key}`, value.trim())
        messageApi.success('已保存')
        await refresh()
        if (key === 'client_secret') setClientSecret('')
      } catch (cause) {
        messageApi.error(cause instanceof Error ? cause.message : String(cause))
      } finally {
        end()
      }
    },
    [api, messageApi, refresh, setClientSecret],
  )

  const generatePairing = useCallback(async () => {
    const result = (await runAction({ type: 'create-pairing' })) as
      | { pairing: PairingInvitation }
      | undefined
    if (result?.pairing) setPairing(result.pairing)
    // 失败多半是按钮可用态滞后于链路真实状态（3s 轮询窗）——立刻刷新收口。
    else await refresh()
  }, [runAction, refresh])

  const revoke = useCallback(
    async (deviceId: string) => {
      // revoked=false（链路离线/设备已不在注册表）不能静默——用户会误以为已断开。
      const result = (await runAction({ type: 'revoke-device', deviceId })) as
        | { revoked: boolean }
        | undefined
      if (result && result.revoked === false)
        messageApi.warning('撤销未生效：远程控制链路离线或设备已不存在，请确认链路在线后重试')
      else messageApi.success('已撤销该设备')
      await refresh()
    },
    [runAction, refresh, messageApi],
  )

  const pairingSecondsLeft = useMemo(
    () => (pairing ? Math.max(0, Math.floor((pairing.expiresAt - now) / 1000)) : 0),
    [pairing, now],
  )

  const availableChannels = view?.channels.filter((channel) => channel.available) ?? []
  const comingSoonChannels = view?.channels.filter((channel) => !channel.available) ?? []

  return (
    <section className="page" style={{ padding: 24, overflow: 'auto', maxWidth: 880 }}>
      {contextHolder}
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        远程控制
      </Typography.Title>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 20 }}>
        管理渠道连接——外部设备经公网网关中转控制本机会话。
      </Typography.Paragraph>

      {/* 总开关 + 网关配置 */}
      <Card size="small" style={{ marginBottom: 16 }}>
        <Space align="center" style={{ marginBottom: 16 }}>
          {status?.state === 'online' || status?.state === 'connecting' ? (
            <Button
              danger
              icon={<StopOutlined />}
              loading={actionBusy}
              onClick={() => void toggle(false)}
            >
              停止服务
            </Button>
          ) : (
            <Button
              type="primary"
              icon={<LinkOutlined />}
              loading={actionBusy}
              onClick={() => void toggle(true)}
            >
              启动服务
            </Button>
          )}
          <Badge status={stateMeta.status} text={stateMeta.label} />
          {status?.gatewayUrl && (
            <Typography.Text type="secondary">{status.gatewayUrl}</Typography.Text>
          )}
        </Space>
        {/* 连接中/失败的原因显眼展示——配对等操作依赖在线状态，藏小字会被当成按钮 bug。 */}
        {status?.state === 'connecting' && status.lastError && (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 16 }}
            title={`正在重试连接（第 ${status.attempt} 次）：${status.lastError}`}
            description="检查网关地址是否可达、client_id/client_secret 是否正确；网关侧日志能看到认证失败原因。"
          />
        )}
        <Space orientation="vertical" size={8} style={{ display: 'flex' }}>
          <Space.Compact style={{ display: 'flex' }}>
            <Input
              prefix={<LinkOutlined />}
              placeholder="网关地址，如 https://gateway.ai-agentic.cc"
              value={gatewayUrl.value}
              onChange={(event) => setGatewayUrl(event.target.value)}
            />
            <Button
              loading={gatewayUrl.saving}
              onClick={() =>
                void saveField('gateway_url', gatewayUrl.value, saveGatewayUrl, endSaveGatewayUrl)
              }
            >
              保存
            </Button>
          </Space.Compact>
          <Space.Compact style={{ display: 'flex' }}>
            <Input
              placeholder="client_id（网关 clients.json 登记的机器凭证 id）"
              value={clientId.value}
              onChange={(event) => setClientId(event.target.value)}
            />
            <Button
              loading={clientId.saving}
              onClick={() =>
                void saveField('client_id', clientId.value, saveClientId, endSaveClientId)
              }
            >
              保存
            </Button>
          </Space.Compact>
          <Space.Compact style={{ display: 'flex' }}>
            <Input.Password
              placeholder={
                secretSet
                  ? 'client_secret 已设置（不回显），输入以更换'
                  : 'client_secret（机器凭证 secret）'
              }
              value={clientSecret.value}
              onChange={(event) => setClientSecret(event.target.value)}
            />
            <Button
              loading={clientSecret.saving}
              onClick={() =>
                void saveField(
                  'client_secret',
                  clientSecret.value,
                  saveClientSecret,
                  endSaveClientSecret,
                )
              }
            >
              保存
            </Button>
          </Space.Compact>
        </Space>
      </Card>

      {/* 已连渠道 */}
      <Card
        size="small"
        title="已连渠道"
        style={{ marginBottom: 16 }}
        extra={
          <Button size="small" icon={<ReloadOutlined />} onClick={() => void refresh()}>
            刷新
          </Button>
        }
      >
        {availableChannels.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="暂无已连接渠道——开启上方远程控制并配置网关后，移动端网站渠道自动就绪"
          />
        ) : (
          <List
            dataSource={availableChannels}
            renderItem={(channel) => (
              <List.Item
                actions={
                  channel.id === 'mobile-web'
                    ? [
                        <Badge
                          key="state"
                          status={status?.state === 'online' ? 'success' : 'default'}
                          text={status?.state === 'online' ? '在线' : '离线'}
                        />,
                        <Tag key="devices">{view?.devices.length ?? 0} 台设备</Tag>,
                      ]
                    : []
                }
              >
                <List.Item.Meta
                  avatar={<MobileOutlined style={{ fontSize: 20 }} />}
                  title={channel.name}
                  description={channel.description}
                />
              </List.Item>
            )}
          />
        )}
      </Card>

      {/* 配对（仅移动站渠道 + 在线时可用） */}
      <Card
        size="small"
        title="添加移动设备"
        style={{ marginBottom: 16 }}
        extra={
          <Button
            size="small"
            type="primary"
            ghost
            icon={<PlusOutlined />}
            disabled={status?.state !== 'online'}
            onClick={() => void generatePairing()}
          >
            生成配对码
          </Button>
        }
      >
        {status?.state !== 'online' ? (
          <Typography.Text type="secondary">
            开启远程控制并连上网关后，可生成一次性配对码（5 分钟有效）供手机扫码接入。
          </Typography.Text>
        ) : pairing && pairingSecondsLeft > 0 ? (
          <Space size={24} align="start">
            {pairingQr && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={pairingQr} alt="配对二维码" width={180} height={180} />
            )}
            <Space orientation="vertical" size={4}>
              <Typography.Text
                copyable={{ text: pairing.url }}
                style={{ fontSize: 20, letterSpacing: 4 }}
              >
                {pairing.code}
              </Typography.Text>
              <Typography.Text type="secondary">手机扫码，或在移动站输入配对码</Typography.Text>
              <Typography.Text type="secondary">{pairingSecondsLeft} 秒后失效</Typography.Text>
            </Space>
          </Space>
        ) : (
          <Typography.Text type="secondary">
            生成配对码后，手机打开网关地址扫码/输入即可接入本机。
          </Typography.Text>
        )}
      </Card>

      {/* 设备管理 */}
      <Card size="small" title="已配对设备" style={{ marginBottom: 16 }}>
        {!view || view.devices.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无已配对设备" />
        ) : (
          <List
            dataSource={view.devices}
            renderItem={(device) => (
              <List.Item
                actions={[
                  <Popconfirm
                    key="revoke"
                    title="撤销该设备？"
                    description="撤销后手机上的访问凭证立即失效"
                    onConfirm={() => void revoke(device.id)}
                  >
                    <Button size="small" danger icon={<StopOutlined />}>
                      撤销
                    </Button>
                  </Popconfirm>,
                ]}
              >
                <List.Item.Meta
                  avatar={
                    <CheckCircleOutlined
                      style={{
                        fontSize: 16,
                        color: now - device.lastSeen < 300_000 ? undefined : undefined,
                      }}
                    />
                  }
                  title={device.name}
                  description={`配对于 ${new Date(device.pairedAt).toLocaleString()} · 最近活跃 ${new Date(
                    device.lastSeen,
                  ).toLocaleString()}`}
                />
              </List.Item>
            )}
          />
        )}
      </Card>

      {/* 更多渠道（R3 插件市场） */}
      <Card size="small" title="安装更多渠道">
        <Space orientation="vertical" size={4}>
          {comingSoonChannels.map((channel) => (
            <Typography.Text key={channel.id} type="secondary">
              <DisconnectOutlined style={{ marginRight: 6 }} />
              {channel.name} — {channel.description}（即将上线）
            </Typography.Text>
          ))}
          <Typography.Text type="secondary">
            浏览插件市场安装第三方渠道插件（即将上线）。
          </Typography.Text>
        </Space>
      </Card>
    </section>
  )
}
