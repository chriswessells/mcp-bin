# Reliability Review — mcp-bin Runner

**Reviewer**: SRE Review (automated)
**Date**: 2026-05-02
**Scope**: All design documents in `design/`, `spec/requirements.md`, `agents/ADR.md`

---

## Summary

The design is well-considered for a solo-developer project. Atomic writes, sidecar checksums, file locking, and signal handling are all addressed. The primary reliability gaps are: (1) partial-rename atomicity during store, (2) no disk-space checks before writes, (3) manifest cache corruption leaving the system unable to self-heal, and (4) the ProcessRunner silently swallowing spawn errors with no observability path.

---

## Findings

### 1. Non-Atomic Two-File Store Creates a Corruption Window

**Severity**: Critical
**Location**: `design/cache-manager.md` — Store Flow, steps 4–5
**Issue**: The store operation performs two sequential `rename()` calls — first the binary, then the sidecar. If the process is killed (SIGKILL, OOM, power loss) between the two renames, the cache will contain a binary without its `.sha256` sidecar. On next lookup, this is treated as a CacheMiss, triggering re-download — which is the correct recovery. However, if the process is killed *after* the sidecar rename but *before* lock release, the lock file persists with a now-dead PID.
**Blast radius**: Next invocation must detect the stale lock (dead PID check). If PID recycling occurs (unlikely but possible on long-running systems), the lock may never be broken until the 10-minute timeout.
**Recommendation**: Rename the sidecar first, then the binary. A binary without a sidecar triggers re-download (safe). A sidecar without a binary also triggers re-download (safe). The current order is fine for correctness but document that the sidecar-first order is preferred because a sidecar without a binary is a smaller on-disk footprint to clean up. Additionally, consider writing a `.complete` sentinel file as the final step — lookup checks for all three files.

---

### 2. No Disk Space Checks Before Write Operations

**Severity**: High
**Location**: `design/downloader.md` — Download Flow; `design/cache-manager.md` — Store Flow; `design/extractor.md` — Extraction Flow
**Issue**: If the disk is full or the filesystem quota is exhausted, downloads will fail mid-stream, extraction will fail, or rename will fail. The current design has no pre-flight check and no specific error handling for `ENOSPC`.
**Blast radius**: Partial temp files left on disk (consuming the last remaining space). Subsequent retries will also fail. The user gets a generic "Failed to download" error with no indication that disk space is the root cause.
**Recommendation**: Catch `ENOSPC` errors explicitly and surface a clear message: "Insufficient disk space in cache directory: <path>". In the download phase, wrap the write stream error handler to detect `ENOSPC`. This doesn't require a pre-flight check — just better error classification.

---

### 3. Manifest Cache Corruption Has No Self-Healing Path

**Severity**: High
**Location**: `design/manifest-client.md` — Fetch Flow, step 2; Cache Layout
**Issue**: If the cached `manifest.json`, `manifest.json.sig`, or `manifest.json.meta` files are corrupted (disk error, partial write from a previous crash), the fetch flow attempts to verify the signature of corrupt data, fails, and treats it as a cache miss. This is correct. However, if the `.meta` file is corrupt (not valid JSON), `JSON.parse` will throw an unhandled error that is not one of the defined McpBinError types.
**Blast radius**: Unhandled exception → "Unexpected error" message with no actionable guidance. User must manually delete `~/.cache/mcp-bin/.manifest/` to recover.
**Recommendation**: Wrap `.meta` file parsing in a try/catch. On parse failure, treat the cache as stale (re-fetch). Log a warning: "Manifest cache metadata corrupted, re-fetching." This makes the system self-healing for all cache corruption scenarios.

---

### 4. ProcessRunner Silently Swallows Spawn Errors

**Severity**: High
**Location**: `design/process-runner.md` — Error Handling section
**Issue**: When `spawn()` fails (binary not found, permission denied, exec format error), the design returns exit code 1 with no output. The comment says "Cannot write to stderr (R20)". This means the user sees a silent exit 1 with zero diagnostic information.
**Blast radius**: User has no way to distinguish between "the MCP server crashed" and "the runner couldn't start the binary". Debugging requires manual inspection of the cache directory.
**Recommendation**: The R20 constraint ("no runner output after spawning the child process") should be interpreted as "after the child process is *successfully* spawned." If spawn itself fails, the child never existed, so writing to stderr is safe and necessary. Emit: "Failed to execute binary: <path>: <error.message>" to stderr before returning exit code 1. This does not violate MCP protocol integrity because no child is running.

---

### 5. Lock File PID Recycling Can Cause Deadlock

**Severity**: Medium
**Location**: `design/cache-manager.md` — Locking (R17), Acquire step 3b
**Issue**: The stale lock detection checks if the PID in the lock file is alive via `process.kill(pid, 0)`. On Linux, PIDs recycle. If a lock is left by a crashed process and the PID is reused by an unrelated process, the lock will appear "alive" and the 60-second timeout will fire instead of immediate stale-break.
**Blast radius**: 60-second delay on first invocation after a crash, if PID recycling has occurred. Not a data loss issue, but a latency surprise.
**Recommendation**: Add a secondary check: read the lock file's mtime. If the lock is older than 10 minutes (already specified in R17), break it regardless of PID liveness. The design already specifies this — ensure the implementation checks mtime *before* PID liveness, not after. Document that the 10-minute stale timeout is the authoritative guard, and PID check is an optimization for faster recovery within that window.

---

### 6. Signal Handlers During Download Phase Use Async Cleanup

**Severity**: Medium
**Location**: `design/cli.md` — Signal Handler Phases
**Issue**: The download-phase signal handler calls `await cleanupFn()` which is async. However, signal handlers in Node.js are synchronous — you cannot `await` inside them. If the cleanup involves async operations (fs.rm, etc.), the process may exit before cleanup completes.
**Blast radius**: Temp files left on disk after SIGTERM/SIGINT during download. Not a correctness issue (next run will work fine) but a disk hygiene issue.
**Recommendation**: Use synchronous fs operations (`fs.rmSync`) in signal handlers, or use `process.on('exit')` as a last-chance synchronous cleanup hook. Alternatively, register cleanup paths at the start and use `fs.rmSync` in the signal handler. The temp directory path is known before the async work begins.

---

### 7. No Timeout on Lock File I/O Operations

**Severity**: Medium
**Location**: `design/cache-manager.md` — Locking
**Issue**: The lock acquisition polls every 1 second for up to 60 seconds. But the individual file operations (`open`, `read`, `unlink`) have no timeout. On a hung NFS mount or FUSE filesystem, these operations can block indefinitely.
**Blast radius**: Runner hangs forever. The MCP client (Kiro) will eventually time out the npx process, but the user gets no feedback.
**Recommendation**: For v1 targeting local filesystems, this is acceptable. Document the assumption that `MCP_BIN_CACHE_DIR` must be on a local filesystem. Add a comment in the design noting that NFS/FUSE cache directories are unsupported. If this becomes a requirement later, use `AbortSignal.timeout()` on fs operations (Node 20+).

---

### 8. Manifest Fallback Has No Age Limit

**Severity**: Medium
**Location**: `design/manifest-client.md` — Fallback Behavior (R29)
**Issue**: On fetch failure, the design falls back to the cached manifest "any age." A manifest cached 6 months ago may reference URLs that no longer exist, versions that have been yanked, or checksums that don't match updated binaries.
**Blast radius**: User gets a download failure (E4 or E5) instead of a manifest fetch failure (E6). The error message is misleading — it points at the download URL rather than the stale manifest.
**Recommendation**: When using a fallback manifest, include the cache age in the warning: "Warning: using cached manifest (age: 3 days). Manifest fetch failed: <reason>". If the cache is older than 7 days, escalate the warning: "Warning: cached manifest is <N> days old and may be outdated." This gives the user enough context to diagnose downstream failures.

---

### 9. No Retry on Manifest Fetch (Only on Binary Download)

**Severity**: Medium
**Location**: `design/manifest-client.md` — Fetch Flow; `design/downloader.md` — Retry Logic
**Issue**: R19 specifies retry with exponential backoff for binary downloads, but the manifest fetch has no retry logic. A transient 503 from GitHub Pages will immediately fall back to the cached manifest (if available) or fail with E6.
**Blast radius**: On a fresh install with no cache, a single transient failure prevents the runner from working. The user must retry manually.
**Recommendation**: Apply the same retry policy (3 attempts, 1s/2s/4s) to manifest and .sig fetches. The manifest is small (<100KB typically), so retries add minimal latency. This is consistent with R19's intent.

---

### 10. Extractor Does Not Limit Extracted File Size

**Severity**: Medium
**Location**: `design/extractor.md` — Extraction Flow
**Issue**: The extractor streams the tar entry to disk without any size limit. A malicious manifest could point to an archive containing a multi-gigabyte file (zip bomb equivalent for tar.gz). The binary would be written to the temp directory until disk is full.
**Blast radius**: Disk exhaustion, affecting all processes on the system.
**Recommendation**: Add a maximum extracted file size (e.g., 500MB — generous for any reasonable MCP server binary). Abort extraction if the entry size exceeds the limit. The tar header contains the file size, so this can be checked before streaming.

---

### 11. No Observability for Successful Operations

**Severity**: Low
**Location**: `design/cli.md` — Orchestration Flow; `spec/requirements.md` — F5
**Issue**: The design only outputs errors to stderr. On a successful first-run download, the user sees nothing — the binary just starts. There's no indication that a download occurred, how long it took, or what version is running. F5 mentions `--verbose` / `MCP_BIN_VERBOSE=1` as a future consideration.
**Blast radius**: Difficult to diagnose slow startups or confirm which version is running. No audit trail.
**Recommendation**: Even without full verbose mode, emit a single line to stderr on cache miss: "mcp-bin: downloading <server> v<version> for <platform>..." This is consistent with how npx itself prints "Need to install the following packages" and does not interfere with MCP protocol traffic (which is on stdout).

---

### 12. Rename Across Filesystems Will Fail

**Severity**: Low
**Location**: `design/cache-manager.md` — Store Flow; `design/architecture.md` — Dependencies
**Issue**: The design states "rename() is atomic on the same filesystem. The temp directory is always under the same cache root, guaranteeing same-filesystem renames." This is correct as designed. However, if a user sets `MCP_BIN_CACHE_DIR` to a path on a different filesystem than the system temp directory, and the implementation uses `os.tmpdir()` instead of the cache-local `.tmp` directory, renames will fail with `EXDEV`.
**Blast radius**: Store operation fails, download is wasted, user gets an unclear error.
**Recommendation**: The design already mitigates this (temp dir is under cache root). Add a defensive check: if `rename()` throws `EXDEV`, fall back to copy+delete with a warning. Or simply document that `MCP_BIN_CACHE_DIR` must be on a single filesystem (which it will be in practice).

---

### 13. No Graceful Handling of Corrupt Archives

**Severity**: Low
**Location**: `design/extractor.md` — Extraction Flow
**Issue**: If the downloaded archive passes SHA256 verification but is not valid gzip or tar (e.g., the upstream accidentally uploaded a non-gzip file with the .tar.gz extension), the gunzip or tar-stream will throw an untyped error.
**Blast radius**: User sees "Unexpected error" instead of a clear message about archive corruption.
**Recommendation**: Catch errors from the gunzip/tar-stream pipeline and wrap them in a descriptive error: "Failed to extract archive for '<server>' v<version>: archive may be corrupt." This helps server authors diagnose packaging issues.

---

### 14. Environment Variable Denylist Is Incomplete (ADR-010 Acknowledged)

**Severity**: Low
**Location**: `design/process-runner.md` — Environment Variable Filtering; `agents/ADR.md` — ADR-010
**Issue**: The denylist approach (`AWS_*`, `GITHUB_TOKEN`, `*_SECRET`, `*_KEY`, `*_PASSWORD`) misses common sensitive patterns: `*_TOKEN` (beyond GITHUB_TOKEN), `*_CREDENTIALS`, `DATABASE_URL` (often contains passwords), `*_API_KEY` (doesn't match `*_KEY` if the var is `OPENAI_API_KEY` — wait, it does match `_KEY$`). Actually `OPENAI_API_KEY` matches `/_KEY$/`. But `SLACK_TOKEN`, `NPM_TOKEN`, `DOCKER_TOKEN` do not match.
**Blast radius**: Sensitive tokens leaked to child processes. The child is a binary the user chose to run, so this is partially mitigated by user intent.
**Recommendation**: **This is already decided in ADR-010.** Flag for the Chief Architect Engineer: consider adding `/_TOKEN$/` to the denylist. The current list misses `*_TOKEN` patterns which are extremely common for API credentials.

---

### 15. No Health Check or Self-Test Command

**Severity**: Low
**Location**: `design/cli.md`
**Issue**: There's no way for a user to verify their setup (manifest reachable, signature valid, cache writable) without attempting to run a real server.
**Blast radius**: Debugging configuration issues requires trial-and-error.
**Recommendation**: Consider a future `mcp-bin-runner --check` command that verifies: manifest fetch + signature, cache directory writable, platform supported. Not blocking for v1 but valuable for adoption.

---

## ADR Conflicts

| Finding | ADR | Recommendation |
|---------|-----|----------------|
| #4 (spawn error silence) | Relates to ADR-009 (spawn + signal forwarding) | No conflict — the ADR doesn't prohibit stderr on spawn failure. Clarify R20 interpretation. |
| #14 (denylist gaps) | ADR-010 (denylist approach) | Flag for Chief Architect Engineer: add `/_TOKEN$/` pattern. Does not overturn the denylist decision. |

---

## Risk Matrix

| # | Severity | Likelihood | Risk | Mitigation Effort |
|---|----------|-----------|------|-------------------|
| 1 | Critical | Low | Medium | Low (reorder renames) |
| 2 | High | Medium | High | Low (catch ENOSPC) |
| 3 | High | Low | Medium | Low (try/catch) |
| 4 | High | Medium | High | Low (stderr on spawn fail) |
| 5 | Medium | Low | Low | Low (check mtime first) |
| 6 | Medium | Medium | Medium | Low (use rmSync) |
| 7 | Medium | Very Low | Low | None (document assumption) |
| 8 | Medium | Medium | Medium | Low (add age to warning) |
| 9 | Medium | Medium | Medium | Medium (add retry loop) |
| 10 | Medium | Low | Low | Low (check tar header size) |
| 11 | Low | N/A | Low | Low (one stderr line) |
| 12 | Low | Very Low | Very Low | None (already mitigated) |
| 13 | Low | Low | Low | Low (catch + wrap) |
| 14 | Low | Low | Low | Consult Chief Architect Engineer |
| 15 | Low | N/A | Low | Defer to future |

---

## Recommendations Priority

**Must fix before implementation** (Critical/High):
1. #4 — Emit stderr on spawn failure (trivial fix, high diagnostic value)
2. #2 — Catch and surface ENOSPC errors
3. #3 — Handle corrupt `.meta` file gracefully

**Should fix during implementation** (Medium):
4. #6 — Use synchronous cleanup in signal handlers
5. #9 — Add retry to manifest fetch
6. #8 — Include cache age in fallback warning
7. #10 — Add max file size check in extractor

**Nice to have** (Low):
8. #11 — Single download progress line to stderr
9. #13 — Wrap extraction errors with context
10. #14 — Consult Chief Architect Engineer on `_TOKEN$` pattern
