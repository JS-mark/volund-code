/**
 * 工作台 FS 变更操作（代码页内嵌 vscode workbench 的 FileSystemProvider 后端）:
 * stat / readBytes(base64) / mkdir / delete / rename,含逃逸与根目录保护。
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createWorkbenchPort } from './workbench'
import type { WorkbenchPort } from './workbench'

let root: string
let port: WorkbenchPort

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'volund-workbench-mutations-'))
  await writeFile(join(root, 'a.txt'), 'hello')
  port = createWorkbenchPort(root)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('workbench fs mutations', () => {
  it('stat 区分文件/目录并带 size/mtime', async () => {
    const file = await port.stat('a.txt')
    expect(file.kind).toBe('file')
    expect(file.size).toBe(5)
    expect(file.mtimeMs).toBeGreaterThan(0)
    await port.mkdir('dir')
    expect((await port.stat('dir')).kind).toBe('dir')
    await expect(port.stat('nope')).rejects.toThrow('not found')
  })

  it('readBytes 返回 base64 字节(二进制友好)', async () => {
    const bytes = await port.readBytes('a.txt')
    expect(Buffer.from(bytes.base64, 'base64').toString('utf8')).toBe('hello')
    expect(bytes.size).toBe(5)
  })

  it('mkdir 递归创建;delete 保护根目录、目录须 recursive', async () => {
    await port.mkdir('x/y/z')
    expect((await port.stat('x/y/z')).kind).toBe('dir')

    await port.deletePath('a.txt', false)
    await expect(port.stat('a.txt')).rejects.toThrow('not found')

    await expect(port.deletePath('x', false)).rejects.toThrow('recursive')
    await port.deletePath('x', true)
    await expect(port.stat('x')).rejects.toThrow('not found')

    await expect(port.deletePath('', true)).rejects.toThrow('workspace root')
  })

  it('rename 移动文件;目标已存在报错', async () => {
    await port.rename('a.txt', 'b.txt')
    expect(Buffer.from((await port.readBytes('b.txt')).base64, 'base64').toString()).toBe('hello')
    await writeFile(join(root, 'c.txt'), 'c')
    await expect(port.rename('b.txt', 'c.txt')).rejects.toThrow('target exists')
  })

  it('逃逸 root 一律拒绝', async () => {
    await expect(port.stat('../outside')).rejects.toThrow('escapes')
    await expect(port.mkdir('../outside')).rejects.toThrow('escapes')
    await expect(port.deletePath('../outside', true)).rejects.toThrow('escapes')
    await expect(port.rename('a.txt', '../outside')).rejects.toThrow('escapes')
  })
})
