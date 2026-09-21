import { unauthorized } from '@/lib/auth'
import { jsonError, matchesQuery, parsePagination } from '@/lib/http'
import { readDatabase, updateDatabase } from '@/lib/store'
import { MAX_CATALOG_ENTRIES, validateSkillInput, ValidationError } from '@/lib/validate'

export const dynamic = 'force-dynamic'

/** Skill 目录列表：q 模糊搜 name/description，按名称排序，分页。 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const query = (url.searchParams.get('q') ?? '').trim().toLowerCase()
  const { page, pageSize } = parsePagination(url)
  const all = Object.values((await readDatabase()).skills)
    .filter((record) => matchesQuery([record.name, record.description], query))
    .sort((a, b) => a.name.localeCompare(b.name))
  return Response.json({
    total: all.length,
    page,
    pageSize,
    items: all.slice((page - 1) * pageSize, page * pageSize),
  })
}

/**
 * 录入/更新 skill 条目（安装走 volund 既有 git 通道，source 须是该通道认的形态）。
 * 重名 = 覆盖更新（发新版本就是换 source/version 再提交一次），保留首次收录时间。
 */
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
    entry = validateSkillInput(body)
  } catch (error) {
    if (error instanceof ValidationError) return jsonError(error.message, 422)
    throw error
  }
  let updated = false
  try {
    await updateDatabase((database) => {
      const existing = database.skills[entry.name]
      updated = existing !== undefined
      if (!existing && Object.keys(database.skills).length >= MAX_CATALOG_ENTRIES)
        throw new ValidationError(`too many skill entries (>${MAX_CATALOG_ENTRIES})`)
      database.skills[entry.name] = {
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
