'use client'

import { DesktopOutlined, MoonOutlined, SunOutlined } from '@ant-design/icons'
import { usePathname } from 'next/navigation'

import { useI18n, useTheme, type ThemeMode } from './Providers'

const THEME_CYCLE: readonly ThemeMode[] = ['auto', 'dark', 'light']
const THEME_ICON = { auto: DesktopOutlined, dark: MoonOutlined, light: SunOutlined } as const

export default function SiteHeader() {
  const pathname = usePathname()
  const { locale, setLocale, t } = useI18n()
  const { mode, setMode } = useTheme()
  const ThemeIcon = THEME_ICON[mode]

  const marketActive = pathname === '/' || pathname.startsWith('/entries')
  const adminActive = pathname.startsWith('/admin')
  const nextTheme = THEME_CYCLE[(THEME_CYCLE.indexOf(mode) + 1) % THEME_CYCLE.length] ?? 'auto'

  return (
    <header className="site-header">
      <div className="shell header-row">
        <a className="brand" href="/">
          volund<span className="mk-accent-text">/</span>market
        </a>
        <div className="site-tools">
          <nav>
            <a href="/" className={marketActive ? 'active' : undefined}>
              {t['nav.market']}
            </a>
            <a href="/admin" className={adminActive ? 'active' : undefined}>
              {t['nav.admin']}
            </a>
          </nav>
          <button
            className="mk-icon-btn"
            title={`${t['theme.label']} · ${t[`theme.${mode}` as const]}`}
            aria-label={t['theme.label']}
            onClick={() => setMode(nextTheme)}
          >
            <ThemeIcon />
          </button>
          <button
            className="mk-icon-btn mk-lang-btn"
            aria-label="language"
            onClick={() => setLocale(locale === 'zh' ? 'en' : 'zh')}
          >
            {t['lang.switch']}
          </button>
        </div>
      </div>
    </header>
  )
}
