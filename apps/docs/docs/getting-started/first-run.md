# First run

## Trust the working directory

Before Volund initializes a provider, tool, or session in a new directory, it shows the canonical (realpath) directory and asks for a trust scope:

- **Trust this folder only** stores an exact-path rule.
- **Trust parent folder tree** stores a tree rule for the displayed parent.
- **Trust folder and subdirectories** stores a tree rule for the current folder.
- **No, exit** (or `Esc`) exits before runtime initialization.

Directory trust permits Volund to start in that location. It does not approve file writes, commands, network access, or bypass the permission manager and sandbox.

Headless and JSON runs fail with `directory_untrusted` instead of waiting for input. Automation may explicitly trust only the canonical current folder with `--trust-workspace`.

Use `volund trust list` (or `--json`) to inspect user-level rules. Revoke one canonical rule with `volund trust revoke <path>`, or clear all rules with `volund trust revoke --all`. Rules live in `~/.volund/trusted-directories.json`, never in the project repository.

Run `volund` or `volund chat` in a repository. With an interactive terminal and
no prompt argument, Volund starts the Ink TUI and shows a `> ` input line. Before
Volund writes configuration, onboarding explains the local-only telemetry default
and the detected Sandbox Tier.

1. Choose Anthropic as the provider.
2. Enter the API key only in Volund's masked credential prompt. Never paste it into chat, shell history, logs, an issue, or a commit.
3. Volund verifies the credential before storing it in the OS keychain or encrypted fallback store.
4. Review every requested write, command, and network permission. Deny requests you do not understand.

Use `volund doctor --strict` before a real task. A degraded sandbox exits with code 3. `--dangerously-no-sandbox` requires an explicit risk confirmation and should not be used for release acceptance.

For local checks, `volund chat --no-tui` forces the line-mode fallback, while
`volund chat "prompt" --json` emits NDJSON for automation and does not start the
TUI.

# First interactive screen

After directory trust is resolved, interactive `volund chat` opens a terminal status screen before
the first prompt. It reports the effective model, authentication availability, canonical workspace,
trust scope, sandbox tier, permission mode, session, and context budget. Unknown runtime values are
shown as `unknown` or `not configured`; Volund never infers a successful security or auth state.

The command band accepts Enter to send and Shift+Enter for a newline. Empty input is ignored.
`--json` and `--no-tui` remain machine/line-output modes and never render the welcome screen.
