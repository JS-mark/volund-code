'use client'

import { AntdRegistry } from '@ant-design/nextjs-registry'
import { App, ConfigProvider, theme } from 'antd'
import enUS from 'antd/locale/en_US'
import zhCN from 'antd/locale/zh_CN'
import { createContext, useContext, useEffect, useState } from 'react'

import { dictionaries, type Dict, type Locale } from '@/lib/i18n'

export type ThemeMode = 'auto' | 'dark' | 'light'
export type ResolvedTheme = 'dark' | 'light'

const THEME_STORAGE_KEY = 'apollo-market-theme'
const LOCALE_STORAGE_KEY = 'apollo-market-locale'

const ThemeCtx = createContext<{
  mode: ThemeMode
  resolved: ResolvedTheme
  setMode: (mode: ThemeMode) => void
}>({
  mode: 'auto',
  resolved: 'dark',
  setMode: () => {},
})
const I18nCtx = createContext<{ locale: Locale; setLocale: (locale: Locale) => void; t: Dict }>({
  locale: 'zh',
  setLocale: () => {},
  t: dictionaries.zh,
})

export const useTheme = () => useContext(ThemeCtx)
export const useI18n = () => useContext(I18nCtx)

// 色板与 apps/docs 主题同源（--volund-* tokens）；发丝线边界。明暗两套 token 随
// resolved 主题切换（auto = 跟随系统 prefers-color-scheme）。
const ANTD_TOKENS = {
  dark: {
    algorithm: theme.darkAlgorithm,
    token: {
      colorPrimary: '#2bbd9b',
      colorInfo: '#2bbd9b',
      colorLink: '#55d7b9',
      colorBgBase: '#0a0d0d',
      colorBgContainer: 'rgba(21, 25, 24, 0.5)',
      colorBgElevated: '#151a18',
      colorBorder: 'rgba(231, 239, 229, 0.14)',
      colorBorderSecondary: 'rgba(231, 239, 229, 0.09)',
      colorText: '#edf1e9',
      colorTextSecondary: '#9ca59f',
      colorTextTertiary: '#7d867f',
      colorTextLightSolid: '#0a0d0d',
      borderRadius: 6,
      fontFamily:
        "'Avenir Next', 'Segoe UI Variable', 'Helvetica Neue', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif",
    },
  },
  light: {
    algorithm: theme.defaultAlgorithm,
    token: {
      colorPrimary: '#147a69',
      colorInfo: '#147a69',
      colorLink: '#0f6759',
      colorBgBase: '#f0f0e9',
      colorBgContainer: 'rgba(252, 253, 248, 0.72)',
      colorBgElevated: '#fbfcf7',
      colorBorder: 'rgba(20, 31, 25, 0.24)',
      colorBorderSecondary: 'rgba(20, 31, 25, 0.12)',
      colorText: '#111714',
      colorTextSecondary: '#515a55',
      colorTextTertiary: '#667069',
      colorTextLightSolid: '#f8faef',
      borderRadius: 6,
      fontFamily:
        "'Avenir Next', 'Segoe UI Variable', 'Helvetica Neue', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif",
    },
  },
} as const

export default function Providers({ children }: { children: React.ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>('auto')
  const [systemDark, setSystemDark] = useState(true)
  const [locale, setLocaleState] = useState<Locale>('zh')

  // 首挂载后从 localStorage 恢复偏好；body 首部的内联脚本已先行设置 data-theme 防闪烁
  useEffect(() => {
    const storedTheme = window.localStorage.getItem(THEME_STORAGE_KEY)
    if (storedTheme === 'dark' || storedTheme === 'light' || storedTheme === 'auto')
      setModeState(storedTheme)
    const storedLocale = window.localStorage.getItem(LOCALE_STORAGE_KEY)
    if (storedLocale === 'en' || storedLocale === 'zh') setLocaleState(storedLocale)
    else if (!navigator.language.startsWith('zh')) setLocaleState('en')
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    setSystemDark(media.matches)
    const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches)
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])

  const resolved: ResolvedTheme = mode === 'auto' ? (systemDark ? 'dark' : 'light') : mode

  useEffect(() => {
    document.documentElement.dataset.theme = resolved
    document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en'
  }, [resolved, locale])

  const setMode = (next: ThemeMode) => {
    setModeState(next)
    window.localStorage.setItem(THEME_STORAGE_KEY, next)
  }
  const setLocale = (next: Locale) => {
    setLocaleState(next)
    window.localStorage.setItem(LOCALE_STORAGE_KEY, next)
  }

  return (
    <AntdRegistry>
      <ConfigProvider locale={locale === 'zh' ? zhCN : enUS} theme={ANTD_TOKENS[resolved]}>
        <ThemeCtx.Provider value={{ mode, resolved, setMode }}>
          <I18nCtx.Provider value={{ locale, setLocale, t: dictionaries[locale] }}>
            <App>{children}</App>
          </I18nCtx.Provider>
        </ThemeCtx.Provider>
      </ConfigProvider>
    </AntdRegistry>
  )
}
