import { Box, Text, useInput } from 'ink'
import { useEffect, useMemo, useState } from 'react'

export interface SelectListItem {
  description?: string
  disabled?: boolean
  id: string
  label: string
  selected?: boolean
}

export interface SelectListProps {
  activeId?: string
  disabledBehavior?: 'focusable' | 'skip'
  items: readonly SelectListItem[]
  onActiveChange?: (id: string) => void
  onCancel?: () => void
  onSubmit?: (id: string) => void
  title?: string
  visibleItems?: number
}

export function SelectList({
  activeId,
  disabledBehavior = 'skip',
  items,
  onActiveChange,
  onCancel,
  onSubmit,
  title,
  visibleItems = 8,
}: SelectListProps) {
  const enabledItems = useMemo(() => items.filter((item) => !item.disabled), [items])
  const initialId = activeId ?? enabledItems[0]?.id ?? items[0]?.id
  const [currentId, setCurrentId] = useState(initialId)

  useEffect(() => {
    if (activeId) setCurrentId(activeId)
  }, [activeId])

  const currentIndex = Math.max(
    0,
    items.findIndex((item) => item.id === currentId),
  )
  const halfWindow = Math.floor(visibleItems / 2)
  const start = Math.max(0, Math.min(currentIndex - halfWindow, items.length - visibleItems))
  const visible = items.slice(start, start + visibleItems)

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) {
      onCancel?.()
      return
    }
    if (key.return || input === '\r' || input === '\n') {
      const item = items.find((candidate) => candidate.id === currentId)
      if (item && !item.disabled) onSubmit?.(item.id)
      return
    }
    if (!key.upArrow && !key.downArrow) return
    const nextId = nextSelectableId(items, currentId, key.downArrow ? 1 : -1, disabledBehavior)
    if (!nextId) return
    setCurrentId(nextId)
    onActiveChange?.(nextId)
  })

  return (
    <Box flexDirection="column">
      {title ? (
        <Text bold color="cyan">
          {title}
        </Text>
      ) : null}
      {visible.map((item) => {
        const active = item.id === currentId
        const content = `${active ? '> ' : '  '}${item.selected ? '* ' : '  '}${item.label}${
          item.description ? `  ${item.description}` : ''
        }`
        if (item.disabled && active)
          return (
            <Text color="yellow" key={item.id}>
              {content}
            </Text>
          )
        if (item.disabled)
          return (
            <Text color="gray" key={item.id}>
              {content}
            </Text>
          )
        if (active)
          return (
            <Text color="cyan" key={item.id}>
              {content}
            </Text>
          )
        return <Text key={item.id}>{content}</Text>
      })}
      {items.length > visible.length ? (
        <Text color="gray">
          Showing {start + 1}-{start + visible.length} of {items.length}
        </Text>
      ) : null}
    </Box>
  )
}

function nextSelectableId(
  items: readonly SelectListItem[],
  currentId: string | undefined,
  step: 1 | -1,
  disabledBehavior: 'focusable' | 'skip',
) {
  if (items.length === 0) return undefined
  const currentIndex = Math.max(
    0,
    items.findIndex((item) => item.id === currentId),
  )
  for (let offset = 1; offset <= items.length; offset += 1) {
    const index = (currentIndex + offset * step + items.length) % items.length
    const item = items[index]
    if (item && (disabledBehavior === 'focusable' || !item.disabled)) return item.id
  }
  return undefined
}
