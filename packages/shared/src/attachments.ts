/**
 * §7.5.2 附件粘贴：输入行 chip 与提交附件的统一类型。
 *
 * chip 是附件在输入行 / 输入历史 / transcript 里的唯一表示——二进制内容只以
 * 内容寻址的 handle 落盘（`~/.volund/sessions/<sid>/attachments/`），永不进事件流、
 * 历史文件或日志（附录 D.1「大 payload 不进事件，只传引用」的输入侧对偶）。
 */

export type SubmitAttachmentKind = 'file' | 'image'

/** 宿主暂存完附件后回给 UI 的信息；chip 文本由输入框分配（[image_1] 顺序编号）。 */
export interface StagedAttachmentInfo {
  readonly kind: SubmitAttachmentKind
  readonly mime: string
  readonly size: number
  /** 已落盘引用（AttachmentStore 内容寻址 handle：`<sha256>.<ext>`）。 */
  readonly handle?: string
  /** 本地路径引用（粘贴文件路径 / Finder 拷贝）。读取由 AttachmentStore 的 allowedPathRoots 把守。 */
  readonly path?: string
}

export interface SubmitAttachment extends StagedAttachmentInfo {
  /** 输入行占位 token 全文，如 `[image_1]` / `[file: report.pdf]`。 */
  readonly chip: string
}

/** Ctrl+V 粘贴的结果：附加成功 / 纯文本（插入输入行）/ 空剪贴板 / 权限拒绝 / 平台不可用。 */
export type PasteAttachmentResult =
  | { readonly kind: 'attached'; readonly attachment: StagedAttachmentInfo }
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'empty' }
  | { readonly kind: 'denied' }
  | { readonly kind: 'unavailable'; readonly reason: string }

/** 图片附件 chip：输入行内按粘贴顺序编号（[image_1]、[image_2]…）。 */
export function imageChipLabel(sequence: number): string {
  return `[image_${sequence}]`
}

/**
 * 附件 chip 文本派生（transcript/history 回放侧）：handle（`<sha256>.<ext>`）取
 * digest 前 8 位；路径取 basename。输入行展示以 UI 分配的 chip 为准（[image_N]），
 * 二者经 app 层的 handle→chip 映射对齐。
 */
export function attachmentChipLabel(input: {
  readonly kind: SubmitAttachmentKind
  readonly handle?: string
  readonly path?: string
}): string {
  if (input.handle) {
    const dot = input.handle.lastIndexOf('.')
    const digest = dot > 0 ? input.handle.slice(0, dot) : input.handle
    const ext = dot > 0 ? input.handle.slice(dot + 1) : ''
    return `[${input.kind}: ${digest.slice(0, 8)}${ext ? `.${ext}` : ''}]`
  }
  if (input.path) {
    const base = input.path.split(/[\\/]/).findLast((segment) => segment.length > 0)
    if (base) return `[${input.kind}: ${base}]`
  }
  return `[${input.kind}]`
}

/**
 * transcript / history 展示的逆运算：image/file ContentPart → chip 文本。
 * 鸭子类型参数——shared 不能反向依赖 provider-kit 的 ContentPart。
 */
export function contentPartChipLabel(part: {
  readonly type: string
  readonly source?: {
    readonly kind: string
    readonly handle?: string
    readonly absPath?: string
  }
  readonly filename?: string
}): string | undefined {
  if (part.type !== 'image' && part.type !== 'file') return undefined
  const kind = part.type
  const source = part.source
  if (source?.kind === 'handle' && source.handle)
    return attachmentChipLabel({ kind, handle: source.handle })
  if (source?.kind === 'path' && source.absPath)
    return attachmentChipLabel({ kind, path: source.absPath })
  if (part.filename) return `[${kind}: ${part.filename}]`
  return `[${kind}]`
}

/**
 * 提交时把 chip token 从文本中剔除——chip 已展开为独立的 image/file ContentPart，
 * 文本里再留一份既污染模型输入也重复展示。只压缩空白，不动换行结构。
 */
export function stripAttachmentChips(
  text: string,
  attachments: readonly SubmitAttachment[],
): string {
  let out = text
  for (const attachment of attachments) out = out.split(attachment.chip).join(' ')
  return out.replace(/[^\S\n]+/g, ' ').trim()
}
