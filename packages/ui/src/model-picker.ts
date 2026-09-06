// SubmitOptions 契约已迁至 @volund/app-runtime（§22.7.1：TUI/Web 共用）；
// 上游新增的 SubmitAttachment 类型定义在 @volund/shared。此处 re-export
// 保持既有引用兼容。
export type { SubmitOptions } from '@volund/app-runtime'
export type { SubmitAttachment } from '@volund/shared'

export interface ModelPickerOption {
  description?: string
  disabled?: boolean
  id: string
  label: string
  model: string
  provider: string
}

export interface ModelPickerState {
  currentModelId: string
  models: readonly ModelPickerOption[]
}
