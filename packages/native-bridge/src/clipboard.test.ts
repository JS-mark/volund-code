import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createClipboardReader, type ClipboardExec } from './clipboard'

const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])

const fixtures: string[] = []

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'clipboard-test-'))
  fixtures.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((dir) => rm(dir, { force: true, recursive: true })))
})

/** darwin 假 exec：按 osascript 脚本内容/pbpaste 分派，图片经 argv 落点写临时文件。 */
function darwinExec(handlers: {
  file?: string
  image?: Uint8Array
  text?: string
}): ClipboardExec {
  return async (file, args) => {
    if (file === 'osascript') {
      const script = args.join(' ')
      if (script.includes('«class furl»')) {
        if (handlers.file) return { stderr: new Uint8Array(), stdout: new TextEncoder().encode(handlers.file) }
        throw new Error('no file on clipboard')
      }
      const imageClass = script.match(/«class (\w+)»/)?.[1]
      if (imageClass && handlers.image) {
        // 真实 osascript 把二进制写到 argv 末的路径；测试模拟同一落盘行为。
        const target = args.at(-1)!
        await import('node:fs/promises').then((fs) => fs.writeFile(target, handlers.image!))
        return { stderr: new Uint8Array(), stdout: new Uint8Array() }
      }
      throw new Error(`clipboard has no ${imageClass}`)
    }
    if (file === 'pbpaste') {
      if (handlers.text) return { stderr: new Uint8Array(), stdout: new TextEncoder().encode(handlers.text) }
      throw new Error('empty clipboard')
    }
    throw new Error(`unexpected command: ${file}`)
  }
}

describe('createClipboardReader (darwin)', () => {
  it('prefers a Finder-copied file over its thumbnail image data', async () => {
    const calls: string[] = []
    const exec: ClipboardExec = async (file, args) => {
      calls.push(file === 'osascript' ? args.join(' ').slice(0, 60) : file)
      return darwinExec({ file: '/tmp/pic.png', image: PNG_BYTES })(file, args)
    }
    const reader = createClipboardReader({ exec, platform: 'darwin', tmpdir: await scratch() })
    await expect(reader.read()).resolves.toEqual({ kind: 'file', paths: ['/tmp/pic.png'] })
    // furl 探测先于图片类探测——否则 Finder 复制的图片会被当成无名截图。
    expect(calls[0]).toContain('«class furl»')
  })

  it('reads screenshot bytes via osascript and reports png mime', async () => {
    const reader = createClipboardReader({
      exec: darwinExec({ image: PNG_BYTES }),
      platform: 'darwin',
      tmpdir: await scratch(),
    })
    await expect(reader.read()).resolves.toEqual({
      bytes: PNG_BYTES,
      kind: 'image',
      mime: 'image/png',
    })
  })

  it('converts TIFF-only clipboards via sips (some apps expose nothing else)', async () => {
    const TIFF_BYTES = Uint8Array.from([0x4d, 0x4d, 0x00, 0x2a, 9])
    const exec: ClipboardExec = async (file, args) => {
      if (file === 'osascript') {
        const script = args.join(' ')
        if (script.includes('«class furl»')) throw new Error('no file')
        if (script.includes('«class TIFF»')) {
          await import('node:fs/promises').then((fs) => fs.writeFile(args.at(-1)!, TIFF_BYTES))
          return { stderr: new Uint8Array(), stdout: new Uint8Array() }
        }
        throw new Error('no PNGf/JPEG/GIFf')
      }
      if (file === 'sips') {
        // sips -s format png <in> --out <out>
        const out = args.at(-1)!
        await import('node:fs/promises').then((fs) => fs.writeFile(out, PNG_BYTES))
        return { stderr: new Uint8Array(), stdout: new Uint8Array() }
      }
      throw new Error(`unexpected command: ${file}`)
    }
    const reader = createClipboardReader({ exec, platform: 'darwin', tmpdir: await scratch() })
    await expect(reader.read()).resolves.toEqual({
      bytes: PNG_BYTES,
      kind: 'image',
      mime: 'image/png',
    })
  })

  it('falls through to plain text when no file or image is present', async () => {
    const reader = createClipboardReader({
      exec: darwinExec({ text: 'hello clipboard' }),
      platform: 'darwin',
      tmpdir: await scratch(),
    })
    await expect(reader.read()).resolves.toEqual({ kind: 'text', text: 'hello clipboard' })
  })

  it('reports empty when every probe comes up blank', async () => {
    const reader = createClipboardReader({
      exec: darwinExec({}),
      platform: 'darwin',
      tmpdir: await scratch(),
    })
    await expect(reader.read()).resolves.toEqual({ kind: 'empty' })
  })
})

describe('createClipboardReader (linux)', () => {
  it('reads wayland images by advertised mime type', async () => {
    const exec: ClipboardExec = async (file, args) => {
      expect(file).toBe('wl-paste')
      if (args.includes('--list-types'))
        return { stderr: new Uint8Array(), stdout: new TextEncoder().encode('text/plain\nimage/png\n') }
      if (args.includes('image/png'))
        return { stderr: new Uint8Array(), stdout: PNG_BYTES }
      return { stderr: new Uint8Array(), stdout: new TextEncoder().encode('plain') }
    }
    const reader = createClipboardReader({ exec, platform: 'linux' })
    await expect(reader.read()).resolves.toEqual({
      bytes: PNG_BYTES,
      kind: 'image',
      mime: 'image/png',
    })
  })

  it('falls back to xclip text when wayland tools are missing', async () => {
    const exec: ClipboardExec = async (file, args) => {
      if (file === 'wl-paste') throw new Error('command not found')
      if (args.includes('TARGETS'))
        return { stderr: new Uint8Array(), stdout: new TextEncoder().encode('UTF8_STRING\ntext/plain\n') }
      return { stderr: new Uint8Array(), stdout: new TextEncoder().encode('x11 text') }
    }
    const reader = createClipboardReader({ exec, platform: 'linux' })
    await expect(reader.read()).resolves.toEqual({ kind: 'text', text: 'x11 text' })
  })
})

describe('createClipboardReader (win32)', () => {
  it('decodes the encoded powershell command to find the image output path', async () => {
    const exec: ClipboardExec = async (file, args) => {
      expect(file).toBe('powershell')
      const script = Buffer.from(args.at(-1)!, 'base64').toString('utf16le')
      if (script.includes('Get-Clipboard -Format Image')) {
        const target = script.match(/\$i\.Save\('([^']+)'/)?.[1]
        if (!target) throw new Error('no save path in script')
        await import('node:fs/promises').then((fs) => fs.writeFile(target, PNG_BYTES))
        return { stderr: new Uint8Array(), stdout: new Uint8Array() }
      }
      throw new Error('no file drop list')
    }
    const reader = createClipboardReader({ exec, platform: 'win32', tmpdir: await scratch() })
    await expect(reader.read()).resolves.toEqual({
      bytes: PNG_BYTES,
      kind: 'image',
      mime: 'image/png',
    })
  })
})

describe('createClipboardReader (unsupported platforms)', () => {
  it('reports empty without touching the system', async () => {
    const exec: ClipboardExec = async () => {
      throw new Error('must not be called')
    }
    const reader = createClipboardReader({ exec, platform: 'freebsd' })
    await expect(reader.read()).resolves.toEqual({ kind: 'empty' })
  })
})
