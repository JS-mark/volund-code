import { describe, expect, it } from 'vitest'

import { createSession, lineageRootSessionId, updateSession } from './session'

describe('SessionState', () => {
  it('updates immutably and increments version', () => {
    const original = createSession({
      id: 's',
      cwd: '/repo',
      maxTokens: 100,
      toolRegistrySnapshot: 'tools-1',
    })
    const updated = updateSession(original, (draft) => {
      draft.pendingInterrupt = true
    })
    expect(original.pendingInterrupt).toBe(false)
    expect(updated.pendingInterrupt).toBe(true)
    expect(updated.version).toBe(1)
  })
  it('does not persist a permission cache in SessionState', () => {
    expect(
      createSession({ id: 's', cwd: '/repo', maxTokens: 100, toolRegistrySnapshot: 'tools-1' }),
    ).not.toHaveProperty('permissionCache')
  })
})

describe('lineage rootSessionId (SAG-06, spec §2.7bis.3 U1)', () => {
  it('a top-level session is its own lineage root', () => {
    const state = createSession({
      id: 'root-1',
      cwd: '/repo',
      maxTokens: 100,
      toolRegistrySnapshot: 't',
    })
    expect(state.lineage).toEqual({ depth: 0, rootSessionId: 'root-1' })
    expect(lineageRootSessionId(state)).toBe('root-1')
  })

  it('an explicitly-rooted lineage keeps the root (subagent → grandchild converges)', () => {
    const child = createSession({
      id: 'child-1',
      cwd: '/repo',
      maxTokens: 100,
      toolRegistrySnapshot: 't',
      lineage: { depth: 1, parentSessionId: 'root-1', rootSessionId: 'root-1' },
    })
    expect(child.lineage.rootSessionId).toBe('root-1')
    expect(lineageRootSessionId(child)).toBe('root-1')
  })

  it('a lineage without rootSessionId normalizes to self (defensive default)', () => {
    const orphan = createSession({
      id: 'child-2',
      cwd: '/repo',
      maxTokens: 100,
      toolRegistrySnapshot: 't',
      lineage: { depth: 2, parentSessionId: 'child-1' },
    })
    expect(orphan.lineage.rootSessionId).toBe('child-2')
  })

  it('lineageRootSessionId falls back to the session id for hand-built states', () => {
    const legacy = createSession({
      id: 's-1',
      cwd: '/repo',
      maxTokens: 100,
      toolRegistrySnapshot: 't',
    })
    const withoutRoot = { ...legacy, lineage: { depth: 0 } }
    expect(lineageRootSessionId(withoutRoot)).toBe('s-1')
  })
})
