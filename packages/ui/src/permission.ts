// 权限交互契约与 PermissionPromptController 已迁至 @volund/app-runtime
// （§22.7.1 / Web P1-03：审批队列是 TUI 卡片与 Web 全局队列的共用原语）；
// 此处 re-export 保持既有引用兼容。
export {
  PermissionPromptController,
  type InteractivePermissionDecision,
  type InteractivePermissionDecisionKind,
  type InteractivePermissionRequest,
  type PermissionPromptListener,
} from '@volund/app-runtime'
