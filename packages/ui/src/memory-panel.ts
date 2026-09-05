// Memory 面板契约已迁至 @volund/app-runtime（P1-04b）；此处 re-export 保持兼容。
// 终端宽度渲染函数留在本包（Ink 渲染关注列宽）。
export {
  memoryPanelError,
  type MemoryPanelController,
  type MemoryPanelError,
  type MemoryPanelErrorCode,
  type MemoryPanelMode,
  type MemoryPanelPage,
  type MemoryPanelRecord,
} from '@volund/app-runtime'

export function truncateTerminal(value: string, columns: number): string {
  if (columns <= 0) return ''
  const normalized = value.replaceAll(/\s+/g, ' ').trim()
  const output: Array<{ character: string; width: number }> = []
  let width = 0
  for (const character of normalized) {
    const next = terminalCharacterWidth(character)
    if (width + next > columns) {
      while (output.length && width + 1 > columns) width -= output.pop()!.width
      return `${output.map((item) => item.character).join('')}…`
    }
    output.push({ character, width: next })
    width += next
  }
  return output.map((item) => item.character).join('')
}

export function wrapTerminalLines(value: string, columns: number): string[] {
  const lines: string[] = []
  const widthLimit = Math.max(1, columns)
  for (const sourceLine of value.split('\n')) {
    let line = ''
    let width = 0
    for (const character of sourceLine) {
      const characterWidth = terminalCharacterWidth(character)
      if (line && width + characterWidth > widthLimit) {
        lines.push(line)
        line = ''
        width = 0
      }
      line += character
      width += characterWidth
    }
    lines.push(line)
  }
  return lines.length ? lines : ['']
}

function terminalCharacterWidth(character: string): number {
  const point = character.codePointAt(0) ?? 0
  if (point === 0 || point < 32 || (point >= 0x7f && point < 0xa0)) return 0
  return point >= 0x1100 &&
    (point <= 0x115f ||
      point === 0x2329 ||
      point === 0x232a ||
      (point >= 0x2e80 && point <= 0xa4cf) ||
      (point >= 0xac00 && point <= 0xd7a3) ||
      (point >= 0xf900 && point <= 0xfaff) ||
      (point >= 0xfe10 && point <= 0xfe19) ||
      (point >= 0xfe30 && point <= 0xfe6f) ||
      (point >= 0xff00 && point <= 0xff60) ||
      (point >= 0xffe0 && point <= 0xffe6) ||
      (point >= 0x1f300 && point <= 0x1faff))
    ? 2
    : 1
}
