import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { CacheLookupResult } from "./types.js";
import { LockTimeoutError, InvalidArgumentError } from "./errors.js";

export interface CacheManagerConfig {
  cacheDir: string;
  maxVersions: number;
  logger: (msg: string) => void;
}

const LOCK_TIMEOUT_MS = 60_000;
const LOCK_POLL_MS = 1_000;
const STALE_LOCK_MS = 3 * 60 * 1_000; // 3 minutes — reduced from 10 to limit PID recycling window
const STALE_RUNNING_MS = 24 * 60 * 60 * 1_000; // 24 hours — age-based fallback for .running sentinel

async function sha256File(filePath: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export class CacheManager {
  private readonly cacheDir: string;
  private readonly maxVersions: number;
  private readonly logger: (msg: string) => void;

  private static readonly SAFE_NAME_RE = /^[a-zA-Z0-9._-]+$/;

  constructor(config: Partial<CacheManagerConfig> & { cacheDir: string }) {
    this.cacheDir = config.cacheDir;
    this.maxVersions = config.maxVersions ?? 5;
    this.logger = config.logger ?? (() => {});
  }

  private versionDir(serverName: string, version: string): string {
    if (!CacheManager.SAFE_NAME_RE.test(serverName)) {
      throw new InvalidArgumentError(`Invalid server name: '${serverName}'`);
    }
    if (!CacheManager.SAFE_NAME_RE.test(version)) {
      throw new InvalidArgumentError(`Invalid version: '${version}'`);
    }
    return path.join(this.cacheDir, serverName, version);
  }

  async lookup(serverName: string, version: string, binaryName: string): Promise<CacheLookupResult> {
    const dir = this.versionDir(serverName, version);
    const binaryPath = path.join(dir, binaryName);
    const sidecarPath = binaryPath + ".sha256";

    try {
      await fsp.access(binaryPath);
    } catch {
      return { hit: false };
    }

    try {
      const expected = (await fsp.readFile(sidecarPath, "utf-8")).trim();
      const actual = await sha256File(binaryPath);
      return actual === expected ? { hit: true, binaryPath } : { hit: false };
    } catch {
      return { hit: false };
    }
  }

  async store(serverName: string, version: string, binaryName: string, tempBinaryPath: string): Promise<string> {
    const dir = this.versionDir(serverName, version);
    const finalBinaryPath = path.join(dir, binaryName);
    const finalSidecarPath = finalBinaryPath + ".sha256";

    const hash = await sha256File(tempBinaryPath);
    const tempSidecarPath = tempBinaryPath + ".sha256";
    await fsp.writeFile(tempSidecarPath, hash, "utf-8");

    await fsp.mkdir(dir, { recursive: true, mode: 0o700 });

    // Rename sidecar first, then binary (see design doc for rationale)
    await fsp.rename(tempSidecarPath, finalSidecarPath);
    try {
      await fsp.rename(tempBinaryPath, finalBinaryPath);
    } catch (err) {
      // Clean up orphaned sidecar if binary rename fails
      await fsp.unlink(finalSidecarPath).catch(() => {});
      throw err;
    }

    return finalBinaryPath;
  }

  async acquireLock(serverName: string, version: string): Promise<void> {
    const dir = this.versionDir(serverName, version);
    const lockPath = path.join(dir, ".lock");
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 });

    const deadline = Date.now() + LOCK_TIMEOUT_MS;

    while (Date.now() < deadline) {
      try {
        const fd = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY);
        fs.writeSync(fd, String(process.pid));
        fs.closeSync(fd);
        return;
      } catch (err: any) {
        if (err.code !== "EEXIST") throw err;
      }

      // Lock exists — check if stale
      try {
        const content = await fsp.readFile(lockPath, "utf-8");
        const pid = parseInt(content.trim(), 10);
        const stat = await fsp.stat(lockPath);
        const age = Date.now() - stat.mtimeMs;

        if (!pidAlive(pid) || age > STALE_LOCK_MS) {
          try { await fsp.unlink(lockPath); } catch {}
          continue;
        }
      } catch {
        // Lock file disappeared between check and read — retry
        continue;
      }

      await new Promise(r => setTimeout(r, LOCK_POLL_MS));
    }

    throw new LockTimeoutError(serverName, version);
  }

  async releaseLock(serverName: string, version: string): Promise<void> {
    const lockPath = path.join(this.versionDir(serverName, version), ".lock");
    try {
      await fsp.unlink(lockPath);
    } catch (err: any) {
      if (err.code !== "ENOENT") throw err;
    }
  }

  async tempDir(serverName: string, version: string): Promise<string> {
    const tmpPath = path.join(this.versionDir(serverName, version), ".tmp");
    await fsp.mkdir(tmpPath, { recursive: true, mode: 0o700 });
    return tmpPath;
  }

  async cleanupTemp(serverName: string, version: string): Promise<void> {
    const tmpPath = path.join(this.versionDir(serverName, version), ".tmp");
    await fsp.rm(tmpPath, { recursive: true, force: true });
  }

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
        const pidStr = await fsp.readFile(path.join(dir, '.running'), 'utf-8');
        const pid = parseInt(pidStr.trim(), 10);
        const runningStat = await fsp.stat(path.join(dir, '.running'));
        if (Date.now() - runningStat.mtimeMs > STALE_RUNNING_MS) {
          await fsp.unlink(path.join(dir, '.running')).catch(() => {});
        } else if (!isNaN(pid) && pidAlive(pid)) {
          continue;
        } else {
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
}
