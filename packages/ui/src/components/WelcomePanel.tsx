import { productIdentity } from '@volund/shared'
import { Box, Text } from 'ink'

import type { WelcomePanelData } from '../welcome'
import { PanelFrame } from './PanelFrame'

export interface WelcomePanelProps {
  compact?: boolean
  data: WelcomePanelData
  footer?: string
  title?: string
}

export function WelcomePanel({
  compact = false,
  data,
  footer = 'Ready. Type a message or /help.',
  title = `${productIdentity.displayName}  v${data.version}`,
}: WelcomePanelProps) {
  return (
    <PanelFrame footer={footer} title={title}>
      <WelcomeRow label="Session" value={shortSessionId(data.sessionId)} />
      <WelcomeRow label="Project" value={compactPath(data.cwd, compact)} />
      <WelcomeRow label="Model" value={formatModel(data.model)} />
      <WelcomeRow
        label="Runtime"
        value={`${formatSandbox(data.sandbox)} | ${formatPermission(data.permission)}`}
      />
      <WelcomeRow label="Config" value={formatConfig(data.config)} />
      <WelcomeRow label="MCP" value={formatMcp(data.mcp)} />
      <WelcomeRow label="History" value={formatHistory(data.history)} />
    </PanelFrame>
  )
}

function WelcomeRow({ label, value }: { label: string; value: string }) {
  const warning = value.includes('unavailable') || value.includes('blocked')
  return (
    <Box>
      <Box width={9}>
        <Text bold>{label}</Text>
      </Box>
      {warning ? (
        <Text color="yellow" wrap="wrap">
          {value}
        </Text>
      ) : (
        <Text wrap="wrap">{value}</Text>
      )}
    </Box>
  )
}

function formatModel(model: WelcomePanelData['model']) {
  if (model.status === 'available') return `${model.provider}/${model.model}  ${model.source}`
  if (model.status === 'unavailable') return `unavailable: ${model.reason.message}`
  return model.reason ? `unknown: ${model.reason.message}` : 'unknown'
}

function formatSandbox(sandbox: WelcomePanelData['sandbox']) {
  if (sandbox.status === 'unavailable') return `sandbox unavailable: ${sandbox.reason.message}`
  if (sandbox.status === 'probing') return 'sandbox probing'
  return `sandbox ${sandbox.tier}`
}

function formatPermission(permission: WelcomePanelData['permission']) {
  return `permissions ${permission.mode}${permission.dangerous ? ' dangerous' : ''}`
}

function formatConfig(config: WelcomePanelData['config']) {
  const sources = config.effectiveSources.length ? config.effectiveSources.join(' + ') : 'defaults'
  const project =
    config.project.status === 'blocked'
      ? ' | project config blocked'
      : config.project.status === 'available'
        ? ' | project trusted'
        : ''
  return `${sources}${project}`
}

function formatMcp(mcp: WelcomePanelData['mcp']) {
  if (mcp.status === 'available') return `${mcp.connected} connected / ${mcp.total} configured`
  if (mcp.status === 'disabled') return mcp.reason ? `disabled: ${mcp.reason.message}` : 'disabled'
  return `unavailable: ${mcp.reason.message}`
}

function formatHistory(history: WelcomePanelData['history']) {
  if (history.status === 'available') return `enabled (${history.entries}/${history.maxEntries})`
  if (history.status === 'disabled')
    return history.reason ? `disabled: ${history.reason.message}` : 'disabled'
  return `unavailable: ${history.reason.message}`
}

function compactPath(path: string, compact: boolean) {
  if (!compact || path.length <= 60) return path
  return `...${path.slice(-57)}`
}

function shortSessionId(sessionId: string) {
  if (sessionId.length <= 12) return sessionId
  return sessionId.slice(0, 12)
}
