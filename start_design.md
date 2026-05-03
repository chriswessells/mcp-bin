# Start Design — mcp-bin

## First Steps

1. Retrieve memory records for actor_id "chris" — namespaces `/user/preferences`, `/user/workflow`, `/system/workflows`.
2. Read `agents/AGENTS.md` for the development workflow.
3. Read `spec/requirements.md` for the approved spec (41 requirements, 12 security rules, 15 error codes, 11 tests).

## Current Status

- **Phase**: Spec complete and approved. Ready for design (Phase 3 per AGENTS.md).
- **Spec reviews**: Two rounds of review by all 7 personas. Zero Critical/High findings remain.
- **Repo**: `chriswessells/mcp-bin` (private)

## What to Produce

Per AGENTS.md Phase 3 (Design) and Phase 4 (Plan):

1. **Architecture design** (`design/architecture.md`) — component boundaries, data flow, API contracts between components
2. **Component designs** — one per component with interfaces, error handling, and implementation details
3. **Plan** (`design/plan.md`) — ordered task list with acceptance criteria, DAG for parallel execution, subagent instructions
4. API contracts must be defined so components can be developed in parallel by subagents.

## Key Decisions Already Made

- **Runtime**: Node.js (npm package, runs via `npx`)
- **Language**: TypeScript (implied by npm ecosystem)
- **Archive format**: `.tar.gz` only (no .zip, no Windows)
- **Platforms**: `darwin-arm64`, `linux-x64`, `linux-arm64`
- **Manifest signing**: Ed25519 detached signature (`.sig` file)
- **Cache integrity**: `.sha256` sidecar file written at extraction, verified on cache hit
- **Locking**: File-based with PID, 60s wait, 10-minute stale auto-break
- **Signal handling**: `child_process.spawn` with signal forwarding (no execve in Node.js)
- **Config**: Environment variables only (no CLI flags for runner config)
- **Manifest hosting**: GitHub Pages default (`https://mcpregistry.wessells.io/manifest.json`)
- **Author tooling**: Shell script (`update-manifest.sh`) using `jq` and `curl`
- **No Windows in v1**

## After Design

Per AGENTS.md, the design must be reviewed by all 7 personas before coding begins. Use subagents with model `sonnet-4.6` for task execution.
