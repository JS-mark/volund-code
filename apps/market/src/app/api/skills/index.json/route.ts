import { readDatabase } from '@/lib/store'
import type { SkillIndex } from '@/lib/types'
import { MAX_CATALOG_ENTRIES } from '@/lib/validate'

export const dynamic = 'force-dynamic'

/** volund `[skills] market` 契约端点：`{version: 1, entries: […]}`，与 parseSkillMarketIndex 同形。 */
export async function GET(): Promise<Response> {
  const database = await readDatabase()
  const entries = Object.values(database.skills)
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, MAX_CATALOG_ENTRIES)
    .map(({ name, description, version, source, homepage }) => ({
      name,
      source,
      ...(description ? { description } : {}),
      ...(version ? { version } : {}),
      ...(homepage ? { homepage } : {}),
    }))
  const index: SkillIndex = { version: 1, entries }
  return Response.json(index, { headers: { 'cache-control': 'no-store' } })
}
