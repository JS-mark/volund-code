// TranscriptEntry 契约已迁至 @volund/app-runtime（§22.7.1：TUI/Web 共用）；
// 此处 re-export 保持既有引用兼容。
import { isSlashSubmitView, type SlashSubmitView, type TranscriptEntry } from '@volund/app-runtime'
import type { CoreEvent, EventBus } from '@volund/core'
import {
  contentPartChipLabel,
  productIdentity,
  type PasteAttachmentResult,
  type StagedAttachmentInfo,
  type SubmitAttachment,
} from '@volund/shared'
import { Box, Text, useApp, useStdout } from 'ink'
import type { Dispatch, SetStateAction } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { InputBox } from './components/InputBox'
import { ListPicker } from './components/ListPicker'
import { McpPanel } from './components/McpPanel'
import { MemoryPanel } from './components/MemoryPanel'
import { ModelPicker } from './components/ModelPicker'
import { PermissionPromptStack } from './components/PermissionPromptStack'
import { ScrollableTranscript } from './components/ScrollableTranscript'
import { SessionPicker } from './components/SessionPicker'
import { SkillsPanel } from './components/SkillsPanel'
import { StatusLine, type StatusLevel } from './components/StatusLine'
import { StatusPanel } from './components/StatusPanel'
import { StreamingStatus, type StreamingPhase } from './components/StreamingStatus'
import { SubagentsPanel } from './components/SubagentsPanel'
import { TabbedListView } from './components/TabbedListView'
import { TopBar } from './components/TopBar'
import { getWelcomeLayout } from './components/welcome/welcomeLayout'
import { WelcomeScreen } from './components/welcome/WelcomeScreen'
import { buildWelcomeScreenState } from './components/welcome/welcomeStateAdapter'
import { WelcomeStatusBar } from './components/welcome/WelcomeStatusBar'
import { useSessionEvents } from './hooks/useSessionEvents'
import { useStreamBuffer } from './hooks/useStreamBuffer'
import type { CommandListEntry, CommandListView } from './list-picker'
import { isCommandListView } from './list-picker'
import type { McpPanelController } from './mcp-panel'
import { mcpListCommandView } from './mcp-panel'
import type { MemoryPanelController } from './memory-panel'
import type { ModelPickerState, SubmitOptions } from './model-picker'
import type { PermissionPromptController } from './permission'
import type { SessionCandidate } from './session-picker'
import { skillsListCommandView } from './skills-panel'
import type { SkillsPanelController } from './skills-panel'
import type { SlashCommandRegistry } from './slash-command-registry'
import { statusPanelFromWelcome, type StatusPanelController, type StatusPanelData } from './status'
import type { SubagentsPanelController } from './subagents-panel'
import { subagentListCommandView } from './subagents-panel'
import { isCommandTabsView, type CommandTabsView } from './tabbed-list'
import type { WelcomeNativeStatus, WelcomePanelData, WelcomeSandboxStatus } from './welcome'

export type { TranscriptEntry }
export { isSlashSubmitView }
export type { SlashSubmitView } from '@volund/app-runtime'

export interface SlashCommandInput {
  name: string
  args: readonly string[]
  raw: string
}

/**
 * SKILLS-MCPS-r1 §S3.3a：一次性调用视图。`/skill-name [args]` 返回它 → TUI 把
 * text 作为**用户消息**提交当轮对话（skill 内容 + 任务），不持久改 system prompt
 * ——业界 invocation 语义（Claude Code / Codex / Cursor）。仅 builtin 与 skill
 * 来源的命令允许产出（runSlashCommand 对其它来源降级为系统消息，防插件伪造
 * 用户发言）。
 */
export interface SlashCommand {
  name: string
  description: string
  aliases?: readonly string[]
  available?: boolean
  /**
   * 建议列表与 /help 的排序键（升序，可选）。内置命令占 10 的倍数号段
   * （help=10 … skill=130，见 memo 内注释）；插件命令用任意有限数穿插
   * （如 45 = /undo 与 /status 之间）。未设置的命令保持在未排序段（内置
   * 之后、按注册序）。插件经 CommandSpec.order 过桥传入。
   */
  order?: number
  /**
   * 返回值契约：字符串 → 作为系统消息进 transcript；CommandListView（
   * `{ kind: 'list', ... }` 纯数据描述符）→ 打开可搜索的列表面板（resume 风格，
   * 插件贡献的查询类命令如 /env 由此呈现）；CommandTabsView（
   * `{ kind: 'tabs', ... }`）→ 打开多页签列表面板（/plugins 风格）；
   * SlashSubmitView（`{ kind: 'submit' }`，仅 builtin/skill 来源）→ text 作为
   * 用户消息提交当轮；void → 静默成功。
   */
  run(
    input: SlashCommandInput,
  ):
    | Promise<string | CommandListView | CommandTabsView | SlashSubmitView | void>
    | string
    | CommandListView
    | CommandTabsView
    | SlashSubmitView
    | void
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
  /** 会话钉住模型（/model 选择随 session.model_changed 落盘，resume 恢复）；缺省 = 跟随全局配置。 */
  model?: string
  onExit(): Promise<void> | void
  /** esc-to-interrupt for the resumed session; omit to leave esc inert. */
  onInterrupt?(): Promise<void> | void
  /** §7.5.2 Ctrl+V 剪贴板附件；缺省时该按键在输入行静默无效。 */
  onPasteAttachment?(): Promise<PasteAttachmentResult>
  /** §7.5.2 粘贴/拖拽文件路径转附件（bracketed paste 文本解析）。 */
  onAttachFilePath?(path: string): Promise<PasteAttachmentResult>
  /** §7.5.3 @ picker 的文件候选源（cwd 相对路径快照）。 */
  listFiles?(): Promise<readonly string[]>
  onSubmit(input: string, options?: SubmitOptions): Promise<void> | void
  transcript?: readonly TranscriptEntry[]
}

export interface SessionResumeController {
  list(): Promise<readonly SessionCandidate[]>
  resume(session: SessionCandidate): Promise<ResumedInteractiveSession>
}

/** §22 W-01：外部驱动（Web 嵌入式 start/resume）的会话激活推送。 */
export interface SessionActivationSource {
  subscribe(listener: (session: ResumedInteractiveSession) => void): () => void
}

export interface InteractiveAppOptions {
  cwd: string
  events?: EventBus
  history?: InputHistoryStore
  initialInput?: string
  memory?: MemoryPanelController
  /** SKILLS-MCPS-r1 §S3.3：/skills 面板控制器（apps/cli 原生装配）。 */
  skills?: SkillsPanelController
  /** SKILLS-MCPS-r1 §S3.6：/mcp 面板控制器（apps/cli 原生装配）。 */
  mcp?: McpPanelController
  /** SUBAGENTS-UI-r1：/subagents 运行管理面板控制器（apps/cli 原生装配）。 */
  subagents?: SubagentsPanelController
  modelPicker?: ModelPickerState
  noColor?: boolean
  /**
   * 启动期一次性系统消息（如内置插件激活失败原因），作为 transcript 初始条目
   * 直接可见——这类失败发生在 REPL 渲染前，走 stderr 要等退出后才看得到。
   */
  notices?: readonly string[]
  onExit?: () => Promise<void> | void
  /** esc-to-interrupt while a turn streams/runs; omit to leave esc inert. */
  onInterrupt?: () => Promise<void> | void
  onModelSelect?: (model: string) => Promise<void> | void
  /**
   * §7.5.2 Ctrl+V 剪贴板附件粘贴：读系统剪贴板 → 权限门 → 图片落盘/文件引用，
   * 返回输入行 chip（或纯文本/空/拒绝）。缺省时 Ctrl+V 在输入行静默无效。
   */
  onPasteAttachment?: () => Promise<PasteAttachmentResult>
  /**
   * §7.5.2 粘贴/拖拽的文件路径（bracketed paste 文本解析）：返回 'attached'
   * 转 chip，其余结果把原文本插入输入行（纯文本粘贴不受影响）。
   */
  onAttachFilePath?: (path: string) => Promise<PasteAttachmentResult>
  /** §7.5.3 @ picker 的文件候选源（cwd 相对路径）；缺省时 @ 只提供模型别名。 */
  listFiles?: () => Promise<readonly string[]>
  onSubmit?: (input: string, options?: SubmitOptions) => Promise<void> | void
  permissions?: PermissionPromptController
  /** §4.4 三档会话权限模式（/mode 命令的后端）；缺省时 /mode 显示为不可用。 */
  permissionMode?: {
    current(): 'ask' | 'auto' | 'full' | undefined
    set(mode: 'ask' | 'auto' | 'full'): Promise<void> | void
  }
  resume?: SessionResumeController
  /**
   * §22 W-01：外部驱动（Web 嵌入式 start/resume）的会话激活源——新会话激活时
   * 本组件换绑 facade（与 /resume 选择同路径，按会话 id 幂等去重）。
   */
  sessionActivation?: SessionActivationSource
  /**
   * r13-P1: resolves the settled native sandbox state after probing. When the
   * welcome panel still shows `sandbox: probing`, the app refreshes the welcome
   * badge and top status once this promise resolves (asynchronous backfill).
   * `native`（可缺省）随同一轮回填 search/fs 探针的加载状态。
   */
  sandboxProbe?: () => Promise<{
    sandbox: WelcomeSandboxStatus
    native?: WelcomeNativeStatus
    status: string
  }>
  sessionId?: string
  slashCommands?: readonly SlashCommand[]
  slashCommandRegistry?: SlashCommandRegistry
  status?: string
  statusPanel?: StatusPanelData
  statusPanelController?: StatusPanelController
  /**
   * REM-r1：远程控制 uplink 状态源——欢迎屏 remote 行在 link 上线/掉线时
   * 异步回填（启动时多半还在 connecting，等 online 后刷新出网关地址）。
   */
  remoteStatus?: {
    subscribe(
      listener: (status: {
        state: 'off' | 'connecting' | 'online'
        gatewayUrl: string | undefined
      }) => void,
    ): () => void
  }
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
    transcript: (options.notices ?? []).map((text, index) => ({
      id: `notice-${index}`,
      role: 'system' as const,
      text,
    })),
  }))
  const [historyEntries, setHistoryEntries] = useState<readonly string[]>([])
  const [welcome, setWelcome] = useState(options.welcome)
  const [showWelcome, setShowWelcome] = useState(Boolean(options.welcome))
  const [memoryOpen, setMemoryOpen] = useState(false)
  const [skillsPanelOpen, setSkillsPanelOpen] = useState(false)
  const [mcpPanelOpen, setMcpPanelOpen] = useState(false)
  const [subagentsPanelOpen, setSubagentsPanelOpen] = useState(false)
  const [modelPickerOpen, setModelPickerOpen] = useState(false)
  const [statusPanelOpen, setStatusPanelOpen] = useState(false)
  const [currentModelId, setCurrentModelId] = useState(options.modelPicker?.currentModelId ?? '')
  const [activeModelId, setActiveModelId] = useState(options.modelPicker?.currentModelId ?? '')
  // 仅当用户在 /model picker 里显式选择后才携带 model 覆盖提交；
  // 否则留 undefined，让 router 用 [provider.*] 配置解析模型（picker 展示值只是显示）。
  const [modelOverride, setModelOverride] = useState<string>()
  // 会话切换（/resume 或 web 驱动激活）时回填模型状态：被恢复会话的钉住模型成为
  // 当前选择；未钉住的会话清掉上一会话的覆盖，picker 回落全局配置展示值。
  const syncSessionModel = (model: string | undefined) => {
    const display = model ?? options.modelPicker?.currentModelId ?? ''
    setCurrentModelId(display)
    setActiveModelId(display)
    setModelOverride(model)
  }
  const [permissionRequests, setPermissionRequests] = useState(
    () => options.permissions?.requests() ?? [],
  )
  const [activeSession, setActiveSession] = useState<ResumedInteractiveSession>()
  const [resumeCandidates, setResumeCandidates] = useState<readonly SessionCandidate[]>()
  const [resumeError, setResumeError] = useState<string>()
  // 插件命令的列表视图输出（如 /env）：打开即独占键盘（InputBox 禁用），
  // Enter 把该条 detail 进 transcript，Esc 关闭。tabs 形态（/plugins）渲染成
  // 多页签面板，交互同源。
  const [commandListView, setCommandListView] = useState<CommandListView | CommandTabsView>()
  // 斜杠命令执行中（如 /plugins 拉市场索引）：spinner 期 esc 不挂中断——
  // 命令不是会话 turn，interrupt 语义不适用。
  const [commandRunning, setCommandRunning] = useState(false)
  // SUBAGENTS-UI-r1 §S4：turn 运行期输入框保持可用——斜杠命令即时执行
  // （undo/compact/model/resume 除外），纯文本排队、turn 结束自动发出。
  // §7.5.2：排队条目随带各自的附件 chip——合并发送时附件一并归并。
  const [queuedInputs, setQueuedInputs] = useState<QueuedInput[]>([])
  const anyPanelOpen =
    statusPanelOpen ||
    memoryOpen ||
    skillsPanelOpen ||
    mcpPanelOpen ||
    subagentsPanelOpen ||
    modelPickerOpen ||
    commandListView !== undefined
  const [registryCommands, setRegistryCommands] = useState(
    () => options.slashCommandRegistry?.snapshot() ?? [],
  )
  const activeEvents = activeSession?.events ?? options.events
  const activeCwd = activeSession?.cwd ?? options.cwd
  const activeOnExit = activeSession ? () => activeSession.onExit() : options.onExit
  const activeOnInterrupt = activeSession
    ? () => activeSession.onInterrupt?.()
    : options.onInterrupt
  const activeOnSubmit = activeSession
    ? (input: string, submitOptions?: SubmitOptions) => activeSession.onSubmit(input, submitOptions)
    : options.onSubmit
  const activeOnPasteAttachment = activeSession
    ? activeSession.onPasteAttachment
    : options.onPasteAttachment
  const activeOnAttachFilePath = activeSession
    ? activeSession.onAttachFilePath
    : options.onAttachFilePath
  const activeListFiles = activeSession ? activeSession.listFiles : options.listFiles
  // §22 W-01：外部（Web 嵌入式 start/resume）驱动的会话切换——controller 激活
  // 新会话时换绑 facade，与 /resume 的 onSelect 同一路径；按 id 幂等去重
  // （TUI 自己 /resume 触发的激活不重复换绑）。
  const sessionIdRef = useRef(state.sessionId)
  sessionIdRef.current = state.sessionId
  useEffect(() => {
    return options.sessionActivation?.subscribe((session) => {
      if (session.id === sessionIdRef.current) return
      setActiveSession(session)
      syncSessionModel(session.model)
      setState((current) => ({
        ...current,
        sessionId: session.id,
        transcript: [...(session.transcript ?? [])],
        pendingAssistantText: '',
        status: 'session switched from web',
        statusLevel: 'muted',
      }))
    })
  }, [options.sessionActivation])
  // §7.5.3 @ picker 文件候选：会话切换时重取（cwd 变了）；失败静默降级为仅模型别名。
  const [mentionFiles, setMentionFiles] = useState<readonly string[]>([])
  useEffect(() => {
    let cancelled = false
    if (!activeListFiles) {
      setMentionFiles([])
      return undefined
    }
    void activeListFiles()
      .then((list) => {
        if (!cancelled) setMentionFiles(list)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [activeListFiles])
  const mentionModels = useMemo(
    () =>
      (options.modelPicker?.models ?? [])
        .filter((model) => !model.disabled)
        .map((model) => ({ alias: model.label, model: model.id })),
    [options.modelPicker],
  )
  // §7.5.2：handle digest 前 8 位 → 输入行 chip（[Image #N]）的映射，提交时登记，
  // message.appended 落 transcript 时回译，保证两处展示一致。
  const attachmentChipLabels = useRef(new Map<string, string>())
  const rememberAttachmentChips = useCallback((attachments: readonly SubmitAttachment[]) => {
    for (const attachment of attachments)
      if (attachment.handle)
        attachmentChipLabels.current.set(attachment.handle.slice(0, 8), attachment.chip)
  }, [])

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
        // SUBAGENTS-UI-r1：subagent 冒泡事件（附录 D.3 tag）不进交互态——
        // 子会话在后台静默执行，进度走 /subagents 面板；主转录只保留 Task 的
        // 最终 tool_result。持久化由 runtime 层订阅负责，不受此过滤影响。
        if ('parentTurnId' in event || (event.parentDepth ?? 0) > 0) return
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
        if (event.type === 'message.appended') {
          // §7.5.2：把 hash 形态的附件 chip（[image: 49779094.png]）回译成输入行的
          // 顺序编号 chip（[Image #1]），transcript 与输入行展示一致。
          setState((current) => {
            const next = applyInteractiveEvent(current, event)
            const added = next.transcript.length - current.transcript.length
            if (added <= 0 || attachmentChipLabels.current.size === 0) return next
            const transcript = next.transcript.slice()
            for (let index = transcript.length - added; index < transcript.length; index++) {
              const entry = transcript[index]!
              const text = remapImageChips(entry.text, attachmentChipLabels.current)
              if (text !== entry.text) transcript[index] = { ...entry, text }
            }
            return { ...next, transcript }
          })
          return
        }
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
        setWelcome((current) =>
          current
            ? {
                ...current,
                sandbox: resolved.sandbox,
                ...(resolved.native ? { native: resolved.native } : {}),
              }
            : current,
        )
        setState((current) =>
          current.status === (options.status ?? 'ready')
            ? { ...current, status: resolved.status }
            : current,
        )
      },
      () => undefined,
    )
    // oxlint-disable-next-line typescript/consistent-return
    return () => {
      disposed = true
    }
  }, [options.sandboxProbe, options.status, welcome])

  useEffect(() => {
    // REM-r1：uplink 拨号是异步的——欢迎屏渲染时多半还在 connecting；订阅状态
    // 源，online 后把 remote 行回填进欢迎屏，off 时摘掉（与启动快照同一字段）。
    if (!options.remoteStatus) return
    return options.remoteStatus.subscribe((status) => {
      setWelcome((current) => {
        if (!current) return current
        if (status.state === 'off') {
          if (current.remote === undefined) return current
          const { remote: _dropped, ...rest } = current
          return rest
        }
        const remote = {
          state: status.state,
          ...(status.gatewayUrl ? { url: status.gatewayUrl } : {}),
        }
        if (current.remote?.state === remote.state && current.remote.url === remote.url)
          return current
        return { ...current, remote }
      })
    })
  }, [options.remoteStatus])

  // §7.5.2：Ctrl+V 与 /paste 共用的剪贴板粘贴通道——结果反馈（系统消息）统一
  // 在这里处理，InputBox/命令各自只决定怎么消费 attached/text。
  const [chipInjection, setChipInjection] = useState<{
    info: StagedAttachmentInfo
    nonce: number
  } | null>(null)
  const pasteClipboardAndReport = useMemo(() => {
    if (!activeOnPasteAttachment) return undefined
    return async (): Promise<PasteAttachmentResult> => {
      try {
        const result = await activeOnPasteAttachment()
        if (result.kind === 'attached' || result.kind === 'text') return result
        // welcome 屏下 transcript 不可见——反馈消息出现时先退 welcome，
        // 否则 denied/empty/unavailable 对用户无声（像粘贴被吞）。
        setShowWelcome(false)
        if (result.kind === 'denied') appendSystemMessage(setState, 'clipboard attachment denied')
        else if (result.kind === 'empty')
          appendSystemMessage(setState, 'clipboard has no image or file to attach')
        else appendSystemMessage(setState, `clipboard attachment unavailable: ${result.reason}`)
        return result
      } catch (error) {
        setShowWelcome(false)
        appendSystemMessage(
          setState,
          `clipboard paste failed: ${error instanceof Error ? error.message : String(error)}`,
        )
        return { kind: 'unavailable', reason: 'clipboard read failed' }
      }
    }
  }, [activeOnPasteAttachment])

  const slashCommands = useMemo(() => {
    const hasModelPicker = Boolean(options.modelPicker?.models.length)
    // 内置命令排序号段（10 的倍数）：help=10 … skill=130。插件命令用任意有限数
    // 穿插（如 45 = /undo 与 /status 之间）；未设置 order 的保持在未排序段（内置
    // 之后、按注册序）。新增内置命令取下一个 10 的倍数，不要复用间隙值。
    const commands: SlashCommand[] = [
      {
        name: 'help',
        order: 10,
        description: 'Show slash commands',
        run: () => {
          setShowWelcome(false)
          appendSystemMessage(setState, slashHelpText(commands))
        },
      },
      {
        name: 'exit',
        order: 20,
        description: 'End the session',
        run: async () => {
          await activeOnExit?.()
          exit()
        },
      },
      {
        name: 'clear',
        order: 30,
        description: 'Clear the transcript',
        run: () => {
          setShowWelcome(false)
          setStatusPanelOpen(false)
          setSkillsPanelOpen(false)
          setMcpPanelOpen(false)
          setSubagentsPanelOpen(false)
          setState((current) => ({ ...current, transcript: [], pendingAssistantText: '' }))
        },
      },
      options.undo
        ? {
            name: 'undo',
            order: 40,
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
        : unavailableSlashCommand('undo', 'Undo the last side-effecting tool (single step)', 40),
      welcome
        ? {
            name: 'status',
            order: 50,
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
        : unavailableSlashCommand('status', 'Show runtime status', 50),
      unavailableSlashCommand('context', 'Show context status', 60),
      unavailableSlashCommand('compact', 'Compact conversation context', 70),
      options.memory
        ? {
            name: 'memory',
            order: 80,
            description: 'Browse and manage memory',
            run: () => {
              setShowWelcome(false)
              setModelPickerOpen(false)
              setStatusPanelOpen(false)
              setSkillsPanelOpen(false)
              setMcpPanelOpen(false)
              setSubagentsPanelOpen(false)
              setResumeCandidates(undefined)
              setMemoryOpen(true)
              setState((current) => ({
                ...current,
                status: 'memory',
                statusLevel: 'muted',
              }))
            },
          }
        : unavailableSlashCommand('memory', 'Browse and manage memory', 80),
      options.resume
        ? {
            name: 'resume',
            order: 90,
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
        : unavailableSlashCommand('resume', 'Resume a saved session', 90),
      hasModelPicker
        ? {
            name: 'model',
            order: 100,
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
        : unavailableSlashCommand('model', 'Switch model', 100),
      options.permissionMode
        ? {
            name: 'mode',
            order: 105,
            description: 'Switch permission mode (ask | auto | full)',
            run: async ({ args }) => {
              const target = args[0]?.trim().toLowerCase()
              if (target !== 'ask' && target !== 'auto' && target !== 'full') {
                const current = options.permissionMode!.current() ?? 'ask'
                return [
                  `permission mode: ${current}`,
                  'usage: /mode ask|auto|full',
                  '  ask  — confirm before changes (default)',
                  '  auto — auto-approve file edits in this project; commands and network still confirm',
                  '  full — no prompts for the rest of this session (deny rules still apply)',
                ].join('\n')
              }
              await options.permissionMode!.set(target)
              return `permission mode: ${target}`
            },
          }
        : unavailableSlashCommand('mode', 'Switch permission mode', 105),
      options.skills
        ? {
            name: 'skills',
            order: 110,
            description: 'Browse and manage skills',
            run: async ({ args }) => {
              setShowWelcome(false)
              setModelPickerOpen(false)
              setStatusPanelOpen(false)
              setMemoryOpen(false)
              setSkillsPanelOpen(false)
              setMcpPanelOpen(false)
              setSubagentsPanelOpen(false)
              if (args[0] === 'list') return skillsListCommandView(await options.skills!.list())
              setSkillsPanelOpen(true)
              setState((current) => ({
                ...current,
                status: 'skills',
                statusLevel: 'muted',
              }))
            },
          }
        : unavailableSlashCommand('skills', 'Browse and manage skills', 110),
      options.mcp
        ? {
            name: 'mcp',
            order: 120,
            description: 'Browse and manage MCP servers',
            run: async ({ args }) => {
              setShowWelcome(false)
              setModelPickerOpen(false)
              setStatusPanelOpen(false)
              setMemoryOpen(false)
              setSkillsPanelOpen(false)
              setMcpPanelOpen(false)
              setSubagentsPanelOpen(false)
              if (args[0] === 'list') return mcpListCommandView(await options.mcp!.list())
              setMcpPanelOpen(true)
              setState((current) => ({
                ...current,
                status: 'mcp',
                statusLevel: 'muted',
              }))
            },
          }
        : unavailableSlashCommand('mcp', 'Browse and manage MCP servers', 120),
      options.subagents
        ? {
            name: 'subagents',
            order: 125,
            description: 'Browse and manage subagent runs',
            run: async ({ args }) => {
              setShowWelcome(false)
              setModelPickerOpen(false)
              setStatusPanelOpen(false)
              setMemoryOpen(false)
              setSkillsPanelOpen(false)
              setMcpPanelOpen(false)
              setSubagentsPanelOpen(false)
              if (args[0] === 'list')
                return subagentListCommandView(await options.subagents!.list())
              setSubagentsPanelOpen(true)
              setState((current) => ({
                ...current,
                status: 'subagents',
                statusLevel: 'muted',
              }))
            },
          }
        : unavailableSlashCommand('subagents', 'Browse and manage subagent runs', 125),
      options.skills
        ? {
            name: 'skill',
            order: 130,
            description: 'Activate, deactivate, or show a skill',
            run: async ({ args }) => {
              const [verb, name] = args
              if (verb === 'activate' && name) {
                setShowWelcome(false)
                return options.skills!.setActive(name, true)
              }
              if (verb === 'deactivate' && name) return options.skills!.setActive(name, false)
              if (verb === 'show' && name) {
                setShowWelcome(false)
                return options.skills!.show(name)
              }
              return 'usage: /skill activate|deactivate|show <name> (browse with /skills)'
            },
          }
        : unavailableSlashCommand('skill', 'Activate, deactivate, or show a skill', 130),
      // §7.5.2：/paste 是不依赖键位的附件通道——有些终端把 Ctrl+V 绑成自己的
      // 粘贴（Warp/VS Code 等），按键根本到不了应用，命令通道始终可用。
      pasteClipboardAndReport
        ? {
            name: 'paste',
            order: 140,
            description: 'Attach the clipboard image or file to the input box',
            run: async () => {
              setShowWelcome(false)
              const result = await pasteClipboardAndReport()
              if (result.kind === 'attached') {
                setChipInjection({ info: result.attachment, nonce: Date.now() })
              } else if (result.kind === 'text') {
                appendSystemMessage(
                  setState,
                  'clipboard contains plain text — paste it with your terminal (Cmd+V)',
                )
              }
            },
          }
        : unavailableSlashCommand(
            'paste',
            'Attach the clipboard image or file to the input box',
            140,
          ),
    ]
    return sortSlashCommands([...commands, ...(options.slashCommands ?? []), ...registryCommands])
  }, [
    activeSession,
    currentModelId,
    exit,
    options.memory,
    options.modelPicker,
    options.skills,
    options.mcp,
    activeOnExit,
    options.resume,
    options.slashCommands,
    options.undo,
    pasteClipboardAndReport,
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
        skillsPanelOpen ||
        mcpPanelOpen ||
        subagentsPanelOpen ||
        modelPickerOpen ||
        resumeCandidates !== undefined ||
        commandListView !== undefined ||
        commandRunning ||
        permissionRequests.length > 0
      }
      history={historyEntries}
      initialValue={options.initialInput ?? ''}
      placeholder={`Ask ${productIdentity.shortName} to inspect, change, test, or explain this repo`}
      slashCommands={slashCommands}
      terminalColumns={terminalSize.columns}
      // §7.5.2：粘贴/拖拽的文件路径转附件；不可附加时 InputBox 回退为插入原文本。
      {...(activeOnAttachFilePath ? { onAttachFilePath: activeOnAttachFilePath } : {})}
      // §7.5.3：@ 统一 picker——文件候选（宿主预取快照）+ 模型别名（⭐ 置顶）。
      // 选中模型 = 当轮显式覆盖（与 /model picker 同一 modelOverride 通道）。
      mentionFiles={mentionFiles}
      mentionModels={mentionModels}
      onMentionModel={(model) => setModelOverride(model)}
      // §7.5.2：Ctrl+V 剪贴板附件（与 /paste 共用同一通道）；/paste 的 chip 经
      // injectedAttachment 注入输入行。
      injectedAttachment={chipInjection}
      {...(pasteClipboardAndReport ? { onPasteAttachment: pasteClipboardAndReport } : {})}
      onSubmit={async (input, attachments = []) => {
        const trimmed = input.trim()
        if (!trimmed) return
        const turnInFlight = state.statusLevel === 'active'
        if (turnInFlight && trimmed.startsWith('/')) {
          const busyName = trimmed.slice(1).split(/\s+/)[0] ?? ''
          if (['undo', 'compact', 'model', 'resume'].includes(busyName)) {
            appendSystemMessage(setState, `/${busyName} is not available while a turn is running`)
            return
          }
        }
        if (trimmed === 'exit' || trimmed === 'quit') {
          await activeOnExit?.()
          exit()
          return
        }
        if (trimmed.startsWith('/')) {
          setShowWelcome(false)
          // 命令执行期（如 /plugins 拉市场索引可能要几秒）显示 spinner：InputBox
          // 随 active 状态禁用，StreamingStatus 以 tool 相位呈现 `running /<name>`。
          const commandName = trimmed.slice(1).split(/\s+/)[0] ?? ''
          setCommandRunning(true)
          setState((current) => ({
            ...current,
            status: `running /${commandName}`,
            statusLevel: 'active',
          }))
          const outcome = await runSlashCommand(trimmed, slashCommands)
          setCommandRunning(false)
          // 命令可能在 run() 里自设状态（如 /undo 的 'undid N file(s)'）——只回落
          // 我们设置的执行期占位，不碰命令自设的值。error/warning 染状态行并落
          // 文本；info 保持命令自设状态。
          const settleStatus = (level: 'info' | 'warning' | 'error', text?: string) =>
            setState((current) => ({
              ...current,
              status:
                level === 'info'
                  ? current.status === `running /${commandName}`
                    ? 'ready'
                    : current.status
                  : (text ?? current.status),
              statusLevel: level,
            }))
          if (!outcome) {
            settleStatus('info')
            return
          }
          // 面板视图（/env 列表、/plugins 页签）打开可搜索面板；文本结果照旧进 transcript
          if (outcome.kind === 'list' || outcome.kind === 'tabs') {
            settleStatus('info')
            setCommandListView(outcome.view)
            return
          }
          // /skill-name 一次性调用：skill 内容 + 任务作为用户消息进当轮对话
          //（不持久改 system prompt）。输入行历史记原始命令，不记展开文本。
          if (outcome.kind === 'submit') {
            setShowWelcome(false)
            settleStatus('info')
            if (turnInFlight) {
              setQueuedInputs((current) => [...current, { attachments: [], text: outcome.text }])
              appendSystemMessage(
                setState,
                'queued — the skill will run when the current turn finishes',
              )
              return
            }
            try {
              await options.history?.append(input)
              setHistoryEntries(await Promise.resolve(options.history?.list() ?? []))
            } catch {
              // 历史失败不阻塞提交（同普通输入路径的降级语义）
            }
            await activeOnSubmit?.(outcome.text)
            return
          }
          appendSystemMessage(setState, outcome.text)
          settleStatus(outcome.level, outcome.text)
          return
        }
        setShowWelcome(false)
        if (turnInFlight) {
          setQueuedInputs((current) => [...current, { attachments, text: input }])
          appendSystemMessage(
            setState,
            'queued — the message will be sent when the current turn finishes',
          )
          return
        }
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
        rememberAttachmentChips(attachments)
        await activeOnSubmit?.(input, submitOptions(modelOverride ?? '', attachments))
      }}
    />
  )

  const bottomStatus = (
    <StatusLine level={permissionRequests.length > 0 ? 'warning' : state.statusLevel}>
      {permissionRequests.length > 0 ? 'permission required' : state.status}
    </StatusLine>
  )

  // While a turn is in flight (statusLevel 'active': streaming or tool running),
  // the plain StatusLine is replaced by a live spinner with elapsed time, token
  // estimate, and esc-to-interrupt hint. Suppressed while a permission prompt
  // is open so esc unambiguously means "deny" there.
  const turnInFlight = state.statusLevel === 'active' && permissionRequests.length === 0
  // 排队消息在 turn 收尾后自动发出（permission 弹窗期不算收尾，statusLevel 仍 active）
  useEffect(() => {
    if (state.statusLevel === 'active' || queuedInputs.length === 0) return
    const next = queuedInputs.map((queued) => queued.text).join('\n\n')
    // 各排队条目的 chip 一并归并；重复粘贴的同一附件（内容寻址 chip 相同）去重。
    const seen = new Set<string>()
    const attachments = queuedInputs
      .flatMap((queued) => queued.attachments)
      .filter((attachment) => {
        const key = attachment.handle ?? attachment.path ?? attachment.chip
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
    setQueuedInputs([])
    rememberAttachmentChips(attachments)
    void activeOnSubmit?.(next, submitOptions(modelOverride ?? '', attachments))
  }, [state.statusLevel, queuedInputs, rememberAttachmentChips])
  const toolName = state.status.startsWith('running ')
    ? state.status.slice('running '.length)
    : undefined
  const streamPhase: StreamingPhase = toolName
    ? 'tool'
    : state.pendingAssistantText
      ? 'streaming'
      : 'waiting'
  const turnStatus = turnInFlight ? (
    <StreamingStatus
      active
      // 面板打开时 esc 归面板（关面板），不得同时中断 turn——ink useInput 广播。
      {...(!commandRunning && !anyPanelOpen && activeOnInterrupt
        ? { onInterrupt: activeOnInterrupt }
        : {})}
      {...(toolName ? { phaseDetail: toolName } : {})}
      phase={streamPhase}
      streamedChars={state.pendingAssistantText.length}
    />
  ) : (
    bottomStatus
  )

  const welcomeState = useMemo(
    () => (welcome ? buildWelcomeScreenState({ data: welcome }) : undefined),
    [welcome],
  )

  return (
    <Box flexDirection="column">
      {/*
        InputBox 绝不进任何条件分支——welcome/正常视图切换时它若随分支移动会被
        React 重挂载，未提交的文本与附件 chip 全丢。commandInput 固定在分支之外；
        welcome 模式的 bottomStatus 与 WelcomeStatusBar 也拆到外层固定槽位。
      */}
      {showWelcome && welcomeState ? (
        <>
          {/* §7.5.2：Ctrl+V 剪贴板授权弹窗可能发生在首次提交之前（welcome 仍
              可见）——welcome 分支同样挂载弹窗，否则请求挂着却无处决策。 */}
          {options.permissions ? (
            <PermissionPromptStack controller={options.permissions} requests={permissionRequests} />
          ) : null}
          <WelcomeScreen state={welcomeState} terminalSize={terminalSize} />
          <Box marginTop={1} paddingX={1}>
            {bottomStatus}
          </Box>
        </>
      ) : (
        <>
          <TopBar cwd={activeCwd} sessionId={state.sessionId} />
          <ScrollableTranscript entries={transcript} />
          {options.permissions ? (
            <PermissionPromptStack controller={options.permissions} requests={permissionRequests} />
          ) : null}
          {turnStatus}
          {queuedInputs.length > 0 ? (
            <Box paddingLeft={1}>
              <Text color="gray">
                {queuedInputs.length} queued message(s) — sent when the turn finishes
              </Text>
            </Box>
          ) : null}
        </>
      )}
      {commandInput}
      {showWelcome && welcomeState ? (
        <WelcomeStatusBar layout={getWelcomeLayout(terminalSize)} state={welcomeState} />
      ) : null}
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
      {skillsPanelOpen && options.skills ? (
        <SkillsPanel
          controller={options.skills}
          {...(options.noColor === undefined ? {} : { noColor: options.noColor })}
          terminalColumns={terminalSize.columns}
          terminalRows={terminalSize.rows}
          onNotice={(text) => appendSystemMessage(setState, text)}
          onClose={() => {
            setSkillsPanelOpen(false)
            setState((current) => ({ ...current, status: 'skills closed' }))
          }}
        />
      ) : null}
      {mcpPanelOpen && options.mcp ? (
        <McpPanel
          controller={options.mcp}
          {...(options.noColor === undefined ? {} : { noColor: options.noColor })}
          terminalColumns={terminalSize.columns}
          terminalRows={terminalSize.rows}
          onNotice={(text) => appendSystemMessage(setState, text)}
          onClose={() => {
            setMcpPanelOpen(false)
            setState((current) => ({ ...current, status: 'mcp closed' }))
          }}
        />
      ) : null}
      {subagentsPanelOpen && options.subagents ? (
        <SubagentsPanel
          controller={options.subagents}
          {...(options.noColor === undefined ? {} : { noColor: options.noColor })}
          terminalColumns={terminalSize.columns}
          terminalRows={terminalSize.rows}
          onNotice={(text) => appendSystemMessage(setState, text)}
          onClose={() => {
            setSubagentsPanelOpen(false)
            setState((current) => ({ ...current, status: 'subagents closed' }))
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
                syncSessionModel(resumed.model)
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
      {commandListView ? (
        commandListView.kind === 'tabs' ? (
          <TabbedListView
            view={commandListView}
            onCancel={() => {
              setCommandListView(undefined)
              setState((current) => ({ ...current, status: 'closed' }))
            }}
            onSelect={(entry: CommandListEntry) => {
              setCommandListView(undefined)
              appendSystemMessage(
                setState,
                entry.detail ??
                  `${entry.label}${entry.value ? ` = ${entry.value}` : ''}${entry.status ? `  [${entry.status}]` : ''}`,
              )
            }}
          />
        ) : (
          <ListPicker
            view={commandListView}
            onCancel={() => {
              setCommandListView(undefined)
              setState((current) => ({ ...current, status: 'closed' }))
            }}
            onSelect={(entry: CommandListEntry) => {
              setCommandListView(undefined)
              // 选中一条 → 完整 detail（长值全文）进 transcript；无 detail 时拼主行信息
              appendSystemMessage(
                setState,
                entry.detail ??
                  `${entry.label}${entry.value ? ` = ${entry.value}` : ''}${entry.status ? `  [${entry.status}]` : ''}`,
              )
            }}
          />
        )
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
    // resize 清屏由 tui.ts renderInteractiveApp 里更早注册的监听负责（必须先于
    // ink 的 resize 渲染执行），这里只跟踪尺寸驱动重渲染。
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

/** turn 运行期排队的输入：文本 + 各自的附件 chip（§7.5.2）。 */
interface QueuedInput {
  attachments: readonly SubmitAttachment[]
  text: string
}

function submitOptions(
  currentModelId: string,
  attachments: readonly SubmitAttachment[] = [],
): SubmitOptions | undefined {
  if (!currentModelId && attachments.length === 0) return undefined
  return {
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(currentModelId ? { model: currentModelId } : {}),
  }
}

/**
 * §7.5.2：transcript 里 hash 形态的图片 chip（[image: 49779094.png]，由
 * contentPartChipLabel 从引用式 ContentPart 派生）回译成输入行的顺序编号
 * chip（[Image #1]）。只处理 image；file chip 两侧同为 basename 无需映射。
 */
function remapImageChips(text: string, chipsByHandle: ReadonlyMap<string, string>): string {
  if (chipsByHandle.size === 0 || !text.includes('[image:')) return text
  return text.replace(
    /\[image: ([0-9a-f]{8})\.(\w+)\]/g,
    (full, prefix: string) => chipsByHandle.get(prefix) ?? full,
  )
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

function unavailableSlashCommand(name: string, description: string, order: number): SlashCommand {
  return {
    name,
    description,
    order,
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

/**
 * 命令执行结果：message → 系统消息进 transcript（level 染状态行：warning 橙 /
 * error 红；info 不动）；list → 打开 ListPicker 面板（数据描述符，可能来自插件
 * 沙箱经桥返回）；tabs → 打开多页签面板（/plugins 风格）。
 *
 * level 刻意止步于 'error'，不收全宽 StatusLevel：'active' 是回合生命周期态
 * （spinner + InputBox 禁用 + esc 中断），命令结果置入且无人复位会软锁 REPL；
 * 'muted' 是空闲基线，内置命令要设状态可直接 setState（/undo 先例），无需经
 * outcome 通道。
 */
export type SlashCommandOutcome =
  | { kind: 'message'; text: string; level: 'info' | 'warning' | 'error' }
  | { kind: 'list'; view: CommandListView }
  | { kind: 'tabs'; view: CommandTabsView }
  | { kind: 'submit'; text: string }

export async function runSlashCommand(
  raw: string,
  commands: readonly SlashCommand[],
): Promise<SlashCommandOutcome | undefined> {
  const [name = '', ...args] = raw.slice(1).trim().split(/\s+/).filter(Boolean)
  if (!name) return undefined
  const command = commands.find((item) => item.name === name || item.aliases?.includes(name))
  if (!command)
    return { kind: 'message', text: `Unknown slash command: /${name}`, level: 'warning' }
  if (command.available === false)
    return {
      kind: 'message',
      text: `/${command.name} is not available in this build/session`,
      level: 'warning',
    }
  try {
    const output = await command.run({ args, name: command.name, raw })
    if (typeof output === 'string' && output)
      return { kind: 'message', text: output, level: 'info' }
    // 桥值是任意 JSON：形状不合法的视图按无输出处理（fail-open，不炸 REPL）
    if (isCommandListView(output)) return { kind: 'list', view: output }
    if (isCommandTabsView(output)) return { kind: 'tabs', view: output }
    // submit 视图等价于"以用户身份发言"——只允许 builtin（无 source）与 skill
    // 来源产出；插件/测试来源一律降级为系统消息（防伪造用户输入）。
    if (isSlashSubmitView(output)) {
      const source = (command as { source?: { kind?: string } }).source?.kind
      if (source === undefined || source === 'builtin' || source === 'skill')
        return { kind: 'submit', text: output.text }
      return {
        kind: 'message',
        text: `/${command.name} returned a submit view, which is only allowed for builtin and skill commands`,
        level: 'warning',
      }
    }
  } catch (error) {
    return {
      kind: 'message',
      text: error instanceof Error ? error.message : `/${command.name} failed`,
      level: 'error',
    }
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

/**
 * 命令排序（稳定）：设置 order 的命令按升序浮到前面；未设置的保持在传入
 * 顺序（内置在前、注册序在后——即现状）。建议下拉与 /help 共用这一顺序。
 */
export function sortSlashCommands(commands: readonly SlashCommand[]): SlashCommand[] {
  return [...commands].toSorted(
    (left, right) =>
      (left.order ?? Number.MAX_SAFE_INTEGER) - (right.order ?? Number.MAX_SAFE_INTEGER),
  )
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
  // 附录 D.2 message.appended：★content（引用式 ContentPart[]）取 text part 拼接；
  // §7.5.2：image/file part 渲染回 chip 文本（[image: a1b2c3d4.png]），与输入行一致。
  const content = objectPayload.content
  if (Array.isArray(content)) {
    return content
      .filter(
        (part): part is { type: string; text: string } =>
          !!part && typeof part === 'object' && !Array.isArray(part),
      )
      .map((part) => {
        if (part.type === 'text' && typeof part.text === 'string') return part.text
        const chip = contentPartChipLabel(part)
        return chip ? `${chip} ` : ''
      })
      .join('')
  }
  return ''
}

function payloadRole(payload: CoreEvent['payload']): TranscriptEntry['role'] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return 'system'
  const role = (payload as Record<string, unknown>).role
  return role === 'assistant' || role === 'user' || role === 'system' ? role : 'system'
}
