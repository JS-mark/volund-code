## L3 external hardware evidence

### Windows Tier 3

| Target                    | Automation                              | Hardware result                       |
| ------------------------- | --------------------------------------- | ------------------------------------- |
| `x86_64-pc-windows-msvc`  | Windows build and Tier 2 escape job     | Tier 3 not executed in this changeset |
| `aarch64-pc-windows-msvc` | Windows ARM build and Tier 2 escape job | Tier 3 not executed in this changeset |

Do not promote either row to Full without an artifact containing the candidate
SHA, runner/architecture/OS, exact command, raw summary, exit code, and UTC
timestamps. A Windows Tier 3 job must additionally exercise default deny,
allowed and denied IPv4/IPv6 endpoints, DNS-answer pinning, concurrent session
isolation, transaction rollback, timeout cleanup, and crash recovery.

### AWS Graviton

`.github/workflows/graviton-evidence.yml` is a manual, secret-free sampling
workflow. It accepts only a full candidate SHA and runs only on an existing
controlled runner labelled `apollo-graviton`; it never creates paid resources.
Its artifact records the candidate and checked-out SHA, host, architecture,
kernel, exact command, raw summary, exit code, and start/end times.

Current hardware result: **not executed; waiting for an authorized external runner**.

## Community plugin local dog-food

Candidate implementation SHA: `5add9f5647ab604d5c65b1e6de4b32a14169834a`.

Executed locally on macOS arm64 on 2026-08-04 (Asia/Shanghai), with an isolated `APOLLO_HOME` and redacted output:

| Step                 | Command                                                                     | Exit | Result                                                         |
| -------------------- | --------------------------------------------------------------------------- | ---: | -------------------------------------------------------------- |
| Pack/publish preview | `pnpm --dir examples/community-plugin pack:dry-run`                         |    0 | Four expected files; no publish performed                      |
| Local install        | `node apps/cli/dist/apollo.js plugin install examples/community-plugin`     |    0 | Explicit `tools.register` approval accepted; installed `0.0.1` |
| Inspect              | `plugin list --json`; `plugin doctor apollo-plugin-community-example`       |    0 | Enabled state and declared permission matched                  |
| Lifecycle            | `plugin disable`; `plugin enable`; `plugin uninstall`; `plugin list --json` |    0 | State transitions succeeded; final list empty                  |

That earlier run reported Sandbox Tier `NONE`; it remains packaging/lifecycle evidence only and is not activation acceptance evidence.

### Sandboxed activation rerun (APO-48; historical only)

> **Superseded by P0-00 containment:** the evidence below describes an earlier candidate and is not a
> current production availability or acceptance claim. Production legacy host composition and its
> E2E lane have since been removed. ABI-R1 must supply fresh verified execution evidence before a
> security review may reopen activation.

Candidate implementation SHA: `33b72726275629f9f23fe251c93b3f4cef1323a0`.

Executed from `2026-08-05T04:22:32Z` through `2026-08-05T04:22:33Z` on macOS Darwin 25.6.0, arm64. The native probe returned Tier `partial`, mechanism `sandbox_init`, with the documented limitation that network allowlists are not hostname-granular on this foundation.

| Step                | Command                                                                                                                          | Exit | Result                                                                                                                                                                                                                                    |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ---: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native probe        | `./target/debug/apollo-sandbox --probe`                                                                                          |    0 | `tier=partial`, `sandbox_init=true`, Darwin 25.6.0 arm64                                                                                                                                                                                  |
| Real lifecycle E2E  | `APOLLO_NATIVE_SANDBOX_BINARY=<candidate apollo-sandbox> APOLLO_RUN_PLUGIN_E2E=1 pnpm --filter @apollo-code/plugin-runtime test` |    0 | 3 files / 15 tests passed; real manager + runtime + native host registered and invoked `plugin:apollo-plugin-community-example:community.echo`, then verified disable, enable, uninstall, corrupt-entry auto-disable, and process cleanup |
| Monorepo gate       | `pnpm turbo run typecheck test build --force`                                                                                    |    0 | 73 tasks passed across 24 packages                                                                                                                                                                                                        |
| Native gate         | `cargo test --workspace`; `cargo clippy --workspace --all-targets -- -D warnings`                                                |    0 | All workspace tests and warning-denied clippy passed                                                                                                                                                                                      |
| Escape/release gate | `bash crates/apollo-sandbox/tests/escape/run.sh ./target/debug/apollo-sandbox`; release verification node tests                  |    0 | Allowed write succeeded, out-of-root write was denied, and all release/changeset/native evidence checks passed                                                                                                                            |

The E2E uses the compiled candidate `apollo-sandbox` and its embedded `plugin_host.mjs`; it does not mock `ApolloPorts`, import the plugin in the main process, or bypass sandbox/permission policy. The direct suite also covers stale approvals, path and symlink escape rejection, RPC allowlist/quota, duplicate loading, activation timeout/cancellation cleanup, three-failure automatic disable, and log redaction. No npm publish, tag, GitHub Release, production signing, real-provider call, Windows Tier 3 run, or Graviton run was performed.
