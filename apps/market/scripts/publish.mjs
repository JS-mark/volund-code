#!/usr/bin/env node
// 把本地插件目录发布到 apollo-market：
//   node scripts/publish.mjs <插件目录> [--base http://127.0.0.1:4315] [--token TOKEN]
// token 也可用 MARKET_ADMIN_TOKEN 环境变量。目录里必须有 manifest.json，
// 校验规则与 volund 宿主 validateManifest 一致（服务端会提前拦截不合规 bundle）。
import { readdir, readFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

const args = process.argv.slice(2)
const dir = args.find((argument) => !argument.startsWith('--'))
if (!dir) {
  console.error('usage: node scripts/publish.mjs <plugin-dir> [--base URL] [--token TOKEN]')
  process.exit(2)
}
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}
const base = flag('base', process.env.MARKET_BASE ?? 'http://127.0.0.1:4315').replace(/\/+$/, '')
const token = flag('token', process.env.MARKET_ADMIN_TOKEN)

const SKIP = new Set(['node_modules', '.git', 'dist', '.next', '.DS_Store'])
async function walk(current) {
  const entries = await readdir(current, { withFileTypes: true })
  const found = []
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    if (entry.isDirectory()) {
      if (SKIP.has(entry.name)) continue
      found.push(...(await walk(join(current, entry.name))))
    } else if (entry.isFile()) {
      found.push(join(current, entry.name))
    }
  }
  return found
}

const paths = await walk(dir)
if (!paths.some((path) => relative(dir, path) === 'manifest.json')) {
  console.error(`no manifest.json in ${dir}`)
  process.exit(1)
}
const files = []
for (const path of paths) {
  files.push({
    path: relative(dir, path).split(sep).join('/'),
    contentBase64: (await readFile(path)).toString('base64'),
  })
}

const response = await fetch(`${base}/api/v1/plugins`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  },
  body: JSON.stringify({ files }),
})
const data = await response.json().catch(() => ({}))
if (!response.ok) {
  console.error(`publish failed: ${data.error ?? response.status}`)
  process.exit(1)
}
console.log(`published ${data.name}@${data.version} → ${base}`)
