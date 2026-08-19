import { describe, expect, it } from 'vitest'

import {
  formatPermissionTextForDisplay,
  formatPermissionValueForDisplay,
} from './permission-display'

describe('permission display safety', () => {
  it.each([
    ['ESC/C0', '\u001B', '\\u{001B}'],
    ['DEL', '\u007F', '\\u{007F}'],
    ['C1 NEL', '\u0085', '\\u{0085}'],
    ['C1 CSI', '\u009B', '\\u{009B}'],
    ['NBSP', '\u00A0', '\\u{00A0}'],
    ['line separator', '\u2028', '\\u{2028}'],
    ['paragraph separator', '\u2029', '\\u{2029}'],
    ['bidi override', '\u202E', '\\u{202E}'],
    ['bidi isolate', '\u2067', '\\u{2067}'],
    ['zero-width space', '\u200B', '\\u{200B}'],
    ['zero-width joiner', '\u200D', '\\u{200D}'],
    ['BOM', '\uFEFF', '\\u{FEFF}'],
    ['lone surrogate', '\uD800', '\\u{D800}'],
    ['lone low surrogate', '\uDFFF', '\\u{DFFF}'],
    ['noncharacter', '\uFDD0', '\\u{FDD0}'],
    ['variation selector', '\uFE0F', '\\u{FE0F}'],
    ['supplementary variation selector', '\u{E0100}', '\\u{E0100}'],
  ])('escapes %s', (_label, input, expected) => {
    expect(formatPermissionTextForDisplay(input)).toEqual({
      approvable: true,
      text: expected,
    })
  })

  it.each([
    'ASCII spaces stay readable',
    '普通中文保持可读',
    'emoji 😀 stays readable',
    'skin tone 👍🏽 stays readable',
    'flag 🇨🇳 stays readable',
  ])('keeps ordinary text readable: %s', (input) => {
    expect(formatPermissionTextForDisplay(input)).toEqual({ approvable: true, text: input })
  })

  it('keeps literal escape text distinct from the code point it resembles', () => {
    expect(formatPermissionTextForDisplay('\\u{202E}')).toEqual({
      approvable: true,
      text: '\\\\u{202E}',
    })
    expect(formatPermissionTextForDisplay('\u202E')).toEqual({
      approvable: true,
      text: '\\u{202E}',
    })
    expect(formatPermissionTextForDisplay('\\u{202E}')).not.toEqual(
      formatPermissionTextForDisplay('\u202E'),
    )
  })

  it('fails closed when an untrusted tool label exceeds the display budget', () => {
    expect(formatPermissionTextForDisplay('x'.repeat(16_385))).toEqual({
      approvable: false,
      text: '[permission label unavailable]',
    })
  })

  it('renders nested values without changing their ordinary content', () => {
    expect(formatPermissionValueForDisplay({ bash: { command: 'echo 中文 😀\u202E' } })).toEqual({
      approvable: true,
      text: '{"bash":{"command":"echo 中文 😀\\u{202E}"}}',
    })
  })

  it.each([
    [
      'cyclic value',
      () => {
        const value: { self?: unknown } = {}
        value.self = value
        return value
      },
    ],
    [
      'throwing getter',
      () =>
        Object.defineProperty({}, 'command', {
          enumerable: true,
          get() {
            throw new Error('boom')
          },
        }),
    ],
    ['unsupported bigint', () => ({ value: 1n })],
    ['NaN', () => ({ value: Number.NaN })],
    ['positive infinity', () => ({ value: Number.POSITIVE_INFINITY })],
    ['negative infinity', () => ({ value: Number.NEGATIVE_INFINITY })],
    ['negative zero', () => ({ value: -0 })],
    ['sparse array', () => Array(1)],
    ['array with extra property', () => Object.assign(['safe'], { hiddenInput: 'not rendered' })],
    ['symbol property', () => ({ [Symbol('hidden')]: 'not rendered' })],
    [
      'non-enumerable property',
      () => Object.defineProperty({}, 'hidden', { value: 'not rendered' }),
    ],
    [
      'over-depth value',
      () => {
        let value: unknown = 'leaf'
        for (let index = 0; index < 34; index++) value = { value }
        return value
      },
    ],
    ['over-budget value', () => ({ command: 'x'.repeat(16_384) })],
    ['over-node-budget value', () => Array.from({ length: 4_100 }, () => null)],
  ] as const)('fails closed for a %s', (_label, createValue) => {
    expect(formatPermissionValueForDisplay(createValue())).toEqual({
      approvable: false,
      text: '[permission details unavailable - deny only]',
    })
  })
})
