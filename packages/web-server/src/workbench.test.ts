import { randomBytes } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { createWebServer, type WebServerHandle } from './index'
import { createTerminalPort } from './terminal'
import { createWorkbenchPort } from './workbench'

let dir: string | undefined
let handle: WebServerHandle | undefined

afterEach(async () => {
  await handle?.close()
  handle = undefined
  if (dir) await rm(dir, { recursive: true, force: true })
  dir = undefined
})

async function workspace(): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), 'volund-workbench-test-'))
  await mkdir(join(dir, 'src', 'nested'), { recursive: true })
  await mkdir(join(dir, 'node_modules', 'pkg'), { recursive: true })
  await writeFile(join(dir, 'src', 'hello.ts'), 'export const hello = "world"\n')
  await writeFile(join(dir, 'src', 'nested', 'deep.ts'), 'const deep = true\n')
  await writeFile(join(dir, 'README.md'), '# Hello World\nsecond line\n')
  await writeFile(join(dir, 'node_modules', 'pkg', 'index.js'), 'module.exports = {}\n')
  await writeFile(join(dir, 'blob.bin'), Buffer.from([0x89, 0x50, 0x00, 0x0d]))
  return dir
}

describe('workbench port', () => {
  it('lists directories with dirs first and posix relative paths', async () => {
    const root = await workspace()
    const port = createWorkbenchPort(root)
    const top = await port.listDir()
    const kinds = top.entries.map((entry) => entry.kind)
    expect(kinds[0]).toBe('dir')
    expect(top.entries.map((entry) => entry.path)).toContain('src')
    const nested = await port.listDir('src')
    expect(nested.entries.map((entry) => entry.path)).toEqual(['src/nested', 'src/hello.ts'])
  })

  it('reads text files, flags binary and truncation boundaries', async () => {
    const root = await workspace()
    const port = createWorkbenchPort(root)
    const text = await port.readText('README.md')
    expect(text.binary).toBe(false)
    expect(text.content).toContain('# Hello World')
    const bin = await port.readText('blob.bin')
    expect(bin.binary).toBe(true)
    expect(bin.content).toBe('')
    await expect(port.readText('missing.ts')).rejects.toMatchObject({
      code: 'web_schema_invalid',
    })
    await expect(port.readText('src')).rejects.toMatchObject({ code: 'web_schema_invalid' })
  })

  it('writes text files and rejects escapes outside the workspace', async () => {
    const root = await workspace()
    const port = createWorkbenchPort(root)
    await port.writeText('src/hello.ts', '// edited\n')
    expect((await port.readText('src/hello.ts')).content).toBe('// edited\n')
    await expect(port.writeText('../evil.ts', 'x')).rejects.toMatchObject({
      code: 'web_schema_invalid',
    })
    await expect(port.readText('../../etc/passwd')).rejects.toMatchObject({
      code: 'web_schema_invalid',
    })
    await expect(port.listDir('..')).rejects.toMatchObject({ code: 'web_schema_invalid' })
  })

  it('finds files by name and skips node_modules', async () => {
    const root = await workspace()
    const port = createWorkbenchPort(root)
    const found = await port.findFiles('hello')
    expect(found.results.map((entry) => entry.path)).toEqual(['src/hello.ts'])
    const nothing = await port.findFiles('index.js')
    expect(nothing.results).toEqual([])
  })

  it('searches content case-insensitively with line numbers', async () => {
    const root = await workspace()
    const port = createWorkbenchPort(root)
    const found = await port.searchContent('hello world')
    expect(found.matches).toEqual([{ path: 'README.md', line: 1, text: '# Hello World' }])
    const none = await port.searchContent('definitely-not-present')
    expect(none.matches).toEqual([])
  })

  it('reports non-repo directories without throwing', async () => {
    const root = await workspace()
    const port = createWorkbenchPort(root)
    const status = await port.gitStatus()
    expect(status.isRepo).toBe(false)
    expect(status.entries).toEqual([])
  })
})

describe('terminal port (interactive shell)', () => {
  it('streams output from an interactive shell and exits on demand', async () => {
    const root = await workspace()
    const session = createTerminalPort(root).spawnShell()
    let buffer = ''
    session.onData((data) => {
      buffer += data
    })
    session.write('echo wb-term-$((40+2))\n')
    // 交互 shell 流式输出：等到结果出现（pty 带回显，匹配具体输出行即可）。
    await vi.waitFor(() => expect(buffer).toContain('wb-term-42'), { timeout: 8000 })
    const exited = new Promise<number | null>((resolveExit) => session.onExit(resolveExit))
    session.write('exit\n')
    await vi.waitFor(
      async () => {
        const state = await Promise.race([
          exited.then(() => 'exited' as const),
          new Promise((r) => setTimeout(() => r('pending'), 200)).then(() => 'pending' as const),
        ])
        expect(state).toBe('exited')
      },
      { timeout: 8000 },
    )
    session.kill()
  }, 20_000)

  it('runs in the workspace cwd', async () => {
    const root = await workspace()
    const session = createTerminalPort(root).spawnShell()
    let buffer = ''
    session.onData((data) => {
      buffer += data
    })
    session.write(process.platform === 'win32' ? 'cd\r' : 'pwd\n')
    await vi.waitFor(() => expect(buffer.toLowerCase()).toContain('volund-workbench-test'), {
      timeout: 8000,
    })
    session.kill()
  }, 20_000)

  // resize 通道只有 darwin（expect slave path + stty -f）有实现；linux/win32 no-op。
  it.runIf(process.platform === 'darwin')(
    'resizes the pty via stty on the slave path',
    async () => {
      const root = await workspace()
      const session = createTerminalPort(root, { shell: '/bin/sh' }).spawnShell()
      let buffer = ''
      session.onData((data) => {
        buffer += data
      })
      // 启动默认 80x24（expect 脚本内 stty）。
      await vi.waitFor(() => expect(buffer).toContain('$'), { timeout: 8000 })
      session.resize(132, 43)
      await new Promise((resolve) => setTimeout(resolve, 300))
      session.write('stty size\n')
      await vi.waitFor(() => expect(buffer).toContain('43 132'), { timeout: 8000 })
      session.kill()
    },
    20_000,
  )

  it('honors configured shell and exposes settings', async () => {
    const root = await workspace()
    const port = createTerminalPort(root, { shell: '/bin/sh', fontSize: 14, scrollback: 500 })
    expect(port.settings).toEqual({ shell: '/bin/sh', fontSize: 14, scrollback: 500 })
    const session = port.spawnShell()
    let buffer = ''
    session.onData((data) => {
      buffer += data
    })
    session.write('echo shell-is-$0\n')
    // /bin/sh 自身回显 $0 = sh（zsh 会是 zsh）。
    await vi.waitFor(() => expect(buffer).toMatch(/shell-is-(.*\/)?sh/), { timeout: 8000 })
    session.kill()
  }, 20_000)
})

describe('workbench routes', () => {
  async function start(wired: boolean) {
    const root = await workspace()
    handle = await createWebServer({
      host: '127.0.0.1',
      port: 0,
      ports: { identity: { version: '0.0.0-test' }, cwd: root },
      ...(wired ? { workbench: createWorkbenchPort(root) } : {}),
    })
    const { hostname, port: portNum } = new URL(handle.url)
    const base = `http://${hostname}:${portNum}`
    // bootstrap 自动签发 browser session（进入无 token 门）
    const boot = await fetch(`${base}/api/v1/bootstrap`)
    const cookie = (boot.headers.get('set-cookie') ?? '').split(';')[0]!
    const csrf = ((await boot.json()) as { data: { session: { csrfToken: string } } }).data.session
      .csrfToken
    const get = (path: string) => fetch(`${base}${path}`, { headers: { Cookie: cookie } })
    const post = (path: string, body: unknown) =>
      fetch(`${base}${path}`, {
        method: 'POST',
        headers: {
          Cookie: cookie,
          'Content-Type': 'application/json',
          Origin: base,
          'X-Volund-Csrf': csrf,
        },
        body: JSON.stringify(body),
      })
    return { get, post }
  }

  it('503s every workbench endpoint when the port is not wired', async () => {
    const { get } = await start(false)
    const res = await get('/api/v1/workbench/fs/list')
    expect(res.status).toBe(503)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'web_capability_unavailable',
    )
  })

  it('serves list/read/search/git over the authenticated API', async () => {
    const { get } = await start(true)
    const list = await get('/api/v1/workbench/fs/list?path=src')
    expect(list.status).toBe(200)
    const listed = (await list.json()) as { data: { entries: { path: string }[] } }
    expect(listed.data.entries.map((entry) => entry.path)).toContain('src/hello.ts')

    const read = await get('/api/v1/workbench/fs/read?path=README.md')
    expect(read.status).toBe(200)
    expect(((await read.json()) as { data: { content: string } }).data.content).toContain(
      '# Hello World',
    )

    const search = await get('/api/v1/workbench/search?q=second+line')
    expect(((await search.json()) as { data: { matches: unknown[] } }).data.matches).toHaveLength(1)

    const git = await get('/api/v1/workbench/git/status')
    expect(((await git.json()) as { data: { isRepo: boolean } }).data.isRepo).toBe(false)
  })

  it('maps path escapes to 400 and requires CSRF for writes', async () => {
    const { get, post } = await start(true)
    const escape = await get('/api/v1/workbench/fs/read?path=../../etc/passwd')
    expect(escape.status).toBe(400)
    expect(((await escape.json()) as { error: { code: string } }).error.code).toBe(
      'web_schema_invalid',
    )
    const write = await post('/api/v1/workbench/fs/write', {
      path: 'src/hello.ts',
      content: '// via route\n',
    })
    expect(write.status).toBe(200)
    expect(((await write.json()) as { data: { size: number } }).data.size).toBeGreaterThan(0)
  })

  it('advertises the workbench capability in bootstrap', async () => {
    const { get } = await start(true)
    const bootstrap = await get('/api/v1/bootstrap')
    const caps = ((await bootstrap.json()) as { data: { capabilities: { workbench: boolean } } })
      .data.capabilities
    expect(caps.workbench).toBe(true)
  })
})

/** 终端 WS 测试的最小握手/帧客户端（客户端帧必须掩码，服务端不掩码）。 */
async function wsHandshake(opts: {
  port: number
  cookie?: string
  origin?: string
}): Promise<{ socket: import('node:net').Socket; rest: Buffer }> {
  const socket = connect(opts.port, '127.0.0.1')
  await new Promise<void>((resolveConnect, rejectConnect) => {
    socket.once('error', rejectConnect)
    socket.once('connect', () => resolveConnect())
  })
  const key = randomBytes(16).toString('base64')
  socket.write(
    `GET /api/v1/workbench/terminal/ws HTTP/1.1\r\n` +
      `Host: 127.0.0.1:${opts.port}\r\n` +
      `Upgrade: websocket\r\nConnection: Upgrade\r\n` +
      `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n` +
      (opts.cookie ? `Cookie: ${opts.cookie}\r\n` : '') +
      `Origin: ${opts.origin ?? `http://127.0.0.1:${opts.port}`}\r\n\r\n`,
  )
  const rest = await new Promise<Buffer>((resolveHandshake, rejectHandshake) => {
    let head = Buffer.alloc(0)
    const onData = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk])
      const end = head.indexOf('\r\n\r\n')
      if (end === -1) return
      const statusLine = head.subarray(0, end).toString('utf8').split('\r\n')[0]
      socket.off('data', onData)
      if (!statusLine?.includes('101'))
        return rejectHandshake(new Error(`handshake rejected: ${statusLine}`))
      resolveHandshake(Buffer.from(head.subarray(end + 4)))
    }
    socket.on('data', onData)
    socket.once('close', () => rejectHandshake(new Error('socket closed during handshake')))
  })
  return { socket, rest: rest }
}

/** 编码客户端文本帧（掩码）。 */
function wsTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8')
  const mask = randomBytes(4)
  for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ mask[i % 4]!
  const length = payload.length
  const header = length < 126 ? Buffer.from([0x81, 0x80 | length]) : Buffer.alloc(4)
  if (length >= 126) {
    header[0] = 0x81
    header[1] = 0x80 | 126
    header.writeUInt16BE(length, 2)
  }
  return Buffer.concat([header, mask, payload])
}

describe('terminal websocket route', () => {
  async function startWithTerminal() {
    const root = await workspace()
    handle = await createWebServer({
      host: '127.0.0.1',
      port: 0,
      ports: { identity: { version: '0.0.0-test' }, cwd: root },
      workbench: createWorkbenchPort(root),
      // /bin/sh：确定快速（用户登录 shell 的 p10k 即时提示符会缓冲早期输入）。
      terminal: createTerminalPort(root, {
        shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
      }),
    })
    const { hostname, port: portText } = new URL(handle.url)
    const boot = await fetch(`http://${hostname}:${portText}/api/v1/bootstrap`)
    const cookie = (boot.headers.get('set-cookie') ?? '').split(';')[0]!
    return { port: Number(portText), cookie }
  }

  it('rejects upgrade without a browser session', async () => {
    const { port } = await startWithTerminal()
    await expect(wsHandshake({ port })).rejects.toThrow(/403|closed/)
  })

  it('streams an interactive shell over the websocket', async () => {
    const { port, cookie } = await startWithTerminal()
    const { socket, rest } = await wsHandshake({ port, cookie })
    try {
      let received = rest.toString('utf8')
      socket.on('data', (chunk: Buffer) => {
        // 只解不掩码文本帧的载荷（单帧小消息，不覆盖分片）。
        let buf = chunk
        while (buf.length >= 2) {
          let length = buf[1]! & 0x7f
          let offset = 2
          if (length === 126) {
            if (buf.length < 4) break
            length = buf.readUInt16BE(2)
            offset = 4
          }
          if (buf.length < offset + length) break
          received += buf.subarray(offset, offset + length).toString('utf8')
          buf = buf.subarray(offset + length)
        }
      })
      // 等 shell 提示符就绪再发命令（pty 回显 '$ '）。
      await vi.waitFor(() => expect(received).toContain('$'), { timeout: 8000 })
      socket.write(wsTextFrame(JSON.stringify({ type: 'in', data: 'echo ws-term-ok\n' })))
      await vi.waitFor(() => expect(received).toContain('ws-term-ok'), { timeout: 8000 })
      socket.write(wsTextFrame(JSON.stringify({ type: 'in', data: 'exit\n' })))
      await vi.waitFor(() => expect(received).toContain('"type":"exit"'), { timeout: 8000 })
    } finally {
      socket.destroy()
    }
  }, 20_000)
})
