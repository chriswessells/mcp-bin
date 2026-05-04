# v1.x cli.ts Changes

## Overview

`src/cli.ts` is the orchestrator. It wires together C1, C2, C3, and C4 by reading env vars and calling into the modified components.

## New Imports

Add to existing imports:
```typescript
import fsp from "node:fs/promises";
import { InvalidPublicKeyError } from "./errors.js";
import { resolveLatest } from "./manifest-client.js";
import { sanitizeUrl } from "./errors.js";
```

Note: `sanitizeUrl` is already exported from `errors.ts`. `fsp` is needed for `.running` sentinel and `utimes`.

## C4: Verbose and Debug Logging

Replace the existing `debug` definition with:

```typescript
const isVerbose = process.env.MCP_BIN_VERBOSE === "1";
const isDebug = process.env.MCP_BIN_DEBUG === "1" || isVerbose;

const debug = isDebug
  ? (msg: string) => process.stderr.write(`[debug] ${msg}\n`)
  : () => {};

const verbose = isVerbose
  ? (msg: string) => process.stderr.write(`[mcp-bin] ${msg}\n`)
  : () => {};
```

Key rule: `MCP_BIN_VERBOSE=1` enables both verbose AND debug output (C4.3).

## C2: parseArgs Allows "latest"

No change needed. `"latest"` already passes `SAFE_NAME_RE` (`/^[a-zA-Z0-9._-]+$/`). Confirm this and add a comment:

```typescript
// "latest" passes SAFE_NAME_RE — resolved to concrete version after manifest fetch (C2.6)
```

## C1: Public Key from Environment

In `main()`, after `cacheDir` assignment, before ManifestClient construction:

```typescript
// C1: Configurable public key
// Note: Buffer.from(value, 'base64') never throws in Node.js — it silently
// returns garbage for invalid input. All validation happens in the
// ManifestClient constructor (throws InvalidPublicKeyError). The catch in
// Step 5 handles it.
let publicKey: Buffer | undefined;
if (process.env.MCP_BIN_PUBLIC_KEY) {
  publicKey = Buffer.from(process.env.MCP_BIN_PUBLIC_KEY, "base64");
  process.stderr.write("Warning: using custom manifest signing key\n"); // C1.5
}
```

ManifestClient construction changes to:
```typescript
let manifestClient: ManifestClient;
try {
  manifestClient = new ManifestClient({
    cacheDir,
    manifestUrl,
    ...(publicKey ? { publicKey } : {}),
    logger: verbose,
  });
} catch (err) {
  if (err instanceof InvalidPublicKeyError) {
    process.stderr.write(err.message + '\n');
    process.exit(1);
  }
  throw err;
}
```

## C2: Latest Resolution

After manifest fetch, before `resolve()`:

```typescript
const { manifest, warnings } = await manifestClient.fetch();
for (const w of warnings) process.stderr.write(`${w}\n`);

// C2: Resolve "latest" to concrete version
if (version === "latest") {
  version = resolveLatest(manifest, serverName);
  process.stderr.write(`Resolved latest → ${version}\n`); // C2.4
}

const entry = manifestClient.resolve(manifest, serverName, version, platformKey);
```

Note: `version` must be declared with `let` (not `const`) in the destructuring from `parseArgs()`:
```typescript
const { serverName, version: rawVersion, extraArgs } = parseArgs(process.argv.slice(2));
let version = rawVersion;
```

## C3: CacheManager with maxVersions

Read env var and construct:
```typescript
const maxVersions = process.env.MCP_BIN_CACHE_MAX_VERSIONS !== undefined
  ? parseInt(process.env.MCP_BIN_CACHE_MAX_VERSIONS, 10)
  : undefined;
if (maxVersions !== undefined && (isNaN(maxVersions) || maxVersions < 0)) {
  process.stderr.write('Invalid MCP_BIN_CACHE_MAX_VERSIONS: must be a non-negative integer\n');
  process.exit(1);
}

const cacheManager = new CacheManager({
  cacheDir,
  ...(maxVersions !== undefined ? { maxVersions } : {}),
  logger: verbose,
});
```

## C3.6: utimes After Store

After `store()` returns (inside the `else` branch of cache miss), after writing the `.running` sentinel:
```typescript
// C3.6: Update mtime to reflect store completion (best-effort — EPERM/ENOENT from
// concurrent eviction should not abort the run after a successful store)
const versionDirPath = path.join(cacheDir, serverName, version);
await fsp.utimes(versionDirPath, new Date(), new Date()).catch(() => {});
```

Note: The `.running` sentinel (C3.7) is written BEFORE utimes. The full sequence after store is:
1. Write `.running` sentinel (protects against concurrent eviction)
2. `utimes()` best-effort (for eviction ordering)
3. Eviction (C3)

## C3: Eviction Call

After the `finally` block (lock release), before Phase 4 exec:
```typescript
// C3: Evict old versions (best-effort)
await cacheManager.evict(serverName, version).catch((err) => {
  process.stderr.write(`Warning: cache eviction failed: ${err instanceof Error ? err.message : String(err)}\n`);
});
```

This goes OUTSIDE the `if (cacheResult.hit) { ... } else { ... }` block — eviction runs on both cache hit and cache miss paths, since a cache hit still means we should check if old versions need cleanup. Actually, re-reading the spec: "On successful cache store, check the total number" — eviction only runs after store. Place it after the else block closes but only when a store happened.

Correction: eviction runs only after a store. Add a flag:
```typescript
let didStore = false;
// ... inside else block, after store:
didStore = true;
// ... after the if/else:
if (didStore) {
  await cacheManager.evict(serverName, version).catch((err) => {
    process.stderr.write(`Warning: cache eviction failed: ${err instanceof Error ? err.message : String(err)}\n`);
  });
}
```

## C3.7: .running Sentinel

The `.running` sentinel is written **immediately after `store()` returns** — before `utimes()` and before eviction. This prevents a concurrent process from evicting the version between store and exec. The sentinel then serves double duty: it protects against concurrent eviction AND marks active execution.

After `store()` returns (inside the else/cache-miss block):
```typescript
binaryPath = await cacheManager.store(serverName, version, entry.binaryName, tmpBinaryPath);

// C3.7: Write .running sentinel immediately after store — before utimes and eviction.
// This prevents a concurrent process from evicting this version between store and exec.
const runningPath = path.join(cacheDir, serverName, version, ".running");
await fsp.writeFile(runningPath, String(process.pid)).catch(() => {});

// C3.6: Update mtime (best-effort)
const versionDirPath = path.join(cacheDir, serverName, version);
await fsp.utimes(versionDirPath, new Date(), new Date()).catch(() => {});
didStore = true;
```

On cache hit, write the sentinel before exec:
```typescript
// Cache hit path — still need .running sentinel for exec protection
const runningPath = path.join(cacheDir, serverName, version, ".running");
await fsp.writeFile(runningPath, String(process.pid)).catch(() => {});
```

After exec completes:
```typescript
const exitCode = await runner.exec(binaryPath, extraArgs);

// C3.7: Remove .running sentinel
await fsp.unlink(runningPath).catch(() => {});

process.exit(exitCode);
```

## C4: Verbose Log Points

Add verbose calls at each phase:

```typescript
// Phase 1: Resolve
verbose(`Fetching manifest from ${sanitizeUrl(manifestUrl)}`);
// (ManifestClient also logs internally via logger callback)

verbose(`Resolved server entry: url=${sanitizeUrl(entry.url)}, sha256=${entry.sha256}, binary=${entry.binaryName}`);

// Phase 2: Cache check
verbose(`Cache lookup: ${cacheResult.hit ? 'hit' : 'miss'}`);

// Phase 3: Download (if cache miss)
verbose(`Downloading ${sanitizeUrl(entry.url)}`);
verbose(`Extraction complete`);
verbose(`Stored in cache`);

// Phase 3.5: Eviction
// (CacheManager logs internally via logger callback)

// Phase 4: Exec
verbose(`Executing: ${binaryPath} ${extraArgs.join(' ')}`);
```

## Complete main() Flow (Pseudocode)

```
1. parseArgs() → serverName, version (may be "latest"), extraArgs
2. detectPlatform()
3. Read env vars: MCP_BIN_MANIFEST_URL, MCP_BIN_CACHE_DIR, MCP_BIN_PUBLIC_KEY, MCP_BIN_CACHE_MAX_VERSIONS
4. Validate MCP_BIN_CACHE_MAX_VERSIONS (exit 1 if NaN or negative)
5. Base64-decode public key if set; warn on custom key (C1.5)
6. Construct ManifestClient (validates key in constructor; catch InvalidPublicKeyError → err.message)
7. Construct CacheManager (with maxVersions, logger)
8. manifestClient.fetch() → manifest
9. If version === "latest": version = resolveLatest(manifest, serverName); log resolution (C2.4)
10. manifestClient.resolve() → entry
11. MCP_BIN_CHECK diagnostic mode (unchanged)
12. cacheManager.lookup()
13. If cache miss:
    a. acquireLock()
    b. Re-check cache
    c. download() → extract() → store()
    d. Write .running sentinel (C3.7) — immediately after store, protects against concurrent eviction
    e. utimes() best-effort with .catch(() => {}) (C3.6)
    f. releaseLock(), cleanupTemp()
    g. evict() wrapped in .catch() (C3)
14. If cache hit: write .running sentinel (C3.7)
15. runner.exec()
16. Remove .running sentinel
17. process.exit(exitCode)
```
