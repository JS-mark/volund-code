import { readdir } from 'node:fs/promises'
/**
 * 会话附件辅助（§7.5.2/§7.5.3 / P1-03 附件增强随 main 合入）：
 * prompt+attachments 组装、@ picker 的文件候选扫描、MIME 判定。
 * 从 apps/cli/src/runtime.ts 迁入（随 RuntimeSessionPort→SessionController 移植）。
 */
import { basename } from 'node:path'
import { join, relative } from 'node:path'

import type { ContentPart } from '@volund/provider-kit'
import { stripAttachmentChips, type SubmitAttachment } from '@volund/shared'

export function composeAttachmentInput(
  prompt: string,
  attachments: readonly SubmitAttachment[],
): string | readonly ContentPart[] {
  if (attachments.length === 0) return prompt
  const parts: ContentPart[] = attachments.map((attachment) => {
    const source = attachment.handle
      ? ({ kind: 'handle', handle: attachment.handle } as const)
      : ({ kind: 'path', absPath: attachment.path ?? '' } as const)
    if (attachment.kind === 'image') return { type: 'image', source, mime: attachment.mime }
    const filename = attachment.path
      ? basename(attachment.path)
      : (attachment.handle ?? 'attachment')
    return { type: 'file', filename, mime: attachment.mime, source }
  })
  const text = stripAttachmentChips(prompt, attachments)
  if (text) parts.push({ type: 'text', text })
  return parts
}

/** @ picker 文件候选遍历时的跳过目录（隐藏目录 + 重依赖/构建产物）。 */
const WORKSPACE_LIST_SKIP = new Set([
  '.git',
  '.next',
  '.turbo',
  '_tmp_test',
  'coverage',
  'dist',
  'node_modules',
  'target',
])
const WORKSPACE_LIST_MAX_ENTRIES = 5_000
const WORKSPACE_LIST_MAX_DEPTH = 8

/**
 * §7.5.3 @ picker 的文件候选：会话 cwd 下的相对路径（排序、限量 5000、限深 8）。
 * 隐藏文件不进候选（.env 这类本就不该被 @ 引用；store 读取侧另有 sensitive 拦截）。
 */
export async function listWorkspaceFiles(cwd: string): Promise<readonly string[]> {
  const out: string[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > WORKSPACE_LIST_MAX_DEPTH || out.length >= WORKSPACE_LIST_MAX_ENTRIES) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (out.length >= WORKSPACE_LIST_MAX_ENTRIES) return
      if (entry.name.startsWith('.')) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!WORKSPACE_LIST_SKIP.has(entry.name)) await walk(full, depth + 1)
      } else if (entry.isFile()) {
        // windows 的 relative 返回反斜杠：@ picker 契约统一 posix 分隔符。
        out.push(relative(cwd, full).replaceAll('\\', '/'))
      }
    }
  }
  await walk(cwd, 0)
  return out.sort()
}

/** 粘贴文件路径的 MIME 猜测；未识别按 octet-stream（provider 不支持时降级为文本）。 */
export function mimeForAttachmentPath(path: string): string {
  const ext = basename(path).split('.').pop()?.toLowerCase() ?? ''
  const known: Record<string, string> = {
    csv: 'text/csv',
    gif: 'image/gif',
    jpeg: 'image/jpeg',
    jpg: 'image/jpeg',
    json: 'application/json',
    log: 'text/plain',
    md: 'text/markdown',
    pdf: 'application/pdf',
    png: 'image/png',
    txt: 'text/plain',
    webp: 'image/webp',
  }
  return known[ext] ?? 'application/octet-stream'
}

/**
 * resume transcript 的全保真提取：markdown 的块级结构（标题/列表/表格/代码块）
 * 全靠换行界定，折叠空白会把整段塌成一行流水文本。
 * §7.5.2：image/file part 渲染回 chip 文本，resume 后用户消息仍可见附件占位。
 */
