#!/usr/bin/env node
/**
 * volund 远程网关（relay）独立入口——不经 volund CLI 的常驻进程：
 *
 *   node packages/gateway-server/dist/bin.js [--port 8788] [--json]
 *
 * 纯中转形态：不挂本机会话——桌面 volund（TUI/Web 控制台的远程控制）经
 * /uplink 反向拨出注册，/v1/* 流量按认证 client 路由到对应实例；
 * /pairing/redeem 设备配对；移动站静态托管（VOLUND_MOBILE_ASSET_DIR →
 * 产物旁 mobile-assets/ → 源码布局 apps/mobile/out）。
 * 配置全部走 GATEWAY_* 环境变量（见 relay-config.ts 头部）；VOLUND_HOME
 * （默认 ~/.volund）下的 gateway/ 存客户端哈希、签名密钥与设备注册表。
 * 直挂模式（网关自带会话 runner）已随 `volund gateway` 子命令一并移除。
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createGatewayServer } from './index'
import { PairingStore } from './pairing'
import { resolveGatewayCredentials, resolveRelayConfig } from './relay-config'

/** 移动站资产目录：env 优先，其次产物旁目录，最后源码布局（仓库根 apps/mobile/out）。 */
function mobileAssetDir(): string | undefined {
  // dist/bin.js → 上三级是仓库根（源码布局）；Docker 里靠 VOLUND_MOBILE_ASSET_DIR。
  const here = fileURLToPath(new URL('.', import.meta.url))
  const candidates = [
    process.env.VOLUND_MOBILE_ASSET_DIR,
    join(here, 'mobile-assets'),
    join(here, '..', 'mobile-assets'),
    join(here, '..', '..', '..', 'apps', 'mobile', 'out'),
  ]
  for (const candidate of candidates) if (candidate && existsSync(candidate)) return candidate
  return undefined
}

async function packageVersion(): Promise<string> {
  try {
    const raw = await readFile(new URL('../package.json', import.meta.url), 'utf8')
    const parsed = JSON.parse(raw) as { version?: unknown }
    return typeof parsed.version === 'string' ? parsed.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

function parseArgs(argv: readonly string[]): { args: Record<string, unknown>; error?: string } {
  const args: Record<string, unknown> = {}
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]!
    if (token === '--json') {
      args.json = true
      continue
    }
    if (token === '--port') {
      const value = argv[++index]
      if (!value) return { args, error: '--port expects a value' }
      args.port = value
      continue
    }
    if (token.startsWith('--port=')) {
      args.port = token.slice('--port='.length)
      continue
    }
    if (token === '--help' || token === '-h') {
      args.help = true
      continue
    }
    return { args, error: `unknown argument: ${token}` }
  }
  return { args }
}

async function main(): Promise<void> {
  const { args, error } = parseArgs(process.argv.slice(2))
  if (error) {
    process.stderr.write(`${error}\nusage: node bin.js [--port 8788] [--json]\n`)
    process.exit(1)
  }
  if (args.help) {
    process.stdout.write(
      'volund gateway relay (standalone)\nusage: node bin.js [--port 8788] [--json]\n',
    )
    return
  }
  const config = resolveRelayConfig({ args, env: process.env })
  const home = process.env.VOLUND_HOME ?? join(homedir(), '.volund')
  const credentials = await resolveGatewayCredentials(home, process.env)
  const staticDir = mobileAssetDir()

  const server = await createGatewayServer({
    host: config.host,
    port: config.port,
    version: await packageVersion(),
    // relay 的 cwd 关卡以注册实例上报的本机工作区为准；这里只兜底必填字段。
    workspaceCwd: process.cwd(),
    oauth: {
      issuer: 'volund-gateway',
      signingKey: credentials.signingKey,
      tokenTtlSeconds: config.tokenTtlSeconds,
      clients: credentials.clients,
    },
    relay: {
      pairing: new PairingStore({
        signingKey: credentials.signingKey,
        issuer: 'volund-gateway',
        storePath: join(home, 'gateway', 'devices.json'),
        logger: (message) => process.stdout.write(`[gateway] ${message}\n`),
      }),
    },
    ...(staticDir ? { staticDir } : {}),
    ...(process.env.GATEWAY_PUBLIC_URL ? { publicUrl: process.env.GATEWAY_PUBLIC_URL } : {}),
    // 移动站单独部署（不经本网关托管）时的站点公网地址；配对 URL 指向它并带 &gw=。
    ...(process.env.GATEWAY_MOBILE_PUBLIC_URL
      ? { mobilePublicUrl: process.env.GATEWAY_MOBILE_PUBLIC_URL }
      : {}),
    queueTimeoutMs: config.queueTimeoutMs,
    permissionTimeoutMs: config.permissionTimeoutMs,
    maxTurnHoldMs: config.maxTurnHoldMs,
    rateLimitPerMinute: config.rateLimitPerMinute,
    tokenRateLimitPerMinute: config.tokenRateLimitPerMinute,
    corsOrigins: config.corsOrigins,
  })

  const banner = {
    url: server.url,
    mode: 'relay' as const,
    clients: credentials.source,
    endpoints: [
      'POST /oauth/token',
      'POST /v1/chat/completions',
      'GET /v1/models',
      'GET /v1/sessions',
      'GET /v1/ws (websocket)',
      'GET /uplink (websocket, machine dial-out)',
      'POST /pairing/redeem',
    ],
    mobileSite: Boolean(staticDir),
  }
  let stdout = args.json
    ? `${JSON.stringify(banner)}\n`
    : `volund gateway listening on ${server.url} (relay mode)\n` +
      `  oauth clients: ${credentials.source} (${credentials.clients.length})\n` +
      banner.endpoints.map((endpoint) => `  - ${endpoint}`).join('\n') +
      '\n' +
      `  mobile site: ${staticDir ? 'served at /' : 'assets not found (set VOLUND_MOBILE_ASSET_DIR)'}\n` +
      `  devices store: ${join(home, 'gateway', 'devices.json')}\n`
  if (credentials.generated) {
    stdout += args.json
      ? ''
      : `\nbootstrap client created (secret shown ONCE here; only its SHA-256 hash is stored in ${home}/gateway/clients.json):\n` +
        `  client_id:     ${credentials.generated.id}\n` +
        `  client_secret: ${credentials.generated.secret}\n` +
        `  machine scopes: use these credentials on the desktop ([remote] gateway_url/client_id/client_secret)\n`
  }
  if (credentials.migrated && !args.json) {
    stdout += `\nnote: clients.json contained plaintext secrets and was rewritten to hashes.\n`
  }
  process.stdout.write(stdout)

  // 常驻进程：服务句柄 ref 住事件循环；信号收尾（docker stop → SIGTERM）。
  const shutdown = () => {
    void server.close().finally(() => process.exit(0))
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((cause) => {
  process.stderr.write(
    `gateway failed to start: ${cause instanceof Error ? cause.message : String(cause)}\n`,
  )
  process.exit(1)
})
