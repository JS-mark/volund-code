import type { StatusTone } from './types'

export const welcomeTheme = {
  brand: '#249a82',
  brandAccent: '#2bbd9b',
  border: '#249a82',
  default: 'white',
  info: 'cyan',
  success: 'green',
  warning: 'yellow',
  danger: 'red',
  muted: 'gray',
} as const

export function colorForTone(tone: StatusTone) {
  return welcomeTheme[tone]
}
