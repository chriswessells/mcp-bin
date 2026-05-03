import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";

const TEST_DIR = join(tmpdir(), `mcp-bin-test-${Date.now()}`);
const TEST_CONTENT = "hello world binary content";
const TEST_SHA256 = createHash("sha256").update(TEST_CONTENT).digest("hex");
const BAD_SHA256 = "0".repeat(64);

const { download } = await import("../src/downloader.ts");
const { DownloadError, RetriesExhaustedError, ChecksumError } = await import("../src/errors.ts");

const fastConfig = {
  connectTimeout: 500,
  responseTimeout: 500,
  downloadTimeout: 5000,
  maxRetries: 3,
  retryDelays: [10, 20, 40],
};

type Handler = (url: string, attempt: number) => {
  statusCode?: number;
  body?: string;
  error?: Error;
};

function fakeGet(handler: Handler) {
  let attempt = 0;
  return function mockGet(_url: any, _opts: any, cb: any) {
    if (typeof _opts === "function") { cb = _opts; }
    attempt++;
    const result = handler(typeof _url === "string" ? _url : _url.toString(), attempt);

    const req = new EventEmitter() as any;
    req.destroy = (err?: Error) => { if (err) setImmediate(() => req.emit("error", err)); };
    req.end = () => {};

    if (result.error) {
      setImmediate(() => req.emit("error", result.error));
      return req;
    }

    setImmediate(() => {
      const body = result.body ?? "";
      const res = new Readable({ read() { this.push(body); this.push(null); } });
      Object.assign(res, {
        statusCode: result.statusCode ?? 200,
        headers: {},
        socket: { setTimeout: () => {}, remoteAddress: "127.0.0.1" },
      });
      cb(res);
    });

    return req;
  };
}

describe("downloader", () => {
  const destPath = () => join(TEST_DIR, "archive.tar.gz");

  beforeEach(() => mkdirSync(TEST_DIR, { recursive: true }));
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  it("successful download with correct checksum", async () => {
    const get = fakeGet(() => ({ statusCode: 200, body: TEST_CONTENT }));
    await download("https://example.com/file.tar.gz", TEST_SHA256, destPath(), fastConfig, get);
    assert.ok(existsSync(destPath()));
    assert.equal(readFileSync(destPath(), "utf8"), TEST_CONTENT);
  });

  it("4xx → immediate failure, no retry", async () => {
    let attempts = 0;
    const get = fakeGet(() => { attempts++; return { statusCode: 404 }; });
    await assert.rejects(
      () => download("https://example.com/file.tar.gz", TEST_SHA256, destPath(), fastConfig, get),
      (err: any) => err instanceof DownloadError && err.code === "E4",
    );
    assert.equal(attempts, 1);
  });

  it("5xx → 3 retries then E9", async () => {
    let attempts = 0;
    const get = fakeGet(() => { attempts++; return { statusCode: 503 }; });
    await assert.rejects(
      () => download("https://example.com/file.tar.gz", TEST_SHA256, destPath(), fastConfig, get),
      (err: any) => err instanceof RetriesExhaustedError && err.code === "E9",
    );
    assert.equal(attempts, 3);
  });

  it("connect timeout → retry then succeed", async () => {
    let attempts = 0;
    const get = fakeGet((_url, attempt) => {
      attempts++;
      if (attempt < 3) return { error: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }) };
      return { statusCode: 200, body: TEST_CONTENT };
    });
    await download("https://example.com/file.tar.gz", TEST_SHA256, destPath(), fastConfig, get);
    assert.equal(attempts, 3);
    assert.ok(existsSync(destPath()));
  });

  it("checksum mismatch → file deleted, E5", async () => {
    const get = fakeGet(() => ({ statusCode: 200, body: TEST_CONTENT }));
    await assert.rejects(
      () => download("https://example.com/file.tar.gz", BAD_SHA256, destPath(), fastConfig, get),
      (err: any) => err instanceof ChecksumError && err.code === "E5",
    );
    assert.ok(!existsSync(destPath()), "file should be deleted on checksum mismatch");
  });

  it("non-HTTPS URL → rejected", async () => {
    await assert.rejects(
      () => download("http://example.com/file.tar.gz", TEST_SHA256, destPath(), fastConfig),
      (err: any) => err instanceof DownloadError && err.code === "E4",
    );
    await assert.rejects(
      () => download("file:///etc/passwd", TEST_SHA256, destPath(), fastConfig),
      (err: any) => err instanceof DownloadError && err.code === "E4",
    );
  });
});
