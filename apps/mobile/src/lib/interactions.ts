'use client'

/**
 * 触摸交互原语：下拉刷新（scrollTop=0 时拉动 → 释放触发）。
 * 纯手势实现（无 antd-mobile 依赖）：阻尼 0.45、阈值 64px、刷新中锁定。
 */
import { useCallback, useEffect, useRef, useState } from 'react'

const DAMPING = 0.45
const TRIGGER_PX = 64
const MAX_PULL = 96

export interface PullToRefreshState {
  /** 当前拉动距离（px，已阻尼；>0 时渲染指示器）。 */
  pull: number
  refreshing: boolean
  /** 释放即刷新的临界提示。 */
  armed: boolean
}

export function usePullToRefresh(
  scrollRef: React.RefObject<HTMLElement | null>,
  onRefresh: () => Promise<void> | void,
): PullToRefreshState {
  const [pull, setPull] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const startY = useRef<number | null>(null)
  const pullRef = useRef(0)
  const refreshingRef = useRef(false)

  const trigger = useCallback(async () => {
    if (refreshingRef.current) return
    refreshingRef.current = true
    setRefreshing(true)
    setPull(0)
    try {
      await onRefresh()
    } finally {
      refreshingRef.current = false
      setRefreshing(false)
    }
  }, [onRefresh])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onStart = (event: TouchEvent) => {
      if (refreshingRef.current || el.scrollTop > 0) return
      startY.current = event.touches[0]?.clientY ?? null
    }
    const onMove = (event: TouchEvent) => {
      if (startY.current === null || refreshingRef.current) return
      const delta = (event.touches[0]?.clientY ?? 0) - startY.current
      if (delta > 0 && el.scrollTop <= 0) {
        const next = Math.min(delta * DAMPING, MAX_PULL)
        pullRef.current = next
        setPull(next)
      } else if (pullRef.current !== 0) {
        pullRef.current = 0
        setPull(0)
        startY.current = null
      }
    }
    const onEnd = () => {
      if (startY.current === null) return
      startY.current = null
      if (pullRef.current >= TRIGGER_PX) void trigger()
      else {
        pullRef.current = 0
        setPull(0)
      }
    }
    el.addEventListener('touchstart', onStart, { passive: true })
    el.addEventListener('touchmove', onMove, { passive: true })
    el.addEventListener('touchend', onEnd, { passive: true })
    el.addEventListener('touchcancel', onEnd, { passive: true })
    return () => {
      el.removeEventListener('touchstart', onStart)
      el.removeEventListener('touchmove', onMove)
      el.removeEventListener('touchend', onEnd)
      el.removeEventListener('touchcancel', onEnd)
    }
  }, [scrollRef, trigger])

  return { pull, refreshing, armed: pull >= TRIGGER_PX }
}
