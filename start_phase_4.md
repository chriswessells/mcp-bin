# Start Phase 4 — Integration Tests

## First Steps

1. Retrieve memory records for actor_id "chris" — namespaces `/user/preferences`, `/user/workflow`, `/system/workflows`.
2. Read `agents/AGENTS.md` for the development workflow and review process.
3. Read `design/plan.md` for subagent instructions (section: "Subagent: Integration Tests (T7)").
4. Read all `src/*.ts` source files (the code being tested).
5. Read `spec/requirements.md` (testing section T1–T11).

## Current Status

- **Phase 1 (T0)**: ✅ Complete — scaffolding, code review, QA verified.
- **Phase 2 (T1–T5)**: ✅ Complete — 5 core components, code review (0 Critical/High remaining), 38 tests pass, QA verified, docs updated.
- **Phase 3 (T6)**: ✅ Complete — CLI integration, code review (0 Critical/High remaining), 38 tests pass, QA verified, docs updated.
- **npm**: `@mcp-bin/runner@0.0.1` published (placeholder to claim name).
- **Repo**: `chriswessells/mcp-bin` (private)

## What to Do Now

Launch 1 subagent (model: sonnet-4.6) to implement the integration tests. The subagent:
- Reads `spec/requirements.md` testing section (T2–T11)
- Reads all `src/*.ts` files (the APIs being tested end-to-end)
- Creates `tests/integration.test.ts` with test infrastructure (local HTTPS server, Ed25519 keypair, test binary, signed manifest)
- Implements 10 integration tests covering the critical paths
- Verifies with `node --import tsx --test tests/integration.test.ts`

## Gate

T7 must pass:
1. `npx tsc --noEmit` — zero errors
2. `node --import tsx --test tests/integration.test.ts` — all integration tests pass
3. `node --import tsx --test tests/*.test.ts` — all 38 unit tests + integration tests pass

## After Phase 4

Execute the full post-phase workflow **without asking for user confirmation** — these steps are mandatory and automatic:

1. **Code review** — run all 7 personas in parallel on T7 code (phase: integration)
2. **Fix** — fix all Critical and High findings immediately
3. **Re-review** — if fixes changed API contracts or interfaces, re-run affected personas
4. **QA verification** — run build + all tests + smoke tests to verify everything works
5. **Documentation update** — update TODO.md, TIME_LOG.md, LESSONS_LEARNED.md, ADR.md

Only ask for user verification **after all of the above is complete** — before advancing to Phase 5 (T9: key generation).

## Key Rules

- Tests: critical and high-severity paths only. No low-likelihood edge cases.
- Model: sonnet-4.6 for the subagent.
- If the subagent discovers a design change is needed: stop, update design docs, notify.
- Track time and maintain a todo list.
- Test runner: `node --import tsx --test` (tsx is a devDependency).

## Test Infrastructure Required

The integration tests need:
1. A local HTTPS server serving a test manifest and test archives
2. An Ed25519 keypair for signing the test manifest
3. A test binary: a shell script that echoes its args and exits 0
4. The test binary packaged into a `.tar.gz` archive
5. SHA256 of the archive computed
6. A signed manifest pointing to the local server
7. `MCP_BIN_MANIFEST_URL` and `MCP_BIN_CACHE_DIR` set to test values
8. The CLI run as a child process for each test

## Tests to Implement (from spec T2–T11)

| # | Test | Expected |
|---|------|----------|
| 1 | Full cycle: download, cache, execute | Binary runs, outputs args |
| 2 | Cache hit: second run, no HTTP | Server request count = 0 |
| 3 | Checksum mismatch | E5 error |
| 4 | Missing platform | E3 error |
| 5 | Concurrent invocations (3 processes) | All succeed, no corruption |
| 6 | Download timeout | E8 error |
| 7 | Path traversal archive | E12 error |
| 8 | Invalid binary_name | E11 error |
| 9 | Stale lock broken | Succeeds after breaking lock |
| 10 | Corrupted cache triggers re-download | Binary re-downloaded and runs |

## Environment Variables (for reference)

| Variable | Default | Purpose |
|----------|---------|---------|
| `MCP_BIN_MANIFEST_URL` | `https://mcpregistry.wessells.io/manifest.json` | Manifest location |
| `MCP_BIN_CACHE_DIR` | `~/.cache/mcp-bin` | Cache root directory |
| `MCP_BIN_ALLOW_FILE_PROTOCOL` | (none) | `1` to allow file:// manifests (dev only) |
| `MCP_BIN_DEBUG` | (none) | `1` for debug logging to stderr |
