export const C = {
  ink: '#0a0d0d',
  surface: '#151918',
  line: '#262e2b',
  accent: '#2bbd9b',
  accentStrong: '#55d7b9',
  text: '#edf1e9',
  muted: '#929b95',
  danger: '#e06c5b',
  amber: '#e0b25b',
} as const

export const FONT_SANS = '-apple-system, "PingFang SC", "Helvetica Neue", sans-serif'
export const FONT_MONO = 'ui-monospace, "SF Mono", Menlo, monospace'

export const eyebrowStyle = {
  fontFamily: FONT_MONO,
  fontSize: '22px',
  letterSpacing: '0.42em',
  color: C.accent,
  textTransform: 'uppercase',
} as const

export const bigTitleStyle = {
  fontSize: '96px',
  fontWeight: 700,
  lineHeight: 1.16,
  letterSpacing: '-0.01em',
  margin: '26px 0 0',
} as const
