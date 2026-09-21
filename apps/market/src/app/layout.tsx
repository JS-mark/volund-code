import type { Metadata } from 'next'

import Providers from '@/components/Providers'
import SiteFooterText from '@/components/SiteFooter'
import SiteHeader from '@/components/SiteHeader'

import './globals.css'

export const metadata: Metadata = {
  title: 'volund market',
  description: 'volund 插件 / Skill / MCP 市场服务端',
}

// 主题防闪烁：渲染任何内容前先按 localStorage / 系统偏好把 data-theme 落到 <html>
const THEME_INIT_SCRIPT = `(function(){try{var m=localStorage.getItem('apollo-market-theme');var d=m==='light'?false:m==='dark'?true:window.matchMedia('(prefers-color-scheme: dark)').matches;document.documentElement.dataset.theme=d?'dark':'light'}catch(e){document.documentElement.dataset.theme='dark'}})()`

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" data-theme="dark" suppressHydrationWarning>
      <body>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        <Providers>
          <div className="page">
            <SiteHeader />
            <main className="shell">{children}</main>
            <footer className="site-footer">
              <div className="shell">
                <SiteFooterText />
              </div>
            </footer>
          </div>
        </Providers>
      </body>
    </html>
  )
}
