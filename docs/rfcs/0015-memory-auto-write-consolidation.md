# ADR 0015: Memory writes auto-allow and end-of-session consolidation

Status: Accepted

Date: 2026-10-12

## Context

Industry comparison (Claude Code auto-memory, Gemini CLI `save_memory`, Codex Memories)
showed two gaps: every tool in that space writes memories without a permission prompt
(memory directories are the agent's own territory, protected by content guards), and the
mature tools consolidate sessions automatically rather than relying solely on in-session
model initiative. Volund denied `Memory.*` writes outright in non-interactive runs and
prompted once per session interactively, and nothing was written unless the model chose
to during the conversation.

## Decision

**Write auto-allow.** `PermissionManager.autoAllow` grants `allow-session` to every
`Memory.`-prefixed tool before any prompt would be raised, in all permission modes.
Explicit deny rules still win (they short-circuit in `request()` before auto-allow), and
the `Memory.` namespace cannot collide with MCP (`mcp__server__tool`) or plugin
(`plugin:name:tool`) tool names. The unconditional preWrite guard (64 KiB, secret veto,
Unicode) remains the content safety boundary.

**End-of-session consolidation.** The process exit path (bin.ts, after stdout flush,
25 s budget; SIGINT/SIGTERM hard exits skip it) calls `ports.consolidateMemory()`, which
distills the last active session into at most 3 new memories via one provider call
(`consolidateSessionMemory` in app-runtime). Gates: at least 2 user/assistant messages
and 200 transcript characters — short one-off commands never trigger a model call.
`VOLUND_MEMORY_AUTO_CONSOLIDATE=0|false` disables the pass. The extraction prompt
receives existing memory summaries for deduplication and the scope rule; every item goes
through `Memory.create` with `provenance: agent / memory-consolidation`, so guard vetoes,
validation failures, malformed model output, and provider errors are silently skipped.
Failures never delay exit.

## Consequences

Memory writing becomes invisible in both interactive and one-shot runs — the
"Permission denied for Memory.create" class of failures disappears. Sessions now leave
durable traces without the model remembering to write; the cost is one bounded provider
call per qualifying session exit (skippable by env). Consolidated memories carry the
same untrusted status as everything else in memory; they can be audited and removed via
the CLI, and their provenance (`memory-consolidation`) makes them filterable with
`--source agent`.
