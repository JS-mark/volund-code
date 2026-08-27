# Contributing to volund Code

Thanks for your interest in volund Code! This document is the operational
guide for contributors. **The design source of truth is the spec directory
[`docs/superpowers/specs/2026-07-31-volund-code-design/`](docs/superpowers/specs/2026-07-31-volund-code-design/)
(split into `01`–`14` section files + `SANDBOX-COMPAT-r1.md`) and the engineering
conventions in [`AGENT.md`](AGENT.md).** Please read both before contributing
non-trivial changes.

## Table of contents

- [Ways to contribute](#ways-to-contribute)
- [Prerequisites](#prerequisites)
- [Setup](#setup)
- [Branching model](#branching-model)
- [Making a change](#making-a-change)
- [RFC process](#rfc-process)
- [Coding conventions](#coding-conventions)
- [Commit messages & DCO](#commit-messages--dco)
- [Tests](#tests)
- [Docs](#docs)
- [Reviewing & merging](#reviewing--merging)
- [License](#license)

## Ways to contribute

- **Bug reports** — open an issue with the bug template. Attach the output of
  `volund doctor` and reproduction steps.
- **Bug fixes** — small fixes can go directly to a PR; larger fixes should
  reference an issue.
- **New features** — open an RFC issue first (see [RFC process](#rfc-process)).
- **Documentation** — direct PRs welcome.
- **Providers** — v1 provider adapters live in this repo; propose new ones
  via RFC first.
- **Plugins / Skills** — please keep out-of-tree and publish to npm under the
  `volund-plugin-*` / `volund-skill-*` naming convention. The docs site
  will link a curated registry (see spec §13.2 `/plugins`).

## Prerequisites

- Node **20+** (LTS)
- pnpm **9+** (managed via `packageManager` in `package.json`)
- Rust **1.80+** (for native crates)
- Recommended: `gh` CLI, VS Code with `rust-analyzer` + `Vitest` extension

Platform requirements: macOS 13+, Linux (glibc 2.31+), or Windows 10 22H2+.

## Setup

```bash
gh repo clone <owner>/volund-code
cd volund-code
pnpm install          # installs JS deps + downloads Rust toolchain (if managed)
pnpm build            # builds all TS packages + Rust native addons
pnpm test             # runs vitest across the workspace
pnpm dev              # runs volund CLI with hot rebuild
```

Native builds land in `packages/native-bridge`. When editing Rust code, run
`pnpm build:native` before re-running the CLI.

## Branching model

Branching evolves with the project's milestone (see design spec `§10`):

- **MVP phase (L1 — L2)** — trunk-based:
  - `main` — the only long-lived branch. Protected on GitHub.
  - Topic branches — `feat/xxx`, `fix/yyy`, `docs/zzz`, `refactor/aaa`, etc.
    Rebase-merge (or squash-merge) onto `main` when green.
  - Single maintainer (BDFL), fast iteration; a separate `next` branch adds
    coordination overhead without benefit.
- **From L3 onward (plugin / MCP ecosystem live)**:
  - `main` — released code. Protected. Only maintainers merge here.
  - `next` — pre-release / integration branch. Breaking changes and RFC
    landings target `next` first, cut into `main` via release PR.
  - Topic branches — as above.

The current phase is documented in the project README's **Status** badge; if
you are unsure, target `main` and a maintainer will re-target if needed.

## Making a change

1. Fork or create a topic branch off `main` (or `next` from L3 onward — see
   above).
2. Follow the [engineering conventions in AGENT.md](AGENT.md) §4-§9. Do not
   cross the §4 boundary rules — those are strong constraints.
3. Add or update tests (see [Tests](#tests)).
4. Update docs / spec / changelog when relevant.
5. Commit with Conventional Commits + DCO sign-off (see below).
6. Open a PR against the current integration branch; fill in the PR template.
7. Ensure CI is green.
8. A maintainer will review; address feedback; squash-merge on approval.

If the change touches:

- **Public API** (any `packages/*-kit`) — bump docs, run `pnpm docs:gen:api`.
- **CLI surface** — regenerate CLI reference: `pnpm docs:gen:cli`.
- **§4 boundary rules** or **security model** — RFC required.
- **Rust native code** — CI matrix must pass on all 8 native targets
  (6 platform combinations × arm64/x64, plus 2 Linux musl variants; see spec
  §5.9 / SANDBOX-COMPAT §S1).

## RFC process

Open an issue with the `RFC` label using the RFC template for any change that:

- Affects the public API of any `packages/*-kit`
- Adds or removes a `packages/*` / `crates/*` / `platforms/*`
- Changes a §4 boundary rule in AGENT.md
- Changes the permission or sandbox model
- Introduces a new provider or transport
- Changes credential storage or telemetry defaults

Discussion happens in the issue. Maintainers close the RFC with a decision
after a **7-day cooling period** (unless it's a fast-track fix). Approved RFCs
become tracking issues for implementation PRs.

## Coding conventions

- **TypeScript**: strict, ESM, latest LTS. Enforced by ESLint + Prettier.
  Run `pnpm lint --fix` before pushing.
- **Rust**: `cargo fmt` + `cargo clippy -- -D warnings`.
- **Imports**: type-only imports for cross-boundary types
  (see AGENT.md §4.1).
- **File layout**: one exported symbol per file where reasonable; kebab-case
  filenames.
- **No `process.exit(1)`** outside `apps/cli` entry.
- **No `console.log`** in committed code (use the logger).
- **No `undici` / global `fetch`** in business code — always go through
  `packages/http-kit`.
- **No API-key reads** outside `packages/auth`.
- See CLAUDE.md §C4 for the full "禁止事项" list.

## Commit messages & DCO

We use **Conventional Commits** with **Developer Certificate of Origin**
sign-off (no CLA).

Format:

```
<type>(<scope>): <subject>

<body>

Signed-off-by: Your Name <your.email@example.com>
```

Types: `feat` `fix` `docs` `refactor` `test` `chore` `ci` `build` `perf`
`revert` `style`.

Scopes: `core`, `runner`, `cli`, `ui`, `provider-anthropic`, `tool-fs`,
`native-bridge`, `plugin-runtime`, `skills-runtime`, `mcp-client`, `storage`,
`auth`, `http-kit`, `docs`, `spec`, `deps`, etc.

To sign off automatically:

```bash
git commit -s -m "feat(core): add PromptComposer"
```

Every commit must be signed off. Our DCO GitHub App will fail PRs missing
sign-offs; use `git rebase --signoff HEAD~N` to fix.

## Tests

- **Unit**: colocated `*.test.ts` next to source in each package.
- **Integration**: `packages/*/test/integration/` or `apps/cli/test/`.
- **E2E**: `apps/cli/test/e2e/` — real subprocess + real filesystem in tmp.
- **Rust**: `cargo test` per crate.
- Add tests for every bug fix (regression test).
- Add tests for every new feature (behavior spec).

Run:

```bash
pnpm test                    # workspace-wide
pnpm --filter @volund/core test
pnpm test:e2e
cargo test --workspace       # Rust
```

## Docs

- Design changes go in `docs/superpowers/specs/*.md` (per spec §13.2).
- User-facing docs go in `apps/docs/` (VitePress).
- Changelog entries are managed by **changesets** — run `pnpm changeset` when
  your PR needs a release note.

## Reviewing & merging

- Every PR needs at least one maintainer approval.
- CI must be green (ts × 3 platforms + Rust × 8 native targets + 8 sandbox-escape jobs).
- Squash-merge is the default; keep the final message Conventional Commits
  compliant.
- Do not force-push after a review starts unless requested.

## License

By contributing you agree to license your work under **Apache License 2.0**
(via DCO sign-off). See [LICENSE](LICENSE).

## Community

- GitHub Issues — bug reports and RFCs
- GitHub Discussions — questions and ideas
- Discord — coming with the first public release

Please follow our [Code of Conduct](CODE_OF_CONDUCT.md).
