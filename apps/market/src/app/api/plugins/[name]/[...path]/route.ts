import { jsonError } from '@/lib/http'
import { readBundleFile, readDatabase, updateDatabase } from '@/lib/store'

export const dynamic = 'force-dynamic'

const PLUGIN_NAME = /^volund-plugin-[a-z0-9][a-z0-9._-]{0,127}$/

/**
 * 插件文件下载（客户端契约）：索引 URL origin 下 `<name>/<path>`，同源约束由
 * 客户端强制。服务端只发该插件最新版本里索引列出的文件（manifest.json /
 * index.mjs / …），逐个命中 MarketFileSpec——路径不在索引内一律 404，
 * 防止把存储目录变成任意文件读。命中即计一次 downloads（≈安装文件数）。
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ name: string; path: string[] }> },
): Promise<Response> {
  const { name, path } = await params
  const relative = path.join('/')
  if (!PLUGIN_NAME.test(name)) return jsonError(`unsafe plugin name: ${name}`, 400)
  const database = await readDatabase()
  const record = database.plugins[name]
  if (!record) return jsonError(`plugin not found: ${name}`, 404)
  const latest = record.versions.at(-1)
  if (!latest) return jsonError(`plugin has no versions: ${name}`, 404)
  const spec = latest.files.find((file) => file.path === relative)
  if (!spec) return jsonError(`file not in published bundle: ${relative}`, 404)
  let bytes: Buffer
  try {
    bytes = await readBundleFile(name, latest.version, spec.path)
  } catch {
    return jsonError(`bundle file missing: ${relative}`, 500)
  }
  await updateDatabase((db) => {
    const current = db.plugins[name]
    if (current) db.plugins[name] = { ...current, downloads: current.downloads + 1 }
  })
  return new Response(new Uint8Array(bytes), {
    headers: {
      'content-type': 'application/octet-stream',
      'content-length': String(bytes.byteLength),
      'x-content-digest': spec.digest,
      'cache-control': 'no-store',
    },
  })
}
