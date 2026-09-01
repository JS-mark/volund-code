import { access, copyFile, mkdir, open, readdir, realpath, rm } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'

import type { Disposable, PromptComposer } from '@volund/core'
import { parse } from 'yaml'

/** SKILLS-MCPS-r1 §S3.1：标准 skill 名约束（agentskills.io）。 */
const SKILL_NAME_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/
/** SKILLS-MCPS-r1 §S3.1：description 预算（index fragment 内截断；元数据保留全文）。 */
const DESCRIPTION_MAX = 1024
/** SKILLS-MCPS-r1 §S3.4：index fragment 默认字符预算。 */
const DEFAULT_INDEX_BUDGET = 4096

export type SkillScope = 'user' | 'project' | 'plugin'
export interface SkillSource {
  dir: string
  scope: SkillScope
  /** 互操作路径（.agents/skills）：Volund 只读不写。 */
  interop?: boolean
}
export type SkillStatus =
  | 'active'
  | 'available'
  | 'disabled'
  | 'shadowed'
  | 'broken'
  | 'incompatible'
export interface SkillMetadata {
  name: string
  description: string
  volundVersion?: string
  version?: string
  activation?: { manual?: boolean; auto?: Array<{ path_exists?: string; secret?: string }> }
  resources: string[]
  path: string
  scope: SkillScope
  interop?: boolean
  disableModelInvocation: boolean
  userInvocable: boolean
  incompatible: boolean
}
/** SKILLS-MCPS-r1 §S3.3：面板条目（含 shadowed / broken 的完整快照）。 */
export interface SkillEntry extends SkillMetadata {
  status: SkillStatus
  /** shadowed：覆盖者的 scope:name；broken / incompatible：原因。 */
  reason?: string
}
export interface SkillsRuntimeOptions {
  /** 单作用域兼容入口（等价 sources: [{dir, scope: 'user'}]）。 */
  skillsDir?: string
  /**
   * 多作用域发现源，数组顺序即优先级（前者覆盖后者同名）。传函数则每次
   * `discover()` 重新求值（SM-08b：插件捆绑 skills 的目录随安装/启停动态变化）。
   */
  sources?: readonly SkillSource[] | (() => Promise<readonly SkillSource[]>)
  volundVersion: string
  composer: PromptComposer
  /** 持久禁用名单（config [skills] disabled）：不进 index、activate 拒绝。 */
  disabled?: ReadonlySet<string>
  /** index fragment 字符预算（默认 4096）。 */
  indexBudgetChars?: number
  loadMarkdown?: (path: string) => Promise<string>
  onWarning?: (message: string) => void
  /** §S3.8：采样事件（scope_shadowed / standard_schema_rejected），runtime 不依赖具体 sink。 */
  onEvent?: (event: string, payload: Record<string, unknown>) => void
}

/**
 * SKILLS-MCPS-r1 §S3.2 默认发现顺序（高 → 低）：
 * `<cwd>/.volund/skills` > `<cwd>/.agents/skills`（互操作）>
 * `<volundHome>/skills` > `<userHome>/.agents/skills`（互操作）。
 * userHome 独立于 volundHome：VOLUND_HOME 可指向自定义目录，而 `.agents` 互操作
 * 路径约定挂在真实用户主目录（业界事实，Gemini/Codex/Cursor/Copilot 共用）。
 */
export function defaultSkillSources(input: {
  volundHome: string
  userHome: string
  cwd: string
  /** SM-08b：已启用插件捆绑的 skills 目录（<pluginDir>/skills），优先级 project > plugin > user。 */
  pluginDirs?: readonly string[]
}): SkillSource[] {
  return [
    { dir: join(input.cwd, '.volund', 'skills'), scope: 'project' },
    { dir: join(input.cwd, '.agents', 'skills'), scope: 'project', interop: true },
    ...(input.pluginDirs ?? []).map((dir): SkillSource => ({ dir, scope: 'plugin' })),
    { dir: join(input.volundHome, 'skills'), scope: 'user' },
    { dir: join(input.userHome, '.agents', 'skills'), scope: 'user', interop: true },
  ]
}

function frontmatter(text: string): { data: Record<string, unknown>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)
  if (!match) throw new TypeError('SKILL.md requires YAML frontmatter')
  const data = parse(match[1]!)
  if (!data || typeof data !== 'object' || Array.isArray(data))
    throw new TypeError('Invalid frontmatter')
  return { data: data as Record<string, unknown>, body: text.slice(match[0].length) }
}
function requiredString(data: Record<string, unknown>, key: string): string {
  const value = data[key]
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`Skill ${key} is required`)
  return value.trim()
}
function optionalBoolean(data: Record<string, unknown>, key: string): boolean | undefined {
  const value = data[key]
  return typeof value === 'boolean' ? value : undefined
}
function compatible(range: string, version: string): boolean {
  const wanted = /^(?:\^|~)?(\d+)/.exec(range)?.[1]
  const actual = /^(\d+)/.exec(version)?.[1]
  return wanted !== undefined && wanted === actual
}
async function readText(path: string): Promise<string> {
  const file = await open(path, 'r')
  try {
    const stat = await file.stat()
    if (!stat.isFile()) throw new TypeError(`${path} is not a file`)
    return await file.readFile('utf8')
  } finally {
    await file.close()
  }
}

export class SkillsRuntime {
  readonly #sources: readonly SkillSource[] = []
  readonly #skills = new Map<string, SkillMetadata>()
  readonly #shadowed = new Map<
    string,
    { scope: SkillScope; path: string; winner: { scope: SkillScope; path: string } }
  >()
  readonly #broken = new Map<string, string>()
  readonly #active = new Map<string, Disposable>()
  #index?: Disposable
  constructor(readonly options: SkillsRuntimeOptions) {
    if (typeof options.sources === 'function') return // 每次 discover() 求值
    if (options.sources && options.sources.length > 0) this.#sources = options.sources
    else if (options.skillsDir) this.#sources = [{ dir: options.skillsDir, scope: 'user' }]
    else this.#sources = []
  }
  async discover(): Promise<SkillMetadata[]> {
    this.#skills.clear()
    this.#shadowed.clear()
    this.#broken.clear()
    const sources =
      typeof this.options.sources === 'function'
        ? await this.options.sources()
        : (this.options.sources ?? this.#sources)
    for (const source of sources ?? []) {
      let entries
      try {
        entries = await readdir(source.dir, { withFileTypes: true })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw error
      }
      for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isDirectory()) continue
        const path = resolve(source.dir, entry.name, 'SKILL.md')
        try {
          const text = await readText(path)
          const { data } = frontmatter(text)
          const resources = data.resources
          const skill: SkillMetadata = {
            name: requiredString(data, 'name'),
            description: requiredString(data, 'description'),
            resources: Array.isArray(resources)
              ? resources.filter((item): item is string => typeof item === 'string')
              : [],
            path,
            scope: source.scope,
            ...(source.interop ? { interop: true } : {}),
            disableModelInvocation: optionalBoolean(data, 'disable-model-invocation') ?? false,
            userInvocable: optionalBoolean(data, 'user-invocable') ?? true,
            incompatible: false,
          }
          if (typeof data.version === 'string') skill.version = data.version
          // SKILLS-MCPS-r1 §S3.1：volundVersion 双读——存量字段可选，出现才校验。
          if (typeof data.volundVersion === 'string' && data.volundVersion)
            skill.volundVersion = data.volundVersion
          // SKILLS-MCPS-r1 §S3.1：标准约束——name 合法且必须与目录名一致。
          if (!validSkillName(skill.name))
            throw new TypeError(
              `Invalid skill name: ${skill.name} (1-64 chars, lowercase/digits/hyphen, no leading/trailing hyphen, no '--')`,
            )
          if (skill.name !== entry.name)
            throw new TypeError(`Skill name must match its directory name: ${entry.name}`)
          if (this.#skills.has(skill.name)) {
            if (!this.#shadowed.has(skill.name)) {
              const winner = this.#skills.get(skill.name)!
              this.#shadowed.set(skill.name, {
                scope: source.scope,
                path,
                winner: { scope: winner.scope, path: winner.path },
              })
              // §S3.8：同名覆盖采样（scope 数量有限，不涉隐私）。
              this.options.onEvent?.('skill.scope_shadowed', {
                name: skill.name,
                winner_scope: winner.scope,
                loser_scope: source.scope,
              })
            }
            continue
          }
          this.#broken.delete(skill.name)
          this.#skills.set(skill.name, skill)
          if (skill.volundVersion && !compatible(skill.volundVersion, this.options.volundVersion)) {
            skill.incompatible = true
            this.options.onWarning?.(
              `Skill ${skill.name} requires volund ${skill.volundVersion}; running ${this.options.volundVersion}`,
            )
          }
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          if (!this.#skills.has(entry.name)) this.#broken.set(entry.name, reason)
          this.options.onWarning?.(`Failed to discover ${entry.name}: ${reason}`)
          // §S3.8：标准字段校验失败采样（reason 已是 redacted 文本）。
          this.options.onEvent?.('skill.standard_schema_rejected', {
            name: entry.name,
            reason,
          })
        }
      }
    }
    return [...this.#skills.values()]
  }
  async installFromDirectory(
    sourceDir: string,
    options: { scope?: SkillScope } = {},
  ): Promise<SkillMetadata> {
    const sourcePath = resolve(sourceDir, 'SKILL.md')
    const { data } = frontmatter(await readText(sourcePath))
    const name = requiredString(data, 'name')
    if (!validSkillName(name)) throw new TypeError(`Invalid skill name: ${name}`)
    if (name !== basename(resolve(sourceDir)))
      throw new TypeError(`Skill name must match its directory name: ${basename(sourceDir)}`)
    const resources = Array.isArray(data.resources)
      ? data.resources.filter((item): item is string => typeof item === 'string')
      : []
    const sourceRoot = await realpath(sourceDir)
    // SKILLS-MCPS-r1 §S3.2：默认装 user scope；--scope project 装到
    // <cwd>/.volund/skills（可写 = 非 interop 的目标作用域源）。
    const writable = this.#sources.find(
      (source) => !source.interop && source.scope === (options.scope ?? 'user'),
    )
    if (!writable)
      throw new TypeError(`No writable ${options.scope ?? 'user'} skills directory configured`)
    const targetRoot = resolve(writable.dir, name)
    try {
      await mkdir(targetRoot, { recursive: false })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        await mkdir(writable.dir, { recursive: true })
        await mkdir(targetRoot, { recursive: false })
      } else if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new TypeError(`Skill already installed: ${name}`, { cause: error })
      } else throw error
    }
    try {
      await copyFile(sourcePath, resolve(targetRoot, 'SKILL.md'))
      for (const resource of resources) {
        if (isAbsolute(resource))
          throw new TypeError(`Skill resource must be relative: ${resource}`)
        const source = await realpath(resolve(sourceRoot, resource))
        const rel = relative(sourceRoot, source)
        if (rel.startsWith('..') || isAbsolute(rel))
          throw new TypeError(`Skill resource escapes skill directory: ${resource}`)
        const target = resolve(targetRoot, rel)
        await mkdir(resolve(target, '..'), { recursive: true })
        await copyFile(source, target)
      }
    } catch (error) {
      await rm(targetRoot, { recursive: true, force: true })
      throw error
    }
    const installed = (await this.discover()).find((skill) => skill.name === name)
    if (!installed) throw new TypeError(`Installed skill could not be discovered: ${name}`)
    await this.registerIndex()
    return installed
  }
  async registerIndex(): Promise<void> {
    this.#index?.dispose()
    const budget = this.options.indexBudgetChars ?? DEFAULT_INDEX_BUDGET
    this.#index = this.options.composer.register({
      id: 'skills:index',
      source: 'skills:index',
      priority: 850,
      when: () => this.#skills.size > 0,
      text: () => {
        // SKILLS-MCPS-r1 §S3.1：disabled / disable-model-invocation 的 skill 模型不可见。
        // #skills 只含各名字的 winner（同名 loser 进 #shadowed，由面板呈现）。
        const visible = [...this.#skills.values()].filter(
          (skill) => !this.isDisabled(skill.name) && !skill.disableModelInvocation,
        )
        if (visible.length === 0) return ''
        const lines = visible.map(
          (skill) => `- ${skill.name}: ${truncateDescription(skill.description)} (${skill.scope})`,
        )
        // 预算超限时从尾部退化为 name-only 行，保住全部名字（可激活性优先于描述）。
        let text = renderIndex(lines)
        let cursor = lines.length - 1
        while (text.length > budget && cursor >= 1) {
          lines[cursor] = `- ${visible[cursor]!.name} (${visible[cursor]!.scope})`
          text = renderIndex(lines)
          cursor--
        }
        return text
      },
    })
  }
  async activate(name: string): Promise<boolean> {
    if (this.#active.has(name)) return false
    if (this.isDisabled(name)) throw new TypeError(`Skill is disabled: ${name}`)
    const skill = this.#skills.get(name)
    if (!skill) {
      const broken = this.#broken.get(name)
      if (broken) throw new TypeError(`Skill is broken: ${name} (${broken})`)
      throw new TypeError(`Unknown skill: ${name}`)
    }
    const root = await realpath(resolve(skill.path, '..'))
    const load = this.options.loadMarkdown ?? readText
    const raw = await load(skill.path)
    const { body } = frontmatter(raw)
    const resources: string[] = []
    for (const resource of skill.resources) {
      if (isAbsolute(resource)) throw new TypeError(`Skill resource must be relative: ${resource}`)
      const target = await realpath(resolve(root, resource))
      const rel = relative(root, target)
      if (rel.startsWith('..') || isAbsolute(rel))
        throw new TypeError(`Skill resource escapes skill directory: ${resource}`)
      resources.push(`<!-- skill resource: ${resource} -->\n${await load(target)}`)
    }
    this.#active.set(
      name,
      this.options.composer.register({
        id: `skill:${name}`,
        source: `skill:${name}`,
        priority: 800,
        text: [body.trim(), ...resources].filter(Boolean).join('\n\n'),
      }),
    )
    return true
  }
  async activateAutomatic(cwd: string, userText = ''): Promise<string[]> {
    const activated: string[] = []
    for (const skill of this.#skills.values()) {
      if (this.isDisabled(skill.name) || skill.disableModelInvocation) continue
      const rules = skill.activation?.auto ?? []
      if (rules.length === 0) continue
      const matches = await Promise.all(
        rules.map(async (rule) => {
          if (rule.path_exists) {
            try {
              await access(resolve(cwd, rule.path_exists))
              return true
            } catch {
              return false
            }
          }
          return rule.secret
            ? userText.toLocaleLowerCase().includes(rule.secret.toLocaleLowerCase())
            : false
        }),
      )
      if (matches.some(Boolean) && (await this.activate(skill.name))) activated.push(skill.name)
    }
    return activated
  }
  /**
   * SKILLS-MCPS-r1 §S3.3a：一次性调用（invocation）——只读 SKILL.md body（含
   * 目录路径，模型按需自行 Read resources），**不**注册 composer fragment、
   * 不改会话 system prompt。业界 `/skill-name` 语义。
   */
  async readInvocation(name: string): Promise<{ name: string; directory: string; body: string }> {
    if (this.isDisabled(name)) throw new TypeError(`Skill is disabled: ${name}`)
    const skill = this.#skills.get(name)
    if (!skill) {
      const broken = this.#broken.get(name)
      if (broken) throw new TypeError(`Skill is broken: ${name} (${broken})`)
      throw new TypeError(`Unknown skill: ${name}`)
    }
    const load = this.options.loadMarkdown ?? readText
    const { body } = frontmatter(await load(skill.path))
    const directory = await realpath(resolve(skill.path, '..'))
    return { name, directory, body: body.trim() }
  }
  deactivate(name: string): boolean {
    const active = this.#active.get(name)
    if (!active) return false
    active.dispose()
    this.#active.delete(name)
    return true
  }
  active(): string[] {
    return [...this.#active.keys()].toSorted()
  }
  /** SKILLS-MCPS-r1 §S3.3：面板快照——winners + shadowed + broken 全量。 */
  entries(): SkillEntry[] {
    const result: SkillEntry[] = []
    for (const skill of this.#skills.values()) {
      const status: SkillStatus = this.isDisabled(skill.name)
        ? 'disabled'
        : this.#active.has(skill.name)
          ? 'active'
          : skill.incompatible
            ? 'incompatible'
            : 'available'
      result.push({
        ...skill,
        status,
        ...(skill.incompatible ? { reason: `requires volund ${skill.volundVersion}` } : {}),
      })
    }
    for (const [name, shadow] of this.#shadowed) {
      result.push({
        name,
        description: '',
        resources: [],
        path: shadow.path,
        scope: shadow.scope,
        disableModelInvocation: false,
        userInvocable: true,
        incompatible: false,
        status: 'shadowed',
        reason: `shadowed by ${shadow.winner.scope} skill at ${shadow.winner.path}`,
      })
    }
    for (const [name, reason] of this.#broken) {
      result.push({
        name,
        description: '',
        resources: [],
        path: '',
        scope: 'user',
        disableModelInvocation: false,
        userInvocable: true,
        incompatible: false,
        status: 'broken',
        reason,
      })
    }
    return result.toSorted((a, b) => a.name.localeCompare(b.name))
  }
  isDisabled(name: string): boolean {
    return this.options.disabled?.has(name) ?? false
  }
  dispose(): void {
    this.#index?.dispose()
    for (const item of this.#active.values()) item.dispose()
    this.#active.clear()
  }
}

function validSkillName(name: string): boolean {
  return name.length <= 64 && !name.includes('--') && SKILL_NAME_PATTERN.test(name)
}
function truncateDescription(description: string): string {
  return description.length <= DESCRIPTION_MAX
    ? description
    : `${description.slice(0, DESCRIPTION_MAX - 1)}…`
}
function renderIndex(lines: string[]): string {
  return `Available skills (activate via /skill activate <name>):\n${lines.join('\n')}`
}
