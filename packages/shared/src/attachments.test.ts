import { describe, expect, it } from 'vitest'

import {
  attachmentChipLabel,
  contentPartChipLabel,
  imageChipLabel,
  stripAttachmentChips,
  type SubmitAttachment,
} from './attachments'

describe('imageChipLabel (§7.5.2)', () => {
  it('numbers clipboard images sequentially', () => {
    expect(imageChipLabel(1)).toBe('[image_1]')
    expect(imageChipLabel(2)).toBe('[image_2]')
  })
})

describe('attachmentChipLabel (§7.5.2)', () => {
  it('derives image chips from content-addressed handles (digest-8 + ext)', () => {
    const handle = `${'a'.repeat(64)}.png`
    expect(attachmentChipLabel({ handle, kind: 'image' })).toBe('[image: aaaaaaaa.png]')
  })

  it('derives file chips from path basename', () => {
    expect(attachmentChipLabel({ kind: 'file', path: '/tmp/docs/report.pdf' })).toBe(
      '[file: report.pdf]',
    )
    expect(attachmentChipLabel({ kind: 'image', path: 'C:\\shots\\one.png' })).toBe(
      '[image: one.png]',
    )
  })

  it('falls back to a bare chip when neither handle nor path exists', () => {
    expect(attachmentChipLabel({ kind: 'image' })).toBe('[image]')
  })
})

describe('contentPartChipLabel', () => {
  it('renders handle and path image/file parts as chips', () => {
    const handle = `${'b'.repeat(64)}.jpg`
    expect(
      contentPartChipLabel({ source: { handle, kind: 'handle' }, type: 'image' }),
    ).toBe('[image: bbbbbbbb.jpg]')
    expect(
      contentPartChipLabel({ source: { absPath: '/tmp/x.png', kind: 'path' }, type: 'file' }),
    ).toBe('[file: x.png]')
  })

  it('uses filename for inline parts and ignores non-attachment parts', () => {
    expect(contentPartChipLabel({ filename: 'a.pdf', type: 'file' })).toBe('[file: a.pdf]')
    expect(contentPartChipLabel({ type: 'text' })).toBeUndefined()
    expect(contentPartChipLabel({ type: 'tool_use' })).toBeUndefined()
  })
})

describe('stripAttachmentChips', () => {
  const attachments: SubmitAttachment[] = [
    { chip: '[image: aaaaaaaa.png]', kind: 'image', mime: 'image/png', size: 10 },
    { chip: '[file: report.pdf]', kind: 'file', mime: 'application/pdf', size: 10 },
  ]

  it('removes chip tokens and squeezes the whitespace they leave behind', () => {
    expect(
      stripAttachmentChips('看看这个 [image: aaaaaaaa.png] 和 [file: report.pdf] 对吗', attachments),
    ).toBe('看看这个 和 对吗')
  })

  it('returns empty text when the message is only chips', () => {
    expect(stripAttachmentChips('[image: aaaaaaaa.png] [file: report.pdf] ', attachments)).toBe('')
  })

  it('keeps newlines from shift+enter intact', () => {
    expect(stripAttachmentChips('第一行\n第二行 [image: aaaaaaaa.png]', attachments)).toBe(
      '第一行\n第二行',
    )
  })
})
