/**
 * 写接口鉴权：Bearer token 恒时比较。读接口（浏览/索引/下载）完全公开——
 * volund 客户端拉索引不带凭据。MARKET_ADMIN_TOKEN 未设置时写接口整体关闭（fail closed）。
 */
import { timingSafeEqual } from 'node:crypto'

export const ADMIN_TOKEN_ENV = 'MARKET_ADMIN_TOKEN'

export function unauthorized(request: Request): Response | undefined {
  const token = process.env[ADMIN_TOKEN_ENV]
  if (!token)
    return Response.json(
      { error: `${ADMIN_TOKEN_ENV} not configured; write endpoints are disabled` },
      { status: 503 },
    )
  const header = request.headers.get('authorization') ?? ''
  const match = /^Bearer (.+)$/s.exec(header)
  const given = match?.[1] ?? ''
  const a = createDigest(given)
  const b = createDigest(token)
  if (given && a.length === b.length && timingSafeEqual(a, b)) return undefined
  return Response.json({ error: 'unauthorized' }, { status: 401 })
}

const createDigest = (value: string) => Buffer.from(value, 'utf8')
