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
  /** §22 W-01：嵌入式 Web 控制台地址（无 token，进入即用）；null = 未启动不渲染。 */
  web: { url: string | null }
  /** REM-r1：远程控制 uplink 状态行；null = 未启用不渲染。 */
  remote: { state: 'connecting' | 'online'; url: string | null; tone: StatusTone } | null
}

// bottomStatus / commandInput 不再是本组件的插槽：welcome 退出时它们若随
// WelcomeScreen 一起卸载，InputBox 会被重建、未提交的输入与附件 chip 全部丢失
// （React 跨父节点移动即重挂载）。它们由 app 渲染层放在两分支之外的固定位置。
export interface WelcomeScreenProps {
  state: WelcomeScreenState
  terminalSize: TerminalSize
}
