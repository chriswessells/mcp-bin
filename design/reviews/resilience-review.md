# Resilience Review — mcp-bin Runner

**Reviewer**: Chaos Engineering (resilience-review agent)
**Date**: 2026-05-02
**Scope**: All design documents, requirements, and ADRs

---

## Summary

The design is solid for a v1 CLI tool. The biggest systemic risks are: (1) the two-step rename in cache store is not truly atomic, (2) no circuit breaker on manifest/download endpoints, (3) the ProcessRunner silently swallows spawn failures with no observability, and (4) the lock mechanism has a TOCTOU race. Most findings are Medium severity — the system degrades to "re-download" rather than data corruption, which is an acceptable failure mode for a cache.

---

## Findings

### 1. Non-Atomic Two-File Cache Store

**Severity**: High
**Location**: `design/cache-manager.md` — Store Flow, steps 4–5
**Issue**: The store performs two sequential `rename()` calls: first the binary, then the sidecar. If the process is killed (SIGKILL, OOM, power loss) between step 4 and step 5, the cache contains a binary without its sidecar `.sha256` file.
**Cascade risk**: Next invocation calls `lookup()`, finds binary present but sidecar missing → returns CacheMiss → acquires lock → re-downloads. This is safe but wasteful. However, if a *third* process runs `lookup()` between steps 4 and 5, it also sees CacheMiss and may race to download.
**Recommendation**: Reverse the rename order — write the sidecar first, then the binary. A binary without a sidecar triggers re-download (safe). A sidecar without a binary also triggers re-download (safe). Alternatively, rename both into a staging directory first, then rename the directory itself (single atomic operation). The current design is *acceptable* because the failure mode is "unnecessary re-download" not "execute unverified binary."

---

### 2. Lock File TOCTOU Race

**Severity**: Medium
**Location**: `design/cache-manager.md` — Locking, Acquire step 3c/3e
**Issue**: Between reading the PID from the lock file, checking if the PID is alive, and deleting the lock file, another process may have already broken the same stale lock and acquired a new one. The sequence: Process A reads stale lock → Process B breaks stale lock and acquires → Process A deletes Process B's fresh lock → Process A acquires a second lock. Now two processes hold the "lock" simultaneously.
**Cascade risk**: Two concurrent downloads of the same server+version. Both will attempt `store()` with rename. On most filesystems, the last rename wins — the final state is consistent, but wasted bandwidth and CPU.
**Recommendation**: Use `rename()` to break stale locks instead of `unlink()` + re-create. Rename the stale lock to a unique name (e.g., `.lock.broken.<pid>`), then attempt `O_CREAT|O_EXCL` on `.lock`. If the `O_CREAT|O_EXCL` fails, another process won the race — back off and retry. Clean up `.lock.broken.*` files in `cleanupTemp()`.

---

### 3. No Retry Jitter — Thundering Herd

**Severity**: Medium
**Location**: `design/downloader.md` — Retry Logic
**Issue**: Retry delays are fixed at 1s/2s/4s with no jitter. If multiple runner instances start simultaneously (e.g., Kiro spawns 5 MCP servers at IDE startup), all will retry at the same wall-clock times, amplifying load on the manifest/download server during an outage.
**Cascade risk**: Prolongs outage recovery for the manifest host. GitHub Pages has rate limits; synchronized retries increase the chance of hitting them.
**Recommendation**: Add ±25% jitter to each retry delay. Implementation: `delay * (0.75 + Math.random() * 0.5)`. The design already notes "jitter is a backlog item" — recommend promoting this to v1 given the multi-instance startup scenario.

---

### 4. Manifest Fetch Has No Circuit Breaker

**Severity**: Medium
**Location**: `design/manifest-client.md` — Fetch Flow
**Issue**: Every invocation attempts a manifest fetch if the cache is stale (>1 hour). If the manifest host is down for an extended period, every single runner invocation pays the full timeout penalty (5s connect + 30s response = up to 35s) before falling back to cache. With 3 retries that's potentially 105s of blocking.
**Cascade risk**: IDE startup becomes extremely slow. Users perceive the tool as broken.
**Recommendation**: (1) The manifest fetch should NOT retry on failure — it has a fallback (cached manifest). A single attempt with timeout is sufficient. (2) Consider a "negative cache" — on fetch failure, write a marker file with a short TTL (e.g., 5 minutes) that suppresses re-fetch attempts. This acts as a simple circuit breaker.

**⚠️ ADR flag**: The retry strategy (R19) is defined for "transient failures" generically. Applying retries to manifest fetch vs. binary download should be differentiated. Recommend consulting the Chief Architect Engineer on whether manifest fetch should retry at all given the fallback-to-cache behavior.

---

### 5. ProcessRunner Silently Swallows Spawn Errors

**Severity**: Medium
**Location**: `design/process-runner.md` — Error Handling
**Issue**: If `spawn()` fails (binary not found, permission denied, corrupt ELF header), the runner returns exit code 1 with zero diagnostic output. The design explicitly states "Cannot write to stderr (R20), just resolve with exit code 1." The user sees a mysterious exit 1 with no explanation.
**Cascade risk**: No direct cascade, but severely impacts debuggability. Users will file bugs or abandon the tool.
**Recommendation**: The "no output after spawn" rule (R20) should apply *after a successful spawn*. If spawn itself fails (the `error` event fires synchronously before any child I/O), the runner has not yet yielded stdio to the child. It is safe to write a diagnostic to stderr in this case. Recommend: on spawn `error` event, write `"Failed to execute binary: <path> (<error.code>)"` to stderr, then exit 1.

**⚠️ ADR flag**: This interpretation of R20 may conflict with the strict reading in ADR-009. Recommend consulting the Chief Architect Engineer on whether pre-spawn errors can emit stderr.

---

### 6. No Integrity Check on Cached Manifest

**Severity**: Medium
**Location**: `design/manifest-client.md` — Fetch Flow, step 2
**Issue**: When the cached manifest is within TTL (< 1 hour), the design reads it and verifies the signature. But if the cache directory is on a shared filesystem or the disk has bit-rot, the cached manifest could be corrupted. The signature verification will catch tampering, but a corrupted `.sig` file could cause `verify()` to throw an unexpected error rather than returning false.
**Cascade risk**: Unhandled exception from `crypto.verify()` with malformed signature bytes could crash the process with a stack trace instead of a clean E10 error.
**Recommendation**: Wrap the `verify()` call in a try/catch. Any exception from the crypto layer should be treated as signature verification failure (E10), not an unhandled crash.

---

### 7. Download Timeout Counted as Retryable

**Severity**: Medium
**Location**: `design/downloader.md` — Retry Logic, "Transient errors (retryable)" list
**Issue**: "Abort due to overall timeout" is listed as retryable. The overall timeout is 5 minutes. If a download times out at 5 minutes and is retried 3 times, the worst case is 15+ minutes of blocking before failure. This is excessive for a tool that's supposed to start an MCP server.
**Cascade risk**: IDE appears hung. User kills the process, potentially leaving temp files and held locks.
**Recommendation**: Do NOT retry overall timeout. The 5-minute timeout is already generous. If the download can't complete in 5 minutes, retrying is unlikely to help (it suggests a bandwidth problem, not a transient glitch). Only retry connect timeout and response timeout. Throw E8 immediately on overall timeout.

---

### 8. Signal During Rename Leaves Partial State

**Severity**: Low
**Location**: `design/cli.md` — Signal Handler Phases
**Issue**: During the download phase, SIGTERM/SIGINT trigger cleanup of temp files. But if the signal arrives during `cacheManager.store()` (between the two renames), the cleanup function calls `cleanupTemp()` which removes `.tmp/` — but the first file has already been renamed to its final location. The cleanup doesn't remove the partially-stored final files.
**Cascade risk**: Orphaned binary without sidecar in cache. Next run sees CacheMiss, re-downloads. No corruption, just wasted space.
**Recommendation**: Accept this as a known edge case. Document that `lookup()` returning CacheMiss on sidecar-missing is the self-healing mechanism for this scenario. No code change needed — the system already recovers.

---

### 9. No Graceful Degradation on Disk Full

**Severity**: Low
**Location**: `design/cache-manager.md` — Store Flow; `design/downloader.md` — Download Flow
**Issue**: If the disk fills up during download or extraction, the error will be an `ENOSPC` from the write stream. This isn't classified in the error taxonomy (E1–E15) and will surface as "Unexpected error: ENOSPC" — unhelpful to users.
**Cascade risk**: None beyond the current invocation. But repeated invocations will all fail with the same unhelpful message.
**Recommendation**: Catch `ENOSPC` errors and surface a clear message: "Insufficient disk space in cache directory: <path>". Add this as E16 or handle it as a special case in the CLI catch-all.

---

### 10. Manifest .sig Fetch Failure with Stale Cached Sig

**Severity**: Low
**Location**: `design/manifest-client.md` — Fetch Flow, step 4
**Issue**: If the manifest is fetched successfully but the `.sig` fetch fails, the design falls back to the *cached* sig. This means a fresh manifest is verified against a *stale* signature. If the manifest was legitimately updated but the sig endpoint is temporarily down, the signature won't match → E10. The user is blocked until the sig endpoint recovers.
**Cascade risk**: Users cannot get manifest updates during partial CDN outages where the manifest file is served from cache but the .sig file returns 404/5xx.
**Recommendation**: If the manifest bytes are identical to the cached manifest bytes (byte-for-byte comparison), it's safe to use the cached sig. If the manifest bytes differ from cache and the sig fetch failed, throw E15 (not E10) — the error message should indicate the sig couldn't be fetched, not that verification failed. This gives the user actionable information.

---

### 11. No Health Check or Self-Test Mode

**Severity**: Low
**Location**: `design/cli.md` — overall
**Issue**: There's no way to verify the runner installation is working without actually downloading and running a server. If the manifest is unreachable, the signing key is wrong, or the cache directory is unwritable, the user discovers this only when trying to start a server.
**Cascade risk**: None (operational convenience issue).
**Recommendation**: Consider a `--check` or `--verify` flag (or `MCP_BIN_CHECK=1` env var to avoid ADR-006 conflict) that validates: manifest reachable, signature valid, cache directory writable, platform supported. Exit 0 on success, exit 1 with diagnostics on failure. Defer to Phase 2 if scope is a concern.

---

### 12. Env Var Denylist is Inherently Incomplete (ADR-010 Acknowledged)

**Severity**: Low
**Location**: `design/process-runner.md` — Environment Variable Filtering
**Issue**: The denylist approach (`AWS_*`, `GITHUB_TOKEN`, `*_SECRET`, `*_KEY`, `*_PASSWORD`) will miss secrets stored in non-standard env var names (e.g., `DATABASE_URL` with embedded credentials, `OPENAI_API_KEY` matching `*_KEY` but `ANTHROPIC_API_KEY` also matching — wait, that does match). The real gap is vars like `DATABASE_URL`, `REDIS_URL`, `MONGO_URI` that contain credentials in the URL.
**Cascade risk**: Credential leakage to untrusted binaries. The binary is signature-verified, so this is only a risk if the binary itself is malicious (which the signing chain should prevent) or if it logs env vars.
**Recommendation**: ADR-010 already acknowledges this tradeoff. For v1, add `/.*_URL$/` to the denylist to catch connection strings. For v2, consider an allowlist mode behind a flag. No ADR override needed — this is additive.

---

## Positive Observations

These aspects of the design demonstrate good resilience thinking:

1. **Cache-as-fallback for manifest**: The 1-hour TTL with fallback-to-any-age-cache means the system works offline after first successful fetch.
2. **Sidecar verification on every cache hit**: Detects bit-rot and tampering without re-downloading the manifest.
3. **Streaming extraction**: Never loads full archive into memory — handles large binaries without OOM.
4. **Same-filesystem rename for atomicity**: Correct use of POSIX rename semantics.
5. **Lock with PID and staleness detection**: Handles crashed processes without manual intervention.
6. **Three-layer timeout**: Connect/response/overall prevents indefinite hangs at each stage.
7. **Symlink and path traversal rejection**: Defense in depth with three independent checks.
8. **Signal handler phase transitions**: Clean separation between download-phase cleanup and exec-phase forwarding.

---

## Risk Matrix

| # | Severity | Self-Heals? | Data Loss? | User Action Required? |
|---|----------|-------------|------------|----------------------|
| 1 | High | Yes (re-download) | No | No |
| 2 | Medium | Yes (last rename wins) | No | No |
| 3 | Medium | No | No | No (perf issue) |
| 4 | Medium | Yes (cache fallback) | No | Wait |
| 5 | Medium | No | No | User confused |
| 6 | Medium | No (crash) | No | Re-run |
| 7 | Medium | No | No | Wait 15min |
| 8 | Low | Yes (re-download) | No | No |
| 9 | Low | No | No | Free disk space |
| 10 | Low | No | No | Wait for CDN |
| 11 | Low | N/A | No | No |
| 12 | Low | N/A | No | No |

---

## Recommendations Priority

**Must fix before v1** (High):
- #1: Reverse rename order (sidecar first, then binary) — 1 line change

**Should fix before v1** (Medium, high impact):
- #5: Allow stderr on spawn failure — improves debuggability dramatically
- #7: Don't retry overall timeout — prevents 15-minute hangs
- #4: Single attempt for manifest fetch (no retry) — has fallback already
- #6: Wrap crypto.verify() in try/catch — prevents unhandled crash

**Nice to have for v1** (Medium, low impact):
- #3: Add jitter to retry delays — simple implementation
- #2: Use rename-based stale lock breaking — more complex, current behavior is safe enough

**Defer to backlog** (Low):
- #8, #9, #10, #11, #12

---

## ADR Consultation Flags

Two findings suggest changes that may conflict with existing ADRs:

1. **Finding #5 vs ADR-009/R20**: The "no output after spawn" rule should be clarified to mean "no output after *successful* spawn." Pre-spawn errors should emit diagnostics. Recommend Chief Architect Engineer review.

2. **Finding #4 vs R19**: The retry policy (3 attempts with backoff) should not apply uniformly to manifest fetch and binary download. Manifest fetch has a fallback (cache); binary download does not. Recommend Chief Architect Engineer clarify whether R19 applies to manifest fetch.
