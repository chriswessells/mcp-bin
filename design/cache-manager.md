# Component Design — CacheManager

## Purpose

Manages the local binary cache: lookup with integrity verification, atomic store with sidecar checksums, and file-based locking to prevent concurrent download races.

## Requirements Covered

R4, R13, R15–R17, S4, S6, E14

## API Contract

```typescript
import { CacheLookupResult } from "./types";

interface CacheManagerConfig {
  cacheDir: string;  // Default: ~/.cache/mcp-bin
}

interface CacheManager {
  /**
   * Check if a verified binary exists in the cache.
   * Verifies the binary's SHA256 against its .sha256 sidecar file.
   * @returns CacheHit with binaryPath, or CacheMiss
   * On sidecar missing or checksum mismatch: returns CacheMiss (triggers re-download)
   */
  lookup(serverName: string, version: string, binaryName: string): Promise<CacheLookupResult>;

  /**
   * Atomically store a binary and its sidecar checksum in the cache.
   * Moves files from tempDir into the final cache path via rename.
   * @param tempBinaryPath - Path to the extracted binary in a temp directory
   * @returns Final binary path in the cache
   */
  store(serverName: string, version: string, binaryName: string, tempBinaryPath: string): Promise<string>;

  /**
   * Acquire a file lock for a server+version. Blocks up to 60s.
   * @throws LockTimeoutError (E14) — could not acquire lock within 60s
   */
  acquireLock(serverName: string, version: string): Promise<void>;

  /**
   * Release the file lock for a server+version.
   */
  releaseLock(serverName: string, version: string): Promise<void>;

  /**
   * Return the temp directory path for a server+version download.
   * Creates the directory if it doesn't exist.
   */
  tempDir(serverName: string, version: string): Promise<string>;

  /**
   * Clean up temp directory for a server+version.
   */
  cleanupTemp(serverName: string, version: string): Promise<void>;
}
```

## Cache Layout

```
~/.cache/mcp-bin/
  .manifest/                          # ManifestClient's domain (not managed here)
  <server-name>/
    <version>/
      <binary-name>                   # The executable binary
      <binary-name>.sha256            # Sidecar: hex-encoded SHA256 of the binary
      .lock                           # Lock file (contains PID)
      .tmp/                           # Temp directory for in-progress downloads
        <binary-name>                 # Binary being extracted
        <binary-name>.sha256          # Sidecar being computed
```

## Internal Design

### Lookup Flow

```
1. Compute path: {cacheDir}/{serverName}/{version}/{binaryName}
2. Check if binary file exists → CacheMiss if not
3. Check if {binaryName}.sha256 sidecar exists → CacheMiss if not
4. Read sidecar content (hex string)
5. Compute SHA256 of binary file
6. Compare → CacheHit if match, CacheMiss if mismatch
```

On CacheMiss due to mismatch or missing sidecar, the caller (CLI) will acquire a lock and re-download. The CacheManager does not delete the corrupt files — the store operation will overwrite them atomically.

### Store Flow (Atomic Writes — R15)

```
1. Compute final paths:
   binary: {cacheDir}/{serverName}/{version}/{binaryName}
   sidecar: {cacheDir}/{serverName}/{version}/{binaryName}.sha256
2. Compute SHA256 of tempBinaryPath → write hex to temp sidecar
3. Ensure final directory exists (mkdir -p, mode 0o700)
4. rename(tempSidecarPath, finalSidecarPath)
5. rename(tempBinaryPath, finalBinaryPath)
6. Return finalBinaryPath
```

**Rename order**: Sidecar first, then binary. If the process is killed between steps 4 and 5, the cache contains a sidecar without a binary — `lookup()` returns CacheMiss (binary file doesn't exist), triggering a clean re-download. The reverse order (binary first) would leave a binary without a sidecar, which also triggers CacheMiss but leaves a larger orphan on disk.

`rename()` is atomic on the same filesystem. The temp directory is always under the same cache root, guaranteeing same-filesystem renames.

### Locking (R17)

Lock file: `{cacheDir}/{serverName}/{version}/.lock`

**Acquire:**
```
1. Attempt to create .lock file with O_CREAT | O_EXCL (atomic create-if-not-exists)
2. If created: write own PID, return success
3. If exists:
   a. Read PID from lock file
   b. Check if PID is alive (process.kill(pid, 0))
   c. If dead: delete lock file, retry from step 1
   d. Check lock file age (mtime)
   e. If age > 10 minutes: delete lock file (stale), retry from step 1
   f. If alive and fresh: wait 1s, retry
4. If 60s elapsed without acquiring: throw E14
```

**Release:**
```
1. Delete .lock file (ignore ENOENT — may have been broken by another process)
```

The lock is always released in a `finally` block by the CLI, and also cleaned up by signal handlers during the download phase.

### Temp Directory

```
1. Path: {cacheDir}/{serverName}/{version}/.tmp
2. Create with mkdir -p, mode 0o700
3. Cleanup: rm -rf the .tmp directory
```

Temp cleanup is called by the CLI in both success and failure paths, and by signal handlers.

### Directory Permissions

All directories created by the CacheManager (`cacheDir`, server dirs, version dirs, `.tmp`) use mode `0o700` (owner-only access). This prevents other users on shared systems from reading cached binaries or temp files during download.

## Error Types

```typescript
class LockTimeoutError extends McpBinError {
  constructor(serverName: string, version: string) {
    super(
      `Timed out waiting for lock on '${serverName}' v${version}. Another process may be downloading.`,
      "E14"
    );
  }
}
```

## Testing Notes

- Lookup: binary + sidecar present and matching → CacheHit
- Lookup: binary present, sidecar missing → CacheMiss
- Lookup: binary present, sidecar mismatch → CacheMiss
- Lookup: binary missing → CacheMiss
- Store: files appear at final path after store, temp files gone
- Store: concurrent store calls don't corrupt (rename is atomic)
- Lock: acquire succeeds on fresh lock
- Lock: acquire waits and succeeds when lock is released
- Lock: stale lock (dead PID) is broken
- Lock: stale lock (>10 min) is broken
- Lock: timeout after 60s throws E14
- Temp cleanup: directory removed on success and failure
