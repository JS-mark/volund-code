# ADR 0014: Project memory identity binds to the git root

Status: Accepted

Date: 2026-10-10

## Context

`projectId` was `sha256(cwd)` — the raw working directory string. In a monorepo, running
volund from `repo/packages/app` produced a different project identity than `repo`, so
project-scoped memories saved at the root were invisible from subpackages and vice versa,
even though AGENT.md discovery treats the repository as one hierarchy. Memories are exact-
match data (ADR-0010 fail-closed), so the identity has to be chosen well rather than widened.

## Decision

`memoryProjectId(cwd)` now hashes the resolved **project root**: the nearest ancestor
directory (including cwd itself) containing `.git` — a directory, or a worktree pointer
file. The upward search mirrors AGENT.md discovery: at most 8 levels, never crossing the
user's home boundary; outside a git repository the fallback is cwd itself, so non-git
directories keep per-directory identities. Results are memoized per cwd for the process.

The storage layout follows the identity: current-project records live at
`<projectRoot>/.volund/memory/*.md` (previously `<cwd>/.volund/memory`), so a monorepo has
one `.volund/memory` at its root shared by all subpackages. Session scope inherits the same
resolution through its embedded projectId. Fail-closed exact matching is unchanged.

## Consequences

Monorepo subpackages share one project memory pool anchored at the repository root, which
matches how users think about a repository. Existing records keyed by the old per-directory
hash stay in `~/.volund/memory/projects/<old-hash>/` (not lost, but no longer matched);
pre-release data volume makes migration unnecessary. A repository moved or reopened through
a different root path changes identity — same as before, now anchored at the root rather
than the invocation directory. Worktrees are distinct identities, consistent with
`git rev-parse --show-toplevel`.
