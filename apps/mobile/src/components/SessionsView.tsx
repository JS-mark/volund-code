'use client'

/**
 * 会话列表：下拉刷新（手势拉动 → 释放触发）+ 上拉分页（客户端切片，
 * 触底增量显示）+ 首屏骨架。会话清单数据源一次全量返回，分页是渲染侧
 * 的窗口化——长列表 DOM 数量有界。
 */
import { MessageOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons'
import { Button, Empty, Skeleton, Tag, Typography } from 'antd'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { SessionSummary } from '../lib/gateway'
import { usePullToRefresh } from '../lib/interactions'

const PAGE_SIZE = 20
/** 触底提前量（px）：距底 48px 即触发追加。 */
const LOAD_MORE_THRESHOLD_PX = 48

function timeLabel(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const now = new Date()
  const sameDay = date.toDateString() === now.toDateString()
  return sameDay
    ? date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
}

function SessionRow({
  session,
  active,
  onSelect,
}: {
  session: SessionSummary
  active: boolean
  onSelect(): void
}) {
  return (
    <div
      className={`session-item${active ? ' active' : ''}`}
      onClick={onSelect}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => event.key === 'Enter' && onSelect()}
    >
      <MessageOutlined style={{ fontSize: 18, color: '#1677ff', flexShrink: 0 }} />
      <div className="session-item-main">
        <div className="session-item-title">
          {active && (
            <Tag color="blue" style={{ fontSize: 11, lineHeight: '16px', margin: 0 }}>
              当前
            </Tag>
          )}
          <span className="session-item-name">{session.title || '未命名会话'}</span>
        </div>
        <Typography.Text type="secondary" className="session-item-sub" ellipsis>
          {session.summary || session.cwd}
        </Typography.Text>
      </div>
      <Typography.Text type="secondary" style={{ fontSize: 11, whiteSpace: 'nowrap' }}>
        {timeLabel(session.updatedAt)}
      </Typography.Text>
    </div>
  )
}

function SessionsSkeleton() {
  return (
    <div aria-busy="true" style={{ padding: '4px 10px' }}>
      {Array.from({ length: 6 }, (_, index) => (
        <Skeleton
          key={index}
          active
          title={{ width: '46%' }}
          paragraph={{ rows: 1, width: '72%' }}
          style={{ padding: '14px 0' }}
        />
      ))}
    </div>
  )
}

export function SessionsView({
  sessions,
  loading,
  activeId,
  onRefresh,
  onResume,
  onNewChat,
}: {
  sessions: SessionSummary[]
  /** 首次加载（骨架屏）；刷新由下拉手势承担。 */
  loading: boolean
  activeId: string | undefined
  onRefresh(): Promise<void> | void
  onResume(id: string): void
  onNewChat(): void
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)
  const [loadingMore, setLoadingMore] = useState(false)
  const { pull, refreshing, armed } = usePullToRefresh(scrollRef, onRefresh)

  // 新数据到来（刷新后清单变短等）收敛显示窗口。
  useEffect(() => {
    setVisibleCount((count) => Math.min(count, Math.max(PAGE_SIZE, sessions.length)))
  }, [sessions.length])

  const visible = useMemo(() => sessions.slice(0, visibleCount), [sessions, visibleCount])
  const hasMore = visibleCount < sessions.length

  const onScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el || loadingMore) return
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - LOAD_MORE_THRESHOLD_PX && hasMore) {
      setLoadingMore(true)
      // 追加走异步边界 + 短暂间隔：给触底一个可见的加载反馈（渲染侧切片本身瞬时）。
      setTimeout(() => {
        setVisibleCount((count) => Math.min(count + PAGE_SIZE, sessions.length))
        setLoadingMore(false)
      }, 220)
    }
  }, [hasMore, loadingMore, sessions.length])

  return (
    <div className="sessions-wrap">
      <div
        className="pull-indicator"
        data-state={refreshing ? 'refreshing' : armed ? 'armed' : pull > 0 ? 'pulling' : 'idle'}
      >
        <span className="pull-spinner">{refreshing ? '⏳' : armed ? '↑' : '↓'}</span>
        <span>{refreshing ? '刷新中…' : armed ? '释放刷新' : pull > 0 ? '下拉刷新' : ''}</span>
      </div>
      <div style={{ display: 'flex', gap: 8, padding: '4px 10px 10px' }}>
        <Button block icon={<PlusOutlined />} onClick={onNewChat}>
          新会话
        </Button>
        <Button icon={<ReloadOutlined />} loading={refreshing} onClick={() => void onRefresh()} />
      </div>
      <div className="session-scroll" ref={scrollRef} onScroll={onScroll}>
        {loading && sessions.length === 0 ? (
          <SessionsSkeleton />
        ) : sessions.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="还没有会话，新建一个开始远程对话"
            style={{ marginTop: 40 }}
          >
            <Button type="primary" icon={<PlusOutlined />} onClick={onNewChat}>
              新建会话
            </Button>
          </Empty>
        ) : (
          <>
            {visible.map((session) => (
              <SessionRow
                key={session.id}
                session={session}
                active={session.id === activeId}
                onSelect={() => onResume(session.id)}
              />
            ))}
            {hasMore ? (
              <div className="load-more">
                {loadingMore ? '加载中…' : `上拉加载更多（${visible.length}/${sessions.length}）`}
              </div>
            ) : (
              sessions.length > PAGE_SIZE && <div className="load-more">已全部加载</div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
