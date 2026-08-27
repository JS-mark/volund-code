import { productIdentity } from '@volund/shared'

import type { WelcomePanelData } from '../../welcome'
import type { StatusTone, WelcomeScreenState } from './types'
import { formatDisplayCwd } from './welcomeLayout'

export interface BuildWelcomeScreenStateInput {
  data: WelcomePanelData
  homeDir?: string
  trustLabel?: string
}

export function buildWelcomeScreenState(input: BuildWelcomeScreenStateInput): WelcomeScreenState {
  const { data } = input
  const model = data.model
  const sandbox = data.sandbox
  const modelAvailable = model.status === 'available'
  const dangerous = data.permission.dangerous
  const providerLabel =
    model.status === 'available'
      ? `${model.provider} / ${model.model}`
      : `not configured${model.reason ? ` (${model.reason.message})` : ''}`
  const authLabel = modelAvailable ? 'configured' : 'unknown'
  const sandboxLabel =
    sandbox.status === 'available'
      ? `${sandbox.mechanism} (${sandbox.tier})`
      : sandbox.status === 'probing'
        ? 'probing'
        : 'unknown'
  return {
    app: { name: productIdentity.displayName, version: data.version },
    workspace: {
      cwd: data.cwd,
      displayCwd: formatDisplayCwd(data.cwd, input.homeDir),
      trustLabel: input.trustLabel ?? data.trustLabel ?? 'Trusted: folder',
      trustTone: 'success',
    },
    provider: {
      label: providerLabel,
      authLabel,
      authTone: modelAvailable ? 'success' : 'warning',
    },
    sandbox: {
      label: sandboxLabel,
      tone: sandbox.status === 'available' ? sandboxTone(sandbox.tier) : 'warning',
    },
    permission: {
      label: dangerous ? 'bypassed' : data.permission.mode,
      tone: dangerous ? 'danger' : 'success',
    },
    session: {
      label: `new ${data.sessionId.slice(0, 12)}`,
      contextLabel: '0% / 200k',
      tokensRemainingLabel: '200k remaining',
    },
    agent: { mode: 'auto', status: 'ready', thinking: 'off' },
    firstRunChecks: [
      ...(model.status !== 'available' && model.reason
        ? [{ id: 'provider-detail', label: model.reason.message, tone: 'muted' as const }]
        : []),
      {
        id: 'provider',
        label: modelAvailable ? 'provider configured' : 'provider unknown',
        tone: modelAvailable ? 'success' : 'warning',
      },
      { id: 'trust', label: input.trustLabel ?? data.trustLabel ?? 'trusted cwd', tone: 'success' },
      {
        id: 'permission',
        label: dangerous ? 'permissions bypassed' : 'tool approval required',
        tone: dangerous ? 'danger' : 'warning',
      },
      {
        id: 'mcp',
        label:
          data.mcp.status === 'available'
            ? `MCP  ${data.mcp.connected} connected / ${data.mcp.total} configured`
            : `MCP ${data.mcp.status}`,
        tone: data.mcp.status === 'available' ? 'info' : 'muted',
      },
    ],
  }
}

function sandboxTone(tier: string): StatusTone {
  if (tier === 'full') return 'success'
  if (tier === 'none') return 'danger'
  return 'warning'
}
