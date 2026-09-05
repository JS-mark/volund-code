// 权限 SafeDisplay 渲染器已迁至 @volund/app-runtime（§22.7.1 / P1-05：
// SafeDisplay 属 UI-neutral 边界，Web 审批卡片复用同一实现）；re-export 保持兼容。
export {
  formatPermissionTextForDisplay,
  formatPermissionValueForDisplay,
} from '@volund/app-runtime'
export type { PermissionDisplayResult } from '@volund/app-runtime'
