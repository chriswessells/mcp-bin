# Security Review — mcp-bin Runner

**Reviewer**: Security Engineer (automated)
**Date**: 2026-05-02
**Scope**: All design documents, requirements, and ADRs
**Posture**: Adversarial — assume untrusted inputs and hostile environment

---

## Summary

The design demonstrates strong security awareness: Ed25519 manifest signing, SHA256 verification, path traversal protection, atomic writes, and env var filtering are all present. However, several gaps remain that could be exploited by a determined attacker or lead to subtle failures in production.

**Critical**: 1 | **High**: 4 | **Medium**: 6 | **Low**: 3

---

## Findings

### Finding 1 — Sidecar checksum is a local-only trust anchor

**Severity**: High
**Location**: `design/cache-manager.md` (Store Flow), `agents/ADR.md` (ADR-005)
**Issue**: The `.sha256` sidecar file is written by the same process that writes the binary, into the same directory. An attacker with write access to `~/.cache/mcp-bin/` can replace both the binary and the sidecar simultaneously, and the cache-hit verification will pass.
**Risk**: Arbitrary code execution. If any other process on the machine (malware, compromised dependency, rogue cron job) can write to the user's cache directory, it can plant a malicious binary that will be executed with the user's privileges.
**Recommendation**: Accept this as a known limitation (ADR-005 acknowledges it), but add defense-in-depth: set the cache directory permissions to `0o700` on creation, and verify the binary's permissions haven't been widened (e.g., world-writable) before execution. Document the threat model boundary: "cache integrity assumes the user's home directory is not compromised."

---

### Finding 2 — Denylist for env var filtering is inherently incomplete

**Severity**: High
**Location**: `design/process-runner.md` (Environment Variable Filtering), `agents/ADR.md` (ADR-010)
**Issue**: The denylist (`AWS_*`, `GITHUB_TOKEN`, `*_SECRET`, `*_KEY`, `*_PASSWORD`) misses many sensitive variables: `DATABASE_URL`, `PRIVATE_KEY`, `API_TOKEN`, `AUTH_TOKEN`, `NPM_TOKEN`, `DOCKER_PASSWORD`, `SSH_AUTH_SOCK`, `KUBECONFIG`, `VAULT_TOKEN`, `OPENAI_API_KEY`, etc.
**Risk**: Sensitive credentials leaked to an untrusted child binary. The binary is downloaded from a URL in the manifest — if the manifest is ever compromised (even briefly before detection), the attacker's binary receives all non-denied env vars.
**Recommendation**: This conflicts with ADR-010 which explicitly chose denylist over allowlist. **Flag for Chief Architect Engineer**: recommend revisiting ADR-010 to adopt a hybrid approach — denylist the known patterns AND strip all `*_TOKEN` and `*_API_KEY` patterns. At minimum, add `/^.*_TOKEN$/`, `/^.*_API_KEY$/`, `/^NPM_/`, `/^DOCKER_/`, `/^SSH_/`, `/^VAULT_/` to the default denylist.

---

### Finding 3 — No TLS certificate pinning or minimum TLS version enforcement

**Severity**: Medium
**Location**: `design/downloader.md` (Download Flow), `design/manifest-client.md` (Fetch Flow)
**Issue**: The design specifies HTTPS-only but does not enforce a minimum TLS version or pin certificates. Node.js `node:https` defaults to TLS 1.2+ but allows TLS 1.2 which has known weaknesses. No certificate pinning means a compromised CA can MITM the manifest or binary download.
**Risk**: Man-in-the-middle attack on manifest or binary download. The Ed25519 signature mitigates manifest MITM, but binary downloads are only protected by TLS + SHA256 (which comes from the potentially-MITMed manifest in a race condition).
**Recommendation**: Set `minVersion: 'TLSv1.2'` explicitly in HTTPS options (defense-in-depth). Certificate pinning is impractical for GitHub Pages/Releases. The Ed25519 signature chain adequately protects the manifest→checksum→binary trust chain, so this is medium rather than high. Document that the security model relies on manifest signature verification, not TLS alone.

---

### Finding 4 — Race condition between cache lookup and lock acquisition

**Severity**: Medium
**Location**: `design/cli.md` (Orchestration Flow, Phase 2-3)
**Issue**: The CLI checks the cache (Phase 2), then if miss, acquires the lock (Phase 3), then re-checks. Between the initial cache check and lock acquisition, another process could complete a download and populate the cache. The design handles this with the re-check after lock — good. However, between the re-check and the download start, the lock could theoretically be broken by a third process that considers it stale (if the download takes >10 minutes).
**Risk**: Two processes download simultaneously, wasting bandwidth. Not a security vulnerability per se, but the 10-minute stale lock timeout combined with the 5-minute download timeout means a slow download on a slow connection could have its lock broken. The atomic rename prevents corruption, but the user sees confusing behavior.
**Recommendation**: Refresh the lock file's mtime periodically during download (e.g., every 60 seconds via a timer). This prevents stale-lock detection from breaking an active download.

---

### Finding 5 — `file://` scheme for manifest URL enables local file read

**Severity**: High
**Location**: `design/manifest-client.md` (URL Handling), `spec/requirements.md` (S3)
**Issue**: The manifest URL accepts `file://` for "local testing." A malicious `MCP_BIN_MANIFEST_URL=file:///etc/shadow` would cause the runner to read arbitrary local files. While the content would need to be valid JSON with a valid Ed25519 signature to proceed, the file is still read and parsed. More critically, if an attacker controls the env var AND has planted a signed manifest (e.g., via a compromised CI pipeline), they can point to a local manifest that references `file://` binary URLs.
**Risk**: Local file disclosure (limited by JSON parsing requirement). More importantly, if `file://` is also accepted for binary download URLs, an attacker could execute any local binary by crafting a manifest entry pointing to it.
**Recommendation**: 
1. The Downloader must reject `file://` URLs for binary downloads — only `https://` is acceptable for binaries.
2. Document that `file://` for manifests is a development-only feature.
3. Consider requiring an additional env var like `MCP_BIN_ALLOW_FILE_PROTOCOL=1` to enable `file://` manifests, disabled by default.

---

### Finding 6 — No size limit on downloaded archives

**Severity**: Medium
**Location**: `design/downloader.md` (Download Flow)
**Issue**: There is no maximum file size for downloaded archives. A malicious manifest entry could point to a multi-gigabyte file, filling the user's disk.
**Risk**: Denial of service via disk exhaustion. The 5-minute timeout provides some protection, but on a fast connection, gigabytes can be downloaded in 5 minutes.
**Recommendation**: Add a `maxArchiveSize` configuration (default: 500MB) and abort the download if `Content-Length` exceeds it or if bytes received exceed it during streaming. This also protects against decompression bombs in the extraction phase.

---

### Finding 7 — No size limit on tar entries during extraction

**Severity**: Medium
**Location**: `design/extractor.md` (Extraction Flow)
**Issue**: The extractor streams the target binary to disk without a size limit. A malicious archive could contain a binary entry claiming to be petabytes (tar headers specify size). `tar-stream` will attempt to write that much data.
**Risk**: Disk exhaustion during extraction.
**Recommendation**: Check `entry.size` before writing. Reject entries larger than a reasonable maximum (e.g., 500MB). Also abort if bytes written exceed the declared size (defense against malformed headers).

---

### Finding 8 — Manifest server name used in file paths without full validation

**Severity**: High
**Location**: `design/cache-manager.md` (Cache Layout), `design/cli.md` (Orchestration)
**Issue**: The `serverName` from CLI args is used directly in cache paths: `{cacheDir}/{serverName}/{version}/...`. While `binaryName` is validated (S8), `serverName` is not validated against the same character set. A malicious server name like `../../etc` or `foo/../../bar` would escape the cache directory.
**Risk**: Path traversal via server name argument. An attacker who controls the Kiro registry entry or the user's config could write files outside the cache directory.
**Recommendation**: Apply the same validation as `binaryName` (S8) to `serverName` and `version` arguments: `/^[a-zA-Z0-9._-]+$/`. Reject values containing `/`, `\`, `..`, or null bytes. Add this validation in the CLI argument parsing phase before any file system operations.

---

### Finding 9 — Ed25519 key rotation has no mechanism

**Severity**: Medium
**Location**: `design/manifest-client.md` (Signature Verification), `agents/ADR.md` (ADR-004)
**Issue**: The public key is pinned in the runner package. If the private key is compromised, there is no way to rotate the key without publishing a new npm package version AND waiting for all users to update.
**Risk**: If the signing key is compromised, all users remain vulnerable until they manually update the runner package. There's no revocation mechanism.
**Recommendation**: Support multiple pinned public keys with a `valid_from` / `valid_until` concept, or include a key ID in the `.sig` file header. For v1, document the incident response plan: "If the signing key is compromised, publish a new runner version with the new key and deprecate the old version." Consider adding a key rotation field to the manifest schema in a future version.

---

### Finding 10 — Temp files created with default umask

**Severity**: Low
**Location**: `design/cache-manager.md` (Temp Directory)
**Issue**: Temp files and directories are created with the process's default umask. On systems with a permissive umask (e.g., `0022`), temp files are world-readable. The downloaded archive and extracted binary are briefly world-readable before being moved to the final cache path.
**Risk**: Another user on a shared system could read the binary during the download window. Low risk because the design targets single-user workstations, but relevant for CI environments.
**Recommendation**: Create temp directories with `0o700` permissions explicitly. Use `fs.open` with mode `0o600` for temp files.

---

### Finding 11 — No integrity check on the runner package itself

**Severity**: Medium
**Location**: `spec/requirements.md` (Architecture), `design/architecture.md`
**Issue**: The runner is distributed via npm (`npx -y @mcp-bin/runner`). The `-y` flag auto-installs without confirmation. If the npm package is compromised (account takeover, registry poisoning), the attacker's code runs with full user privileges before any Ed25519 verification occurs.
**Risk**: Supply chain attack on the runner itself. The Ed25519 manifest signing protects against manifest tampering but not against a compromised runner package.
**Recommendation**: 
1. Enable npm 2FA on the `@mcp-bin` scope.
2. Pin the runner version in registry entries: `@mcp-bin/runner@1.0.0` (not `@1.x`). R40 says "pin to 1.x" which still allows minor/patch updates — use exact versions.
3. Publish with `--provenance` for npm package provenance attestation.
4. Document this as a known trust boundary: "The runner package is the root of trust. Protect the npm account."

---

### Finding 12 — `update-manifest.sh` downloads checksums over HTTPS without verification

**Severity**: Low
**Location**: `spec/requirements.md` (R31-R34), `design/plan.md` (T8)
**Issue**: The `update-manifest.sh` script downloads `SHA256SUMS.txt` from a URL via `curl`. If the GitHub release is compromised, the attacker controls both the binaries and the checksums file. The script trusts whatever checksums it downloads.
**Risk**: A compromised GitHub release leads to a signed manifest with attacker-controlled checksums. The Ed25519 signature then legitimizes the malicious entries.
**Recommendation**: This is inherent to the trust model (the manifest author trusts the release). Document that the signing step is the security gate: "Only sign the manifest after verifying the release artifacts through an independent channel (e.g., reproducible builds, CI attestation)." Consider adding GitHub Actions artifact attestation verification to the script in a future version.

---

### Finding 13 — Signal handler cleanup race condition

**Severity**: Low
**Location**: `design/cli.md` (Signal Handler Phases)
**Issue**: The download-phase signal handler calls `cleanupFn()` which is async. If the process receives a second signal during cleanup, or if cleanup takes too long, temp files may be left behind. The handler calls `process.exit(1)` after cleanup, but `process.exit()` in an async handler may not wait for the promise.
**Risk**: Temp files left on disk after interrupted downloads. Not a security vulnerability, but violates S6 (temp files must be cleaned up on failure).
**Recommendation**: Use synchronous cleanup where possible (`fs.rmSync`). For the signal handler, set a flag to prevent re-entry and use `process.exitCode = 1` followed by allowing the event loop to drain, rather than calling `process.exit()` directly in an async context.

---

### Finding 14 — Manifest cache poisoning via symlink attack

**Severity**: Medium
**Location**: `design/manifest-client.md` (Manifest Cache Layout)
**Issue**: The manifest cache is stored at `~/.cache/mcp-bin/.manifest/manifest.json`. If an attacker can create a symlink at this path before the runner first runs (e.g., via a malicious package's postinstall script), the runner will write the manifest content to the symlink target. On subsequent reads, if the symlink points to an attacker-controlled file, the runner reads attacker content (though signature verification would catch this).
**Risk**: Limited by Ed25519 verification — the attacker cannot forge a valid signature. However, the write-through-symlink could overwrite arbitrary files with manifest content. The atomic write (write to temp, rename) partially mitigates this if the temp file is in the same directory.
**Recommendation**: Before writing to the manifest cache, verify the target path is not a symlink using `fs.lstat()`. If it is a symlink, delete it and recreate as a regular file. Apply this check to all cache paths (binary cache too).

---

## Positive Observations

The design gets several things right:

1. **Ed25519 manifest signing (ADR-004)** — Correct decision. Without this, SHA256 verification is meaningless if the manifest host is compromised.
2. **Atomic writes (R15)** — Prevents partial/corrupt cache state.
3. **Path traversal protection (S9)** — Three-layer defense with resolve check as the definitive guard.
4. **Binary name validation (S8)** — Prevents injection via manifest content.
5. **URL sanitization (S11)** — Prevents credential leakage in error messages.
6. **Stdout reservation (R11, E7)** — Prevents protocol corruption.
7. **No external HTTP dependencies** — Using `node:https` built-in avoids supply chain risk from HTTP client libraries.
8. **Single external dependency (`tar-stream`)** — Minimal attack surface.

---

## Recommendations Summary (Priority Order)

| # | Severity | Action |
|---|----------|--------|
| 8 | High | Validate `serverName` and `version` args against `/^[a-zA-Z0-9._-]+$/` |
| 5 | High | Reject `file://` for binary download URLs; gate `file://` manifests behind opt-in env var |
| 2 | High | Expand env var denylist (**consult Chief Architect Engineer re: ADR-010**) |
| 1 | High | Set cache dir permissions to `0o700`; verify binary permissions before exec |
| 6 | Medium | Add `maxArchiveSize` limit (500MB default) |
| 7 | Medium | Check `entry.size` during extraction |
| 11 | Medium | Pin exact runner version; enable npm 2FA and provenance |
| 14 | Medium | Check for symlinks before writing to cache paths |
| 4 | Medium | Refresh lock mtime during long downloads |
| 9 | Medium | Document key rotation plan |
| 3 | Medium | Set `minVersion: 'TLSv1.2'` explicitly |
| 10 | Low | Create temp files with `0o700`/`0o600` permissions |
| 12 | Low | Document trust boundary for `update-manifest.sh` |
| 13 | Low | Use synchronous cleanup in signal handlers |

---

## ADR Conflicts

| Finding | ADR | Recommendation |
|---------|-----|----------------|
| #2 (env var denylist) | ADR-010 | Consult Chief Architect Engineer — recommend expanding denylist patterns significantly, or switching to hybrid approach |

No other findings require overturning existing ADRs.
