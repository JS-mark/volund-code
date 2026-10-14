import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DefaultMemoryService, LocalMemoryRepository } from '@volund/storage'
import { afterEach, describe, expect, it } from 'vitest'

import {
  consolidateSessionMemory,
  type ConsolidationTranscriptItem,
  type MemoryConsolidationModel,
} from '../memory-consolidation'
import { projectMemoryScope, workspaceMemoryScope } from '../memory-scope'

const dirs: string[] = []
afterEach(async () =>
  Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))),
)

const workspace = workspaceMemoryScope()
const project = projectMemoryScope('/repo')

function transcript(...pairs: [string, string][]): ConsolidationTranscriptItem[] {
  return pairs.map(([role, text]) => ({ role, text }))
}

function scriptModel(
  output: string,
  calls: { prompt?: string; system?: string }[] = [],
): MemoryConsolidationModel {
  return {
    async complete({ prompt, system }) {
      calls.push({ prompt, system })
      return output
    },
  }
}

async function memoryService() {
  const root = await mkdtemp(join(tmpdir(), 'volund-consolidation-'))
  dirs.push(root)
  return new DefaultMemoryService(new LocalMemoryRepository(join(root, 'records.json')))
}

const FULL_SESSION = transcript(
  [
    'user',
    '我们团队一律用 pnpm，别用 npm——这是之前吃过亏定下的规矩，CI 和本地脚本都用 pnpm 跑，避免锁文件不一致的问题。',
  ],
  [
    'assistant',
    '好的，记住了：这个仓库统一用 pnpm 作为包管理器，CI 和本地脚本保持一致，提交前跑 pnpm lint 和 pnpm test。我已经用 pnpm install 装好依赖，测试全部通过，没有发现锁文件冲突。',
  ],
  ['user', '另外回复尽量简短一点，直接给结论和必要的命令就行，不要长篇解释背景'],
  ['assistant', '明白，之后保持简洁：结论优先，只在必要时给上下文。'],
)

describe('consolidateSessionMemory', () => {
  it('writes model-extracted memories with consolidation provenance', async () => {
    const memory = await memoryService()
    const calls: { prompt?: string; system?: string }[] = []
    const written = await consolidateSessionMemory({
      memory,
      workspaceScope: workspace,
      projectScope: project,
      model: scriptModel(
        '[{"scope":"workspace","content":"用户偏好 pnpm 与简短回复","tags":["style"]},{"scope":"project","content":"仓库使用 pnpm 工作流","tags":[]}]',
        calls,
      ),
      transcript: FULL_SESSION,
      existingSummaries: [],
    })
    expect(written).toBe(2)
    const all = await memory.list(workspace)
    const projectItems = await memory.list(project)
    expect(all).toHaveLength(1)
    expect(projectItems).toHaveLength(1)
    expect(all[0]?.provenance).toEqual({ source: 'agent', actorId: 'memory-consolidation' })
    expect(all[0]?.tags).toEqual(['style'])
    expect(calls[0]?.system).toContain('JSON array')
    expect(calls[0]?.prompt).toContain('Session transcript')
  })

  it('passes existing summaries to the model for deduplication', async () => {
    const memory = await memoryService()
    const calls: { prompt?: string; system?: string }[] = []
    await consolidateSessionMemory({
      memory,
      workspaceScope: workspace,
      projectScope: project,
      model: scriptModel('[]', calls),
      transcript: FULL_SESSION,
      existingSummaries: ['用户偏好 pnpm'],
    })
    expect(calls[0]?.prompt).toContain('Existing memories')
    expect(calls[0]?.prompt).toContain('- 用户偏好 pnpm')
  })

  it('gates on message count, transcript size, and the env kill switch', async () => {
    const memory = await memoryService()
    const model = scriptModel('[{"scope":"workspace","content":"x","tags":[]}]')
    const short = transcript(['user', 'hi'], ['assistant', 'hello'])
    expect(
      await consolidateSessionMemory({
        memory,
        workspaceScope: workspace,
        projectScope: project,
        model,
        transcript: short,
      }),
    ).toBe(0)
    expect(
      await consolidateSessionMemory({
        memory,
        workspaceScope: workspace,
        projectScope: project,
        model,
        transcript: transcript(
          ...Array.from({ length: 4 }, (): [string, string] => ['user', 'ok']),
        ),
      }),
    ).toBe(0)
    expect(
      await consolidateSessionMemory({
        memory,
        workspaceScope: workspace,
        projectScope: project,
        model,
        transcript: FULL_SESSION,
        env: '0',
      }),
    ).toBe(0)
    expect(await memory.list(workspace)).toHaveLength(0)
  })

  it('ignores malformed model output and skips guard-vetoed items', async () => {
    const memory = await memoryService()
    const written = await consolidateSessionMemory({
      memory,
      workspaceScope: workspace,
      projectScope: project,
      model: scriptModel('not json at all'),
      transcript: FULL_SESSION,
    })
    expect(written).toBe(0)

    const vetoed = await consolidateSessionMemory({
      memory,
      workspaceScope: workspace,
      projectScope: project,
      model: scriptModel(
        `[{"scope":"workspace","content":"key sk-proj-${'FAKE'.repeat(6)} is leaked","tags":[]},{"scope":"workspace","content":"干净的一条","tags":[]}]`,
      ),
      transcript: FULL_SESSION,
    })
    expect(vetoed).toBe(1)
    const items = await memory.list(workspace)
    expect(items).toHaveLength(1)
    expect(items[0]?.content).toBe('干净的一条')
  })

  it('never creates more than maxItems records', async () => {
    const memory = await memoryService()
    const many = Array.from({ length: 8 }, (_, index) => ({
      scope: 'workspace',
      content: `记忆 ${index}`,
      tags: [],
    }))
    const written = await consolidateSessionMemory({
      memory,
      workspaceScope: workspace,
      projectScope: project,
      model: scriptModel(JSON.stringify(many)),
      transcript: FULL_SESSION,
      maxItems: 3,
    })
    expect(written).toBe(3)
  })

  it('returns zero when the model call rejects', async () => {
    const memory = await memoryService()
    const failing: MemoryConsolidationModel = {
      complete: async () => {
        throw new Error('provider down')
      },
    }
    expect(
      await consolidateSessionMemory({
        memory,
        workspaceScope: workspace,
        projectScope: project,
        model: failing,
        transcript: FULL_SESSION,
      }),
    ).toBe(0)
    expect(await memory.list(workspace)).toHaveLength(0)
  })
})
