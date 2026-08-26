import { Box, Text, useInput } from 'ink'
import { useEffect, useState } from 'react'

import type { SlashCommand } from '../app'

export interface InputBoxProps {
  disabled?: boolean
  history?: readonly string[]
  initialValue?: string
  onSubmit?: (input: string) => Promise<void> | void
  placeholder?: string
  slashCommands?: readonly SlashCommand[]
  terminalColumns?: number
}

export function InputBox({
  disabled = false,
  history = [],
  initialValue = '',
  onSubmit,
  placeholder = 'Type a message',
  slashCommands = [],
  terminalColumns = 80,
}: InputBoxProps) {
  const [cursorVisible, setCursorVisible] = useState(true)
  const [draftBeforeHistory, setDraftBeforeHistory] = useState('')
  const [historyIndex, setHistoryIndex] = useState<number | null>(null)
  const [slashSuggestionIndex, setSlashSuggestionIndex] = useState(0)
  const [value, setValue] = useState(initialValue)
  const suggestions = slashSuggestions(value, slashCommands)
  const showShortcutHint = terminalColumns >= 100

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

  useInput(
    (input, key) => {
      if (disabled) return
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
        setValue(history[nextIndex] ?? '')
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
          setValue(draftBeforeHistory)
        } else {
          setHistoryIndex(nextIndex)
          setValue(history[nextIndex] ?? '')
        }
        return
      }
      if (key.ctrl && input === 'c') {
        void onSubmit?.('/exit')
        return
      }
      if ((key.return || input === '\r' || input === '\n') && key.shift) {
        setValue((current) => `${current}\n`)
        return
      }
      if (key.return || input === '\r' || input === '\n') {
        const selectedSuggestion = suggestions[slashSuggestionIndex]
        const submitted = selectedSuggestion ? `/${selectedSuggestion.name}` : value
        if (!submitted.trim()) return
        setHistoryIndex(null)
        setDraftBeforeHistory('')
        setSlashSuggestionIndex(0)
        setValue('')
        void onSubmit?.(submitted)
        return
      }
      if (key.backspace || key.delete) {
        setHistoryIndex(null)
        setSlashSuggestionIndex(0)
        setValue((current) => current.slice(0, -1))
        return
      }
      if (key.tab) {
        const selectedSuggestion = suggestions[slashSuggestionIndex]
        if (selectedSuggestion) setValue(`/${selectedSuggestion.name} `)
        return
      }
      if (key.ctrl || key.meta || key.escape) return
      if (input) {
        setHistoryIndex(null)
        setSlashSuggestionIndex(0)
        setValue((current) => current + input)
      }
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
              <>
                <Text>{value}</Text>
                <Text color={disabled ? 'gray' : 'cyan'}>{cursorVisible ? '▌' : ' '}</Text>
              </>
            ) : (
              <>
                <Text color={disabled ? 'gray' : 'cyan'}>{cursorVisible ? '▌' : ' '}</Text>
                <Text color="gray">{placeholder}</Text>
              </>
            )}
          </Box>
          {showShortcutHint ? <Text color="gray">Enter send / Shift+Enter newline</Text> : null}
        </Box>
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
