/**
 * `volund web` 的生产装配（§22 W-01 / Web 计划 P2-07）：loopback server + 静态资源
 * 定位 + 默认打开浏览器。Web 资产目录的锚点留在 CLI 包（与 builtinPluginRoot 同惯例）。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { standaloneArtifactDir } from '@volund/native-bridge'
import { createWebServer } from '@volund/web-server'
import type { WebServerHandle } from '@volund/web-server'

import type { VolundPorts } from './ports'

/** Web 资产目录：VOLUND_WEB_ASSET_DIR → 产物旁 web-assets/ → 源码布局 apps/web/dist。 */
export function webAssetDir(): string | undefined {
  const here = standaloneArtifactDir(import.meta.url, process.execPath)
  // 锚点 here 在源码布局是 apps/cli/src、dist 布局是 apps/cli/dist——
  // 两者上两级都是 apps/，web 产物在 apps/web/dist。
  const candidates = [
    process.env.VOLUND_WEB_ASSET_DIR,
    join(here, 'web-assets'),
    join(here, '..', 'web-assets'),
    join(here, '..', '..', 'web', 'dist'),
  ]
  for (const candidate of candidates) if (candidate && existsSync(candidate)) return candidate
  return undefined
}

async function openBrowser(url: string): Promise<void> {
  const { spawn } = await import('node:child_process')
  const command =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open'
  const child = spawn(command, process.platform === 'win32' ? ['/c', 'start', url] : [url], {
    detached: true,
    stdio: 'ignore',
  })
  child.unref?.()
}

export interface WebServeInput {
  readonly cwd: string
  readonly port: number
  readonly open: boolean
  readonly onReady: (handle: WebServerHandle) => void
}

/** VolundPorts['web'] 的生产实现：serve 阻塞到 server 关闭（SIGINT 由 bin.ts 收尾）。 */
export function createWebPort(ports: VolundPorts): NonNullable<VolundPorts['web']> {
  return {
    async serve({ cwd, port, open, onReady }) {
      const handle = await createWebServer({
        host: '127.0.0.1',
        port,
        staticDir: webAssetDir(),
        ports: {
          identity: ports.identity,
          cwd,
          ...(ports.session ? { session: ports.session } : {}),
          ...(ports.config ? { config: ports.config } : {}),
          ...(ports.native ? { native: ports.native } : {}),
        },
      })
      onReady(handle)
      if (open) await openBrowser(handle.url)
      // 阻塞到进程信号：bin.ts 的 SIGINT/SIGTERM 路径负责 ports.shutdown() 与退出。
      await new Promise<void>((resolve) => {
        const done = () => void handle.close().then(resolve, () => resolve())
        process.once('SIGINT', done)
        process.once('SIGTERM', done)
      })
      return { url: handle.url, port: handle.port }
    },
  }
}
