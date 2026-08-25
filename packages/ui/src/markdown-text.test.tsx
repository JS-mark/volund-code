import { PassThrough, Writable } from 'node:stream'

import { render } from 'ink'
import { lexer, type Tokens } from 'marked'
import { createElement } from 'react'
import stringWidth from 'string-width'
import { describe, expect, it } from 'vitest'

import { formatCodeBlock, formatTable, MarkdownText } from './components/MarkdownText'

class MemoryWriteStream extends Writable {
  columns = 80
  rows = 24
  isTTY = false
  output = ''
  _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error) => void) {
    this.output += chunk.toString()
    callback()
  }
}

async function renderMarkdown(markdown: string): Promise<string> {
  const stdout = new MemoryWriteStream()
  const stdin = new PassThrough()
  const instance = render(createElement(MarkdownText, null, markdown), {
    debug: true,
    interactive: false,
    patchConsole: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  })
  await new Promise((resolve) => setTimeout(resolve, 40))
  instance.unmount()
  return stdout.output
}

function gutterColumns(line: string): number[] {
  const positions: number[] = []
  let column = 0
  for (const char of line) {
    if (char === '│') positions.push(column)
    column += stringWidth(char)
  }
  return positions
}

describe('MarkdownText', () => {
  it('renders bold and inline code without literal markdown markers', async () => {
    const output = await renderMarkdown('I am **mimo-v2.5-pro**, via `Anthropic` API.')
    expect(output).not.toContain('**')
    expect(output).not.toContain('`')
    expect(output).toContain('mimo-v2.5-pro')
    expect(output).toContain('Anthropic')
  })

  it('renders list items with bullet markers instead of raw dashes', async () => {
    const output = await renderMarkdown('- one\n- two')
    expect(output).toContain('•')
    expect(output).toContain('one')
    expect(output).toContain('two')
  })

  it('keeps a blank line between paragraphs', async () => {
    const output = await renderMarkdown('first\n\nsecond')
    expect(output).toMatch(/first\r?\n\r?\nsecond/)
  })

  it('renders fenced code blocks without the fences', async () => {
    const output = await renderMarkdown('```ts\nconst a = 1\n```')
    expect(output).not.toContain('```')
    expect(output).toContain('const a = 1')
  })

  it('renders link text with the href alongside', async () => {
    const output = await renderMarkdown('see [docs](https://example.com/docs)')
    expect(output).toContain('docs')
    expect(output).toContain('https://example.com/docs')
  })

  it('aligns CJK table columns by display width', () => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- marked v18 unions every Token with Tokens.Generic; the table fixture is known to lex as a table.
    const table = lexer(
      '| 名字 | 年龄 | 城市 | 职业 |\n| --- | ---: | --- | --- |\n| 张三 | 28 | 北京 | 工程师 |\n| 李四 | 35 | 上海 | 设计师 |',
    )[0] as Tokens.Table
    const lines = formatTable(table)
    const expected = gutterColumns(lines.header)
    expect(gutterColumns(lines.separator.replaceAll('┼', '│'))).toEqual(expected)
    for (const row of lines.rows) {
      expect(gutterColumns(row)).toEqual(expected)
    }
    // `---:` right-aligns the age column.
    expect(lines.rows[0]).toContain('  28')
  })

  it('strips delimiters from inline math', async () => {
    const output = await renderMarkdown('欧拉公式 $e^{i\\pi}+1=0$ 很美')
    expect(output).toContain('e^{i\\pi}+1=0')
    expect(output).not.toContain('$')
  })

  it('strips fences from block math and keeps following paragraph spacing', async () => {
    const output = await renderMarkdown('$$\n\\int_0^1 x^2 dx\n$$\n\n后文段落')
    expect(output).toContain('\\int_0^1 x^2 dx')
    expect(output).not.toContain('$$')
    expect(output).toMatch(/\n\r?\n后文段落/)
  })

  it('leaves currency-like dollar amounts as plain text', async () => {
    const output = await renderMarkdown('价格在 $5 到 $10 之间')
    expect(output).toContain('$5')
    expect(output).toContain('$10')
  })

  it('pads code block lines to a uniform display width', () => {
    const lines = formatCodeBlock('短\n这是一行比较长的中文行').split('\n')
    expect(new Set(lines.map((line) => stringWidth(line))).size).toBe(1)
  })

  it('renders plain text unchanged', async () => {
    const output = await renderMarkdown('plain text')
    expect(output).toContain('plain text')
  })
})
