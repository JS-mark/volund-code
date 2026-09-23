/**
 * 把 typedoc 产物 api/ 镜像到 zh/api/，让中文站（/zh/）拥有与英文 API 区一一对应的路由。
 * 每个镜像页顶部注入中文提示横幅；手写的 zh/api/README.md（中文总览）不被覆盖。
 * 由 apps/docs 的 build 脚本在 docs:api（typedoc）之后、vitepress build 之前运行。
 */
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const docsRoot = dirname(dirname(fileURLToPath(import.meta.url))) // apps/docs
const srcRoot = join(docsRoot, 'api')
const destRoot = join(docsRoot, 'zh', 'api')
const OVERVIEW = 'README.md' // 中文总览为手写文件，镜像时跳过

const banner = (_depth) =>
  `> **注：** 本页为 TypeDoc 自动生成的 API 参考，内容为英文。中文导读见 [API 总览](/zh/api/README)。\n\n`

async function collect(dir) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await collect(full)))
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full)
  }
  return out
}

// 手写总览保留：整目录重建前取出，完成后写回（typedoc 不会生成 zh/api/README.md）
let overview
try {
  overview = await readFile(join(destRoot, OVERVIEW), 'utf8')
} catch {
  // 首次运行尚无总览
}

await rm(destRoot, { recursive: true, force: true })
await mkdir(destRoot, { recursive: true })
if (overview !== undefined) await writeFile(join(destRoot, OVERVIEW), overview)

const files = (await collect(srcRoot)).filter((file) => relative(srcRoot, file) !== OVERVIEW)
for (const file of files) {
  const rel = relative(srcRoot, file)
  const target = join(destRoot, rel)
  await mkdir(dirname(target), { recursive: true })
  const depth = rel.split(sep).length - 1
  const content = await readFile(file, 'utf8')
  await writeFile(target, `${banner(depth)}${content}`)
}

// 汇总
const written = files.length
console.log(`[mirror-api-zh] ${written} 页已镜像到 zh/api/（含中文提示横幅；README.md 为手写总览）`)
