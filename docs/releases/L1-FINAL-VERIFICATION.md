# L1 final verification runbook

Status: **PROCEDURE ONLY — L1 remains blocked and not published.**

This runbook defines how to turn a specific release candidate into auditable L1
acceptance evidence. It is not proof that a step ran. Record results only in the
linked evidence files after independently checking the underlying artifact.

## Roles and separation of duties

| Role | Responsibility | Must not do |
| --- | --- | --- |
| Candidate owner | Freeze the revision and package set; coordinate fixes | Change the candidate after evidence collection without restarting affected phases |
| Dog-food operator | Use an authorized Anthropic account in a private interactive terminal | Paste credentials, prompts containing secrets, or sensitive file content into issues or logs |
| Evidence reviewer | Re-run commands and validate links, hashes, target identity, and redaction | Accept screenshots or prose in place of machine-readable output where durable output exists |
| Security signer | Review sandbox, permissions, credential handling, telemetry, and residual risks | Infer runtime isolation from a successful build |
| BDFL signer | Accept or reject product readiness and residual risks | Treat implementation, acceptance, merge, publication, and release as equivalent states |
| Publisher | Publish only the explicitly authorized package/version/tag set | Publish from an unverified revision or before both human decisions exist |

The dog-food operator and at least one evidence reviewer must be different
people. BDFL and security decisions must name the reviewer and date; an agent
cannot manufacture either decision.

## Entry criteria

Do not begin the acceptance run until all items below are true:

- The candidate is the latest intended `main` revision and the worktree is clean.
- Every L1 remediation PR is merged; each linked issue and residual risk has an owner.
- CI can execute the TypeScript matrix and all four L1 native targets:
  `darwin-arm64`, `darwin-x64`, `linux-x64-gnu`, and `linux-arm64-gnu`.
- An authorized operator has configured the Anthropic credential through Volund CLI's
  verified, masked login flow in a private interactive environment.
- Credential values must not appear in shell arguments, environment dumps,
  telemetry exports, screenshots, issue comments, commits, or PR bodies.
- The BDFL and security reviewers have agreed to review the resulting manifest.

If masked login is not connected in the candidate, stop and fix that product gap
in a separate PR. Environment injection, `--skip-verify`, mock providers, and
`--dangerously-no-sandbox` are not acceptance substitutes.

## Phase 1 — Freeze the candidate

From a fresh checkout, record outputs without modifying the repository:

```sh
git fetch origin main
git switch --detach origin/main
git status --short
git rev-parse HEAD
node --version
pnpm --version
rustc --version
cargo --version
```

Acceptance:

- `git status --short` is empty.
- The full 40-character revision is copied to the evidence manifest.
- The candidate version and expected npm package set are recorded.
- Every later artifact, workflow run, and dog-food PR points to this revision or
  explicitly documents the tested descendant revision.

Any candidate change invalidates the affected evidence. Security, auth,
sandbox, provider, permission, CLI, build, or distribution changes require all
later phases to restart.

## Phase 2 — Automated and target evidence

### Repository gates

Run from the frozen candidate:

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
cargo fmt --all -- --check
cargo check --workspace
cargo test --workspace
cargo build --workspace
```

Also run the repository's license, dependency-policy, native distribution, and
documentation contract jobs. Record the exact command, exit code, candidate
revision, and durable CI URL. A local pass does not replace a required target CI
job, and a cross-build does not replace runtime execution.

### Four-target matrix

For each target, record evidence separately:

| Field | Required value |
| --- | --- |
| Target identity | OS, architecture, libc where applicable, OS/kernel version, runner type |
| Artifact identity | Package name/version, archive checksum, source revision |
| Strict doctor | Full sanitized output and exit code from `volund doctor --strict` |
| Sandbox probe | Tier, mechanism, features, known limitations |
| Escape suite | Suite revision, tests passed/total, `escape.pass_ratio`, durable log URL |
| Native workers | Real search/fs/sandbox binaries discovered and exercised |
| Result | `PASS`, `FAIL`, or `UNVERIFIED`; never infer `PASS` from compilation |

Required targets:

- `aarch64-apple-darwin`
- `x86_64-apple-darwin`
- `x86_64-unknown-linux-gnu`
- `aarch64-unknown-linux-gnu`

All four must execute the required runtime and escape checks. A skipped,
cross-built-only, stale, or unverifiable target blocks L1 stable release.

### Evidence integrity and secret scan

- Preserve immutable CI URLs and checksums; do not paste mutable local paths.
- Search tracked files and sanitized evidence for credential patterns before
  upload. Do not print matching secret values to the terminal or CI annotation.
- Confirm telemetry remains local by default and exported payloads are sanitized.
- Record dangerous-mode telemetry tests, but do not use a dangerous mode during
  the acceptance dog-food run.

## Phase 3 — Real Anthropic dog-food

Mock/fake provider runs are **PRE-FLIGHT ONLY**. They may exercise orchestration
and evidence templates, but they must not change `L1-DOGFOOD.md` to `PASS`.

### Select the task

Choose a small, real, reviewable defect in a repository the operator may modify.
Before starting, write down only the public task description and expected test;
do not pre-author the patch. The task must require Volund CLI to:

1. read the relevant source and failing test;
2. propose or perform an edit;
3. request permissions for every write, command, and network side effect;
4. run the focused test and an appropriate regression gate;
5. create a signed commit and open an accessible PR.

### Run conditions

- Start from the frozen Volund CLI candidate and a clean task-repository branch.
- Run `volund doctor --strict`; all required checks must pass before prompting.
- Use the real Anthropic provider resolved through Volund CLI auth.
- Keep sandboxing and the normal permission chain enabled.
- Do not paste a credential into the prompt, command line, source, config,
  screenshot, session export, issue, commit, or PR.
- Deny at least one intentionally out-of-scope request if one naturally occurs;
  never manufacture a destructive request merely to collect a denial.

Record each permission event as a sanitized tuple:

```text
timestamp | tool category | normalized resource scope | decision | rationale
```

Do not record raw prompt content, environment values, authorization headers, or
sensitive file contents. For shell commands, record a reviewed redacted form and
its exit code.

### Dog-food acceptance

The run passes only when all of the following are durable and reviewable:

- session ID/export hash, candidate revision, host target, and frozen Sandbox Tier;
- strict doctor result;
- real Anthropic provider identification without any credential value;
- complete permission-decision record;
- focused and regression test commands with passing results;
- signed commit and accessible task PR URL;
- reviewer confirmation that the produced diff solves the selected task;
- sanitized evidence scan with no credential or sensitive-content finding.

Update `L1-DOGFOOD.md` from `BLOCKED` to `PASS` or `FAIL`. A retry gets a new run
ID; never overwrite or hide a failed attempt. The documentation PR must contain
a DCO signed commit, a changeset, and `Closes APO-15` only when every APO-15 gate
is actually satisfied.

## Phase 4 — BDFL and security sign-off

Populate `L1-SIGNOFF.md` only after Phases 1–3 pass. Give both reviewers the
candidate revision, matrix, dog-food record, release notes, package list, and
residual-risk register.

Security review must explicitly decide:

- sandbox tier/escape evidence for each target;
- permission decisions and dangerous-mode behavior;
- auth verification/storage path and evidence redaction;
- telemetry defaults and sanitization;
- dependency/license results and every security residual risk.

BDFL review must explicitly decide:

- checklist completeness and product usability;
- whether every residual risk is accepted, rejected, or deferred with an owner;
- the exact package/version set and whether publication may be requested.

Each decision records `ACCEPT` or `REJECT`, reviewer identity, UTC date, rationale,
and linked remediation for every rejection. Silence, reactions, prior approval,
or agent-authored text are not sign-off.

## Phase 5 — Release decision and publication boundary

After both signers accept, an independent reviewer reconciles
`RELEASE-CHECKLIST-L1.md`, `L1-READINESS.md`, `L1-DOGFOOD.md`,
`L1-SIGNOFF.md`, and this manifest against the same candidate.

Use these distinct states:

| State | Meaning |
| --- | --- |
| Implemented | Code exists on a named revision |
| Accepted | All required automated, target, dog-food, and human gates passed |
| Merged | The acceptance-document PR is merged |
| Published | Authorized npm packages, Git tag, and release evidence exist |

Acceptance and merge do not authorize publication. Until a human explicitly
authorizes the exact package versions and Git tag, report **not published** and
do not run npm publish, create a tag, or create a GitHub Release.

If publication is later authorized, the publisher must verify the clean signed
tag points to the accepted revision, publish only the approved package set, run
post-publish install/smoke checks, and append immutable registry/tag/release URLs.

## Failure, retry, and rollback rules

- Stop on any failed mandatory command, target, doctor check, secret scan,
  dog-food criterion, or human rejection. Mark the relevant evidence `FAIL` or
  `BLOCKED`; never relabel it as partial success.
- Open a concrete remediation issue with owner and scope. Security failures must
  be fixed and re-reviewed; they cannot be waived by an agent.
- Retry from the earliest invalidated phase on a new candidate revision. Keep the
  old manifest and failure links for audit history.
- If unauthorized or incorrect publication occurs, stop further publishing,
  notify the owner/security reviewer, deprecate affected npm versions where
  appropriate, document the immutable tag/package state, and issue a corrected
  version. Never rewrite an already consumed public tag as a silent rollback.

## Evidence manifest

Copy this table into the acceptance PR and replace every `pending` value with a
durable value or an explicit `FAIL`/`BLOCKED` reason:

| Evidence | Required record | Status |
| --- | --- | --- |
| Candidate | Full revision, version, clean-tree check, toolchain versions | pending |
| TypeScript | install/typecheck/test/build commands, counts, CI URLs | pending |
| Rust | fmt/check/test/build commands, counts, CI URLs | pending |
| Policy | license, dependency, lockfile, documentation checks | pending |
| Four targets | identity, checksum, doctor, tier, escape ratio, worker checks | pending |
| Dog-food | task, run/export hash, permissions, tests, signed commit, PR URL | pending |
| Secret review | reviewed surfaces, scanner/version, reviewer, outcome | pending |
| Residual risks | issue URLs, severity, owner, disposition | pending |
| Security sign-off | decision, reviewer, UTC date, rationale | pending |
| BDFL sign-off | decision, reviewer, UTC date, rationale | pending |
| Publication | explicit authorization and immutable URLs, or `not published` | pending |

Final reviewer attestation:

```text
Candidate revision:
Manifest revision:
All evidence refers to the same candidate: YES / NO
Unverified fields remaining:
Accepted for L1: YES / NO
Reviewer and UTC date:
```
