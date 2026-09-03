import { productIdentity } from '@volund/shared'

import type { WelcomeNativeStatus, WelcomePanelData } from '../../welcome'
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
    native: nativeRows(data.native),
  }
}

/** 探针三态 → 欢迎屏展示行：loaded 绿 / probing 黄 / 不可用红。 */
function nativeRows(native: WelcomeNativeStatus | undefined) {
  const modules = [
    { key: 'sandbox' as const, state: native?.sandbox },
    { key: 'search' as const, state: native?.search },
    { key: 'fs' as const, state: native?.fs },
  ]
  return modules.map(({ key, state }) => ({
    label: key,
    state:
      state === 'loaded'
        ? 'loaded'
        : state === 'unavailable'
          ? 'not loaded'
          : // 缺省与 'probing' 同态：启动探针未回填时不谎报结果。
            'probing',
    tone: (state === 'loaded' ? 'success' : state === 'unavailable' ? 'danger' : 'warning') as StatusTone,
  }))
}

function sandboxTone(tier: string): StatusTone {
  if (tier === 'full') return 'success'
  if (tier === 'none') return 'danger'
  return 'warning'
}
