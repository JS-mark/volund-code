import { Box, Text, useInput, useStdout } from 'ink'
import { useEffect, useMemo, useState } from 'react'

import type {
  InteractivePermissionDecisionKind,
  InteractivePermissionRequest,
  PermissionPromptController,
} from '../permission'
import { permissionDiffPreview } from '../permission-diff'
import { formatPermissionTextForDisplay } from '../permission-display'

export interface PermissionPromptStackProps {
  controller: PermissionPromptController
  requests: readonly InteractivePermissionRequest[]
  /** 会话 cwd：Edit/Write 的审批时点探测（文件是否已变/是否覆盖现有文件）。 */
  cwd?: string
}

interface DecisionOption {
  color: string
  id: InteractivePermissionDecisionKind
  label: string
  /** 记忆范围说明：项目内文件路径落盘为 <repo>/** 模式；bash/net 按 command/origin 精确记忆。 */
  hint: string
  /** 字母快捷键：旧肌肉记忆，始终生效但不进展示（展示位给数字编号）。 */
  quickKey: string
  /** 次要选项：不进焦点列表（数字/字母键仍直接生效），只在底部暗字提示。 */
  secondary?: boolean
}

/** Escaped-newline token produced by the injective permission formatter. */
const NEWLINE_TOKEN = '\\u{000A}'
/** spec gutter 中文标签的最大显示宽度（自定义 = 3 CJK = 6 列）。 */
const GUTTER_LABEL_WIDTH = 6
/** 主选项标签列的显示宽度（本会话内允许 = 6 CJK = 12 列）。 */
const OPTION_LABEL_WIDTH = 12
const MIN_INNER_WIDTH = 40
const MAX_INNER_WIDTH = 96
const MAX_SPEC_ROWS = 8

/**
 * 决策选项：声明顺序即数字编号（1..7），编号固定不随可见性变化——
 * 「4 拒绝」在任何形态下都是 4，肌肉记忆不漂移。主选项进焦点列表（↑↓ 移动），
 * 次要选项收进底部暗字行，数字/字母键都可直达。
 */
const DECISION_OPTIONS: readonly DecisionOption[] = [
  {
    color: 'green',
    id: 'allow-once',
    hint: '仅本次运行',
    label: '允许一次',
    quickKey: 'a',
  },
  {
    color: 'cyan',
    id: 'allow-session',
    hint: '相同操作在本会话内不再询问',
    label: '本会话内允许',
    quickKey: 's',
  },
  {
    color: 'blue',
    id: 'allow-project',
    hint: '写入 .volund/permissions.toml；仓库内路径记为 <repo>/**',
    label: '项目内记住',
    quickKey: 'p',
  },
  {
    color: 'red',
    id: 'deny',
    hint: '本次不执行',
    label: '拒绝',
    quickKey: 'd',
  },
  {
    color: 'magenta',
    id: 'allow-forever',
    hint: '写入全局 ~/.volund/permissions.toml',
    label: '始终允许',
    quickKey: 'f',
    secondary: true,
  },
  {
    color: 'yellow',
    id: 'allow-all-session',
    hint: '本会话不再询问任何操作；deny 规则仍生效',
    label: '全部放行（本会话）',
    quickKey: 'g',
    secondary: true,
  },
  {
    color: 'red',
    id: 'deny-forever',
    hint: '全局拉黑此操作',
    label: '永不询问',
    quickKey: 'x',
    secondary: true,
  },
]

/** spec 能力行的中文 gutter 标签与风险配色（写/运行类用黄色提示副作用）。 */
const SPEC_KIND_PRESENTATION: Record<string, { label: string; tone: string }> = {
  read: { label: '读取', tone: 'cyan' },
  write: { label: '写入', tone: 'yellow' },
  run: { label: '运行', tone: 'yellow' },
  net: { label: '网络', tone: 'cyan' },
  env: { label: '环境', tone: 'magenta' },
  custom: { label: '自定义', tone: 'gray' },
}

/** One human-readable capability line of the permission summary. */
export interface SpecLine {
  label: string
  tone: string
  value: string
}

interface SpecRow {
  dim?: boolean
  gutter: string
  text: string
  tone: string
}

function escapeText(value: string): string {
  return formatPermissionTextForDisplay(value).text
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function stringArrayOf(
  record: Record<string, unknown>,
  key: string,
): readonly string[] | undefined {
  const value = record[key]
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) return undefined
  return value as string[]
}

/** 按显示宽度对齐（CJK 双宽），padEnd 对中文会少算一半宽度。 */
function padDisplay(text: string, width: number): string {
  const measured = displayWidth(text)
  return measured >= width ? text : text + ' '.repeat(width - measured)
}

/** 终端列宽：CJK/全角计 2 列，其余计 1（标签都是受控文案，无需完整 wcwidth 表）。 */
function displayWidth(text: string): number {
  let width = 0
  for (const char of text) width += isWideCodePoint(char.codePointAt(0)!) ? 2 : 1
  return width
}

function isWideCodePoint(codePoint: number): boolean {
  return (
    codePoint >= 0x1100 &&
    (codePoint <= 0x115f || // Hangul Jamo
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf) || // CJK 部首… Yi
      (codePoint >= 0xa960 && codePoint <= 0xa97f) || // Hangul Jamo Extended-A
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) || // Hangul Syllables
      (codePoint >= 0xf900 && codePoint <= 0xfaff) || // CJK Compatibility Ideographs
      (codePoint >= 0xfe30 && codePoint <= 0xfe4f) || // CJK Compatibility Forms
      (codePoint >= 0xff00 && codePoint <= 0xff60) || // Fullwidth Forms
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x20000 && codePoint <= 0x2fffd) ||
      (codePoint >= 0x30000 && codePoint <= 0x3fffd))
  )
}

/**
 * Translates the structured permission spec into capability lines so prompts read
 * like prose instead of raw JSON. Each rendered string is escaped individually:
 * the structured spec is secret-scrubbed upstream but not terminal-safe on its own.
 */
export function summarizeSpec(spec: unknown): readonly SpecLine[] {
  const record = asRecord(spec)
  if (!record) return []
  const lines: SpecLine[] = []
  const push = (kind: string, value: string) => {
    const presentation = SPEC_KIND_PRESENTATION[kind] ?? { label: kind, tone: 'gray' }
    lines.push({ label: presentation.label, tone: presentation.tone, value })
  }
  const fs = asRecord(record.fs)
  for (const key of ['read', 'write'] as const) {
    const paths = fs ? stringArrayOf(fs, key) : undefined
    if (paths?.length) push(key, paths.map(escapeText).join(', '))
  }
  const bash = asRecord(record.bash)
  if (bash && typeof bash.command === 'string') push('run', `$ ${escapeText(bash.command)}`)
  const net = asRecord(record.net)
  if (net && typeof net.method === 'string' && typeof net.url === 'string')
    push('net', `${net.method} ${escapeText(net.url)}`)
  const env = asRecord(record.env)
  const envKeys = env ? stringArrayOf(env, 'read') : undefined
  if (envKeys?.length) push('env', envKeys.map(escapeText).join(', '))
  const custom = asRecord(record.custom)
  if (custom) {
    for (const [key, value] of Object.entries(custom)) {
      let rendered: string
      try {
        rendered = JSON.stringify(value) ?? 'undefined'
      } catch {
        rendered = '[unserializable]'
      }
      push('custom', `${escapeText(key)} ${escapeText(rendered)}`)
    }
  }
  return lines
}

/**
 * Renders one summary value as fixed-width rows. Escaped newlines become indented
 * `│` continuation rows so multi-line commands stay scannable instead of wrapping
 * into an unreadable block. Truncation is always labelled, never silent.
 */
export function layoutSpecLine(line: SpecLine, innerWidth: number): SpecRow[] {
  const valueWidth = Math.max(16, innerWidth - GUTTER_LABEL_WIDTH - 2)
  const baseGutter = `${padDisplay(line.label, GUTTER_LABEL_WIDTH)} `
  // Blank source lines render as nothing at all so multi-line commands don't
  // burn display rows on separators.
  const fragments = line.value
    .split(NEWLINE_TOKEN)
    .filter((fragment, index) => index === 0 || fragment.length > 0)
  return fragments.map((fragment, index) => {
    if (index === 0)
      return fragment.length > valueWidth
        ? { gutter: baseGutter, text: `${fragment.slice(0, valueWidth)}…`, tone: line.tone }
        : { gutter: baseGutter, text: fragment, tone: line.tone }
    const gutter = `${' '.repeat(GUTTER_LABEL_WIDTH)} │ `
    return fragment.length > valueWidth - 3
      ? { gutter, text: `${fragment.slice(0, valueWidth - 3)}…`, tone: line.tone }
      : { gutter, text: fragment, tone: line.tone }
  })
}

function fallbackRow(text: string): SpecRow {
  return { dim: true, gutter: `${' '.repeat(GUTTER_LABEL_WIDTH)} `, text, tone: 'gray' }
}

/**
 * Multi-request permission prompt. Pending requests are shown as a tab strip
 * (`1:Bash`, `2:Write`, …); each tab carries its own option list. ←/→ or
 * tab/shift+tab switch requests, ↑/↓ + Enter pick an option, number/letter keys
 * decide immediately, and esc denies the focused request. Decided requests leave
 * the strip and focus advances to the next pending one.
 */
export function PermissionPromptStack({ controller, requests, cwd }: PermissionPromptStackProps) {
  const { stdout } = useStdout()
  const [activeIndex, setActiveIndex] = useState(0)
  const [optionIndex, setOptionIndex] = useState(0)
  const request = requests[Math.min(activeIndex, requests.length - 1)]

  // The controller removes a request as soon as it is decided; clamp the focus
  // so the strip advances to whatever is still pending.
  useEffect(() => {
    if (activeIndex > requests.length - 1) setActiveIndex(Math.max(0, requests.length - 1))
  }, [activeIndex, requests.length])

  const options = optionsFor(request)
  useEffect(() => {
    if (optionIndex > options.length - 1) setOptionIndex(Math.max(0, options.length - 1))
  }, [optionIndex, options.length])

  useInput(
    (input, key) => {
      if (!request) return
      if (key.escape) {
        controller.decide(request.id, { kind: 'deny' })
        return
      }
      const switchTab =
        key.tab || key.leftArrow || key.rightArrow
          ? key.leftArrow || (key.shift && key.tab)
            ? -1
            : 1
          : 0
      if (switchTab !== 0 && requests.length > 1) {
        const next = (activeIndex + switchTab + requests.length) % requests.length
        setActiveIndex(next)
        setOptionIndex(0)
        return
      }
      if (key.upArrow || key.downArrow) {
        const step = key.downArrow ? 1 : -1
        setOptionIndex((current) => (current + step + options.length) % options.length)
        return
      }
      if (key.return || input === '\r' || input === '\n') {
        const option = options[optionIndex]
        if (option) controller.decide(request.id, { kind: option.id })
        return
      }
      const quick = quickDecision(input, request)
      if (quick) controller.decide(request.id, { kind: quick })
    },
    { isActive: Boolean(request) },
  )

  // 写操作 diff 预览（Edit/MultiEdit/Write）：审批前看到具体要改什么。
  // hooks 顺序必须在早退 return 之前稳定——diff 按 request id memo，同一请求
  // 多次 render 不重复读盘/算 diff；无请求时返回空数组（hooks 仍要执行）。
  const innerWidth = Math.max(
    MIN_INNER_WIDTH,
    Math.min((stdout?.columns ?? 80) - 6, MAX_INNER_WIDTH),
  )
  const diffRows = useMemo(
    () =>
      request ? permissionDiffPreview(request.toolName, request.input, innerWidth - 2, cwd) : [],
    [request?.id, request?.toolName, request?.input, innerWidth, cwd],
  )

  if (!request) return null

  const specRows = request.display.approvable
    ? summarizeSpec(request.spec).flatMap((line) => layoutSpecLine(line, innerWidth))
    : [fallbackRow(request.display.spec)]
  const visibleRows = specRows.slice(0, MAX_SPEC_ROWS)
  const hiddenRowCount = specRows.length - visibleRows.length
  const backgroundBash =
    (request.spec as { bash?: { background?: boolean } } | undefined)?.bash?.background === true
  const approvable = request.display.approvable
  const secondaryOptions = approvable ? DECISION_OPTIONS.filter((option) => option.secondary) : []

  return (
    <Box
      borderColor="gray"
      borderStyle="round"
      flexDirection="column"
      marginBottom={1}
      paddingX={2}
      paddingY={0}
    >
      <Box marginTop={1}>
        <Text key="title" bold color="yellow">
          ◆ 权限请求
        </Text>
        {request.display.toolName.length > 0 ? (
          <Text key="tool" bold>
            {' · '}
            {request.display.toolName}
          </Text>
        ) : null}
        {backgroundBash ? (
          <Text key="bg" color="magentaBright">
            {' '}
            · 后台
          </Text>
        ) : null}
        {requests.length > 1 ? (
          <Text color="gray" key="count">
            {' '}
            · {activeIndex + 1}/{requests.length}
          </Text>
        ) : null}
      </Box>
      {request.lineage ? (
        <Box marginTop={1}>
          <Text bold color="magenta">
            {'◈ 子代理'}
            {request.lineage.agentType ? ` · ${escapeText(request.lineage.agentType)}` : ''}
          </Text>
        </Box>
      ) : null}
      {requests.length > 1 ? (
        <Box marginTop={1}>
          {visibleTabs(requests, activeIndex).map((entry) => {
            if (entry.kind === 'ellipsis')
              return (
                <Text color="gray" key={`ellipsis:${entry.key}`}>
                  {' …  '}
                </Text>
              )
            const tab = entry.request
            const active = entry.index === activeIndex
            const label = ` ${entry.index + 1}:${tabLabel(tab.display.toolName)} `
            if (active)
              return (
                <Text backgroundColor="yellow" bold color="black" key={tab.id}>
                  {label}
                </Text>
              )
            return (
              <Text color={tab.display.approvable ? 'gray' : 'red'} key={tab.id}>
                {label}
              </Text>
            )
          })}
        </Box>
      ) : null}
      <Box flexDirection="column" marginTop={1}>
        {visibleRows.map((row, index) => (
          <Text {...(row.dim ? { color: 'gray' } : {})} key={`row:${index}`} wrap="truncate">
            <Text color={row.dim ? 'gray' : row.tone} key="gutter">
              {row.gutter}
            </Text>
            {row.text}
          </Text>
        ))}
        {hiddenRowCount > 0 ? (
          <Text color="gray" key="more">
            {'       └ … '}
            {hiddenRowCount}
            {' more'}
          </Text>
        ) : null}
      </Box>
      {diffRows.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color="gray">变更预览</Text>
          {diffRows.map((row, index) => (
            <Text key={`diff:${index}`} wrap="truncate">
              <Text
                color={row.tone === 'add' ? 'green' : row.tone === 'del' ? 'red' : 'gray'}
                key="marker"
              >
                {row.tone === 'add' ? '+ ' : row.tone === 'del' ? '- ' : '  '}
              </Text>
              <Text {...(row.tone === 'meta' ? { color: 'gray' } : {})} key="body">
                {row.text}
              </Text>
            </Text>
          ))}
        </Box>
      ) : null}
      <Box flexDirection="column" marginTop={1} marginBottom={1}>
        {options.map((option, index) => {
          const focused = index === optionIndex
          const num = String(DECISION_OPTIONS.indexOf(option) + 1)
          return (
            <Text key={option.id} wrap="truncate">
              {focused ? (
                <Text bold color={option.color} key="ptr">
                  {'> '}
                </Text>
              ) : (
                '  '
              )}
              <Text bold={focused} color={focused ? option.color : 'gray'} key="num">
                {num}
              </Text>
              {'  '}
              <Text
                bold={focused}
                key="lbl"
                {...(focused ? { color: option.color } : { color: 'white' })}
              >
                {padDisplay(option.label, OPTION_LABEL_WIDTH)}
              </Text>
              <Text color="gray" key="hint">
                {'  '}
                {option.hint}
              </Text>
            </Text>
          )
        })}
      </Box>
      <Box flexDirection="column" marginBottom={1}>
        <Text color="gray">
          {approvable ? '↑↓ 选择 · enter 确认 · 数字/字母键直选' : 'enter 确认'}
          {requests.length > 1 ? ' · ←/→ 切换请求' : ''}
          {' · esc 拒绝'}
        </Text>
        {secondaryOptions.length > 0 ? (
          <Text color="gray" wrap="truncate">
            {secondaryOptions
              .map((option) => `${DECISION_OPTIONS.indexOf(option) + 1} ${option.label}`)
              .join(' · ')}
          </Text>
        ) : null}
      </Box>
    </Box>
  )
}

function optionsFor(request: InteractivePermissionRequest | undefined): readonly DecisionOption[] {
  const primary = DECISION_OPTIONS.filter((option) => !option.secondary)
  if (!request) return primary
  if (!request.display.approvable) return primary.filter((o) => o.id === 'deny')
  return primary
}

function quickDecision(
  input: string,
  request: InteractivePermissionRequest,
): InteractivePermissionDecisionKind | undefined {
  // 数字键 = 声明顺序编号；'y'（yes 的肌肉记忆）按 allow-once 处理。
  const numbered = /^[1-9]$/.test(input) ? DECISION_OPTIONS[Number(input) - 1] : undefined
  const normalized = input === 'y' ? 'a' : input
  const option = numbered ?? DECISION_OPTIONS.find((candidate) => candidate.quickKey === normalized)
  if (!option) return undefined
  if (!request.display.approvable && option.id !== 'deny') return undefined
  return option.id
}

function tabLabel(toolName: string): string {
  const collapsed = toolName.replace(/\s+/g, ' ')
  if (collapsed.length <= MAX_TAB_LABEL) return collapsed
  return `${collapsed.slice(0, MAX_TAB_LABEL - 1)}…`
}

const MAX_TAB_LABEL = 14
const MAX_VISIBLE_TABS = 5

type TabEntry =
  | { index: number; kind: 'tab'; request: InteractivePermissionRequest }
  | { key: string; kind: 'ellipsis' }

/** Window of tabs around the active one so long queues keep the strip readable. */
function visibleTabs(
  requests: readonly InteractivePermissionRequest[],
  activeIndex: number,
): TabEntry[] {
  if (requests.length <= MAX_VISIBLE_TABS)
    return requests.map((request, index) => ({ index, kind: 'tab', request }))
  let start = Math.max(
    0,
    Math.min(activeIndex - Math.floor(MAX_VISIBLE_TABS / 2), requests.length - MAX_VISIBLE_TABS),
  )
  const end = start + MAX_VISIBLE_TABS
  const entries: TabEntry[] = []
  if (start > 0) entries.push({ key: 'left', kind: 'ellipsis' })
  for (let index = start; index < end; index += 1)
    entries.push({ index, kind: 'tab', request: requests[index]! })
  if (end < requests.length) entries.push({ key: 'right', kind: 'ellipsis' })
  return entries
}
