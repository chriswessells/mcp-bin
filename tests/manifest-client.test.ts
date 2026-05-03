import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ManifestClient } from "../src/manifest-client.ts";
import type { Manifest } from "../src/types.ts";

// Generate test Ed25519 keypair in DER SPKI format
const { publicKey: pubKeyObj, privateKey: privKeyObj } = generateKeyPairSync(
  "ed25519"
);
const publicKey = pubKeyObj.export({ type: "spki", format: "der" }) as Buffer;
const privateKey = privKeyObj;

function signManifest(data: Buffer): Buffer {
  return sign(null, data, privKeyObj);
}

const validManifest: Manifest = {
  schema_version: 1,
  servers: {
    "test-server": {
      "1.0.0": {
        "darwin-arm64": {
          url: "https://example.com/test.tar.gz",
          sha256: "abc123",
        },
      },
    },
  },
};

let tmpDir: string;
let cacheDir: string;
let manifestDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-bin-test-"));
  cacheDir = path.join(tmpDir, "cache");
  manifestDir = path.join(cacheDir, ".manifest");
});

afterEach(async () => {
  mock.restoreAll();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function writeCache(
  manifestBytes: Buffer,
  sigBytes: Buffer,
  fetchedAt?: string
) {
  await fs.mkdir(manifestDir, { recursive: true });
  await fs.writeFile(path.join(manifestDir, "manifest.json"), manifestBytes);
  await fs.writeFile(path.join(manifestDir, "manifest.json.sig"), sigBytes);
  await fs.writeFile(
    path.join(manifestDir, "manifest.json.meta"),
    JSON.stringify({ fetchedAt: fetchedAt ?? new Date().toISOString() })
  );
}

function mockFetch(
  manifestBytes: Buffer,
  sigBytes: Buffer,
  opts?: { failManifest?: boolean; failSig?: boolean }
) {
  mock.method(globalThis, "fetch", (url: string) => {
    if (opts?.failManifest && !url.endsWith(".sig")) {
      return Promise.reject(new Error("network error"));
    }
    if (opts?.failSig && url.endsWith(".sig")) {
      return Promise.reject(new Error("network error"));
    }
    const body = url.endsWith(".sig") ? sigBytes : manifestBytes;
    return Promise.resolve(
      new Response(body, { status: 200 })
    );
  });
}

describe("ManifestClient.fetch()", () => {
  it("fresh fetch with valid signature returns manifest", async () => {
    const manifestBytes = Buffer.from(JSON.stringify(validManifest));
    const sig = signManifest(manifestBytes);
    mockFetch(manifestBytes, sig);

    const client = new ManifestClient({ cacheDir, publicKey });
    const result = await client.fetch();
    assert.deepStrictEqual(result.manifest, validManifest);
  });

  it("cached manifest within TTL skips HTTP request", async () => {
    const manifestBytes = Buffer.from(JSON.stringify(validManifest));
    const sig = signManifest(manifestBytes);
    await writeCache(manifestBytes, sig);

    let fetchCalled = false;
    mock.method(globalThis, "fetch", () => {
      fetchCalled = true;
      return Promise.reject(new Error("should not be called"));
    });

    const client = new ManifestClient({ cacheDir, publicKey });
    const result = await client.fetch();
    assert.deepStrictEqual(result.manifest, validManifest);
    assert.strictEqual(fetchCalled, false);
  });

  it("fetch failure with valid cache returns cached + warning", async () => {
    const manifestBytes = Buffer.from(JSON.stringify(validManifest));
    const sig = signManifest(manifestBytes);
    // Write cache with old timestamp
    await writeCache(manifestBytes, sig, "2020-01-01T00:00:00.000Z");

    mockFetch(manifestBytes, sig, { failManifest: true });

    const client = new ManifestClient({ cacheDir, publicKey });
    const result = await client.fetch();
    assert.deepStrictEqual(result.manifest, validManifest);
    assert.ok(
      result.warnings.some((w) => w.includes("cached manifest"))
    );
  });

  it("fetch failure with no cache throws E6", async () => {
    mockFetch(Buffer.alloc(0), Buffer.alloc(0), { failManifest: true });

    const client = new ManifestClient({ cacheDir, publicKey });
    await assert.rejects(() => client.fetch(), (err: any) => {
      assert.strictEqual(err.code, "E6");
      return true;
    });
  });

  it("invalid signature throws E10", async () => {
    const manifestBytes = Buffer.from(JSON.stringify(validManifest));
    const badSig = Buffer.alloc(64); // wrong signature
    mockFetch(manifestBytes, badSig);

    const client = new ManifestClient({ cacheDir, publicKey });
    await assert.rejects(() => client.fetch(), (err: any) => {
      assert.strictEqual(err.code, "E10");
      return true;
    });
  });

  it("schema version 2 throws E13", async () => {
    const badManifest = { ...validManifest, schema_version: 2 };
    const manifestBytes = Buffer.from(JSON.stringify(badManifest));
    const sig = signManifest(manifestBytes);
    mockFetch(manifestBytes, sig);

    const client = new ManifestClient({ cacheDir, publicKey });
    await assert.rejects(() => client.fetch(), (err: any) => {
      assert.strictEqual(err.code, "E13");
      return true;
    });
  });
});

describe("ManifestClient.resolve()", () => {
  it("missing server throws E1", () => {
    const client = new ManifestClient({ cacheDir, publicKey });
    assert.throws(
      () => client.resolve(validManifest, "nope", "1.0.0", "darwin-arm64"),
      (err: any) => {
        assert.strictEqual(err.code, "E1");
        return true;
      }
    );
  });

  it("missing version throws E2", () => {
    const client = new ManifestClient({ cacheDir, publicKey });
    assert.throws(
      () =>
        client.resolve(validManifest, "test-server", "9.9.9", "darwin-arm64"),
      (err: any) => {
        assert.strictEqual(err.code, "E2");
        return true;
      }
    );
  });

  it("missing platform throws E3", () => {
    const client = new ManifestClient({ cacheDir, publicKey });
    assert.throws(
      () =>
        client.resolve(validManifest, "test-server", "1.0.0", "linux-x64"),
      (err: any) => {
        assert.strictEqual(err.code, "E3");
        return true;
      }
    );
  });
});
