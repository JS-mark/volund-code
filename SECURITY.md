# Security Policy

Volund CLI is a terminal AI agent that executes tools with user permission,
routes credentials through OS keychains, and runs a native Rust sandbox on the
host. Security bugs here can be high-impact — thank you for reporting them
responsibly.

## Supported versions

Volund CLI is under active pre-release development. Only the latest tagged
version receives security fixes.

| Version                | Supported                                      |
|------------------------|------------------------------------------------|
| Latest `0.x` tag       | ✅ Fixes on the next `0.x` release              |
| Older `0.x` tags       | ❌ Pre-release; upgrade to the latest `0.x` tag |
| `1.x` (once released)  | ✅ Latest minor                                 |
| `< 1.0` after `1.0` GA | ❌ Upgrade to `1.x`                             |

## Reporting a vulnerability

**Please do not open a public GitHub issue for security bugs.**

- Email: `security@volund-code.dev` (placeholder — will be replaced with the
  real address before first public release)
- GitHub Security Advisory: use the `Report a vulnerability` button on the
  repository's `Security` tab (preferred for coordinated disclosure)

If practical, encrypt with our PGP key (fingerprint to be published on the
docs site under `/security`).

## What to include

- A description of the issue and impact
- Steps to reproduce (minimal example preferred)
- The installed package version (`volund version`) and OS
- Any suggested mitigation

## Our commitment

- **Acknowledge**: within 48 hours (business days)
- **Triage**: within 7 days
- **Fix or mitigation**: within 14 days for high-severity issues
- **Public disclosure**: coordinated, after a fix is released

We will credit you in the release notes and advisory (unless you request
otherwise).

## Scope

**In scope:**
- Sandbox escape from `volund-sandbox` (macOS `sandbox-exec`/sbpl / Linux
  bundled `bwrap`+seccomp (landlock fallback) / Windows Job Object + AppContainer
  + WFP)
- Permission model bypass (any tool executing without required decision)
- Credential exfiltration from `packages/auth` (keychain / encrypted file /
  env fallback)
- Plugin sandbox breakout (escape from the `volund-sandbox --run-plugin`
  subprocess isolation, JSBridge abuse, RPC whitelist bypass)
- Supply chain attacks affecting shipped npm packages or Rust crates (incl.
  the bundled bwrap binary digest tampering)
- Prompt-injection issues that lead to unauthorized privileged actions
  (e.g. arbitrary file write without permission prompt)

**Out of scope:**
- Vulnerabilities in third-party MCP servers, plugins, or provider APIs
- Issues requiring physical access to the machine
- Attacks that require the user to already have `--dangerous-no-sandbox`,
  `--dangerously-skip-permissions`, or `--yolo` set (these flags are
  documented as unsafe)
- Findings against unmaintained forks

## Safe harbor

We consider good-faith security research not to be a violation of our terms.
If you follow this policy we will not pursue legal action.

## Hardening resources

- Design spec: `docs/superpowers/specs/2026-07-31-volund-code-design/` (split
  into `01`–`14` section files + `SANDBOX-COMPAT-r1.md`; `§4` permissions,
  `§5` Rust sandbox, `§6` plugin runtime)
- Engineering conventions: `AGENT.md` `§4` boundary rules

Thank you for helping keep Volund CLI and its users safe.
