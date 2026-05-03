# Start Phase 1 — Implementation

## First Steps

1. Retrieve memory records for actor_id "chris" — namespaces `/user/preferences`, `/user/workflow`.
2. Read `agents/AGENTS.md` for the development workflow.
3. Read `design/plan.md` for the full implementation plan, DAG, and subagent instructions.

## Current Status

- **Phase**: Design complete and approved. Ready for implementation (Phase 6 per AGENTS.md).
- **Design reviews**: 7 personas reviewed. 0 Critical, 0 High findings remain.
- **Chief Architect Engineer**: Approved plan. 3 ADR conflicts resolved.
- **Repo**: `chriswessells/mcp-bin` (private)

## Execution Phases

| Phase | Tasks | Mode | Gate |
|-------|-------|------|------|
| 1 | T0 (scaffolding) | Sequential | Build passes (`tsc --noEmit`) |
| 2 | T1, T2, T3, T4, T5 | **Parallel** (5 subagents, sonnet-4.6) | All 5 build + unit tests pass |
| 3 | T6 (CLI integration) | Sequential | Build passes, `node dist/cli.js` runs |
| 4 | T7 (integration tests) | Sequential | All integration tests pass |
| 5 | T9 (key generation) | Sequential (after T4) | Manifest signed and verified |
| — | T8 (author tooling) | Independent, anytime | Script runs idempotently |
| — | T10 (README + docs) | Independent, anytime | README exists with quickstart |

## What to Do Now

**Start with Phase 1: T0 (Scaffolding)**

Read `design/plan.md` section "Subagent: Scaffolding (T0)" for the full instructions. Summary:

Create these files:
1. `package.json` — `@mcp-bin/runner`, `tar-stream` pinned to `3.1.7`, `node:test` runner
2. `tsconfig.json` — ES2022, Node16, strict
3. `src/types.ts` — shared interfaces from `design/architecture.md` "Shared Types"
4. `src/errors.ts` — McpBinError base + E1–E15 subclasses + InvalidArgumentError + DiskFullError + sanitizeUrl()
5. `src/platform.ts` — detectPlatform() returning Platform type
6. `LICENSE` — MIT
7. `.github/workflows/ci.yml` — `npm ci && npm run build && npm test`

Gate: `npx tsc --noEmit` passes.

## After T0

Run Phase 2: launch 5 parallel subagents (T1–T5) using the prompts in `design/plan.md`. Each subagent reads its component design doc and implements against the API contract.

## Key Design Files

| File | Purpose |
|------|---------|
| `design/architecture.md` | Component boundaries, shared types, data flow, dependencies |
| `design/manifest-client.md` | Manifest fetch, Ed25519 verification, cache, resolve |
| `design/cache-manager.md` | Cache lookup, atomic store, locking, permissions |
| `design/downloader.md` | HTTPS download, retry, timeouts, SHA256 |
| `design/extractor.md` | tar.gz extraction, path traversal protection |
| `design/process-runner.md` | spawn, signal forwarding, env filtering |
| `design/cli.md` | Entry point, orchestration, signal phases |
| `design/plan.md` | Full task list, DAG, subagent instructions |

## Key Decisions (ADRs)

- **ADR-001**: npm distribution (`npx @mcp-bin/runner`)
- **ADR-002**: TypeScript
- **ADR-003**: .tar.gz only, no Windows
- **ADR-004**: Ed25519 manifest signing (non-negotiable)
- **ADR-005**: .sha256 sidecar for cache verification
- **ADR-006**: Env vars only, no CLI flags (amended: `MCP_BIN_CHECK` env var OK)
- **ADR-007**: Shell script for manifest updates
- **ADR-008**: GitHub Pages for default manifest
- **ADR-009**: spawn + signal forwarding (not execve)
- **ADR-010**: Env var denylist (amended: `MCP_BIN_ALLOW_ENV` escape hatch)

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `MCP_BIN_MANIFEST_URL` | `https://your-registry.example.com/manifest.json` | Manifest location |
| `MCP_BIN_CACHE_DIR` | `~/.cache/mcp-bin` | Cache root directory |
| `MCP_BIN_ALLOW_ENV` | (none) | Comma-separated var names to bypass denylist |
| `MCP_BIN_ALLOW_FILE_PROTOCOL` | (none) | `1` to allow file:// manifests (dev only) |
| `MCP_BIN_DEBUG` | (none) | `1` for debug logging to stderr |
| `MCP_BIN_CHECK` | (none) | `1` for diagnostic mode (no exec) |

## Testing Rule

Write tests for critical and high-severity paths only. Do not write tests for low-likelihood edge cases.

## After All Tasks Complete

Per AGENTS.md: Code Review (7 personas) → fix Critical/High → QA testing → ship.
