/**
 * SKILLS-MCPS-r1 §S3.3：/skills 面板的数据契约（K0 渲染，纯数据 view model）。
 * 控制器由 apps/cli 原生实现（不经过插件桥）：list/reload 走 SkillsRuntime，
 * setEnabled 持久写 config [skills] disabled，setActive 是会话级 prompt fragment
 * 开关。UI 组件只消费这个接口，不读 runtime 内部。
 */

export type SkillsPanelEntryStatus =
  | 'active'
  | 'available'
  | 'disabled'
  | 'shadowed'
  | 'broken'
  | 'incompatible'

export interface SkillsPanelEntry {
  readonly name: string
  readonly description: string
  /** plugin = 已启用插件捆绑的 skills（SM-08b，随插件信任）。 */
  readonly scope: 'user' | 'project' | 'plugin'
  readonly source: string
  readonly status: SkillsPanelEntryStatus
  readonly version?: string
  /** shadowed：覆盖者；broken / incompatible：原因。 */
  readonly reason?: string
  readonly flags?: readonly string[]
}

export interface SkillsPanelController {
  list(): Promise<readonly SkillsPanelEntry[]>
  /** 重扫描（SKILL.md 编辑后免重启生效）。 */
  reload(): Promise<readonly SkillsPanelEntry[]>
  /** 会话级激活切换（等价 /skill activate|deactivate）。 */
  setActive(name: string, active: boolean): Promise<string>
  /** 持久启停（写 config [skills] disabled）。 */
  setEnabled(name: string, enabled: boolean): Promise<string>
  /**
   * SKILL.md 全文（frontmatter + body）。保证非空：读取失败返回错误文本（
   * `[failed to read: ...]`），面板详情视图据此总有一帧可见内容。
   */
  show(name: string): Promise<string>
}

export function skillsPanelStatusText(entry: SkillsPanelEntry): string {
  if (entry.status === 'shadowed' || entry.status === 'broken') return entry.status
  return `${entry.scope}:${entry.status}`
}

/** `/skills list`（非面板形态）：转 ListPicker 可渲染的纯数据视图，detail 进 transcript。 */
export function skillsListCommandView(entries: readonly SkillsPanelEntry[]): {
  kind: 'list'
  title: string
  placeholder?: string
  entries: Array<{
    id: string
    label: string
    value?: string
    status?: string
    detail?: string
  }>
} {
  return {
    kind: 'list',
    title: 'Skills',
    placeholder: 'filter skills…',
    entries: entries.map((entry) => ({
      id: entry.name,
      label: entry.name,
      value: entry.description,
      status: skillsPanelStatusText(entry),
      detail: [
        `${entry.name} (${skillsPanelStatusText(entry)})`,
        entry.description,
        entry.source ? `path: ${entry.source}` : '',
        entry.reason ? entry.reason : '',
      ]
        .filter(Boolean)
        .join('\n'),
    })),
  }
}

/**
 * §S3.3a：`/skill-name` 一次性调用提交的是全文（`<skill name=…>` 框架 + body +
 * 任务），模型必须收到全文，但 transcript 里全文刷屏不可读——UI 对该形态的
 * 用户消息折叠成一行摘要 + 附带行数提示。判定只依赖文本自身（resume / 重放
 * 从 session JSONL 重建的 transcript 同样折叠）。
 */
const SKILL_FRAME_PATTERN =
  /^<skill name="((?:[^"&]|&(?:amp|lt|quot);)+)"(?: directory="[^"]*")?>\n([\s\S]*?)\n<\/skill>/

export interface CollapsedSkillInvocation {
  name: string
  /** 斜杠堆叠（`/a /b task`）里首个之后的其余 skill 名。 */
  stack?: string[]
  /** 任务首行（截断显示）。 */
  task: string
  /** 折叠掉的 skill 指令行数（含框架）。 */
  lines: number
}

/**
 * 识别一个或多个连续的 `<skill>` 框架（业界堆叠：一条消息首框架 + 至多 5 个
 * 后续），其余文本视为共享任务行。无框架 → undefined（按普通消息渲染）。
 */
export function collapseSkillInvocation(text: string): CollapsedSkillInvocation | undefined {
  let rest = text
  const names: string[] = []
  let lines = 0
  for (;;) {
    const match = SKILL_FRAME_PATTERN.exec(rest)
    if (!match) break
    names.push(unescapeSkillAttribute(match[1]!))
    const body = match[2] ?? ''
    lines += body ? body.split('\n').length + 2 : 2
    rest = rest.slice(match[0].length)
    if (rest.startsWith('\n')) rest = rest.slice(1)
  }
  if (names.length === 0) return undefined
  const remainder = rest.trim()
  const taskLine = remainder.split('\n', 1)[0] ?? ''
  const task = taskLine.length <= 60 ? taskLine : `${taskLine.slice(0, 59)}…`
  return {
    name: names[0]!,
    ...(names.length > 1 ? { stack: names.slice(1) } : {}),
    task,
    lines,
  }
}

function unescapeSkillAttribute(value: string): string {
  return value.replaceAll('&quot;', '"').replaceAll('&lt;', '<').replaceAll('&amp;', '&')
}
