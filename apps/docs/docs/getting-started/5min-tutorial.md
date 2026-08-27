# A five-minute task

Start with a small, reviewable repository task:

```sh
volund chat "Read the failing test, make the smallest fix, run that test, and show me the diff."
```

Passing a prompt runs a one-shot chat turn. Running `volund chat` without a
prompt in a TTY starts the Ink TUI for an interactive session with input history,
slash commands, streaming output, and permission prompts. Volund reads context,
proposes permission-gated actions, streams provider output, and records the
session locally. Inspect each permission prompt and the final diff. Run the
project test yourself before committing.

For release dog-food evidence, the task must use the real Anthropic provider and cover reading, editing, tests, and a pull request. Record decisions and URLs in `docs/releases/L1-DOGFOOD.md` without recording credentials or sensitive prompt contents.
