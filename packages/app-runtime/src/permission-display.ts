export interface PermissionDisplayResult {
  /** Approval is disabled when the complete value cannot be rendered safely. */
  approvable: boolean
  text: string
}

const unsafeCategory = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u
const nonAsciiSpace = /\p{Zs}/u
const defaultIgnorable = /\p{Default_Ignorable_Code_Point}/u
const noncharacter = /\p{Noncharacter_Code_Point}/u
const MAX_DISPLAY_DEPTH = 32
const MAX_DISPLAY_NODES = 4_096
const MAX_DISPLAY_CODE_POINTS = 16_384
const MAX_DISPLAY_BYTES = 64 * 1024
const utf8 = new TextEncoder()

interface DisplayBudget {
  nodes: number
  codePoints: number
  bytes: number
}

function take(budget: DisplayBudget, value: string): string {
  budget.codePoints -= Array.from(value).length
  budget.bytes -= utf8.encode(value).byteLength
  if (budget.codePoints < 0 || budget.bytes < 0)
    throw new RangeError('permission display exceeds its output budget')
  return value
}

function visibleUnicodeEscape(value: string): string {
  return `\\u{${value.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}}`
}

function mustEscape(value: string): boolean {
  return (
    unsafeCategory.test(value) ||
    defaultIgnorable.test(value) ||
    noncharacter.test(value) ||
    (value !== ' ' && nonAsciiSpace.test(value))
  )
}

/** Injective, bounded formatter for untrusted labels such as plugin or MCP tool names. */
export function formatPermissionTextForDisplay(value: string): PermissionDisplayResult {
  try {
    const budget: DisplayBudget = {
      nodes: 1,
      codePoints: MAX_DISPLAY_CODE_POINTS,
      bytes: MAX_DISPLAY_BYTES,
    }
    let output = ''
    for (const character of value) {
      if (character === '\\') output += take(budget, '\\\\')
      else
        output += take(budget, mustEscape(character) ? visibleUnicodeEscape(character) : character)
    }
    return { approvable: true, text: output }
  } catch {
    return { approvable: false, text: '[permission label unavailable]' }
  }
}

function quoteString(value: string, budget: DisplayBudget): string {
  let output = take(budget, '"')
  for (const character of value) {
    if (character === '"') output += take(budget, '\\"')
    else if (character === '\\') output += take(budget, '\\\\')
    else output += take(budget, mustEscape(character) ? visibleUnicodeEscape(character) : character)
  }
  return `${output}${take(budget, '"')}`
}

function renderValue(value: unknown, seen: Set<object>, budget: DisplayBudget, depth = 0): string {
  budget.nodes -= 1
  if (budget.nodes < 0) throw new RangeError('permission display exceeds its node limit')
  if (depth > MAX_DISPLAY_DEPTH) throw new RangeError('permission display exceeds its depth limit')
  if (value === null) return take(budget, 'null')
  if (typeof value === 'string') return quoteString(value, budget)
  if (typeof value === 'boolean') return take(budget, String(value))
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0))
      throw new TypeError('permission display number cannot be represented exactly')
    return take(budget, JSON.stringify(value))
  }
  if (typeof value !== 'object') throw new TypeError('permission display value is not JSON-safe')

  if (seen.has(value)) throw new TypeError('permission display value is cyclic')
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      if (value.length > budget.nodes)
        throw new RangeError('permission display array exceeds its node budget')
      const keys = Reflect.ownKeys(value)
      if (keys.some((key) => typeof key !== 'string'))
        throw new TypeError('permission display array has symbol keys')
      const stringKeys = keys as string[]
      if (
        stringKeys.length !== value.length + 1 ||
        stringKeys.some((key) => key !== 'length' && !/^\d+$/.test(key))
      )
        throw new TypeError('permission display array is sparse or has extra properties')
      const items: string[] = []
      for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        if (!descriptor?.enumerable || !('value' in descriptor))
          throw new TypeError('permission display array has accessor elements')
        if (index > 0) take(budget, ',')
        items.push(renderValue(descriptor.value, seen, budget, depth + 1))
      }
      return `${take(budget, '[')}${items.join(',')}${take(budget, ']')}`
    }

    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null)
      throw new TypeError('permission display value is not a plain object')
    const keys = Reflect.ownKeys(value)
    if (keys.length > budget.nodes)
      throw new RangeError('permission display object exceeds its node budget')
    if (keys.some((key) => typeof key !== 'string'))
      throw new TypeError('permission display value has symbol keys')
    const entries: string[] = []
    for (const key of keys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor?.enumerable || !('value' in descriptor))
        throw new TypeError('permission display value has hidden or accessor properties')
      if (entries.length > 0) take(budget, ',')
      entries.push(
        `${quoteString(key, budget)}${take(budget, ':')}${renderValue(descriptor.value, seen, budget, depth + 1)}`,
      )
    }
    return `${take(budget, '{')}${entries.join(',')}${take(budget, '}')}`
  } finally {
    seen.delete(value)
  }
}

/**
 * Renders the complete permission value or returns a deny-only marker. A partial or exceptional
 * rendering is never approvable.
 */
export function formatPermissionValueForDisplay(value: unknown): PermissionDisplayResult {
  try {
    return {
      approvable: true,
      text: renderValue(value, new Set(), {
        nodes: MAX_DISPLAY_NODES,
        codePoints: MAX_DISPLAY_CODE_POINTS,
        bytes: MAX_DISPLAY_BYTES,
      }),
    }
  } catch {
    return {
      approvable: false,
      text: '[permission details unavailable - deny only]',
    }
  }
}
