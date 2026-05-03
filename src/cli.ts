#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { InvalidArgumentError, McpBinError } from "./errors.js";
import { detectPlatform } from "./platform.js";
import { ManifestClient } from "./manifest-client.js";
import { CacheManager } from "./cache-manager.js";
import { download, DEFAULT_CONFIG } from "./downloader.js";
import { extract } from "./extractor.js";
import { createProcessRunner } from "./process-runner.js";

const DEFAULT_MANIFEST_URL = "https://mcpregistry.wessells.io/manifest.json";
const SAFE_NAME_RE = /^[a-zA-Z0-9._-]+$/;

const debug = process.env.MCP_BIN_DEBUG === "1"
  ? (msg: string) => process.stderr.write(`[debug] ${msg}\n`)
  : () => {};

function parseArgs(argv: string[]): { serverName: string; version: string; extraArgs: string[] } {
  const [serverName, version, ...extraArgs] = argv;
  if (!serverName || !version) {
    process.stderr.write("Usage: mcp-bin-runner <server-name> <version> [extra-args...]\n");
    process.exit(1);
  }
  if (!SAFE_NAME_RE.test(serverName)) {
    throw new InvalidArgumentError(`Invalid server name: '${serverName}'`);
  }
  if (!SAFE_NAME_RE.test(version)) {
    throw new InvalidArgumentError(`Invalid version: '${version}'`);
  }
  return { serverName, version, extraArgs };
}

async function main(): Promise<void> {
  const { serverName, version, extraArgs } = parseArgs(process.argv.slice(2));
  const platformKey = detectPlatform();
  debug(`platform: ${platformKey}`);

  const manifestUrl = process.env.MCP_BIN_MANIFEST_URL ?? DEFAULT_MANIFEST_URL;
  const cacheDir = process.env.MCP_BIN_CACHE_DIR ?? path.join(os.homedir(), ".cache", "mcp-bin");

  // S10: Warn on non-default manifest URL
  if (process.env.MCP_BIN_MANIFEST_URL) {
    process.stderr.write(`Warning: using custom manifest URL: ${manifestUrl}\n`);
  }

  const manifestClient = new ManifestClient({ cacheDir, manifestUrl });
  const cacheManager = new CacheManager({ cacheDir });

  // Phase 1: Resolve
  debug("fetching manifest");
  const { manifest, warnings } = await manifestClient.fetch();
  for (const w of warnings) process.stderr.write(`${w}\n`);

  const entry = manifestClient.resolve(manifest, serverName, version, platformKey);
  debug(`resolved: ${entry.url}`);

  // MCP_BIN_CHECK=1 diagnostic mode
  if (process.env.MCP_BIN_CHECK === "1") {
    process.stderr.write(`server: ${serverName}\n`);
    process.stderr.write(`version: ${version}\n`);
    process.stderr.write(`platform: ${platformKey}\n`);
    process.stderr.write(`url: ${entry.url}\n`);
    process.stderr.write(`sha256: ${entry.sha256}\n`);
    process.stderr.write(`binary: ${entry.binaryName}\n`);
    process.exit(0);
  }

  // Phase 2: Cache check
  const cacheResult = await cacheManager.lookup(serverName, version, entry.binaryName);
  let binaryPath: string;

  if (cacheResult.hit) {
    debug("cache hit");
    binaryPath = cacheResult.binaryPath;
  } else {
    // Phase 3: Download + extract + cache
    debug("cache miss, acquiring lock");
    await cacheManager.acquireLock(serverName, version);

    let cleanupPath: string | null = null;
    const lockPath = path.join(cacheDir, serverName, version, ".lock");
    const downloadPhaseHandler = () => {
      if (cleanupPath) {
        try { fs.rmSync(cleanupPath, { recursive: true, force: true }); } catch {}
      }
      try { fs.unlinkSync(lockPath); } catch {}
      process.exit(1);
    };
    process.on("SIGTERM", downloadPhaseHandler);
    process.on("SIGINT", downloadPhaseHandler);

    try {
      // Re-check cache after lock
      const recheck = await cacheManager.lookup(serverName, version, entry.binaryName);
      if (recheck.hit) {
        debug("cache hit after lock");
        binaryPath = recheck.binaryPath;
      } else {
        const tmpDir = await cacheManager.tempDir(serverName, version);
        cleanupPath = tmpDir;
        const archivePath = path.join(tmpDir, "archive.tar.gz");

        debug("downloading");
        await download(entry.url, entry.sha256, archivePath, DEFAULT_CONFIG, undefined, { serverName, version });

        debug("extracting");
        const tmpBinaryPath = await extract(archivePath, entry.binaryName, tmpDir);

        debug("storing in cache");
        binaryPath = await cacheManager.store(serverName, version, entry.binaryName, tmpBinaryPath);
      }
    } finally {
      await cacheManager.releaseLock(serverName, version);
      await cacheManager.cleanupTemp(serverName, version);
      process.removeListener("SIGTERM", downloadPhaseHandler);
      process.removeListener("SIGINT", downloadPhaseHandler);
      cleanupPath = null;
    }
  }

  // Phase 4: Exec
  debug(`executing: ${binaryPath}`);
  const runner = createProcessRunner();
  const exitCode = await runner.exec(binaryPath, extraArgs);
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
