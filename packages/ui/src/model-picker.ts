import type { SubmitAttachment } from '@volund/shared'

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

export interface SubmitOptions {
  /** §7.5.2：输入行 chip 对应的已暂存附件；提交时展开成 image/file ContentPart。 */
  attachments?: readonly SubmitAttachment[]
  model?: string
}
