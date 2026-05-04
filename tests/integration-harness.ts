#!/usr/bin/env node
/**
 * Integration test harness — mirrors src/cli.ts but accepts PUBLIC_KEY env var
 * (base64-encoded DER SPKI) to allow test-signed manifests.
 *
 * NOTE: Keep in sync with src/cli.ts orchestration logic. Key differences:
 * - Accepts PUBLIC_KEY env var instead of hardcoded key
 * - Accepts MCP_BIN_DOWNLOAD_TIMEOUT / MCP_BIN_CONNECT_TIMEOUT for test control
 * - No MCP_BIN_CHECK diagnostic mode
 *
 * Requires env: MCP_BIN_MANIFEST_URL, MCP_BIN_CACHE_DIR, PUBLIC_KEY
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { detectPlatform } from "../src/platform.ts";
import { ManifestClient, resolveLatest } from "../src/manifest-client.ts";
import { CacheManager } from "../src/cache-manager.ts";
import { download, DEFAULT_CONFIG, type DownloaderConfig } from "../src/downloader.ts";
import { extract } from "../src/extractor.ts";
import { createProcessRunner } from "../src/process-runner.ts";
import { McpBinError } from "../src/errors.ts";

const SAFE_NAME_RE = /^[a-zA-Z0-9._-]+$/;

const [serverName, version, ...extraArgs] = process.argv.slice(2);
if (!serverName || !version) {
  process.stderr.write("Usage: integration-harness <server> <version> [args...]\n");
  process.exit(1);
}
if (!SAFE_NAME_RE.test(serverName) || !SAFE_NAME_RE.test(version)) {
  process.stderr.write("Invalid server name or version\n");
  process.exit(1);
}

const manifestUrl = process.env.MCP_BIN_MANIFEST_URL!;
const cacheDir = process.env.MCP_BIN_CACHE_DIR!;
const publicKey = Buffer.from(process.env.PUBLIC_KEY!, "base64");

// Allow overriding download timeout for tests
const dlConfig: DownloaderConfig = {
  ...DEFAULT_CONFIG,
  ...(process.env.MCP_BIN_DOWNLOAD_TIMEOUT
    ? { downloadTimeout: Number(process.env.MCP_BIN_DOWNLOAD_TIMEOUT) }
    : {}),
  ...(process.env.MCP_BIN_CONNECT_TIMEOUT
    ? { connectTimeout: Number(process.env.MCP_BIN_CONNECT_TIMEOUT) }
    : {}),
};

async function main(): Promise<void> {
  const platformKey = detectPlatform();
  const manifestClient = new ManifestClient({ cacheDir, manifestUrl, publicKey });

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

  const { manifest } = await manifestClient.fetch();

  let resolvedVersion = version;
  if (resolvedVersion === "latest") {
    resolvedVersion = resolveLatest(manifest, serverName);
    process.stderr.write(`Resolved latest → ${resolvedVersion}\n`);
  }

  const entry = manifestClient.resolve(manifest, serverName, resolvedVersion, platformKey);

  const cacheResult = await cacheManager.lookup(serverName, resolvedVersion, entry.binaryName);
  let binaryPath: string;
  let didStore = false;

  if (cacheResult.hit) {
    binaryPath = cacheResult.binaryPath;
  } else {
    await cacheManager.acquireLock(serverName, resolvedVersion);

    // Signal handlers for download-phase cleanup (mirrors cli.ts)
    const lockPath = path.join(cacheDir, serverName, resolvedVersion, ".lock");
    let cleanupPath: string | null = null;
    const downloadPhaseHandler = () => {
      if (cleanupPath) try { fs.rmSync(cleanupPath, { recursive: true, force: true }); } catch {}
      try { fs.unlinkSync(lockPath); } catch {}
      process.exit(1);
    };
    process.on("SIGTERM", downloadPhaseHandler);
    process.on("SIGINT", downloadPhaseHandler);

    try {
      const recheck = await cacheManager.lookup(serverName, resolvedVersion, entry.binaryName);
      if (recheck.hit) {
        binaryPath = recheck.binaryPath;
      } else {
        const tmpDir = await cacheManager.tempDir(serverName, resolvedVersion);
        cleanupPath = tmpDir;
        const archivePath = path.join(tmpDir, "archive.tar.gz");
        await download(entry.url, entry.sha256, archivePath, dlConfig, undefined, { serverName, version: resolvedVersion });
        const tmpBinaryPath = await extract(archivePath, entry.binaryName, tmpDir);
        binaryPath = await cacheManager.store(serverName, resolvedVersion, entry.binaryName, tmpBinaryPath);

        // Write .running sentinel immediately after store (before utimes/eviction)
        const runningPath = path.join(cacheDir, serverName, resolvedVersion, ".running");
        await fsp.writeFile(runningPath, String(process.pid)).catch(() => {});

        const versionDirPath = path.join(cacheDir, serverName, resolvedVersion);
        await fsp.utimes(versionDirPath, new Date(), new Date()).catch(() => {});
        didStore = true;
      }
    } finally {
      await cacheManager.releaseLock(serverName, resolvedVersion);
      await cacheManager.cleanupTemp(serverName, resolvedVersion);
      process.removeListener("SIGTERM", downloadPhaseHandler);
      process.removeListener("SIGINT", downloadPhaseHandler);
    }
  }

  if (didStore) {
    await cacheManager.evict(serverName, resolvedVersion).catch(() => {});
  }

  // Cache hit path — write .running sentinel before exec
  if (!didStore) {
    const runningPath = path.join(cacheDir, serverName, resolvedVersion, ".running");
    await fsp.writeFile(runningPath, String(process.pid)).catch(() => {});
  }

  const runner = createProcessRunner();
  const exitCode = await runner.exec(binaryPath, extraArgs);

  // Remove .running sentinel after exec
  const runningPath = path.join(cacheDir, serverName, resolvedVersion, ".running");
  await fsp.unlink(runningPath).catch(() => {});
  process.exit(exitCode);
}

main().catch((err) => {
  if (err instanceof McpBinError) {
    process.stderr.write(`${err.message}\n`);
    process.exit(err.exitCode);
  }
  process.stderr.write(`Unexpected error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
