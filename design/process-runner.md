# Component Design — ProcessRunner

## Purpose

Spawns the native binary as a child process with stdio inherited, forwards signals, filters sensitive environment variables, and propagates the child's exit code.

## Requirements Covered

R9–R10, R14, R20, S5, S12, E7

## API Contract

```typescript
interface ProcessRunnerConfig {
  envDenyPatterns: RegExp[];  // Default: see below
}

interface ProcessRunner {
  /**
   * Spawn the binary and wait for it to exit.
   * Forwards SIGTERM and SIGINT to the child.
   * Filters sensitive env vars before spawning.
   * The runner must not write to stdout or stderr after a successful spawn.
   * @param binaryPath - Absolute path to the verified binary
   * @param args - Arguments to pass to the binary (R14: extra CLI args)
   * @returns Exit code of the child process
   */
  exec(binaryPath: string, args: string[]): Promise<number>;
}
```

## Internal Design

### Environment Variable Filtering (S12, ADR-010)

Before spawning, filter `process.env` through a denylist:

```typescript
const DEFAULT_DENY_PATTERNS: RegExp[] = [
  /^AWS_/,
  /^GITHUB_TOKEN$/,
  /_SECRET$/,
  /_KEY$/,
  /_PASSWORD$/,
];

function filterEnv(
  env: NodeJS.ProcessEnv,
  denyPatterns: RegExp[],
  allowList: Set<string>
): NodeJS.ProcessEnv {
  const filtered: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (allowList.has(key) || !denyPatterns.some(p => p.test(key))) {
      filtered[key] = value;
    }
  }
  return filtered;
}
```

The `allowList` is populated from `MCP_BIN_ALLOW_ENV` (comma-separated exact var names). This lets users pass through specific vars like `AWS_REGION` that match denylist patterns but aren't secrets (ADR-010 amendment).

The filtered env is passed to `spawn()`. The runner's own env vars (`MCP_BIN_*`) are also stripped — the child doesn't need them.

### Spawn

```typescript
import { spawn } from "node:child_process";

const child = spawn(binaryPath, args, {
  stdio: "inherit",
  env: filteredEnv,
});
```

`stdio: "inherit"` passes stdin/stdout/stderr directly to the child. The MCP protocol traffic flows through stdout/stdin without the runner touching it.

### Signal Forwarding (R20)

After spawning, install signal handlers that forward to the child:

```typescript
const forwardSignal = (signal: NodeJS.Signals) => {
  child.kill(signal);
};

process.on("SIGTERM", () => forwardSignal("SIGTERM"));
process.on("SIGINT", () => forwardSignal("SIGINT"));
```

The runner does **not** exit on receiving these signals. It waits for the child to exit and uses the child's exit code.

### Exit Code Propagation (R10)

```typescript
const exitCode = await new Promise<number>((resolve) => {
  child.on("exit", (code, signal) => {
    if (code !== null) {
      resolve(code);
    } else if (signal) {
      // Child killed by signal — map to conventional exit code
      resolve(128 + (signalToNumber(signal) ?? 1));
    } else {
      resolve(1);
    }
  });
});
```

Signal-to-number mapping for common signals:
- SIGTERM → 15 (exit code 143)
- SIGINT → 2 (exit code 130)
- SIGKILL → 9 (exit code 137)

### No Output After Successful Spawn (R20)

Once the child process is **successfully spawned**, the runner must not write to stdout or stderr. All error handling within `exec()` after a successful spawn is silent — errors are communicated solely through the exit code. The CLI must complete all stderr output before calling `exec()`.

**Exception**: If `spawn()` itself fails (the `error` event fires before any child I/O), the child never existed and stdio was never yielded. In this case, writing a diagnostic to stderr is safe and necessary.

## Error Handling

The ProcessRunner does not throw errors. It always returns an exit code. If `spawn()` itself fails (e.g., binary not found, permission denied), the `error` event fires and the runner emits a diagnostic to stderr before returning exit code 1.

```typescript
child.on("error", (err) => {
  // spawn failed — binary not executable or not found
  // Safe to write stderr: child never started, stdio was never inherited
  process.stderr.write(`Failed to execute binary: ${binaryPath} (${err.code ?? err.message})\n`);
  resolve(1);
});
```

## Testing Notes

- Normal execution: child exits 0 → runner returns 0
- Child exits non-zero → runner returns same code
- SIGTERM forwarded: child receives SIGTERM, exits 143 → runner returns 143
- SIGINT forwarded: child receives SIGINT, exits 130 → runner returns 130
- Env filtering: `AWS_SECRET_ACCESS_KEY` not in child env
- Env filtering: `GITHUB_TOKEN` not in child env
- Env filtering: `MY_PASSWORD` not in child env
- Env filtering: `HOME`, `PATH`, `USER` preserved
- Env filtering: `MCP_BIN_MANIFEST_URL` stripped
- Extra args forwarded: `["--port", "3000"]` passed to child
- Spawn failure: returns exit code 1, emits diagnostic to stderr
