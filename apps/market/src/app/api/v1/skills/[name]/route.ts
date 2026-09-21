import { unauthorized } from '@/lib/auth'
import { jsonError } from '@/lib/http'
import { readDatabase, updateDatabase } from '@/lib/store'

export const dynamic = 'force-dynamic'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ name: string }> },
): Promise<Response> {
  const { name } = await params
  const record = (await readDatabase()).skills[name]
  if (!record) return jsonError(`skill not found: ${name}`, 404)
  return Response.json(record)
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ name: string }> },
): Promise<Response> {
  const denied = unauthorized(request)
  if (denied) return denied
  const { name } = await params
  const removed = await updateDatabase((database) => {
    if (!database.skills[name]) return false
    delete database.skills[name]
    return true
  })
  if (!removed) return jsonError(`skill not found: ${name}`, 404)
  return Response.json({ ok: true, name })
}
