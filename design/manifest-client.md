# Component Design — ManifestClient

## Purpose

Fetches, caches, verifies, and resolves the manifest registry. Ensures every manifest used by the runner has a valid Ed25519 signature.

## Requirements Covered

R3, R12, R28–R30, S1, S3, S7, S10, S11, E1–E3, E6, E10, E13, E15

## API Contract

```typescript
import { Manifest, ServerEntry, Platform } from "./types";

interface ManifestClientConfig {
  manifestUrl: string;       // Default: https://chriswessells.github.io/mcp-bin/manifest.json
  cacheDir: string;          // Where to store cached manifest + sig
  publicKey: Buffer;         // Pinned Ed25519 public key
}

interface ManifestClient {
  /**
   * Fetch the manifest and its signature, verify, and return the parsed manifest.
   * Uses cached manifest if fresh (< 1 hour). Falls back to last-known-good on fetch failure.
   * @throws ManifestFetchError (E6) — fetch failed and no cached fallback
   * @throws ManifestSignatureError (E10) — signature verification failed
   * @throws ManifestSignatureNotFoundError (E15) — .sig file unavailable and no cached sig
   * @throws ManifestSchemaError (E13) — unsupported schema_version
   */
  fetch(): Promise<Manifest>;

  /**
   * Resolve a server+version+platform from a manifest to a download entry.
   * @throws ServerNotFoundError (E1) — server name not in manifest
   * @throws VersionNotFoundError (E2) — version not found for server
   * @throws PlatformNotFoundError (E3) — platform not found for server+version
   */
  resolve(manifest: Manifest, serverName: string, version: string, platform: Platform): ServerEntry;
}
```

## Internal Design

### Fetch Flow

```
1. Check manifest cache: ~/.cache/mcp-bin/.manifest/manifest.json + manifest.json.sig
2. If cache exists and age < 1 hour:
   a. Read cached manifest + sig
   b. Verify signature → return manifest
   c. If sig verification fails → treat as cache miss (re-fetch)
3. Fetch manifest from manifestUrl via HTTPS (single attempt, no retry — cache fallback exists)
   - Connect timeout: 5s, response timeout: 30s
4. Fetch signature from manifestUrl + ".sig" (single attempt, no retry)
   - If .sig fetch fails and no cached sig exists → throw E15
   - If .sig fetch fails but cached sig exists → use cached sig with warning
5. Verify Ed25519 signature of manifest bytes against .sig using pinned public key
   - Failure → throw E10
6. Parse JSON, check schema_version === 1
   - Unsupported → throw E13
   - Validate `manifest.servers` is an object (not null, not array). Missing or wrong type → throw E6 with "Invalid manifest structure"
7. Write manifest + sig to cache atomically (write to temp, rename)
8. Return parsed manifest
```

### Fallback Behavior (R29)

On fetch failure (network error, timeout, HTTP error):
1. If cached manifest+sig pair exists (any age): verify signature, return with warning to stderr
2. If no cached pair: throw E6

The warning is returned to the CLI for output — ManifestClient does not write to stderr directly.

### Resolve Flow

```
1. Look up serverName in manifest.servers → throw E1 if missing
2. Look up version in server entry → throw E2 if missing
3. Look up platform in version entry → throw E3 if missing
4. Return { url, sha256, binaryName: entry.binary_name ?? serverName }
```

### Signature Verification

```typescript
import { verify } from "node:crypto";

function verifyManifestSignature(
  manifestBytes: Buffer,
  signatureBytes: Buffer,
  publicKey: Buffer
): boolean {
  try {
    return verify(null, manifestBytes, { key: publicKey, format: "der", type: "spki" }, signatureBytes);
  } catch {
    // Malformed key or signature bytes — treat as verification failure
    return false;
  }
}
```

The public key is embedded in the package as a constant (DER-encoded SPKI format). The signature file contains the raw 64-byte Ed25519 signature.

### Manifest Cache Layout

```
~/.cache/mcp-bin/
  .manifest/
    manifest.json       # Cached manifest body
    manifest.json.sig   # Cached signature
    manifest.json.meta  # JSON: { fetchedAt: ISO8601 }
```

The `.meta` file stores the fetch timestamp for TTL calculation. All three files are written atomically as a group (write to temp names, rename in sequence).

**Corrupt cache handling**: If any cached file (manifest, sig, or meta) fails to parse or read, treat the cache as stale and re-fetch. Specifically, wrap `.meta` JSON parsing in a try/catch — on parse failure, log a warning ("Manifest cache metadata corrupted, re-fetching") and proceed as if the cache is expired. This makes the system self-healing for all cache corruption scenarios.

### URL Handling

- Non-default manifest URL (from `MCP_BIN_MANIFEST_URL`) triggers a warning (S10). The warning message is returned to the caller.
- URLs in error messages have query parameters stripped (S11).
- Manifest URL must be `https://`. The `file://` scheme is only accepted when `MCP_BIN_ALLOW_FILE_PROTOCOL=1` is set (development/testing only). All other schemes throw E6.
- When `file://` is enabled, log a warning: "Warning: file:// protocol enabled for manifest. Do not use in production."

## Error Types

```typescript
class ManifestFetchError extends McpBinError {
  constructor(url: string) {
    super(`Failed to fetch manifest: ${sanitizeUrl(url)}`, "E6");
  }
}

class ManifestSignatureError extends McpBinError {
  constructor() {
    super("Manifest signature verification failed. The manifest may have been tampered with.", "E10");
  }
}

class ManifestSignatureNotFoundError extends McpBinError {
  constructor(url: string) {
    super(`Manifest signature file not found at ${sanitizeUrl(url)}.sig`, "E15");
  }
}

class ManifestSchemaError extends McpBinError {
  constructor(version: number) {
    super(`Unsupported manifest schema version ${version}. Please update @mcp-bin/runner.`, "E13");
  }
}

class ServerNotFoundError extends McpBinError {
  constructor(name: string) {
    super(`Server '${name}' not found in manifest`, "E1");
  }
}

class VersionNotFoundError extends McpBinError {
  constructor(version: string, name: string) {
    super(`Version '${version}' of '${name}' not found`, "E2");
  }
}

class PlatformNotFoundError extends McpBinError {
  constructor(platform: string) {
    super(`No binary available for platform '${platform}'`, "E3");
  }
}
```

## Testing Notes

- Mock HTTP responses for manifest and .sig fetch
- Test TTL: fresh cache returns without fetch, stale cache triggers fetch
- Test fallback: fetch failure with valid cache returns cached manifest + warning
- Test signature failure: tampered manifest is rejected
- Test schema version: version !== 1 throws E13
- Test resolve: missing server/version/platform each throw correct error
- Test URL sanitization: query params stripped from error messages
