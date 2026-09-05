/**
 * API client（§22.8.1）：nonce fragment → browser session → 带 CSRF 的调用。
 * fragment 从不进 HTTP 请求；csrfToken 只存内存（不写 localStorage）。
 */
export interface BrowserSession {
  serverId: string
  csrfToken: string
  expiresAt: number
}

export interface ApiError {
  code: string
  message: string
}

async function parseResponse<T>(res: Response): Promise<T> {
  const body = (await res.json()) as { data?: T; error?: ApiError }
  if (!res.ok)
    throw Object.assign(new Error(body.error?.message ?? res.statusText), {
      code: body.error?.code ?? 'unknown',
    })
  return body.data as T
}

/** 启动 nonce（URL fragment）一次性交换为 HttpOnly session + CSRF token。 */
export async function exchangeNonce(): Promise<BrowserSession> {
  const nonce = new URL(window.location.href).hash.replace('#token=', '')
  if (!nonce)
    throw Object.assign(new Error('missing launch nonce — start via `volund web`'), {
      code: 'web_session_invalid',
    })
  const res = await fetch('/api/v1/browser-session/exchange', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nonce }),
  })
  const session = await parseResponse<BrowserSession>(res)
  // nonce 已消费：清掉 fragment，防止刷新/分享泄漏重放面。
  history.replaceState(null, '', window.location.pathname)
  return session
}

export interface Bootstrap {
  server: { serverId: string; version: string; startedAt: number }
  workspace: { cwd: string }
  capabilities: Record<string, unknown>
}

export interface SessionSummary {
  id: string
  cwd: string
  updatedAt: string
  title: string
  summary?: string
}

export interface StatusView {
  status: readonly { label: string; value: string }[]
  [key: string]: unknown
}

export class WebApi {
  constructor(private readonly session: BrowserSession) {}

  async bootstrap(): Promise<Bootstrap> {
    return parseResponse(await fetch('/api/v1/bootstrap'))
  }
  async sessions(): Promise<readonly SessionSummary[]> {
    const data = await parseResponse<{ sessions: readonly SessionSummary[] }>(
      await fetch('/api/v1/sessions'),
    )
    return data.sessions
  }
  async status(): Promise<StatusView> {
    return parseResponse(await fetch('/api/v1/status'))
  }
  /** SSE 事件流（cookie 鉴权；hello/heartbeat）。 */
  events(onEvent: (kind: string, data: unknown) => void): EventSource {
    const source = new EventSource('/api/v1/events')
    source.addEventListener('control', (event) => {
      onEvent('control', JSON.parse((event as MessageEvent).data as string))
    })
    return source
  }
}
