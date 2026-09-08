/**
 * Web 侧栏会话分组存储：分组 CRUD + sessionId→groupId 归属映射，
 * 持久化为 JSON 文件（0600，tmp+rename 原子写；损坏时回退空状态不拖垮 server）。
 *
 * 只存组织元数据，不碰会话本体；已消失会话的陈旧归属由 server 在 GET 视图里
 * 裁剪（不落盘清理，随删组/重分配自然收敛）。
 */
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface SessionGroup {
  id: string
  name: string
  createdAt: number
}

export interface SessionGroupsView {
  readonly groups: readonly SessionGroup[]
  /** sessionId → groupId；只含指向现存分组的归属。 */
  readonly assignments: Record<string, string>
}

export interface SessionGroupsPort {
  list(): Promise<SessionGroupsView>
  create(name: string): Promise<SessionGroup>
  rename(id: string, name: string): Promise<SessionGroup>
  /** 删除分组：组内会话的归属一并移除（回未分组）。 */
  remove(id: string): Promise<void>
  /** groupId 为 null = 移出分组（回未分组）。 */
  assign(sessionId: string, groupId: string | null): Promise<void>
}

interface StoreState {
  groups: SessionGroup[]
  assignments: Record<string, string>
}

const MAX_NAME_LENGTH = 60

function invalid(message: string): Error {
  return Object.assign(new Error(message), { code: 'web_schema_invalid' })
}

function notFound(id: string): Error {
  return Object.assign(new Error(`session group not found: ${id}`), {
    code: 'web_session_group_not_found',
  })
}

function conflict(message: string): Error {
  return Object.assign(new Error(message), { code: 'web_state_conflict' })
}

function cleanName(name: unknown): string {
  if (typeof name !== 'string') throw invalid('group name must be a string')
  const trimmed = name.trim()
  if (!trimmed || trimmed.length > MAX_NAME_LENGTH)
    throw invalid(`group name must be 1..${MAX_NAME_LENGTH} non-blank chars`)
  return trimmed
}

function cleanState(raw: unknown): StoreState {
  const candidate = (raw ?? {}) as { groups?: unknown; assignments?: unknown }
  const groups: SessionGroup[] = []
  if (Array.isArray(candidate.groups)) {
    for (const item of candidate.groups) {
      const group = item as Partial<SessionGroup>
      if (
        group &&
        typeof group.id === 'string' &&
        typeof group.name === 'string' &&
        typeof group.createdAt === 'number'
      )
        groups.push({ id: group.id, name: group.name, createdAt: group.createdAt })
    }
  }
  const known = new Set(groups.map((group) => group.id))
  const assignments: Record<string, string> = {}
  if (candidate.assignments && typeof candidate.assignments === 'object') {
    for (const [sessionId, groupId] of Object.entries(candidate.assignments)) {
      if (typeof groupId === 'string' && known.has(groupId)) assignments[sessionId] = groupId
    }
  }
  return { groups, assignments }
}

export function createSessionGroupStore(file: string): SessionGroupsPort {
  let state: StoreState | undefined
  // 写操作串行化：并发 mutation 排队，避免交错写坏文件。
  let queue: Promise<unknown> = Promise.resolve()

  async function load(): Promise<StoreState> {
    if (state) return state
    try {
      state = cleanState(JSON.parse(await readFile(file, 'utf8')))
    } catch {
      state = { groups: [], assignments: {} }
    }
    return state
  }

  async function persist(): Promise<void> {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 })
    const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`
    await writeFile(tmp, JSON.stringify(state), { mode: 0o600 })
    await rename(tmp, file)
  }

  function mutate<T>(fn: (current: StoreState) => T): Promise<T> {
    const run = queue.then(async () => {
      const current = await load()
      const result = fn(current)
      await persist()
      return result
    })
    queue = run.catch(() => {})
    return run
  }

  function findGroup(current: StoreState, id: string): SessionGroup {
    const group = current.groups.find((candidate) => candidate.id === id)
    if (!group) throw notFound(id)
    return group
  }

  function assertNameFree(current: StoreState, name: string, exceptId?: string): void {
    if (current.groups.some((group) => group.id !== exceptId && group.name === name))
      throw conflict(`session group name already exists: ${name}`)
  }

  return {
    async list() {
      const current = await load()
      return { groups: [...current.groups], assignments: { ...current.assignments } }
    },
    async create(name) {
      const cleaned = cleanName(name)
      return mutate((current) => {
        assertNameFree(current, cleaned)
        const group: SessionGroup = {
          id: `grp_${randomBytes(8).toString('base64url')}`,
          name: cleaned,
          createdAt: Date.now(),
        }
        current.groups.push(group)
        return { ...group }
      })
    },
    async rename(id, name) {
      const cleaned = cleanName(name)
      return mutate((current) => {
        const group = findGroup(current, id)
        assertNameFree(current, cleaned, id)
        group.name = cleaned
        return { ...group }
      })
    },
    async remove(id) {
      await mutate((current) => {
        findGroup(current, id)
        current.groups = current.groups.filter((group) => group.id !== id)
        for (const [sessionId, groupId] of Object.entries(current.assignments))
          if (groupId === id) delete current.assignments[sessionId]
      })
    },
    async assign(sessionId, groupId) {
      if (typeof sessionId !== 'string' || !sessionId) throw invalid('sessionId is required')
      await mutate((current) => {
        if (groupId === null) {
          delete current.assignments[sessionId]
          return
        }
        findGroup(current, groupId)
        current.assignments[sessionId] = groupId
      })
    },
  }
}
