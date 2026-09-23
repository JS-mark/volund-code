/**
 * 诊断日志环形缓冲：手机上没有 devtools，远程问题（连不上/上下文丢失/无法中断）
 * 靠「我的」页把最近的诊断日志捞出来复制给维护者。条目同时镜像到 console.debug
 * （接电脑时可直接看）。容量有界（300 条），不落盘——页面刷新即清，够排一次障。
 */
export interface DiagEntry {
  readonly t: number
  readonly tag: string
  readonly message: string
}

const CAP = 300
const entries: DiagEntry[] = []

export function diag(tag: string, message: string): void {
  entries.push({ t: Date.now(), tag, message })
  if (entries.length > CAP) entries.splice(0, entries.length - CAP)
  console.debug(`[diag:${tag}] ${message}`)
}

export function diagEntries(): readonly DiagEntry[] {
  return [...entries]
}

/** 全量导出（时间 ISO 格式），供复制/贴给维护者。 */
export function diagDump(): string {
  return entries
    .map((entry) => `${new Date(entry.t).toISOString()} [${entry.tag}] ${entry.message}`)
    .join('\n')
}

export function diagClear(): void {
  entries.length = 0
}
