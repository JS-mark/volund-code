import type { PermissionSpec } from '@volund/permission'
import type { SkillsRuntime } from '@volund/skills-runtime'
import type { Tool } from '@volund/tool-kit'

/** skill invocation 框架的属性值转义（§S3.3a：skill 元数据是不可信输入）。 */
function escapeSkillAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;')
}

/** skill 调用提交文本：SKILL.md 正文 + 任务文本装进 <skill> 框架（§S3.3a）。 */
export function buildSkillInvocationText(
  invocation: { name: string; directory: string; body: string },
  args: readonly string[],
): string {
  return buildStackedSkillInvocationText([invocation], args)
}

/**
 * 业界堆叠语义（Claude Code）：一条消息 `/a /b task` = 首个 + 至多 5 个后续
 * （MAX_SKILL_STACK），任务文本由堆叠里的 skill 共享——每个 body 独立插值
 * `$ARGUMENTS`，共享任务行只附加一次在末尾。单元素堆叠与既有单 skill
 * 提交文本逐字节一致。
 */
export function buildStackedSkillInvocationText(
  invocations: ReadonlyArray<{ name: string; directory: string; body: string }>,
  args: readonly string[],
): string {
  const first = invocations[0]
  if (!first) return ''
  // Claude Code 惯例：body 里的 $ARGUMENTS 占位在带参调用时插值为任务文本；
  // 无占位时保持既有行为（args 作为整体任务附在 skill 框架后）。args 来自
  // 用户本人的 REPL 输入（可信指令源），插值在不可信 body 转义之后进行。
  const task = args.length
    ? args.join(' ')
    : `Follow the "${first.name}" skill's instructions for my next request.`
  const frames = invocations.map((invocation) => {
    const body =
      args.length > 0 && invocation.body.includes('$ARGUMENTS')
        ? invocation.body.replaceAll('$ARGUMENTS', args.join(' '))
        : invocation.body
    return [
      `<skill name="${escapeSkillAttribute(invocation.name)}" directory="${escapeSkillAttribute(invocation.directory)}">`,
      // 防框架逃逸：body 内闭合标签转义（skill 内容是不可信第三方输入）
      body.replaceAll('</skill', '<\\/skill'),
      '</skill>',
    ].join('\n')
  })
  return [...frames, '', task].join('\n')
}

/**
 * 解析斜杠堆叠：`/a /b task` → stack=['a','b'], taskArgs=['task']。后续 token
 * 必须精确命中已注册 skill 名才算堆叠（否则归入任务文本，如 `/a /tmp/x`）；
 * 上限 MAX_SKILL_STACK，超限 token 保留在任务文本里（自可见，不静默丢弃）。
 */
export function splitSkillStack(
  name: string,
  args: readonly string[],
  known: ReadonlySet<string>,
): { stack: string[]; taskArgs: string[] } {
  const stack = [name]
  let index = 0
  while (index < args.length && stack.length < MAX_SKILL_STACK) {
    const token = args[index]!
    if (!token.startsWith('/') || !known.has(token.slice(1))) break
    stack.push(token.slice(1))
    index += 1
  }
  return { stack, taskArgs: args.slice(index) }
}

/** 业界上限：一条消息首个 + 至多 5 个后续（Claude Code 同款）。 */
export const MAX_SKILL_STACK = 6

/**
 * SKILLS-MCPS-r1 §allowed-tools：Claude 规则语法 → 回合级放行规则的子集映射。
 * 支持裸工具名（整工具放行）、`Bash(cmd)`（全串匹配）与 `Bash(cmd:*)`（前缀
 * glob）；其余语法（WebFetch(domain:*) 等）忽略并 warn——宁可多问不静默放行。
 */
export function mapAllowedTools(
  rules: readonly string[],
  onWarn?: (message: string) => void,
): Array<{ tool: string; spec: PermissionSpec }> {
  const mapped: Array<{ tool: string; spec: PermissionSpec }> = []
  for (const rule of rules) {
    const prefix = /^Bash\((.+):\*\)$/.exec(rule)
    if (prefix?.[1]) {
      mapped.push({ tool: 'Bash', spec: { bash: { command: `${prefix[1]} *` } } })
      continue
    }
    const exact = /^Bash\((.+)\)$/.exec(rule)
    if (exact?.[1]) {
      mapped.push({ tool: 'Bash', spec: { bash: { command: exact[1] } } })
      continue
    }
    if (/^[A-Za-z][A-Za-z0-9_]*$/.test(rule)) {
      mapped.push({ tool: rule, spec: {} })
      continue
    }
    onWarn?.(`skill allowed-tools rule ignored (unsupported syntax): ${rule}`)
  }
  return mapped
}

/**
 * §S3.3a：模型可调用的 Skill 工具——一次性 invocation（业界惯例：Claude Code /
 * zcode 的 Skill tool）。name 枚举随 discover() 动态刷新（forProvider 每轮重读
 * inputSchema）；permissionSpec 按 skill 名收敛，用户可对单个技能落 allow/deny。
 *
 * 独立成模块：bundle 压缩器对「模块尾部函数声明 + 早处调用」会产出标识符
 * 冲突（createSkillTool 与其他顶层绑定撞名，minified 产物启动即崩）。
 */
export function createSkillTool(options: {
  skills: Pick<SkillsRuntime, 'modelInvocableNames' | 'readInvocation'>
  /** allowed-tools → 回合级放行；缺省时 skill 照常调用只是不免批。 */
  grantEphemeral?: (rules: ReadonlyArray<{ tool: string; spec: PermissionSpec }>) => void
  onWarn?: (message: string) => void
}): Tool {
  const skills = options.skills
  return {
    name: 'Skill',
    description: "Load an installed skill's instructions into the conversation by name",
    readonly: true,
    parallelSafe: true,
    get inputSchema() {
      return {
        type: 'object',
        additionalProperties: false,
        required: ['name'],
        properties: {
          name: { type: 'string', enum: skills.modelInvocableNames() },
          args: { type: 'string' },
        },
      }
    },
    permissionSpec: (input: unknown) => {
      const name = (input as { name?: unknown }).name
      return typeof name === 'string' ? { custom: { skill: name } } : {}
    },
    async invoke(input: unknown) {
      const { name, args } = input as { name: string; args?: string }
      const invocation = await skills.readInvocation(name)
      if (invocation.allowedTools?.length && options.grantEphemeral)
        options.grantEphemeral(mapAllowedTools(invocation.allowedTools, options.onWarn))
      return {
        content: [{ type: 'text', text: buildSkillInvocationText(invocation, args ? [args] : []) }],
        meta: { durationMs: 0, costImpact: 'safe' },
      }
    },
  }
}
