# L4 release evidence

Volund CLI publishes a deterministic 8-target × 3-tier sandbox evidence matrix from the versioned `l4-evidence.schema.json` contract. The canonical generated matrix lives in `docs/releases/L4-EVIDENCE-MATRIX.md` in the repository.

The matrix keeps build, native runtime, escape, signing, and notarization evidence separate. It also distinguishes native, cross, QEMU, and real-hardware execution. Missing, malformed, conflicting, or stale evidence blocks a stable release; a successful build never substitutes for a native escape result or an external signing gate.

The repository baseline intentionally reports every target and tier as `None / not-run` until authorized evidence is supplied. Release operators regenerate it with `pnpm release:evidence:generate`, verify committed output with `pnpm release:evidence:check`, and apply the fail-closed stable gate with `pnpm release:evidence:assert`.
