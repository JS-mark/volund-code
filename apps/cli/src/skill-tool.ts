// Skill 工具/调用文本已迁至 @volund/app-runtime（P1-04c）；re-export 保持既有引用兼容。
export {
  buildSkillInvocationText,
  buildStackedSkillInvocationText,
  createSkillTool,
  mapAllowedTools,
  MAX_SKILL_STACK,
  splitSkillStack,
} from '@volund/app-runtime'
