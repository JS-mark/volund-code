import type { Metadata, Viewport } from 'next'

import './globals.css'

export const metadata: Metadata = {
  title: 'Volund Web',
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        {/* 首帧前落地主题避免闪烁（system 走 prefers-color-scheme）；CSP nonce 由 web-server 发 HTML 时注入。 */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var s=localStorage.getItem('volund-web-theme');document.documentElement.dataset.theme=s==='dark'||s==='light'?s:(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light')}catch(e){}`,
          }}
        />
      </head>
      <body>{children}</body>
    </html>
  )
}
