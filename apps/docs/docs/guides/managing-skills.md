# Managing skills

Skills are prompt-layer capability packs: a directory with a `SKILL.md` (YAML frontmatter + Markdown instructions), plus optional `scripts/`, `references/`, and `assets/`. Volund aligns with the [agentskills.io](https://agentskills.io) open standard and shares the same file format as Claude Code, Codex, and Cursor.

## Install

```sh
# Local directory (must contain SKILL.md; name must match the directory name)
volund skill install ./my-skill

# GitHub repo (installs the repo root if it has SKILL.md, otherwise installs every first-level subdirectory that does)
volund skill install github:anthropics/skills
volund skill install anthropics/skills          # shorthand
volund skill install https://github.com/you/skills-repo.git
volund skill install file:///path/to/local-repo
# Nested repos are also supported (e.g. anthropics/claude-plugins-official's plugins/<name>/skills/…): arbitrary-depth scan, per-skill failures skipped with a warning
 # local git repo

# Project scope (shipped with the repo, shared with the team)
volund skill install anthropics/skills --scope project   # → <cwd>/.volund/skills/
```

You can also install with the ecosystem's own tool — Volund discovers the result automatically (read-only interop path):

```sh
npx skills add <query>          # skills.sh installs to ~/.agents/skills
```

## Discovery and scopes

Discovered in priority order (highest wins for a same-name skill):

1. Project `<cwd>/.volund/skills/`
2. Project `<cwd>/.agents/skills/` (interop path, read-only)
3. User `~/.volund/skills/`
4. User `~/.agents/skills/` (interop path, read-only)

A same-name skill in a higher-priority layer marks the lower-priority copy `shadowed` (visible in the panel with the reason); it is never an error.

## Use

| Route                          | Semantics                                                                                                                              |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `/skill-name [task]`           | One-shot invocation: the skill body plus the task text becomes the user message for the current turn (no persistent prompt change).    |
| `/skill activate <name>`       | Session-level: the skill is injected into the system prompt until `/skill deactivate`.                                                 |
| `a` key in the `/skills` panel | Same as `/skill activate`.                                                                                                             |
| Model-driven                   | The model calls the `Skill.activate` tool after seeing the index; disabled when the frontmatter sets `disable-model-invocation: true`. |

## Manage

| Action                        | REPL                                          | CLI                                         |
| ----------------------------- | --------------------------------------------- | ------------------------------------------- |
| List / status                 | `/skills` panel                               | `volund skill list [--scope user\|project]` |
| Detail                        | Enter in the panel (read-only scrolling view) | `volund skill show <name>`                  |
| Enable / disable (persistent) | Space in the panel                            | `volund skill enable\|disable <name>`       |
| Rescan                        | `r` in the panel                              | —                                           |
| Uninstall                     | —                                             | `volund skill uninstall <name>`             |

Enabled state persists in `~/.volund/config.toml` under `[skills] disabled`. Edits to `SKILL.md` take effect after rescan without restarting the session.
