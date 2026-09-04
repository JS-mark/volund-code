import type { SkillEntry } from '@volund/skills-runtime'
import type { MutableSlashCommandRegistry, SlashSubmitView } from '@volund/ui'

/**
 * SKILLS-MCPS-r1 §S3.3a：每个可被用户调用的 skill 自动注册为同名 slash 命令
 * （业界惯例：Claude Code / Codex / Cursor 的 `/skill-name`）。
 *
 * - 可注册集合 = entries() 里 user-invocable 且非 broken / shadowed / disabled 的 winner；
 * - `/skill-name [args]` 执行 = **一次性调用**（invocation）：skill body + args 任务
 *   组装成 `{kind:'submit'}` 视图，TUI 把它作为用户消息提交当轮对话——不持久改
 *   system prompt（区别于 `/skill activate` 的会话级激活）；
 * - 撞 builtin / 已注册命令名 → warn + 跳过（skill 名空间不覆盖命令名空间）；
 * - sync() 幂等：新增注册、消失注销，面板 r / 启停后重调即可。
 */
/** slash 可注册集合：user-invocable 且非 broken/shadowed/disabled 的 winner——
 *  同一集合也是斜杠堆叠（`/a /b task`）识别后续 skill 名的依据。 */
export function slashInvocableSkillNames(entries: readonly SkillEntry[]): Set<string> {
  const names = new Set<string>()
  for (const entry of entries) {
    if (!entry.userInvocable) continue
    if (entry.status === 'broken' || entry.status === 'shadowed' || entry.status === 'disabled')
      continue
    names.add(entry.name)
  }
  return names
}

export class SkillSlashCommands {
  readonly #registered = new Map<string, () => void>()
  constructor(
    private readonly options: {
      registry: MutableSlashCommandRegistry
      invoke(name: string, args: readonly string[]): Promise<SlashSubmitView>
      onWarn(message: string): void
    },
  ) {}
  sync(entries: readonly SkillEntry[]): void {
    const wanted = new Map<string, SkillEntry>()
    for (const entry of entries) {
      if (!slashInvocableSkillNames([entry]).has(entry.name)) continue
      if (!wanted.has(entry.name)) wanted.set(entry.name, entry)
    }
    for (const [name, dispose] of this.#registered)
      if (!wanted.has(name)) {
        dispose()
        this.#registered.delete(name)
      }
    for (const [name, entry] of wanted) {
      if (this.#registered.has(name)) continue
      try {
        this.#registered.set(
          name,
          this.options.registry.register(
            {
              name,
              description: slashDescription(entry.description),
              run: ({ args }) => this.options.invoke(name, args),
            },
            { kind: 'skill' },
          ),
        )
      } catch (error) {
        this.options.onWarn(
          `Skill command /${name} not registered: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
  }
  registered(): string[] {
    return [...this.#registered.keys()].toSorted()
  }
  dispose(): void {
    for (const dispose of this.#registered.values()) dispose()
    this.#registered.clear()
  }
}

/** slash 建议是单行展示：描述截到一行可读长度（全文在 /skills 面板详情里）。 */
function slashDescription(description: string): string {
  const oneLine = description.split('\n', 1)[0]!.trim()
  return oneLine.length <= 80 ? oneLine : `${oneLine.slice(0, 79)}…`
}
