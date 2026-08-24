import type { CoreEvent, EventBus } from '@apollo-code/core'
import { Box, useApp, useStdout } from 'ink'
import type { Dispatch, SetStateAction } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { InputBox } from './components/InputBox'
import { MemoryPanel } from './components/MemoryPanel'
import { ModelPicker } from './components/ModelPicker'
import { PermissionPromptStack } from './components/PermissionPromptStack'
import { ScrollableTranscript } from './components/ScrollableTranscript'
import { SessionPicker } from './components/SessionPicker'
import { StatusLine, type StatusLevel } from './components/StatusLine'
import { StatusPanel } from './components/StatusPanel'
import { TopBar } from './components/TopBar'
import { WelcomeScreen } from './components/welcome/WelcomeScreen'
import { buildWelcomeScreenState } from './components/welcome/welcomeStateAdapter'
import { useSessionEvents } from './hooks/useSessionEvents'
import { useStreamBuffer } from './hooks/useStreamBuffer'
import type { MemoryPanelController } from './memory-panel'
import type { ModelPickerState, SubmitOptions } from './model-picker'
import type { PermissionPromptController } from './permission'
import type { SessionCandidate } from './session-picker'
import type { SlashCommandRegistry } from './slash-command-registry'
import { statusPanelFromWelcome, type StatusPanelController, type StatusPanelData } from './status'
import type { WelcomePanelData, WelcomeSandboxStatus } from './welcome'

export interface TranscriptEntry {
  id: string
  role: 'assistant' | 'system' | 'user'
  text: string
  /** B7（r13-G5）：该 assistant 消息因 max_tokens 截断，UI 渲染续写提示 */
  truncated?: boolean
}

export interface SlashCommandInput {
  name: string
  args: readonly string[]
  raw: string
}

export interface SlashCommand {
  name: string
  description: string
  aliases?: readonly string[]
  available?: boolean
  run(input: SlashCommandInput): Promise<void> | void
}

export interface InputHistoryStore {
  append(input: string): Promise<void> | void
  list(): Promise<readonly string[]> | readonly string[]
}

export interface UndoStepWarning {
  path: string
  kind: 'backup_missing' | 'target_modified'
}

export interface UndoStepOutcome {
  undone: boolean
  reason?: 'no_backup'
  paths: readonly string[]
  warnings: readonly UndoStepWarning[]
}

/**
 * r13-G4 (spec 08-session-config.md §8.6.2): single-step `/undo` adapter.
 * The implementation picks the most recent not-yet-consumed backup batch for
 * the session — read-only tools are skipped naturally and Bash changes are out
 * of scope because Bash produces no backups.
 */
export interface UndoController {
  undoStep(sessionId: string): Promise<UndoStepOutcome>
}

/** Exact StatusLine message required when no undoable backup exists. */
export const UNDO_NOTHING_MESSAGE = 'nothing to undo (no backup for last side-effecting tool)'

export interface ResumedInteractiveSession {
  cwd: string
  events?: EventBus
  id: string
  onExit(): Promise<void> | void
  onSubmit(input: string, options?: SubmitOptions): Promise<void> | void
  transcript?: readonly TranscriptEntry[]
}

export interface SessionResumeController {
  list(): Promise<readonly SessionCandidate[]>
  resume(session: SessionCandidate): Promise<ResumedInteractiveSession>
}

export interface InteractiveAppOptions {
  cwd: string
  events?: EventBus
  history?: InputHistoryStore
  initialInput?: string
  memory?: MemoryPanelController
  modelPicker?: ModelPickerState
  noColor?: boolean
  onExit?: () => Promise<void> | void
  onModelSelect?: (model: string) => Promise<void> | void
  onSubmit?: (input: string, options?: SubmitOptions) => Promise<void> | void
  permissions?: PermissionPromptController
  resume?: SessionResumeController
  /**
   * r13-P1: resolves the settled native sandbox state after probing. When the
   * welcome panel still shows `sandbox: probing`, the app refreshes the welcome
   * badge and top status once this promise resolves (asynchronous backfill).
   */
  sandboxProbe?: () => Promise<{ sandbox: WelcomeSandboxStatus; status: string }>
  sessionId?: string
  slashCommands?: readonly SlashCommand[]
  slashCommandRegistry?: SlashCommandRegistry
  status?: string
  statusPanel?: StatusPanelData
  statusPanelController?: StatusPanelController
  undo?: UndoController
  welcome?: WelcomePanelData
}

export interface InteractiveAppState {
  pendingAssistantText: string
  sessionId: string
  status: string
  statusLevel: StatusLevel
  transcript: TranscriptEntry[]
}

export function InteractiveApp(options: InteractiveAppOptions) {
  const { exit } = useApp()
  const { stdout } = useStdout()
  const terminalSize = useTerminalSize(stdout)
  const [state, setState] = useState<InteractiveAppState>(() => ({
    pendingAssistantText: '',
    sessionId: options.sessionId ?? 'new',
    status: options.status ?? 'ready',
    statusLevel: 'muted',
    transcript: [],
  }))
  const [historyEntries, setHistoryEntries] = useState<readonly string[]>([])
  const [welcome, setWelcome] = useState(options.welcome)
  const [showWelcome, setShowWelcome] = useState(Boolean(options.welcome))
  const [memoryOpen, setMemoryOpen] = useState(false)
  const [modelPickerOpen, setModelPickerOpen] = useState(false)
  const [statusPanelOpen, setStatusPanelOpen] = useState(false)
  const [currentModelId, setCurrentModelId] = useState(options.modelPicker?.currentModelId ?? '')
  const [activeModelId, setActiveModelId] = useState(options.modelPicker?.currentModelId ?? '')
  // 仅当用户在 /model picker 里显式选择后才携带 model 覆盖提交；
  // 否则留 undefined，让 router 用 [provider.*] 配置解析模型（picker 展示值只是显示）。
  const [modelOverride, setModelOverride] = useState<string>()
  const [permissionRequests, setPermissionRequests] = useState(
    () => options.permissions?.requests() ?? [],
  )
  const [activeSession, setActiveSession] = useState<ResumedInteractiveSession>()
  const [resumeCandidates, setResumeCandidates] = useState<readonly SessionCandidate[]>()
  const [resumeError, setResumeError] = useState<string>()
  const [registryCommands, setRegistryCommands] = useState(
    () => options.slashCommandRegistry?.snapshot() ?? [],
  )
  const activeEvents = activeSession?.events ?? options.events
  const activeCwd = activeSession?.cwd ?? options.cwd
  const activeOnExit = activeSession?.onExit ?? options.onExit
  const activeOnSubmit = activeSession?.onSubmit ?? options.onSubmit

  const flushPendingToTranscript = useCallback(
    (state: InteractiveAppState, id: string): InteractiveAppState => {
      if (!state.pendingAssistantText) return state
      return {
        ...state,
        pendingAssistantText: '',
        transcript: [
          ...state.transcript,
          { id, role: 'assistant', text: state.pendingAssistantText },
        ],
      }
    },
    [],
  )

  const streamBuffer = useStreamBuffer(
    useCallback((text) => {
      setState((current) => ({
        ...current,
        pendingAssistantText: current.pendingAssistantText + text,
      }))
    }, []),
  )

  useEffect(() => {
    const registry = options.slashCommandRegistry
    if (!registry) return
    const refresh = () => setRegistryCommands(registry.snapshot())
    refresh()
    return registry.subscribe(refresh)
  }, [options.slashCommandRegistry])

  useEffect(() => {
    if (!options.permissions) return
    return options.permissions.subscribe(setPermissionRequests)
  }, [options.permissions])

  useSessionEvents(
    activeEvents,
    useCallback(
      (event) => {
        if (event.type === 'stream.started') {
          streamBuffer.reset()
          setShowWelcome(false)
          setState((current) => applyInteractiveEvent(current, event))
          return
        }
        if (event.type === 'stream.delta') {
          streamBuffer.append(payloadText(event.payload))
          setState((current) => ({ ...current, status: 'streaming', statusLevel: 'active' }))
          return
        }
        if (event.type === 'stream.completed') {
          const flushed = streamBuffer.flushNow()
          setState((current) => {
            const withFlushed = flushed
              ? {
                  ...current,
                  pendingAssistantText: current.pendingAssistantText + flushed,
                }
              : current
            return applyInteractiveEvent(withFlushed, event)
          })
          return
        }
        if (event.type === 'turn.aborted' || event.type === 'error.raised') {
          const flushed = streamBuffer.flushNow()
          setState((current) => {
            const withFlushed = flushed
              ? {
                  ...current,
                  pendingAssistantText: current.pendingAssistantText + flushed,
                }
              : current
            return applyInteractiveEvent(flushPendingToTranscript(withFlushed, event.id), event)
          })
          return
        }
        if (event.type === 'tool.started') setShowWelcome(false)
        setState((current) => applyInteractiveEvent(current, event))
      },
      [flushPendingToTranscript, streamBuffer],
    ),
  )

  useEffect(() => {
    let disposed = false
    void Promise.resolve(options.history?.list() ?? []).then(
      (items) => {
        if (!disposed) setHistoryEntries(items)
      },
      () => {
        if (!disposed)
          setState((current) => ({
            ...current,
            status: 'history unavailable',
            statusLevel: 'warning',
          }))
      },
    )
    return () => {
      disposed = true
    }
  }, [options.history])

  useEffect(() => {
    // r13-P1: the REPL rendered while native probing was still in flight; once
    // the probe settles, backfill the welcome sandbox badge and the top status.
    if (!welcome || welcome.sandbox.status !== 'probing' || !options.sandboxProbe) return
    let disposed = false
    options.sandboxProbe().then(
      (resolved) => {
        if (disposed || resolved.sandbox.status === 'probing') return
        setWelcome((current) => (current ? { ...current, sandbox: resolved.sandbox } : current))
        setState((current) =>
          current.status === (options.status ?? 'ready')
            ? { ...current, status: resolved.status }
            : current,
        )
      },
      () => undefined,
    )
    return () => {
      disposed = true
    }
  }, [options.sandboxProbe, options.status, welcome])

  const slashCommands = useMemo(() => {
    const hasModelPicker = Boolean(options.modelPicker?.models.length)
    const commands: SlashCommand[] = [
      {
        name: 'help',
        description: 'Show slash commands',
        run: () => {
          setShowWelcome(false)
          appendSystemMessage(setState, slashHelpText(commands))
        },
      },
      {
        name: 'exit',
        description: 'End the session',
        run: async () => {
          await activeOnExit?.()
          exit()
        },
      },
      {
        name: 'clear',
        description: 'Clear the transcript',
        run: () => {
          setShowWelcome(false)
          setStatusPanelOpen(false)
          setState((current) => ({ ...current, transcript: [], pendingAssistantText: '' }))
        },
      },
      options.undo
        ? {
            name: 'undo',
            description: 'Undo the last side-effecting tool (single step)',
            run: async () => {
              setShowWelcome(false)
              setStatusPanelOpen(false)
              const outcome = await options.undo!.undoStep(activeSession?.id ?? state.sessionId)
              if (!outcome.undone) {
                appendSystemMessage(setState, UNDO_NOTHING_MESSAGE)
                setState((current) => ({
                  ...current,
                  status: UNDO_NOTHING_MESSAGE,
                  statusLevel: 'warning',
                }))
                return
              }
              appendSystemMessage(setState, undoTranscriptMessage(outcome))
              setState((current) => ({
                ...current,
                status: outcome.warnings.length
                  ? 'undo restored with warnings (may have overwritten manual changes)'
                  : `undid ${outcome.paths.length} file(s)`,
                statusLevel: outcome.warnings.length ? 'warning' : 'muted',
              }))
            },
          }
        : unavailableSlashCommand('undo', 'Undo the last side-effecting tool (single step)'),
      welcome
        ? {
            name: 'status',
            description: 'Show runtime status',
            run: () => {
              setShowWelcome(false)
              setModelPickerOpen(false)
              setStatusPanelOpen(true)
              setState((current) => ({
                ...current,
                status: 'status',
                statusLevel: 'muted',
              }))
            },
          }
        : unavailableSlashCommand('status', 'Show runtime status'),
      unavailableSlashCommand('context', 'Show context status'),
      unavailableSlashCommand('compact', 'Compact conversation context'),
      options.memory
        ? {
            name: 'memory',
            description: 'Browse and manage memory',
            run: () => {
              setShowWelcome(false)
              setModelPickerOpen(false)
              setStatusPanelOpen(false)
              setResumeCandidates(undefined)
              setMemoryOpen(true)
              setState((current) => ({
                ...current,
                status: 'memory',
                statusLevel: 'muted',
              }))
            },
          }
        : unavailableSlashCommand('memory', 'Browse and manage memory'),
      options.resume
        ? {
            name: 'resume',
            description: 'Resume a saved session',
            run: async () => {
              setShowWelcome(false)
              setModelPickerOpen(false)
              setStatusPanelOpen(false)
              setResumeError(undefined)
              setResumeCandidates(await options.resume!.list())
              setState((current) => ({
                ...current,
                status: 'select session',
                statusLevel: 'muted',
              }))
            },
          }
        : unavailableSlashCommand('resume', 'Resume a saved session'),
      hasModelPicker
        ? {
            name: 'model',
            description: 'Switch model',
            run: () => {
              setShowWelcome(false)
              setStatusPanelOpen(false)
              setModelPickerOpen(true)
              setActiveModelId(currentModelId || firstAvailableModelId(options.modelPicker!.models))
              setState((current) => ({
                ...current,
                status: 'select model',
                statusLevel: 'muted',
              }))
            },
          }
        : unavailableSlashCommand('model', 'Switch model'),
    ]
    return [...commands, ...(options.slashCommands ?? []), ...registryCommands]
  }, [
    activeSession,
    currentModelId,
    exit,
    options.memory,
    options.modelPicker,
    activeOnExit,
    options.resume,
    options.slashCommands,
    options.undo,
    registryCommands,
    state.sessionId,
    welcome,
  ])

  const transcript = useMemo(() => {
    if (!state.pendingAssistantText) return state.transcript
    return [
      ...state.transcript,
      { id: 'pending-assistant', role: 'assistant' as const, text: state.pendingAssistantText },
    ]
  }, [state.pendingAssistantText, state.transcript])

  const commandInput = (
    <InputBox
      disabled={
        statusPanelOpen ||
        memoryOpen ||
        modelPickerOpen ||
        resumeCandidates !== undefined ||
        state.statusLevel === 'active' ||
        permissionRequests.length > 0
      }
      history={historyEntries}
      initialValue={options.initialInput ?? ''}
      placeholder="Ask Apollo to inspect, change, test, or explain this repo"
      slashCommands={slashCommands}
      terminalColumns={terminalSize.columns}
      onSubmit={async (input) => {
        const trimmed = input.trim()
        if (!trimmed) return
        if (trimmed === 'exit' || trimmed === 'quit') {
          await activeOnExit?.()
          exit()
          return
        }
        if (trimmed.startsWith('/')) {
          setShowWelcome(false)
          const message = await runSlashCommand(trimmed, slashCommands)
          if (message) {
            appendSystemMessage(setState, message)
            setState((current) => ({ ...current, status: message, statusLevel: 'warning' }))
          }
          return
        }
        setShowWelcome(false)
        try {
          await options.history?.append(input)
          setHistoryEntries(await Promise.resolve(options.history?.list() ?? []))
        } catch {
          setState((current) => ({
            ...current,
            status: 'history unavailable',
            statusLevel: 'warning',
          }))
        }
        await activeOnSubmit?.(input, submitOptions(modelOverride ?? ''))
      }}
    />
  )

  const bottomStatus = (
    <StatusLine level={permissionRequests.length > 0 ? 'warning' : state.statusLevel}>
      {permissionRequests.length > 0 ? 'permission required' : state.status}
    </StatusLine>
  )

  return (
    <Box flexDirection="column">
      {showWelcome && welcome ? (
        <WelcomeScreen
          bottomStatus={bottomStatus}
          commandInput={commandInput}
          state={buildWelcomeScreenState({ data: welcome })}
          terminalSize={terminalSize}
        />
      ) : (
        <>
          <TopBar cwd={activeCwd} sessionId={state.sessionId} status={state.status} />
          <ScrollableTranscript entries={transcript} />
          {options.permissions ? (
            <PermissionPromptStack controller={options.permissions} requests={permissionRequests} />
          ) : null}
          {bottomStatus}
          {commandInput}
        </>
      )}
      {statusPanelOpen && (options.statusPanel || welcome) ? (
        <StatusPanel
          data={options.statusPanel ?? statusPanelFromWelcome(welcome!)}
          {...(options.statusPanelController ? { controller: options.statusPanelController } : {})}
          onClose={() => {
            setStatusPanelOpen(false)
            setState((current) => ({ ...current, status: 'status closed' }))
          }}
        />
      ) : null}
      {modelPickerOpen && options.modelPicker ? (
        <ModelPicker
          activeId={activeModelId}
          currentModelId={currentModelId}
          models={options.modelPicker.models}
          onActiveChange={setActiveModelId}
          onCancel={() => {
            setModelPickerOpen(false)
            setState((current) => ({ ...current, status: 'model selection cancelled' }))
          }}
          onSubmit={(id) => {
            void (async () => {
              const model = options.modelPicker?.models.find((item) => item.id === id)
              if (!model || model.disabled) return
              setCurrentModelId(model.id)
              setActiveModelId(model.id)
              setModelOverride(model.id)
              setModelPickerOpen(false)
              await options.onModelSelect?.(`${model.provider}/${model.model}`)
              appendSystemMessage(setState, `Model set to ${model.label}`)
              setState((current) => ({ ...current, status: `model ${model.label}` }))
            })()
          }}
        />
      ) : null}
      {memoryOpen && options.memory ? (
        <MemoryPanel
          controller={options.memory}
          {...(options.noColor === undefined ? {} : { noColor: options.noColor })}
          paused={permissionRequests.length > 0}
          terminalColumns={terminalSize.columns}
          terminalRows={terminalSize.rows}
          onClose={() => {
            setMemoryOpen(false)
            setState((current) => ({ ...current, status: 'memory closed' }))
          }}
        />
      ) : null}
      {resumeCandidates ? (
        <SessionPicker
          {...(resumeError ? { error: resumeError } : {})}
          sessions={resumeCandidates}
          onCancel={() => {
            setResumeCandidates(undefined)
            setResumeError(undefined)
            setState((current) => ({ ...current, status: 'session resume cancelled' }))
          }}
          onSelect={(candidate) => {
            void (async () => {
              try {
                const resumed = await options.resume!.resume(candidate)
                setActiveSession(resumed)
                setResumeCandidates(undefined)
                setResumeError(undefined)
                setState((current) => ({
                  ...current,
                  sessionId: resumed.id,
                  transcript: [...(resumed.transcript ?? [])],
                  pendingAssistantText: '',
                  status: 'session resumed',
                  statusLevel: 'muted',
                }))
              } catch (error) {
                setResumeError(error instanceof Error ? error.message : String(error))
              }
            })()
          }}
        />
      ) : null}
    </Box>
  )
}

function useTerminalSize(stdout: NodeJS.WriteStream) {
  const readSize = useCallback(
    () => ({ columns: stdout.columns ?? 80, rows: stdout.rows ?? 24 }),
    [stdout],
  )
  const [size, setSize] = useState(readSize)

  useEffect(() => {
    const handleResize = () => {
      const next = readSize()
      setSize((current) =>
        current.columns === next.columns && current.rows === next.rows ? current : next,
      )
    }
    stdout.on('resize', handleResize)
    return () => {
      stdout.off('resize', handleResize)
    }
  }, [readSize, stdout])

  return size
}

function firstAvailableModelId(models: readonly ModelPickerState['models'][number][]) {
  return models.find((model) => !model.disabled)?.id ?? models[0]?.id ?? ''
}

function submitOptions(currentModelId: string): SubmitOptions | undefined {
  if (!currentModelId) return undefined
  return { model: currentModelId }
}

function appendSystemMessage(
  setState: Dispatch<SetStateAction<InteractiveAppState>>,
  text: string,
) {
  setState((current) => ({
    ...current,
    transcript: [
      ...current.transcript,
      {
        id: `system-${Date.now()}`,
        role: 'system',
        text,
      },
    ],
  }))
}

function unavailableSlashCommand(name: string, description: string): SlashCommand {
  return {
    name,
    description,
    available: false,
    run: () => {},
  }
}

/**
 * Transcript lines for a completed single-step undo. Warnings never block the
 * restore (spec 08-session-config.md §8.6.2), so the user is told afterwards
 * that manual changes may have been overwritten.
 */
function undoTranscriptMessage(outcome: UndoStepOutcome): string {
  const lines = outcome.paths.map((path) => `restored ${path}`)
  for (const warning of outcome.warnings)
    lines.push(
      warning.kind === 'backup_missing'
        ? `warning: backup file missing for ${warning.path}; file left unchanged`
        : `warning: ${warning.path} was modified after the backup (mtime > backup time); restored anyway and may have overwritten manual changes`,
    )
  return [`undo: restored ${outcome.paths.length} file(s) to their pre-tool state`, ...lines].join(
    '\n',
  )
}

export async function runSlashCommand(raw: string, commands: readonly SlashCommand[]) {
  const [name = '', ...args] = raw.slice(1).trim().split(/\s+/).filter(Boolean)
  if (!name) return undefined
  const command = commands.find((item) => item.name === name || item.aliases?.includes(name))
  if (!command) return `Unknown slash command: /${name}`
  if (command.available === false) return `/${command.name} is not available in this build/session`
  try {
    await command.run({ args, name: command.name, raw })
  } catch (error) {
    return error instanceof Error ? error.message : `/${command.name} failed`
  }
  return undefined
}

function slashHelpText(commands: readonly SlashCommand[]) {
  return commands
    .map((command) => {
      const suffix = command.available === false ? ' (not available in this build/session)' : ''
      return `/${command.name} - ${command.description}${suffix}`
    })
    .join('\n')
}

export function applyInteractiveEvent(
  state: InteractiveAppState,
  event: CoreEvent,
): InteractiveAppState {
  if (event.type === 'session.started') {
    return {
      ...state,
      sessionId: event.sessionId,
      status: 'session started',
      statusLevel: 'muted',
    }
  }

  if (event.type === 'message.appended') {
    const text = payloadText(event.payload)
    if (!text) return state
    return {
      ...state,
      transcript: [...state.transcript, { id: event.id, role: payloadRole(event.payload), text }],
    }
  }

  if (event.type === 'stream.started') {
    return { ...state, pendingAssistantText: '', status: 'streaming', statusLevel: 'active' }
  }

  if (event.type === 'stream.delta') {
    return {
      ...state,
      pendingAssistantText: state.pendingAssistantText + payloadText(event.payload),
      status: 'streaming',
      statusLevel: 'active',
    }
  }

  if (event.type === 'stream.completed') {
    // 附录 D.2 时序：runner 对每个 assistant step 先 stream.completed 再 message.appended。
    // 定稿 entry 只由 message.appended 落 transcript；这里若也追加，同一条回复会渲染两遍。
    return { ...state, pendingAssistantText: '', status: 'ready', statusLevel: 'muted' }
  }

  if (event.type === 'turn.aborted') {
    // reason=error 时 error.raised 刚把状态置成具体错误（含 message）；
    // 别把诊断信息覆盖成泛泛的 'turn aborted'
    if (payloadField(event.payload, 'reason') === 'error' && state.statusLevel === 'error')
      return state
    return { ...state, status: 'turn aborted', statusLevel: 'warning' }
  }

  if (event.type === 'turn.completed') {
    // B7（r13-G5）：turn 以 max_tokens 截断 → 标记最后一条 assistant 消息，渲染续写提示
    if (payloadField(event.payload, 'stopReason') === 'max_tokens') {
      const lastAssistant = [...state.transcript].reverse().find((e) => e.role === 'assistant')
      if (lastAssistant)
        return {
          ...state,
          status: 'ready',
          statusLevel: 'muted',
          transcript: state.transcript.map((e) =>
            e.id === lastAssistant.id ? { ...e, truncated: true } : e,
          ),
        }
    }
    return { ...state, status: 'ready', statusLevel: 'muted' }
  }

  if (event.type === 'tool.permission_asked') {
    return { ...state, status: 'permission required', statusLevel: 'warning' }
  }

  if (event.type === 'tool.started') {
    const toolName = payloadField(event.payload, 'tool') || 'tool'
    return { ...state, status: `running ${toolName}`, statusLevel: 'active' }
  }

  if (event.type === 'tool.completed') {
    const toolName = payloadField(event.payload, 'tool') || 'tool'
    return { ...state, status: `${toolName} completed`, statusLevel: 'muted' }
  }

  if (event.type === 'context.compacted') {
    return { ...state, status: 'context compacted', statusLevel: 'muted' }
  }

  if (event.type === 'error.raised') {
    // 附录 D.2 error.raised：★code（附录 B） ?context——状态行 code 优先，附 context.message
    // （如 'runner_error: Anthropic request failed (401)'），否则用户只看到 turn aborted。
    const code = payloadField(event.payload, 'code') || payloadText(event.payload) || 'error'
    const contextMessage = payloadContextMessage(event.payload)
    return {
      ...state,
      status: contextMessage ? `${code}: ${contextMessage}` : code,
      statusLevel: 'error',
    }
  }

  if (event.type === 'session.ended') {
    return { ...state, status: 'session ended', statusLevel: 'muted' }
  }

  return state
}

function payloadField(payload: CoreEvent['payload'], key: string): string | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined
  const value = (payload as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : undefined
}

/** error.raised 的 ?context.message（附录 D.2）：仅接受字符串，其余形态不展示。 */
function payloadContextMessage(payload: CoreEvent['payload']): string | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined
  const context = (payload as Record<string, unknown>).context
  if (!context || typeof context !== 'object' || Array.isArray(context)) return undefined
  const message = (context as Record<string, unknown>).message
  return typeof message === 'string' && message ? message : undefined
}

function payloadText(payload: CoreEvent['payload']): string {
  if (typeof payload === 'string') return payload
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return ''

  const objectPayload = payload as Record<string, unknown>
  // 附录 D.2 stream.delta：★fragment（string）只传增量片段。
  const fragment = objectPayload.fragment
  if (typeof fragment === 'string') return fragment
  const chunk = objectPayload.chunk
  if (chunk && typeof chunk === 'object' && !Array.isArray(chunk)) {
    const chunkText = (chunk as Record<string, unknown>).text
    if (typeof chunkText === 'string') return chunkText
  }

  for (const key of ['text', 'message']) {
    const value = objectPayload[key]
    if (typeof value === 'string') return value
  }
  // 附录 D.2 message.appended：★content（引用式 ContentPart[]）取 text part 拼接。
  const content = objectPayload.content
  if (Array.isArray(content)) {
    return content
      .filter(
        (part): part is { type: string; text: string } =>
          !!part && typeof part === 'object' && !Array.isArray(part),
      )
      .map((part) => (part.type === 'text' && typeof part.text === 'string' ? part.text : ''))
      .join('')
  }
  return ''
}

function payloadRole(payload: CoreEvent['payload']): TranscriptEntry['role'] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return 'system'
  const role = (payload as Record<string, unknown>).role
  return role === 'assistant' || role === 'user' || role === 'system' ? role : 'system'
}
