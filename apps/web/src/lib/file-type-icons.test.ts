import { describe, expect, it } from 'vitest'

import { fileTypeBadge } from './file-type-icons'

describe('fileTypeBadge', () => {
  it('常见扩展名命中语言徽章', () => {
    expect(fileTypeBadge('index.ts')).toEqual({ label: 'TS', color: '#3178c6' })
    expect(fileTypeBadge('App.tsx')).toEqual({ label: 'TS', color: '#3178c6' })
    expect(fileTypeBadge('tool.mjs')?.label).toBe('JS')
    expect(fileTypeBadge('README.md')?.label).toBe('MD')
    expect(fileTypeBadge('main.py')?.label).toBe('PY')
    expect(fileTypeBadge('icon.png')?.label).toBe('IM')
  })

  it('特殊文件名优先于扩展名', () => {
    expect(fileTypeBadge('package.json')).toEqual({ label: 'N', color: '#cb3837' })
    expect(fileTypeBadge('pnpm-lock.yaml')?.label).toBe('LK')
    expect(fileTypeBadge('Dockerfile')).toEqual({ label: 'DK', color: '#2496ed' })
    expect(fileTypeBadge('Dockerfile.prod')?.label).toBe('DK')
    expect(fileTypeBadge('.gitignore')?.label).toBe('G')
    expect(fileTypeBadge('.env.local')?.label).toBe('E')
  })

  it('未命中返回 undefined(回落默认文件图标)', () => {
    expect(fileTypeBadge('notes.xyz')).toBeUndefined()
    expect(fileTypeBadge('AUTHORS')).toBeUndefined()
  })
})
