/**
 * Skill 安装解析器（P1-04c）：`<本地目录>` / git URL / github: 简写 → 目录列表。
 * 从 apps/cli/src/mcp.ts 迁入，行为等价。
 */
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

async function collectSkillDirectories(root: string): Promise<string[]> {
  const SKIP = new Set([
    'node_modules',
    'vendor',
    'dist',
    'build',
    'out',
    'target',
    'coverage',
    '__pycache__',
  ])
  const found: string[] = []
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true })
    // 目录里先有 SKILL.md 就收（不再深入——skill 目录是叶子，内部 resources/ 不再扫描）
    for (const entry of entries) {
      if (entry.isFile() && entry.name === 'SKILL.md') {
        found.push(dir)
        return
      }
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || SKIP.has(entry.name)) continue
      await walk(join(dir, entry.name))
    }
  }
  await walk(root)
  return found.sort((a, b) => a.localeCompare(b))
}

/**
 * 解析 GitHub 子目录 spec（WEB-EXT-MANAGE-MARKET-r1 r1.3：市场单 skill 安装）：
 * `https://github.com/<owner>/<repo>/tree/<branch>/<path>` 或
 * `github:<owner>/<repo>/tree/<branch>/<path>` → { repo, branch, path }；非 tree 形态 → undefined。
 */
export function parseGithubTreeSpec(
  spec: string,
): { repoUrl: string; subpath: string } | undefined {
  const normalized = spec.startsWith('github:')
    ? `https://github.com/${spec.slice('github:'.length)}`
    : spec
  const match =
    /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/tree\/([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(
      normalized,
    )
  if (!match) return undefined
  const [, owner, repo, , subpath] = match
  if (!owner || !repo || !subpath) return undefined
  return {
    repoUrl: `https://github.com/${owner}/${repo}.git`,
    subpath: subpath.replace(/\/+$/, ''),
  }
}

export async function resolveSkillSpecToDirectories(
  spec: string,
  options: { onInfo?: (message: string) => void } = {},
): Promise<{ directories: string[]; cleanup: () => Promise<void> }> {
  const isGitSpec =
    spec.startsWith('https://') ||
    spec.startsWith('git@') ||
    spec.startsWith('github:') ||
    spec.startsWith('file://') ||
    /^\w[\w.-]*\/\w[\w.-]*$/.test(spec)
  if (!isGitSpec) return { directories: [spec], cleanup: async () => {} }
  // 市场单 skill 安装（r1.3）：github tree URL = 仓库内单个 skill 目录，
  // 只装该目录（不扫全仓）。
  const tree = parseGithubTreeSpec(spec)
  if (tree) {
    options.onInfo?.(`cloning ${tree.repoUrl} (subpath ${tree.subpath})`)
    const temporary = await mkdtemp(join(tmpdir(), 'volund-skill-'))
    const cleanup = () => rm(temporary, { recursive: true, force: true })
    try {
      await execFileAsync('git', ['clone', '--quiet', '--depth', '1', tree.repoUrl, temporary], {
        timeout: 120_000,
      })
      const sub = join(temporary, ...tree.subpath.split('/'))
      try {
        await readFile(join(sub, 'SKILL.md'), 'utf8')
      } catch {
        throw new Error(`No SKILL.md at ${tree.subpath} in ${tree.repoUrl}`)
      }
      return { directories: [sub], cleanup }
    } catch (error) {
      await cleanup()
      throw error
    }
  }
  let url = spec
  if (spec.startsWith('github:')) url = `https://github.com/${spec.slice('github:'.length)}.git`
  else if (!spec.startsWith('https://') && !spec.startsWith('git@') && !spec.startsWith('file://'))
    url = `https://github.com/${spec}.git`
  options.onInfo?.(`cloning ${url}`)
  const temporary = await mkdtemp(join(tmpdir(), 'volund-skill-'))
  const cleanup = () => rm(temporary, { recursive: true, force: true })
  try {
    await execFileAsync('git', ['clone', '--quiet', '--depth', '1', url, temporary], {
      timeout: 120_000,
    })
    // 根有 SKILL.md → 装 root;否则递归扫描（任意深度,装全部命中目录）
    try {
      await readFile(join(temporary, 'SKILL.md'), 'utf8')
      return { directories: [temporary], cleanup }
    } catch {
      const withSkill = await collectSkillDirectories(temporary)
      if (withSkill.length === 0) throw new Error(`No SKILL.md found in ${spec}`)
      return { directories: withSkill, cleanup }
    }
  } catch (error) {
    await cleanup()
    throw error
  }
}
