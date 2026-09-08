'use client'

import { createContext, useContext, useEffect, useState } from 'react'

/** system = 跟随系统（prefers-color-scheme）；resolved 是实际应用的浅色/深色。 */
export type ThemeMode = 'dark' | 'light' | 'system'

interface ThemeContextValue {
  mode: ThemeMode
  resolved: 'dark' | 'light'
  setMode(mode: ThemeMode): void
}

const ThemeContext = createContext<ThemeContextValue>({
  mode: 'system',
  resolved: 'light',
  setMode: () => {},
})

export function useThemeMode(): ThemeContextValue {
  return useContext(ThemeContext)
}

function systemPrefersDark(): boolean {
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

/** 主题状态源（localStorage 持久化；SSG 期无 window 走跟随系统）。 */
export function ThemeModeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setMode] = useState<ThemeMode>('system')
  const [systemDark, setSystemDark] = useState(false)
  useEffect(() => {
    const saved = window.localStorage.getItem('volund-web-theme')
    if (saved === 'dark' || saved === 'light' || saved === 'system') setMode(saved)
    setSystemDark(systemPrefersDark())
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches)
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])
  const resolved: 'dark' | 'light' = mode === 'system' ? (systemDark ? 'dark' : 'light') : mode
  useEffect(() => {
    document.documentElement.dataset.theme = resolved
    window.localStorage.setItem('volund-web-theme', mode)
  }, [mode, resolved])
  return (
    <ThemeContext.Provider value={{ mode, resolved, setMode }}>{children}</ThemeContext.Provider>
  )
}
