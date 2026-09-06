/**
 * §7.5.2 系统级剪贴板读取（native-bridge 边界）：TUI 的 Ctrl+V 附件粘贴从这里
 * 拿图片二进制 / 文件引用 / 纯文本。
 *
 * 平台策略：
 * - darwin：osascript（«class furl» 文件引用 → «class PNGf/JPEG/GIFf» 图片二进制
 *   经临时文件读出）+ pbpaste 文本。macOS 剪贴板上的文件拷贝同时带图标缩略图，
 *   必须先探文件再探图片，否则 Finder 里复制的图片会被当成无名字的截图。
 * - linux：wl-paste（Wayland）优先，xclip（X11）兜底；图片只认 image/png。
 * - win32：powershell Get-Clipboard（-Format Image / FileDropList / 文本），
 *   脚本走 -EncodedCommand 规避引号转义。
 *
 * 探测类失败（命令不存在、剪贴板无该类型）一律安静落到下一形态；三态全空返回
 * 'empty'；只有非预期错误（权限、I/O）才抛出，由调用方映射为 unavailable。
 */
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir as osTmpdir } from 'node:os'
import { join } from 'node:path'

export type ClipboardPayload =
  | { readonly kind: 'image'; readonly bytes: Uint8Array; readonly mime: string }
  | { readonly kind: 'file'; readonly paths: readonly string[] }
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'empty' }

export interface ClipboardExecResult {
  readonly stdout: Uint8Array
  readonly stderr: Uint8Array
}
export type ClipboardExec = (file: string, args: readonly string[]) => Promise<ClipboardExecResult>

export interface ClipboardReaderOptions {
  readonly platform?: NodeJS.Platform
  readonly exec?: ClipboardExec
  /** darwin/win32 图片二进制的中转目录；默认系统临时目录。 */
  readonly tmpdir?: string
}

export interface ClipboardReader {
  read(): Promise<ClipboardPayload>
}

const EXEC_TIMEOUT_MS = 5_000
const EXEC_MAX_BUFFER = 64 * 1024 * 1024

function defaultExec(file: string, args: readonly string[]): Promise<ClipboardExecResult> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { encoding: 'buffer', maxBuffer: EXEC_MAX_BUFFER, timeout: EXEC_TIMEOUT_MS },
      (error, stdout, stderr) => {
        if (error) {
          reject(error)
          return
        }
        resolve({ stdout: new Uint8Array(stdout), stderr: new Uint8Array(stderr) })
      },
    )
  })
}

function text(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}

/**
 * 探测单次剪贴板访问；任何失败（命令缺失 / 非零退出 / 超时）都安静返回
 * undefined，由调用方落到下一形态——剪贴板工具链残缺不该让 TUI 报错。
 */
async function probe(
  exec: ClipboardExec,
  file: string,
  args: readonly string[],
): Promise<Uint8Array | undefined> {
  try {
    return (await exec(file, args)).stdout
  } catch {
    return undefined
  }
}

/** macOS 图片类型：AppleScript 类名 → MIME。顺序即探测优先级。 */
const MAC_IMAGE_CLASSES = [
  { cls: 'PNGf', mime: 'image/png', ext: 'png' },
  { cls: 'JPEG', mime: 'image/jpeg', ext: 'jpg' },
  { cls: 'GIFf', mime: 'image/gif', ext: 'gif' },
] as const

/** 部分应用（微信/Preview 等）只在剪贴板放 TIFF——经 sips 转 PNG 兜底。 */
async function readDarwinTiff(
  exec: ClipboardExec,
  tmp: string,
): Promise<ClipboardPayload | undefined> {
  const tiffPath = join(tmp, 'clipboard.tiff')
  const wrote = await probe(exec, 'osascript', [
    '-e',
    'on run argv',
    '-e',
    'set p to item 1 of argv',
    '-e',
    'set d to the clipboard as «class TIFF»',
    '-e',
    'set f to open for access (POSIX file p) with write permission',
    '-e',
    'set eof f to 0',
    '-e',
    'write d to f',
    '-e',
    'close access f',
    '-e',
    'end run',
    '--',
    tiffPath,
  ])
  if (!wrote) return undefined
  const pngPath = join(tmp, 'clipboard-tiff.png')
  const converted = await probe(exec, 'sips', ['-s', 'format', 'png', tiffPath, '--out', pngPath])
  if (!converted) return undefined
  try {
    const bytes = new Uint8Array(await readFile(pngPath))
    return bytes.byteLength > 0 ? { kind: 'image', bytes, mime: 'image/png' } : undefined
  } catch {
    return undefined
  }
}

async function readDarwinFile(exec: ClipboardExec): Promise<ClipboardPayload | undefined> {
  const stdout = await probe(exec, 'osascript', [
    '-e',
    'try',
    '-e',
    'POSIX path of (the clipboard as «class furl»)',
    '-e',
    'on error',
    '-e',
    '""',
    '-e',
    'end try',
  ])
  const path = stdout ? text(stdout).trim() : ''
  return path ? { kind: 'file', paths: [path] } : undefined
}

async function readDarwinImage(
  exec: ClipboardExec,
  tmp: string,
): Promise<ClipboardPayload | undefined> {
  for (const { cls, mime, ext } of MAC_IMAGE_CLASSES) {
    const target = join(tmp, `clipboard.${ext}`)
    const stdout = await probe(exec, 'osascript', [
      '-e',
      'on run argv',
      '-e',
      'set p to item 1 of argv',
      '-e',
      `set d to the clipboard as «class ${cls}»`,
      '-e',
      'set f to open for access (POSIX file p) with write permission',
      '-e',
      'set eof f to 0',
      '-e',
      'write d to f',
      '-e',
      'close access f',
      '-e',
      'end run',
      '--',
      target,
    ])
    if (!stdout) continue
    try {
      const bytes = new Uint8Array(await readFile(target))
      if (bytes.byteLength === 0) continue
      return { kind: 'image', bytes, mime }
    } catch {
      continue
    }
  }
  return undefined
}

async function readDarwinText(exec: ClipboardExec): Promise<ClipboardPayload | undefined> {
  const stdout = await probe(exec, 'pbpaste', [])
  const value = stdout ? text(stdout) : ''
  return value.length > 0 ? { kind: 'text', text: value } : undefined
}

const WAYLAND_IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const

async function readLinuxWayland(exec: ClipboardExec): Promise<ClipboardPayload | undefined> {
  const types = await probe(exec, 'wl-paste', ['--list-types'])
  if (!types) return undefined
  const offered = text(types)
  const mime = WAYLAND_IMAGE_MIMES.find((candidate) => offered.includes(candidate))
  if (mime) {
    const bytes = await probe(exec, 'wl-paste', ['--type', mime])
    if (bytes && bytes.byteLength > 0) return { kind: 'image', bytes, mime }
  }
  const stdout = await probe(exec, 'wl-paste', ['--no-newline'])
  const value = stdout ? text(stdout) : ''
  return value.length > 0 ? { kind: 'text', text: value } : undefined
}

async function readLinuxXclip(exec: ClipboardExec): Promise<ClipboardPayload | undefined> {
  const targets = await probe(exec, 'xclip', ['-selection', 'clipboard', '-t', 'TARGETS', '-o'])
  if (!targets) return undefined
  const offered = text(targets)
  const mime = WAYLAND_IMAGE_MIMES.find((candidate) => offered.includes(candidate))
  if (mime) {
    const bytes = await probe(exec, 'xclip', ['-selection', 'clipboard', '-t', mime, '-o'])
    if (bytes && bytes.byteLength > 0) return { kind: 'image', bytes, mime }
  }
  const stdout = await probe(exec, 'xclip', ['-selection', 'clipboard', '-o'])
  const value = stdout ? text(stdout) : ''
  return value.length > 0 ? { kind: 'text', text: value } : undefined
}

function encodedPowerShell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

async function readWindows(
  exec: ClipboardExec,
  tmp: string,
): Promise<ClipboardPayload | undefined> {
  const target = join(tmp, 'clipboard.png')
  // Get-Clipboard -Format Image 返回 System.Drawing.Bitmap；落盘后由调用方读回。
  const image = await probe(exec, 'powershell', [
    '-NoProfile',
    '-NonInteractive',
    '-EncodedCommand',
    encodedPowerShell(
      `Add-Type -AssemblyName System.Drawing; ` +
        `$i = Get-Clipboard -Format Image; ` +
        `if ($null -ne $i) { $i.Save('${target}', [System.Drawing.Imaging.ImageFormat]::Png); $i.Dispose() }`,
    ),
  ])
  if (image) {
    try {
      const bytes = new Uint8Array(await readFile(target))
      if (bytes.byteLength > 0) return { kind: 'image', bytes, mime: 'image/png' }
    } catch {
      // 剪贴板无图片：powershell 正常退出但不落盘，继续探文件/文本。
    }
  }
  const files = await probe(exec, 'powershell', [
    '-NoProfile',
    '-NonInteractive',
    '-EncodedCommand',
    encodedPowerShell(
      `$f = Get-Clipboard -Format FileDropList; if ($null -ne $f) { $f -join [char]10 }`,
    ),
  ])
  const paths = files
    ? text(files)
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
    : []
  if (paths.length > 0) return { kind: 'file', paths }
  const stdout = await probe(exec, 'powershell', [
    '-NoProfile',
    '-NonInteractive',
    '-EncodedCommand',
    encodedPowerShell('Get-Clipboard'),
  ])
  const value = stdout ? text(stdout).replace(/\r\n/g, '\n') : ''
  return value.length > 0 ? { kind: 'text', text: value } : undefined
}

export function createClipboardReader(options: ClipboardReaderOptions = {}): ClipboardReader {
  const platform = options.platform ?? process.platform
  const exec = options.exec ?? defaultExec
  const tmp = options.tmpdir ?? osTmpdir()
  return {
    async read() {
      if (platform === 'darwin') {
        const scratch = await mkdtemp(join(tmp, 'volund-clipboard-'))
        try {
          // 文件优先：macOS 上复制文件会附带图标缩略图，先探图片会把图标当截图。
          const file = await readDarwinFile(exec)
          if (file) return file
          const image = await readDarwinImage(exec, scratch)
          if (image) return image
          const tiff = await readDarwinTiff(exec, scratch)
          if (tiff) return tiff
          const pastedText = await readDarwinText(exec)
          if (pastedText) return pastedText
          return { kind: 'empty' }
        } finally {
          await rm(scratch, { force: true, recursive: true })
        }
      }
      if (platform === 'linux') {
        const wayland = await readLinuxWayland(exec)
        if (wayland) return wayland
        const x11 = await readLinuxXclip(exec)
        if (x11) return x11
        return { kind: 'empty' }
      }
      if (platform === 'win32') {
        const scratch = await mkdtemp(join(tmp, 'volund-clipboard-'))
        try {
          const result = await readWindows(exec, scratch)
          return result ?? { kind: 'empty' }
        } finally {
          await rm(scratch, { force: true, recursive: true })
        }
      }
      return { kind: 'empty' }
    },
  }
}
