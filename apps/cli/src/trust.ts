import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'

export type TrustScope = 'exact' | 'tree'
export interface TrustRule {
  path: string
  scope: TrustScope
  trustedAt: string
}
export interface TrustCheck {
  canonicalPath: string
  trusted: boolean
  matchedPath?: string
  scope?: TrustScope
}
export type TrustGateResult =
  | { status: 'trusted'; canonicalPath: string; scope: TrustScope; persisted: true }
  | { status: 'denied'; canonicalPath: string; reason: 'user-exit' | 'non-interactive' }

interface TrustDocument {
  version: 1
  rules: TrustRule[]
}

const emptyDocument = (): TrustDocument => ({ version: 1, rules: [] })

export class DirectoryTrustStore {
  readonly filePath: string
  readonly lockPath: string

  constructor(readonly configDir = join(homedir(), '.volund')) {
    this.filePath = join(configDir, 'trusted-directories.json')
    this.lockPath = `${this.filePath}.lock`
  }

  async canonicalize(path: string): Promise<string> {
    return realpath(resolve(path))
  }

  async check(path: string): Promise<TrustCheck> {
    const canonicalPath = await this.canonicalize(path)
    const { document } = await this.readDocument()
    const rule = document.rules.find(
      (candidate) =>
        candidate.path === canonicalPath ||
        (candidate.scope === 'tree' && isWithin(candidate.path, canonicalPath)),
    )
    return rule
      ? { canonicalPath, trusted: true, matchedPath: rule.path, scope: rule.scope }
      : { canonicalPath, trusted: false }
  }

  async grant(path: string, scope: TrustScope): Promise<TrustRule> {
    const canonicalPath = await this.canonicalize(path)
    assertSafeTrustTarget(canonicalPath)
    const rule = {
      path: canonicalPath,
      scope,
      trustedAt: new Date().toISOString(),
    } satisfies TrustRule
    await this.mutate((document) => {
      document.rules = document.rules.filter((item) => item.path !== canonicalPath)
      document.rules.push(rule)
    })
    return rule
  }

  async list(): Promise<TrustRule[]> {
    return (await this.readDocument()).document.rules
  }

  async revoke(path: string): Promise<number> {
    const canonicalPath = await this.canonicalize(path)
    let removed = 0
    await this.mutate((document) => {
      const before = document.rules.length
      document.rules = document.rules.filter((item) => item.path !== canonicalPath)
      removed = before - document.rules.length
    })
    return removed
  }

  async revokeAll(): Promise<number> {
    let removed = 0
    await this.mutate((document) => {
      removed = document.rules.length
      document.rules = []
    })
    return removed
  }

  private async mutate(update: (document: TrustDocument) => void): Promise<void> {
    await mkdir(this.configDir, { recursive: true, mode: 0o700 })
    await this.withLock(async () => {
      const { corrupt, document, source } = await this.readDocument()
      if (corrupt && source !== undefined)
        await writeFile(`${this.filePath}.corrupt`, source, { mode: 0o600 })
      update(document)
      document.rules.sort((a, b) => a.path.localeCompare(b.path) || a.scope.localeCompare(b.scope))
      const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`
      await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 })
      await rename(temporary, this.filePath)
    })
  }

  private async readDocument(): Promise<{
    corrupt: boolean
    document: TrustDocument
    source?: string
  }> {
    let source: string
    try {
      source = await readFile(this.filePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return { corrupt: false, document: emptyDocument() }
      throw error
    }
    try {
      const value = JSON.parse(source) as Partial<TrustDocument>
      if (value.version !== 1 || !Array.isArray(value.rules))
        throw new Error('invalid trust schema')
      const rules = value.rules.filter(isTrustRule)
      if (rules.length !== value.rules.length) throw new Error('invalid trust rule')
      return { corrupt: false, document: { version: 1, rules } }
    } catch {
      return { corrupt: true, document: emptyDocument(), source }
    }
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      try {
        const handle = await open(this.lockPath, 'wx', 0o600)
        try {
          return await operation()
        } finally {
          await handle.close()
          await rm(this.lockPath, { force: true })
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        await new Promise((resolveWait) => setTimeout(resolveWait, 10))
      }
    }
    throw new Error('Timed out waiting for the directory trust store lock')
  }
}

function isTrustRule(value: unknown): value is TrustRule {
  if (!value || typeof value !== 'object') return false
  const rule = value as Partial<TrustRule>
  return (
    typeof rule.path === 'string' &&
    isAbsolute(rule.path) &&
    (rule.scope === 'exact' || rule.scope === 'tree') &&
    typeof rule.trustedAt === 'string'
  )
}

function isWithin(parent: string, child: string): boolean {
  const result = relative(parent, child)
  return result === '' || (!result.startsWith('..') && !isAbsolute(result))
}

function assertSafeTrustTarget(path: string): void {
  const home = resolve(homedir())
  const root = resolve(path, '..') === path
  const sensitive = [join(home, '.volund'), join(home, '.ssh'), '/etc'].some(
    (prefix) => path === prefix || isWithin(prefix, path),
  )
  if (root || path === home || sensitive)
    throw new Error(`Refusing to trust a sensitive directory scope: ${path}`)
}
