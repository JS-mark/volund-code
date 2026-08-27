import type { ReactNode } from 'react'

export type WelcomeLayoutMode = 'full' | 'compact' | 'minimal'
export type StatusTone = 'default' | 'info' | 'success' | 'warning' | 'danger' | 'muted'
export type TerminalSize = { columns: number; rows: number }

export interface WelcomeScreenState {
  app: { name: string; version: string }
  workspace: { displayCwd: string; trustLabel: string; trustTone: StatusTone }
  provider: { label: string }
  sandbox: { label: string; tone: StatusTone }
  permission: { label: string; tone: StatusTone }
  session: { label: string; tokensRemainingLabel: string | null }
  agent: { mode: string; status: string; thinking: 'on' | 'off' }
  /** 最近会话标题（已过滤当前会话，至多 3 条）；空数组渲染 "No recent activity"。 */
  recentActivity: ReadonlyArray<string>
}

export interface WelcomeScreenProps {
  bottomStatus: ReactNode
  commandInput: ReactNode
  state: WelcomeScreenState
  terminalSize: TerminalSize
}
