export type Locale = 'zh' | 'en'

export type PermColor = 'green' | 'cyan' | 'blue' | 'red'

export interface PromoCopy {
  tagline: string
  ossBadge: string
  term: {
    /** Activity/tool rows mirroring the real TUI ActivityBlock (◆ verb target · suffix). */
    readDone: string
    editDone: string
    testDone: string
    commitDone: string
    assistant1: string
    assistant2: string
    assistant3: string
    /** Permission card mirroring PermissionPromptStack. */
    permTitle: string
    permTool: string
    permSpecGutter: string
    permFile: string
    permSpecSuffix: string
    permOptions: { label: string; hint: string; color: PermColor }[]
    permFooter: string
    permSecondary: string
    permApproved: string
    captionPre: string
    captionHl: string
  }
  controlEyebrow: string
  controlTitle: [string, string]
  controlSub: [string, string]
  rail: [string, string][]
  featEyebrow: string
  featTitle: [string, string]
  features: [string, string][]
  ecoEyebrow: string
  ecoTitle: [string, string]
  strips: [string, string][]
  ctaClaim: [string, string]
  badges: string[]
  github: string
}

export const COPY: Record<Locale, PromoCopy> = {
  zh: {
    tagline: '为 coder 锻造的 AI 编程 CLI',
    ossBadge: '开源 · APACHE-2.0',
    term: {
      readDone: '已读取 12 个文件',
      editDone: '已编辑 src/stream.ts',
      testDone: '已运行 npm test',
      commitDone: '已运行 git commit',
      assistant1: '我在流解码器中找到了回归点。',
      assistant2: '最后一个 UTF-8 边界在 abort 状态之前被刷新。',
      assistant3: '已修复，测试全部通过。',
      permTitle: '◆ 权限请求',
      permTool: 'Edit',
      permSpecGutter: '写入 ',
      permFile: 'src/stream.ts',
      permSpecSuffix: '（改动 3 处：+8 −3）',
      permOptions: [
        { label: '允许一次', hint: '仅本次运行', color: 'green' },
        { label: '本会话内允许', hint: '相同操作在本会话内不再询问', color: 'cyan' },
        { label: '项目内记住', hint: '写入 .volund/permissions.toml', color: 'blue' },
        { label: '拒绝', hint: '本次不执行', color: 'red' },
      ],
      permFooter: '↑↓ 选择 · enter 确认 · 数字/字母键直选 · esc 拒绝',
      permSecondary: 'f 始终允许 · g 全部放行（本会话） · x 永不询问',
      permApproved: '已批准 · 本会话内允许 src/stream.ts',
      captionPre: '推理与执行分离 —— ',
      captionHl: '每个副作用，都经过你的确认',
    },
    controlEyebrow: '控制平面',
    controlTitle: ['一个智能体。', '没有黑箱。'],
    controlSub: [
      '模型负责提出方案，权限层负责决策，沙箱负责隔离。',
      '每一步都清晰呈现在你的终端中。',
    ],
    rail: [
      ['你', '任务意图'],
      ['VOLUND', '上下文 + 循环'],
      ['路由器', '你的模型'],
      ['沙箱', '受控执行'],
    ],
    featEyebrow: '为终端而生',
    featTitle: ['重要的部分，', '都属于你。'],
    features: [
      ['模型无关', '通过稳定的统一契约切换模型，不必改变你的工作方式。'],
      ['权限优先', '写文件、执行命令与访问网络都会先询问；拒绝是正常流程。'],
      ['默认本地', '会话与诊断默认保留在本机，只有明确选择才会发送。'],
      ['全链路开源', 'TypeScript 编排配合 Rust 安全内核，可阅读、可审计、可扩展。'],
    ],
    ecoEyebrow: '不止终端',
    ecoTitle: ['一套内核，', '随处工作。'],
    strips: [
      ['Web 控制台', '浏览器中的完整工作台 —— 聊天、代码、终端、审批，开箱即用。'],
      ['远程网关', '反向隧道 + 配对码，手机也能查看进度、批准权限请求。'],
      ['插件 · Skills · MCP', '可组合的运行时 —— 用命名空间插件、技能与 MCP 服务扩展能力。'],
    ],
    ctaClaim: ['你的仓库。', '你的规则。'],
    badges: ['开源 · Apache-2.0', 'Node ≥ 20.19', '遥测默认保留在本地'],
    github: 'github.com/JS-mark/volund-code',
  },
  en: {
    tagline: 'The AI coding CLI, forged for coders.',
    ossBadge: 'OPEN SOURCE · APACHE-2.0',
    term: {
      readDone: 'Read 12 files',
      editDone: 'Edited src/stream.ts',
      testDone: 'Ran npm test',
      commitDone: 'Ran git commit',
      assistant1: 'I found the regression in the stream decoder.',
      assistant2: 'The final UTF-8 boundary is flushed before the abort state.',
      assistant3: 'Fixed — all tests green.',
      permTitle: '◆ Permission request',
      permTool: 'Edit',
      permSpecGutter: 'write ',
      permFile: 'src/stream.ts',
      permSpecSuffix: ' (3 hunks: +8 −3)',
      permOptions: [
        { label: 'Allow once', hint: 'this run only', color: 'green' },
        { label: 'Allow this session', hint: 'the same action will not ask again', color: 'cyan' },
        { label: 'Remember in project', hint: 'writes .volund/permissions.toml', color: 'blue' },
        { label: 'Deny', hint: 'do not run this time', color: 'red' },
      ],
      permFooter: '↑↓ choose · enter confirm · number/letter direct · esc denies',
      permSecondary: 'f always · g allow all (session) · x never ask',
      permApproved: 'Approved · allow this session src/stream.ts',
      captionPre: 'Reasoning apart from execution — ',
      captionHl: 'every side effect asks first',
    },
    controlEyebrow: 'THE CONTROL PLANE',
    controlTitle: ['One agent.', 'No black box.'],
    controlSub: [
      'Models propose. The permission layer decides. The sandbox contains.',
      'Every step stays visible in your terminal.',
    ],
    rail: [
      ['YOU', 'intent'],
      ['VOLUND', 'context + loop'],
      ['ROUTER', 'your provider'],
      ['SANDBOX', 'controlled action'],
    ],
    featEyebrow: 'BUILT FOR THE TERMINAL',
    featTitle: ['The parts that matter', 'are yours.'],
    features: [
      [
        'Provider-neutral',
        'Route through a stable contract. Change the model, keep your workflow.',
      ],
      ['Permission-first', 'Writes, commands, and network access ask before they happen.'],
      ['Local by default', 'Sessions and diagnostics stay on your machine unless you opt in.'],
      ['Open end to end', 'TypeScript orchestration, a Rust safety core. Read, audit, extend.'],
    ],
    ecoEyebrow: 'BEYOND THE TERMINAL',
    ecoTitle: ['One kernel.', 'Works everywhere.'],
    strips: [
      ['Web console', 'A full workbench in the browser — chat, code, terminal, approvals.'],
      [
        'Remote gateway',
        'Reverse tunnel plus a pairing code: watch progress and approve from your phone.',
      ],
      [
        'Plugins · Skills · MCP',
        'A composable runtime — namespaced plugins, skills, and MCP servers.',
      ],
    ],
    ctaClaim: ['Your repo.', 'Your rules.'],
    badges: ['Open source · Apache-2.0', 'Node ≥ 20.19', 'Telemetry stays local'],
    github: 'github.com/JS-mark/volund-code',
  },
}
