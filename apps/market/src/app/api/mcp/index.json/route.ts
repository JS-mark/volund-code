import { readDatabase } from '@/lib/store'
import type { McpIndex } from '@/lib/types'
import { MAX_CATALOG_ENTRIES } from '@/lib/validate'

export const dynamic = 'force-dynamic'

/** volund `[mcp] market` 契约端点：`{version: 1, entries: […]}`，与 parseMcpMarketIndex 同形。 */
export async function GET(): Promise<Response> {
  const database = await readDatabase()
  const entries = Object.values(database.mcp)
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, MAX_CATALOG_ENTRIES)
    .map(
      ({ name, description, version, transport, url, headers, command, args, env, homepage }) => ({
        name,
        transport,
        ...(description ? { description } : {}),
        // 客户端 v1 解析器忽略未知字段；带上供展示与未来版本读取
        ...(version ? { version } : {}),
        ...(url ? { url } : {}),
        ...(headers ? { headers } : {}),
        ...(command ? { command } : {}),
        ...(args ? { args } : {}),
        ...(env ? { env } : {}),
        ...(homepage ? { homepage } : {}),
      }),
    )
  const index: McpIndex = { version: 1, entries }
  return Response.json(index, { headers: { 'cache-control': 'no-store' } })
}
