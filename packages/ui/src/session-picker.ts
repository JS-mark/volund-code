// SessionCandidate 契约已迁至 @volund/app-runtime（§22.7.1：TUI/Web 共用）；
// 此处 re-export 保持既有引用兼容。
import type { SessionCandidate } from '@volund/app-runtime'

export type { SessionCandidate }

export interface SessionPickerState {
  sessions: readonly SessionCandidate[]
  query: string
  selected: number
}

export interface SessionPickerPage {
  end: number
  items: readonly SessionCandidate[]
  start: number
  total: number
}

export type SessionPickerAction =
  | { type: 'cancel' }
  | { type: 'select'; session: SessionCandidate }
  | { type: 'update'; state: SessionPickerState }

export function filterSessions(
  sessions: readonly SessionCandidate[],
  query: string,
): SessionCandidate[] {
  const terms = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean)
  return [...sessions]
    .map((session) => ({ session, score: sessionScore(session, terms) }))
    .filter(
      (result): result is { session: SessionCandidate; score: number } =>
        result.score !== undefined,
    )
    .toSorted(
      (a, b) =>
        b.score - a.score ||
        timestamp(b.session.updatedAt) - timestamp(a.session.updatedAt) ||
        a.session.id.localeCompare(b.session.id),
    )
    .map(({ session }) => session)
}

export function createSessionPickerState(
  sessions: readonly SessionCandidate[],
): SessionPickerState {
  return { sessions, query: '', selected: 0 }
}

export function sessionPickerKey(
  state: SessionPickerState,
  key: string,
  pageSize = 10,
): SessionPickerAction {
  const filtered = filterSessions(state.sessions, state.query)
  if (key === 'Escape') return { type: 'cancel' }
  if (key === 'Enter') {
    const session = filtered[state.selected]
    return session ? { type: 'select', session } : { type: 'update', state }
  }
  if (
    key === 'ArrowUp' ||
    key === 'ArrowDown' ||
    key === 'PageUp' ||
    key === 'PageDown' ||
    key === 'Home' ||
    key === 'End'
  ) {
    if (!filtered.length) return { type: 'update', state: { ...state, selected: 0 } }
    const last = filtered.length - 1
    const selected =
      key === 'Home'
        ? 0
        : key === 'End'
          ? last
          : Math.max(
              0,
              Math.min(
                last,
                state.selected +
                  (key === 'ArrowUp'
                    ? -1
                    : key === 'ArrowDown'
                      ? 1
                      : key === 'PageUp'
                        ? -pageSize
                        : pageSize),
              ),
            )
    return {
      type: 'update',
      state: { ...state, selected },
    }
  }
  if (key === 'Backspace' || key === 'Delete')
    return {
      type: 'update',
      state: { ...state, query: state.query.slice(0, -1), selected: 0 },
    }
  const code = key.codePointAt(0)
  if (code !== undefined && key.length <= 2 && code >= 32 && code !== 127)
    return { type: 'update', state: { ...state, query: state.query + key, selected: 0 } }
  return { type: 'update', state }
}

export function sessionPickerPage(
  sessions: readonly SessionCandidate[],
  selected: number,
  pageSize = 10,
): SessionPickerPage {
  const size = Math.max(1, pageSize)
  const safeSelected = Math.max(0, Math.min(sessions.length - 1, selected))
  const start = sessions.length ? Math.floor(safeSelected / size) * size : 0
  const end = Math.min(sessions.length, start + size)
  return { start, end, total: sessions.length, items: sessions.slice(start, end) }
}

export function formatSessionTime(value: string, now: number | undefined = Date.now()): string {
  const reference = now ?? Date.now()
  const time = Date.parse(value)
  if (!Number.isFinite(time)) return 'time unknown'
  const delta = reference - time
  if (delta < -60_000) return new Date(time).toLocaleString()
  if (delta < 60_000) return 'just now'
  if (delta < 60 * 60_000) return `${Math.floor(delta / 60_000)}m ago`
  if (delta < 24 * 60 * 60_000) return `${Math.floor(delta / (60 * 60_000))}h ago`
  if (delta < 48 * 60 * 60_000) return 'yesterday'
  if (delta < 7 * 24 * 60 * 60_000) return `${Math.floor(delta / (24 * 60 * 60_000))}d ago`
  return new Date(time).toLocaleDateString()
}

function sessionScore(session: SessionCandidate, terms: readonly string[]): number | undefined {
  if (!terms.length) return 0
  const fields = [
    [session.title, 80],
    [session.summary ?? '', 40],
    [session.cwd, 20],
    [session.id, 10],
  ] as const
  let score = 0
  for (const term of terms) {
    let best: number | undefined
    for (const [rawValue, weight] of fields) {
      const value = rawValue.toLocaleLowerCase()
      const match = fuzzyScore(value, term)
      if (match !== undefined) best = Math.max(best ?? -Infinity, weight + match)
    }
    if (best === undefined) return undefined
    score += best
  }
  return score
}

function fuzzyScore(value: string, term: string): number | undefined {
  if (!term) return 0
  if (value === term) return 100
  const contiguous = value.indexOf(term)
  if (contiguous >= 0) return 70 - Math.min(contiguous, 30)
  let position = -1
  let gap = 0
  for (const character of term) {
    const next = value.indexOf(character, position + 1)
    if (next < 0) return undefined
    if (position >= 0) gap += next - position - 1
    position = next
  }
  return 30 - Math.min(gap, 30)
}

function timestamp(value: string): number {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}
