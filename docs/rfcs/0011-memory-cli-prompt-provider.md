# ADR 0011: Memory CLI and bounded pinned prompt provider

Status: Accepted

## Context

The durable Memory service from ADR 0010 needs a scriptable user interface and a safe way to supply selected records to `PromptComposer`. Reimplementing CRUD or scope checks in either consumer would drift from the model tools. Injecting stored text directly into the system prompt would also let hostile imported data imitate trusted instructions and could grow the prompt without bound.

## Decision

`volund memory list|get|add|update|delete|pin|unpin` delegates every operation to the production `MemoryService`. CLI scope names map to the same workspace/project identities as model tools. List filters include scope, tag, provenance source, pinned state, limit, and stable cursor. Management JSON is one `schemaVersion: 1` document; text and JSON formatters sanitize secrets and omit ANSI. Exit codes are fixed at 0 for success, 2 for validation/confirmation, 3 for not found, and 13 for scope denial. Delete requires an interactive confirmation or explicit `--yes` in non-TTY, JSON, and no-TUI operation.

`MemoryPromptProvider` registers the priority-950 memory guide and priority-700 pinned fragment. It loads visible session, project, and workspace pins through the same service and policy, prefers narrower scopes, removes normalized content duplicates, sorts deterministically, and enforces both line and estimated-token budgets. Record bodies and boundary-sensitive markup are escaped inside `<untrusted source="memory:pinned">` wrappers. They remain advisory data below current system and user instructions.

The Memory service exposes a change observer. Successful create, update, delete, pin, and unpin operations invalidate `memory:pinned` in the composer, so the next provider request reflects durable state without restarting. Observer failures cannot roll back or misreport an already durable mutation.

## Consequences

CLI users and model tools share one persistence, validation, redaction, concurrency, and ACL contract. Pinned prompt size stays constant across long conversations. Imported prompt-injection strings cannot close the untrusted wrapper, and deleted or unpinned content disappears on the next composition. The default token estimator is intentionally conservative and injectable so a provider-specific tokenizer can replace it later without changing provider ordering or safety boundaries.
