import { readDatabase } from '@/lib/store'
import type { PluginIndex } from '@/lib/types'
import { MAX_PLUGINS } from '@/lib/validate'

export const dynamic = 'force-dynamic'

/**
 * volund `[plugins] market` 契约端点：`{schemaVersion: 1, plugins: […]}`，
 * 与 app-runtime parseMarketIndex 同形。客户端把本 URL 配进 config.toml 后，
 * 逐文件下载走同源 `/api/plugins/<name>/<path>`；≤256 条（客户端硬上限），
 * 按更新时间倒序，只发每插件最新版本。
 */
export async function GET(): Promise<Response> {
  const database = await readDatabase()
  const plugins = Object.values(database.plugins)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, MAX_PLUGINS)
    .map((record) => {
      const latest = record.versions.at(-1)
      if (!latest) return undefined
      return {
        name: record.name,
        version: latest.version,
        ...(record.description ? { description: record.description } : {}),
        ...(record.publisher ? { publisher: record.publisher } : {}),
        files: latest.files,
      }
    })
    .filter((entry) => entry !== undefined)
  const index: PluginIndex = { schemaVersion: 1, plugins }
  return Response.json(index, { headers: { 'cache-control': 'no-store' } })
}
