# L1 release readiness audit

Audit date: 2026-08-01
Audited revision: `c6e155dcaa5e631096c341126f5489657900fac8` (`main`)
Checklist: `docs/superpowers/specs/2026-07-31-volund-code-design/RELEASE-CHECKLIST-L1.md`

## Decision

**Not release-ready and not published.** The merged implementation is a useful
foundation, but the L1 checklist's automated, security, manual, packaging, and
sign-off gates are not all satisfied. No npm publication or Git tag was
performed by this audit.

The four lifecycle states must not be conflated:

| State | Result | Evidence |
| --- | --- | --- |
| Implemented | Partial | Stage 1/2 implementation is on `main`; the gaps below remain. |
| Accepted | Partial | Local TS/Rust checks and three native escape targets passed; the complete checklist did not. |
| Merged | Yes, for Stage 1/2 | APO-3 through APO-8 implementation PRs are merged into the audited revision. |
| Published | No | No tag or npm publication evidence exists, and this audit did not publish. |

## Independently rerun evidence

| Gate | Result | Detail |
| --- | --- | --- |
| Lockfile | Pass | `pnpm install --frozen-lockfile` |
| TypeScript | Pass | `pnpm turbo run typecheck test build --force`: 48/48 tasks, 0 cached; 66 tests passed. |
| Rust | Pass | `cargo test --workspace`: 9 tests passed; `cargo check --workspace` and `cargo build --workspace` passed. |
| Local sandbox probe | Partial | macOS arm64 reported tier `partial`, `sandbox_init: true`, with non-hostname-granular network allowlists as a known limitation. |
| Local escape fixture | Pass | `bash crates/volund-sandbox/tests/escape/run.sh target/debug/volund-sandbox`. |
| License | CI pass; local unverified | Main workflow run `30699640748` passed `cargo deny check licenses bans`. Local Cargo 1.71 cannot install current cargo-deny because it lacks Rust 2024-edition support. |
| Doctor strict | Fail | Native platform packages and Anthropic credential are unavailable in the audit environment; config and cwd checks pass. |
| Anthropic dog-food | Blocked | No credential is present. No secret was requested, logged, or written. |

Main revision CI evidence:

- Native workflow run `30699640748` passed license, bwrap reproducibility, three native targets, and one aarch64 Linux cross-build marked `partial-verified`.
- Escape workflow run `30699640737` passed macOS arm64, macOS x64, and Linux x64 native fixtures. Linux arm64 only cross-built; its escape execution step was skipped.

## Checklist disposition

| Checklist area | Status | Reason |
| --- | --- | --- |
| §0 Definition of Done | Blocked | No real Anthropic read/edit/test/PR dog-food; four-target escape execution is incomplete. |
| §1 CI gates | Blocked | No three-OS TS job or four-target doctor job; Linux arm64 escape is not executed. |
| §2–§8 runtime/security | Partial | Existing tests pass, but not every mandatory checklist scenario has mapped evidence; `provider-kit` and `tool-kit` currently have no tests. |
| §9 build/distribution | Blocked | CLI uses multi-file `tsc`, not Rolldown `dist/volund.js`; no `platforms/` packages or 12 optional native dependencies; no universal2 `lipo` job. |
| §10 CLI | Partial | Unit tests pass; four-target strict doctor and complete command/onboarding evidence are absent. |
| §11 onboarding | Partial | Automated shell tests do not establish all manual onboarding gates. |
| §12 completion/sign-off | Blocked | Docs site, dog-food, target release metrics, npm publication, and BDFL/security approval are absent. |

## Tracked remediation

- APO-14: runtime/checklist mandatory implementation and evidence.
- APO-12: CI, native/escape, and platform distribution gates.
- APO-13: real Anthropic dog-food, documentation, release notes, and human sign-off.

These issues are parked in backlog. They must be completed and independently
re-audited before changing this decision to release-ready.

