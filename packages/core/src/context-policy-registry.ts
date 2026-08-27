import type {
  ContextCtx,
  ContextPolicy,
  ContextPolicyContributor,
  ContextPolicyRegistration,
  ContextPolicySpec,
} from '@volund/provider-kit'

export class ContextPolicyRegistry implements ContextPolicyContributor {
  readonly #policies = new Map<string, ContextPolicySpec>()
  contributePolicy(spec: ContextPolicySpec): ContextPolicyRegistration {
    if (!spec.name.trim() || spec.policy.name !== spec.name)
      throw new Error('Context policy name must match its registration')
    if (this.#policies.has(spec.name))
      throw new Error(`Context policy already registered: ${spec.name}`)
    this.#policies.set(spec.name, Object.freeze({ ...spec }))
    let disposed = false
    return {
      dispose: () => {
        if (!disposed) this.#policies.delete(spec.name)
        disposed = true
      },
    }
  }
  select(context: ContextCtx, name?: string): ContextPolicy {
    if (name) {
      const selected = this.#policies.get(name)
      if (!selected) throw new Error(`Unknown context policy: ${name}`)
      return selected.policy
    }
    const selected = [...this.#policies.values()]
      .filter((item) => item.when?.(context) ?? true)
      .sort((a, b) => b.priority - a.priority)[0]
    if (!selected) throw new Error('No context policy is available')
    return selected.policy
  }
}
