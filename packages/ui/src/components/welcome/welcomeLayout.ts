import type { TerminalSize, WelcomeLayoutMode } from './types'

export function getWelcomeLayout(size: TerminalSize): WelcomeLayoutMode {
  const columns = validDimension(size.columns, 90)
  const rows = validDimension(size.rows, 24)
  if (columns < 80 || rows < 20) return 'minimal'
  if (columns < 110 || rows < 28) return 'compact'
  return 'full'
}

export function validDimension(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback
}

export function truncateMiddle(value: string, maxLength: number): string {
  if (maxLength < 2) return value.slice(0, Math.max(0, maxLength))
  if (value.length <= maxLength) return value
  const left = Math.ceil((maxLength - 1) / 2)
  return `${value.slice(0, left)}…${value.slice(value.length - (maxLength - left - 1))}`
}

export function formatDisplayCwd(cwd: string, homeDir?: string, maxLength = 48): string {
  const display =
    homeDir && (cwd === homeDir || cwd.startsWith(`${homeDir}/`))
      ? `~${cwd.slice(homeDir.length)}`
      : cwd
  return truncateMiddle(display, maxLength)
}
