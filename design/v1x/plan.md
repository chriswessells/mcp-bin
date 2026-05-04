# v1.x Implementation Plan

## DAG Overview

```
Phase 1 (Foundation)
  ├── Task 1A: errors.ts (E16, E17)
  │
Phase 2 (Parallel Components) — all depend on 1A
  ├── Task 2A: manifest-client.ts (C1 + C2 + C4 logger)
  ├── Task 2B: cache-manager.ts (C3 + C4 logger)
  │
Phase 3 (Integration) — depends on 2A + 2B
  ├── Task 3A: cli.ts (C1 + C2 + C3 + C4 wiring)
  │
Phase 4 (Docs & Scripts) — independent of Phase 2/3, can run in parallel
  ├── Task 4A: README.md (C5 + C7)
  ├── Task 4B: manifest.schema.json (C6)
  ├── Task 4C: update-manifest.sh (C8)
  │
Phase 5 (Tests) — depends on Phase 3
  ├── Task 5A: manifest-client tests (C1 + C2)
  ├── Task 5B: cache-manager tests (C3)
  ├── Task 5C: integration-harness update + integration tests
```

**Parallelism:** 2A ∥ 2B ∥ 4A ∥ 4B ∥ 4C. Then 3A. Then 5A ∥ 5B. Then 5C.

---

## Phase 1: Foundation

### Task 1A: New Error Classes

**Files:** `src/errors.ts`
**Model:** sonnet-4.6
**Depends on:** nothing

#### Instructions

Add two new error classes to `src/errors.ts`, at the end of the file (after `DiskFullError`):

```typescript
/** E16: Invalid MCP_BIN_PUBLIC_KEY */
export class InvalidPublicKeyError extends McpBinError {
  constructor() {
    super(
      "Invalid MCP_BIN_PUBLIC_KEY: expected base64-encoded Ed25519 DER SPKI public key.\n" +
      "Extract with: openssl pkey -in your-key.pem -pubout -outform DER | base64 | tr -d '\\n'",
      "E16"
    );
  }
}

/** E17: No stable versions for latest resolution */
export class NoStableVersionsError extends McpBinError {
  constructor(serverName: string) {
    super(`No stable versions found for '${serverName}'`, "E17");
  }
}
```

#### What NOT to change
- Do not modify any existing error classes.
- Do not change `sanitizeUrl()`.

#### Acceptance Criteria
- `InvalidPublicKeyError` extends `McpBinError`, has code `"E16"`, exit code `1`.
- `NoStableVersionsError` extends `McpBinError`, has code `"E17"`, exit code `1`, message includes the server name.
- `npx tsc` compiles without errors.

#### Testing
- No dedicated test file. These are validated by Phase 5 tests.

---

## Phase 2: Parallel Components

### Task 2A: ManifestClient Changes (C1 + C2 + C4)

**Files:** `src/manifest-client.ts`
**Model:** sonnet-4.6
**Depends on:** Task 1A

#### Instructions

**Read first:** `src/manifest-client.ts`, `src/errors.ts`, `design/v1x/manifest-client.md`

**Step 1: Update imports**

Change the `crypto` import from:
```typescript
import { verify } from "node:crypto";
```
to:
```typescript
import { verify, createPublicKey } from "node:crypto";
```

Add to the errors import:
```typescript
import {
  ManifestFetchError,
  SignatureVerificationError,
  SignatureNotFoundError,
  SchemaVersionError,
  ServerNotFoundError,
  VersionNotFoundError,
  PlatformNotFoundError,
  InvalidPublicKeyError,
  NoStableVersionsError,
  sanitizeUrl,
} from "./errors.js";
```

**Step 2: Update ManifestClientConfig**

```typescript
export interface ManifestClientConfig {
  manifestUrl: string;
  cacheDir: string;
  publicKey: Buffer;
  logger: (msg: string) => void;
}
```

**Step 3: Update constructor**

Replace the constructor body. After setting `this.config` (with `logger: config.logger ?? (() => {})`), add key validation:

```typescript
constructor(config: Partial<ManifestClientConfig> & { cacheDir: string }) {
  this.config = {
    manifestUrl: config.manifestUrl ?? DEFAULT_MANIFEST_URL,
    cacheDir: config.cacheDir,
    publicKey: config.publicKey ?? DEFAULT_PUBLIC_KEY,
    logger: config.logger ?? (() => {}),
  };
  this.manifestDir = path.join(this.config.cacheDir, ".manifest");
  this.manifestPath = path.join(this.manifestDir, "manifest.json");
  this.sigPath = path.join(this.manifestDir, "manifest.json.sig");
  this.metaPath = path.join(this.manifestDir, "manifest.json.meta");

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

**Step 4: Remove zero-check from fetch()**

Delete these lines from the beginning of `fetch()`:
```typescript
if (publicKey.every((b) => b === 0)) {
  throw new Error(
    "Ed25519 public key not configured — replace the placeholder before release"
  );
}
```

**Step 5: Add logger calls in fetch()**

Add at the start of `fetch()`, after the `validateUrl` call:
```typescript
this.config.logger(`Fetching manifest from ${sanitizeUrl(manifestUrl)}`);
```

After the cached manifest signature verification succeeds (the `if (fresh)` block that returns):
```typescript
this.config.logger("Manifest served from cache (fresh)");
```

After the network-fetched signature verification succeeds:
```typescript
this.config.logger("Manifest signature verified");
```

In the `fallback()` method, before returning:
```typescript
this.config.logger("Manifest served from cache (fallback)");
```

**Step 6: Add resolveLatest and semverGt**

Add these as module-level named exports (outside the class), after the class definition:

```typescript
// Strict semver stable version check — rejects pre-release tags (1.0.0-beta),
// malformed versions (1.0.0a), and anything that isn't exactly major.minor.patch.
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

#### What NOT to change
- Do not modify `verifySignature()`, `validateUrl()`, `validateManifest()`, `fetchWithTimeout()`.
- Do not modify `resolve()` method signature or logic.
- Do not modify `readCache()`, `writeCache()` private methods.
- Do not change `DEFAULT_MANIFEST_URL`, `CACHE_TTL_MS`, timeout constants, or `DEFAULT_PUBLIC_KEY`.

#### Acceptance Criteria
- `ManifestClient` constructor throws `InvalidPublicKeyError` for non-Ed25519 keys.
- `ManifestClient` constructor accepts the existing `DEFAULT_PUBLIC_KEY` without error.
- `resolveLatest()` is a named export.
- `resolveLatest()` returns highest non-prerelease semver version (uses strict `STABLE_VERSION_RE` regex, not `v.includes('-')`).
- `resolveLatest()` throws `ServerNotFoundError` for missing server.
- `resolveLatest()` throws `NoStableVersionsError` when only prerelease versions exist.
- `npx tsc` compiles without errors.

---

### Task 2B: CacheManager Changes (C3 + C4)

**Files:** `src/cache-manager.ts`
**Model:** sonnet-4.6
**Depends on:** Task 1A

#### Instructions

**Read first:** `src/cache-manager.ts`, `src/errors.ts`, `design/v1x/cache-manager.md`

**Step 1: Add import**

Add `InvalidArgumentError` to the errors import:
```typescript
import { LockTimeoutError, InvalidArgumentError } from "./errors.js";
```

**Step 2: Update CacheManagerConfig and constructor**

```typescript
export interface CacheManagerConfig {
  cacheDir: string;
  maxVersions: number;
  logger: (msg: string) => void;
}
```

Update the class fields and constructor:
```typescript
export class CacheManager {
  private readonly cacheDir: string;
  private readonly maxVersions: number;
  private readonly logger: (msg: string) => void;

  constructor(config: Partial<CacheManagerConfig> & { cacheDir: string }) {
    this.cacheDir = config.cacheDir;
    this.maxVersions = config.maxVersions ?? 5;
    this.logger = config.logger ?? (() => {});
  }
```

**Step 3: Add SAFE_NAME_RE and update versionDir()**

Add a static regex to the class:
```typescript
private static readonly SAFE_NAME_RE = /^[a-zA-Z0-9._-]+$/;
```

Replace `versionDir()`:
```typescript
private versionDir(serverName: string, version: string): string {
  if (!CacheManager.SAFE_NAME_RE.test(serverName)) {
    throw new InvalidArgumentError(`Invalid server name: '${serverName}'`);
  }
  if (!CacheManager.SAFE_NAME_RE.test(version)) {
    throw new InvalidArgumentError(`Invalid version: '${version}'`);
  }
  return path.join(this.cacheDir, serverName, version);
}
```

**Step 4: Add evict() method**

Add this method to the `CacheManager` class:

```typescript
async evict(serverName: string, currentVersion: string): Promise<void> {
  if (this.maxVersions === 0) return;

  const serverDir = path.join(this.cacheDir, serverName);
  let entries: string[];
  try {
    entries = await fsp.readdir(serverDir);
  } catch {
    return;
  }

  const versionDirs = entries.filter(e => CacheManager.SAFE_NAME_RE.test(e) && !e.startsWith('.'));

  if (versionDirs.length <= this.maxVersions) return;

  const stats: Array<{ name: string; mtimeMs: number }> = [];
  for (const name of versionDirs) {
    if (name === currentVersion) continue;
    const dir = path.join(serverDir, name);
    try {
      await fsp.access(path.join(dir, '.lock'));
      continue;
    } catch {
      // No .lock — eligible
    }
    try {
      // C3.7: skip dirs with .running (with stale-PID and stale-age check)
      const pidStr = await fsp.readFile(path.join(dir, '.running'), 'utf-8');
      const pid = parseInt(pidStr.trim(), 10);
      // Stale age fallback: recycled PIDs can cause permanent eviction skip.
      // If .running is older than STALE_RUNNING_MS (24h), remove it regardless of PID.
      const STALE_RUNNING_MS = 24 * 60 * 60 * 1000;
      const runningStat = await fsp.stat(path.join(dir, '.running'));
      if (Date.now() - runningStat.mtimeMs > STALE_RUNNING_MS) {
        await fsp.unlink(path.join(dir, '.running')).catch(() => {});
      } else if (!isNaN(pid) && pidAlive(pid)) {
        continue;
      } else {
        // Dead PID, not yet stale — clean up and allow eviction
        await fsp.unlink(path.join(dir, '.running')).catch(() => {});
      }
    } catch {
      // No .running — eligible
    }
    try {
      const st = await fsp.stat(dir);
      stats.push({ name, mtimeMs: st.mtimeMs });
    } catch {
      continue;
    }
  }

  stats.sort((a, b) => a.mtimeMs - b.mtimeMs);

  // currentCount includes protected dirs (locked, running, currentVersion).
  // If protected dirs prevent reaching maxVersions, we evict all eligible dirs and stop.
  // This is intentional best-effort behavior — the limit is enforced on future runs
  // once locks/sentinels clear.
  let currentCount = versionDirs.length;
  for (const entry of stats) {
    if (currentCount <= this.maxVersions) break;
    const dir = path.join(serverDir, entry.name);
    try {
      await fsp.rm(dir, { recursive: true, force: true });
      this.logger(`Evicted cached version: ${serverName}@${entry.name}`);
      currentCount--;
    } catch {
      this.logger(`Failed to evict ${serverName}@${entry.name}`);
    }
  }
}
```

Note: `pidAlive()` already exists as a module-level function in this file. Do NOT duplicate it.

#### What NOT to change
- Do not modify `sha256File()` or `pidAlive()` functions.
- Do not modify `lookup()`, `store()`, `acquireLock()`, `releaseLock()`, `tempDir()`, `cleanupTemp()` method logic (only `versionDir()` changes affect them indirectly).
- Do not change `LOCK_TIMEOUT_MS`, `LOCK_POLL_MS`, `STALE_LOCK_MS` constants.

#### Acceptance Criteria
- `versionDir()` throws `InvalidArgumentError` for names containing `../` or other unsafe chars.
- `evict()` removes oldest version dirs when count exceeds `maxVersions`.
- `evict()` skips `currentVersion`, dirs with `.lock`, dirs with live `.running`.
- `evict()` is a no-op when `maxVersions === 0`.
- `evict()` early-exits when version count ≤ limit.
- `npx tsc` compiles without errors.

---

## Phase 3: Integration

### Task 3A: cli.ts Wiring (C1 + C2 + C3 + C4)

**Files:** `src/cli.ts`
**Model:** sonnet-4.6
**Depends on:** Task 2A + Task 2B

#### Instructions

**Read first:** `src/cli.ts`, `design/v1x/cli.md`, `src/manifest-client.ts` (updated), `src/cache-manager.ts` (updated)

**Step 1: Add imports**

Add to existing imports:
```typescript
import fsp from "node:fs/promises";
```

Add to error imports:
```typescript
import { InvalidArgumentError, McpBinError, InvalidPublicKeyError, sanitizeUrl } from "./errors.js";
```

Add manifest-client import:
```typescript
import { ManifestClient, resolveLatest } from "./manifest-client.js";
```

**Step 2: Replace debug with verbose+debug**

Replace:
```typescript
const debug = process.env.MCP_BIN_DEBUG === "1"
  ? (msg: string) => process.stderr.write(`[debug] ${msg}\n`)
  : () => {};
```

With:
```typescript
const isVerbose = process.env.MCP_BIN_VERBOSE === "1";
const isDebug = process.env.MCP_BIN_DEBUG === "1" || isVerbose;

const debug = isDebug
  ? (msg: string) => process.stderr.write(`[debug] ${msg}\n`)
  : (() => {}) as (msg: string) => void;

const verbose = isVerbose
  ? (msg: string) => process.stderr.write(`[mcp-bin] ${msg}\n`)
  : (() => {}) as (msg: string) => void;
```

**Step 3: Update parseArgs return to allow mutable version**

Change the destructuring in `main()` from:
```typescript
const { serverName, version, extraArgs } = parseArgs(process.argv.slice(2));
```
to:
```typescript
const { serverName, version: rawVersion, extraArgs } = parseArgs(process.argv.slice(2));
let version = rawVersion;
```

**Step 4: Add public key reading (C1)**

After the `cacheDir` assignment, before ManifestClient construction:

```typescript
// C1: Configurable public key
// Note: Buffer.from(value, 'base64') never throws in Node.js — it silently
// returns garbage for invalid input. All validation happens in the
// ManifestClient constructor (throws InvalidPublicKeyError). The catch in
// Step 5 handles it.
let publicKey: Buffer | undefined;
if (process.env.MCP_BIN_PUBLIC_KEY) {
  publicKey = Buffer.from(process.env.MCP_BIN_PUBLIC_KEY, "base64");
  process.stderr.write("Warning: using custom manifest signing key\n");
}
```

**Step 5: Construct ManifestClient with error handling (C1)**

Replace:
```typescript
const manifestClient = new ManifestClient({ cacheDir, manifestUrl });
```

With:
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

**Step 6: Construct CacheManager with maxVersions (C3)**

Replace:
```typescript
const cacheManager = new CacheManager({ cacheDir });
```

With:
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

**Step 7: Add latest resolution (C2)**

After `for (const w of warnings) process.stderr.write(...)` and before `const entry = manifestClient.resolve(...)`:

```typescript
// C2: Resolve "latest" to concrete version
if (version === "latest") {
  version = resolveLatest(manifest, serverName);
  process.stderr.write(`Resolved latest → ${version}\n`);
}
```

**Step 8: Add verbose log for resolved entry**

After `const entry = manifestClient.resolve(...)`:
```typescript
verbose(`Resolved: url=${sanitizeUrl(entry.url)}, sha256=${entry.sha256}, binary=${entry.binaryName}`);
```

**Step 9: Add verbose log for cache result**

After `const cacheResult = await cacheManager.lookup(...)`:
```typescript
verbose(`Cache lookup: ${cacheResult.hit ? 'hit' : 'miss'}`);
```

**Step 10: Add utimes after store (C3.6) and track didStore**

Before the `if (cacheResult.hit)` block, add:
```typescript
let didStore = false;
```

After `binaryPath = await cacheManager.store(...)` (inside the else/try block), add:
```typescript
// C3.7: Write .running sentinel immediately after store — before utimes and eviction.
// This prevents a concurrent process from evicting this version between store and exec.
const runningPath = path.join(cacheDir, serverName, version, ".running");
await fsp.writeFile(runningPath, String(process.pid)).catch(() => {});

// C3.6: Update mtime to reflect store completion (best-effort — EPERM/ENOENT from
// concurrent eviction should not abort the run after a successful store)
const versionDirPath = path.join(cacheDir, serverName, version);
await fsp.utimes(versionDirPath, new Date(), new Date()).catch(() => {});
didStore = true;
```

**Step 11: Add eviction call (C3)**

After the `finally` block that releases the lock (after the closing `}` of the `else` block), add:
```typescript
if (didStore) {
  await cacheManager.evict(serverName, version).catch((err) => {
    process.stderr.write(`Warning: cache eviction failed: ${err instanceof Error ? err.message : String(err)}\n`);
  });
}
```

**Step 12: Add .running sentinel (C3.7)**

The `.running` sentinel is now written in two places:
1. **Cache miss path:** immediately after `store()` (Step 10 above) — before utimes and eviction
2. **Cache hit path:** before exec (below)

On cache hit, add before exec:
```typescript
// Cache hit path — still need .running sentinel for exec protection
if (!didStore) {
  const runningPath = path.join(cacheDir, serverName, version, ".running");
  await fsp.writeFile(runningPath, String(process.pid)).catch(() => {});
}
```

Replace the Phase 4 exec section:
```typescript
// Phase 4: Exec
debug(`executing: ${binaryPath}`);
const runner = createProcessRunner();
const exitCode = await runner.exec(binaryPath, extraArgs);
process.exit(exitCode);
```

With:
```typescript
// Phase 4: Exec
verbose(`Executing: ${binaryPath} ${extraArgs.join(' ')}`.trimEnd());
debug(`executing: ${binaryPath}`);
const runner = createProcessRunner();

const exitCode = await runner.exec(binaryPath, extraArgs);

// C3.7: Remove .running sentinel
const runningPath2 = path.join(cacheDir, serverName, version, ".running");
await fsp.unlink(runningPath2).catch(() => {});
process.exit(exitCode);
```

**Step 13: Update existing debug() calls to use sanitizeUrl where URLs appear**

The existing `debug(\`resolved: ${entry.url}\`)` should become:
```typescript
debug(`resolved: ${sanitizeUrl(entry.url)}`);
```

#### What NOT to change
- Do not modify `parseArgs()` function logic (just the destructuring in `main()`).
- Do not modify the download/extract/store logic inside the try block.
- Do not modify signal handlers for download phase cleanup.
- Do not modify the `main().catch()` error handler at the bottom.

#### Acceptance Criteria
- `MCP_BIN_PUBLIC_KEY` env var is read, base64-decoded (no try/catch — `Buffer.from` never throws), and passed to ManifestClient.
- Invalid public key produces E16 message via `err.message` (not duplicated string) and exits 1.
- `version === "latest"` is resolved before any cache/store operation.
- `MCP_BIN_CACHE_MAX_VERSIONS` is validated: NaN or negative values produce error message and exit 1.
- `evict()` is called after store, wrapped in `.catch()`.
- `.running` sentinel is written immediately after `store()` (before utimes and eviction) on cache miss, and before exec on cache hit.
- `utimes()` is wrapped in `.catch(() => {})` — best-effort, never fatal.
- `MCP_BIN_VERBOSE=1` enables `[mcp-bin]` prefixed logging.
- `MCP_BIN_VERBOSE=1` also enables `[debug]` logging.
- All URLs in log output pass through `sanitizeUrl()`.
- `npx tsc` compiles without errors.

---

## Phase 4: Docs & Scripts (parallel with Phase 3)

### Task 4A: README Updates (C5 + C7)

**Files:** `README.md`
**Model:** sonnet-4.6
**Depends on:** nothing (can run in parallel with Phase 2/3)

#### Instructions

**Read first:** `README.md`, spec sections C5 and C7.

Add the following sections to `README.md`. Read the existing README first to determine correct placement.

**1. "Why mcp-bin?" section** (add after the introductory section, before Configuration):

```markdown
## Why mcp-bin?

**vs. Docker:** Lighter weight, no container runtime required, native performance, simpler configuration in MCP client settings.

**vs. cargo-binstall:** Works for any compiled language (Go, Rust, C++, Zig), integrates with MCP registries, signed manifests for supply-chain security.

**vs. manual install scripts:** Automatic caching, version management, SHA256 checksum verification, cross-platform detection, Ed25519 manifest signing.
```

**2. Update Configuration table** — add these rows:

| Variable | Description | Default |
|---|---|---|
| `MCP_BIN_PUBLIC_KEY` | Base64-encoded Ed25519 DER SPKI public key for manifest verification | (hardcoded default) |
| `MCP_BIN_CACHE_MAX_VERSIONS` | Max cached versions per server (0 = unlimited) | `5` |
| `MCP_BIN_VERBOSE` | Set to `1` for verbose logging (includes debug output) | (none) |

**3. "Self-Hosting" section** (add after Configuration):

```markdown
## Self-Hosting

Run your own mcp-bin registry — no fork required.

### Quickstart

1. **Generate an Ed25519 signing key:**
   ```bash
   openssl genpkey -algorithm ed25519 -out signing-key.pem
   ```

2. **Extract the base64 DER SPKI public key:**
   ```bash
   openssl pkey -in signing-key.pem -pubout -outform DER | base64 | tr -d '\n'
   ```
   > **Important:** The `tr -d '\n'` is required — most base64 implementations wrap output at 76 characters by default, which breaks the environment variable.

3. **Create your manifest:**
   ```bash
   ./update-manifest.sh \
     --server my-server \
     --version 1.0.0 \
     --release-url https://github.com/you/my-server/releases/download/v1.0.0 \
     --checksums https://github.com/you/my-server/releases/download/v1.0.0/SHA256SUMS.txt
   ```

4. **Sign the manifest:**
   ```bash
   ./sign-manifest.sh manifest.json signing-key.pem
   ```

5. **Host `manifest.json` and `manifest.json.sig`** on any HTTPS endpoint (GitHub Pages, S3, any static host).

6. **Configure clients:**
   ```bash
   export MCP_BIN_MANIFEST_URL=https://your-domain.com/manifest.json
   export MCP_BIN_PUBLIC_KEY=<output from step 2>
   ```

### Server Binary Requirements

- Must be an MCP server using stdio transport.
- Must provide `.tar.gz` archives for at least one supported platform (`darwin-arm64`, `linux-x64`, `linux-arm64`).
- Must provide a SHA256SUMS file in the release.
- Binary must be statically linked or bundled with all dependencies.
- Release URLs must be HTTPS.
```

**4. WSL2 note** — add a brief note in the platform/compatibility section:

```markdown
### WSL2

mcp-bin works under WSL2 using the `linux-x64` platform. No special configuration required.
```

#### What NOT to change
- Do not modify existing sections that are not listed above.
- Do not change the project description or installation instructions.

#### Acceptance Criteria
- "Why mcp-bin?" section exists with three comparisons.
- Configuration table includes `MCP_BIN_PUBLIC_KEY`, `MCP_BIN_CACHE_MAX_VERSIONS`, `MCP_BIN_VERBOSE`.
- Self-Hosting section has complete quickstart with all 6 steps.
- `tr -d '\n'` warning is explicitly called out.
- WSL2 compatibility note exists.

---

### Task 4B: JSON Schema (C6)

**Files:** `manifest.schema.json` (new file at repo root)
**Model:** sonnet-4.6
**Depends on:** nothing

#### Instructions

Create `manifest.schema.json` at the repo root:

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "https://github.com/mcp-bin/mcp-bin/blob/main/manifest.schema.json",
  "title": "mcp-bin Manifest",
  "description": "Schema for mcp-bin registry manifest files",
  "type": "object",
  "required": ["schema_version", "servers"],
  "properties": {
    "schema_version": {
      "type": "integer",
      "const": 1
    },
    "servers": {
      "type": "object",
      "additionalProperties": {
        "type": "object",
        "additionalProperties": {
          "type": "object",
          "additionalProperties": false,
          "patternProperties": {
            "^(darwin-arm64|linux-x64|linux-arm64)$": {
              "type": "object",
              "required": ["url", "sha256"],
              "additionalProperties": false,
              "properties": {
                "url": {
                  "type": "string",
                  "pattern": "^https://"
                },
                "sha256": {
                  "type": "string",
                  "pattern": "^[a-f0-9]{64}$"
                },
                "binary_name": {
                  "type": "string",
                  "pattern": "^[a-zA-Z0-9_-]+$"
                }
              }
            }
          }
        }
      }
    }
  },
  "additionalProperties": false
}
```

#### What NOT to change
- This is a new file. No existing files are modified.
- The runner does NOT load this schema at runtime.

#### Acceptance Criteria
- File is valid JSON Schema draft-07.
- Validates `schema_version` is exactly `1`.
- Platform keys restricted to `darwin-arm64`, `linux-x64`, `linux-arm64`.
- URLs must start with `https://`.
- SHA256 must be 64-char lowercase hex.
- `binary_name` is optional, alphanumeric + hyphens + underscores.

---

### Task 4C: update-manifest.sh Help (C8)

**Files:** `update-manifest.sh`
**Model:** sonnet-4.6
**Depends on:** nothing

#### Instructions

**Read first:** `update-manifest.sh`

Add a usage function and help/no-args handling at the top of the script, after the `set -eo pipefail` line and before the dependency checks.

```bash
usage() {
  cat <<'EOF'
Usage: ./update-manifest.sh --server <name> --version <version> --release-url <url> --checksums <url>

Options:
  --server       Server name in the manifest
  --version      Version string (e.g., 1.0.0)
  --release-url  Base URL for release assets
  --checksums    URL to SHA256SUMS file

Example:
  ./update-manifest.sh \
    --server my-server \
    --version 1.0.0 \
    --release-url https://github.com/you/my-server/releases/download/v1.0.0 \
    --checksums https://github.com/you/my-server/releases/download/v1.0.0/SHA256SUMS.txt
EOF
}

# Show help on no args or --help/-h
if [[ $# -eq 0 ]] || [[ "$1" == "--help" ]] || [[ "$1" == "-h" ]]; then
  usage
  exit 0
fi
```

Also add a schema validation step at the end of the script (after the `add_platform` calls, before the final echo), if `manifest.schema.json` exists and `node` is available:

```bash
# Validate against schema if available
if [[ -f "manifest.schema.json" ]] && command -v node >/dev/null 2>&1; then
  node -e "
    const fs = require('fs');
    const schema = JSON.parse(fs.readFileSync('manifest.schema.json', 'utf-8'));
    const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf-8'));
    // Basic validation: check required fields
    if (manifest.schema_version !== 1) { console.error('Schema version must be 1'); process.exit(1); }
    if (typeof manifest.servers !== 'object') { console.error('Missing servers object'); process.exit(1); }
    console.log('  Schema validation passed');
  " || echo "  Warning: schema validation failed" >&2
fi
```

#### What NOT to change
- Do not modify the argument parsing loop or `add_platform` function.
- Do not change the existing error message for missing required args.
- The existing `exit 1` for missing args (when some but not all are provided) is unchanged.

#### Acceptance Criteria
- `./update-manifest.sh` with no args prints usage and exits 0.
- `./update-manifest.sh --help` prints usage and exits 0.
- `./update-manifest.sh -h` prints usage and exits 0.
- Usage block includes a complete copy-pasteable example.
- Existing behavior with partial args (exit 1 with error) is unchanged.

---

## Phase 5: Tests

### Task 5A: ManifestClient Tests (C1 + C2)

**Files:** `tests/manifest-client.test.ts`
**Model:** sonnet-4.6
**Depends on:** Task 2A

#### Instructions

**Read first:** `tests/manifest-client.test.ts` (existing patterns), `src/manifest-client.ts` (updated)

Add new test blocks to the existing test file. Follow the existing patterns: `describe`/`it` from `node:test`, `assert` from `node:assert/strict`, temp dirs in `beforeEach`/`afterEach`.

**Tests to add:**

```typescript
describe("ManifestClient constructor (C1)", () => {
  it("T12: accepts a valid custom Ed25519 public key", () => {
    // The test file already generates a keypair at the top — use `publicKey`
    const client = new ManifestClient({ cacheDir, publicKey });
    // Should not throw — construction succeeds
    assert.ok(client);
  });

  it("T13: rejects garbage MCP_BIN_PUBLIC_KEY with E16", () => {
    const garbage = Buffer.from("not-a-valid-key");
    assert.throws(
      () => new ManifestClient({ cacheDir, publicKey: garbage }),
      (err: any) => {
        assert.strictEqual(err.code, "E16");
        assert.match(err.message, /Ed25519 DER SPKI/);
        return true;
      }
    );
  });

  it("T13b: rejects RSA SPKI key with E16", () => {
    const { publicKey: rsaPub } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const rsaDer = rsaPub.export({ type: "spki", format: "der" }) as Buffer;
    assert.throws(
      () => new ManifestClient({ cacheDir, publicKey: rsaDer }),
      (err: any) => {
        assert.strictEqual(err.code, "E16");
        return true;
      }
    );
  });
});
```

Add `resolveLatest` import at the top:
```typescript
import { ManifestClient, resolveLatest } from "../src/manifest-client.ts";
```

Also import `NoStableVersionsError` and `ServerNotFoundError`:
```typescript
import { NoStableVersionsError, ServerNotFoundError } from "../src/errors.ts";
```

```typescript
describe("resolveLatest (C2)", () => {
  it("T14: resolves to highest stable version, skipping prerelease", () => {
    const manifest: Manifest = {
      schema_version: 1,
      servers: {
        "test-server": {
          "1.0.0": { "darwin-arm64": { url: "https://x.com/a", sha256: "a".repeat(64) } },
          "2.0.0": { "darwin-arm64": { url: "https://x.com/b", sha256: "b".repeat(64) } },
          "1.5.0-beta.1": { "darwin-arm64": { url: "https://x.com/c", sha256: "c".repeat(64) } },
        },
      },
    };
    assert.strictEqual(resolveLatest(manifest, "test-server"), "2.0.0");
  });

  it("T14b: uses numeric not lexicographic comparison", () => {
    const manifest: Manifest = {
      schema_version: 1,
      servers: {
        "test-server": {
          "9.0.0": { "darwin-arm64": { url: "https://x.com/a", sha256: "a".repeat(64) } },
          "10.0.0": { "darwin-arm64": { url: "https://x.com/b", sha256: "b".repeat(64) } },
        },
      },
    };
    assert.strictEqual(resolveLatest(manifest, "test-server"), "10.0.0");
  });

  it("T14c: skips malformed versions like '1.0.0a' (strict STABLE_VERSION_RE)", () => {
    const manifest: Manifest = {
      schema_version: 1,
      servers: {
        "test-server": {
          "1.0.0": { "darwin-arm64": { url: "https://x.com/a", sha256: "a".repeat(64) } },
          "1.0.0a": { "darwin-arm64": { url: "https://x.com/b", sha256: "b".repeat(64) } },
          "2.0": { "darwin-arm64": { url: "https://x.com/c", sha256: "c".repeat(64) } },
          "latest": { "darwin-arm64": { url: "https://x.com/d", sha256: "d".repeat(64) } },
        },
      },
    };
    assert.strictEqual(resolveLatest(manifest, "test-server"), "1.0.0");
  });

  it("T15: throws E17 when only prerelease versions exist", () => {
    const manifest: Manifest = {
      schema_version: 1,
      servers: {
        "test-server": {
          "1.0.0-rc.1": { "darwin-arm64": { url: "https://x.com/a", sha256: "a".repeat(64) } },
        },
      },
    };
    assert.throws(
      () => resolveLatest(manifest, "test-server"),
      (err: any) => {
        assert.strictEqual(err.code, "E17");
        assert.match(err.message, /test-server/);
        return true;
      }
    );
  });

  it("throws E1 for missing server", () => {
    const manifest: Manifest = { schema_version: 1, servers: {} };
    assert.throws(
      () => resolveLatest(manifest, "nope"),
      (err: any) => {
        assert.strictEqual(err.code, "E1");
        return true;
      }
    );
  });
});
```

#### What NOT to change
- Do not modify existing tests.
- Do not change the test keypair generation at the top of the file.

#### Acceptance Criteria
- All new tests pass: `node --import tsx --test tests/manifest-client.test.ts`
- Existing tests still pass.

---

### Task 5B: CacheManager Tests (C3)

**Files:** `tests/cache-manager.test.ts`
**Model:** sonnet-4.6
**Depends on:** Task 2B

#### Instructions

**Read first:** `tests/cache-manager.test.ts` (existing patterns), `src/cache-manager.ts` (updated)

Add new test blocks. Follow existing patterns. The existing `beforeEach` creates `tmpRoot` and `cm`. For eviction tests, create a new `CacheManager` with `maxVersions` set.

**Tests to add:**

```typescript
describe("evict (C3)", () => {
  it("T16: evicts oldest version when count exceeds max", async () => {
    const evictCm = new CacheManager({ cacheDir: tmpRoot, maxVersions: 2 });

    // Create 3 version dirs with staggered mtimes
    for (const [i, ver] of ["1.0.0", "2.0.0", "3.0.0"].entries()) {
      const dir = path.join(tmpRoot, "srv", ver);
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(path.join(dir, "bin"), `v${ver}`);
      // Set mtime: oldest first
      const t = new Date(Date.now() - (3 - i) * 60_000);
      await fsp.utimes(dir, t, t);
    }

    await evictCm.evict("srv", "3.0.0");

    // 1.0.0 should be evicted (oldest), 2.0.0 and 3.0.0 remain
    assert.ok(!fs.existsSync(path.join(tmpRoot, "srv", "1.0.0")));
    assert.ok(fs.existsSync(path.join(tmpRoot, "srv", "2.0.0")));
    assert.ok(fs.existsSync(path.join(tmpRoot, "srv", "3.0.0")));
  });

  it("T17: maxVersions=0 disables eviction", async () => {
    const evictCm = new CacheManager({ cacheDir: tmpRoot, maxVersions: 0 });

    for (const ver of ["1.0.0", "2.0.0", "3.0.0", "4.0.0", "5.0.0", "6.0.0"]) {
      const dir = path.join(tmpRoot, "srv", ver);
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(path.join(dir, "bin"), `v${ver}`);
    }

    await evictCm.evict("srv", "6.0.0");

    // All versions should remain
    for (const ver of ["1.0.0", "2.0.0", "3.0.0", "4.0.0", "5.0.0", "6.0.0"]) {
      assert.ok(fs.existsSync(path.join(tmpRoot, "srv", ver)));
    }
  });

  it("T19: eviction skips directories with .lock file", async () => {
    const evictCm = new CacheManager({ cacheDir: tmpRoot, maxVersions: 1 });

    for (const [i, ver] of ["1.0.0", "2.0.0"].entries()) {
      const dir = path.join(tmpRoot, "srv", ver);
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(path.join(dir, "bin"), `v${ver}`);
      const t = new Date(Date.now() - (2 - i) * 60_000);
      await fsp.utimes(dir, t, t);
    }

    // Lock the oldest version
    await fsp.writeFile(path.join(tmpRoot, "srv", "1.0.0", ".lock"), String(process.pid));

    await evictCm.evict("srv", "2.0.0");

    // 1.0.0 should NOT be evicted (locked)
    assert.ok(fs.existsSync(path.join(tmpRoot, "srv", "1.0.0")));
    assert.ok(fs.existsSync(path.join(tmpRoot, "srv", "2.0.0")));
  });

  it("T20: eviction skips directories with live .running file", async () => {
    const evictCm = new CacheManager({ cacheDir: tmpRoot, maxVersions: 1 });

    for (const [i, ver] of ["1.0.0", "2.0.0"].entries()) {
      const dir = path.join(tmpRoot, "srv", ver);
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(path.join(dir, "bin"), `v${ver}`);
      const t = new Date(Date.now() - (2 - i) * 60_000);
      await fsp.utimes(dir, t, t);
    }

    // Mark oldest as running with our own PID (alive)
    await fsp.writeFile(path.join(tmpRoot, "srv", "1.0.0", ".running"), String(process.pid));

    await evictCm.evict("srv", "2.0.0");

    // 1.0.0 should NOT be evicted (running)
    assert.ok(fs.existsSync(path.join(tmpRoot, "srv", "1.0.0")));
  });

  it("T20b: eviction removes stale .running (older than 24h) even if PID is alive", async () => {
    const evictCm = new CacheManager({ cacheDir: tmpRoot, maxVersions: 1 });

    for (const [i, ver] of ["1.0.0", "2.0.0"].entries()) {
      const dir = path.join(tmpRoot, "srv", ver);
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(path.join(dir, "bin"), `v${ver}`);
      const t = new Date(Date.now() - (2 - i) * 60_000);
      await fsp.utimes(dir, t, t);
    }

    // Mark oldest as running with our own PID (alive) but with stale mtime (>24h)
    const runningPath = path.join(tmpRoot, "srv", "1.0.0", ".running");
    await fsp.writeFile(runningPath, String(process.pid));
    const staleTime = new Date(Date.now() - 25 * 60 * 60 * 1000); // 25 hours ago
    await fsp.utimes(runningPath, staleTime, staleTime);

    await evictCm.evict("srv", "2.0.0");

    // 1.0.0 SHOULD be evicted (stale .running)
    assert.ok(!fs.existsSync(path.join(tmpRoot, "srv", "1.0.0")));
  });

  it("T21: versionDir rejects path traversal in serverName", () => {
    assert.throws(
      () => cm.lookup("../etc", "1.0.0", "bin"),
      (err: any) => {
        assert.strictEqual(err.code, "EINVAL");
        return true;
      }
    );
  });
});
```

Import `InvalidArgumentError` at the top if not already imported:
```typescript
import { LockTimeoutError, InvalidArgumentError } from "../src/errors.ts";
```

#### What NOT to change
- Do not modify existing tests.
- Do not change the `beforeEach`/`afterEach` setup.

#### Acceptance Criteria
- All new tests pass: `node --import tsx --test tests/cache-manager.test.ts`
- Existing tests still pass.

---

### Task 5C: Integration Harness Update

**Files:** `tests/integration-harness.ts`
**Model:** sonnet-4.6
**Depends on:** Task 3A

#### Instructions

**Read first:** `tests/integration-harness.ts`, `src/cli.ts` (updated)

Update the integration harness to mirror the v1.x cli.ts changes. The harness already accepts `PUBLIC_KEY` env var (base64), so C1 is partially handled. Changes needed:

1. **Import `resolveLatest`:**
```typescript
import { ManifestClient, resolveLatest } from "../src/manifest-client.ts";
```

2. **Add latest resolution after manifest fetch:**
```typescript
let resolvedVersion = version;
if (resolvedVersion === "latest") {
  resolvedVersion = resolveLatest(manifest, serverName);
  process.stderr.write(`Resolved latest → ${resolvedVersion}\n`);
}
```
Use `resolvedVersion` instead of `version` for all subsequent calls.

3. **Add maxVersions support (with NaN validation):**
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
});
```

4. **Add .running sentinel — write immediately after store (before utimes/eviction), remove after exec:**
```typescript
import fsp from "node:fs/promises";
// ...
// On cache miss, after store:
const runningPath = path.join(cacheDir, serverName, resolvedVersion, ".running");
await fsp.writeFile(runningPath, String(process.pid)).catch(() => {});
// Then utimes (best-effort), then eviction...

// On cache hit, before exec:
await fsp.writeFile(runningPath, String(process.pid)).catch(() => {});

// After exec:
const exitCode = await runner.exec(binaryPath, extraArgs);
await fsp.unlink(runningPath).catch(() => {});
process.exit(exitCode);
```

5. **Add eviction after store (with .running written first, utimes best-effort):**
```typescript
binaryPath = await cacheManager.store(serverName, resolvedVersion, entry.binaryName, tmpBinaryPath);
// .running sentinel written first (step 4 above)
const versionDirPath = path.join(cacheDir, serverName, resolvedVersion);
await fsp.utimes(versionDirPath, new Date(), new Date()).catch(() => {});
// Evict after store
await cacheManager.evict(serverName, resolvedVersion).catch(() => {});
```

#### What NOT to change
- Do not change the TLS cert generation or test server setup.
- Do not change the `PUBLIC_KEY` env var handling (it already works).

#### Acceptance Criteria
- Integration tests still pass: `node --import tsx --test tests/integration.test.ts`
- Harness supports `latest` as a version argument.
- Harness supports `MCP_BIN_CACHE_MAX_VERSIONS`.

---

## Risk Flags

1. **Task 2A (ManifestClient constructor validation):** The `DEFAULT_PUBLIC_KEY` constant must pass the new validation. If it doesn't (e.g., it's a placeholder), the constructor will throw on every construction. Verify the hardcoded key is a valid Ed25519 SPKI key.

2. **Task 3A (cli.ts wiring):** Most complex task — touches many parts of the flow. High risk of merge conflicts if done in parallel with other cli.ts changes. This is why it's sequenced after Phase 2.

3. **Task 5B (eviction tests):** Timing-sensitive due to mtime comparisons. Tests use explicit `utimes()` to set deterministic mtimes rather than relying on filesystem timing.

## Build Verification

After all phases complete, run:
```bash
npx tsc
node --import tsx --test tests/*.test.ts
```

Both must pass with zero failures.
