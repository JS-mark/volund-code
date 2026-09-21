import { unauthorized } from '@/lib/auth'
import { jsonError, matchesQuery, parsePagination } from '@/lib/http'
import { readDatabase, updateDatabase } from '@/lib/store'
import { MAX_CATALOG_ENTRIES, validateMcpInput, ValidationError } from '@/lib/validate'

export const dynamic = 'force-dynamic'

/** MCP 目录列表：q 模糊搜 name/description，按名称排序，分页。 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const query = (url.searchParams.get('q') ?? '').trim().toLowerCase()
  const { page, pageSize } = parsePagination(url)
  const all = Object.values((await readDatabase()).mcp)
    .filter((record) => matchesQuery([record.name, record.description], query))
    .sort((a, b) => a.name.localeCompare(b.name))
  return Response.json({
    total: all.length,
    page,
    pageSize,
    items: all.slice((page - 1) * pageSize, page * pageSize),
  })
}

/** 录入 MCP 条目（安装 = 客户端预填 add 表单、用户确认后落盘）。 */
export async function POST(request: Request): Promise<Response> {
  const denied = unauthorized(request)
  if (denied) return denied
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return jsonError('body must be valid JSON', 400)
  }
  let entry
  try {
    entry = validateMcpInput(body)
  } catch (error) {
    if (error instanceof ValidationError) return jsonError(error.message, 422)
    throw error
  }
  let updated = false
  try {
    await updateDatabase((database) => {
      const existing = database.mcp[entry.name]
      updated = existing !== undefined
      if (!existing && Object.keys(database.mcp).length >= MAX_CATALOG_ENTRIES)
        throw new ValidationError(`too many mcp entries (>${MAX_CATALOG_ENTRIES})`)
      database.mcp[entry.name] = {
        ...entry,
        addedAt: existing?.addedAt ?? new Date().toISOString(),
      }
    })
  } catch (error) {
    if (error instanceof ValidationError) return jsonError(error.message, 422)
    throw error
  }
  return Response.json({ ok: true, name: entry.name, updated }, { status: updated ? 200 : 201 })
}
