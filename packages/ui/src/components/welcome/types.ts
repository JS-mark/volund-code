import type { ReactNode } from 'react'

export type WelcomeLayoutMode = 'full' | 'compact' | 'minimal'
export type StatusTone = 'default' | 'info' | 'success' | 'warning' | 'danger' | 'muted'
export type TerminalSize = { columns: number; rows: number }

export interface WelcomeScreenState {
  app: { name: string; version: string }
  workspace: { displayCwd: string; trustLabel: string; trustTone: StatusTone }
  provider: { label: string }
  permission: { label: string; tone: StatusTone }
  session: { label: string; tokensRemainingLabel: string | null }
  agent: { mode: string; status: string; thinking: 'on' | 'off' }
  /** native-bridge 探针加载状态（sandbox/search/fs 各一行）；缺省视为 probing。 */
  native: ReadonlyArray<{ label: string; state: string; tone: StatusTone }>
}

export interface WelcomeScreenProps {
  bottomStatus: ReactNode
  commandInput: ReactNode
  state: WelcomeScreenState
  terminalSize: TerminalSize
}
