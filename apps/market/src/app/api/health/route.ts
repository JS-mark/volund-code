import { readDatabase } from '@/lib/store'

export const dynamic = 'force-dynamic'

/** 存活 + 库规模速览。 */
export async function GET(): Promise<Response> {
  const database = await readDatabase()
  return Response.json({
    ok: true,
    seededAt: database.seededAt,
    counts: {
      plugins: Object.keys(database.plugins).length,
      skills: Object.keys(database.skills).length,
      mcp: Object.keys(database.mcp).length,
    },
  })
}
