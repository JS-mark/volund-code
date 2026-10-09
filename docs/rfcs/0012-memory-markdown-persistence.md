# ADR 0012: Memory records persist as markdown files

Status: Accepted

Supersedes the persistence axis of [ADR 0010](./0010-memory-core-runtime.md) (JSON snapshot);
keeps its service, ACL, guard, and tooling decisions intact. Restores the storage layout of
spec §6.12.1/§6.12.2 (2026-10-09 product decision).

## Context

ADR-0010 chose a single JSON snapshot (`~/.volund/memory/records.json`) for deterministic
recovery. That made memory an opaque blob: users could not read, edit, version, or sync
their own memories without the CLI, and project-scoped knowledge could not live beside the
code it describes. The original design (spec §6.12) intended exactly that — human-editable
markdown with frontmatter — and was dropped before implementation. The product decision is
to restore it.

## Decision

`@volund/storage` gains `MarkdownMemoryRepository` (with `MarkdownMemoryLayout`), replacing
the JSON snapshot as the production repository. One `.md` file per record: YAML frontmatter
carries the record metadata (`schemaVersion`, `id`, `scope`, `tags`, `pinned`, timestamps,
`deletedAt`, provenance, attachments); the markdown body after the closing fence is the
record content byte-for-byte.

Directory layout:

- workspace scope → `~/.volund/memory/*.md`
- project scope → `<cwd>/.volund/memory/*.md` for the current project (lives with the
  repository; `.volund/` is gitignored by default so users opt in by un-ignoring), other
  projects under `~/.volund/memory/projects/<projectId>/*.md`
- session scope → `~/.volund/memory/sessions/*.md`

Filenames are `YYYY-MM-DD-<slug>-<id-prefix>.md` and cosmetic: the frontmatter `id` is
authoritative, so renaming or hand-reorganizing files is safe. Writes are atomic per file
(temp file → fsync → rename → directory fsync) with mode 0600/0700. All writers serialize
on the same cross-process lock discipline as the snapshot repository (shared
`memory-file-lock` module, stale-lock recovery, injectable retry budget).

Hand-authored files are first-class: `load()` admits every valid `.md` in the managed
directories; `save()` only writes or removes files it has previously observed, so notes a
user dropped into the directory are never swept away. Files with invalid frontmatter are
skipped (and preserved), not rewritten. Duplicate ids resolve to the newest mtime.

The ADR-0010 JSON snapshot is migrated on first open: records are written out, then the
snapshot is renamed to `records.json.imported` as the archive (its stale `.bak` removed).
Migration is idempotent and crash-safe; a snapshot unreadable together with its `.bak`
fails loud instead of hiding records.

Everything above the repository is unchanged: `MemoryService` semantics (idempotent CRUD,
optimistic concurrency, soft delete), scope ACL fail-closed, unconditional preWrite guards
(64 KiB / secret / Unicode), model tools `Memory.create/get/list/update/delete/pin/unpin`,
the keyword index (content-keyed fingerprints survive the format change), pinned prompt
injection with untrusted wrappers, transfer import/export, and the CLI.

## Consequences

Memory becomes inspectable and editable with any editor; project memories can be committed
to repositories and shared. Crash atomicity is per record rather than per corpus — a crash
mid-mutation can leave one record updated while another is stale, where the JSON snapshot
was all-or-nothing; accepted as the cost of an editable format (the common failure mode, a
crashed process between locks, is still serialized away). Cross-format tools that assumed
one snapshot file must go through the service, which was already the ADR-0010 rule.
