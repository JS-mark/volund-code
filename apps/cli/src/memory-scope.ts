// Memory scope 构造已迁至 @volund/app-runtime（P1-04b）；re-export 保持既有引用兼容。
export {
  LOCAL_MEMORY_WORKSPACE_ID,
  memoryProjectId,
  projectMemoryScope,
  sessionMemoryScope,
  workspaceMemoryScope,
} from '@volund/app-runtime'
