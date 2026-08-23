import {
  CapabilityContractError,
  type CapabilityContractErrorCodeV1,
  type ContractErrorDetail,
} from './errors'

/**
 * Canonical JSON V1 (§19a.2): raw-byte admission, strict value domain, and
 * the canonical encoder. This is a bootstrap primitive of the capability
 * contract — the machine registry (ABI-00, not yet implemented) will reuse
 * exactly these rules for generated validators.
 *
 * The parsed representation is plain JSON (objects with original key order);
 * the canonical encoder is the only serializer and always re-sorts keys.
 */

const MAX_DEPTH = 32
const JSON_WHITESPACE = new Set([' ', '\t', '\n', '\r'])
const SAFE_INTEGER_MAX = 9007199254740991
const SAFE_INTEGER_MIN = -9007199254740991

export interface CanonicalParseLimits {
  /** Root byte limit; checked before any decoding (input-too-large). */
  readonly maxBytes: number
  /** Require the top-level value to be an object (§19a.2.1.3). */
  readonly requireTopLevelObject?: boolean
}

export interface CanonicalParseResult {
  /** Canonical re-encoding; equals the input bytes for accepted documents. */
  readonly canonicalBytes: Uint8Array
  /** Parsed value (objects keep original key order; use encodeCanonical to serialize). */
  readonly value: unknown
}

/** Strict UTF-8 validation: no BOM, overlong, surrogate, or truncated sequences. */
export function validateUtf8(bytes: Uint8Array): ContractErrorDetail | undefined {
  let index = 0
  const fail = (code: CapabilityContractErrorCodeV1): ContractErrorDetail => ({
    code,
    byteOffset: index,
  })
  // Full UTF-8 scan first: utf8-invalid precedes bom-forbidden in the phase
  // vector, so a document that is both invalid UTF-8 and BOM-prefixed reports
  // utf8-invalid (§19a.2.4).
  const bomPrefixed =
    bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
  while (index < bytes.length) {
    const lead = bytes[index]!
    if (lead < 0x80) {
      index += 1
      continue
    }
    let length: number
    let min: number
    let max = 0xbf
    if (lead >= 0xc2 && lead <= 0xdf) {
      length = 2
      min = 0x80
    } else if (lead >= 0xe0 && lead <= 0xef) {
      length = 3
      min = lead === 0xe0 ? 0xa0 : 0x80
      if (lead === 0xed) {
        // Surrogate halves must not appear in UTF-8 at all.
        const next = bytes[index + 1]
        if (next !== undefined && next >= 0xa0 && next <= 0xbf) return fail('contract.utf8-invalid')
      }
    } else if (lead >= 0xf0 && lead <= 0xf4) {
      length = 4
      min = lead === 0xf0 ? 0x90 : 0x80
      // F4 sequences above U+10FFFF are invalid UTF-8 (§19a.2.1.1).
      max = lead === 0xf4 ? 0x8f : 0xbf
    } else {
      // 0x80-0xBF stray continuation, 0xC0/0xC1 overlong, 0xF5-0xFF out of range.
      return fail('contract.utf8-invalid')
    }
    for (let offset = 1; offset < length; offset += 1) {
      const continuation = bytes[index + offset]
      const lowerBound = offset === 1 ? min : 0x80
      const upperBound = offset === 1 ? max : 0xbf
      if (continuation === undefined || continuation < lowerBound || continuation > upperBound)
        return fail('contract.utf8-invalid')
    }
    index += length
  }
  if (bomPrefixed) return { code: 'contract.bom-forbidden', byteOffset: 0 }
  return undefined
}

const decodeUtf8 = (bytes: Uint8Array): string =>
  Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8')

const byteOffsetOf = (text: string, index: number): number =>
  Buffer.byteLength(text.slice(0, index), 'utf8')

/**
 * Internal finding: records the O(1) JS string index, never a byte offset —
 * converting per finding would be O(position) each and O(n²) on hostile input
 * (UTF-8 byte length is monotone in string index, so phase tie-breaks are
 * unchanged). The single reported winner is converted to a byte offset once,
 * at report time (§19a.2.4).
 */
interface Finding {
  readonly code: CapabilityContractErrorCodeV1
  readonly charIndex?: number
  readonly fieldPath?: string
}

interface ParseState {
  readonly text: string
  position: number
  readonly syntax: Finding[]
  readonly duplicates: Finding[]
  readonly valueDomain: Finding[]
}

/** Phase-local first finding: smallest char index wins, then smallest field path. */
function firstFinding(findings: readonly Finding[]): Finding | undefined {
  let best: Finding | undefined
  for (const finding of findings) {
    if (best === undefined) {
      best = finding
      continue
    }
    const aIndex = best.charIndex ?? Number.POSITIVE_INFINITY
    const bIndex = finding.charIndex ?? Number.POSITIVE_INFINITY
    if (bIndex < aIndex) {
      best = finding
      continue
    }
    if (bIndex === aIndex) {
      const aPath = best.fieldPath ?? '\uffff'
      const bPath = finding.fieldPath ?? '\uffff'
      if (Buffer.compare(Buffer.from(bPath, 'utf8'), Buffer.from(aPath, 'utf8')) < 0) best = finding
    }
  }
  return best
}

/** Convert the single winning finding to the public error detail (one O(n) byte conversion). */
function toDetail(text: string, finding: Finding): ContractErrorDetail {
  return {
    code: finding.code,
    ...(finding.charIndex === undefined
      ? {}
      : { byteOffset: byteOffsetOf(text, finding.charIndex) }),
    ...(finding.fieldPath === undefined ? {} : { fieldPath: finding.fieldPath }),
  }
}

/**
 * Explicit container frames for the iterative parser: nesting depth is a
 * checked counter (§19a.2.1.4), never call-stack depth — no input can turn
 * the verifier into a RangeError (an internal exception outside the closed
 * error enums is an implementation defect, §19a.2.4).
 */
interface ObjectFrame {
  readonly kind: 'object'
  readonly value: Record<string, unknown>
  pendingKey: string | undefined
  /** 'fresh' allows immediate '}'; after ',' a key is mandatory. */
  state: 'fresh' | 'after-comma' | 'after-member'
}
interface ArrayFrame {
  readonly kind: 'array'
  readonly value: unknown[]
  /** 'fresh' allows immediate ']'; after ',' an element is mandatory. */
  state: 'fresh' | 'after-comma' | 'after-element'
}
type Frame = ObjectFrame | ArrayFrame

class Parser {
  constructor(private readonly state: ParseState) {}
  private failSyntax(): never {
    this.state.syntax.push({
      code: 'contract.json-syntax',
      charIndex: this.state.position,
    })
    throw PARSE_ABORT
  }
  private failValueDomain(): void {
    // Findings per phase are recorded strictly left→right, so the first one
    // already holds the phase's minimum char index. Keeping only it bounds
    // memory on pathological input (e.g. millions of over-depth values).
    if (this.state.valueDomain.length === 0)
      this.state.valueDomain.push({
        code: 'contract.value-domain',
        charIndex: this.state.position,
      })
  }
  private peek(): string {
    return this.state.text[this.state.position] ?? ''
  }
  skipWhitespace(): void {
    while (JSON_WHITESPACE.has(this.peek())) this.state.position += 1
  }
  private expect(character: string): void {
    this.skipWhitespace()
    if (this.peek() !== character) this.failSyntax()
    this.state.position += 1
  }
  /**
   * Whole-document parse. Containers run on the explicit frame stack, never
   * recursion: over-depth input records `contract.value-domain` and parsing
   * CONTINUES, so a later whole-document syntax error still wins the phase
   * vector (§19a.2.4 json-syntax → duplicate-key → value-domain) while the
   * call stack stays O(1) in input nesting.
   */
  parseDocument(): unknown {
    const stack: Frame[] = []
    let completed: unknown
    let hasCompleted = false

    for (;;) {
      if (hasCompleted) {
        // Deliver the just-finished value to its parent frame (or finish root).
        const parent = stack[stack.length - 1]
        if (parent === undefined) return completed
        if (parent.kind === 'array') {
          parent.value.push(completed)
          parent.state = 'after-element'
        } else {
          const key = parent.pendingKey!
          if (Object.hasOwn(parent.value, key) && this.state.duplicates.length === 0)
            this.state.duplicates.push({
              code: 'contract.duplicate-key',
              charIndex: this.state.position,
            })
          parent.value[key] = completed
          parent.pendingKey = undefined
          parent.state = 'after-member'
        }
        hasCompleted = false
        continue
      }

      const frame = stack[stack.length - 1]
      this.skipWhitespace()
      const character = this.peek()

      // Immediate close of a just-opened empty container. An object frame
      // with a pending key is NOT empty (`{"a":` …) — '}' there is a syntax
      // error, never a close.
      if (
        frame !== undefined &&
        frame.state === 'fresh' &&
        (frame.kind === 'array' || frame.pendingKey === undefined)
      ) {
        const closer = frame.kind === 'array' ? ']' : '}'
        if (character === closer) {
          this.state.position += 1
          completed = frame.value
          stack.pop()
          hasCompleted = true
          continue
        }
      }

      const valueExpected =
        frame === undefined ||
        (frame.kind === 'array' ? frame.state !== 'after-element' : frame.pendingKey !== undefined)

      if (valueExpected) {
        // Depth of the value about to start = open frames + 1 (root = 1).
        // Findings are keep-first per phase (left→right scan ⇒ first holds
        // the minimum char index); deeper values still parse but do not
        // allocate new findings.
        if (stack.length + 1 > MAX_DEPTH) this.failValueDomain()
        if (character === '{') {
          this.state.position += 1
          stack.push({
            kind: 'object',
            // Null-prototype: `__proto__` must be a plain own key so duplicate
            // detection and canonical re-encoding see it — on a plain object
            // literal the key would hit the prototype setter and the member
            // would be silently swallowed.
            value: Object.create(null) as Record<string, unknown>,
            pendingKey: undefined,
            state: 'fresh',
          })
          continue
        }
        if (character === '[') {
          this.state.position += 1
          stack.push({ kind: 'array', value: [], state: 'fresh' })
          continue
        }
        if (character === '"') {
          completed = this.parseString()
          hasCompleted = true
          continue
        }
        if (character === '-' || (character >= '0' && character <= '9')) {
          completed = this.parseNumber()
          hasCompleted = true
          continue
        }
        if (this.state.text.startsWith('true', this.state.position)) {
          this.state.position += 4
          completed = true
          hasCompleted = true
          continue
        }
        if (this.state.text.startsWith('false', this.state.position)) {
          this.state.position += 5
          completed = false
          hasCompleted = true
          continue
        }
        if (this.state.text.startsWith('null', this.state.position)) {
          this.state.position += 4
          completed = null
          hasCompleted = true
          continue
        }
        this.failSyntax()
      }

      // --- container punctuation expected ---
      if (frame !== undefined && frame.kind === 'array') {
        // state === 'after-element'
        if (character === ',') {
          this.state.position += 1
          frame.state = 'after-comma'
          continue
        }
        if (character === ']') {
          this.state.position += 1
          completed = frame.value
          stack.pop()
          hasCompleted = true
          continue
        }
        this.failSyntax()
      }
      const objectFrame = frame as ObjectFrame
      // pendingKey === undefined here; 'after-member' expects ',' or '}'.
      if (objectFrame.state === 'after-member') {
        if (character === ',') {
          this.state.position += 1
          objectFrame.state = 'after-comma'
          continue
        }
        if (character === '}') {
          this.state.position += 1
          completed = objectFrame.value
          stack.pop()
          hasCompleted = true
          continue
        }
        this.failSyntax()
      }
      // 'fresh' (immediate close already handled above) or 'after-comma': a
      // double-quoted key is the only legal continuation.
      if (character !== '"') this.failSyntax()
      objectFrame.pendingKey = this.parseString()
      this.expect(':')
      // pendingKey set → next iteration parses the member value.
    }
  }
  private parseString(): string {
    this.state.position += 1
    let value = ''
    for (;;) {
      const character = this.state.text[this.state.position]
      if (character === undefined) this.failSyntax()
      if (character === '"') {
        this.state.position += 1
        return value
      }
      if (character === '\\') {
        this.state.position += 1
        const escape = this.state.text[this.state.position]
        if (escape === undefined) this.failSyntax()
        if (escape === '"' || escape === '\\' || escape === '/') {
          value += escape
          this.state.position += 1
          continue
        }
        if (
          escape === 'b' ||
          escape === 'f' ||
          escape === 'n' ||
          escape === 'r' ||
          escape === 't'
        ) {
          value += { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }[escape]!
          this.state.position += 1
          continue
        }
        if (escape === 'u') {
          const hex = this.state.text.slice(this.state.position + 1, this.state.position + 5)
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.failSyntax()
          let codePoint = Number.parseInt(hex, 16)
          this.state.position += 5
          if (codePoint >= 0xdc00 && codePoint <= 0xdfff) {
            // Lone low surrogate.
            this.failValueDomain()
            codePoint = 0xfffd
          } else if (codePoint >= 0xd800 && codePoint <= 0xdbff) {
            if (
              this.state.text[this.state.position] === '\\' &&
              this.state.text[this.state.position + 1] === 'u'
            ) {
              const low = this.state.text.slice(this.state.position + 2, this.state.position + 6)
              if (/^[0-9a-fA-F]{4}$/.test(low)) {
                const lowPoint = Number.parseInt(low, 16)
                if (lowPoint >= 0xdc00 && lowPoint <= 0xdfff) {
                  codePoint = 0x10000 + ((codePoint - 0xd800) << 10) + (lowPoint - 0xdc00)
                  this.state.position += 6
                }
              }
            }
            if (codePoint <= 0xdbff) {
              // Lone high surrogate.
              this.failValueDomain()
              codePoint = 0xfffd
            }
          }
          value += String.fromCodePoint(codePoint)
          continue
        }
        this.failSyntax()
      }
      const codePoint = character.codePointAt(0)!
      if (codePoint <= 0x1f) this.failSyntax()
      this.state.position += character.length
      value += character
    }
  }
  private parseNumber(): number {
    const start = this.state.position
    if (this.peek() === '-') this.state.position += 1
    if (this.peek() === '0') {
      // A leading '0' is the whole integer part; a following digit (e.g. "01")
      // is left unconsumed and surfaces as a syntax error at the enclosing
      // container or as trailing content — contract.json-syntax (§19a.2.4).
      this.state.position += 1
    } else if (this.peek() >= '1' && this.peek() <= '9') {
      while (this.peek() >= '0' && this.peek() <= '9') this.state.position += 1
    } else {
      this.failSyntax()
    }
    let fractional = false
    if (this.peek() === '.') {
      fractional = true
      this.state.position += 1
      if (!(this.peek() >= '0' && this.peek() <= '9')) this.failSyntax()
      while (this.peek() >= '0' && this.peek() <= '9') this.state.position += 1
    }
    let exponent = false
    if (this.peek() === 'e' || this.peek() === 'E') {
      exponent = true
      this.state.position += 1
      if (this.peek() === '+' || this.peek() === '-') this.state.position += 1
      if (!(this.peek() >= '0' && this.peek() <= '9')) this.failSyntax()
      while (this.peek() >= '0' && this.peek() <= '9') this.state.position += 1
    }
    const literal = this.state.text.slice(start, this.state.position)
    // `-0` is a value-domain rejection — but only when it is the WHOLE
    // literal: in `-01` the trailing digit is a document-level syntax error
    // (same as `01`), which must stay discoverable as contract.json-syntax.
    if (fractional || exponent || (literal === '-0' && !isDigit(this.peek()))) {
      // Record and CONTINUE with a placeholder: a later whole-document syntax
      // error must still win the phase vector (json-syntax → value-domain).
      // The re-scan starts at the literal's first byte, so re-consume the
      // sign first — otherwise a negative literal leaves '-' unconsumed and
      // surfaces as trailing content (contract.json-syntax), wrongly winning
      // the phase vector over this value-domain finding.
      this.state.position = start
      this.failValueDomain()
      if (this.peek() === '-') this.state.position += 1
      while (this.peek() >= '0' && this.peek() <= '9') this.state.position += 1
      if (this.peek() === '.') {
        this.state.position += 1
        while (this.peek() >= '0' && this.peek() <= '9') this.state.position += 1
      }
      if (this.peek() === 'e' || this.peek() === 'E') {
        this.state.position += 1
        if (this.peek() === '+' || this.peek() === '-') this.state.position += 1
        while (this.peek() >= '0' && this.peek() <= '9') this.state.position += 1
      }
      return 0
    }
    const value = Number.parseInt(literal, 10)
    if (value > SAFE_INTEGER_MAX || value < SAFE_INTEGER_MIN) {
      this.state.position = start
      this.failValueDomain()
      if (this.peek() === '-') this.state.position += 1
      while (this.peek() >= '0' && this.peek() <= '9') this.state.position += 1
      return 0
    }
    return value
  }
}

const PARSE_ABORT = Symbol('parse-abort')

const isDigit = (character: string): boolean => character >= '0' && character <= '9'

/** Scalar ranges forbidden by the value domain (§19a.2.2), fixed and version-free. */
function forbiddenScalar(codePoint: number): boolean {
  if (codePoint <= 0x1f) return true
  if (codePoint >= 0x7f && codePoint <= 0x9f) return true
  if (codePoint >= 0xfdd0 && codePoint <= 0xfdef) return true
  if ((codePoint & 0xfffe) === 0xfffe) return true
  return (
    codePoint === 0x61c ||
    codePoint === 0x200e ||
    codePoint === 0x200f ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069)
  )
}

function validateScalars(state: ParseState, value: unknown): void {
  // Iterative work list: a parsed document may legally reach depth 32, and
  // this walk must not grow the call stack with attacker-controlled nesting.
  // Records at most one finding (a rejected document needs only one).
  const work: unknown[] = [value]
  while (work.length > 0) {
    const item = work.pop()
    if (typeof item === 'string') {
      for (const character of item) {
        if (forbiddenScalar(character.codePointAt(0)!)) {
          // Escaped-only scalars never occur in the raw text, so no honest byte
          // offset exists for this finding; the phase code is what matters.
          state.valueDomain.push({ code: 'contract.value-domain' })
          return
        }
      }
      continue
    }
    if (Array.isArray(item)) {
      for (const element of item) work.push(element)
      continue
    }
    if (typeof item === 'object' && item !== null) {
      for (const [key, member] of Object.entries(item)) {
        for (const character of key) {
          if (forbiddenScalar(character.codePointAt(0)!)) {
            state.valueDomain.push({ code: 'contract.value-domain' })
            return
          }
        }
        work.push(member)
      }
    }
  }
}

const compareBytes = (a: string, b: string): number =>
  Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))

/** Canonical JSON V1 encoder: sorted keys, minimal escapes, raw UTF-8 scalars. */
export function encodeCanonical(value: unknown): Uint8Array {
  const chunks: string[] = []
  const write = (text: string): void => {
    chunks.push(text)
  }
  const writeString = (text: string): void => {
    write('"')
    for (const character of text) {
      const codePoint = character.codePointAt(0)!
      if (forbiddenScalar(codePoint))
        throw new TypeError('canonical encoder received a forbidden scalar')
      // Escapes exist only for the two JSON metacharacters (§19a.2.3).
      write(character === '"' ? '\\"' : character === '\\' ? '\\\\' : character)
    }
    write('"')
  }
  const writeValue = (item: unknown): void => {
    if (item === null) return write('null')
    if (item === true) return write('true')
    if (item === false) return write('false')
    if (typeof item === 'number') {
      if (!Number.isInteger(item) || item > SAFE_INTEGER_MAX || item < SAFE_INTEGER_MIN)
        throw new TypeError('canonical encoder requires safe integers')
      write(String(item))
      return
    }
    if (typeof item === 'string') return writeString(item)
    if (Array.isArray(item)) {
      write('[')
      item.forEach((element, index) => {
        if (index > 0) write(',')
        writeValue(element)
      })
      write(']')
      return
    }
    if (typeof item === 'object') {
      write('{')
      const entries = Object.entries(item as Record<string, unknown>).sort(([a], [b]) =>
        compareBytes(a, b),
      )
      entries.forEach(([key, member], index) => {
        if (index > 0) write(',')
        writeString(key)
        write(':')
        writeValue(member)
      })
      write('}')
      return
    }
    throw new TypeError('canonical encoder received a non-JSON value')
  }
  writeValue(value)
  return new TextEncoder().encode(chunks.join(''))
}

/**
 * Raw-byte admission + parse + canonical re-encode equality (§19a.2.1).
 * Throws CapabilityContractError with the FIRST error per the parse phase
 * vector; never includes raw bytes or document values in the error.
 */
export function parseCanonicalJson(
  bytes: Uint8Array,
  limits: CanonicalParseLimits,
): CanonicalParseResult {
  if (bytes.byteLength > limits.maxBytes)
    throw new CapabilityContractError({ code: 'contract.input-too-large' })
  // Strict UTF-8 validation happens in validateUtf8 (incl. >U+10FFFF and
  // surrogates), so the decoder below can never see a replacement char that
  // was not literally encoded.
  const utf8Error = validateUtf8(bytes)
  if (utf8Error !== undefined) throw new CapabilityContractError(utf8Error)
  const text = decodeUtf8(bytes)
  const state: ParseState = {
    text,
    position: 0,
    syntax: [],
    duplicates: [],
    valueDomain: [],
  }
  const parser = new Parser(state)
  let value: unknown
  try {
    value = parser.parseDocument()
    parser.skipWhitespace()
    if (state.position !== text.length)
      state.syntax.push({ code: 'contract.json-syntax', charIndex: state.position })
  } catch (error) {
    if (error !== PARSE_ABORT) throw error
  }
  if (state.syntax.length === 0 && state.duplicates.length === 0) validateScalars(state, value)
  // Phase vector: ANY syntax error first, then ANY duplicate, then value
  // domain; within a phase the smallest offset wins (§19a.2.4).
  const reported =
    firstFinding(state.syntax) ?? firstFinding(state.duplicates) ?? firstFinding(state.valueDomain)
  if (reported !== undefined) throw new CapabilityContractError(toDetail(text, reported))
  const canonicalBytes = encodeCanonical(value)
  if (!Buffer.from(canonicalBytes).equals(Buffer.from(bytes)))
    throw new CapabilityContractError({ code: 'contract.noncanonical-bytes' })
  if (
    limits.requireTopLevelObject !== false &&
    (typeof value !== 'object' || value === null || Array.isArray(value))
  )
    throw new CapabilityContractError({ code: 'contract.schema-invalid', fieldPath: '' })
  return { canonicalBytes, value }
}

/** Convenience for programmatic callers: encode + digest-ready canonical bytes. */
export function canonicalHex(value: unknown): string {
  return Buffer.from(encodeCanonical(value)).toString('hex')
}
