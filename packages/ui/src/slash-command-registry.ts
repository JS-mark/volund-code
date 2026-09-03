import type { SlashCommand } from './app'

export interface SlashCommandSource {
  /** builtin = 内置命令；skill = SKILL.md 贡献的同名命令（SKILLS-MCPS-r1 §S3.3a）。 */
  kind: 'builtin' | 'plugin' | 'skill' | 'test'
  plugin?: string
}

export interface RegisteredSlashCommand extends SlashCommand {
  source: SlashCommandSource
}

export interface SlashCommandRegistry {
  snapshot(): readonly RegisteredSlashCommand[]
  subscribe(listener: () => void): () => void
}

const validName = /^[a-z][a-z0-9._-]*$/
export const BUILTIN_SLASH_COMMAND_NAMES = Object.freeze([
  'help',
  'exit',
  'clear',
  'undo',
  'status',
  'context',
  'compact',
  'memory',
  'resume',
  'model',
  'mode',
  // SKILLS-MCPS-r1：/skills 与 /mcp（业界单数惯例）为内置保留名；
  // /skill（activate|deactivate|show 动词式入口，§11.4）同样保留
  'skills',
  'mcp',
  'skill',
])
const builtinNames = new Set<string>(BUILTIN_SLASH_COMMAND_NAMES)

export function normalizeSlashCommandName(value: string): string {
  const name = value.trim().replace(/^\/+/, '').toLowerCase()
  if (!validName.test(name)) throw new Error(`slash_command_invalid_name: ${value}`)
  return name
}

export class MutableSlashCommandRegistry implements SlashCommandRegistry {
  readonly #commands = new Map<string, RegisteredSlashCommand>()
  readonly #listeners = new Set<() => void>()

  register(command: SlashCommand, source: SlashCommandSource): () => void {
    const name = normalizeSlashCommandName(command.name)
    const aliases = [...new Set((command.aliases ?? []).map(normalizeSlashCommandName))]
    const keys = [name, ...aliases]
    for (const key of keys) {
      if (source.kind !== 'builtin' && builtinNames.has(key))
        throw new Error(`slash_command_builtin_reserved: ${key}`)
      const existing = this.find(key)
      if (existing)
        throw new Error(
          existing.source.kind === 'builtin'
            ? `slash_command_builtin_reserved: ${key}`
            : `slash_command_conflict: ${key}`,
        )
    }
    const registered: RegisteredSlashCommand = Object.freeze({
      ...command,
      name,
      aliases: Object.freeze(aliases),
      source: Object.freeze({ ...source }),
    })
    this.#commands.set(name, registered)
    this.emit()
    let active = true
    return () => {
      if (!active) return
      active = false
      this.#commands.delete(name)
      this.emit()
    }
  }

  snapshot(): readonly RegisteredSlashCommand[] {
    return Object.freeze(
      [...this.#commands.values()].toSorted(
        (left, right) =>
          // order 是显式排序键（升序，浮在最前）；未设置的保持源优先级
          //（builtin 在前）+ 字母序的既有行为。
          (left.order ?? Number.MAX_SAFE_INTEGER) - (right.order ?? Number.MAX_SAFE_INTEGER) ||
          Number(right.source.kind === 'builtin') - Number(left.source.kind === 'builtin') ||
          left.name.localeCompare(right.name),
      ),
    )
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  private find(name: string) {
    return [...this.#commands.values()].find(
      (command) => command.name === name || command.aliases?.includes(name),
    )
  }

  private emit() {
    for (const listener of this.#listeners) listener()
  }
}
