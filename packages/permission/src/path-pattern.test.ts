import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  canonicalizePath,
  canonicalizePattern,
  matchPath,
  PathPatternError,
  toPosixSeparators,
} from './path-pattern'

/**
 * Spec §4.4 「路径模式语义」(r13-I2) 强制点用例：
 * 大小写 / 双星 / symlink / 字面-vs-glob / 裸名与否定模式拒绝 / origin 归一（见 net-origin.test.ts）。
 *
 * 注意：root 取 realpath 后的值 —— 被检路径会先 realpath（规则 3），
 * 而 macOS 的 $TMPDIR 本身是 /var → /private/var 的 symlink，双方必须落在同一规范形态上。
 */
let root: string
let home: string | undefined
let userProfile: string | undefined

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'volund-path-pattern-')))
  home = process.env.HOME
  userProfile = process.env.USERPROFILE
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  if (home === undefined) delete process.env.HOME
  else process.env.HOME = home
  if (userProfile === undefined) delete process.env.USERPROFILE
  else process.env.USERPROFILE = userProfile
})

describe('matchPath — dialect rule 2 (globstar + case sensitivity)', () => {
  it('`**` crosses directory separators and includes the directory itself', () => {
    expect(matchPath(`${root}/work/**`, `${root}/work`)).toBe(true)
    expect(matchPath(`${root}/work/**`, `${root}/work/a`)).toBe(true)
    expect(matchPath(`${root}/work/**`, `${root}/work/a/b/c.txt`)).toBe(true)
    expect(matchPath(`${root}/work/**/*.ts`, `${root}/work/a/b/c.ts`)).toBe(true)
  })
  it('`**` does not bleed across segment boundaries', () => {
    expect(matchPath(`${root}/work/**`, `${root}/worker/x`)).toBe(false)
    expect(matchPath(`${root}/work/**`, `${root}/other/a`)).toBe(false)
  })
  it('single `*` does not cross directory separators', () => {
    expect(matchPath(`${root}/work/*`, `${root}/work/a`)).toBe(true)
    expect(matchPath(`${root}/work/*`, `${root}/work/a/b`)).toBe(false)
  })
  it('matching is case-sensitive in both directions', () => {
    expect(matchPath(`${root}/SRC/**`, `${root}/src/a.js`)).toBe(false)
    expect(matchPath(`${root}/src/**`, `${root}/SRC/a.js`)).toBe(false)
    expect(matchPath(`${root}/src/**`, `${root}/src/a.js`)).toBe(true)
  })
  it('dot segments stay hidden from `*` / `**` unless the pattern is explicit (conservative)', () => {
    mkdirSync(join(root, '.hidden'), { recursive: true })
    writeFileSync(join(root, '.hidden', 'x'), 'x')
    expect(matchPath(`${root}/**`, join(root, '.hidden', 'x'))).toBe(false)
    expect(matchPath(`${root}/.hidden/**`, join(root, '.hidden', 'x'))).toBe(true)
  })
})

describe('matchPath — literal vs glob', () => {
  it('a literal pattern matches exactly that canonical path, nothing more', () => {
    expect(matchPath(`${root}/a.txt`, `${root}/a.txt`)).toBe(true)
    expect(matchPath(`${root}/a.txt`, `${root}/a.txt.bak`)).toBe(false)
    expect(matchPath(`${root}/a.txt`, join(root, 'sub', 'a.txt'))).toBe(false)
  })
  it('metacharacters make a pattern a glob, not a literal', () => {
    expect(matchPath(`${root}/*.txt`, `${root}/a.txt`)).toBe(true)
    expect(matchPath(`${root}/*.txt`, `${root}/a.ts`)).toBe(false)
    expect(matchPath(`${root}/?.txt`, `${root}/a.txt`)).toBe(true)
    expect(matchPath(`${root}/?.txt`, `${root}/ab.txt`)).toBe(false)
  })
  it('bracket expressions are dialect metacharacters (and also match their literal spelling)', () => {
    // `a[1].txt` is a glob (matches `a1.txt`); picomatch additionally matches the
    // literal spelling `a[1].txt` — pin both facets of the pinned dialect.
    expect(matchPath(`${root}/a[1].txt`, `${root}/a1.txt`)).toBe(true)
    expect(matchPath(`${root}/a[1].txt`, `${root}/a[1].txt`)).toBe(true)
    expect(matchPath(`${root}/a[1].txt`, `${root}/a2.txt`)).toBe(false)
  })
})

describe('matchPath — rule 3 (canonicalize + realpath)', () => {
  it('expands `~` on both sides', () => {
    const fakeHome = mkdtempSync(join(root, 'home-'))
    // os.homedir() 在 POSIX 读 HOME、Windows 读 USERPROFILE——两处都设才能跨平台生效
    process.env.HOME = fakeHome
    process.env.USERPROFILE = fakeHome
    mkdirSync(join(fakeHome, 'docs'), { recursive: true })
    expect(matchPath('~/docs/**', '~/docs/a.md')).toBe(true)
    expect(matchPath(`${fakeHome}/docs/**`, '~/docs/a.md')).toBe(true)
    expect(matchPath('~/docs/**', `${fakeHome}/docs/a.md`)).toBe(true)
  })
  it('rejects `~user` shorthand (only bare `~` / `~/` expand)', () => {
    expect(() => matchPath('~other/docs/**', '/tmp/x')).toThrow(PathPatternError)
  })
  it('symlink pointing outside the allowed tree is blocked (bypass defense)', () => {
    mkdirSync(join(root, 'safe'), { recursive: true })
    mkdirSync(join(root, 'outside'), { recursive: true })
    writeFileSync(join(root, 'outside', 'secret.txt'), 'secret')
    symlinkSync(join(root, 'outside'), join(root, 'safe', 'link'))
    // lexical form lives under `safe/**`, but realpath lands in `outside/` → deny
    expect(matchPath(`${root}/safe/**`, join(root, 'safe', 'link', 'secret.txt'))).toBe(false)
  })
  it('a checked path that realpaths into the allowed tree matches even when passed via a symlink', () => {
    mkdirSync(join(root, 'outside'), { recursive: true })
    writeFileSync(join(root, 'outside', 'secret.txt'), 'secret')
    symlinkSync(join(root, 'outside'), join(root, 'alias'))
    expect(matchPath(`${root}/outside/**`, join(root, 'alias', 'secret.txt'))).toBe(true)
    // single-file symlink: canonical form is the target
    symlinkSync(join(root, 'outside', 'secret.txt'), join(root, 'alias.txt'))
    expect(matchPath(`${root}/outside/secret.txt`, `${root}/alias.txt`)).toBe(true)
  })
  it('falls back to nearest existing ancestor when the checked path does not exist (write targets)', () => {
    mkdirSync(join(root, 'new'), { recursive: true })
    expect(matchPath(`${root}/new/**`, join(root, 'new', 'not-created-yet.txt'))).toBe(true)
    expect(matchPath(`${root}/brand/**`, join(root, 'brand', 'new', 'file.txt'))).toBe(true)
  })
  it('nonexistent path under a symlinked dir resolves through the link target', () => {
    mkdirSync(join(root, 'outside'), { recursive: true })
    symlinkSync(join(root, 'outside'), join(root, 's2'))
    expect(matchPath(`${root}/outside/**`, join(root, 's2', 'ghost.txt'))).toBe(true)
    expect(matchPath(`${root}/s2/**`, join(root, 's2', 'ghost.txt'))).toBe(false)
  })
})

describe('matchPath — rule 4 (relative patterns resolve against cwd; bare names rejected)', () => {
  it('`./` and `../` patterns resolve against the provided cwd', () => {
    mkdirSync(join(root, 'work'), { recursive: true })
    mkdirSync(join(root, 'work', 'sub'), { recursive: true })
    expect(matchPath('./work/**', join(root, 'work', 'sub', 'a'), { cwd: root })).toBe(true)
    expect(matchPath('../work/**', join(root, 'work', 'a'), { cwd: join(root, 'sub') })).toBe(true)
    expect(matchPath('./other/**', join(root, 'work', 'a'), { cwd: root })).toBe(false)
  })
  it('relative checked paths resolve against the provided cwd', () => {
    mkdirSync(join(root, 'work'), { recursive: true })
    expect(matchPath(`${root}/work/**`, 'work/a.js', { cwd: root })).toBe(true)
    expect(matchPath(`${root}/work/**`, 'a.js', { cwd: join(root, 'work') })).toBe(true)
  })
  it('bare-name patterns without an anchor are rejected', () => {
    for (const pattern of ['src/**', '*.ts', 'a.txt', 'work', '']) {
      expect(() => matchPath(pattern, `${root}/a`)).toThrow(PathPatternError)
      expect(() => matchPath(pattern, `${root}/a`)).toThrow(/anchor/i)
    }
  })
})

describe('matchPath — rule 5 (negation rejected)', () => {
  it('`!` patterns are rejected — deny lists belong in permissions.toml', () => {
    expect(() => matchPath(`!${root}/**`, `${root}/a`)).toThrow(PathPatternError)
    expect(() => matchPath(`!${root}/a`, `${root}/a`)).toThrow(/negation/i)
  })
})

describe('canonicalizePattern / canonicalizePath', () => {
  it('canonicalizePattern anchors, expands `~` and stays lexical (no realpath)', () => {
    const fakeHome = mkdtempSync(join(root, 'home-'))
    process.env.HOME = fakeHome
    process.env.USERPROFILE = fakeHome
    expect(canonicalizePattern('~/docs/**')).toBe(toPosixSeparators(join(fakeHome, 'docs')) + '/**')
    expect(canonicalizePattern('./src/*.ts', { cwd: root })).toBe(
      toPosixSeparators(join(root, 'src', '*.ts')),
    )
    // Windows 上无盘符的绝对路径会 resolve 到当前盘（如 D:/abs/x）——期望值取 resolve 形态
    expect(canonicalizePattern('/abs/x')).toBe(toPosixSeparators(resolve('/abs/x')))
    expect(() => canonicalizePattern('src/**')).toThrow(PathPatternError)
  })
  it('canonicalizePath anchors, expands `~` and applies best-effort realpath', () => {
    const fakeHome = mkdtempSync(join(root, 'home-'))
    process.env.HOME = fakeHome
    process.env.USERPROFILE = fakeHome
    mkdirSync(join(fakeHome, 'docs'), { recursive: true })
    expect(canonicalizePath('~/docs')).toBe(toPosixSeparators(realpathSync(join(fakeHome, 'docs'))))
    expect(canonicalizePath('docs/ghost.md', { cwd: fakeHome })).toBe(
      toPosixSeparators(join(realpathSync(fakeHome), 'docs', 'ghost.md')),
    )
  })
})

describe('toPosixSeparators — Windows 分隔符归一（CI ts (windows) 修复）', () => {
  // mock process.platform 只影响 toPosixSeparators 自身分支；node:path 的平台行为不变，
  // 因此跨 canonicalize 的集成语义由 CI 的真 Windows runner 上的既有 14 个用例验证。
  it('win32 分支把反斜杠归一为 picomatch 的 `/` 方言', () => {
    const realPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    try {
      expect(toPosixSeparators('C:\\Users\\mark\\docs\\*.md')).toBe('C:/Users/mark/docs/*.md')
    } finally {
      Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true })
    }
  })
  it('POSIX 分支不改动含反斜杠的路径（反斜杠是合法文件名字符）', () => {
    if (process.platform === 'win32') return
    expect(toPosixSeparators('/tmp/a\\b/*.ts')).toBe('/tmp/a\\b/*.ts')
  })
})
