# ADR 0010: Memory core runtime and persistence

Status: Accepted

## Context

Memory needs one durable model shared by later CRUD, recall, CLI, and TUI work. Direct filesystem access from those consumers would duplicate scope and recovery rules.

## Decision

`@volund/storage` owns the versioned `MemoryRecord`, the service/repository/policy ports, and a local atomic-snapshot repository. Records carry an explicit workspace, project, or session scope; provenance, normalized tags, pin state, timestamps, and a soft-delete timestamp. Scope equality is fail-closed at every read and mutation.

The local adapter writes a temporary file, fsyncs it, rotates the last valid snapshot to `.bak`, atomically renames the temporary file, and fsyncs the directory. Startup falls back to the backup after a corrupt or interrupted primary write. Schema dispatch is centralized in the loader so future versions can add migrations without leaking persistence details into the service.

The production CLI composition root creates exactly one `MemoryService` and exposes it through `VolundPorts`. A successful mutation is durable before it resolves; `flush()` remains the explicit shutdown boundary and waits for queued writes.

CRUD consumers share that service's stable contract: create is idempotent for an identical caller-supplied id, delete/pin/unpin are idempotent, `updatedAt` is the optimistic-concurrency token, and list cursors encode the immutable `(createdAt, id)` ordering key. Invalid cursors and stale updates return stable `memory_validation` and `memory_conflict` errors.

Every create and content update passes an unconditional built-in `memory.preWrite` guard before any in-memory or durable mutation. It rejects invalid Unicode, oversized content, obvious secrets, and unsafe identifiers. An injected policy hook can impose additional restrictions but cannot replace or disable the built-in guard; a veto leaves the prior snapshot untouched.

The production tool registry exposes `Memory.create/get/list/update/delete/pin/unpin`. Tool schemas do not accept workspace, project, or session identifiers: the adapter derives them from the trusted tool context, then delegates all behavior to the shared service. This keeps model parameters from widening scope and avoids a second CRUD implementation.

## Consequences

Later CLI and TUI interfaces depend only on `MemoryService`. The first schema uses JSON snapshots for deterministic recovery and migration; indexing and external synchronization remain separate adapters and are intentionally out of scope.
