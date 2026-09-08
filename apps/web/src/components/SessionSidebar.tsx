'use client'

/**
 * 侧栏：搜索 + 会话分组列表。
 * - 「+」下拉：新建对话 / 新建分组（capability 未接线时只有新建对话）；
 * - 有用户分组时按分组展示（用户分组按创建序，未分组殿后），分组可折叠；
 * - 每个分组默认展示 5 条，「更多」每次再加载 5 条；
 * - 会话条目 ⋯ 菜单可把会话移动到其他分组；
 * - 无用户分组时退化为平铺全量列表（不截断历史）；搜索时平铺展示匹配项。
 */
import {
  CommentOutlined,
  DownOutlined,
  EllipsisOutlined,
  FolderAddOutlined,
  PlusOutlined,
  RightOutlined,
  SearchOutlined,
} from '@ant-design/icons'
import type { MenuProps } from 'antd'
import type { InputRef } from 'antd'
import { App, Button, Dropdown, Empty, Input, Modal, Typography } from 'antd'
import { useMemo, useState } from 'react'

import type { SessionGroup, SessionGroupsView, SessionSummary, WebApi } from '../lib/api'
import type { SidebarGroup } from '../lib/session-groups'
import { buildSidebarGroups, nextVisibleCount, visibleCount } from '../lib/session-groups'

interface SessionSidebarProps {
  api: WebApi
  sessions: readonly SessionSummary[]
  groups: SessionGroupsView
  /** bootstrap capability.sessionGroups：未接线时隐藏分组入口、平铺展示。 */
  groupingEnabled: boolean
  activeId: string | undefined
  /** 「最近会话」弹层的管理入口聚焦此搜索框。 */
  searchRef?: React.Ref<InputRef>
  onSelect(id: string): void
  onNewChat(): void
  onGroupsChanged(): void
}

/** 会话条目的时间副标：HH:MM。 */
function timeLabel(updatedAt: string): string {
  const time = Date.parse(updatedAt)
  if (Number.isNaN(time)) return ''
  const date = new Date(time)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

type NameModal = { mode: 'create' } | { mode: 'rename'; group: SessionGroup } | null

export function SessionSidebar(props: SessionSidebarProps) {
  const { api, groupingEnabled, groups, sessions, activeId } = props
  const { message } = App.useApp()
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [visibleCounts, setVisibleCounts] = useState<Record<string, number>>({})
  const [nameModal, setNameModal] = useState<NameModal>(null)
  const [nameValue, setNameValue] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<SessionGroup | null>(null)

  const searching = query.trim().length > 0
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return sessions
    return sessions.filter(
      (session) => session.title.toLowerCase().includes(needle) || session.id.includes(needle),
    )
  }, [sessions, query])

  const sidebarGroups = useMemo(() => buildSidebarGroups(filtered, groups), [filtered, groups])
  // 平铺模式：搜索中 / 分组能力未接线 / 还没有任何用户分组（不截断历史）。
  const flat = searching || !groupingEnabled || groups.groups.length === 0

  const groupOf = (sessionId: string): string | null => groups.assignments[sessionId] ?? null

  const runOp = async (op: () => Promise<unknown>, success: string) => {
    try {
      await op()
      message.success(success)
      props.onGroupsChanged()
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const submitNameModal = async () => {
    if (!nameModal) return
    const name = nameValue.trim()
    if (!name) return
    if (nameModal.mode === 'create') await runOp(() => api.createSessionGroup(name), '分组已创建')
    else await runOp(() => api.renameSessionGroup(nameModal.group.id, name), '分组已重命名')
    setNameModal(null)
  }

  const moveMenu = (session: SessionSummary): MenuProps => ({
    items: [
      {
        key: 'move',
        label: '移动到分组',
        children: [
          { key: 'move:', label: '未分组', disabled: groupOf(session.id) === null },
          ...groups.groups.map((group) => ({
            key: `move:${group.id}`,
            label: group.name,
            disabled: groupOf(session.id) === group.id,
          })),
        ],
      },
    ],
    onClick: ({ key, domEvent }) => {
      domEvent.stopPropagation()
      if (!key.startsWith('move:')) return
      const groupId = key.slice('move:'.length) || null
      void runOp(
        () => api.assignSessionGroup(session.id, groupId),
        groupId ? '已移动会话' : '已移回未分组',
      )
    },
  })

  const renderItem = (session: SessionSummary) => (
    <div
      key={session.id}
      className={session.id === activeId ? 'sg-item sg-item-active' : 'sg-item'}
      onClick={() => props.onSelect(session.id)}
    >
      <div className="sg-avatar">V</div>
      <div className="sg-item-text">
        <Typography.Text strong ellipsis style={{ display: 'block' }}>
          {session.title}
        </Typography.Text>
        <Typography.Text type="secondary" style={{ fontSize: 11 }}>
          {timeLabel(session.updatedAt)} · {session.cwd.split('/').pop() ?? session.cwd}
        </Typography.Text>
      </div>
      {groupingEnabled && (
        <Dropdown trigger={['click']} placement="bottomRight" menu={moveMenu(session)}>
          <Button
            className="sg-item-menu"
            type="text"
            size="small"
            icon={<EllipsisOutlined />}
            onClick={(event) => event.stopPropagation()}
          />
        </Dropdown>
      )}
    </div>
  )

  const renderGroup = (group: SidebarGroup) => {
    const isCollapsed = collapsed[group.key] === true
    const visible = visibleCount(visibleCounts[group.key], group.sessions.length)
    const remaining = group.sessions.length - visible
    // 内置「未分组」无管理菜单；用户分组从 view 里取回实体做重命名/删除。
    const source = group.builtin ? undefined : groups.groups.find((g) => g.id === group.key)
    const menu: MenuProps | undefined = source
      ? {
          items: [
            { key: 'rename', label: '重命名分组' },
            { key: 'delete', label: '删除分组', danger: true },
          ],
          onClick: ({ key, domEvent }) => {
            domEvent.stopPropagation()
            if (key === 'rename') {
              setNameValue(source.name)
              setNameModal({ mode: 'rename', group: source })
            } else if (key === 'delete') {
              setDeleteTarget(source)
            }
          },
        }
      : undefined
    return (
      <div className="sg-group" key={group.key}>
        <div
          className="sg-group-header"
          onClick={() => setCollapsed((current) => ({ ...current, [group.key]: !isCollapsed }))}
        >
          {isCollapsed ? (
            <RightOutlined className="sg-caret" />
          ) : (
            <DownOutlined className="sg-caret" />
          )}
          <span className="sg-group-name">{group.name}</span>
          <span className="sg-group-count">{group.sessions.length}</span>
          {menu && (
            <Dropdown trigger={['click']} placement="bottomRight" menu={menu}>
              <Button
                className="sg-item-menu"
                type="text"
                size="small"
                icon={<EllipsisOutlined />}
                onClick={(event) => event.stopPropagation()}
              />
            </Dropdown>
          )}
        </div>
        {!isCollapsed &&
          (group.sessions.length === 0 ? (
            <div className="sg-group-empty">暂无会话，可从会话菜单移入</div>
          ) : (
            <>
              {group.sessions.slice(0, visible).map(renderItem)}
              {remaining > 0 && (
                <Button
                  type="link"
                  size="small"
                  className="sg-more"
                  onClick={() =>
                    setVisibleCounts((current) => ({
                      ...current,
                      [group.key]: nextVisibleCount(current[group.key], group.sessions.length),
                    }))
                  }
                >
                  更多（还有 {remaining} 条）
                </Button>
              )}
            </>
          ))}
      </div>
    )
  }

  const showEmpty =
    filtered.length === 0 && sidebarGroups.every((group) => group.sessions.length === 0)

  return (
    <>
      <div style={{ display: 'flex', gap: 8, padding: '10px 10px 6px' }}>
        <Input
          ref={props.searchRef}
          allowClear
          prefix={<SearchOutlined />}
          placeholder="搜索会话"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <Dropdown
          trigger={['click']}
          placement="bottomRight"
          menu={{
            items: [
              { key: 'chat', label: '新建对话', icon: <CommentOutlined /> },
              ...(groupingEnabled
                ? [{ key: 'group', label: '新建分组', icon: <FolderAddOutlined /> }]
                : []),
            ],
            onClick: ({ key }) => {
              if (key === 'chat') props.onNewChat()
              else if (key === 'group') {
                setNameValue('')
                setNameModal({ mode: 'create' })
              }
            },
          }}
        >
          <Button icon={<PlusOutlined />} title="新建对话 / 新建分组" />
        </Dropdown>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 8px 8px' }}>
        {showEmpty ? (
          <Empty
            description={searching ? '没有匹配的会话' : '暂无历史会话'}
            style={{ marginTop: 32 }}
          />
        ) : flat ? (
          filtered.map(renderItem)
        ) : (
          sidebarGroups.map(renderGroup)
        )}
      </div>
      <Modal
        title={nameModal?.mode === 'rename' ? '重命名分组' : '新建分组'}
        open={nameModal !== null}
        okText={nameModal?.mode === 'rename' ? '保存' : '创建'}
        cancelText="取消"
        okButtonProps={{ disabled: !nameValue.trim() }}
        onCancel={() => setNameModal(null)}
        onOk={() => void submitNameModal()}
        destroyOnHidden
      >
        <Input
          autoFocus
          placeholder="分组名称（1-60 字符）"
          value={nameValue}
          maxLength={60}
          onChange={(event) => setNameValue(event.target.value)}
          onPressEnter={(event) => {
            event.preventDefault()
            void submitNameModal()
          }}
        />
      </Modal>
      <Modal
        title="删除分组"
        open={deleteTarget !== null}
        okText="删除"
        okButtonProps={{ danger: true }}
        cancelText="取消"
        onCancel={() => setDeleteTarget(null)}
        onOk={() => {
          if (!deleteTarget) return
          void (async () => {
            await runOp(() => api.deleteSessionGroup(deleteTarget.id), '分组已删除')
            setDeleteTarget(null)
          })()
        }}
      >
        {deleteTarget && (
          <Typography.Text>
            删除分组「{deleteTarget.name}」？组内会话会移回「未分组」，会话本身不受影响。
          </Typography.Text>
        )}
      </Modal>
    </>
  )
}
