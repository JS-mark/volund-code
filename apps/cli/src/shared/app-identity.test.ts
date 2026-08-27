import { describe, expect, it } from 'vitest'

import { defineAppIdentity } from './app-identity'

describe('AppIdentity', () => {
  it('accepts and freezes an explicit SemVer build identity', () => {
    const identity = defineAppIdentity({ version: '2.4.0-rc.1+abc123', channel: 'next' })
    expect(identity).toEqual({ version: '2.4.0-rc.1+abc123', channel: 'next' })
    expect(Object.isFrozen(identity)).toBe(true)
  })

  it.each(['0.0.0', 'latest', '1.2'])(
    'fails closed for invalid production version %s',
    (version) => {
      expect(() => defineAppIdentity({ version })).toThrow('Volund')
    },
  )
})
