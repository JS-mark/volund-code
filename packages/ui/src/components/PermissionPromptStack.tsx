import { Box, Text, useInput, useStdout } from 'ink'
import { useEffect, useState } from 'react'

import type {
  InteractivePermissionDecisionKind,
  InteractivePermissionRequest,
  PermissionPromptController,
} from '../permission'
import { formatPermissionTextForDisplay } from '../permission-display'

export interface PermissionPromptStackProps {
  controller: PermissionPromptController
  requests: readonly InteractivePermissionRequest[]
}

interface DecisionOption {
  color: string
  id: InteractivePermissionDecisionKind
  label: string
  /** 记忆范围说明：grant 按 tool+参数 精确匹配，新操作各自第一次仍会问。 */
  hint: string
  quickKey: string
}

/** Escaped-newline token produced by the injective permission formatter. */
const NEWLINE_TOKEN = '\\u{000A}'
const LABEL_WIDTH = 6
const MIN_INNER_WIDTH = 40
const MAX_INNER_WIDTH = 96
const MAX_SPEC_ROWS = 8

const DECISION_OPTIONS: readonly DecisionOption[] = [
  {
    color: 'green',
    id: 'allow-once',
    hint: 'approve just this run',
    label: 'Allow once',
    quickKey: 'a',
  },
  {
    color: 'cyan',
    id: 'allow-session',
    hint: 'this exact operation stays approved until the session ends',
    label: 'For this session',
    quickKey: 's',
  },
  {
    color: 'blue',
    id: 'allow-project',
    hint: 'remembered in .volund/permissions.toml for this repo',
    label: 'For this project',
    quickKey: 'p',
  },
  {
    color: 'magenta',
    id: 'allow-forever',
    hint: 'remembered in ~/.volund/permissions.toml, across sessions',
    label: 'Always',
    quickKey: 'f',
  },
  { color: 'red', id: 'deny', hint: 'reject this run', label: 'Deny', quickKey: 'd' },
  {
    color: 'red',
    id: 'deny-forever',
    hint: 'blacklist this exact operation globally',
    label: 'Never ask again',
    quickKey: 'x',
  },
]

const GROUP_CAPTIONS: ReadonlyArray<{ caption: string; match: RegExp }> = [
  { caption: 'ALLOW', match: /^allow/ },
  { caption: 'DENY', match: /^deny/ },
]

/** One human-readable capability line of the permission summary. */
export interface SpecLine {
  kind: string
  value: string
}

interface SpecRow {
  dim?: boolean
  gutter: string
  text: string
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

/**
 * Translates the structured permission spec into capability lines so prompts read
 * like prose instead of raw JSON. Each rendered string is escaped individually:
 * the structured spec is secret-scrubbed upstream but not terminal-safe on its own.
 */
export function summarizeSpec(spec: unknown): readonly SpecLine[] {
  const record = asRecord(spec)
  if (!record) return []
  const lines: SpecLine[] = []
  const fs = asRecord(record.fs)
  for (const key of ['read', 'write'] as const) {
    const paths = fs ? stringArrayOf(fs, key) : undefined
    if (paths?.length) lines.push({ kind: key, value: paths.map(escapeText).join(', ') })
  }
  const bash = asRecord(record.bash)
  if (bash && typeof bash.command === 'string')
    lines.push({ kind: 'run', value: `$ ${escapeText(bash.command)}` })
  const net = asRecord(record.net)
  if (net && typeof net.method === 'string' && typeof net.url === 'string')
    lines.push({ kind: 'net', value: `${net.method} ${escapeText(net.url)}` })
  const env = asRecord(record.env)
  const envKeys = env ? stringArrayOf(env, 'read') : undefined
  if (envKeys?.length) lines.push({ kind: 'env', value: envKeys.map(escapeText).join(', ') })
  const custom = asRecord(record.custom)
  if (custom) {
    for (const [key, value] of Object.entries(custom)) {
      let rendered: string
      try {
        rendered = JSON.stringify(value) ?? 'undefined'
      } catch {
        rendered = '[unserializable]'
      }
      lines.push({ kind: 'custom', value: `${escapeText(key)} ${escapeText(rendered)}` })
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
  const valueWidth = Math.max(16, innerWidth - LABEL_WIDTH - 2)
  const baseGutter = `${line.kind.padEnd(LABEL_WIDTH)} `
  // Blank source lines render as nothing at all so multi-line commands don't
  // burn display rows on separators.
  const fragments = line.value
    .split(NEWLINE_TOKEN)
    .filter((fragment, index) => index === 0 || fragment.length > 0)
  return fragments.map((fragment, index) => {
    if (index === 0)
      return fragment.length > valueWidth
        ? { gutter: baseGutter, text: `${fragment.slice(0, valueWidth)}…` }
        : { gutter: baseGutter, text: fragment }
    const gutter = `${' '.repeat(LABEL_WIDTH)} │ `
    return fragment.length > valueWidth - 3
      ? { gutter, text: `${fragment.slice(0, valueWidth - 3)}…` }
      : { gutter, text: fragment }
  })
}

function fallbackRow(text: string): SpecRow {
  return { dim: true, gutter: `${''.padEnd(LABEL_WIDTH)} `, text }
}

/**
 * Multi-request permission prompt. Pending requests are shown as a tab strip
 * (`1:Bash`, `2:Write`, …); each tab carries its own option list. ←/→ or
 * tab/shift+tab switch requests, ↑/↓ + Enter pick an option, letter keys decide
 * immediately, and esc denies the focused request. Decided requests leave the
 * strip and focus advances to the next pending one.
 */
export function PermissionPromptStack({ controller, requests }: PermissionPromptStackProps) {
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

  if (!request) return null

  const innerWidth = Math.max(
    MIN_INNER_WIDTH,
    Math.min((stdout?.columns ?? 80) - 6, MAX_INNER_WIDTH),
  )
  const specRows = request.display.approvable
    ? summarizeSpec(request.spec).flatMap((line) => layoutSpecLine(line, innerWidth))
    : [fallbackRow(request.display.spec)]
  const visibleRows = specRows.slice(0, MAX_SPEC_ROWS)
  const hiddenRowCount = specRows.length - visibleRows.length
  const backgroundBash =
    (request.spec as { bash?: { background?: boolean } } | undefined)?.bash?.background === true

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
          ◆ Permission required
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
            · background
          </Text>
        ) : null}
        {requests.length > 1 ? (
          <Text color="gray" key="count">
            {' '}
            · {activeIndex + 1}/{requests.length}
          </Text>
        ) : null}
      </Box>
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
            <Text color={row.dim ? 'gray' : 'cyanBright'} key="gutter">
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
      <Box flexDirection="column" marginTop={1} marginBottom={1}>
        {options.map((option, index) => {
          const focused = index === optionIndex
          const previous = index > 0 ? options[index - 1] : undefined
          const caption = GROUP_CAPTIONS.find(
            (group) => group.match.test(option.id) && (!previous || !group.match.test(previous.id)),
          )?.caption
          return (
            <Box key={option.id} flexDirection="column">
              {caption ? (
                <Text bold color="gray" key="caption">
                  {caption}
                </Text>
              ) : null}
              <Text key="opt" wrap="truncate">
                {focused ? (
                  <Text bold color={option.color} key="ptr">
                    {'> '}
                  </Text>
                ) : (
                  '  '
                )}
                <Text bold={focused} color={focused ? option.color : 'gray'} key="qkey">
                  {option.quickKey}
                </Text>
                {focused ? (
                  <Text bold color={option.color} key="lbl-focus">
                    {'  '}
                    {option.label}
                  </Text>
                ) : (
                  <Text key="lbl-blur">
                    {'  '}
                    {option.label}
                  </Text>
                )}
                <Text color="gray" key="hint">
                  {'  ·  '}
                  {option.hint}
                </Text>
              </Text>
            </Box>
          )
        })}
      </Box>
      <Box flexDirection="column" marginBottom={1}>
        <Text color="gray">
          {'↑/↓ choose · enter confirm · keys decide now'}
          {requests.length > 1 ? ' · ←/→ switch' : ''}
          {' · esc deny'}
        </Text>
        <Text color="gray">
          {'grants match exactly: a new command, path, or site asks once, then is remembered'}
        </Text>
      </Box>
    </Box>
  )
}

function optionsFor(request: InteractivePermissionRequest | undefined): readonly DecisionOption[] {
  if (!request) return DECISION_OPTIONS
  if (!request.display.approvable) return DECISION_OPTIONS.filter((o) => o.id === 'deny')
  return DECISION_OPTIONS
}

function quickDecision(
  input: string,
  request: InteractivePermissionRequest,
): InteractivePermissionDecisionKind | undefined {
  const option = DECISION_OPTIONS.find((candidate) => candidate.quickKey === input)
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
