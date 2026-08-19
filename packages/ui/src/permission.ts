export type InteractivePermissionDecisionKind = 'allow-once' | 'allow-session' | 'deny'

export interface InteractivePermissionDecision {
  kind: InteractivePermissionDecisionKind
}

export interface InteractivePermissionRequest {
  display: {
    approvable: boolean
    spec: string
    toolName: string
  }
  id: string
  attempt: number
  input: unknown
  spec: unknown
  toolName: string
}

interface PendingPermissionRequest {
  request: InteractivePermissionRequest
  resolve(decision: InteractivePermissionDecision): void
}

export type PermissionPromptListener = (requests: readonly InteractivePermissionRequest[]) => void

export class PermissionPromptController {
  readonly #pending: PendingPermissionRequest[] = []
  readonly #listeners = new Set<PermissionPromptListener>()

  subscribe(listener: PermissionPromptListener): () => void {
    this.#listeners.add(listener)
    listener(this.requests())
    return () => this.#listeners.delete(listener)
  }

  request(request: InteractivePermissionRequest): Promise<InteractivePermissionDecision> {
    return new Promise((resolve) => {
      this.#pending.push({ request, resolve })
      this.notify()
    })
  }

  decide(id: string, decision: InteractivePermissionDecision): void {
    const index = this.#pending.findIndex((item) => item.request.id === id)
    if (index < 0) return
    const [pending] = this.#pending.splice(index, 1)
    pending?.resolve(decision)
    this.notify()
  }

  requests(): readonly InteractivePermissionRequest[] {
    return this.#pending.map((item) => item.request)
  }

  private notify(): void {
    const requests = this.requests()
    for (const listener of this.#listeners) listener(requests)
  }
}
