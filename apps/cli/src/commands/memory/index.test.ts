import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DefaultMemoryService,
  LocalMemoryRepository,
  MemoryError,
  MemoryTransferService,
} from '@volund/storage'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { runCli } from '../../cli'
import { projectMemoryScope } from '../../memory-scope'
import { unavailablePorts } from '../../ports'
import type { CliIo } from '../../shared/cli-types'

const roots: string[] = []
const nonInteractive: CliIo = {
  isInteractiveTerminal: () => false,
  readStdin: async () => '',
  confirm: vi.fn(async () => false),
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'volund-memory-cli-'))
  roots.push(root)
  let tick = 0
  const memory = new DefaultMemoryService(
    new LocalMemoryRepository(join(root, 'records.json')),
    undefined,
    () => new Date(`2026-08-12T00:00:0${tick++}.000Z`),
  )
  const memoryTransfer = new MemoryTransferService(memory, {
    journalPath: join(root, 'import-journal.json'),
  })
  const ports = { ...unavailablePorts(), memory, memoryTransfer }
  return { root, memory, ports }
}

describe('volund memory', () => {
  it('supports add, filtered cursor listing, get, update, pin, and unpin as stable JSON', async () => {
    const { ports } = await fixture()
    const added = await runCli(
      [
        'memory',
        'add',
        '--id',
        'preference',
        '--scope',
        'project',
        '--tag',
        'tooling,package-manager',
        '--content',
        'Use pnpm',
        '--json',
      ],
      ports,
      nonInteractive,
    )
    expect(added.exitCode).toBe(0)
    expect(JSON.parse(added.stdout)).toMatchObject({
      schemaVersion: 1,
      memory: { id: 'preference', content: 'Use pnpm', provenance: { source: 'user' } },
    })
    await runCli(
      ['memory', 'add', '--id', 'second', '--tag', 'tooling', '--content', 'Keep lockfiles'],
      ports,
      nonInteractive,
    )

    const listed = await runCli(
      [
        'memory',
        'list',
        '--scope',
        'project',
        '--tag',
        'tooling',
        '--source',
        'user',
        '--limit',
        '1',
        '--json',
      ],
      ports,
      nonInteractive,
    )
    const firstPage = JSON.parse(listed.stdout) as { nextCursor: string }
    expect(firstPage).toEqual({
      schemaVersion: 1,
      items: [expect.objectContaining({ id: 'second', tags: ['tooling'] })],
      nextCursor: expect.any(String),
    })
    expect(
      JSON.parse(
        (
          await runCli(
            [
              'memory',
              'list',
              '--scope',
              'project',
              '--limit',
              '1',
              '--cursor',
              firstPage.nextCursor,
              '--json',
            ],
            ports,
            nonInteractive,
          )
        ).stdout,
      ),
    ).toMatchObject({ items: [{ id: 'preference' }], nextCursor: null })
    expect(
      (
        await runCli(
          ['memory', 'list', '--scope', 'project', '--tag', 'package-manager'],
          ports,
          nonInteractive,
        )
      ).stdout,
    ).toMatchInlineSnapshot(`"preference\tproject\t-\tpackage-manager,tooling\tUse pnpm\n"`)
    expect((await runCli(['memory', 'get', 'preference'], ports, nonInteractive)).stdout).toContain(
      'Use pnpm',
    )
    await runCli(
      ['memory', 'update', 'preference', '--content', 'Use pnpm 11', '--pinned'],
      ports,
      nonInteractive,
    )
    expect(
      JSON.parse(
        (await runCli(['memory', 'get', 'preference', '--json'], ports, nonInteractive)).stdout,
      ),
    ).toMatchObject({
      memory: { content: 'Use pnpm 11', pinned: true },
    })
    await runCli(['memory', 'unpin', 'preference'], ports, nonInteractive)
    expect(
      JSON.parse(
        (await runCli(['memory', 'get', 'preference', '--json'], ports, nonInteractive)).stdout,
      ).memory.pinned,
    ).toBe(false)
    await runCli(['memory', 'pin', 'preference'], ports, nonInteractive)
    expect(
      JSON.parse(
        (
          await runCli(
            ['memory', 'list', '--scope', 'project', '--pinned', '--json'],
            ports,
            nonInteractive,
          )
        ).stdout,
      ).items,
    ).toMatchObject([{ id: 'preference' }])
  })

  it('requires explicit non-TTY deletion confirmation and returns stable exit codes', async () => {
    const { ports } = await fixture()
    await runCli(['memory', 'add', '--id', 'doomed', 'temporary'], ports, nonInteractive)
    const denied = await runCli(['memory', 'delete', 'doomed', '--json'], ports, nonInteractive)
    expect(denied.exitCode).toBe(2)
    expect(JSON.parse(denied.stdout)).toEqual({
      schemaVersion: 1,
      error: {
        code: 'confirmation_required',
        message: 'memory delete requires --yes outside an interactive terminal',
        exitCode: 2,
      },
    })
    expect((await runCli(['memory', 'get', 'doomed'], ports, nonInteractive)).exitCode).toBe(0)
    expect(
      (await runCli(['memory', 'delete', 'doomed', '--yes'], ports, nonInteractive)).exitCode,
    ).toBe(0)
    expect((await runCli(['memory', 'get', 'doomed'], ports, nonInteractive)).exitCode).toBe(3)
  })

  it('maps validation and authorization failures and supports stdin without TUI or ANSI', async () => {
    const { memory, ports } = await fixture()
    const stdin = { ...nonInteractive, readStdin: async () => 'stdin body' }
    const result = await runCli(
      ['memory', 'add', '--id', 'stdin', '--body-stdin', '--no-tui', '--no-color'],
      ports,
      stdin,
    )
    expect(result).toMatchObject({ exitCode: 0, stderr: '' })
    expect(result.stdout).not.toContain('\u001B')
    expect((await runCli(['memory', 'list', '--limit', '0'], ports, nonInteractive)).exitCode).toBe(
      2,
    )

    await memory.create({
      id: 'redacted',
      scope: { kind: 'workspace', workspaceId: 'local' },
      content: 'safe',
      provenance: { source: 'user' },
    })
    const redacted = new Proxy(memory, {
      get(target, property, receiver) {
        if (property === 'get')
          return async (...parameters: Parameters<typeof memory.get>) => {
            const record = await target.get(...parameters)
            return record ? { ...record, content: 'token=super-secret' } : record
          }
        const value = Reflect.get(target, property, receiver) as unknown
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const redactedOutput = await runCli(
      ['memory', 'get', 'redacted', '--scope', 'workspace', '--json'],
      { ...ports, memory: redacted },
      nonInteractive,
    )
    expect(redactedOutput.stdout).toContain('token=[REDACTED]')
    expect(redactedOutput.stdout).not.toContain('super-secret')

    const denied = new Proxy(memory, {
      get(target, property, receiver) {
        if (property === 'create')
          return async () => {
            throw new MemoryError('memory_scope_denied', 'scope denied')
          }
        const value = Reflect.get(target, property, receiver) as unknown
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    expect(
      (
        await runCli(
          ['memory', 'add', '--content', 'denied', '--json'],
          { ...ports, memory: denied },
          nonInteractive,
        )
      ).exitCode,
    ).toBe(13)

    const fakeProviderSecret = `AKIA${'FAKE'.repeat(4)}`
    const rejected = await runCli(
      ['memory', 'add', '--id', 'secret', '--content', fakeProviderSecret, '--json'],
      ports,
      nonInteractive,
    )
    expect(rejected.exitCode).toBe(2)
    expect(rejected.stdout).not.toContain(fakeProviderSecret)
    expect(await memory.get(projectMemoryScope(process.cwd()), 'secret')).toBeUndefined()
  })

  it('renders command-specific help without starting runtime work', async () => {
    const { ports } = await fixture()
    const result = await runCli(['memory', '--help'], ports, nonInteractive)
    expect(result).toMatchObject({ exitCode: 0, stderr: '' })
    expect(result.stdout).toContain('volund memory <command>')
    expect(result.stdout).toContain('--cursor')
  })

  it('exports a versioned local archive and imports with dry-run conflict reporting', async () => {
    const source = await fixture()
    await runCli(
      ['memory', 'add', '--id', 'portable', '--scope', 'project', '--content', 'portable body'],
      source.ports,
      nonInteractive,
    )
    await runCli(
      ['memory', 'add', '--id', 'workspace-only', '--scope', 'workspace', '--content', 'private'],
      source.ports,
      nonInteractive,
    )
    const exported = await runCli(
      ['memory', 'export', '--scope', 'project'],
      source.ports,
      nonInteractive,
    )
    expect(JSON.parse(exported.stdout)).toMatchObject({
      schemaVersion: 'volund.memory.export.v1',
      records: [{ id: 'portable' }],
    })

    const archive = join(source.root, 'memory-export.json')
    await writeFile(archive, exported.stdout)
    const target = await fixture()
    await runCli(
      ['memory', 'add', '--id', 'portable', '--scope', 'project', '--content', 'existing'],
      target.ports,
      nonInteractive,
    )
    const dryRun = await runCli(
      [
        'memory',
        'import',
        archive,
        '--scope',
        'project',
        '--strategy',
        'overwrite',
        '--dry-run',
        '--json',
      ],
      target.ports,
      nonInteractive,
    )
    expect(JSON.parse(dryRun.stdout)).toMatchObject({
      dryRun: true,
      applied: 0,
      conflicts: [{ id: 'portable', action: 'overwritten' }],
    })
    expect((await target.memory.get(projectMemoryScope(process.cwd()), 'portable'))?.content).toBe(
      'existing',
    )
  })
})
