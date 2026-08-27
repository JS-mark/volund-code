import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'

import { onTestFinished } from 'vitest'

export interface TempvolundHomeOptions {
  /** `config.toml` content: a raw TOML string or a serializable object. */
  readonly config?: string | Record<string, unknown>
  /** Raw content written to `credentials.enc`. */
  readonly credentials?: string
  /** Extra files created under `.volund/`, keyed by relative path. */
  readonly files?: Record<string, string>
}

export interface TempvolundHome {
  /** The temporary HOME directory (inside `os.tmpdir()`). */
  readonly home: string
  /** `<home>/.volund` — the directory volund-code treats as its home. */
  readonly volundDir: string
  readonly configPath: string
  readonly credentialsPath: string
  /** Restore the original environment and delete the temporary directory. */
  restore(): Promise<void>
}

/**
 * Env keys redirected for the duration of a test and restored afterwards.
 *
 * `HOME`/`USERPROFILE` cover `os.homedir()`; `VOLUND_HOME` is pinned inside the
 * temp dir so a developer machine's exported `VOLUND_HOME` cannot leak in (the
 * runtime checks it before falling back to `homedir()/.volund`).
 */
const ENV_KEYS = ['HOME', 'USERPROFILE', 'VOLUND_HOME'] as const

/**
 * Per-test isolated volund home (spec 06d-testkit §6.13.3).
 *
 * Creates a fresh tmpdir, points `HOME`/`USERPROFILE`/`VOLUND_HOME` into it,
 * and prefills `<home>/.volund` with the requested `config.toml` /
 * `credentials.enc` plus any extra `files`. When called inside a running
 * vitest test, teardown is registered via `onTestFinished`; `restore()` is
 * always available for manual or non-vitest use and is idempotent.
 */
export async function tempvolundHome(options: TempvolundHomeOptions = {}): Promise<TempvolundHome> {
  const home = await mkdtemp(join(tmpdir(), 'volund-testkit-'))
  const volundDir = join(home, '.volund')
  const configPath = join(volundDir, 'config.toml')
  const credentialsPath = join(volundDir, 'credentials.enc')
  try {
    await mkdir(volundDir, { recursive: true })
    if (options.config !== undefined) {
      const content = typeof options.config === 'string' ? options.config : toToml(options.config)
      await writeFile(configPath, content, 'utf8')
    }
    if (options.credentials !== undefined) {
      await writeFile(credentialsPath, options.credentials, 'utf8')
    }
    for (const [path, content] of Object.entries(options.files ?? {})) {
      const target = resolve(volundDir, path)
      const offset = relative(volundDir, target)
      if (offset.startsWith('..') || offset === '') throw new Error(`testkit_path_escape: ${path}`)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, content, 'utf8')
    }
  } catch (error) {
    await rm(home, { recursive: true, force: true })
    throw error
  }
  const snapshot = new Map<string, string | undefined>(
    ENV_KEYS.map((key) => [key, process.env[key]]),
  )
  process.env.HOME = home
  process.env.USERPROFILE = home
  process.env.VOLUND_HOME = volundDir
  let restored = false
  const restore = async (): Promise<void> => {
    if (restored) return
    restored = true
    for (const [key, value] of snapshot) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(home, { recursive: true, force: true })
  }
  try {
    onTestFinished(async () => {
      await restore()
    })
  } catch {
    // Called outside a running vitest test: the caller owns restore().
  }
  return { home, volundDir, configPath, credentialsPath, restore }
}

const BARE_KEY = /^[A-Za-z0-9_-]+$/

function tomlKey(key: string): string {
  return BARE_KEY.test(key) ? key : `"${key.replaceAll('"', '\\"')}"`
}

function isTable(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function tomlScalar(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`toml_unsupported_number: ${value}`)
    return String(value)
  }
  if (typeof value === 'boolean') return String(value)
  if (value instanceof Date) return JSON.stringify(value.toISOString())
  throw new Error(`toml_unsupported_type: ${typeof value}`)
}

function renderTable(table: Record<string, unknown>, path: string): string {
  const scalars: string[] = []
  const subtables: Array<{ path: string; table: Record<string, unknown>; array: boolean }> = []
  for (const [key, value] of Object.entries(table)) {
    if (value === null || value === undefined) continue
    const keyPath = path ? `${path}.${tomlKey(key)}` : tomlKey(key)
    if (isTable(value)) {
      subtables.push({ path: keyPath, table: value, array: false })
    } else if (Array.isArray(value) && value.length > 0 && value.every(isTable)) {
      for (const element of value) subtables.push({ path: keyPath, table: element, array: true })
    } else if (Array.isArray(value)) {
      scalars.push(`${tomlKey(key)} = [${value.map(tomlScalar).join(', ')}]`)
    } else {
      scalars.push(`${tomlKey(key)} = ${tomlScalar(value)}`)
    }
  }
  let out = scalars.length > 0 ? `${scalars.join('\n')}\n` : ''
  for (const subtable of subtables) {
    out += `\n${subtable.array ? '[[' : '['}${subtable.path}${subtable.array ? ']]' : ']'}\n${renderTable(subtable.table, subtable.path)}`
  }
  return out
}

/** Minimal TOML serializer for plain nested objects (test fixture quality). */
function toToml(value: Record<string, unknown>): string {
  return renderTable(value, '').replace(/^\n/, '')
}
