import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HELPER = path.join(__dirname, "fixtures", "run-helper.ts");
const FIXTURE = path.join(__dirname, "fixtures", "echo-env.sh");

function spawn(
  fixtureArgs: string[],
  extraEnv?: Record<string, string>
): { stdout: string; stderr: string; status: number } {
  const env = { ...process.env, ...extraEnv };
  try {
    const stdout = execFileSync(
      "npx",
      ["tsx", HELPER, FIXTURE, ...fixtureArgs],
      { encoding: "utf-8", env, timeout: 10000, stdio: ["pipe", "pipe", "pipe"] }
    );
    return { stdout, stderr: "", status: 0 };
  } catch (e: any) {
    return {
      stdout: (e.stdout as string) ?? "",
      stderr: (e.stderr as string) ?? "",
      status: (e.status as number) ?? 1,
    };
  }
}

function spawnBinary(
  binary: string,
  args: string[],
  extraEnv?: Record<string, string>
): { stdout: string; stderr: string; status: number } {
  const env = { ...process.env, ...extraEnv };
  try {
    const stdout = execFileSync(
      "npx",
      ["tsx", HELPER, binary, ...args],
      { encoding: "utf-8", env, timeout: 10000, stdio: ["pipe", "pipe", "pipe"] }
    );
    return { stdout, stderr: "", status: 0 };
  } catch (e: any) {
    return {
      stdout: (e.stdout as string) ?? "",
      stderr: (e.stderr as string) ?? "",
      status: (e.status as number) ?? 1,
    };
  }
}

describe("ProcessRunner", () => {
  it("propagates exit code 0", () => {
    const r = spawn(["--exit", "0", "HOME"]);
    assert.equal(r.status, 0);
  });

  it("propagates non-zero exit code", () => {
    const r = spawn(["--exit", "42", "HOME"]);
    assert.equal(r.status, 42);
  });

  it("filters AWS_SECRET_ACCESS_KEY", () => {
    const r = spawn(["AWS_SECRET_ACCESS_KEY"], {
      AWS_SECRET_ACCESS_KEY: "supersecret",
    });
    assert.match(r.stdout, /AWS_SECRET_ACCESS_KEY=<unset>/);
  });

  it("filters GITHUB_TOKEN", () => {
    const r = spawn(["GITHUB_TOKEN"], { GITHUB_TOKEN: "ghp_xxx" });
    assert.match(r.stdout, /GITHUB_TOKEN=<unset>/);
  });

  it("filters MCP_BIN_MANIFEST_URL", () => {
    const r = spawn(["MCP_BIN_MANIFEST_URL"], {
      MCP_BIN_MANIFEST_URL: "https://example.com",
    });
    assert.match(r.stdout, /MCP_BIN_MANIFEST_URL=<unset>/);
  });

  it("preserves HOME and PATH", () => {
    const r = spawn(["HOME", "PATH"]);
    assert.match(r.stdout, /HOME=\//);
    assert.match(r.stdout, /PATH=\//);
  });

  it("forwards extra args to child", () => {
    const r = spawn(["--args", "--port", "3000"]);
    assert.match(r.stdout, /ARG:--port/);
    assert.match(r.stdout, /ARG:3000/);
  });

  it("returns exit code 1 on spawn failure", () => {
    const r = spawnBinary("/nonexistent/binary", []);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Failed to execute binary/);
  });
});
