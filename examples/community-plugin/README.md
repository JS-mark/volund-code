# Community plugin example

This bundled single-file ESM example requests only `tools.register`; it has no filesystem or network permission.

The tool name is namespaced as `plugin:volund-plugin-community-example:community.echo`, as required for all plugin-contributed tools. Volund CLI activates it only after installation and explicit permission approval, and executes its handler in the native sandbox host.

```sh
npm pack --dry-run
volund plugin install .
volund plugin doctor volund-plugin-community-example
volund plugin disable volund-plugin-community-example
volund plugin enable volund-plugin-community-example
volund plugin uninstall volund-plugin-community-example
```

Installation always requires an interactive permission confirmation. `npm publish` is intentionally outside this example and must not be run without release authorization.
