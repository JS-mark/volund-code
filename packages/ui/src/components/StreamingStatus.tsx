import { Box, Text, useInput } from 'ink'
import { useEffect, useRef, useState } from 'react'

export type StreamingPhase = 'streaming' | 'tool' | 'waiting'

export interface StreamingStatusProps {
  /** Whether a turn is in flight. When false, nothing renders and esc is inert. */
  active: boolean
  /** Tool name shown when `phase === 'tool'`. */
  phaseDetail?: string
  /** Called when the user presses esc while a turn is in flight. */
  onInterrupt?: () => Promise<void> | void
  phase: StreamingPhase
  /** Characters streamed so far in the current step; rendered as a token estimate. */
  streamedChars?: number
  /** Spinner refresh interval (ms). Exposed for tests. */
  tickMs?: number
  /** Verb shown before the ellipsis; defaults to a per-turn pick from VERBS. */
  verb?: string
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const

const VERBS = [
  'Thinking',
  'Working',
  'Crafting',
  'Pondering',
  'Brewing',
  'Computing',
  'Reasoning',
] as const

const TIPS = [
  'Tip: Type /help anytime to see all available commands.',
  'Tip: esc interrupts the current turn; partial output stays in the transcript.',
  'Tip: Use /model to switch models, /status to inspect the runtime.',
] as const

const SPINNER_FRAME_MS = 80
const TIP_ROTATE_SECONDS = 8

/** Rough output-token estimate: providers only report usage at stream end. */
export function estimateStreamedTokens(streamedChars: number): number {
  return Math.round(streamedChars / 4)
}

export function phaseLabel(phase: StreamingPhase, phaseDetail?: string): string {
  if (phase === 'waiting') return 'waiting for model'
  if (phase === 'tool') return phaseDetail ? `running ${phaseDetail}` : 'running tool'
  return 'streaming'
}

/**
 * Live turn status in the style of modern agent TUIs: spinner + verb, elapsed
 * seconds, phase, output-token estimate, and an esc-to-interrupt hint, with a
 * rotating tip on the line below.
 */
export function StreamingStatus({
  active,
  phaseDetail,
  onInterrupt,
  phase,
  streamedChars = 0,
  tickMs = 100,
  verb,
}: StreamingStatusProps) {
  const startedAt = useRef(Date.now())
  const [now, setNow] = useState(() => Date.now())
  const verbRef = useRef<string | undefined>(undefined)

  useEffect(() => {
    if (!active) return undefined
    startedAt.current = Date.now()
    verbRef.current = undefined
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), tickMs)
    return () => clearInterval(timer)
  }, [active, tickMs])

  useInput(
    (_input, key) => {
      if (key.escape) void onInterrupt?.()
    },
    { isActive: active && Boolean(onInterrupt) },
  )

  if (!active) return null

  const elapsedMs = Math.max(0, now - startedAt.current)
  const seconds = Math.floor(elapsedMs / 1000)
  const frame = SPINNER_FRAMES[Math.floor(elapsedMs / SPINNER_FRAME_MS) % SPINNER_FRAMES.length]
  const chosenVerb =
    verb ?? verbRef.current ?? (verbRef.current = VERBS[startedAt.current % VERBS.length]!)
  const tip = TIPS[Math.floor(seconds / TIP_ROTATE_SECONDS) % TIPS.length]

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text>
        <Text color="cyan">{frame} </Text>
        <Text bold>{chosenVerb}… </Text>
        <Text color="gray">
          ({seconds}s · {phaseLabel(phase, phaseDetail)} · ↑{' '}
          {estimateStreamedTokens(streamedChars)} tokens · <Text bold>esc</Text> to interrupt)
        </Text>
      </Text>
      <Text color="gray"> ⎿ {tip}</Text>
    </Box>
  )
}
