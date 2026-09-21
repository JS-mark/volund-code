import { unauthorized } from '@/lib/auth'
import { byRecency, ConflictError, jsonError, matchesQuery, parsePagination } from '@/lib/http'
import { readDatabase, removeBundleVersion, updateDatabase, writeBundleFiles } from '@/lib/store'
import { MAX_PLUGINS, validatePluginPublish, ValidationError } from '@/lib/validate'

export const dynamic = 'force-dynamic'

/** 管理列表：q 模糊搜 name/description/publisher，分页，附最新版摘要。 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const query = (url.searchParams.get('q') ?? '').trim().toLowerCase()
  const { page, pageSize } = parsePagination(url)
  const database = await readDatabase()
  const all = Object.values(database.plugins)
    .filter((record) => matchesQuery([record.name, record.description, record.publisher], query))
    .sort(byRecency)
  const items = all.slice((page - 1) * pageSize, page * pageSize).map((record) => {
    const latest = record.versions.at(-1)
    return {
      name: record.name,
      version: latest?.version ?? '',
      description: record.description,
      publisher: record.publisher,
      downloads: record.downloads,
      updatedAt: record.updatedAt,
      fileCount: latest?.files.length ?? 0,
      versionCount: record.versions.length,
    }
  })
  return Response.json({ total: all.length, page, pageSize, items })
}

/** 发布新版本：bundle 先落盘再入库；同名同版本 409，插件总数超客户端上限 422。 */
export async function POST(request: Request): Promise<Response> {
  const denied = unauthorized(request)
  if (denied) return denied
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return jsonError('body must be valid JSON', 400)
  }
  let input
  try {
    input = validatePluginPublish(body)
  } catch (error) {
    if (error instanceof ValidationError) return jsonError(error.message, 422)
    throw error
  }
  const name = String(input.manifest.name)
  try {
    await writeBundleFiles(name, input.version.version, input.files)
    const published = await updateDatabase((database) => {
      const existing = database.plugins[name]
      if (existing?.versions.some((version) => version.version === input.version.version))
        throw new ConflictError(`${name}@${input.version.version} already exists; bump the version`)
      if (!existing && Object.keys(database.plugins).length >= MAX_PLUGINS)
        throw new ValidationError(`too many plugins (>${MAX_PLUGINS})`)
      const description =
        typeof input.manifest.description === 'string' && input.manifest.description.trim()
          ? input.manifest.description
          : existing?.description
      const publisher = input.publisher ?? existing?.publisher
      const now = new Date().toISOString()
      database.plugins[name] = {
        name,
        ...(publisher ? { publisher } : {}),
        ...(description ? { description } : {}),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        downloads: existing?.downloads ?? 0,
        versions: [...(existing?.versions ?? []), input.version],
      }
      return { name, version: input.version.version }
    })
    return Response.json({ ok: true, ...published }, { status: 201 })
  } catch (error) {
    await removeBundleVersion(name, input.version.version)
    if (error instanceof ConflictError) return jsonError(error.message, 409)
    if (error instanceof ValidationError) return jsonError(error.message, 422)
    throw error
  }
}
