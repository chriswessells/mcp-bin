# Component Design — CLI

## Purpose

Entry point for the runner. Parses arguments, detects the platform, orchestrates all components, handles errors, and manages signal handler transitions.

## Requirements Covered

R1–R2, R11–R14, R24, E1–E3, E7, S10

## API Contract

The CLI is not imported by other components. It is the `bin` entry point in `package.json`.

```
Usage: mcp-bin-runner <server-name> <version> [-- extra-args...]

Positional:
  server-name   Name of the MCP server in the manifest
  version       Exact version string (e.g. "1.0.0")

Everything after server-name and version is forwarded to the binary (R14).

Environment:
  MCP_BIN_MANIFEST_URL   Override manifest URL (default: https://chriswessells.github.io/mcp-bin/manifest.json)
  MCP_BIN_CACHE_DIR      Override cache directory (default: ~/.cache/mcp-bin)
```

## Internal Design

### Argument Parsing

```typescript
const SAFE_NAME_RE = /^[a-zA-Z0-9._-]+$/;

function parseArgs(argv: string[]): { serverName: string; version: string; extraArgs: string[] } {
  // argv = process.argv.slice(2)
  const [serverName, version, ...extraArgs] = argv;
  if (!serverName || !version) {
    process.stderr.write("Usage: mcp-bin-runner <server-name> <version> [extra-args...]\n");
    process.exit(1);
  }
  if (!SAFE_NAME_RE.test(serverName)) {
    throw new InvalidArgumentError("server name", serverName);
  }
  if (!SAFE_NAME_RE.test(version)) {
    throw new InvalidArgumentError("version", version);
  }
  return { serverName, version, extraArgs };
}
```

Both `serverName` and `version` are validated against `/^[a-zA-Z0-9._-]+$/` before any filesystem operations. This prevents path traversal via CLI arguments (e.g., `../../etc` as server name). The `InvalidArgumentError` is defined in `errors.ts`.

No flag parsing library needed. Positional args only (ADR-006).

### Platform Detection

```typescript
import { arch, platform } from "node:os";

function detectPlatform(): Platform {
  const p = platform();  // "darwin", "linux"
  const a = arch();      // "arm64", "x64"
  const key = `${p}-${a}`;
  if (key !== "darwin-arm64" && key !== "linux-x64" && key !== "linux-arm64") {
    process.stderr.write(`No binary available for platform '${key}'\n`);
    process.exit(1);
  }
  return key as Platform;
}
```

### Orchestration Flow

```typescript
async function main(): Promise<void> {
  const { serverName, version, extraArgs } = parseArgs(process.argv.slice(2));
  const platformKey = detectPlatform();

  const manifestUrl = process.env.MCP_BIN_MANIFEST_URL ?? DEFAULT_MANIFEST_URL;
  const cacheDir = process.env.MCP_BIN_CACHE_DIR ?? defaultCacheDir();

  // Warn on non-default manifest URL (S10)
  if (process.env.MCP_BIN_MANIFEST_URL) {
    process.stderr.write(`Warning: using custom manifest URL: ${manifestUrl}\n`);
  }

  const manifestClient = new ManifestClient({ manifestUrl, cacheDir, publicKey: PINNED_PUBLIC_KEY });
  const cacheManager = new CacheManager({ cacheDir });
  const downloader = new Downloader(DEFAULT_DOWNLOADER_CONFIG);
  const extractor = new Extractor();
  const processRunner = new ProcessRunner(DEFAULT_RUNNER_CONFIG);

  // Phase 1: Resolve
  const manifest = await manifestClient.fetch();
  const entry = manifestClient.resolve(manifest, serverName, version, platformKey);

  // Phase 2: Cache check
  const cacheResult = await cacheManager.lookup(serverName, version, entry.binaryName);
  let binaryPath: string;

  if (cacheResult.hit) {
    binaryPath = cacheResult.binaryPath;
  } else {
    // Phase 3: Download + extract + cache
    await cacheManager.acquireLock(serverName, version);
    try {
      // Re-check cache after acquiring lock (another process may have completed)
      const recheck = await cacheManager.lookup(serverName, version, entry.binaryName);
      if (recheck.hit) {
        binaryPath = recheck.binaryPath;
      } else {
        const tmpDir = await cacheManager.tempDir(serverName, version);
        const archivePath = `${tmpDir}/archive.tar.gz`;

        await downloader.download(entry.url, entry.sha256, archivePath);
        const tmpBinaryPath = await extractor.extract(archivePath, entry.binaryName, tmpDir);
        binaryPath = await cacheManager.store(serverName, version, entry.binaryName, tmpBinaryPath);
      }
    } finally {
      await cacheManager.releaseLock(serverName, version);
      await cacheManager.cleanupTemp(serverName, version);
    }
  }

  // Phase 4: Exec (no more stderr output after this point)
  const exitCode = await processRunner.exec(binaryPath, extraArgs);
  process.exit(exitCode);
}
```

### Signal Handler Phases

**Download phase** (before `processRunner.exec`):
```typescript
let cleanupPath: string | null = null;

const downloadPhaseHandler = (signal: NodeJS.Signals) => {
  if (cleanupPath) {
    try { fs.rmSync(cleanupPath, { recursive: true, force: true }); } catch {}
  }
  process.exit(1);
};

process.on("SIGTERM", downloadPhaseHandler);
process.on("SIGINT", downloadPhaseHandler);
```

Uses `fs.rmSync` (synchronous) because signal handlers cannot reliably `await` async operations. The `cleanupPath` is set to the temp directory path when it exists.

**Exec phase** (after `processRunner.exec` is called): Signal handlers are removed. The ProcessRunner installs its own handlers that forward to the child.

### Error Handling

The `main()` function wraps everything in a try/catch:

```typescript
main().catch((err) => {
  if (err instanceof McpBinError) {
    process.stderr.write(`${err.message}\n`);
    process.exit(err.exitCode);
  }
  process.stderr.write(`Unexpected error: ${err.message}\n`);
  process.exit(1);
});
```

All errors go to stderr (R11, E7). Stdout is never used by the runner.

### Package Configuration

```json
{
  "name": "@mcp-bin/runner",
  "version": "1.0.0",
  "bin": {
    "mcp-bin-runner": "./dist/cli.js"
  },
  "files": ["dist"],
  "engines": { "node": ">=18" }
}
```

The `bin` field makes `npx @mcp-bin/runner` invoke `dist/cli.js`. The shebang `#!/usr/bin/env node` is added to `cli.ts` output.

## Testing Notes

- Missing server name → usage message, exit 1
- Missing version → usage message, exit 1
- Extra args forwarded to binary
- Platform detection: correct key on darwin-arm64, linux-x64, linux-arm64
- Unsupported platform → exit 1 with E3 message
- Custom manifest URL → warning to stderr
- Cache hit → no download, binary executed
- Cache miss → download, extract, cache, execute
- Lock contention → second process waits, re-checks cache after lock acquired
- Signal during download → temp files cleaned up
- Error formatting: all McpBinError messages appear on stderr
