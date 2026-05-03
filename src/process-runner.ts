import { spawn } from "node:child_process";

const DEFAULT_DENY_PATTERNS: RegExp[] = [
  /^AWS_/,
  /^GITHUB_TOKEN$/,
  /_SECRET$/,
  /_KEY$/,
  /_PASSWORD$/,
  /^MCP_BIN_/,
];

const SIGNAL_MAP: Partial<Record<NodeJS.Signals, number>> = {
  SIGTERM: 15,
  SIGINT: 2,
  SIGKILL: 9,
};

function filterEnv(
  env: NodeJS.ProcessEnv,
  denyPatterns: RegExp[],
  allowList: Set<string>
): NodeJS.ProcessEnv {
  const filtered: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (allowList.has(key) || !denyPatterns.some((p) => p.test(key))) {
      filtered[key] = value;
    }
  }
  return filtered;
}

function parseAllowList(env: NodeJS.ProcessEnv): Set<string> {
  const raw = env["MCP_BIN_ALLOW_ENV"];
  if (!raw) return new Set();
  return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
}

export interface ProcessRunnerConfig {
  envDenyPatterns?: RegExp[];
}

export interface ProcessRunner {
  exec(binaryPath: string, args: string[]): Promise<number>;
}

export function createProcessRunner(
  config: ProcessRunnerConfig = {}
): ProcessRunner {
  const denyPatterns = config.envDenyPatterns ?? DEFAULT_DENY_PATTERNS;

  return {
    exec(binaryPath: string, args: string[]): Promise<number> {
      const allowList = parseAllowList(process.env);
      const filteredEnv = filterEnv(process.env, denyPatterns, allowList);
      const child = spawn(binaryPath, args, { stdio: "inherit", env: filteredEnv });

      const onSigterm = () => { try { child.kill("SIGTERM"); } catch {} };
      const onSigint = () => { try { child.kill("SIGINT"); } catch {} };
      process.on("SIGTERM", onSigterm);
      process.on("SIGINT", onSigint);

      return new Promise<number>((resolve) => {
        child.on("error", (err: NodeJS.ErrnoException) => {
          process.removeListener("SIGTERM", onSigterm);
          process.removeListener("SIGINT", onSigint);
          process.stderr.write(
            `Failed to execute binary: ${binaryPath} (${err.code ?? err.message})\n`
          );
          resolve(1);
        });

        child.on("exit", (code, signal) => {
          process.removeListener("SIGTERM", onSigterm);
          process.removeListener("SIGINT", onSigint);
          if (code !== null) {
            resolve(code);
          } else if (signal) {
            resolve(128 + (SIGNAL_MAP[signal] ?? 1));
          } else {
            resolve(1);
          }
        });
      });
    },
  };
}
