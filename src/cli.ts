#!/usr/bin/env node
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { InvalidArgumentError, McpBinError, InvalidPublicKeyError, sanitizeUrl } from "./errors.js";
import { detectPlatform } from "./platform.js";
import { ManifestClient, resolveLatest } from "./manifest-client.js";
import { CacheManager } from "./cache-manager.js";
import { download, DEFAULT_CONFIG } from "./downloader.js";
import { extract } from "./extractor.js";
import { createProcessRunner } from "./process-runner.js";

const DEFAULT_MANIFEST_URL = "https://your-registry.example.com/manifest.json";
const SAFE_NAME_RE = /^[a-zA-Z0-9._-]+$/;

const isVerbose = process.env.MCP_BIN_VERBOSE === "1";
const isDebug = process.env.MCP_BIN_DEBUG === "1" || isVerbose;

const debug = isDebug
  ? (msg: string) => process.stderr.write(`[debug] ${msg}\n`)
  : (() => {}) as (msg: string) => void;

const verbose = isVerbose
  ? (msg: string) => process.stderr.write(`[mcp-bin] ${msg}\n`)
  : (() => {}) as (msg: string) => void;

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
  const { serverName, version: rawVersion, extraArgs } = parseArgs(process.argv.slice(2));
  let version = rawVersion;
  const platformKey = detectPlatform();
  debug(`platform: ${platformKey}`);

  const manifestUrl = process.env.MCP_BIN_MANIFEST_URL ?? DEFAULT_MANIFEST_URL;
  const cacheDir = process.env.MCP_BIN_CACHE_DIR ?? path.join(os.homedir(), ".cache", "mcp-bin");

  // S10: Warn on non-default manifest URL
  if (process.env.MCP_BIN_MANIFEST_URL) {
    process.stderr.write(`Warning: using custom manifest URL: ${manifestUrl}\n`);
  }

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

  // Phase 1: Resolve
  debug("fetching manifest");
  const { manifest, warnings } = await manifestClient.fetch();
  for (const w of warnings) process.stderr.write(`${w}\n`);

  // C2: Resolve "latest" to concrete version
  if (version === "latest") {
    version = resolveLatest(manifest, serverName);
    process.stderr.write(`Resolved latest → ${version}\n`);
  }

  const entry = manifestClient.resolve(manifest, serverName, version, platformKey);
  debug(`resolved: ${sanitizeUrl(entry.url)}`);
  verbose(`Resolved: url=${sanitizeUrl(entry.url)}, sha256=${entry.sha256}, binary=${entry.binaryName}`);

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
  verbose(`Cache lookup: ${cacheResult.hit ? 'hit' : 'miss'}`);
  let binaryPath: string;
  let didStore = false;
  const runningPath = path.join(cacheDir, serverName, version, ".running");

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
        // Write .running sentinel inside lock to protect against concurrent eviction
        await fsp.writeFile(runningPath, String(process.pid)).catch(() => {});
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

        // C3.7: Write .running sentinel immediately after store — before utimes and eviction.
        await fsp.writeFile(runningPath, String(process.pid)).catch(() => {});

        // C3.6: Update mtime to reflect store completion (best-effort)
        await fsp.utimes(path.join(cacheDir, serverName, version), new Date(), new Date()).catch(() => {});
        didStore = true;
      }
    } finally {
      await cacheManager.releaseLock(serverName, version);
      await cacheManager.cleanupTemp(serverName, version);
      process.removeListener("SIGTERM", downloadPhaseHandler);
      process.removeListener("SIGINT", downloadPhaseHandler);
      cleanupPath = null;
    }
  }

  if (didStore) {
    await cacheManager.evict(serverName, version).catch((err) => {
      process.stderr.write(`Warning: cache eviction failed: ${err instanceof Error ? err.message : String(err)}\n`);
    });
  }

  // Cache hit (no lock path) — write .running sentinel for exec protection
  if (!didStore && cacheResult.hit) {
    await fsp.writeFile(runningPath, String(process.pid)).catch(() => {});
  }

  // Phase 4: Exec
  verbose(`Executing: ${binaryPath} ${extraArgs.join(' ')}`.trimEnd());
  debug(`executing: ${binaryPath}`);
  const runner = createProcessRunner();

  const exitCode = await runner.exec(binaryPath, extraArgs);

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
