// oxlint-disable typescript/no-unsafe-type-assertion -- marked v18 unions every
// Token with the loosely-typed Tokens.Generic, defeating switch narrowing; the
// per-case casts below are the sanctioned way to recover precise token types.
import { Box, Text } from 'ink'
import { Marked, type Token, type Tokens, type TokenizerAndRendererExtension } from 'marked'
import { useMemo, type ReactNode } from 'react'
import stringWidth from 'string-width'

/**
 * TeX math is recognized but rendered as styled source — a terminal cannot
 * typeset formulas, so `$...$`/`$$...$$` delimiters are stripped and the
 * LaTeX body shown in italic magenta to read as "formula", not raw noise.
 * Inline math refuses `$$`, leading/trailing spaces, and `$` in the body so
 * currency like "$5 to $10" stays plain text.
 */
const blockMathExtension: TokenizerAndRendererExtension = {
  name: 'blockMath',
  level: 'block',
  start(src: string) {
    const index = src.indexOf('$$')
    return index === -1 ? undefined : index
  },
  tokenizer(src: string) {
    const match = /^\$\$([\s\S]+?)\$\$/.exec(src)
    if (match) {
      return { type: 'blockMath', raw: match[0], text: (match[1] ?? '').trim() }
    }
    return undefined
  },
}

const inlineMathExtension: TokenizerAndRendererExtension = {
  name: 'inlineMath',
  level: 'inline',
  start(src: string) {
    const index = src.indexOf('$')
    return index === -1 ? undefined : index
  },
  tokenizer(src: string) {
    const match = /^\$(?!\$)(?!\s)([^$\n]+?)(?<!\s)\$/.exec(src)
    if (match) {
      return { type: 'inlineMath', raw: match[0], text: (match[1] ?? '').trim() }
    }
    return undefined
  },
}

const marked = new Marked({ extensions: [blockMathExtension, inlineMathExtension] })

export interface MarkdownTextProps {
  children: string
}

/**
 * Minimal markdown renderer for assistant messages: marked's lexer turns model
 * output into tokens, which we map onto Ink text styles (bold, italic, code
 * color, list markers) instead of showing raw `**` glyphs. Kept dependency-
 * light on purpose — ink-markdown and friends shell out to marked-terminal,
 * which `require()`s ink and cannot load under ESM-only ink 7.
 */
export function MarkdownText({ children }: MarkdownTextProps) {
  const tokens = useMemo(() => lex(children), [children])
  if (!tokens) {
    return <Text wrap="wrap">{children}</Text>
  }
  // Blank lines only matter between blocks — drop edge spacing so a message
  // neither starts nor ends with empty rows.
  let first = 0
  let last = tokens.length
  while (first < last && tokens[first]?.type === 'space') first += 1
  while (last > first && tokens[last - 1]?.type === 'space') last -= 1
  return <Box flexDirection="column">{tokens.slice(first, last).map(renderBlock)}</Box>
}

function lex(markdown: string): Token[] | null {
  try {
    return marked.lexer(markdown)
  } catch {
    return null
  }
}

function renderBlock(token: Token, key: number): ReactNode {
  switch (token.type) {
    case 'paragraph': {
      const paragraph = token as Tokens.Paragraph
      return (
        <Text key={key} wrap="wrap">
          {renderInline(paragraph.tokens)}
        </Text>
      )
    }
    case 'heading': {
      const heading = token as Tokens.Heading
      return (
        <Text key={key} bold wrap="wrap">
          {renderInline(heading.tokens)}
        </Text>
      )
    }
    case 'code': {
      const code = token as Tokens.Code
      return (
        <Box key={key} marginLeft={2}>
          <Text backgroundColor="blackBright" color="whiteBright" wrap="wrap">
            {formatCodeBlock(code.text)}
          </Text>
        </Box>
      )
    }
    case 'blockMath': {
      const math = token as Tokens.Generic & { text?: string }
      return (
        <Box key={key} marginLeft={2}>
          <Text italic color="magenta" wrap="wrap">
            {math.text}
          </Text>
        </Box>
      )
    }
    case 'space':
      return <Box key={key} height={1} />
    case 'hr':
      return (
        <Text key={key} dimColor>
          {'─'.repeat(32)}
        </Text>
      )
    case 'blockquote': {
      const quote = token as Tokens.Blockquote
      return (
        <Box key={key}>
          <Text dimColor>{'│ '}</Text>
          <Box flexDirection="column" flexGrow={1}>
            {quote.tokens.map(renderBlock)}
          </Box>
        </Box>
      )
    }
    case 'list':
      return renderList(token as Tokens.List, key)
    case 'table':
      return renderTable(token as Tokens.Table, key)
    case 'html': {
      const html = token as Tokens.HTML
      return (
        <Text key={key} dimColor wrap="wrap">
          {html.text}
        </Text>
      )
    }
    case 'text': {
      const text = token as Tokens.Text
      return (
        <Text key={key} wrap="wrap">
          {text.tokens ? renderInline(text.tokens) : text.text}
        </Text>
      )
    }
    default:
      return null
  }
}

/**
 * Pads every line to the block's widest display width so the background color
 * paints a solid rectangle instead of a ragged edge. Display width, not code
 * units — code may contain CJK too.
 */
export function formatCodeBlock(code: string): string {
  const lines = code.replace(/\n$/, '').split('\n')
  const width = Math.max(0, ...lines.map((line) => stringWidth(line)))
  return lines.map((line) => line + ' '.repeat(Math.max(0, width - stringWidth(line)))).join('\n')
}

function renderList(list: Tokens.List, key: number): ReactNode {
  const start = Number(list.start) || 1
  return (
    <Box key={key} flexDirection="column">
      {list.items.map((item, i) => {
        const marker = item.task
          ? item.checked
            ? '[x]'
            : '[ ]'
          : list.ordered
            ? `${start + i}.`
            : '•'
        return (
          <Box key={i}>
            <Box flexShrink={0} width={marker.length + 1}>
              <Text dimColor>{marker}</Text>
            </Box>
            <Box flexDirection="column" flexGrow={1}>
              {item.tokens.map(renderBlock)}
            </Box>
          </Box>
        )
      })}
    </Box>
  )
}

function renderTable(table: Tokens.Table, key: number): ReactNode {
  const lines = formatTable(table)
  return (
    <Box key={key} flexDirection="column">
      <Text bold wrap="wrap">
        {lines.header}
      </Text>
      <Text dimColor>{lines.separator}</Text>
      {lines.rows.map((row, i) => (
        <Text key={i} wrap="wrap">
          {row}
        </Text>
      ))}
    </Box>
  )
}

/**
 * Pure table formatter, exported for tests: pads cells by terminal display
 * width (not code-unit length — CJK glyphs occupy two columns, so `.length`
 * misaligns every Chinese/Japanese table) and honors `---:`/`---` alignment.
 */
export function formatTable(table: Tokens.Table): {
  header: string
  separator: string
  rows: string[]
} {
  const rows = [table.header, ...table.rows]
  const widths = table.header.map((_, col) =>
    Math.max(...rows.map((row) => (row[col] ? stringWidth(row[col].text) : 0))),
  )
  const pad = (text: string, col: number): string => {
    const gap = Math.max(0, (widths[col] ?? 0) - stringWidth(text))
    const align = table.align[col]
    if (align === 'right') return ' '.repeat(gap) + text
    if (align === 'center') {
      const left = Math.floor(gap / 2)
      return ' '.repeat(left) + text + ' '.repeat(gap - left)
    }
    return text + ' '.repeat(gap)
  }
  const line = (cells: Tokens.TableCell[]) =>
    cells.map((cell, col) => pad(cell.text, col)).join(' │ ')
  return {
    header: line(table.header).trimEnd(),
    separator: widths.map((w) => '─'.repeat(w)).join('─┼─'),
    rows: table.rows.map((row) => line(row).trimEnd()),
  }
}

function renderInline(tokens: Token[] | undefined): ReactNode[] {
  if (!tokens) return []
  return tokens.map((token, i) => {
    switch (token.type) {
      case 'strong':
        return (
          <Text key={i} bold>
            {renderInline((token as Tokens.Strong).tokens)}
          </Text>
        )
      case 'em':
        return (
          <Text key={i} italic>
            {renderInline((token as Tokens.Em).tokens)}
          </Text>
        )
      case 'del':
        return (
          <Text key={i} strikethrough>
            {renderInline((token as Tokens.Del).tokens)}
          </Text>
        )
      case 'codespan':
        return (
          <Text key={i} color="yellow">
            {(token as Tokens.Codespan).text}
          </Text>
        )
      case 'inlineMath':
        return (
          <Text key={i} italic color="magenta">
            {(token as Tokens.Generic & { text?: string }).text}
          </Text>
        )
      case 'link': {
        const link = token as Tokens.Link
        const label = renderInline(link.tokens)
        if (link.href && link.href !== link.text) {
          return (
            <Text key={i}>
              <Text color="cyan" underline>
                {label}
              </Text>{' '}
              <Text dimColor>({link.href})</Text>
            </Text>
          )
        }
        return (
          <Text key={i} color="cyan" underline>
            {label}
          </Text>
        )
      }
      case 'image': {
        const image = token as Tokens.Image
        return (
          <Text key={i} dimColor>
            [image: {image.text || image.href}]
          </Text>
        )
      }
      case 'br':
        return <Text key={i}>{'\n'}</Text>
      case 'text': {
        const text = token as Tokens.Text
        return text.tokens ? renderInline(text.tokens) : text.text
      }
      default:
        return 'raw' in token ? token.raw : null
    }
  })
}
