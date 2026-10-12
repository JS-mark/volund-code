# Memory

Volund's memory system lets the agent accumulate durable knowledge across sessions —
user preferences, repository conventions, lessons learned — as **plain markdown files you
can read, edit, version, and commit**. It complements rule files (`AGENT.md` /
`AGENTS.md` / `CLAUDE.md`): rules are **trusted instructions** compiled into the system
prompt; memories are **advisory data** the agent can recall, never instructions.

## What lives where

| Layer | Rule file (trusted) | Memory (advisory data) |
|---|---|---|
| Global | `~/.volund/AGENT.md` (`AGENTS.md` / `CLAUDE.md` also work) | `~/.volund/memory/*.md` |
| Project | `<repo-root>/AGENT.md` per directory, discovered upward | `<repo-root>/.volund/memory/*.md` |
| Session | — | `~/.volund/memory/sessions/*.md` |

Both levels of rule files use the same candidate order — `AGENT.md`, then `AGENTS.md`
(the open convention), then `CLAUDE.md` — first hit per directory wins, so files you
already maintain for Claude Code or Codex work as-is.

Project memory identity is anchored at the **git root** (nearest ancestor with `.git`),
so a monorepo's subpackages share one memory pool at `<repo-root>/.volund/memory/`.
Outside a git repository the identity is the directory itself. Other projects' records
are kept under `~/.volund/memory/projects/<projectId>/`.

A memory directory contains only markdown: one `<YYYY-MM-DD>-<slug>-<id>.md` file per
record (filename is cosmetic — the frontmatter `id` is authoritative) plus an
auto-generated `MEMORY.md` index, one line per record with a first-line summary and
`pinned` / `deleted` markers. The index is rewritten on every write; hand-edits to it
will be overwritten. Machine state (search index, locks, import journal, plugin audit
log) lives in the hidden `.state/` subdirectory.

## Hand-editing memory files

You can drop a file straight into a memory directory:

```markdown
---
schemaVersion: 1
id: pnpm-convention
scope: project
workspaceId: local
pinned: true
---
This repo always uses pnpm, never npm.
```

Only `schemaVersion`, `id`, and `scope` (+ `workspaceId`, `local` in this deployment)
are required; `tags`, `pinned`, `source`, and timestamps are optional. Files that fail
validation are ignored but never deleted. Edits to existing files are picked up by new
sessions; a running session keeps its in-memory snapshot.

## How the agent uses memory

- **Pinned injection** — records with `pinned: true` from all three scopes are compiled
  into the system prompt (narrower scope wins, bounded by line and token budgets). They
  are wrapped in `<untrusted source="memory:pinned">`: the agent treats them as data,
  never as instructions.
- **Autonomous recall** — the model-facing `Memory.recall` tool searches the keyword
  index; `Memory.get` reads full text, `Memory.list` browses. Recall results are
  snippets inside an `<untrusted source="memory:recall">` wrapper.
- **Writing** — `Memory.create` / `Memory.update` / `Memory.delete` / `pin` / `unpin`.
  The agent is instructed to pick scope by who the knowledge belongs to (user-level
  preference → workspace, repository fact → project) and to suggest rule files instead
  of storing reply-format contracts as memory.

Writing memories is a side-effecting operation: the interactive UI asks once per
session (choose "remember for this session" or stronger to stop the prompts), and
non-interactive runs deny it unless a persisted permission rule allows it.

## Rules vs. memories — which file for what

- **Rule files** (`AGENT.md` family): things that must be *obeyed* — reply formats,
  tone contracts, workflow requirements. They are trusted prompt content.
- **Memory**: facts and preferences that should *influence but not bind* — "this repo
  uses pnpm", "the user prefers concise answers". Always advisory.

## CLI

```
volund memory list | get | add | update | delete | pin | unpin | search | doctor | reindex | export | import
```

`search` queries the same local index the agent uses; `doctor` checks store and index
health; `export`/`import` move a versioned JSON archive between machines (memory files
themselves can simply be copied or committed). `volund memory add --scope project
"…" --pinned` is the quickest way to seed a project's memory by hand.

## Storage internals

Every write is atomic per file (temp file → fsync → rename → directory fsync, modes
0600/0700) and serialized across processes by a lock file with stale-owner recovery.
The legacy single-file JSON snapshot (`records.json`) from earlier releases is migrated
to markdown on first open and archived as `records.json.imported`. Soft-deleted records
keep their file with a `deletedAt` frontmatter field.

## Security notes

- Memory content passes an unconditional pre-write guard: oversized content (64 KiB),
  obvious secrets (API keys, OAuth codes), and invalid Unicode are rejected before any
  bytes hit disk; the guard cannot be disabled.
- Memories are advisory data. Neither pinned injection nor recall results can close
  their untrusted wrappers, and imported memory carries no additional authority.
