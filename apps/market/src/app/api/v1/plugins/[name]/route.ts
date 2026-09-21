import { unauthorized } from '@/lib/auth'
import { jsonError } from '@/lib/http'
import { readDatabase, removeBundle, updateDatabase } from '@/lib/store'

export const dynamic = 'force-dynamic'

/** 插件详情：全部版本、最新版 manifest 与文件清单（含 digest）、readme。 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ name: string }> },
): Promise<Response> {
  const { name } = await params
  const record = (await readDatabase()).plugins[name]
  if (!record) return jsonError(`plugin not found: ${name}`, 404)
  return Response.json(record)
}

/** 删除插件：全部版本 + bundle 落盘文件。 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ name: string }> },
): Promise<Response> {
  const denied = unauthorized(request)
  if (denied) return denied
  const { name } = await params
  const removed = await updateDatabase((database) => {
    const record = database.plugins[name]
    if (!record) return false
    delete database.plugins[name]
    return true
  })
  if (!removed) return jsonError(`plugin not found: ${name}`, 404)
  await removeBundle(name)
  return Response.json({ ok: true, name })
}
