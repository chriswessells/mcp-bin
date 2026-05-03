# Chief Architect Engineer — Final Plan Review

**Date**: 2026-05-02
**Verdict**: **APPROVED — proceed to implementation.**

The plan is tight, the DAG is correct, and the subagent instructions are precise enough to execute without follow-up. This is a well-scoped v1.

---

## Scope Creep Check

**No scope creep detected.** The plan builds exactly what the spec requires and nothing more:
- Single external dependency (tar-stream)
- Three platforms (no Windows)
- .tar.gz only (no .zip)
- Shell script for author tooling (no CLI tool, no GitHub Action)
- Env vars only (no CLI flags for runner config)

The `MCP_BIN_CHECK` diagnostic mode and `MCP_BIN_ALLOW_ENV` escape hatch are minimal additions that solve real customer problems without expanding the surface area. Good two-way doors.

---

## Missing Essentials Check

**Nothing blocking.** All critical-path items are covered:
- ✅ Manifest fetch + signature verification
- ✅ Cache with integrity verification
- ✅ Atomic writes + locking
- ✅ Download with retry/timeout/checksum
- ✅ Extraction with security hardening
- ✅ Process exec with signal forwarding
- ✅ Integration tests covering spec T2–T11
- ✅ Author tooling for manifest updates
- ✅ Key generation and signing

**One minor gap**: T10 (README + docs) has no subagent instructions in the plan. It's listed in the phase table as "Independent, anytime" but has no prompt block. Not blocking — it's obvious work — but add a one-paragraph instruction before kicking off implementation so it doesn't get forgotten.

---

## Ordering / DAG Check

**DAG is correct.** No hidden dependencies detected.

- T0 produces shared types/errors that all components import — correct gate.
- T1–T5 are genuinely independent (they share only types.ts/errors.ts, no cross-imports).
- T6 correctly depends on all five components.
- T7 correctly depends on T6 (needs the built CLI).
- T9 depends on T4 (needs manifest-client to pin the key) — correct.
- T8 is truly independent (shell script, no TypeScript imports).

**One sequencing note**: T9 modifies `src/manifest-client.ts` (replaces placeholder key). If T7 runs before T9, integration tests will fail signature verification unless they generate their own test keypair. The plan handles this correctly — T7's instructions say "Generate an Ed25519 keypair for signing the test manifest" in the test setup. Good. T9 is for the *production* key, not the test key.

---

## Subagent Instruction Quality

**Good enough to execute.** Each prompt:
- References the exact design files to read
- Lists concrete acceptance criteria
- Specifies the verification command (`tsc --noEmit` + `node --test`)
- Names the exact file paths to create

**Minor improvements** (non-blocking):
1. T1 (Downloader): The instruction says "Mock HTTP with a local HTTPS server or by mocking the https module" — this is slightly ambiguous. A subagent might waste time deciding. Recommend: "Use node:test mock module to mock the https.request function." But either approach works, so not blocking.
2. T3 (Cache Manager): The stale lock test says "hold a lock in a subprocess" — good, but should specify "use a short timeout (e.g., 2s) for the test to avoid slow tests." Already partially there ("use a short timeout for testing").
3. T6 (CLI): Should explicitly mention implementing `MCP_BIN_CHECK` diagnostic mode and `MCP_BIN_DEBUG` logging, since these were added post-design-review. The cli.md design file should cover them, but the subagent prompt doesn't call them out.

---

## ADR Compliance

| ADR | Status |
|-----|--------|
| ADR-001: npm distribution | ✅ Package named `@mcp-bin/runner`, invoked via npx |
| ADR-002: TypeScript | ✅ tsconfig.json with strict mode |
| ADR-003: .tar.gz only, no Windows | ✅ Three platforms, tar-stream only |
| ADR-004: Ed25519 signing | ✅ T4 + T9 implement full chain |
| ADR-005: .sha256 sidecar | ✅ Cache manager stores and verifies sidecar |
| ADR-006: Env vars only (+ amendment) | ✅ No CLI flags. MCP_BIN_CHECK as env var. |
| ADR-007: Shell script tooling | ✅ T8 is update-manifest.sh with jq/curl |
| ADR-008: GitHub Pages hosting | ✅ Default URL in architecture.md |
| ADR-009: spawn + signal forwarding | ✅ Process runner uses spawn, not execve |
| ADR-010: Denylist (+ amendment) | ✅ MCP_BIN_ALLOW_ENV escape hatch included |

**Full compliance.**

---

## Ship Readiness

After all tasks complete (T0–T10), the project is shippable:
- npm package builds and runs
- Binary download/cache/exec pipeline works end-to-end
- Integration tests prove the critical paths
- Manifest can be signed and verified
- Author can update the manifest via shell script
- README provides quickstart

**What "shippable" means here**: `npm publish` and a user can add the JSON block to their config and it works. The only manual step remaining after implementation is: publish the npm package and host the manifest on GitHub Pages.

---

## Summary

| Check | Result |
|-------|--------|
| Scope creep | ✅ None |
| Missing essentials | ✅ None blocking (T10 instructions minor gap) |
| Ordering risks | ✅ DAG correct |
| Instruction quality | ✅ Sufficient (3 minor suggestions above) |
| ADR compliance | ✅ All 10 ADRs respected |
| Ship readiness | ✅ Yes |

**Decision: Ship it.**
