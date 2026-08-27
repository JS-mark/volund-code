---
title: Themes and plugin UI
---

# Themes and plugin UI

Volund theme files use schema version `1`. A theme must provide exactly these eight six-digit hexadecimal color tokens: `background`, `foreground`, `muted`, `accent`, `success`, `warning`, `error`, and `border`. The built-in `dark` and `light` themes are always available. Invalid files, unsupported schema versions, missing tokens, and extra tokens fall back to the selected built-in theme and retain a diagnostic message.

```json
{
  "schemaVersion": 1,
  "name": "ocean",
  "tokens": {
    "background": "#071521",
    "foreground": "#e7f5ff",
    "muted": "#8296a6",
    "accent": "#4da3ff",
    "success": "#55c995",
    "warning": "#e4b85c",
    "error": "#ef7272",
    "border": "#294052"
  }
}
```

Plugin UI is declarative. Version 1 permits plain-text items on the `status-bar` surface only:

The `permissions.volund` key below is a frozen v1 manifest field. It remains unchanged for plugin
compatibility even though the product and CLI are now named Volund.

```json
{
  "permissions": { "volund": ["ui.contribute"] },
  "contributes": {
    "ui": [{ "id": "branch", "surface": "status-bar", "text": "main", "priority": 10 }]
  }
}
```

IDs are plugin-local. The runtime namespaces registrations by plugin and removes them on disable, uninstall, activation failure, or shutdown. Unsupported surfaces, duplicate IDs, control characters, oversized text, unknown fields (including component or module references), and missing `ui.contribute` permission reject the manifest. Plugins cannot inject components or access another plugin's items. In `--no-tui`, JSON, and other headless operation the registry is a deterministic no-op; contributions never write to stdout or alter exit status.
