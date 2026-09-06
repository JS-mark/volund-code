// Skills 面板契约已迁至 @volund/app-runtime（P1-04c）；re-export 保持既有引用兼容。
export {
  collapseSkillInvocation,
  skillsListCommandView,
  skillsPanelStatusText,
} from '@volund/app-runtime'
export type {
  CollapsedSkillInvocation,
  SkillsPanelController,
  SkillsPanelEntry,
  SkillsPanelEntryStatus,
} from '@volund/app-runtime'
