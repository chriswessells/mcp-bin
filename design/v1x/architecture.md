# v1.x Architecture — Community Onboarding

## Change-to-Component Mapping

| Change | Files Modified | New Files |
|--------|---------------|-----------|
| C1: Configurable public key | `src/errors.ts`, `src/manifest-client.ts`, `src/cli.ts` | — |
| C2: Latest alias | `src/errors.ts`, `src/manifest-client.ts`, `src/cli.ts` | — |
| C3: Cache eviction | `src/cache-manager.ts`, `src/cli.ts` | — |
| C4: Verbose logging | `src/cli.ts`, `src/manifest-client.ts`, `src/cache-manager.ts`, `src/downloader.ts` | — |
| C5: Self-hosting guide | `README.md` | — |
| C6: JSON schema | — | `manifest.schema.json` |
| C7: README enhancements | `README.md` | — |
| C8: update-manifest.sh help | `update-manifest.sh` | — |

No new modules. No new external dependencies.

## Data Flow Changes

### v1.0 Flow (unchanged paths)
```
cli.ts → ManifestClient.fetch() → ManifestClient.resolve()
       → CacheManager.lookup()
       → download() → extract() → CacheManager.store()
       → ProcessRunner.exec()
```

### v1.x Additions

**C1 — Public key injection:**
```
cli.ts reads MCP_BIN_PUBLIC_KEY env → base64-decode → pass as `publicKey: Buffer` to ManifestClient constructor
ManifestClient constructor validates key via crypto.createPublicKey() + asymmetricKeyType check
```
The existing `publicKey.every(b => b === 0)` zero-check in `fetch()` is replaced by real validation in the constructor. This means the hardcoded default key is also validated on construction (defense-in-depth).

**C2 — Latest resolution:**
```
cli.ts parseArgs() allows "latest" through SAFE_NAME_RE (it already passes)
cli.ts: after manifest fetch, if version === "latest":
  version = resolveLatest(manifest, serverName)  // exported from manifest-client.ts
  stderr: "Resolved latest → <version>"
All subsequent calls use the resolved concrete version.
```

**C3 — Cache eviction:**
```
After CacheManager.store() returns:
  cli.ts writes .running sentinel with PID (C3.7 — immediately after store,
    protects against concurrent eviction)
  cli.ts calls fsp.utimes().catch(() => {}) on the version dir (C3.6 — best-effort)
  cli.ts calls cacheManager.evict(serverName, version).catch(warn)

On cache hit (before exec):
  cli.ts writes .running sentinel with PID

After exec returns:
  cli.ts removes .running sentinel

CacheManager.evict(serverName, currentVersion):
  1. Read server dir entries
  2. Early-exit if count <= maxVersions (C3.8)
  3. Stat mtimes for all version dirs
  4. Sort by mtime ascending
  5. Skip: currentVersion, dirs with .lock, dirs with .running (with stale-PID
     AND stale-age check — STALE_RUNNING_MS = 24h)
  6. rm -rf oldest dirs until count <= maxVersions
```

**C4 — Verbose logging:**
```
cli.ts defines verbose() alongside existing debug()
  verbose = MCP_BIN_VERBOSE=1 → emit [mcp-bin] prefixed lines to stderr
  debug = MCP_BIN_DEBUG=1 OR MCP_BIN_VERBOSE=1 → emit [debug] prefixed lines to stderr

For modules (ManifestClient, CacheManager, downloader):
  Accept optional `logger?: (msg: string) => void` in config/params
  Default: no-op
  cli.ts passes verbose() as the logger
```

## Security Considerations

1. **C1 key validation**: `crypto.createPublicKey()` + `asymmetricKeyType === 'ed25519'` prevents algorithm confusion. Moved to ManifestClient constructor so all callers get validation.

2. **C3 path validation**: `CacheManager.versionDir()` validates `serverName` and `version` against `SAFE_NAME_RE` (`/^[a-zA-Z0-9._-]+$/`). Defense-in-depth independent of cli.ts validation.

3. **C3 eviction safety**: Never evict dirs with `.lock` (concurrent download) or `.running` (active process). `.running` includes stale-PID check via `pidAlive()` and stale-age fallback (24h) to handle recycled PIDs.

4. **C4 URL sanitization**: All URLs in verbose/debug output pass through `sanitizeUrl()` to strip query parameters.

## Error Handling

Two new error classes added to `src/errors.ts`:

- **E16 `InvalidPublicKeyError`**: Thrown by ManifestClient constructor when the public key fails validation. cli.ts catches and formats the user-facing message with extraction command hint.
- **E17 `NoStableVersionsError`**: Thrown by `resolveLatest()` when no non-prerelease versions exist.

Both extend `McpBinError` and follow the existing pattern (code string, exit code 1).

## What Does NOT Change

- `src/downloader.ts` — Only change: accept optional logger param. Download logic unchanged.
- `src/extractor.ts` — No changes.
- `src/process-runner.ts` — No changes.
- `src/platform.ts` — No changes.
- `src/types.ts` — No changes.
- Manifest schema version stays at 1.
- All existing env vars and CLI arguments work unchanged.
