# ADR 0013: User-level rules join the AGENT.md family; PROMPT.md retired

Status: Accepted

Date: 2026-10-10

## Context

The user-level prompt file `~/.volund/PROMPT.md` (spec §6.5, priority 400) was a volund-only
name in a landscape where the leading tools already own this space: Claude Code uses
`CLAUDE.md` (project and `~/.claude/CLAUDE.md`), Codex standardized `AGENTS.md` (project and
`~/.codex/AGENTS.md`). Project-level discovery already prefers volund-native `AGENT.md`, then
`AGENTS.md`, then `CLAUDE.md` per directory; the global level was the only place still using
a bespoke filename, and its separate name caused confusion (which file carries rules vs.
memories) plus a real defect: loading it crossed the session permission boundary (fixed in
the same batch — top-level rule files load without a permission prompt).

## Decision

`~/.volund/PROMPT.md` is retired. The global user-level rule file is discovered in
`~/.volund/` with the same candidate order as project directories — `AGENT.md` →
`AGENTS.md` → `CLAUDE.md`, first hit wins, still priority 400, still one file. No migration:
existing PROMPT.md files are ignored (pre-release, single-user surface).

The rules/memories split is unchanged: rule files (project `AGENT.md`/`AGENTS.md`/
`CLAUDE.md`, global under `~/.volund/`) are trusted instructions injected by PromptComposer;
memories (`~/.volund/memory/*.md`, `<cwd>/.volund/memory/*.md`) remain advisory untrusted
data with their own index (`MEMORY.md`, ADR-0012).

## Consequences

One naming family for rules everywhere (project and global), full overlap with what users of
Claude Code/Codex already maintain, and one fewer bespoke file to explain. `@include` inside
global rule files resolves against `~/.volund/` as before (it is inside the include roots).
Model-facing copy (memory guide, `Memory.create` description) now points at `AGENT.md`
instead of `PROMPT.md`.
