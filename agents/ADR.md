# Architecture Decision Records

## ADR-001: Use npm as the distribution mechanism for the runner

**Date**: 2026-05-02
**Status**: Accepted
**Context**: Kiro's MCP registry only supports `npm`, `pypi`, and `oci` as runner types. We need a way to distribute native binaries through this registry.
**Decision**: Package the runner as an npm package (`@mcp-bin/runner`) invoked via `npx`.
**Tradeoff**: Requires Node.js on the user's machine. Target audience (Rust developers) may not have Node.js. Mitigated by planning a standalone binary runner in Phase 2 (P1).

## ADR-002: TypeScript for the runner implementation

**Date**: 2026-05-02
**Status**: Accepted
**Context**: The runner is an npm package. Could be plain JS or TypeScript.
**Decision**: TypeScript for type safety and better maintainability.
**Tradeoff**: Adds a build step. Acceptable for a small project.

## ADR-003: .tar.gz only, no .zip, no Windows in v1

**Date**: 2026-05-02
**Status**: Accepted
**Context**: Supporting both .tar.gz and .zip doubles extraction code paths. Windows support requires .exe handling, different exec semantics, and different cache paths.
**Decision**: Support .tar.gz only on `darwin-arm64`, `linux-x64`, `linux-arm64`. Windows deferred to future version.
**Rationale**: Profitability and maintainability reviews flagged this as unnecessary scope for a solo developer. Halves extraction code and test surface.

## ADR-004: Ed25519 manifest signing as a launch requirement

**Date**: 2026-05-02
**Status**: Accepted
**Context**: Security review flagged that SHA256 verification alone is "security theater" if the manifest host is compromised — attacker controls both URLs and checksums.
**Decision**: Require Ed25519 detached signature (`.sig` file) for the manifest. Public key pinned in the runner package.
**Tradeoff**: Adds implementation complexity and key management burden. Justified because the runner executes arbitrary binaries — the trust chain must be strong.

## ADR-005: .sha256 sidecar file for cache-hit verification

**Date**: 2026-05-02
**Status**: Accepted
**Context**: The manifest provides the archive checksum, but the cache stores the extracted binary. R16 requires verifying the cached binary on every hit, but there's no binary checksum in the manifest.
**Decision**: At extraction time, compute the binary's SHA256 and store it in a `<binary>.sha256` sidecar file. Cache-hit verification checks the binary against this sidecar.
**Tradeoff**: Local trust anchor — if an attacker can modify the cache, they can modify the sidecar too. Acceptable because cache is user-scoped (S4) and atomic writes (R15) prevent partial state.

## ADR-006: Environment variables only for runner config (no CLI flags)

**Date**: 2026-05-02
**Status**: Accepted — **amended 2026-05-02**
**Context**: CLI flags (`--manifest-url`, `--cache-dir`) conflict with R14 (forward additional arguments to the binary). Ambiguity about which flags belong to the runner vs the child.
**Decision**: Use environment variables only (`MCP_BIN_MANIFEST_URL`, `MCP_BIN_CACHE_DIR`). No CLI flags for runner configuration.
**Rationale**: Env vars are unambiguous, don't conflict with forwarded args, and are already the integration path for Kiro registry entries.
**Amendment**: Added `MCP_BIN_CHECK` env var. When set to `1`, runs diagnostic mode (verify manifest, signature, cache, platform) without executing a binary. Outputs JSON status to stdout, exits 0/1. No CLI flags added — stays within the "env vars only" principle. Chief Architect Engineer ruling: `--check` flag rejected (precedent-setting), env var accepted.

## ADR-007: Shell script for manifest updates, not a CLI tool

**Date**: 2026-05-02
**Status**: Accepted
**Context**: Profitability review flagged that building a generic CLI tool or GitHub Action for manifest updates is premature — there's only one server author (us).
**Decision**: Provide `update-manifest.sh` using `jq` and `curl`. Defer generic tooling to a future version.
**Tradeoff**: Third-party authors must manually edit the manifest or adapt the script. Acceptable until there are third-party authors.

## ADR-008: GitHub Pages for default manifest hosting

**Date**: 2026-05-02
**Status**: Accepted
**Context**: The manifest needs a default HTTPS location. Options: S3, GitHub Pages, custom server.
**Decision**: `https://mcpregistry.wessells.io/manifest.json` — GitHub Pages on this repo.
**Rationale**: Zero cost, zero infrastructure, version-controlled, automatic deployment on push.

## ADR-009: spawn + signal forwarding instead of execve

**Date**: 2026-05-02
**Status**: Accepted
**Context**: R20/R21 originally specified execve semantics, but Node.js doesn't support true process replacement.
**Decision**: Use `child_process.spawn` with stdio inherited. Forward SIGTERM/SIGINT to the child. Exit with the child's exit code. No runner output after spawn.
**Rationale**: Only viable approach in Node.js. Reliability review confirmed this is sufficient.

## ADR-010: Denylist approach for sensitive env var filtering

**Date**: 2026-05-02
**Status**: Accepted — **amended 2026-05-02**
**Context**: S12 requires filtering sensitive env vars. Options: allowlist (only forward explicitly listed vars) or denylist (block known-sensitive patterns).
**Decision**: Denylist (`AWS_*`, `GITHUB_TOKEN`, `*_SECRET`, `*_KEY`, `*_PASSWORD`). Override via Kiro registry `environmentVariables` array.
**Tradeoff**: Denylists are inherently incomplete. Resilience review suggested an allowlist. Accepted denylist for v1 because most MCP servers need a broad environment to function. May revisit if security incidents occur.
**Amendment**: Added `MCP_BIN_ALLOW_ENV` env var (comma-separated exact var names to pass through despite matching denylist patterns). Solves the real customer problem (e.g., `AWS_REGION` blocked by `/^AWS_/`). Denylist patterns NOT expanded — adding more patterns is a treadmill. Chief Architect Engineer ruling: escape hatch is the right fix, not a bigger denylist.
