/**
 * 首次启动种子数据：一个可完整安装的示例插件（文件落盘 + sha256 入库）+
 * 真实可装的官方 skills（anthropics/skills tree URL，走既有 git 安装通道）+
 * 常用 MCP 目录条目。种子只写一次（data/market.json 存在即跳过）。
 */
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { MarketDatabase, SkillRecord } from './types'

const sha256 = (content: Buffer | string) =>
  `sha256-${createHash('sha256').update(content).digest('hex')}` as const

const DEMO_MANIFEST = {
  name: 'volund-plugin-demo',
  version: '1.0.0',
  type: 'module',
  main: 'index.mjs',
  // 与当前 volund 运行时（0.2.0）匹配；宿主安装时会做 engines 校验
  engines: { volund: '^0.2.0' },
  description: '市场示例插件：演示发布 → 浏览 → 安装的完整链路',
  publisher: 'volund',
  permissions: { volund: ['commands.register'] },
}

const DEMO_INDEX_MJS = `// volund-plugin-demo —— 市场示例插件（仅演示市场链路，无实际功能）。
// 安装后由插件宿主按 manifest.permissions 授权并激活。
export const activate = (bridge) => {
  bridge?.log?.write?.('volund-plugin-demo activated')
}
`

const DEMO_README = `# volund-plugin-demo

市场端到端示例插件：在管理页发布 → 市场页浏览 → \`volund\` 配置回环市场源后安装。
manifest.json / index.mjs 均为最小可校验形态（engines ^0.1.0，仅申请 commands.register）。
`

function demoPlugin(): { files: { path: string; content: string }[]; readme: string } {
  return {
    files: [
      { path: 'manifest.json', content: `${JSON.stringify(DEMO_MANIFEST, null, 2)}\n` },
      { path: 'index.mjs', content: DEMO_INDEX_MJS },
    ],
    readme: DEMO_README,
  }
}

const now = () => new Date().toISOString()

// 版本标签统一 semver（x.y.z，校验同插件 manifest）
const skill = (name: string, description: string): SkillRecord => ({
  name,
  description,
  version: '1.0.0',
  source: `https://github.com/anthropics/skills/tree/main/skills/${name}`,
  homepage: 'https://github.com/anthropics/skills',
  addedAt: now(),
})

export function seedDatabase(): {
  database: MarketDatabase
  bundleFiles: { name: string; version: string; path: string; content: string }[]
} {
  const demo = demoPlugin()
  const installedAt = now()
  const database: MarketDatabase = {
    seededAt: installedAt,
    plugins: {
      'volund-plugin-demo': {
        name: 'volund-plugin-demo',
        publisher: 'volund',
        description: DEMO_MANIFEST.description,
        createdAt: installedAt,
        updatedAt: installedAt,
        downloads: 0,
        versions: [
          {
            version: DEMO_MANIFEST.version,
            publishedAt: installedAt,
            manifest: DEMO_MANIFEST,
            files: demo.files.map((file) => ({ path: file.path, digest: sha256(file.content) })),
            readme: demo.readme,
          },
        ],
      },
    },
    skills: Object.fromEntries(
      [
        skill('xlsx', 'Excel 电子表格处理：创建、编辑与分析 .xlsx'),
        skill('docx', 'Word 文档处理：创建、编辑与分析 .docx'),
        skill('pptx', 'PowerPoint 演示文稿创建、编辑与分析'),
        skill('pdf', 'PDF 处理：表单填写、文本提取、合并与拆分'),
        skill('skill-creator', '引导式创建高质量的新 skill'),
        skill('mcp-builder', '构建高质量 MCP 服务器的指导'),
        skill('frontend-design', '前端界面设计审美与实现指导'),
      ].map((item) => [item.name, item]),
    ),
    mcp: Object.fromEntries(
      (
        [
          {
            name: 'filesystem',
            description: '官方文件系统 MCP：受控目录读写（stdio / npx）',
            // 包版本取自 npm @modelcontextprotocol/server-filesystem latest（2026-09 查询）
            version: '2026.8.31',
            transport: 'stdio',
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
            homepage: 'https://github.com/modelcontextprotocol/servers',
          },
          {
            name: 'fetch',
            description: '官方网页抓取 MCP：取网页并转 Markdown（stdio / uvx）',
            // 包版本取自 PyPI mcp-server-fetch latest（2026-09 查询）
            version: '2026.8.18',
            transport: 'stdio',
            command: 'uvx',
            args: ['mcp-server-fetch'],
            homepage: 'https://github.com/modelcontextprotocol/servers',
          },
          {
            name: 'deepwiki',
            description: 'DeepWiki：对任意 GitHub 仓库提问（http）',
            // 托管服务无包版本，此处为目录标签
            version: '1.0.0',
            transport: 'http',
            url: 'https://mcp.deepwiki.com/mcp',
            homepage: 'https://deepwiki.com',
          },
        ] as const
      ).map((entry) => [entry.name, { ...entry, addedAt: installedAt }]),
    ),
  }
  return {
    database,
    bundleFiles: demo.files.map((file) => ({
      name: DEMO_MANIFEST.name,
      version: DEMO_MANIFEST.version,
      path: file.path,
      content: file.content,
    })),
  }
}

/** 把种子插件的 bundle 文件写到存储目录（仅首次启动调用）。 */
export async function writeSeedBundles(
  bundleRoot: string,
  files: { name: string; version: string; path: string; content: string }[],
): Promise<void> {
  for (const file of files) {
    const target = join(bundleRoot, file.name, file.version, file.path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, file.content, 'utf8')
  }
}
