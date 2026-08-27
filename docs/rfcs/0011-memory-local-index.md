# ADR 0011: Local memory recall index and recovery

Status: Accepted

## Context

Memory keyword recall must remain fast without turning a derived search structure into a second source of truth. A crash can occur after the fact snapshot is durable but before its index update, and a damaged index must never endanger or broaden access to durable memory records.

## Decision

`@volund/storage` defines separate `MemoryIndex`, `MemoryIndexMaintenance`, `MemoryRecallService`, and `MemoryMaintenanceService` ports. `LocalKeywordMemoryIndex` stores schema version 1, a unique generation, a source fingerprint, source update tokens, and normalized keyword frequencies. It stores no complete memory body. The adapter performs no network or embedding calls.

`IndexingMemoryService` is the production `MemoryService`. It writes a dirty marker before each fact mutation, persists the fact through the existing atomic repository, incrementally upserts or removes the returned full record, then clears the marker. Startup compares the index fingerprint with all active facts and safely rebuilds a missing, dirty, stale, or corrupt index.

Recall treats index output only as candidates. Every candidate is fetched through `MemoryService.get(scope, id)`, rejected when absent, deleted, unauthorized, or based on an outdated `updatedAt`, then tag-filtered and limited. The fact repository and its existing policy therefore remain authoritative even when an old backup index is used during recovery.

Reindex reads all facts, takes an exclusive cross-process lock, prepares documents in bounded batches, fsyncs a temporary snapshot, and atomically publishes a new generation. The previous generation stays available until publication succeeds. A failed or interrupted build leaves it untouched. `force` may remove only a stale lock; a live lock is never stolen. `check` and Doctor only read facts, markers, and index metadata.

## Consequences

Index loss is recoverable and fact loss is not coupled to index health. Incremental updates make normal CRUD immediately searchable; the dirty marker and fingerprint close crash windows. Keyword scoring is deterministic and local. Future semantic adapters may implement the same ports, but external embeddings or network synchronization require separate explicit authorization.
