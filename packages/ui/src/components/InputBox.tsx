import { Box, Text, useInput, usePaste } from 'ink'
import { useEffect, useRef, useState } from 'react'

import type { PasteAttachmentResult, StagedAttachmentInfo, SubmitAttachment } from '@volund/shared'
import { attachmentChipLabel, imageChipLabel } from '@volund/shared'

import type { SlashCommand } from '../app'

export interface InputBoxProps {
  disabled?: boolean
  history?: readonly string[]
  initialValue?: string
  /** /paste 命令注入的附件：nonce 变化时作为 chip 插入一次（命令无法直接改输入行）。 */
  injectedAttachment?: { info: StagedAttachmentInfo; nonce: number } | null
  /**
   * §7.5.2 粘贴/拖拽的路径附件：终端 bracketed paste 进来的文本若能解析到
   * 存在的文件（Finder 拷贝 Cmd+V、iTerm2/Warp 拖文件），转成附件 chip。
   * 返回非 'attached' 时原文本原样插入输入行。
   */
  onAttachFilePath?: (path: string) => Promise<PasteAttachmentResult>
  /**
   * §7.5.3 `@` 统一 picker 的文件候选（cwd 相对路径快照，宿主预取）与模型别名。
   * 两者都缺省时 `@` 只是普通字符。
   */
  mentionFiles?: readonly string[]
  mentionModels?: readonly ModelAlias[]
  /** picker 里选中模型别名 → 当轮显式模型覆盖。 */
  onMentionModel?: (model: string) => void
  /** §7.5.2 Ctrl+V：读系统剪贴板并暂存附件，返回 chip / 纯文本 / 空 / 拒绝。 */
  onPasteAttachment?: () => Promise<PasteAttachmentResult>
  onSubmit?: (input: string, attachments?: readonly SubmitAttachment[]) => Promise<void> | void
  placeholder?: string
  slashCommands?: readonly SlashCommand[]
  terminalColumns?: number
}

export interface ModelAlias {
  alias: string
  model: string
}

/** `@` picker 候选：模型别名（⭐ 置顶）+ 文件（📄），前缀过滤。 */
export interface MentionCandidate {
  kind: 'file' | 'model'
  label: string
  value: string
}

/** 行尾 `@query` 触发段：光标在行尾、@ 位于 token 边界（行首或空白后）才算。 */
export function mentionQueryAt(
  value: string,
  cursor: number,
): { at: number; query: string } | undefined {
  if (cursor !== value.length) return undefined
  const match = /(?:^|\s)@([^\s@]*)$/.exec(value.slice(0, cursor))
  if (!match) return undefined
  const query = match[1] ?? ''
  return { at: match.index + (match[0].length - query.length - 1), query }
}

export function mentionCandidates(
  query: string,
  models: readonly ModelAlias[],
  files: readonly string[],
): readonly MentionCandidate[] {
  const q = query.toLowerCase()
  const modelHits = models
    .filter((item) => item.alias.toLowerCase().startsWith(q))
    .map((item) => ({ kind: 'model' as const, label: `⭐ ${item.alias}`, value: item.model }))
  const fileHits = files
    .filter((path) => path.toLowerCase().startsWith(q))
    .map((path) => ({ kind: 'file' as const, label: `📄 ${path}`, value: path }))
  return [...modelHits, ...fileHits].slice(0, 50)
}

/** chip 在输入文本里的占用区间（光标移动/删除按原子 token 跳过或整枚删除）。 */
export interface ChipRange {
  chip: string
  end: number
  start: number
}

export function chipRanges(
  value: string,
  chips: readonly SubmitAttachment[],
): readonly ChipRange[] {
  const ranges: ChipRange[] = []
  for (const { chip } of chips) {
    let from = 0
    for (;;) {
      const start = value.indexOf(chip, from)
      if (start < 0) break
      ranges.push({ chip, end: start + chip.length, start })
      from = start + chip.length
    }
  }
  return ranges.sort((a, b) => a.start - b.start)
}

/** 左移：光标落在 chip 内或紧贴 chip 右缘时整枚跳过。 */
export function cursorLeft(cursor: number, ranges: readonly ChipRange[]): number {
  if (cursor <= 0) return 0
  const covering = ranges.find((range) => cursor > range.start && cursor <= range.end)
  return covering ? covering.start : cursor - 1
}

/** 右移：光标落在 chip 内或紧贴 chip 左缘时整枚跳过。 */
export function cursorRight(cursor: number, length: number, ranges: readonly ChipRange[]): number {
  if (cursor >= length) return length
  const covering = ranges.find((range) => cursor >= range.start && cursor < range.end)
  return covering ? covering.end : cursor + 1
}

export interface EditResult {
  cursor: number
  /** 被整枚删除的 chip（从跟踪表移除一枚同文本条目）。 */
  removedChip?: string
  value: string
}

/** 退格：chip 紧贴光标左侧（可隔一个尾随空格）时整枚删除，否则删前一个字符。 */
export function deleteBackward(
  value: string,
  cursor: number,
  ranges: readonly ChipRange[],
): EditResult {
  if (cursor <= 0) return { cursor, value }
  const leftChip = ranges.find(
    (range) => range.end === cursor || (range.end === cursor - 1 && value[cursor - 1] === ' '),
  )
  if (leftChip)
    return {
      cursor: leftChip.start,
      removedChip: leftChip.chip,
      value: value.slice(0, leftChip.start) + value.slice(cursor),
    }
  return { cursor: cursor - 1, value: value.slice(0, cursor - 1) + value.slice(cursor) }
}

/** 前向删除：光标紧贴 chip 左缘时整枚删除（含一个尾随空格），否则删后一个字符。 */
export function deleteForward(
  value: string,
  cursor: number,
  ranges: readonly ChipRange[],
): EditResult {
  if (cursor >= value.length) return { cursor, value }
  const rightChip = ranges.find((range) => range.start === cursor)
  if (rightChip) {
    const tail = rightChip.end + (value[rightChip.end] === ' ' ? 1 : 0)
    return {
      cursor,
      removedChip: rightChip.chip,
      value: value.slice(0, cursor) + value.slice(tail),
    }
  }
  return { cursor, value: value.slice(0, cursor) + value.slice(cursor + 1) }
}

/** 粘贴文本解引用：去首尾空白、去成对引号、还原 shell 转义（iTerm2 拖文件产生 `\ ` 序列）。 */
export function unquotePastedPath(text: string): string {
  let out = text.trim()
  if (out.length >= 2 && ((out.startsWith("'") && out.endsWith("'")) || (out.startsWith('"') && out.endsWith('"'))))
    out = out.slice(1, -1)
  return out.replace(/\\(.)/g, '$1')
}

/** 单行且像路径（绝对/~/./含分隔符）才值得问宿主是不是文件，避免普通文本白跑一趟。 */
export function looksLikePath(text: string): boolean {
  if (text.length === 0 || text.length > 4096 || text.includes('\n')) return false
  return text.startsWith('/') || text.startsWith('~/') || text.startsWith('./') || text.includes('/')
}

export function InputBox({
  disabled = false,
  history = [],
  initialValue = '',
  injectedAttachment,
  mentionFiles = [],
  mentionModels = [],
  onAttachFilePath,
  onMentionModel,
  onPasteAttachment,
  onSubmit,
  placeholder = 'Type a message',
  slashCommands = [],
  terminalColumns = 80,
}: InputBoxProps) {
  const [cursorVisible, setCursorVisible] = useState(true)
  const [draftBeforeHistory, setDraftBeforeHistory] = useState('')
  const [historyIndex, setHistoryIndex] = useState<number | null>(null)
  const [slashSuggestionIndex, setSlashSuggestionIndex] = useState(0)
  // value 与 cursor 同源更新（光标是 value 的索引，0..value.length）。
  const [input, setInput] = useState({ cursor: initialValue.length, value: initialValue })
  const { cursor, value } = input
  // 输入行里的附件 chip（"[image: a1b2c3d4.png]"）→ 已暂存附件的映射。
  // chip 文本随 value 一起编辑；提交时只带上仍存在于文本里的 chip。
  const [chips, setChips] = useState<readonly SubmitAttachment[]>([])
  // 图片 chip 的顺序编号器：单调递增，不随提交重置（transcript 里可对照第几张图）。
  const imageSequence = useRef(0)
  const ranges = chipRanges(value, chips)
  const suggestions = slashSuggestions(value, slashCommands)
  // §7.5.3 `@` 统一 picker：行尾 token 边界的 @query 触发，⭐ 模型别名置顶 + 📄 文件。
  const mention = mentionQueryAt(value, cursor)
  const [mentionDismissed, setMentionDismissed] = useState(false)
  const [mentionIndex, setMentionIndex] = useState(0)
  const mentionList = mention
    ? mentionCandidates(mention.query, mentionModels, mentionFiles)
    : []
  const mentionOpen = mention !== undefined && !mentionDismissed && mentionList.length > 0
  const showShortcutHint = terminalColumns >= 100

  /** 编辑后顺手清掉文本里已不存在的 chip（光标可以移进文本中间删字符）。 */
  const applyEdit = (next: string, nextCursor: number) => {
    setInput({ cursor: nextCursor, value: next })
    setChips((current) => current.filter((chip) => next.includes(chip.chip)))
  }
  const insertText = (text: string) => {
    setHistoryIndex(null)
    setSlashSuggestionIndex(0)
    setInput((current) => ({
      cursor: current.cursor + text.length,
      value: current.value.slice(0, current.cursor) + text + current.value.slice(current.cursor),
    }))
  }
  const insertChip = (info: StagedAttachmentInfo) => {
    // chip 文本归输入框所有：剪贴板图片（无路径的匿名 blob）按粘贴顺序编号
    // （[image_1]、[image_2]…）；路径附件（拖拽/Finder 拷贝）带 basename。
    const chip =
      info.kind === 'image' && !info.path
        ? imageChipLabel(++imageSequence.current)
        : attachmentChipLabel({ kind: info.kind, ...(info.path ? { path: info.path } : {}) })
    const attachment: SubmitAttachment = { ...info, chip }
    setChips((current) => [...current, attachment])
    setHistoryIndex(null)
    setSlashSuggestionIndex(0)
    setInput((current) => {
      const before = current.value.slice(0, current.cursor)
      const separator = before && !before.endsWith(' ') ? ' ' : ''
      const inserted = `${separator}${chip} `
      return {
        cursor: current.cursor + inserted.length,
        value: before + inserted + current.value.slice(current.cursor),
      }
    })
  }
  const dropChip = (chip: string) =>
    setChips((current) => {
      const index = current.map((entry) => entry.chip).indexOf(chip)
      return index < 0 ? current : current.filter((_, at) => at !== index)
    })

  // /paste 命令注入的附件：nonce 变化时作为 chip 插入一次。
  const lastInjectionNonce = useRef(0)
  useEffect(() => {
    if (!injectedAttachment || injectedAttachment.nonce === lastInjectionNonce.current) return
    lastInjectionNonce.current = injectedAttachment.nonce
    insertChip(injectedAttachment.info)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- insertChip 是纯插入动作
  }, [injectedAttachment])

  useEffect(() => {
    if (disabled) return undefined
    const timer = setInterval(() => setCursorVisible((visible) => !visible), 500)
    return () => clearInterval(timer)
  }, [disabled])

  useEffect(() => {
    setCursorVisible(true)
  }, [value])

  useEffect(() => {
    if (suggestions.length === 0) {
      if (slashSuggestionIndex !== 0) setSlashSuggestionIndex(0)
      return
    }
    if (slashSuggestionIndex >= suggestions.length) setSlashSuggestionIndex(suggestions.length - 1)
  }, [slashSuggestionIndex, suggestions.length])

  // picker 候选数变化时收口选中项；文本变动解除 esc 屏蔽。
  useEffect(() => {
    if (mentionIndex >= mentionList.length) setMentionIndex(Math.max(0, mentionList.length - 1))
  }, [mentionIndex, mentionList.length])
  useEffect(() => {
    setMentionDismissed(false)
  }, [value])

  const selectMention = (candidate: MentionCandidate) => {
    if (!mention) return
    const removeQuery = () =>
      setInput((current) => {
        const token = `@${mention.query}`
        const uptoCursor = current.value.slice(0, current.cursor)
        const index = uptoCursor.lastIndexOf(token)
        if (index < 0) return current
        return {
          cursor: index,
          value: current.value.slice(0, index) + current.value.slice(index + token.length),
        }
      })
    if (candidate.kind === 'model') {
      onMentionModel?.(candidate.value)
      removeQuery()
      return
    }
    // 文件候选：走附件暂存（权限门）；宿主不可用时补全为路径文本。
    if (!onAttachFilePath) {
      removeQuery()
      insertText(`${candidate.value} `)
      return
    }
    void onAttachFilePath(candidate.value).then((result) => {
      if (result.kind === 'attached') {
        removeQuery()
        insertChip(result.attachment)
      } else {
        removeQuery()
        insertText(`${candidate.value} `)
      }
    })
  }

  // §7.5.2：bracketed paste（Cmd+V 文本/文件路径、拖拽文件）走独立事件通道，
  // 整段一次到达——多行文本原样插入不触发提交；能解析成文件的路径转附件 chip。
  // 空粘贴事件（onEmptyPaste，与 Claude Code 同语义）：用户按了 Cmd+V 而剪贴板
  // 里没有文本表示（图片/文件数据不进 TTY），终端发来零长度的粘贴包裹——此时
  // 主动读系统剪贴板补齐附件。
  usePaste(
    (text) => {
      if (disabled) return
      if (text.length === 0) {
        if (!onPasteAttachment) return
        void onPasteAttachment().then((result) => {
          if (result.kind === 'attached') insertChip(result.attachment)
          else if (result.kind === 'text' && result.text) insertText(result.text)
        })
        return
      }
      const candidate = unquotePastedPath(text)
      if (onAttachFilePath && looksLikePath(candidate)) {
        void onAttachFilePath(candidate).then((result) => {
          if (result.kind === 'attached') insertChip(result.attachment)
          else insertText(text)
        })
        return
      }
      insertText(text)
    },
    { isActive: !disabled },
  )

  useInput(
    (keyInput, key) => {
      if (disabled) return
      // §7.5.3 @ picker 打开期间：方向键/Tab/Enter 归 picker，esc 关闭（文本再变动即复活）。
      if (mentionOpen) {
        if (key.upArrow) {
          setMentionIndex((current) =>
            current <= 0 ? mentionList.length - 1 : current - 1,
          )
          return
        }
        if (key.downArrow) {
          setMentionIndex((current) => (current + 1) % mentionList.length)
          return
        }
        if (key.escape) {
          setMentionDismissed(true)
          return
        }
        if (key.tab || key.return || keyInput === '\r' || keyInput === '\n') {
          const candidate = mentionList[mentionIndex]
          if (candidate) selectMention(candidate)
          return
        }
      }
      if (key.upArrow) {
        if (suggestions.length > 0) {
          setSlashSuggestionIndex((current) =>
            current <= 0 ? suggestions.length - 1 : current - 1,
          )
          return
        }
        if (history.length === 0) return
        const nextIndex = historyIndex === null ? history.length - 1 : Math.max(0, historyIndex - 1)
        if (historyIndex === null) setDraftBeforeHistory(value)
        setHistoryIndex(nextIndex)
        setInput({ cursor: (history[nextIndex] ?? '').length, value: history[nextIndex] ?? '' })
        return
      }
      if (key.downArrow) {
        if (suggestions.length > 0) {
          setSlashSuggestionIndex((current) => (current + 1) % suggestions.length)
          return
        }
        if (historyIndex === null) return
        const nextIndex = historyIndex + 1
        if (nextIndex >= history.length) {
          setHistoryIndex(null)
          setInput({ cursor: draftBeforeHistory.length, value: draftBeforeHistory })
        } else {
          setHistoryIndex(nextIndex)
          setInput({ cursor: (history[nextIndex] ?? '').length, value: history[nextIndex] ?? '' })
        }
        return
      }
      if (key.leftArrow) {
        setInput((current) => ({
          ...current,
          cursor: cursorLeft(current.cursor, chipRanges(current.value, chips)),
        }))
        return
      }
      if (key.rightArrow) {
        setInput((current) => ({
          ...current,
          cursor: cursorRight(current.cursor, current.value.length, chipRanges(current.value, chips)),
        }))
        return
      }
      if (key.home || (key.ctrl && keyInput === 'a')) {
        setInput((current) => ({ ...current, cursor: 0 }))
        return
      }
      if (key.end || (key.ctrl && keyInput === 'e')) {
        setInput((current) => ({ ...current, cursor: current.value.length }))
        return
      }
      if (key.ctrl && keyInput === 'c') {
        void onSubmit?.('/exit')
        return
      }
      if ((key.return || keyInput === '\r' || keyInput === '\n') && key.shift) {
        insertText('\n')
        return
      }
      if (key.ctrl && keyInput === 'v') {
        // §7.5.2：Ctrl+V 读系统剪贴板（截图等不进 bracketed paste 的内容）。
        // 图片/文件 → 暂存并插入原子 chip；纯文本 → 原样插入；空/拒绝/不可用
        // 安静返回（反馈消息由 app 层的包装回调负责）。
        if (!onPasteAttachment) return
        void onPasteAttachment().then((result) => {
          if (result.kind === 'attached') insertChip(result.attachment)
          else if (result.kind === 'text') insertText(result.text)
        })
        return
      }
      if (key.return || keyInput === '\r' || keyInput === '\n') {
        const selectedSuggestion = suggestions[slashSuggestionIndex]
        const submitted = selectedSuggestion ? `/${selectedSuggestion.name}` : value
        if (!submitted.trim()) return
        // 只有仍在文本里的 chip 才随提交展开；同一附件重复粘贴（内容寻址，
        // chip 相同）按 handle/path 去重，避免给 provider 发重复图片。
        const active = chips.filter((chip) => submitted.includes(chip.chip))
        const seen = new Set<string>()
        const attachments = active.filter((chip) => {
          const key = chip.handle ?? chip.path ?? chip.chip
          if (seen.has(key)) return false
          seen.add(key)
          return true
        })
        setHistoryIndex(null)
        setDraftBeforeHistory('')
        setSlashSuggestionIndex(0)
        setInput({ cursor: 0, value: '' })
        setChips([])
        void onSubmit?.(submitted, attachments)
        return
      }
      if (key.backspace) {
        setHistoryIndex(null)
        setSlashSuggestionIndex(0)
        const result = deleteBackward(value, cursor, ranges)
        if (result.removedChip) dropChip(result.removedChip)
        applyEdit(result.value, result.cursor)
        return
      }
      if (key.delete) {
        setHistoryIndex(null)
        setSlashSuggestionIndex(0)
        const result = deleteForward(value, cursor, ranges)
        if (result.removedChip) dropChip(result.removedChip)
        applyEdit(result.value, result.cursor)
        return
      }
      if (key.tab) {
        const selectedSuggestion = suggestions[slashSuggestionIndex]
        if (selectedSuggestion) {
          const completed = `/${selectedSuggestion.name} `
          setInput({ cursor: completed.length, value: completed })
        }
        return
      }
      if (key.ctrl || key.meta || key.escape) return
      if (keyInput) insertText(keyInput)
    },
    { isActive: !disabled },
  )

  return (
    <Box
      borderBottom
      borderColor={disabled ? 'gray' : 'cyan'}
      borderLeft={false}
      borderRight={false}
      borderStyle="single"
      borderTop
      paddingX={1}
      width="100%"
    >
      <Box flexDirection="column" width="100%">
        <Box justifyContent="space-between">
          <Box flexShrink={1}>
            <Text color={disabled ? 'gray' : 'green'}>{'> '}</Text>
            {value ? (
              cursor >= value.length ? (
                <>
                  <Text>{value}</Text>
                  <Text color={disabled ? 'gray' : 'cyan'}>{cursorVisible ? '▌' : ' '}</Text>
                </>
              ) : value[cursor] === '\n' ? (
                <>
                  {/* 光标落在换行符上：反色空格占位，换行本身照常渲染 */}
                  <Text>{value.slice(0, cursor)}</Text>
                  <Text inverse> </Text>
                  <Text>{value.slice(cursor)}</Text>
                </>
              ) : (
                <>
                  {/* 文本中间的光标：反色当前字符（不闪烁、不引起后续文本位移） */}
                  <Text>{value.slice(0, cursor)}</Text>
                  <Text inverse>{value[cursor]}</Text>
                  <Text>{value.slice(cursor + 1)}</Text>
                </>
              )
            ) : (
              <>
                <Text color={disabled ? 'gray' : 'cyan'}>{cursorVisible ? '▌' : ' '}</Text>
                <Text color="gray">{placeholder}</Text>
              </>
            )}
          </Box>
          {showShortcutHint ? (
            <Text color="gray">
              {onPasteAttachment
                ? 'Enter send / Shift+Enter newline / Ctrl+V paste image'
                : 'Enter send / Shift+Enter newline'}
            </Text>
          ) : null}
        </Box>
        {mentionOpen ? (
          <Box flexDirection="column" marginLeft={2} marginTop={1}>
            {/* @ picker：与 slash 建议同款滚动窗口（10 行），⭐ 模型置顶、📄 文件随后。 */}
            {mentionList
              .map((candidate, index) => ({ candidate, index }))
              .slice(
                Math.min(
                  Math.max(0, mentionIndex - (SLASH_SUGGESTION_WINDOW - 1)),
                  Math.max(0, mentionList.length - SLASH_SUGGESTION_WINDOW),
                ),
                Math.min(
                  Math.max(0, mentionIndex - (SLASH_SUGGESTION_WINDOW - 1)),
                  Math.max(0, mentionList.length - SLASH_SUGGESTION_WINDOW),
                ) + SLASH_SUGGESTION_WINDOW,
              )
              .map(({ candidate, index }) => {
                const active = index === mentionIndex
                return (
                  <Text color={active ? 'cyan' : 'gray'} key={`${candidate.kind}:${candidate.value}`}>
                    {active ? '> ' : '  '}
                    {candidate.label}
                  </Text>
                )
              })}
          </Box>
        ) : null}
        {suggestions.length > 0 ? (
          <Box flexDirection="column" marginLeft={2} marginTop={1}>
            {/*
              高度预算 10 行，但完整候选可能更多（内置 10 个 + 插件命令）：
              渲染跟随选中项的滚动窗口，方向键在完整列表上循环。
            */}
            {suggestions
              .map((command, index) => ({ command, index }))
              .slice(
                Math.min(
                  Math.max(0, slashSuggestionIndex - (SLASH_SUGGESTION_WINDOW - 1)),
                  Math.max(0, suggestions.length - SLASH_SUGGESTION_WINDOW),
                ),
                Math.min(
                  Math.max(0, slashSuggestionIndex - (SLASH_SUGGESTION_WINDOW - 1)),
                  Math.max(0, suggestions.length - SLASH_SUGGESTION_WINDOW),
                ) + SLASH_SUGGESTION_WINDOW,
              )
              .map(({ command, index }) => {
                const active = index === slashSuggestionIndex
                return (
                  <Text color={command.available === false ? 'gray' : 'cyan'} key={command.name}>
                    {active ? '> ' : '  '}/{command.name} {command.description}
                    {command.available === false ? ' (not available)' : ''}
                  </Text>
                )
              })}
          </Box>
        ) : null}
      </Box>
    </Box>
  )
}

const SLASH_SUGGESTION_WINDOW = 10

function slashSuggestions(value: string, commands: readonly SlashCommand[]) {
  if (!value.startsWith('/') || value.includes(' ')) return []
  const prefix = value.slice(1).toLowerCase()
  // 不在此处截断：完整候选交给渲染侧按选中项滚动（slice 会把插件命令挡在窗外）。
  return commands.filter((command) => command.name.toLowerCase().startsWith(prefix))
}
