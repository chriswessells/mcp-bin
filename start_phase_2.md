# Start Phase 2 — Parallel Component Implementation

## First Steps

1. Retrieve memory records for actor_id "chris" — namespaces `/user/preferences`, `/user/workflow`, `/system/workflows`.
2. Read `agents/AGENTS.md` for the development workflow and review process.
3. Read `design/plan.md` for subagent instructions (sections: T1–T5).
4. Read the T0 scaffolding files: `src/types.ts`, `src/errors.ts`, `src/platform.ts`.

## Current Status

- **Phase 1 (T0)**: ✅ Complete — scaffolding, code review (0 Critical/High), QA verified, docs updated.
- **Phase 2 (T1–T5)**: Ready to start.
- **Repo**: `chriswessells/mcp-bin` (private)

## What to Do Now

Launch 5 parallel subagents (model: sonnet-4.6) to implement the core components. Each subagent:
- Reads its component design doc from `design/`
- Reads `src/types.ts` and `src/errors.ts` (shared interfaces)
- Implements the component following the API contract exactly
- Writes unit tests in `tests/` (critical and high-severity paths only)
- Verifies with `npx tsc --noEmit` and `node --test`

## Subagent Assignments

| Track | Task | Component | Design Doc | Output Files |
|-------|------|-----------|------------|--------------|
| A | T1 | Downloader | `design/downloader.md` | `src/downloader.ts`, `tests/downloader.test.ts` |
| B | T2 | Extractor | `design/extractor.md` | `src/extractor.ts`, `tests/extractor.test.ts` |
| C | T3 | Cache Manager | `design/cache-manager.md` | `src/cache-manager.ts`, `tests/cache-manager.test.ts` |
| D | T4 | Manifest Client | `design/manifest-client.md` | `src/manifest-client.ts`, `tests/manifest-client.test.ts` |
| E | T5 | Process Runner | `design/process-runner.md` | `src/process-runner.ts`, `tests/process-runner.test.ts` |

## Subagent Prompts

Full prompts are in `design/plan.md` under "Subagent Instructions" — sections titled:
- "Subagent: Downloader (T1)"
- "Subagent: Extractor (T2)"
- "Subagent: Cache Manager (T3)"
- "Subagent: Manifest Client (T4)"
- "Subagent: Process Runner (T5)"

## Gate

All 5 must pass:
1. `npx tsc --noEmit` — zero errors
2. `node --test tests/<component>.test.ts` — all tests pass

## After Phase 2

Execute the full post-phase workflow **without asking for user confirmation** — these steps are mandatory and automatic:

1. **Code review** — run all 7 personas in parallel on T1–T5 code (phase: implementation)
2. **Fix** — fix all Critical and High findings immediately
3. **Re-review** — if fixes changed API contracts or interfaces, re-run affected personas
4. **QA verification** — run build + all tests + smoke tests to verify everything works
5. **Documentation update** — update TODO.md, TIME_LOG.md, LESSONS_LEARNED.md, ADR.md

Only ask for user verification **after all of the above is complete** — before advancing to Phase 3 (T6: CLI integration).

## Key Rules

- Tests: critical and high-severity paths only. No low-likelihood edge cases.
- Model: sonnet-4.6 for all subagents.
- If a subagent discovers a design change is needed: stop, update design docs, notify others.
- Each subagent tracks time and maintains a todo list.

## Environment Variables (for reference)

| Variable | Default | Purpose |
|----------|---------|---------|
| `MCP_BIN_MANIFEST_URL` | `https://chriswessells.github.io/mcp-bin/manifest.json` | Manifest location |
| `MCP_BIN_CACHE_DIR` | `~/.cache/mcp-bin` | Cache root directory |
| `MCP_BIN_ALLOW_ENV` | (none) | Comma-separated var names to bypass denylist |
| `MCP_BIN_ALLOW_FILE_PROTOCOL` | (none) | `1` to allow file:// manifests (dev only) |
| `MCP_BIN_DEBUG` | (none) | `1` for debug logging to stderr |
| `MCP_BIN_CHECK` | (none) | `1` for diagnostic mode (no exec) |
