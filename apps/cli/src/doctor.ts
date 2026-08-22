import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { promisify } from 'node:util'

import type { ApolloPorts, DoctorHealth, PluginAvailability } from './ports'

const execFileAsync = promisify(execFile)
const GH_VERSION_TIMEOUT_MS = 5000
/** r13-G6: hint mirrors CONTRIBUTING "Recommended" deps — gh only powers the PR workflow. */
export const GH_CLI_MISSING_HINT = 'PR 工作流需要 gh（CONTRIBUTING 推荐依赖）'

export interface GhCliHealth {
  installed: boolean
  path?: string
  version?: string
}
export interface DoctorCheck {
  detail: string
  /** Structured gh CLI availability for --json consumers (r13-G6). */
  gh?: GhCliHealth
  name: string
  ok: boolean
  /** Structured production plugin containment disclosure. */
  plugin?: PluginAvailability
  /** Warn-only check: rendered ⚠️ and never trips --strict (r13-G6). */
  warn?: boolean
}
export async function detectGhCli(env: NodeJS.ProcessEnv = process.env): Promise<GhCliHealth> {
  const path = await resolveExecutablePath('gh', env)
  if (!path) return { installed: false }
  try {
    const { stdout } = await execFileAsync(path, ['--version'], {
      env,
      timeout: GH_VERSION_TIMEOUT_MS,
      windowsHide: true,
    })
    const version = /gh version (\S+)/.exec(stdout)?.[1]
    return version ? { installed: true, path, version } : { installed: false }
  } catch {
    return { installed: false }
  }
}
async function resolveExecutablePath(
  name: string,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  const searchPath = env.PATH ?? env.Path
  if (!searchPath) return undefined
  const candidates = process.platform === 'win32' ? [`${name}.exe`, name] : [name]
  for (const directory of searchPath.split(delimiter)) {
    if (!directory) continue
    for (const candidate of candidates) {
      const full = join(directory, candidate)
      try {
        await access(full, constants.X_OK)
        return full
      } catch {
        // Keep scanning the PATH entries.
      }
    }
  }
  return undefined
}
export async function runDoctor(
  cwd: string,
  ports: ApolloPorts,
  env: NodeJS.ProcessEnv = process.env,
): Promise<DoctorCheck[]> {
  const [native, auth, config, telemetry, gh, plugin, evolution] = await Promise.all([
    ports.native.health(),
    ports.auth.health(),
    ports.config.health(cwd),
    ports.telemetry.health(),
    detectGhCli(env),
    ports.plugin?.availability(),
    ports.evolution?.health?.().catch(
      (error): DoctorHealth => ({
        valid: false,
        detail: `evolution health check failed: ${error instanceof Error ? error.message : String(error)}`,
      }),
    ),
  ])
  let writable = true
  try {
    await access(cwd, constants.W_OK)
  } catch {
    writable = false
  }
  return [
    {
      name: 'node version',
      ok: Number(process.versions.node.split('.')[0]) >= 20,
      detail: process.versions.node,
    },
    { name: 'apollo version', ok: true, detail: ports.identity.version },
    {
      name: 'native sandbox',
      ok: native.sandbox,
      detail: native.sandbox ? 'available' : 'native sandbox unavailable',
    },
    {
      name: 'native search',
      ok: native.search,
      detail: native.search ? 'available' : 'native search unavailable',
    },
    { name: 'native fs', ok: native.fs, detail: native.fs ? 'available' : 'native fs unavailable' },
    { name: 'auth', ok: auth.configured === true, detail: auth.detail },
    { name: 'config', ok: config.valid === true, detail: config.detail },
    // §15.11 T1b: journal recovery is surfaced here but never fails doctor —
    // tuning stays default-off and reads remain available.
    ...(evolution
      ? [
          {
            name: 'evolution tuning store',
            ok: true,
            ...(evolution.valid === false ? { warn: true } : {}),
            detail: evolution.detail,
          } satisfies DoctorCheck,
        ]
      : []),
    { name: 'cwd writable', ok: writable, detail: cwd },
    {
      detail: gh.installed ? `${gh.version} (${gh.path})` : GH_CLI_MISSING_HINT,
      gh,
      name: 'gh CLI',
      // Warn-only (r13-G6): a missing gh never fails doctor, not even with --strict.
      ok: true,
      ...(gh.installed ? {} : { warn: true }),
    },
    ...(plugin
      ? [
          {
            name: 'plugin activation',
            ok: true,
            warn: true,
            detail: `${plugin.detail} Reopen requires ${plugin.reopenCondition}.`,
            plugin,
          } satisfies DoctorCheck,
        ]
      : []),
    {
      name: 'local telemetry',
      ok: telemetry.writable && telemetry.corruptLines === 0,
      detail: telemetry.detail,
    },
  ]
}
