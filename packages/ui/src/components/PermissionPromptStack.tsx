import { Box, Text, useInput } from 'ink'
import { useEffect, useState } from 'react'

import type {
  InteractivePermissionDecisionKind,
  InteractivePermissionRequest,
  PermissionPromptController,
} from '../permission'

export interface PermissionPromptStackProps {
  controller: PermissionPromptController
  requests: readonly InteractivePermissionRequest[]
}

interface DecisionOption {
  color: string
  id: InteractivePermissionDecisionKind
  label: string
  quickKey: string
}

const DECISION_OPTIONS: readonly DecisionOption[] = [
  { color: 'green', id: 'allow-once', label: 'Allow once', quickKey: 'a' },
  { color: 'cyan', id: 'allow-session', label: 'Allow for this session', quickKey: 's' },
  { color: 'red', id: 'deny', label: 'Deny', quickKey: 'd' },
]

const MAX_VISIBLE_TABS = 5
const MAX_TAB_LABEL = 14

/**
 * Multi-request permission prompt. Pending requests are shown as a tab strip
 * (`1:Bash`, `2:Write`, …); each tab carries its own option list. ←/→ or
 * tab/shift+tab switch requests, ↑/↓ + Enter pick an option, a/s/d quick-decide
 * the focused request, and esc denies it. Decided requests leave the strip and
 * focus advances to the next pending one.
 */
export function PermissionPromptStack({ controller, requests }: PermissionPromptStackProps) {
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
        key.tab || key.leftArrow || key.rightArrow ? (key.leftArrow || (key.shift && key.tab) ? -1 : 1) : 0
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

  return (
    <Box
      borderColor="yellow"
      borderStyle="single"
      flexDirection="column"
      marginBottom={1}
      paddingX={1}
    >
      <Text color="yellow" bold>
        Permission required
      </Text>
      {requests.length > 1 ? (
        <Box>
          {visibleTabs(requests, activeIndex).map((entry) => {
            if (entry.kind === 'ellipsis')
              return (
                <Text color="gray" key={entry.key}>
                  {' …  '}
                </Text>
              )
            const tab = entry.request
            const active = entry.index === activeIndex
            const label = ` ${entry.index + 1}:${tabLabel(tab.display.toolName)} `
            return (
              <Text
                {...(active
                  ? { backgroundColor: 'yellow', color: 'black' }
                  : { color: tab.display.approvable ? 'white' : 'red' })}
                key={tab.id}
              >
                {label}
              </Text>
            )
          })}
        </Box>
      ) : null}
      <Box flexDirection="column" marginTop={1}>
        <Text bold>{request.display.toolName}</Text>
        <Text color="gray" wrap="wrap">
          {request.display.spec}
        </Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {options.map((option, index) => (
          <Text {...(index === optionIndex ? { color: option.color } : {})} key={option.id}>
            {index === optionIndex ? '> ' : '  '}
            {option.label} <Text color="gray">({option.quickKey})</Text>
          </Text>
        ))}
      </Box>
      <Text color="gray">
        {requests.length > 1
          ? '↑/↓ choose · Enter confirm · ←/→ switch request · esc deny'
          : '↑/↓ choose · Enter confirm · esc deny'}
      </Text>
    </Box>
  )
}

function optionsFor(
  request: InteractivePermissionRequest | undefined,
): readonly DecisionOption[] {
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
  let start = Math.max(0, Math.min(activeIndex - Math.floor(MAX_VISIBLE_TABS / 2), requests.length - MAX_VISIBLE_TABS))
  const end = start + MAX_VISIBLE_TABS
  const entries: TabEntry[] = []
  if (start > 0) entries.push({ key: 'left', kind: 'ellipsis' })
  for (let index = start; index < end; index += 1)
    entries.push({ index, kind: 'tab', request: requests[index]! })
  if (end < requests.length) entries.push({ key: 'right', kind: 'ellipsis' })
  return entries
}
