# Marketplaces

Volund reads three marketplace indexes from `~/.volund/config.toml` — one each for
plugins, skills, and MCP servers. Any trusted URL serving the expected index format
works; the web console's market tab and the REPL browse these indexes and install
from them.

## Configuration

```toml
[plugins]
market = "https://market.example.com/plugins/index.json"

[skills]
market = "https://market.example.com/skills/index.json"

[mcp]
market = "https://market.example.com/mcp/index.json"
```

Indexes are re-read on every fetch (skill and MCP indexes are cached in-process for
60 seconds, keyed by source), so changing a URL takes effect on the next refresh —
no restart needed.

Without configuration, skills and MCP fall back to built-in defaults (the
[anthropics/skills](https://github.com/anthropics/skills) marketplace list via
jsDelivr, and the official MCP Registry v0 API). Plugins have no default — a source
must be configured before the market tab shows entries.

## Trust model

- Index browsing requires a canonical HTTPS URL or loopback HTTP (LAN HTTP is rejected).
- **Plugins** are executable: installs from remote HTTPS sources fail closed with
  `plugin_registry_signature_required` until a publisher-signing trust root exists.
  Loopback HTTP sources are installable today — this is the supported path for
  self-hosted marketplaces. Every file is digest-verified on download and re-verified
  on each activation.
- **Skills** are prompt-layer content and do not execute code: installation goes
  through the git channel and remote sources are allowed.
- **MCP** entries are never installed silently — selecting one pre-fills the add
  form, and the entry is written to `mcp.toml` only after you confirm.

## Self-hosted marketplace (`@volund/market`)

The repository ships a standalone marketplace server at `apps/market` — a Next.js
app whose three index endpoints are field-compatible with volund's client parsers,
so clients browse and install from it with zero changes.

Build and push the image:

```bash
REGISTRY=registry.example.com/volund sh deploy/market/image-push.sh
```

Run it (data persists in the `volund-market-data` volume; first start seeds a demo
plugin, sample skills, and MCP entries):

```bash
docker run -d --name volund-market \
  -p 4315:4315 \
  -e MARKET_ADMIN_TOKEN=your-write-token \
  -v volund-market-data:/app/data \
  --restart unless-stopped \
  registry.example.com/volund/volund-market:1.0.0
```

Point volund at it — loopback HTTP sources are executable, so plugins install for real:

```toml
[plugins]
market = "http://127.0.0.1:4315/api/plugins/index.json"

[skills]
market = "http://127.0.0.1:4315/api/skills/index.json"

[mcp]
market = "http://127.0.0.1:4315/api/mcp/index.json"
```

## Publishing entries

The server's `/admin` page, its REST API (`/api/v1/*`, Bearer
`MARKET_ADMIN_TOKEN`), or `apps/market/scripts/publish.mjs` (CI-friendly, publishes
a plugin directory) all work:

- **Plugins**: publish a directory containing `manifest.json` plus bundle files —
  the manifest is validated against the same rules as the host (`volund-plugin-*`
  naming, semver, `engines.volund`), files are stored per version with sha256 digests.
- **Skills / MCP**: catalog entries with an optional semver `version`; re-submitting
  the same name updates the entry (upsert). Skill `source` must be a git URL / GitHub
  tree URL / `owner/repo` shorthand.

See `apps/market/README.md` for the full API reference and deployment details.
