# Session Resume — v1.x Community Onboarding

## Current State

On branch `feature/v1x-community-onboarding`. Ready to run the full development workflow against the spec.

## What's Done

1. **Spec written and reviewed**: `spec/v1x-community-onboarding.md` — 8 changes (C1–C8), reviewed by all 7 personas, all 15 high/critical findings resolved.
2. **GitHub Issues created**:
   - #1 — Better fix for npx resolving to local source instead of published package
   - #2 — Make manifest verification public key configurable via env var
3. **Agent configs updated** (in `~/code/kiro-shared-context/agents/`):
   - `developer.json` — added `fs_write`, `execute_bash` to `allowedTools`
   - `architect.json` — added `fs_write` to `allowedTools`
   - `qa.json` — added `execute_bash` to `allowedTools`
   - `red-lens.json` — added `execute_bash` to `allowedTools`

## Next Step

Run the full development workflow against `spec/v1x-community-onboarding.md`. The spec is already reviewed — skip Phase 1 (design from scratch) and Phase 2 (spec review). The architect should read the spec and produce the design/plan, then proceed through the normal workflow.

Command: **"Run the workflow against spec/v1x-community-onboarding.md"**

## Key Context

- This is a TypeScript/Node.js project. Build: `npx tsc`. Tests: `node --import tsx --test tests/*.test.ts`.
- The spec has 8 changes: configurable public key (C1), latest alias (C2), cache eviction (C3), verbose logging (C4), self-hosting guide (C5), JSON schema (C6), README enhancements (C7), update-manifest.sh help (C8).
- The spec includes implementation notes, security considerations, and a review resolution log at the bottom.
- No design docs exist yet for v1.x — the architect needs to produce them.
