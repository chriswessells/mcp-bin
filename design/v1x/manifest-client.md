# v1.x ManifestClient Changes

## Overview

Three changes to `src/manifest-client.ts`:
1. **C1**: Validate public key in constructor (replace zero-check)
2. **C2**: Export `resolveLatest()` and helper `semverGt()`
3. **C4**: Accept optional logger callback

## C1: Public Key Validation in Constructor

### Current Code (to replace)

In `fetch()`, lines:
```typescript
if (publicKey.every((b) => b === 0)) {
  throw new Error(
    "Ed25519 public key not configured — replace the placeholder before release"
  );
}
```

### New Code

Add import at top of file:
```typescript
import { createPublicKey } from "node:crypto";
```
Note: `verify` is already imported from `node:crypto`. Change to: `import { verify, createPublicKey } from "node:crypto";`

Add import of new error:
```typescript
import { InvalidPublicKeyError } from "./errors.js";
```

In the constructor, after setting `this.config`, add validation:
```typescript
constructor(config: Partial<ManifestClientConfig> & { cacheDir: string }) {
  this.config = {
    manifestUrl: config.manifestUrl ?? DEFAULT_MANIFEST_URL,
    cacheDir: config.cacheDir,
    publicKey: config.publicKey ?? DEFAULT_PUBLIC_KEY,
  };
  this.manifestDir = path.join(this.config.cacheDir, ".manifest");
  this.manifestPath = path.join(this.manifestDir, "manifest.json");
  this.sigPath = path.join(this.manifestDir, "manifest.json.sig");
  this.metaPath = path.join(this.manifestDir, "manifest.json.meta");

  // Validate public key (C1.4, C1.7)
  try {
    const keyObj = createPublicKey({ key: this.config.publicKey, format: 'der', type: 'spki' });
    if (keyObj.asymmetricKeyType !== 'ed25519') {
      throw new InvalidPublicKeyError();
    }
  } catch (err) {
    if (err instanceof InvalidPublicKeyError) throw err;
    throw new InvalidPublicKeyError();
  }
}
```

Remove the zero-check from `fetch()`.

### Logger Injection (C4)

Add to `ManifestClientConfig`:
```typescript
export interface ManifestClientConfig {
  manifestUrl: string;
  cacheDir: string;
  publicKey: Buffer;
  logger: (msg: string) => void;
}
```

In constructor, default logger to no-op:
```typescript
this.config = {
  manifestUrl: config.manifestUrl ?? DEFAULT_MANIFEST_URL,
  cacheDir: config.cacheDir,
  publicKey: config.publicKey ?? DEFAULT_PUBLIC_KEY,
  logger: config.logger ?? (() => {}),
};
```

Add log calls in `fetch()`:
```typescript
// Before network fetch:
this.config.logger(`Fetching manifest from ${sanitizeUrl(manifestUrl)}`);

// After cache hit:
this.config.logger("Manifest served from cache");

// After signature verification succeeds:
this.config.logger("Manifest signature verified");
```

Import `sanitizeUrl` from `./errors.js` (add to existing import).

## C2: resolveLatest Export

Add these as **named exports** at the module level (not inside the class):

```typescript
// Strict semver stable version check — rejects pre-release tags (1.0.0-beta),
// malformed versions (1.0.0a), and anything that isn't exactly major.minor.patch.
// v.includes('-') is insufficient: '1.0.0a' has no hyphen but produces NaN in semverGt.
const STABLE_VERSION_RE = /^\d+\.\d+\.\d+$/;

export function resolveLatest(manifest: Manifest, serverName: string): string {
  const server = manifest.servers[serverName];
  if (!server) throw new ServerNotFoundError(serverName);
  let best: string | null = null;
  for (const v of Object.keys(server)) {
    if (!STABLE_VERSION_RE.test(v)) continue;
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

Import `NoStableVersionsError` from `./errors.js` (add to existing import).

## Contract Summary

### ManifestClientConfig (updated)
```typescript
export interface ManifestClientConfig {
  manifestUrl: string;
  cacheDir: string;
  publicKey: Buffer;
  logger: (msg: string) => void;
}
```

### Constructor
```typescript
constructor(config: Partial<ManifestClientConfig> & { cacheDir: string })
```
- Throws `InvalidPublicKeyError` if `publicKey` is not a valid Ed25519 DER SPKI key
- Defaults `logger` to no-op
- Defaults `publicKey` to `DEFAULT_PUBLIC_KEY`
- Defaults `manifestUrl` to `DEFAULT_MANIFEST_URL`

### resolveLatest (new export)
```typescript
export function resolveLatest(manifest: Manifest, serverName: string): string
```
- Returns the highest semver version (major.minor.patch) excluding pre-release versions
- Uses strict `STABLE_VERSION_RE` (`/^\d+\.\d+\.\d+$/`) — rejects pre-release tags AND malformed versions like `1.0.0a`
- Throws `ServerNotFoundError` if server not in manifest
- Throws `NoStableVersionsError` if no non-prerelease versions exist
- Uses linear scan with numeric comparison (no sort, no intermediate array)

### Existing methods — no signature changes
- `fetch(): Promise<FetchResult>` — unchanged except: remove zero-check, add logger calls
- `resolve(manifest, serverName, version, platform): ServerEntry` — unchanged
