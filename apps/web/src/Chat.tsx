import { useCallback, useEffect, useRef, useState } from 'react'

import type { WebApi } from './api'
import { hydrateFromTranscript, initialChatState, useSessionStream } from './session-stream'
import type { ChatState } from './session-stream'

interface ChangeRow {
  path: string
  created: boolean
  batches: number
  lastModifiedAt: string
  allConsumed: boolean
}

interface UndoPreview {
  undoable: boolean
  reason?: string
  paths: string[]
  warnings: { path: string; kind: string }[]
  stepCreatedAt?: string
}

/** 聊天视图：消息流 + composer + 权限卡 + 停止（§22 W-04/W-05/W-07 首版）。 */
export function Chat({ api, cwd }: { api: WebApi; cwd: string }) {
  const [state, setState] = useState<ChatState>(initialChatState)
  const [activeId, setActiveId] = useState<string | undefined>()
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string>()
  const stream = useSessionStream(activeId !== undefined)
  const listRef = useRef<HTMLDivElement>(null)
  const [changes, setChanges] = useState<ChangeRow[]>()
  const [showChanges, setShowChanges] = useState(false)
  const [undoPreview, setUndoPreview] = useState<UndoPreview>()
  const [undoNotice, setUndoNotice] = useState<string>()

  // 活动会话建立后拉取变更聚合（turn 结束时也会刷新）。
  useEffect(() => {
    if (activeId === undefined) return
    void api
      .changes()
      .then((snapshot) => setChanges(snapshot.paths))
      .catch(() => setChanges(undefined))
  }, [api, activeId, stream.turn])

  const loadUndoPreview = useCallback(async () => {
    try {
      setUndoPreview(await api.undoPreview())
    } catch (cause) {
      setUndoNotice(cause instanceof Error ? cause.message : String(cause))
    }
  }, [api])

  const runUndo = useCallback(async () => {
    try {
      const result = await api.undo()
      setUndoPreview(undefined)
      setUndoNotice(
        result.undone
          ? `已撤销 ${result.paths.length} 个文件${result.warnings.length ? `（${result.warnings.length} 条警告）` : ''}`
          : '没有可撤销的批次',
      )
      setChanges(undefined)
      setNotice(undefined)
    } catch (cause) {
      setUndoNotice(cause instanceof Error ? cause.message : String(cause))
    }
  }, [api])

  // 合并 SSE 状态与本地 notice（SSE 的 notice 覆盖本地提示）。
  useEffect(() => {
    if (stream.notice !== undefined) setNotice(stream.notice)
  }, [stream.notice])

  const refreshTranscript = useCallback(async () => {
    const snapshot = await api.transcript()
    setState((current) => hydrateFromTranscript(current, snapshot.transcript))
    setActiveId(snapshot.id)
  }, [api])

  // 活动会话探测 + 恢复：切到 Chat 即尝试拉活动会话/transcript。
  useEffect(() => {
    void (async () => {
      try {
        const active = await api.activeSession()
        if (active.active) {
          setActiveId(active.active.id)
          await refreshTranscript()
        }
      } catch {
        // 首次进入无活动会话：静默（界面展示新建入口）。
      }
    })()
  }, [api, refreshTranscript])

  const start = useCallback(async () => {
    setBusy(true)
    try {
      const { id } = await api.startSession(cwd)
      setActiveId(id)
      setState(initialChatState)
      await refreshTranscript()
      setNotice(undefined)
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }, [api, cwd, refreshTranscript])

  const send = useCallback(async () => {
    const prompt = draft.trim()
    if (!prompt || stream.turn === 'running') return
    setDraft('')
    setNotice(undefined)
    // 本地乐观回显：user 消息会随后经 message.appended 事件收口。
    setState((current) => ({
      ...current,
      messages: [...current.messages, { id: `local-${Date.now()}`, role: 'user', text: prompt }],
    }))
    try {
      await api.submitTurn(prompt)
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : String(cause))
    }
  }, [api, draft, stream.turn])

  const decide = useCallback(
    async (kind: string) => {
      if (!stream.permission) return
      try {
        await api.decidePermission(stream.permission.id, kind)
      } catch (cause) {
        setNotice(cause instanceof Error ? cause.message : String(cause))
      }
    },
    [api, stream.permission],
  )

  const end = useCallback(async () => {
    setBusy(true)
    try {
      await api.endSession()
      setActiveId(undefined)
      setState(initialChatState)
    } finally {
      setBusy(false)
    }
  }, [api])

  // 消息列表自动滚底。
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [state.messages.length, state.messages.at(-1)?.text])

  if (activeId === undefined)
    return (
      <section>
        <h2>新会话</h2>
        <p className="muted">将在工作区 {cwd} 创建会话（模型与权限模式沿用运行时配置）。</p>
        <button onClick={() => void start()} disabled={busy}>
          创建会话
        </button>
        {notice && <p className="warn">{notice}</p>}
      </section>
    )

  return (
    <section className="chat">
      <div className="chat-head">
        <span className="muted">{activeId.slice(0, 8)}</span>
        <span className={stream.turn === 'running' ? 'ok' : 'muted'}>
          {stream.turn === 'running' ? '● 运行中' : '○ 空闲'}
        </span>
        <button className="ghost" onClick={() => void end()} disabled={busy}>
          结束会话
        </button>
      </div>
      <div className="messages" ref={listRef}>
        {state.messages.map((message) => (
          <div key={message.id} className={`message ${message.role}`}>
            <span className="role">{message.role}</span>
            <div className="text">
              {message.text}
              {message.streaming && <span className="cursor">▊</span>}
            </div>
          </div>
        ))}
        {state.tools.map((tool) => (
          <div key={tool.toolUseId} className={`tool ${tool.status}`}>
            <span className="role">tool</span>
            {tool.tool} —{' '}
            {tool.status === 'running' ? '运行中…' : tool.status === 'error' ? '失败' : '完成'}
          </div>
        ))}
        {state.usage && (
          <div className="muted usage">
            用量：in {state.usage.inputTokens} / out {state.usage.outputTokens}
            {state.usage.costUSD !== null ? ` · $${state.usage.costUSD.toFixed(4)}` : ''}
          </div>
        )}
        {state.permission && (
          <div className="permission">
            <div>
              <strong>权限请求</strong>：{state.permission.display.toolName}
            </div>
            <pre>{state.permission.display.spec}</pre>
            {state.permission.display.approvable ? (
              <div className="actions">
                <button onClick={() => void decide('allow-once')}>允许一次</button>
                <button onClick={() => void decide('allow-session')}>本会话允许</button>
                <button className="danger" onClick={() => void decide('deny')}>
                  拒绝
                </button>
              </div>
            ) : (
              <div className="actions">
                <button className="danger" onClick={() => void decide('deny')}>
                  拒绝（详情不可批准）
                </button>
              </div>
            )}
          </div>
        )}
        {notice && <div className="warn">{notice}</div>}
        {changes && changes.length > 0 && (
          <div className="changes">
            <div className="row">
              <strong>本会话文件变更（{changes.length}）</strong>
              <button className="ghost" onClick={() => setShowChanges((value) => !value)}>
                {showChanges ? '收起' : '展开'}
              </button>
              <button
                className="ghost"
                onClick={() => {
                  setShowChanges(true)
                  void loadUndoPreview()
                }}
              >
                撤销上一批…
              </button>
            </div>
            {showChanges && (
              <ul className="change-list">
                {changes.map((row) => (
                  <li key={row.path}>
                    <span className={row.created ? 'ok' : ''}>
                      {row.created ? '[新建]' : '[修改]'}
                    </span>{' '}
                    {row.path}
                    <span className="muted">
                      {' '}
                      · {row.batches} 批 · {row.allConsumed ? '已撤销' : row.lastModifiedAt}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {undoPreview && (
              <div className="undo-confirm">
                {undoPreview.undoable ? (
                  <>
                    <div>
                      将撤销 <strong>{undoPreview.paths.length}</strong> 个文件的上一批变更：
                    </div>
                    <ul>
                      {undoPreview.paths.map((path) => (
                        <li key={path} className="muted">
                          {path}
                        </li>
                      ))}
                    </ul>
                    {undoPreview.warnings.map((warning) => (
                      <div key={warning.path} className="warn">
                        ⚠ {warning.path}:{' '}
                        {warning.kind === 'target_modified'
                          ? '备份后曾被外部修改，撤销可能覆盖手工改动'
                          : '备份对象缺失，该文件将跳过'}
                      </div>
                    ))}
                    <div className="actions">
                      <button className="danger" onClick={() => void runUndo()}>
                        确认撤销
                      </button>
                      <button className="ghost" onClick={() => setUndoPreview(undefined)}>
                        取消
                      </button>
                    </div>
                  </>
                ) : (
                  <div className="muted">没有可撤销的批次（no_backup）。</div>
                )}
                {undoNotice && <div className="warn">{undoNotice}</div>}
              </div>
            )}
          </div>
        )}
      </div>
      <div className="composer">
        <textarea
          value={draft}
          placeholder="输入消息（Enter 发送，Shift+Enter 换行）"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              void send()
            }
          }}
        />
        {stream.turn === 'running' ? (
          <button className="danger" onClick={() => void api.interrupt()}>
            停止
          </button>
        ) : (
          <button onClick={() => void send()} disabled={!draft.trim()}>
            发送
          </button>
        )}
      </div>
    </section>
  )
}
