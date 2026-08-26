# Skills and image attachments

Apollo discovers skills from layered scopes (project `.apollo/skills/` and `.agents/skills/`, user `~/.apollo/skills/` and `~/.agents/skills/`), and every user-invocable skill is registered as a same-name slash command. Startup reads only YAML metadata and contributes a compact index to the system prompt. A one-shot `/skill-name [task]` sends the skill body plus the task as the current turn's user message without persisting a prompt change; `/skill activate <name>` (or the `a` key in the `/skills` panel) keeps the skill in the prompt for the session. Skill instructions never execute code and do not grant permissions. Enable/disable state persists in `~/.apollo/config.toml` under `[skills] disabled`; the `/skills` panel lists every discovered skill with scope, status (active / available / disabled / shadowed / broken / incompatible), and the reason for any shadow or failure.

An incompatible `apolloVersion` produces a warning but does not hide the skill. Activation is idempotent, and deactivation removes the prompt contribution immediately.

Image attachments are stored as content-addressed files under the session's `attachments` directory. Session JSONL contains only an opaque handle, MIME type, and message metadata; binary bytes never enter the event log. PNG, JPEG, GIF, and WebP are accepted after signature and size checks. Provider adapters enforce their own capability, MIME, and size limits again before sending a request.

If the selected provider does not support vision, Apollo replaces the image part in that request with a visible text placeholder. The durable session message keeps the original handle, so resuming the session or choosing a vision-capable provider does not lose the attachment.

Real provider vision calls require user credentials and are an explicit manual verification gate. Fixture tests cover Anthropic and OpenAI request mapping without claiming online-provider evidence.
