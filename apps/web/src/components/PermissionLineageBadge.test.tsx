import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { PermissionLineageBadge } from './PermissionLineageBadge'

/** §2.7bis.5 U4 / §22 W-07：Web 审批卡「子代理 · <agentType>」徽标——lineage 有/无两态。 */
describe('PermissionLineageBadge（Web 审批归属徽标）', () => {
  it('renders 「子代理 · <agentType>」 when lineage carries agentType', () => {
    const html = renderToStaticMarkup(
      <PermissionLineageBadge
        lineage={{ sessionId: 'sub-1', agentType: 'explore', parentTurnId: 'turn-3' }}
      />,
    )
    expect(html).toContain('子代理 · explore')
  })

  it('renders bare 「子代理」 when lineage has no agentType', () => {
    const html = renderToStaticMarkup(<PermissionLineageBadge lineage={{ sessionId: 'sub-2' }} />)
    expect(html).toContain('子代理')
    expect(html).not.toContain('子代理 ·')
  })

  it('renders nothing for main-agent requests（无 lineage 回归面）', () => {
    const html = renderToStaticMarkup(<PermissionLineageBadge lineage={undefined} />)
    expect(html).toBe('')
  })
})
