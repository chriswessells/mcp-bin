# v1.x CacheManager Changes

## Overview

Three changes to `src/cache-manager.ts`:
1. **C3**: Add `evict()` method with early-exit optimization
2. **C3 security**: Add `SAFE_NAME_RE` validation in `versionDir()`
3. **C3.7**: Support `.running` sentinel awareness in `evict()`
4. **C4**: Accept optional logger callback

## C3 Security: Path Validation in versionDir()

### Current Code
```typescript
private versionDir(serverName: string, version: string): string {
  return path.join(this.cacheDir, serverName, version);
}
```

### New Code
```typescript
private static readonly SAFE_NAME_RE = /^[a-zA-Z0-9._-]+$/;

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

Import `InvalidArgumentError` from `./errors.js` (add to existing import).

## C4: Logger Injection

### Config Change
```typescript
export interface CacheManagerConfig {
  cacheDir: string;
  maxVersions: number;
  logger: (msg: string) => void;
}
```

### Constructor Change
```typescript
private readonly cacheDir: string;
private readonly maxVersions: number;
private readonly logger: (msg: string) => void;

constructor(config: Partial<CacheManagerConfig> & { cacheDir: string }) {
  this.cacheDir = config.cacheDir;
  this.maxVersions = config.maxVersions ?? 5;
  this.logger = config.logger ?? (() => {});
}
```

## C3: evict() Method

### Signature
```typescript
async evict(serverName: string, currentVersion: string): Promise<void>
```

### Algorithm
```typescript
async evict(serverName: string, currentVersion: string): Promise<void> {
  if (this.maxVersions === 0) return; // C3.5: disabled

  const serverDir = path.join(this.cacheDir, serverName);
  let entries: string[];
  try {
    entries = await fsp.readdir(serverDir);
  } catch {
    return; // Server dir doesn't exist — nothing to evict
  }

  // Filter to version dirs only (exclude .manifest, .tmp, etc.)
  const versionDirs = entries.filter(e => CacheManager.SAFE_NAME_RE.test(e) && !e.startsWith('.'));

  // C3.8: Early-exit if count within limit
  if (versionDirs.length <= this.maxVersions) return;

  // Stat mtimes
  const stats: Array<{ name: string; mtimeMs: number }> = [];
  for (const name of versionDirs) {
    if (name === currentVersion) continue; // C3.3: never evict current
    const dir = path.join(serverDir, name);
    try {
      // C3.3: skip dirs with .lock
      await fsp.access(path.join(dir, '.lock'));
      continue;
    } catch {
      // No .lock — good
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
      // No .running — good
    }
    try {
      const st = await fsp.stat(dir);
      stats.push({ name, mtimeMs: st.mtimeMs });
    } catch {
      continue; // Dir disappeared — skip
    }
  }

  // Sort by mtime ascending (oldest first)
  stats.sort((a, b) => a.mtimeMs - b.mtimeMs);

  // Evict oldest until count <= maxVersions
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
      // C3.4: best-effort — log and continue
      this.logger(`Failed to evict ${serverName}@${entry.name}`);
    }
  }
}
```

Note: `pidAlive` already exists in the file as a module-level function. No need to add it.

## C3.6: utimes After Store

This is done in `cli.ts`, NOT in CacheManager. After `store()` returns, cli.ts calls:
```typescript
const versionDirPath = path.join(cacheDir, serverName, version);
const now = new Date();
await fsp.utimes(versionDirPath, now, now).catch(() => {});
```

This ensures mtime reflects store completion, not directory creation time. The `.catch(() => {})` is intentional — `utimes()` can throw (EPERM, ENOENT from concurrent eviction) and mtime accuracy is best-effort for eviction ordering.

## Contract Summary

### CacheManagerConfig (updated)
```typescript
export interface CacheManagerConfig {
  cacheDir: string;
  maxVersions: number;
  logger: (msg: string) => void;
}
```

### Constructor (updated)
```typescript
constructor(config: Partial<CacheManagerConfig> & { cacheDir: string })
```
- Defaults `maxVersions` to `5`
- Defaults `logger` to no-op

### evict (new)
```typescript
async evict(serverName: string, currentVersion: string): Promise<void>
```
- Best-effort: never throws (caller wraps in `.catch()` anyway, but method itself swallows internal errors)
- Skips eviction when `maxVersions === 0`
- Skips `currentVersion`, dirs with `.lock`, dirs with live `.running`
- Cleans up stale `.running` files (dead PID or older than 24 hours / `STALE_RUNNING_MS`)
- Age-based fallback prevents recycled PIDs from permanently blocking eviction
- Early-exits when version count ≤ limit

### Existing methods — no signature changes
- `lookup()`, `store()`, `acquireLock()`, `releaseLock()`, `tempDir()`, `cleanupTemp()` — unchanged except `versionDir()` now validates inputs
