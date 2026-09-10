/**
 * API client（§22.8.1）：bootstrap 自动签发 browser session → 带 CSRF 的调用。
 * 进入无 token 门；csrfToken 只存内存（不写 localStorage）。
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

export interface Bootstrap {
  server: { serverId: string; version: string; startedAt: number }
  workspace: { cwd: string }
  capabilities: {
    embedded?: boolean
    models?: boolean
    permissionMode?: boolean
    [key: string]: unknown
  }
}

export interface ModelsView {
  current?: string
  options: { id: string; label: string }[]
}

/**
 * W-13 设置页 config 视图：合并生效值（user+project；凭据键已被服务端脱敏为
 * presence `true`，路径收进 redacted）、加载警告、user/project 文件路径。
 * 写入一律落用户级 config.toml（web 无 project scope）。
 */
export interface ConfigView {
  config: Record<string, unknown>
  redacted: string[]
  warnings: string[]
  files?: { user: string; project: string }
}

/**
 * 进入即建会话：GET bootstrap——无有效 cookie 时服务端自动签发 browser session
 * （Set-Cookie），payload 带回本会话 CSRF token；刷新/重开同一入口。
 */
export async function openBrowserSession(): Promise<{
  session: BrowserSession
  bootstrap: Bootstrap
}> {
  const res = await fetch('/api/v1/bootstrap')
  const bootstrap = await parseResponse<
    Bootstrap & { session: { csrfToken: string; expiresAt: number } }
  >(res)
  return {
    session: {
      serverId: bootstrap.server.serverId,
      csrfToken: bootstrap.session.csrfToken,
      expiresAt: bootstrap.session.expiresAt,
    },
    bootstrap,
  }
}

export interface SessionSummary {
  id: string
  cwd: string
  updatedAt: string
  title: string
  summary?: string
}

/** 侧栏会话分组（组织元数据；assignments 为 sessionId → groupId）。 */
export interface SessionGroup {
  id: string
  name: string
  createdAt: number
}

export interface SessionGroupsView {
  groups: readonly SessionGroup[]
  assignments: Record<string, string>
}

export interface StatusView {
  status: readonly { label: string; value: string }[]
  [key: string]: unknown
}

// ── REM-r1 远程控制 ────────────────────────────────────────────────────
export interface RemoteStatusView {
  state: 'off' | 'connecting' | 'online'
  gatewayUrl: string | undefined
  attempt: number
  lastError: string | undefined
  lastOnlineAt: number | undefined
}

export interface RemoteChannel {
  id: string
  name: string
  description: string
  available: boolean
}

export interface RemoteDevice {
  id: string
  name: string
  pairedAt: number
  lastSeen: number
}

export interface RemoteView {
  status: RemoteStatusView
  channels: RemoteChannel[]
  devices: RemoteDevice[]
}

export interface PairingInvitation {
  code: string
  url: string
  expiresAt: number
}

export interface ActiveSession {
  active: { id: string; cwd?: string } | null
  pendingPermissions: string[]
}

/** transcript 条目携带的图片引用（chip = text 里的占位 token；handle = AttachmentStore 引用）。 */
export interface TranscriptAttachment {
  chip: string
  kind: 'image'
  mime: string
  handle?: string
}

export interface TranscriptEntry {
  id: string
  role: 'assistant' | 'system' | 'user'
  text: string
  attachments?: readonly TranscriptAttachment[]
}

/** §22 W-05：已暂存附件（AttachmentStore handle 引用；字节永不进事件流/日志）。 */
export interface StagedAttachment {
  kind: 'file' | 'image'
  mime: string
  size: number
  handle?: string
  path?: string
}

/** 提交 turn 时随 prompt 携带的附件引用（chip 为 UI 侧占位 token）。 */
export interface TurnAttachment extends StagedAttachment {
  chip: string
}

// ── 工作台（右侧面板）─────────────────────────────────────────────────
export interface WbEntry {
  path: string
  name: string
  kind: 'dir' | 'file' | 'other'
  size: number
  mtimeMs: number
}

export interface WbFileRead {
  path: string
  size: number
  binary: boolean
  truncated: boolean
  content: string
}

export interface WbMatch {
  path: string
  line: number
  text: string
}

export interface WbGitStatus {
  isRepo: boolean
  branch?: string
  entries: { path: string; x: string; y: string; origPath?: string }[]
}

/** fs/stat 返回面（代码页 FileSystemProvider 用）。 */
export interface WbStat {
  path: string
  kind: 'dir' | 'file' | 'other'
  size: number
  mtimeMs: number
}

/** fs/read-bytes 返回面（base64 字节；图片等二进制预览走这里）。 */
export interface WbFileBytes {
  path: string
  size: number
  base64: string
}

export class WebApi {
  constructor(private readonly session: BrowserSession) {}

  // ── P3 会话生命周期 ────────────────────────────────────────────────
  async activeSession(): Promise<ActiveSession> {
    return parseResponse(await fetch('/api/v1/sessions/active'))
  }
  async startSession(cwd: string): Promise<{ id: string }> {
    return parseResponse(
      await fetch('/api/v1/sessions', {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ cwd }),
      }),
    )
  }
  async resumeSession(id: string): Promise<{ id: string }> {
    return parseResponse(
      await fetch('/api/v1/sessions/resume', {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ id }),
      }),
    )
  }
  async transcript(): Promise<{
    id?: string
    cwd?: string
    transcript: readonly TranscriptEntry[]
  }> {
    return parseResponse(await fetch('/api/v1/sessions/active/transcript'))
  }
  async submitTurn(
    prompt: string,
    options: { model?: string; attachments?: readonly TurnAttachment[] } = {},
  ): Promise<void> {
    const res = await fetch('/api/v1/sessions/active/turns', {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        prompt,
        ...(options.model ? { model: options.model } : {}),
        ...(options.attachments?.length ? { attachments: options.attachments } : {}),
      }),
    })
    if (res.status === 409) {
      const body = (await res.json()) as { error?: ApiError }
      throw Object.assign(new Error(body.error?.message ?? 'turn in progress'), {
        code: body.error?.code ?? 'turn_in_progress',
      })
    }
    await parseResponse(res)
  }
  /** W-05 图片上传：字节直传（Content-Type=mime），返回内容寻址的暂存引用。 */
  async stageAttachment(bytes: Blob, mime: string): Promise<StagedAttachment> {
    const res = await fetch('/api/v1/sessions/active/attachments', {
      method: 'POST',
      headers: { 'Content-Type': mime, 'X-Volund-Csrf': this.session.csrfToken },
      body: bytes,
    })
    return parseResponse(res)
  }
  async interrupt(): Promise<void> {
    await parseResponse(
      await fetch('/api/v1/sessions/active/interrupt', { method: 'POST', headers: this.headers() }),
    )
  }
  async endSession(): Promise<void> {
    await parseResponse(
      await fetch('/api/v1/sessions/active/end', { method: 'POST', headers: this.headers() }),
    )
  }
  // ── W-08 变更/undo ────────────────────────────────────────────────
  async changes(): Promise<{
    sessionId: string
    paths: {
      path: string
      created: boolean
      batches: number
      lastModifiedAt: string
      allConsumed: boolean
    }[]
    missing: boolean
  }> {
    return parseResponse(await fetch('/api/v1/sessions/active/changes'))
  }
  async undoPreview(): Promise<{
    undoable: boolean
    reason?: string
    paths: string[]
    warnings: { path: string; kind: string }[]
    stepCreatedAt?: string
  }> {
    return parseResponse(await fetch('/api/v1/sessions/active/undo/preview'))
  }
  async undo(): Promise<{
    undone: boolean
    paths: string[]
    warnings: { path: string; kind: string }[]
  }> {
    return parseResponse(
      await fetch('/api/v1/sessions/active/undo', { method: 'POST', headers: this.headers() }),
    )
  }
  async decidePermission(requestId: string, kind: string): Promise<void> {
    await parseResponse(
      await fetch('/api/v1/permissions/decide', {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ requestId, kind }),
      }),
    )
  }

  // ── P4 管理面 ─────────────────────────────────────────────────────
  async managementList(domain: string): Promise<unknown> {
    return parseResponse(await fetch(`/api/v1/${domain}/actions`))
  }
  async managementAction(domain: string, body: Record<string, unknown>): Promise<unknown> {
    return parseResponse(
      await fetch(`/api/v1/${domain}/actions`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
      }),
    )
  }

  private headers(): Record<string, string> {
    return { 'Content-Type': 'application/json', 'X-Volund-Csrf': this.session.csrfToken }
  }

  async sessions(): Promise<readonly SessionSummary[]> {
    const data = await parseResponse<{ sessions: readonly SessionSummary[] }>(
      await fetch('/api/v1/sessions'),
    )
    return data.sessions
  }
  // ── 侧栏会话分组 ────────────────────────────────────────────────────
  async sessionGroups(): Promise<SessionGroupsView> {
    return parseResponse(await fetch('/api/v1/session-groups'))
  }
  async createSessionGroup(name: string): Promise<SessionGroup> {
    const data = await parseResponse<{ group: SessionGroup }>(
      await fetch('/api/v1/session-groups', {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ name }),
      }),
    )
    return data.group
  }
  async renameSessionGroup(id: string, name: string): Promise<void> {
    await parseResponse(
      await fetch('/api/v1/session-groups/rename', {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ id, name }),
      }),
    )
  }
  async deleteSessionGroup(id: string): Promise<void> {
    await parseResponse(
      await fetch('/api/v1/session-groups/delete', {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ id }),
      }),
    )
  }
  /** groupId 为 null = 移出分组（回未分组）。 */
  async assignSessionGroup(sessionId: string, groupId: string | null): Promise<void> {
    await parseResponse(
      await fetch('/api/v1/session-groups/assign', {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ sessionId, groupId }),
      }),
    )
  }
  async status(): Promise<StatusView> {
    return parseResponse(await fetch('/api/v1/status'))
  }
  /** W-06：模型候选（current + aliases 解析后的 provider/model 全限定 id）。 */
  async models(): Promise<ModelsView> {
    return parseResponse(await fetch('/api/v1/models'))
  }
  /** §4.4 权限模式（ask/auto/full）。 */
  async permissionMode(): Promise<{ mode: string }> {
    return parseResponse(await fetch('/api/v1/permission-mode'))
  }
  async setPermissionMode(mode: string): Promise<{ mode: string }> {
    return parseResponse(
      await fetch('/api/v1/permission-mode', {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ mode }),
      }),
    )
  }
  /** 退出登录：销毁 browser session（cookie 过期 + 服务端删除）。 */
  async logout(): Promise<void> {
    await parseResponse(
      await fetch('/api/v1/browser-session/logout', {
        method: 'POST',
        headers: this.headers(),
      }),
    )
  }

  // ── REM-r1 远程控制（/uplink 状态 / 渠道 / 设备 / 配对） ─────────────
  async remote(): Promise<RemoteView> {
    return parseResponse(await fetch('/api/v1/remote'))
  }
  async remoteAction(body: {
    type: 'start' | 'stop' | 'create-pairing' | 'revoke-device'
    deviceId?: string
  }): Promise<unknown> {
    return parseResponse(
      await fetch('/api/v1/remote/actions', {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
      }),
    )
  }

  // ── 工作台 ─────────────────────────────────────────────────────────
  async wbListDir(path?: string): Promise<{ path: string; entries: WbEntry[] }> {
    const query = path ? `?path=${encodeURIComponent(path)}` : ''
    return parseResponse(await fetch(`/api/v1/workbench/fs/list${query}`))
  }
  async wbReadFile(path: string): Promise<WbFileRead> {
    return parseResponse(await fetch(`/api/v1/workbench/fs/read?path=${encodeURIComponent(path)}`))
  }
  async wbWriteFile(path: string, content: string): Promise<{ path: string; size: number }> {
    return parseResponse(
      await fetch('/api/v1/workbench/fs/write', {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ path, content }),
      }),
    )
  }
  async wbFindFiles(query: string): Promise<{ results: { path: string; name: string }[] }> {
    return parseResponse(await fetch(`/api/v1/workbench/fs/find?q=${encodeURIComponent(query)}`))
  }
  async wbSearch(query: string): Promise<{ matches: WbMatch[]; truncated: boolean }> {
    return parseResponse(await fetch(`/api/v1/workbench/search?q=${encodeURIComponent(query)}`))
  }
  async wbGitStatus(): Promise<WbGitStatus> {
    return parseResponse(await fetch('/api/v1/workbench/git/status'))
  }
  async wbGitDiff(path?: string): Promise<{ diff: string }> {
    const query = path ? `?path=${encodeURIComponent(path)}` : ''
    return parseResponse(await fetch(`/api/v1/workbench/git/diff${query}`))
  }
  /** 工作台终端走 WebSocket（/api/v1/workbench/terminal/ws），不经 REST client。 */

  // ── 代码页（内嵌 vscode workbench 的 FileSystemProvider 后端）────────────
  async wbStat(path: string): Promise<WbStat> {
    return parseResponse(await fetch(`/api/v1/workbench/fs/stat?path=${encodeURIComponent(path)}`))
  }
  async wbReadBytes(path: string): Promise<WbFileBytes> {
    return parseResponse(
      await fetch(`/api/v1/workbench/fs/read-bytes?path=${encodeURIComponent(path)}`),
    )
  }
  async wbWriteBytes(path: string, base64: string): Promise<{ path: string; size: number }> {
    return parseResponse(
      await fetch('/api/v1/workbench/fs/write-bytes', {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ path, base64 }),
      }),
    )
  }
  async wbMkdir(path: string): Promise<unknown> {
    return parseResponse(
      await fetch('/api/v1/workbench/fs/mkdir', {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ path }),
      }),
    )
  }
  async wbDelete(path: string, recursive: boolean): Promise<unknown> {
    return parseResponse(
      await fetch('/api/v1/workbench/fs/delete', {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ path, recursive }),
      }),
    )
  }
  async wbRename(from: string, to: string): Promise<unknown> {
    return parseResponse(
      await fetch('/api/v1/workbench/fs/rename', {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ from, to }),
      }),
    )
  }

  /**
   * W-13 设置页 config 全量读写：key 形状由服务端校验，schema 校验（未知 key /
   * 类型错）在端口内（config_unknown_key / config_invalid）；value 为任意 JSON
   * 值（数组/对象用于 aliases、router.chain、env 等结构化键）。
   */
  async configGet(): Promise<ConfigView> {
    return parseResponse(await fetch('/api/v1/config'))
  }
  async configSet(key: string, value: unknown): Promise<unknown> {
    return parseResponse(
      await fetch('/api/v1/config/set', {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ key, value }),
      }),
    )
  }
  /** W-13 clear：删除用户级 key（重置为默认）。 */
  async configUnset(key: string): Promise<unknown> {
    return parseResponse(
      await fetch('/api/v1/config/unset', {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ key }),
      }),
    )
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
