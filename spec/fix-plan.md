# Spec Fix Plan — Critical & High Findings

## Tasks

### T1: Add value proposition and quickstart
**Fixes**: C4 (no value proposition), H12 (no quickstart)
**Dependencies**: None
**Estimated time**: 30 min

### T2: Cut Windows/zip, reduce platform matrix
**Fixes**: H10 (dual archive format), H16 (5 platforms → 2)
**Dependencies**: None
**Estimated time**: 20 min

### T3: Replace R21-R24 with simple script
**Fixes**: C6 (premature tooling), H11 (doubles maintenance), H14 (underspecified)
**Dependencies**: None
**Estimated time**: 20 min

### T4: Add security hardening requirements
**Fixes**: C1 (manifest signing), C2 (TOCTOU), H4 (env var injection), H5 (Zip Slip), H6 (binary_name validation), H17 (env leakage)
**Dependencies**: T2 (need to know final archive format before specifying extraction security)
**Estimated time**: 45 min

### T5: Add reliability requirements
**Fixes**: C3 (partial download as valid cache), H2 (concurrent download race), H7 (no timeouts), H8 (no retries), H9 (signal handling)
**Dependencies**: None
**Estimated time**: 30 min

### T6: Add manifest improvements
**Fixes**: H1 (monolithic manifest), H3 (no manifest caching), H13 (no default hosting location), H15 (no runner versioning)
**Dependencies**: None
**Estimated time**: 30 min

### T7: Simplify runner config and add schema version
**Fixes**: Drop CLI flags (use env vars only), add manifest schema version field, elevate F5 to Phase 2
**Dependencies**: None
**Estimated time**: 20 min

---

## DAG

```
T1 ─────────────────────────────────────┐
T2 ──────────────┐                      │
T3 ──────────────┤                      │
T5 ──────────────┤── all merge ──► Commit updated spec
T6 ──────────────┤
T7 ──────────────┘                      │
                                        │
T2 ──────► T4 ──────────────────────────┘
```

**Parallel group 1** (no dependencies): T1, T2, T3, T5, T6, T7
**Sequential**: T4 waits for T2

---

## Subagent Instructions

### Subagent A: T1 — Value Proposition & Quickstart

Read `spec/requirements.md`. Make these changes:

1. Add a new section **after the "## Problem" section** called `## Value Proposition`:
   ```
   Ship your Rust (or any native binary) MCP server to any Kiro user with zero manual installation.
   One npx command. Automatic platform detection, SHA256 verification, and local caching.
   ```

2. Add a new section **after "## Components"** called `## Quickstart Example` with a concrete end-to-end walkthrough:
   - Server author: "You maintain `my-server` on GitHub with release binaries. Here's what you do:"
     1. Add your server to the manifest JSON (show the exact JSON)
     2. Host the manifest (or submit to the default registry)
   - End user: "A Kiro user adds your server:"
     1. Show the agent config JSON
     2. Explain: "First run downloads the binary (~5s). Subsequent runs use the cache (<100ms)."

3. In the Problem section, add a one-sentence "Before/After":
   - Before: "Users must manually download, extract, chmod, and configure the binary path."
   - After: "Users add one JSON block to their config. The runner handles everything."

Do not change any other sections. Write changes directly to `spec/requirements.md`.

---

### Subagent B: T2 — Cut Windows/zip, Reduce Platforms

Read `spec/requirements.md`. Make these changes:

1. In R2, change the platform list to: `darwin-arm64`, `linux-x64`, `linux-arm64`. Remove `darwin-x64` and `win32-x64`.

2. In R7, change to: "Extract the binary from the archive (`.tar.gz` format only)." Remove `.zip` support.

3. In R8, remove any ambiguity — this is Unix-only: "Set the binary as executable (`chmod +x`) on Unix systems."

4. In R17, update the platform list to: `darwin-arm64`, `linux-x64`, `linux-arm64`.

5. Add a new non-requirement: "NR6: Windows is not supported in v1. The platform schema allows adding `win32-x64` in a future version."

6. Remove `win32-x64` from any examples in the spec.

Do not change any other sections. Write changes directly to `spec/requirements.md`.

---

### Subagent C: T3 — Replace Author Tooling with Script

Read `spec/requirements.md`. Make these changes:

1. Replace the entire "### 3. Server Author Integration" section with:

   ```markdown
   ### 3. Server Author Integration

   How a Rust MCP server author registers their server in the manifest.

   #### Requirements

   - R21: Provide a shell script (`update-manifest.sh`) that updates the manifest JSON after a release.
   - R22: Input: server name, version, GitHub Release URL base, SHA256SUMS file URL.
   - R23: Output: updated manifest JSON with entries for all platforms found in the release.
   - R24: The script should be idempotent — running it twice with the same input produces the same output.
   - R25 (renumber): A generic CLI tool or GitHub Action for third-party authors is deferred to a future version.

   #### Example usage:
   ```
   ./update-manifest.sh \
     --server local-memory-mcp \
     --version 0.2.1 \
     --release-url https://github.com/chriswessells/local-memory-mcp/releases/download/v0.2.1 \
     --checksums https://github.com/chriswessells/local-memory-mcp/releases/download/v0.2.1/SHA256SUMS.txt
   ```
   ```

2. Renumber all subsequent requirements (R25→R26, R26→R27, etc.) to account for the change.

Do not change any other sections. Write changes directly to `spec/requirements.md`.

---

### Subagent D: T5 — Reliability Requirements

Read `spec/requirements.md`. Make these changes:

1. Add the following new requirements to the **Runner Requirements** section (after R14):

   ```
   - R15: Use atomic write semantics for cache population: download to a temporary file in the cache directory, verify the SHA256 checksum, then atomically rename into the final cache path. Never write directly to the final path.
   - R16: On cache hit, verify the cached binary's SHA256 checksum before execution. Re-download on mismatch.
   - R17: Use file-based locking (e.g., `<cache-path>.lock`) to prevent concurrent downloads of the same server+version by multiple processes.
   - R18: Specify a connect timeout of 5 seconds and a response timeout of 30 seconds for manifest fetches. Specify a total download timeout of 5 minutes for binary downloads.
   - R19: Retry transient failures (HTTP 5xx, TCP reset, TLS handshake timeout) with exponential backoff: 3 attempts with 1s/2s/4s delays. Do not retry 4xx errors.
   - R20: Install signal handlers for SIGTERM and SIGINT during the download/verify phase that clean up temporary files before exit. After exec, use process replacement (execve semantics) so signals are delivered directly to the child.
   - R21: Forward SIGTERM and SIGINT to the child process if using spawn instead of exec. Wait for the child to exit before exiting the runner.
   ```

2. Renumber all subsequent requirements throughout the spec to account for the new R15-R21.

3. Update the Error Handling section — add:
   ```
   - E8: Download timeout → exit 1, stderr: "Download timed out after <N>s: <url>"
   - E9: All retries exhausted → exit 1, stderr: "Failed after <N> retries: <url>"
   ```

Do not change any other sections. Write changes directly to `spec/requirements.md`.

---

### Subagent E: T6 — Manifest Improvements

Read `spec/requirements.md`. Make these changes:

1. In the Manifest Registry section, add these requirements:

   ```
   - Add to R16 schema: a top-level `"schema_version": 1` field. The runner must check this and fail with "Unsupported manifest schema version <N>. Please update @mcp-bin/runner." if it encounters an unsupported version.
   - New requirement: The runner should cache the manifest locally with a 1-hour TTL. On fetch failure, fall back to the last-known-good cached manifest with a warning to stderr.
   - New requirement: Define a default manifest URL: `https://chriswessells.github.io/mcp-bin/manifest.json` (GitHub Pages on this repo). The `MCP_BIN_MANIFEST_URL` env var overrides this.
   ```

2. Add a new requirement for runner versioning:
   ```
   - The runner CLI interface (positional args, env vars) is a stable contract. Breaking changes require a major version bump. Registry entries should pin the runner version: `@mcp-bin/runner@1.x`.
   ```

3. In the manifest schema example (R16), add `"schema_version": 1` at the top level.

Do not change any other sections. Write changes directly to `spec/requirements.md`.

---

### Subagent F: T7 — Simplify Config & Elevate F5

Read `spec/requirements.md`. Make these changes:

1. In R12 and R13, remove the `--manifest-url` and `--cache-dir` CLI flags. Keep only the environment variables (`MCP_BIN_MANIFEST_URL`, `MCP_BIN_CACHE_DIR`). Update the requirement text:
   - R12: "Support `MCP_BIN_MANIFEST_URL` environment variable to override the default manifest location."
   - R13: "Support `MCP_BIN_CACHE_DIR` environment variable to override the default cache location."

2. In Future Considerations, move F5 (standalone binary runner) up and relabel it as "Phase 2 — Planned":
   ```
   ## Phase 2 — Planned
   - P1: Distribute the runner as a standalone binary, removing the npm/npx dependency. This addresses the adoption barrier for users without Node.js.
   ```

3. Remove F5 from the Future Considerations list (it's now in Phase 2).

4. Add to Future Considerations: "F5 (renumbered): Support `--verbose` or `MCP_BIN_VERBOSE=1` for debug logging to stderr."

Do not change any other sections. Write changes directly to `spec/requirements.md`.

---

### Subagent G: T4 — Security Hardening (runs after T2)

Read `spec/requirements.md` (after Subagent B has completed). Make these changes:

1. In the Security section, add:
   ```
   - S7: The manifest must be signed. The runner must verify the signature before trusting any URL or checksum. The signing public key is pinned in the runner package. Signature format: detached Ed25519 signature file at `<manifest-url>.sig`.
   - S8: Validate that `binary_name` in the manifest contains only alphanumeric characters, hyphens, and underscores. Reject values containing `/`, `\`, `..`, or null bytes.
   - S9: During archive extraction, validate that all extracted paths resolve within the target cache directory. Reject archives containing absolute paths, `..` components, or symlinks.
   - S10: Log a warning to stderr when using a non-default manifest URL via `MCP_BIN_MANIFEST_URL`.
   - S11: Sanitize URLs in error messages — strip query parameters before printing to prevent credential leakage.
   - S12: The runner should not forward sensitive environment variables (AWS_*, GITHUB_TOKEN, *_SECRET, *_KEY, *_PASSWORD) to the child process unless explicitly listed in the manifest's `environmentVariables` array.
   ```

2. In Error Handling, add:
   ```
   - E10: Manifest signature verification failed → exit 1, stderr: "Manifest signature verification failed. The manifest may have been tampered with."
   - E11: Invalid binary_name → exit 1, stderr: "Invalid binary name '<name>' in manifest — must contain only alphanumeric characters, hyphens, and underscores."
   - E12: Archive path traversal detected → exit 1, stderr: "Archive contains unsafe paths. Extraction aborted."
   ```

Do not change any other sections. Write changes directly to `spec/requirements.md`.
