# mcp-bin v1.x — Community Onboarding Specification

## Goal

Lower the barrier for third-party server authors to use mcp-bin by self-hosting their own registry — no fork required. The default registry remains operator-controlled; third parties run their own manifest with their own signing key.

## Background

v1.0 ships a working runner with Ed25519 manifest signing, SHA256 verification, and atomic caching. The limitation: the public key is hardcoded, so third parties must fork the entire runner to use their own signing key. v1.x fixes this with a configurable public key, self-hosting documentation, and quality-of-life features (latest alias, cache eviction, verbose logging).

## Changes

### C1: Configurable Public Key (GitHub Issue #2)

The Ed25519 public key used for manifest signature verification must be configurable via environment variable.

#### Requirements

- C1.1: Accept `MCP_BIN_PUBLIC_KEY` environment variable containing a base64-encoded DER SPKI public key.
- C1.2: When `MCP_BIN_PUBLIC_KEY` is set, use it instead of the hardcoded default key.
- C1.3: When `MCP_BIN_PUBLIC_KEY` is not set, use the hardcoded default key (no behavior change from v1.0).
- C1.4: Validate the key on startup. Base64-decode the value, then call `crypto.createPublicKey({ key: decoded, format: 'der', type: 'spki' })`. Assert `keyObj.asymmetricKeyType === 'ed25519'`. If any step fails, exit 1 with E16.
- C1.5: Log a warning to stderr when a custom public key is in use: `"Warning: using custom manifest signing key"`.
- C1.6: Document the env var in the README Configuration table.
- C1.7: Move key validation into `ManifestClient`'s constructor (replacing the existing zero-check guard) so that any caller — not just `cli.ts` — gets validation. `cli.ts` reads the env var and formats the user-facing E16 message; `ManifestClient` enforces the structural invariant.

#### Implementation Notes

In `cli.ts`, read `MCP_BIN_PUBLIC_KEY` from env, base64-decode, and pass into `ManifestClient` config. In `ManifestClient`'s constructor, replace the zero-check with real validation: `createPublicKey(...)` + `asymmetricKeyType === 'ed25519'` check. This ensures the hardcoded default key is also validated.

#### Security Considerations

- A custom public key means the user is opting into a different trust root. The warning (C1.5) makes this visible.
- The hardcoded default key remains the secure default for users of the official registry.
- This does NOT enable unsigned manifests. A valid key is always required.
- The Ed25519 algorithm check (C1.4) prevents algorithm confusion — supplying an RSA or EC key is rejected at startup, not silently ignored at verification time.

### C2: `latest` Version Alias

Allow `latest` as a version argument that resolves to the highest semver version in the manifest for the given server.

#### Requirements

- C2.1: When the version argument is `latest`, resolve it to the highest semver version available for the given server in the manifest.
- C2.2: Semver comparison must handle standard `major.minor.patch` versions. Pre-release versions (e.g., `1.0.0-beta.1`) are excluded from `latest` resolution.
- C2.3: If no non-prerelease versions exist for the server, exit 1 with: `"No stable versions found for '<server>'"`.
- C2.4: Log the resolved version to stderr: `"Resolved latest → <version>"`.
- C2.5: The cache key uses the resolved concrete version, not the string `latest`. This ensures `latest` benefits from caching once resolved.
- C2.6: In `cli.ts`, `latest` must be resolved to a concrete version immediately after manifest fetch and before any cache or store operation. The resolved version replaces the `version` variable for all subsequent calls. `parseArgs()` must allow `"latest"` through the `SAFE_NAME_RE` check.
- C2.7: Export `resolveLatest` as a named export from `manifest-client.ts` so it can be directly unit-tested.

#### Implementation Notes

Implement `resolveLatest` as a single linear max-scan (no sort, no intermediate array) with numeric comparison:

```typescript
export function resolveLatest(manifest: Manifest, serverName: string): string {
  const server = manifest.servers[serverName];
  if (!server) throw new ServerNotFoundError(serverName);
  let best: string | null = null;
  for (const v of Object.keys(server)) {
    if (v.includes('-')) continue;
    if (best === null || semverGt(v, best)) best = v;
  }
  if (!best) throw new NoStableVersionsError(serverName);
  return best;
}

function semverGt(a: string, b: string): boolean {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  }
  return false;
}
```

### C3: Cache Eviction Policy

Prevent unbounded cache growth by evicting old versions.

#### Requirements

- C3.1: On successful cache store, check the total number of cached versions for the same server.
- C3.2: If the count exceeds `MCP_BIN_CACHE_MAX_VERSIONS` (default: 5), delete the oldest versions (by directory mtime) until the count is at or below the limit.
- C3.3: Never evict the version that was just stored or is currently running. Skip any version directory that contains a `.lock` or `.running` file (see C3.7).
- C3.4: Eviction is best-effort. Failures (permission errors, concurrent access) are logged to stderr and do not block execution. Wrap `evict()` calls in `.catch()` to enforce this.
- C3.5: `MCP_BIN_CACHE_MAX_VERSIONS=0` disables eviction (keep everything).
- C3.6: After `store()` completes, update the version directory's mtime with `fsp.utimes()` so mtime reflects store completion, not directory creation (lock acquisition) time. This ensures correct eviction ordering under concurrency.
- C3.7: Before `exec()`, write a `.running` sentinel file containing the PID. Remove it after the child process exits. `evict()` must skip directories containing `.running` (with stale-PID check using the existing `pidAlive()` pattern).
- C3.8: Early-exit optimization: read directory count first; only stat mtimes when count exceeds the limit.

#### Implementation Notes

Add `evict(serverName, currentVersion)` to `CacheManager`. In `cli.ts`, call it after `store()` wrapped in `.catch()`:

```typescript
await cacheManager.evict(serverName, version).catch((err) => {
  process.stderr.write(`Warning: cache eviction failed: ${err instanceof Error ? err.message : String(err)}\n`);
});
```

The `.running` sentinel in `cli.ts`:

```typescript
const runningPath = path.join(cacheDir, serverName, version, ".running");
await fsp.writeFile(runningPath, String(process.pid)).catch(() => {});
const exitCode = await runner.exec(binaryPath, extraArgs);
await fsp.unlink(runningPath).catch(() => {});
process.exit(exitCode);
```

#### Security Considerations

- C3 operates on paths derived from `serverName` and `version`. `CacheManager` must validate these against `SAFE_NAME_RE` (`/^[a-zA-Z0-9._-]+$/`) in its `versionDir()` method as defense-in-depth, independent of `cli.ts` validation. This prevents path traversal if `CacheManager` is ever called with unvalidated input (e.g., from manifest data).

### C4: Verbose Logging

Add opt-in verbose logging for debugging manifest resolution, downloads, and cache behavior.

#### Requirements

- C4.1: When `MCP_BIN_VERBOSE=1` is set, emit detailed log lines to stderr prefixed with `[mcp-bin]`.
- C4.2: Log the following events:
  - Manifest URL being fetched
  - Whether manifest was served from cache or network
  - Signature verification result
  - Resolved server entry (URL, sha256, binary name)
  - Cache lookup result (hit/miss)
  - Download start, progress (if available), completion
  - Extraction result
  - Cache store result
  - Eviction actions (if any)
  - Binary exec path and arguments
- C4.3: `MCP_BIN_VERBOSE` supersedes `MCP_BIN_DEBUG`. When `MCP_BIN_VERBOSE=1`, all debug messages are also emitted. `MCP_BIN_DEBUG` remains supported for backward compatibility.
- C4.4: All URLs in verbose output must be passed through `sanitizeUrl()` (from `errors.ts`) to strip query parameters. This applies to the existing `debug()` call sites as well as new verbose call sites.

#### Implementation Notes

Extend the existing `debug()` pattern in `cli.ts` with a `verbose()` function. Both check their respective env vars. For modules that need logging (`manifest-client.ts`, `downloader.ts`, `cache-manager.ts`), accept an optional logger callback in their constructors/function signatures. Default to a no-op. This keeps the modules testable without env-var coupling.

### C5: Self-Hosting Guide

Document how third-party server authors self-host their own mcp-bin registry.

#### Requirements

- C5.1: Create a "Self-Hosting" section in the README.
- C5.2: Include a complete quickstart with exact, platform-tested commands:
  1. Generate an Ed25519 keypair:
     ```bash
     openssl genpkey -algorithm ed25519 -out signing-key.pem
     ```
  2. Extract the base64 DER SPKI public key (works on macOS and Linux):
     ```bash
     openssl pkey -in signing-key.pem -pubout -outform DER | base64 | tr -d '\n'
     ```
  3. Create a `manifest.json` using `update-manifest.sh`.
  4. Sign it with `sign-manifest.sh`.
  5. Host `manifest.json` and `manifest.json.sig` on any HTTPS endpoint (GitHub Pages, S3, any static host).
  6. Configure clients with `MCP_BIN_MANIFEST_URL` and `MCP_BIN_PUBLIC_KEY`.
- C5.3: Document requirements for server binaries:
  - Must be an MCP server (stdio transport).
  - Must provide `.tar.gz` archives for at least one supported platform.
  - Must provide a SHA256SUMS file in the release.
  - Binary must be statically linked or bundled with dependencies.
  - Release URLs must be HTTPS.
- C5.4: The `tr -d '\n'` in step 2 is critical — macOS `base64` wraps at 76 chars, which breaks the env var. This must be called out explicitly.

### C6: Manifest JSON Schema

Provide a machine-readable schema for manifest validation.

#### Requirements

- C6.1: Create `manifest.schema.json` at the repo root, conforming to JSON Schema draft-07.
- C6.2: The schema must validate:
  - `schema_version` is exactly `1`.
  - `servers` is an object of objects of objects matching the `{server: {version: {platform: entry}}}` structure.
  - Platform keys are one of `darwin-arm64`, `linux-x64`, `linux-arm64`.
  - Each entry has `url` (string, HTTPS), `sha256` (64-char hex string), and optional `binary_name` (alphanumeric + hyphens + underscores).
- C6.3: The schema is for external tooling and self-hosters to validate their manifests. The runner itself does not load or reference the schema file at runtime.
- C6.4: Add a validation step to `update-manifest.sh` that checks the output against the schema using `node` (already a dependency). This gives the schema a concrete consumer.

### C7: README Enhancements

Update the README with competitive positioning and self-hosting documentation.

#### Requirements

- C7.1: Add a "Why mcp-bin?" section comparing to alternatives:
  - vs. Docker: lighter weight, no container runtime, native performance, simpler config
  - vs. cargo-binstall: works for any language (Go, C++, Zig), integrates with MCP registries, signed manifests
  - vs. manual install scripts: automatic caching, version management, checksum verification, platform detection
- C7.2: Document WSL2 compatibility: the runner works under WSL2 using the `linux-x64` platform. Note any known issues (if any are discovered during testing).
- C7.3: Update the Configuration table with new env vars: `MCP_BIN_PUBLIC_KEY`, `MCP_BIN_CACHE_MAX_VERSIONS`, `MCP_BIN_VERBOSE`.

### C8: update-manifest.sh Usage Help

Improve the `update-manifest.sh` script so new users can discover the correct invocation without reading docs.

#### Requirements

- C8.1: When invoked with no arguments, print a usage block showing the command with all switches and example parameter values, then exit 0.
- C8.2: When invoked with `--help` or `-h`, print the same usage block and exit 0.
- C8.3: The usage block must include a complete copy-pasteable example:
  ```
  Usage: ./update-manifest.sh --server <name> --version <version> --release-url <url> --checksums <url>

  Example:
    ./update-manifest.sh \
      --server my-server \
      --version 1.0.0 \
      --release-url https://github.com/you/my-server/releases/download/v1.0.0 \
      --checksums https://github.com/you/my-server/releases/download/v1.0.0/SHA256SUMS.txt
  ```
- C8.4: The existing behavior (exit with error on missing required args) is unchanged when some but not all args are provided.

## Environment Variables (Updated)

| Variable | Description | Default |
|---|---|---|
| `MCP_BIN_MANIFEST_URL` | Manifest JSON URL | `https://your-registry.example.com/manifest.json` |
| `MCP_BIN_CACHE_DIR` | Local cache directory | `~/.cache/mcp-bin` |
| `MCP_BIN_ALLOW_ENV` | Comma-separated env vars to pass through denylist | (none) |
| `MCP_BIN_DEBUG` | Set to `1` for debug logging | (none) |
| `MCP_BIN_CHECK` | Set to `1` for diagnostic mode (no exec) | (none) |
| `MCP_BIN_PUBLIC_KEY` | Base64-encoded Ed25519 DER SPKI public key | (hardcoded default) |
| `MCP_BIN_CACHE_MAX_VERSIONS` | Max cached versions per server (0 = unlimited) | `5` |
| `MCP_BIN_VERBOSE` | Set to `1` for verbose logging | (none) |

## Error Handling (New)

- E16: Invalid `MCP_BIN_PUBLIC_KEY` → exit 1, stderr: `"Invalid MCP_BIN_PUBLIC_KEY: expected base64-encoded Ed25519 DER SPKI public key.\nExtract with: openssl pkey -in your-key.pem -pubout -outform DER | base64 | tr -d '\\n'"`
- E17: No stable versions for `latest` → exit 1, stderr: `"No stable versions found for '<server>'"`

## Testing

- T12: Custom public key: generate a test keypair, sign a test manifest, verify the runner accepts it via `MCP_BIN_PUBLIC_KEY`.
- T13: Invalid public key: set `MCP_BIN_PUBLIC_KEY` to garbage, verify clean error (E16).
- T13b: Wrong key type: set `MCP_BIN_PUBLIC_KEY` to a valid RSA SPKI key, verify E16 error (not silent failure).
- T14: `latest` resolution: manifest with versions `1.0.0`, `2.0.0`, `1.5.0-beta.1` → resolves to `2.0.0`.
- T14b: `latest` numeric ordering: manifest with `9.0.0` and `10.0.0` → resolves to `10.0.0` (not lexicographic).
- T15: `latest` with no stable versions: manifest with only `1.0.0-rc.1` → error (E17).
- T16: Cache eviction: store 6 versions with max=5, verify oldest is evicted.
- T17: Cache eviction disabled: `MCP_BIN_CACHE_MAX_VERSIONS=0`, store 10 versions, all retained.
- T18: Verbose logging: verify key events are logged to stderr when `MCP_BIN_VERBOSE=1`.
- T19: Eviction skips locked directories: create a `.lock` file in a version dir, verify eviction skips it.
- T20: Eviction skips running directories: create a `.running` file in a version dir, verify eviction skips it.
- T21: CacheManager path validation: pass a serverName containing `../` to CacheManager, verify it throws.

## Scope Boundary

The following are explicitly NOT in v1.x scope:
- Standalone binary runner (v2.0 — P1)
- Per-entry signatures / multi-publisher (v3.0)
- `mcp-bin publish` CLI (v3.0 — F4)
- Windows support (deferred — ADR-003)
- Additional signing algorithms (F3)

## Migration

v1.x is backward compatible with v1.0:
- All existing env vars and CLI arguments work unchanged.
- The hardcoded public key remains the default.
- `latest` is a new valid version argument; existing explicit versions are unaffected.
- Cache eviction is additive; existing caches are not modified on upgrade.
- No manifest schema changes. `schema_version` remains `1`.

## Review Resolution Log

Findings resolved from 7-persona review:

| # | Severity | Source | Finding | Resolution |
|---|----------|--------|---------|------------|
| 1 | CRITICAL | resilience, reliability | Eviction races with concurrent downloads | C3.3: skip dirs with `.lock` file |
| 2 | CRITICAL | reliability | mtime reflects lock acquisition, not store | C3.6: `utimes()` after store |
| 3 | CRITICAL | resilience, reliability | Eviction deletes running binaries | C3.7: `.running` sentinel + PID check |
| 4 | HIGH | security, reliability, maintainability | Missing Ed25519 algorithm check | C1.4, C1.7: explicit `asymmetricKeyType` check in ManifestClient constructor |
| 5 | HIGH | resilience, reliability | `latest` leaks as raw cache key | C2.6: enforce resolution before any cache call |
| 6 | HIGH | security | Path traversal in CacheManager | C3 security note: validate in `versionDir()` |
| 7 | HIGH | security | URL sanitization in verbose logs | C4.4: mandate `sanitizeUrl()` for all URL logging |
| 8 | HIGH | maintainability | Logger injection vs env coupling | C4 impl notes: optional logger callback in constructors |
| 9 | HIGH | reliability | Eviction errors must be caught | C3.4: wrap in `.catch()` |
| 10 | HIGH | scalability | Eviction stats all dirs unnecessarily | C3.8: early-exit when count ≤ limit |
| 11 | HIGH | marketability | E16 error message is cryptic | E16: include extraction command |
| 12 | HIGH | marketability | Self-hosting guide missing exact commands | C5.2, C5.4: platform-tested openssl + `tr -d '\n'` |
| 13 | HIGH | marketability | README needs clear author guidance | Simplified: self-hosting is the only third-party path |
| 14 | HIGH | profitability | JSON Schema has no consumer | C6.4: add validation step to `update-manifest.sh` |
| 15 | HIGH | profitability | Logger injection over-engineered | C4 impl notes: extend existing `debug()` pattern, optional callback |
