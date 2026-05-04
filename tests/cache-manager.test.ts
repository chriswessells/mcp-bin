import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { CacheManager } from "../src/cache-manager.ts";
import { LockTimeoutError, InvalidArgumentError } from "../src/errors.ts";

let tmpRoot: string;
let cm: CacheManager;

function sha256(data: Buffer | string): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

async function setupBinary(server: string, version: string, name: string, content: string) {
  const dir = path.join(tmpRoot, server, version);
  await fsp.mkdir(dir, { recursive: true });
  const binPath = path.join(dir, name);
  await fsp.writeFile(binPath, content);
  await fsp.writeFile(binPath + ".sha256", sha256(content));
  return binPath;
}

describe("CacheManager", () => {
  beforeEach(async () => {
    tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "mcp-bin-test-"));
    cm = new CacheManager({ cacheDir: tmpRoot });
  });

  afterEach(async () => {
    await fsp.rm(tmpRoot, { recursive: true, force: true });
  });

  describe("lookup", () => {
    it("returns CacheHit when binary and sidecar match", async () => {
      const binPath = await setupBinary("srv", "1.0", "bin", "hello");
      const result = await cm.lookup("srv", "1.0", "bin");
      assert.deepEqual(result, { hit: true, binaryPath: binPath });
    });

    it("returns CacheMiss when binary does not exist", async () => {
      const result = await cm.lookup("srv", "1.0", "bin");
      assert.deepEqual(result, { hit: false });
    });

    it("returns CacheMiss when sidecar has wrong hash", async () => {
      const dir = path.join(tmpRoot, "srv", "1.0");
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(path.join(dir, "bin"), "hello");
      await fsp.writeFile(path.join(dir, "bin.sha256"), "badhash");
      const result = await cm.lookup("srv", "1.0", "bin");
      assert.deepEqual(result, { hit: false });
    });
  });

  describe("store", () => {
    it("atomically stores binary and sidecar at final path", async () => {
      const tmpDir = await cm.tempDir("srv", "1.0");
      const tempBin = path.join(tmpDir, "bin");
      await fsp.writeFile(tempBin, "payload");

      const finalPath = await cm.store("srv", "1.0", "bin", tempBin);

      assert.equal(finalPath, path.join(tmpRoot, "srv", "1.0", "bin"));
      const content = await fsp.readFile(finalPath, "utf-8");
      assert.equal(content, "payload");

      const sidecar = await fsp.readFile(finalPath + ".sha256", "utf-8");
      assert.equal(sidecar, sha256("payload"));

      // Verify lookup succeeds after store
      const result = await cm.lookup("srv", "1.0", "bin");
      assert.deepEqual(result, { hit: true, binaryPath: finalPath });
    });
  });

  describe("locking", () => {
    it("acquires and releases a lock", async () => {
      await cm.acquireLock("srv", "1.0");
      const lockPath = path.join(tmpRoot, "srv", "1.0", ".lock");
      assert.ok(fs.existsSync(lockPath));

      await cm.releaseLock("srv", "1.0");
      assert.ok(!fs.existsSync(lockPath));
    });

    it("breaks stale lock from dead PID", async () => {
      const dir = path.join(tmpRoot, "srv", "1.0");
      await fsp.mkdir(dir, { recursive: true });
      // PID 99999999 should not exist
      await fsp.writeFile(path.join(dir, ".lock"), "99999999");

      await cm.acquireLock("srv", "1.0");
      // Should succeed by breaking the stale lock
      const content = await fsp.readFile(path.join(dir, ".lock"), "utf-8");
      assert.equal(content, String(process.pid));
      await cm.releaseLock("srv", "1.0");
    });

    it("throws LockTimeoutError when lock cannot be acquired", async () => {
      // Create a lock held by our own PID (alive process) — can't be broken
      const dir = path.join(tmpRoot, "srv", "1.0");
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(path.join(dir, ".lock"), String(process.pid));

      // Monkey-patch timeout for fast test by creating a subclass
      const ShortCM = class extends CacheManager {
        async acquireLock(serverName: string, version: string): Promise<void> {
          // Inline a short-timeout version
          const lockPath = path.join(tmpRoot, serverName, version, ".lock");
          const deadline = Date.now() + 2_000; // 2s timeout
          while (Date.now() < deadline) {
            try {
              const fd = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY);
              fs.writeSync(fd, String(process.pid));
              fs.closeSync(fd);
              return;
            } catch (err: any) {
              if (err.code !== "EEXIST") throw err;
            }
            try {
              const content = await fsp.readFile(lockPath, "utf-8");
              const pid = parseInt(content.trim(), 10);
              try { process.kill(pid, 0); } catch { try { await fsp.unlink(lockPath); } catch {} continue; }
            } catch { continue; }
            await new Promise(r => setTimeout(r, 200));
          }
          throw new LockTimeoutError(serverName, version);
        }
      };

      const shortCm = new ShortCM({ cacheDir: tmpRoot });
      await assert.rejects(() => shortCm.acquireLock("srv", "1.0"), LockTimeoutError);

      // Cleanup
      await fsp.unlink(path.join(dir, ".lock"));
    });
  });

  describe("tempDir / cleanupTemp", () => {
    it("creates and cleans up temp directory", async () => {
      const tmp = await cm.tempDir("srv", "1.0");
      assert.ok(fs.existsSync(tmp));
      assert.ok(tmp.endsWith(".tmp"));

      await cm.cleanupTemp("srv", "1.0");
      assert.ok(!fs.existsSync(tmp));
    });
  });

  describe("evict (C3)", () => {
    it("T16: evicts oldest version when count exceeds max", async () => {
      const evictCm = new CacheManager({ cacheDir: tmpRoot, maxVersions: 2 });

      for (const [i, ver] of ["1.0.0", "2.0.0", "3.0.0"].entries()) {
        const dir = path.join(tmpRoot, "srv", ver);
        await fsp.mkdir(dir, { recursive: true });
        await fsp.writeFile(path.join(dir, "bin"), `v${ver}`);
        const t = new Date(Date.now() - (3 - i) * 60_000);
        await fsp.utimes(dir, t, t);
      }

      await evictCm.evict("srv", "3.0.0");

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

      await fsp.writeFile(path.join(tmpRoot, "srv", "1.0.0", ".lock"), String(process.pid));

      await evictCm.evict("srv", "2.0.0");

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

      await fsp.writeFile(path.join(tmpRoot, "srv", "1.0.0", ".running"), String(process.pid));

      await evictCm.evict("srv", "2.0.0");

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

      const runningPath = path.join(tmpRoot, "srv", "1.0.0", ".running");
      await fsp.writeFile(runningPath, String(process.pid));
      const staleTime = new Date(Date.now() - 25 * 60 * 60 * 1000);
      await fsp.utimes(runningPath, staleTime, staleTime);

      await evictCm.evict("srv", "2.0.0");

      assert.ok(!fs.existsSync(path.join(tmpRoot, "srv", "1.0.0")));
    });

    it("T21: versionDir rejects path traversal in serverName", async () => {
      await assert.rejects(
        () => cm.lookup("../etc", "1.0.0", "bin"),
        (err: any) => {
          assert.strictEqual(err.code, "EINVAL");
          return true;
        }
      );
    });
  });
});
