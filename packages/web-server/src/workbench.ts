/**
 * 工作台（web 右侧面板）的宿主端口：工作区文件树/读取/写入、按名找文件、
 * 内容搜索、git 状态/差异。（终端已独立成交互式 shell 会话，见 terminal.ts。）
 *
 * 全部操作锚定 workspace root：
 * - 路径一律相对 root 解析，归一化后必须仍在 root 内（同 serveStatic 的逃逸门）；
 * - API 面向的路径一律 posix 分隔（与 @ picker 的工作区列表约定一致）；
 * - 读/搜有大小与数量上限，walk 跳过 .git/node_modules 及构建产物目录。
 */
import { execFile } from 'node:child_process'
import { readdir, readFile, rename as fsRename, rm, stat, writeFile, mkdir } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'

/** 单文件读取上限（超出截断并标记）。 */
const MAX_READ_BYTES = 512 * 1024
/** 写入上限（body 门在路由层再卡一道）。 */
const MAX_WRITE_BYTES = 2 * 1024 * 1024
/**
 * 内容搜索/按名查找跳过的目录：依赖与构建产物（等价于编辑器默认 search.exclude —
 * 这些目录通常被 gitignore，且体量能烧光 walk 预算把真实源码挤出结果）。
 * 注意只影响 walk 类操作（find/search）；资源管理器 listDir 不做任何排除。
 */
const WALK_SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  '.next',
  '.turbo',
  'target',
  'dist',
  'out',
  'coverage',
  '.pnpm-store',
])
/** walk 总量上限（防失控遍历巨型工作区）。 */
const WALK_VISIT_LIMIT = 50_000
/** 内容搜索单文件上限（更大文件跳过）。 */
const SEARCH_FILE_MAX_BYTES = 1024 * 1024
const SEARCH_MATCH_LIMIT = 200
const FIND_RESULT_LIMIT = 100
const LIST_ENTRY_LIMIT = 2000
const GIT_TIMEOUT_MS = 10_000

export interface WorkbenchEntry {
  /** posix 相对路径（root 直接子级为纯名字）。 */
  path: string
  name: string
  kind: 'dir' | 'file' | 'other'
  size: number
  mtimeMs: number
}

export interface WorkbenchFileRead {
  path: string
  size: number
  binary: boolean
  truncated: boolean
  content: string
}

export interface WorkbenchSearchMatch {
  path: string
  line: number
  text: string
}

export interface GitStatusEntry {
  path: string
  /** porcelain v1 的两个状态列（原样透传，如 ' M' / 'A ' / '??'）。 */
  x: string
  y: string
  /** 改名场景的原路径。 */
  origPath?: string
}

export interface WorkbenchPort {
  listDir(rel?: string): Promise<{ path: string; entries: WorkbenchEntry[] }>
  readText(rel: string): Promise<WorkbenchFileRead>
  writeText(rel: string, content: string): Promise<{ path: string; size: number }>
  findFiles(query: string): Promise<{ results: { path: string; name: string }[] }>
  searchContent(query: string): Promise<{ matches: WorkbenchSearchMatch[]; truncated: boolean }>
  gitStatus(): Promise<{
    isRepo: boolean
    branch?: string
    entries: GitStatusEntry[]
  }>
  gitDiff(rel?: string): Promise<{ diff: string }>
  // ── 内嵌 vscode workbench 的 FileSystemProvider 后端(代码页)─────────────
  /** 单节点 stat(目录/文件/其他 + size/mtime)。 */
  stat(rel: string): Promise<WorkbenchStat>
  /** 字节读取(base64;图片等二进制预览走这里,上限 2 MiB)。 */
  readBytes(rel: string): Promise<WorkbenchFileBytes>
  /** 字节写入(base64;二进制粘贴/复制保真)。 */
  writeBytes(rel: string, base64: string): Promise<{ path: string; size: number }>
  mkdir(rel: string): Promise<{ path: string }>
  deletePath(rel: string, recursive: boolean): Promise<{ path: string }>
  rename(from: string, to: string): Promise<{ from: string; to: string }>
}

/** fs/stat 返回面。 */
export interface WorkbenchStat {
  path: string
  kind: 'dir' | 'file' | 'other'
  size: number
  mtimeMs: number
}

/** fs/read-bytes 返回面(base64 编码的文件字节;超上限报错而非截断)。 */
export interface WorkbenchFileBytes {
  path: string
  size: number
  base64: string
}

/** 字节读取上限(图片预览场景):与写入上限同量级。 */
const MAX_READ_BYTES_BINARY = 2 * 1024 * 1024

/** 领域错误：带 code 由路由层 failFrom 映射状态码。 */
function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code })
}

export function createWorkbenchPort(rootInput: string): WorkbenchPort {
  const root = resolve(rootInput)

  /** 相对路径 → 绝对路径；逃逸 root（含绝对路径入参）一律拒绝。 */
  const resolveWithin = (rel: string): string => {
    if (rel.includes('\0')) fail('web_schema_invalid', 'path contains NUL')
    const abs = resolve(root, rel)
    if (abs !== root && !abs.startsWith(root + sep))
      fail('web_schema_invalid', `path escapes the workspace: ${rel}`)
    return abs
  }

  /** 绝对路径 → posix 相对路径（根为 ''）。 */
  const toRel = (abs: string): string => relative(root, abs).split(sep).join('/')

  const sniffBinary = (buffer: Buffer): boolean => buffer.includes(0)

  /** 有界 walk：跳过 .git/node_modules，总量封顶；yield 文件的绝对路径。 */
  async function* walk(dir: string, budget: { left: number }): AsyncGenerator<string> {
    if (budget.left <= 0) return
    let dirents
    try {
      dirents = await readdir(dir, { withFileTypes: true })
    } catch {
      return // 无权限/消失的目录跳过
    }
    for (const dirent of dirents) {
      if (budget.left <= 0) return
      budget.left -= 1
      const abs = resolve(dir, dirent.name)
      if (dirent.isDirectory()) {
        if (WALK_SKIP_DIRS.has(dirent.name)) continue
        yield* walk(abs, budget)
      } else if (dirent.isFile()) {
        yield abs
      }
    }
  }

  const runGit = (args: string[]): Promise<{ stdout: string; code: number | null }> =>
    new Promise((resolvePromise, rejectPromise) => {
      execFile(
        'git',
        args,
        { cwd: root, timeout: GIT_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
        (error, stdout) => {
          // git 非零退出（如非仓库）也带 stdout/stderr；调用方按场景判断。
          if (error && (error as { code?: unknown }).code === 'ENOENT') {
            rejectPromise(fail('web_capability_unavailable', 'git is not installed'))
            return
          }
          resolvePromise({
            stdout,
            code: typeof error?.code === 'number' ? error.code : error ? 1 : 0,
          })
        },
      )
    })

  return {
    async listDir(rel = '') {
      const abs = resolveWithin(rel)
      const info = await stat(abs).catch(() => fail('web_schema_invalid', `not found: ${rel}`))
      if (!info.isDirectory()) fail('web_schema_invalid', `not a directory: ${rel}`)
      const dirents = await readdir(abs, { withFileTypes: true })
      const entries: WorkbenchEntry[] = []
      for (const dirent of dirents.slice(0, LIST_ENTRY_LIMIT)) {
        const childAbs = resolve(abs, dirent.name)
        const childStat = await stat(childAbs).catch(() => undefined)
        entries.push({
          path: toRel(childAbs),
          name: dirent.name,
          kind: dirent.isDirectory() ? 'dir' : dirent.isFile() ? 'file' : 'other',
          size: childStat?.size ?? 0,
          mtimeMs: childStat?.mtimeMs ?? 0,
        })
      }
      entries.sort((a, b) =>
        a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1,
      )
      return { path: rel, entries }
    },

    async readText(rel) {
      const abs = resolveWithin(rel)
      const info = await stat(abs).catch(() => fail('web_schema_invalid', `not found: ${rel}`))
      if (!info.isFile()) fail('web_schema_invalid', `not a file: ${rel}`)
      const handle = await readFile(abs)
      const truncated = handle.byteLength > MAX_READ_BYTES
      const slice = truncated ? handle.subarray(0, MAX_READ_BYTES) : handle
      if (sniffBinary(slice.subarray(0, 8192)))
        return { path: rel, size: info.size, binary: true, truncated: false, content: '' }
      return {
        path: rel,
        size: info.size,
        binary: false,
        truncated,
        content: slice.toString('utf8'),
      }
    },

    async writeText(rel, content) {
      if (Buffer.byteLength(content, 'utf8') > MAX_WRITE_BYTES)
        fail('web_attachment_rejected', `content exceeds ${MAX_WRITE_BYTES} bytes`)
      const abs = resolveWithin(rel)
      const info = await stat(abs).catch(() => fail('web_schema_invalid', `not found: ${rel}`))
      if (!info.isFile()) fail('web_schema_invalid', `not a file: ${rel}`)
      await writeFile(abs, content, 'utf8')
      return { path: rel, size: Buffer.byteLength(content, 'utf8') }
    },

    async stat(rel) {
      const abs = resolveWithin(rel)
      const info = await stat(abs).catch(() => fail('web_schema_invalid', `not found: ${rel}`))
      return {
        path: rel,
        kind: info.isDirectory() ? 'dir' : info.isFile() ? 'file' : 'other',
        size: info.size,
        mtimeMs: info.mtimeMs,
      }
    },

    async readBytes(rel) {
      const abs = resolveWithin(rel)
      const info = await stat(abs).catch(() => fail('web_schema_invalid', `not found: ${rel}`))
      if (!info.isFile()) fail('web_schema_invalid', `not a file: ${rel}`)
      if (info.size > MAX_READ_BYTES_BINARY)
        fail('web_attachment_rejected', `content exceeds ${MAX_READ_BYTES_BINARY} bytes`)
      const handle = await readFile(abs)
      return { path: rel, size: info.size, base64: handle.toString('base64') }
    },

    async writeBytes(rel, base64) {
      const buffer = Buffer.from(base64, 'base64')
      if (buffer.byteLength > MAX_WRITE_BYTES)
        fail('web_attachment_rejected', `content exceeds ${MAX_WRITE_BYTES} bytes`)
      const abs = resolveWithin(rel)
      // 与 writeText 不同:允许新建(vscode 新建文件/粘贴图片走这里),父目录必须已存在。
      const info = await stat(abs).catch(() => undefined)
      if (info?.isDirectory()) fail('web_schema_invalid', `is a directory: ${rel}`)
      await writeFile(abs, buffer)
      return { path: rel, size: buffer.byteLength }
    },

    async mkdir(rel) {
      const abs = resolveWithin(rel)
      await mkdir(abs, { recursive: true })
      return { path: rel }
    },

    async deletePath(rel, recursive) {
      // 根目录本身永不删;目录必须显式 recursive。
      if (!rel || rel === '.' || rel === '/')
        fail('web_schema_invalid', 'refusing to delete the workspace root')
      const abs = resolveWithin(rel)
      const info = await stat(abs).catch(() => fail('web_schema_invalid', `not found: ${rel}`))
      if (info.isDirectory() && !recursive)
        fail('web_schema_invalid', `recursive delete requires recursive=true: ${rel}`)
      await rm(abs, { recursive, force: false })
      return { path: rel }
    },

    async rename(from, to) {
      if (!from || !to) fail('web_schema_invalid', 'from and to are required')
      const absFrom = resolveWithin(from)
      const absTo = resolveWithin(to)
      await stat(absFrom).catch(() => fail('web_schema_invalid', `not found: ${from}`))
      // 目标已存在时不覆盖(vscode 侧 overwrite 语义由它自己先 delete)。
      const target = await stat(absTo).catch(() => undefined)
      if (target) fail('web_schema_invalid', `target exists: ${to}`)
      await fsRename(absFrom, absTo)
      return { from, to }
    },

    async findFiles(query) {
      const needle = query.trim().toLowerCase()
      if (!needle) return { results: [] }
      const budget = { left: WALK_VISIT_LIMIT }
      const results: { path: string; name: string }[] = []
      for await (const abs of walk(root, budget)) {
        const relPath = toRel(abs)
        const name = relPath.split('/').pop() ?? relPath
        if (relPath.toLowerCase().includes(needle)) {
          results.push({ path: relPath, name })
          if (results.length >= FIND_RESULT_LIMIT) break
        }
      }
      return { results }
    },

    async searchContent(query) {
      const needle = query.trim().toLowerCase()
      if (!needle) return { matches: [], truncated: false }
      const budget = { left: WALK_VISIT_LIMIT }
      const matches: WorkbenchSearchMatch[] = []
      let truncated = false
      for await (const abs of walk(root, budget)) {
        if (matches.length >= SEARCH_MATCH_LIMIT) {
          truncated = true
          break
        }
        const info = await stat(abs).catch(() => undefined)
        if (!info || info.size > SEARCH_FILE_MAX_BYTES || info.size === 0) continue
        const buffer = await readFile(abs).catch(() => undefined)
        if (!buffer || sniffBinary(buffer.subarray(0, 8192))) continue
        const relPath = toRel(abs)
        const lines = buffer.toString('utf8').split('\n')
        for (let index = 0; index < lines.length; index += 1) {
          const text = lines[index]!
          if (!text.toLowerCase().includes(needle)) continue
          matches.push({ path: relPath, line: index + 1, text: text.slice(0, 300) })
          if (matches.length >= SEARCH_MATCH_LIMIT) {
            truncated = true
            break
          }
        }
      }
      return { matches, truncated }
    },

    async gitStatus() {
      const probe = await runGit(['rev-parse', '--is-inside-work-tree'])
      if (probe.code !== 0) return { isRepo: false, entries: [] }
      const branchOut = await runGit(['branch', '--show-current'])
      const status = await runGit(['status', '--porcelain=v1', '-z'])
      const entries: GitStatusEntry[] = []
      const fields = status.stdout.split('\0').filter((field) => field.length > 0)
      for (let index = 0; index < fields.length; index += 1) {
        const field = fields[index]!
        const x = field[0] ?? ' '
        const y = field[1] ?? ' '
        const path = field.slice(3)
        // 改名/复制：porcelain -z 格式是「XY new\0old」两段。
        if (x === 'R' || x === 'C') {
          const origPath = fields[index + 1]
          index += 1
          entries.push({ path, x, y, ...(origPath ? { origPath } : {}) })
        } else {
          entries.push({ path, x, y })
        }
      }
      const branch = branchOut.stdout.trim()
      return { isRepo: true, ...(branch ? { branch } : {}), entries }
    },

    async gitDiff(rel) {
      // 相对路径同样过逃逸门；HEAD 视图同时覆盖已暂存+未暂存。
      const args = ['diff', '--no-color', 'HEAD', '--']
      if (rel) {
        resolveWithin(rel)
        args.push(rel)
      }
      const out = await runGit(args)
      return { diff: out.stdout }
    },
  }
}
