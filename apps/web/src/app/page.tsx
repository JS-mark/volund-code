'use client'

import { AntdRegistry } from '@ant-design/nextjs-registry'
import { App as AntdApp, ConfigProvider, theme as antdTheme } from 'antd'
import zhCN from 'antd/locale/zh_CN'

import { AppShell } from '../components/AppShell'
import { ThemeModeProvider, useThemeMode } from '../lib/theme'

function Themed({ children }: { children: React.ReactNode }) {
  const { resolved } = useThemeMode()
  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        // antd v6 默认开启 cssVar（--ant-* 变量随 algorithm 切换），壳层布局直接用。
        algorithm: resolved === 'dark' ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
        token: { colorPrimary: '#2f6feb' },
      }}
    >
      <AntdApp>{children}</AntdApp>
    </ConfigProvider>
  )
}

export default function Page() {
  return (
    <AntdRegistry>
      <ThemeModeProvider>
        <Themed>
          <AppShell />
        </Themed>
      </ThemeModeProvider>
    </AntdRegistry>
  )
}
