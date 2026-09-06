---
'@volund/shared': minor
'@volund/native-bridge': minor
'@volund/ui': minor
'@volund/cli': minor
---

Clipboard attachment paste (spec §7.5.2): Ctrl+V in the TUI reads the system clipboard — images are staged content-addressed into the session attachment store and inserted as atomic, sequentially numbered `[image_1]` chips, copied files become `[file: <name>]` path references, and plain text is inserted in place. Dragging a file into the terminal or pasting a resolvable file path attaches it too (bracketed paste; in-workspace files by path, out-of-workspace images staged as blobs). Cmd+V pastes images too: an empty bracketed paste (clipboard holds an image, no text) triggers the clipboard read — the same onEmptyPaste semantics as Claude Code. Pasting requires no permission prompt (the chip is a local reference; content leaves only when the message is sent); submissions expand chips into image/file content parts for vision-capable providers (others degrade to a textual note). History and transcripts keep only chip text, never binary.

The `@` unified picker (spec §7.5.3) is wired into the input box: typing `@` lists model aliases (⭐) and workspace files (📄) with prefix filtering; selecting a file attaches it, selecting a model sets the turn-level override. TIFF-only clipboards convert via `sips`.

A `/paste` command provides a keybinding-independent attach path (for terminals that capture Ctrl+V), the permission prompt accepts `y` as allow-once, and the input box no longer loses its draft and attachment chips when the welcome screen hides (it is no longer remounted on view switches).

The input box now supports cursor movement (←/→, Home/End, Ctrl+A/Ctrl+E) with edits applying at the cursor; pasted multi-line text no longer triggers premature submission.
