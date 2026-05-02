# T5 Patch: Reliability Requirements

## INSERT AFTER: R14 (in "### 1. Runner" → "#### Requirements")

```
- R15: Use atomic write semantics for cache population: download to a temporary file in the cache directory, verify the SHA256 checksum, then atomically rename into the final cache path. Never write directly to the final path.
- R16: On cache hit, verify the cached binary's SHA256 checksum before execution. Re-download on mismatch.
- R17: Use file-based locking (e.g., `<cache-path>.lock`) to prevent concurrent downloads of the same server+version by multiple processes.
- R18: Specify a connect timeout of 5 seconds and a response timeout of 30 seconds for manifest fetches. Specify a total download timeout of 5 minutes for binary downloads.
- R19: Retry transient failures (HTTP 5xx, TCP reset, TLS handshake timeout) with exponential backoff: 3 attempts with 1s/2s/4s delays. Do not retry 4xx errors.
- R20: Install signal handlers for SIGTERM and SIGINT during the download/verify phase that clean up temporary files before exit. After exec, use process replacement (execve semantics) so signals are delivered directly to the child.
- R21: Forward SIGTERM and SIGINT to the child process if using spawn instead of exec. Wait for the child to exit before exiting the runner.
```

**Note:** All subsequent requirements (currently R15–R29) must be renumbered to R22–R36.

---

## INSERT AFTER: E7 (in "## Error Handling")

```
- E8: Download timeout → exit 1, stderr: "Download timed out after <N>s: <url>"
- E9: All retries exhausted → exit 1, stderr: "Failed after <N> retries: <url>"
```
