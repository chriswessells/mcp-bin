# Maintainability Review — mcp-bin Runner

**Reviewer**: maintainability-review agent
**Date**: 2026-05-02
**Scope**: All design documents, requirements, ADRs, and implementation plan

---

## Summary

The design is well-structured for a solo-maintained project. The module boundaries are clean, the single external dependency is justified, and the ADRs document key tradeoffs. The implementation plan is realistic and parallelizable. Below are findings that will cause maintenance pain if unaddressed.

---

## Findings

### 1. Manifest cache TTL is a magic number buried in implementation

**Severity**: Medium
**Location**: `design/manifest-client.md`, Fetch Flow step 2; `design/cli.md`, component instantiation
**Issue**: The 1-hour TTL is hardcoded in the ManifestClient design with no configuration path. It appears in prose but not in `ManifestClientConfig`. If you need to change it (e.g., for testing or during an incident), you must modify source code.
**Consequence**: During a manifest rollback or security incident, you cannot shorten the TTL without a code change and npm publish.
**Recommendation**: Add `cacheTtlMs: number` to `ManifestClientConfig` with a default of `3_600_000`. This costs one line and makes testing trivial (set TTL to 0).

---

### 2. Env var denylist is not extensible without code changes

**Severity**: Medium
**Location**: `design/process-runner.md`, Environment Variable Filtering section; ADR-010
**Issue**: The denylist patterns are hardcoded. If a user's MCP server needs `AWS_REGION` (which matches `/^AWS_/`), there's no override mechanism. The design acknowledges Kiro's `environmentVariables` array isn't available at runtime.
**Consequence**: Users will file issues asking how to pass `AWS_REGION` or `AWS_DEFAULT_REGION` to their server. You'll need a code change or a new env var like `MCP_BIN_ALLOW_ENV`.
**Recommendation**: This touches ADR-010. Flag for Chief Architect Engineer: consider adding `MCP_BIN_ALLOW_ENV` (comma-separated list of env var names to exempt from filtering) as a low-cost escape hatch. Alternatively, refine the denylist to target credential-bearing vars more precisely (e.g., `/^AWS_SECRET/`, `/^AWS_SESSION/` instead of `/^AWS_/`).

---

### 3. No version pinning for `tar-stream` in design

**Severity**: High
**Location**: `design/plan.md`, T0 Scaffolding; `design/architecture.md`, Dependencies table
**Issue**: The plan specifies `"tar-stream": "^3.1.7"` — a caret range. `tar-stream` is the only external dependency and handles untrusted archive data (security-critical path). A breaking change or supply-chain compromise in a minor/patch version would auto-propagate.
**Consequence**: A compromised or buggy `tar-stream` 3.2.x gets pulled in on next `npm install`, potentially bypassing path traversal protections.
**Recommendation**: Pin exact version: `"tar-stream": "3.1.7"`. Use `npm audit` and Dependabot for controlled upgrades. For a security-critical single dependency, exact pinning is worth the manual update cost.

---

### 4. Lock file PID check is unreliable across reboots and PID recycling

**Severity**: Low
**Location**: `design/cache-manager.md`, Locking section
**Issue**: The stale lock detection checks if the PID is alive via `process.kill(pid, 0)`. PIDs recycle — after a reboot or on a busy system, a different process may hold the same PID. The 10-minute age check mitigates this, but there's a window where a recycled PID prevents lock breaking.
**Consequence**: Rare edge case where a user gets E14 and must manually delete `.lock`. Acceptable for v1 but worth documenting.
**Recommendation**: Add a note in the error message for E14 suggesting manual deletion of the lock file path. Consider storing a boot ID or timestamp in the lock file for future robustness.

---

### 5. No structured logging or debug mode in v1

**Severity**: Medium
**Location**: `spec/requirements.md`, F5 (future); `design/cli.md`
**Issue**: F5 defers `--verbose` / `MCP_BIN_VERBOSE=1` to the future. Without it, debugging production issues requires reading source code to understand what step failed. The error messages (E1–E15) are good, but transient issues (retries, cache misses, fallback to cached manifest) produce no output.
**Consequence**: When a user reports "it's slow" or "it sometimes fails", you have no diagnostic path except asking them to reproduce with modified source.
**Recommendation**: Add a minimal `debug()` function that writes to stderr when `MCP_BIN_DEBUG=1` is set. Gate it behind a single env var check. This is ~10 lines of code and dramatically improves supportability. Not a design change — just an implementation detail in T0.

---

### 6. Integration tests require a local HTTPS server with valid TLS

**Severity**: Medium
**Location**: `design/plan.md`, T7 Integration Tests
**Issue**: The integration test plan requires a local HTTPS server. Node's `https.createServer` needs a self-signed cert, and the downloader enforces HTTPS. The test setup must either disable cert verification in test mode or generate certs — both add complexity and potential flakiness.
**Consequence**: Integration tests become the most fragile part of the CI pipeline. Self-signed cert expiry, platform-specific TLS behavior, and port conflicts cause spurious failures.
**Recommendation**: Design the Downloader to accept an optional `agent` or `rejectUnauthorized` parameter (test-only, not exposed in production config). Alternatively, use `file://` URLs for integration tests where possible and reserve HTTPS testing for a smaller focused test. Document the test TLS setup clearly.

---

### 7. No explicit cleanup of orphaned temp directories

**Severity**: Low
**Location**: `design/cache-manager.md`, Temp Directory section; `design/cli.md`, signal handlers
**Issue**: If the process is killed with SIGKILL (uncatchable), the `.tmp` directory persists forever. There's no startup sweep or periodic cleanup.
**Consequence**: Disk space accumulates over months. Not critical for a single user, but confusing when debugging cache issues.
**Recommendation**: On `CacheMiss`, before acquiring the lock, check if `.tmp` exists and remove it (it's from a previous failed run). This is safe because the lock hasn't been acquired yet — if another process is active, it holds the lock and the current process will wait.

---

### 8. The `update-manifest.sh` script has no tests in CI

**Severity**: Medium
**Location**: `design/plan.md`, T8 Author Tooling
**Issue**: T8 says "Tested manually with a sample release." The shell script manipulates the manifest (the trust root for the entire system) but has no automated tests. A typo in `jq` logic could produce an invalid manifest that passes signing but breaks resolution.
**Consequence**: A bad manifest push breaks all users. You discover it when someone reports E1/E2/E3 errors.
**Recommendation**: Add a simple test in CI: run `update-manifest.sh` against a fixture, diff the output against an expected manifest. This is a 10-line shell test that prevents the highest-impact failure mode.

---

### 9. No manifest schema validation beyond `schema_version`

**Severity**: Medium
**Location**: `design/manifest-client.md`, Fetch Flow step 6; `spec/requirements.md`, R28
**Issue**: The design checks `schema_version === 1` but does no structural validation of the manifest body. A manifest with a typo (`"serers"` instead of `"servers"`) passes signature verification and schema version check, then causes a confusing `E1` error.
**Consequence**: Debugging manifest authoring errors is painful. The error says "Server not found" when the real problem is a malformed manifest.
**Recommendation**: Add minimal structural validation after parsing: check that `manifest.servers` is an object. Optionally validate that entries have `url`, `sha256`, and `binary_name` fields. This is 5–10 lines and produces much better error messages for authors.

---

### 10. Signal handler phase transition is implicit and error-prone

**Severity**: Medium
**Location**: `design/cli.md`, Signal Handler Phases section
**Issue**: The CLI must manually remove download-phase handlers and rely on ProcessRunner installing its own. If a future code change reorders operations or adds a step between phases, signals may be mishandled (e.g., cleanup runs after spawn, corrupting stdio).
**Consequence**: A subtle bug where SIGINT during the transition window causes undefined behavior. Hard to reproduce, hard to test.
**Recommendation**: Make the phase transition explicit: have `processRunner.exec()` accept a callback or return a "ready" signal that the CLI uses to deregister its handlers. Or simpler: have the CLI remove its handlers immediately before calling `exec()`, and document this as a critical ordering constraint with a code comment.

---

### 11. No health check or self-test command

**Severity**: Low
**Location**: General (not in any design file)
**Issue**: There's no way to verify the installation works without actually downloading a server. If the manifest URL is wrong, the signing key is mismatched, or the cache dir is unwritable, the user discovers this only when trying to use a server.
**Consequence**: Support burden — users report "it doesn't work" with no diagnostic information.
**Recommendation**: Consider a `mcp-bin-runner --check` flag (exception to ADR-006's "no flags" rule — this doesn't conflict with forwarded args since it's before the server name). It would: verify manifest fetch, verify signature, check cache dir writability, and exit 0. Low priority but high supportability value.

---

### 12. Plan estimates are optimistic for test infrastructure

**Severity**: Low
**Location**: `design/plan.md`, Time Estimate Summary
**Issue**: T7 (integration tests) is estimated at 60 minutes but requires: generating Ed25519 keypairs, creating test archives, running a local HTTPS server, spawning CLI as child processes, and testing concurrency. This is typically 2–3x the estimate.
**Consequence**: You'll either rush the integration tests (making them brittle) or blow the schedule.
**Recommendation**: Accept that T7 will take 2–3 hours. Consider splitting it: T7a (test infrastructure setup) and T7b (actual test cases). This makes progress visible and allows shipping with partial integration coverage.

---

## Positive Observations

- **Single external dependency** (`tar-stream`) is an excellent choice for maintainability. The design maximizes use of Node.js built-ins.
- **ADRs are well-written** — each captures context, decision, and tradeoff. Future-you will thank present-you.
- **Component boundaries are clean** — no component imports another. The CLI is the sole orchestrator. This makes unit testing straightforward.
- **Error codes are comprehensive** — E1–E15 cover every failure mode with user-friendly messages.
- **The plan's DAG structure** enables parallel implementation and clear dependency tracking.
- **Security posture is strong** for a v1 — Ed25519 signing, path traversal protection, env var filtering, URL sanitization.

---

## Priority Summary

| # | Severity | Quick Fix? | Finding |
|---|----------|-----------|---------|
| 3 | High | Yes | Pin `tar-stream` exact version |
| 8 | Medium | Yes | Add CI test for `update-manifest.sh` |
| 9 | Medium | Yes | Add minimal manifest structure validation |
| 1 | Medium | Yes | Make cache TTL configurable |
| 5 | Medium | Yes | Add `MCP_BIN_DEBUG=1` stderr logging |
| 6 | Medium | No | Design test TLS strategy |
| 10 | Medium | No | Explicit signal phase transition |
| 2 | Medium | No | Env var denylist escape hatch (consult Chief Architect Engineer — touches ADR-010) |
| 7 | Low | Yes | Clean orphaned `.tmp` on cache miss |
| 4 | Low | Yes | Improve E14 error message |
| 11 | Low | No | Self-test command (consult Chief Architect Engineer — touches ADR-006) |
| 12 | Low | No | Adjust T7 time estimate |
