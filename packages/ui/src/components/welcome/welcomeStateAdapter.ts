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
  const dangerous = data.permission.dangerous
  const providerLabel =
    model.status === 'available'
      ? `${model.provider} / ${model.model}`
      : `not configured${model.reason ? ` (${model.reason.message})` : ''}`
  const sandboxLabel =
    sandbox.status === 'available'
      ? `${sandbox.mechanism} (${sandbox.tier})`
      : sandbox.status === 'probing'
        ? 'probing'
        : 'unknown'
  return {
    app: { name: productIdentity.displayName, version: data.version },
    workspace: {
      displayCwd: formatDisplayCwd(data.cwd, input.homeDir),
      trustLabel: input.trustLabel ?? data.trustLabel ?? 'Trusted: folder',
      trustTone: 'success',
    },
    provider: { label: providerLabel },
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
      tokensRemainingLabel: '200k remaining',
    },
    agent: { mode: 'auto', status: 'ready', thinking: 'off' },
    // 去重：同目录多个会话的自动标题相同（"Session in <cwd>"），重复行既无信息
    // 量也会让 React key 冲突刷警告。
    recentActivity: [...new Set(data.recentActivity ?? [])].slice(0, 3),
  }
}

function sandboxTone(tier: string): StatusTone {
  if (tier === 'full') return 'success'
  if (tier === 'none') return 'danger'
  return 'warning'
}
