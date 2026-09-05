import { useEffect, useState } from 'react'

import type { Bootstrap, BrowserSession, SessionSummary, StatusView } from './api'
import { exchangeNonce, WebApi } from './api'

type Route = 'sessions' | 'status'

interface Loaded {
  api: WebApi
  bootstrap: Bootstrap
  sessions: readonly SessionSummary[]
  status: StatusView | undefined
}

export function App() {
  const [loaded, setLoaded] = useState<Loaded>()
  const [error, setError] = useState<{ code: string; message: string }>()
  const [route, setRoute] = useState<Route>('sessions')
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const session: BrowserSession = await exchangeNonce()
        const api = new WebApi(session)
        const bootstrap = await api.bootstrap()
        const sessions = await api.sessions().catch(() => [] as const)
        const status = await api.status().catch(() => undefined)
        api.events((kind) => {
          if (kind === 'control') setConnected(true)
        })
        if (!cancelled) setLoaded({ api, bootstrap, sessions, status })
      } catch (cause) {
        if (!cancelled)
          setError({
            code: (cause as { code?: string }).code ?? 'unknown',
            message: cause instanceof Error ? cause.message : String(cause),
          })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  if (error)
    return (
      <main className="center">
        <h1>无法连接 Volund Web</h1>
        <p className="muted">
          {error.code}: {error.message}
        </p>
        <p className="muted">请确认从 `volund web` 打印的启动 URL 进入（nonce 一次性）。</p>
      </main>
    )
  if (!loaded)
    return (
      <main className="center">
        <p className="muted">正在与本地运行时建立会话…</p>
      </main>
    )

  const { bootstrap, sessions, status } = loaded
  return (
    <div className="shell">
      <header>
        <strong>Volund Web</strong>
        <span className="muted">v{bootstrap.server.version}</span>
        <span className="muted grow">{bootstrap.workspace.cwd}</span>
        <span className={connected ? 'ok' : 'warn'}>{connected ? '● 已连接' : '○ 连接中'}</span>
      </header>
      <div className="body">
        <nav>
          <button
            className={route === 'sessions' ? 'active' : ''}
            onClick={() => setRoute('sessions')}
          >
            会话
          </button>
          <button className={route === 'status' ? 'active' : ''} onClick={() => setRoute('status')}>
            状态
          </button>
        </nav>
        <main>
          {route === 'sessions' ? (
            <Sessions sessions={sessions} />
          ) : (
            <StatusView_ status={status} />
          )}
        </main>
      </div>
    </div>
  )
}

function Sessions({ sessions }: { sessions: readonly SessionSummary[] }) {
  if (sessions.length === 0)
    return <p className="muted">暂无会话。TUI 中开始的会话会出现在这里（Web 对话在 P3 落地）。</p>
  return (
    <section>
      <h2>会话（{sessions.length}）</h2>
      <ul className="sessions">
        {sessions.map((session) => (
          <li key={session.id}>
            <div className="title">{session.title}</div>
            <div className="muted">
              {session.id.slice(0, 8)} · {session.cwd}
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}

function StatusView_({ status }: { status: StatusView | undefined }) {
  if (!status) return <p className="muted">状态端口不可用（unavailable）。</p>
  return (
    <section>
      <h2>状态</h2>
      <table>
        <tbody>
          {(status.status ?? []).map((row) => (
            <tr key={row.label}>
              <td className="muted">{row.label}</td>
              <td>{row.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}
