/** 路由层小工具：错误响应 / 冲突 / 分页参数。 */

export const jsonError = (message: string, status: number) =>
  Response.json({ error: message }, { status })

export class ConflictError extends Error {}

export interface Pagination {
  readonly page: number
  readonly pageSize: number
}

export function parsePagination(url: URL): Pagination {
  const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1)
  const rawSize = Number(url.searchParams.get('pageSize') ?? '20') || 20
  return { page, pageSize: Math.min(50, Math.max(1, rawSize)) }
}

export const matchesQuery = (fields: readonly (string | undefined)[], query: string) =>
  !query || fields.some((field) => field?.toLowerCase().includes(query))

/** 更新时间倒序（字符串 ISO 时间可直接字典序比较）。 */
export const byRecency = (a: { updatedAt?: string; addedAt?: string }, b: typeof a) => {
  const key = (item: typeof a) => item.updatedAt ?? item.addedAt ?? ''
  return (b.updatedAt ?? b.addedAt ?? '').localeCompare(key(a))
}
