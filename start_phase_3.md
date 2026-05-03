# Start Phase 3 — CLI Integration

## First Steps

1. Retrieve memory records for actor_id "chris" — namespaces `/user/preferences`, `/user/workflow`, `/system/workflows`.
2. Read `agents/AGENTS.md` for the development workflow and review process.
3. Read `design/plan.md` for subagent instructions (section: "Subagent: CLI Integration (T6)").
4. Read `design/cli.md` for the full CLI design.
5. Read the component source files: `src/downloader.ts`, `src/extractor.ts`, `src/cache-manager.ts`, `src/manifest-client.ts`, `src/process-runner.ts`, `src/types.ts`, `src/errors.ts`, `src/platform.ts`.

## Current Status

- **Phase 1 (T0)**: ✅ Complete — scaffolding, code review, QA verified.
- **Phase 2 (T1–T5)**: ✅ Complete — 5 core components, code review (0 Critical/High remaining), 38 tests pass, QA verified, docs updated.
- **Phase 3 (T6)**: Ready to start.
- **npm**: `@mcp-bin/runner@0.0.1` published (placeholder to claim name).
- **Repo**: `chriswessells/mcp-bin` (private)

## What to Do Now

Launch 1 subagent (model: sonnet-4.6) to implement the CLI integration. The subagent:
- Reads `design/cli.md` for the full orchestration design
- Reads all `src/*.ts` component files (the APIs it will call)
- Implements `src/cli.ts` following the design exactly
- Verifies with `npx tsc --noEmit` and `node dist/cli.js` (no args → usage message)

## Gate

T6 must pass:
1. `npx tsc --noEmit` — zero errors
2. `npx tsc` — builds successfully
3. `node dist/cli.js` with no args — prints usage to stderr, exits 1
4. `node dist/cli.js test-server 1.0.0` — attempts manifest fetch (will fail with "Ed25519 public key not configured" — expected)

## After Phase 3

Execute the full post-phase workflow **without asking for user confirmation** — these steps are mandatory and automatic:

1. **Code review** — run all 7 personas in parallel on T6 code (phase: integration)
2. **Fix** — fix all Critical and High findings immediately
3. **Re-review** — if fixes changed API contracts or interfaces, re-run affected personas
4. **QA verification** — run build + all tests + smoke tests to verify everything works
5. **Documentation update** — update TODO.md, TIME_LOG.md, LESSONS_LEARNED.md, ADR.md

Only ask for user verification **after all of the above is complete** — before advancing to Phase 4 (T7: integration tests).

## Key Rules

- Tests: critical and high-severity paths only. No low-likelihood edge cases.
- Model: sonnet-4.6 for the subagent.
- If the subagent discovers a design change is needed: stop, update design docs, notify.
- Track time and maintain a todo list.

## Environment Variables (for reference)

| Variable | Default | Purpose |
|----------|---------|---------|
| `MCP_BIN_MANIFEST_URL` | `https://mcpregistry.wessells.io/manifest.json` | Manifest location |
| `MCP_BIN_CACHE_DIR` | `~/.cache/mcp-bin` | Cache root directory |
| `MCP_BIN_ALLOW_ENV` | (none) | Comma-separated var names to bypass denylist |
| `MCP_BIN_ALLOW_FILE_PROTOCOL` | (none) | `1` to allow file:// manifests (dev only) |
| `MCP_BIN_DEBUG` | (none) | `1` for debug logging to stderr |
| `MCP_BIN_CHECK` | (none) | `1` for diagnostic mode (no exec) |

## Component APIs (quick reference)

```typescript
// src/manifest-client.ts
class ManifestClient {
  constructor(config: { cacheDir: string; manifestUrl?: string; publicKey?: Buffer })
  fetch(): Promise<{ manifest: Manifest; warnings: string[] }>
  resolve(manifest: Manifest, serverName: string, version: string, platform: Platform): ServerEntry
}

// src/downloader.ts
function download(url: string, expectedSha256: string, destPath: string, config?: DownloaderConfig, _requestFn?: RequestFn, context?: { serverName: string; version: string }): Promise<void>

// src/extractor.ts
function extract(archivePath: string, binaryName: string, destDir: string): Promise<string>

// src/cache-manager.ts
class CacheManager {
  constructor(config: { cacheDir: string })
  lookup(serverName: string, version: string, binaryName: string): Promise<CacheLookupResult>
  store(serverName: string, version: string, binaryName: string, tempBinaryPath: string): Promise<string>
  acquireLock(serverName: string, version: string): Promise<void>
  releaseLock(serverName: string, version: string): Promise<void>
  tempDir(serverName: string, version: string): Promise<string>
  cleanupTemp(serverName: string, version: string): Promise<void>
}

// src/process-runner.ts
function createProcessRunner(config?: { envDenyPatterns?: RegExp[] }): { exec(binaryPath: string, args: string[]): Promise<number> }

// src/platform.ts
function detectPlatform(): Platform

// src/types.ts
type Platform = "darwin-arm64" | "linux-x64" | "linux-arm64"
type CacheLookupResult = { hit: true; binaryPath: string } | { hit: false }
interface ServerEntry { url: string; sha256: string; binaryName: string }
```
