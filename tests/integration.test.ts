import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir, readFile, stat } from "node:fs/promises";
import { createWriteStream, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import https from "node:https";
import { execFile } from "node:child_process";
import { createGzip } from "node:zlib";
import { pack } from "tar-stream";
import type { AddressInfo } from "node:net";

// --- Helpers ---

function createTarGzBuffer(
  entries: Array<{ name: string; data: string; type?: string }>
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = pack();
    const gzip = createGzip();
    const chunks: Buffer[] = [];
    gzip.on("data", (c: Buffer) => chunks.push(c));
    gzip.on("end", () => resolve(Buffer.concat(chunks)));
    gzip.on("error", reject);
    p.pipe(gzip);
    for (const e of entries) {
      p.entry({ name: e.name, type: (e.type as any) ?? "file" }, e.data);
    }
    p.finalize();
  });
}

function sha256(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function run(
  env: Record<string, string>,
  args: string[],
  timeout = 30_000
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      ["--import", "tsx", path.join(__dirname, "integration-harness.ts"), ...args],
      {
        env: { ...process.env, ...env, NODE_TLS_REJECT_UNAUTHORIZED: "0" },
        timeout,
        cwd: path.join(__dirname, ".."),
      },
      (err, stdout, stderr) => {
        resolve({
          code: err && "code" in err ? (err as any).code : child.exitCode ?? 0,
          stdout: stdout?.toString() ?? "",
          stderr: stderr?.toString() ?? "",
        });
      }
    );
  });
}

const __dirname = path.dirname(new URL(import.meta.url).pathname);

// --- Test Suite ---

describe("integration", () => {
  let tmpDir: string;
  let cacheDir: string;
  let server: https.Server;
  let port: number;
  let publicKeyB64: string;
  let archiveBuf: Buffer;
  let archiveSha: string;
  let manifestJson: string;
  let sigBuf: Buffer;
  let requestCount: number;
  let requestLog: string[];
  let slowMode: boolean;
  let badArchiveBuf: Buffer | null;

  before(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "mcp-int-"));
    cacheDir = path.join(tmpDir, "cache");
    await mkdir(cacheDir, { recursive: true });

    // Ed25519 keypair
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    const pubDer = publicKey.export({ type: "spki", format: "der" });
    publicKeyB64 = pubDer.toString("base64");

    // Test binary: shell script that echoes args
    const binaryContent = "#!/bin/sh\necho \"$@\"";

    // Package into tar.gz
    archiveBuf = await createTarGzBuffer([{ name: "test-server", data: binaryContent }]);
    archiveSha = sha256(archiveBuf);

    // Self-signed TLS cert
    const certKey = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const cert = (await import("node:tls")).createSecureContext; // just need the key
    // Use openssl-free approach: generate self-signed with crypto
    const tlsKey = certKey.privateKey.export({ type: "pkcs8", format: "pem" });
    const tlsCert = generateSelfSignedCert(certKey);

    // Build manifest
    const platform = `${os.platform()}-${os.arch()}` as string;
    requestCount = 0;
    requestLog = [];
    slowMode = false;
    badArchiveBuf = null;

    // Start HTTPS server
    server = https.createServer({ key: tlsKey, cert: tlsCert }, (req, res) => {
      requestCount++;
      requestLog.push(req.url ?? "");

      if (slowMode && req.url?.includes("archive")) {
        // Simulate timeout: never respond
        return;
      }

      if (req.url === "/manifest.json") {
        // Build manifest dynamically so tests can change archiveSha
        const m = buildManifest(platform);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(m);
      } else if (req.url === "/manifest.json.sig") {
        const m = buildManifest(platform);
        const sig = crypto.sign(null, Buffer.from(m), privateKey);
        res.writeHead(200);
        res.end(sig);
      } else if (req.url === "/archive.tar.gz") {
        const buf = badArchiveBuf ?? archiveBuf;
        res.writeHead(200, { "Content-Type": "application/octet-stream" });
        res.end(buf);
      } else {
        res.writeHead(404);
        res.end("not found");
      }
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;

    function buildManifest(plat: string): string {
      return JSON.stringify({
        schema_version: 1,
        servers: {
          "test-server": {
            "1.0.0": {
              [plat]: {
                url: `https://127.0.0.1:${port}/archive.tar.gz`,
                sha256: archiveSha,
              },
            },
          },
          "bad-checksum-server": {
            "1.0.0": {
              [plat]: {
                url: `https://127.0.0.1:${port}/archive.tar.gz`,
                sha256: "0000000000000000000000000000000000000000000000000000000000000000",
              },
            },
          },
          "no-platform-server": {
            "1.0.0": {
              "fake-platform": {
                url: `https://127.0.0.1:${port}/archive.tar.gz`,
                sha256: archiveSha,
              },
            },
          },
          "invalid-binary-server": {
            "1.0.0": {
              [plat]: {
                url: `https://127.0.0.1:${port}/archive.tar.gz`,
                sha256: archiveSha,
                binary_name: "../evil",
              },
            },
          },
          "traversal-server": {
            "1.0.0": {
              [plat]: {
                url: `https://127.0.0.1:${port}/archive.tar.gz`,
                sha256: archiveSha,
                binary_name: "traversal-bin",
              },
            },
          },
        },
      });
    }
  });

  after(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  function baseEnv(): Record<string, string> {
    return {
      MCP_BIN_MANIFEST_URL: `https://127.0.0.1:${port}/manifest.json`,
      MCP_BIN_CACHE_DIR: cacheDir,
      PUBLIC_KEY: publicKeyB64,
      MCP_BIN_DEBUG: "1",
    };
  }

  it("T2: full cycle — download, cache, execute", async () => {
    const { code, stdout } = await run(baseEnv(), ["test-server", "1.0.0", "hello", "world"]);
    assert.equal(code, 0);
    assert.match(stdout.trim(), /hello world/);
  });

  it("T3: cache hit — no HTTP requests on second run", async () => {
    // First run to populate cache
    await run(baseEnv(), ["test-server", "1.0.0", "warmup"]);
    // Reset counter
    requestCount = 0;
    requestLog = [];
    const { code, stdout } = await run(baseEnv(), ["test-server", "1.0.0", "cached"]);
    assert.equal(code, 0);
    assert.match(stdout.trim(), /cached/);
    // Only manifest requests (no archive download)
    const archiveReqs = requestLog.filter((u) => u.includes("archive"));
    assert.equal(archiveReqs.length, 0);
  });

  it("T4: checksum mismatch — E5 error", async () => {
    const dir = path.join(cacheDir, "bad-checksum-server");
    await rm(dir, { recursive: true, force: true });
    const { code, stderr } = await run(baseEnv(), ["bad-checksum-server", "1.0.0"]);
    assert.equal(code, 1);
    assert.match(stderr, /E5|[Cc]hecksum/);
  });

  it("T5: missing platform — E3 error", async () => {
    const { code, stderr } = await run(baseEnv(), ["no-platform-server", "1.0.0"]);
    assert.equal(code, 1);
    assert.match(stderr, /E3|[Pp]latform/);
  });

  it("T6: concurrent invocations — all succeed", async () => {
    // Fresh cache dir for this test
    const concCache = path.join(tmpDir, "cache-conc");
    await mkdir(concCache, { recursive: true });
    const env = { ...baseEnv(), MCP_BIN_CACHE_DIR: concCache };
    const results = await Promise.all([
      run(env, ["test-server", "1.0.0", "p1"]),
      run(env, ["test-server", "1.0.0", "p2"]),
      run(env, ["test-server", "1.0.0", "p3"]),
    ]);
    for (const r of results) {
      assert.equal(r.code, 0, `Failed with stderr: ${r.stderr}`);
      assert.match(r.stdout.trim(), /p[123]/);
    }
  });

  it("T7: download timeout — E8 error", async () => {
    slowMode = true;
    try {
      const timeoutCache = path.join(tmpDir, "cache-timeout");
      await mkdir(timeoutCache, { recursive: true });
      const env = {
        ...baseEnv(),
        MCP_BIN_CACHE_DIR: timeoutCache,
        MCP_BIN_DOWNLOAD_TIMEOUT: "1000",
        MCP_BIN_CONNECT_TIMEOUT: "500",
      };
      const { code, stderr } = await run(env, ["test-server", "1.0.0"], 15_000);
      assert.equal(code, 1);
      assert.match(stderr, /E8|[Tt]imed?\s*out/);
    } finally {
      slowMode = false;
    }
  });

  it("T8: path traversal archive — E12 error", async () => {
    // Serve an archive with path traversal entry
    const evilArchive = await createTarGzBuffer([{ name: "../../../etc/evil", data: "pwned" }]);
    const evilSha = sha256(evilArchive);
    // Temporarily swap archive
    const origBuf = archiveBuf;
    const origSha = archiveSha;
    archiveBuf = evilArchive;
    archiveSha = evilSha;

    try {
      const travCache = path.join(tmpDir, "cache-trav");
      await mkdir(travCache, { recursive: true });
      const { code, stderr } = await run(
        { ...baseEnv(), MCP_BIN_CACHE_DIR: travCache },
        ["traversal-server", "1.0.0"]
      );
      assert.equal(code, 1);
      assert.match(stderr, /E12|[Pp]ath traversal|unsafe/);
    } finally {
      archiveBuf = origBuf;
      archiveSha = origSha;
    }
  });

  it("T9: invalid binary_name — E11 error", async () => {
    const invCache = path.join(tmpDir, "cache-inv");
    await mkdir(invCache, { recursive: true });
    const { code, stderr } = await run(
      { ...baseEnv(), MCP_BIN_CACHE_DIR: invCache },
      ["invalid-binary-server", "1.0.0"]
    );
    assert.equal(code, 1);
    assert.match(stderr, /E11|[Ii]nvalid binary/);
  });

  it("T10: stale lock broken — succeeds after breaking lock", async () => {
    const lockCache = path.join(tmpDir, "cache-lock");
    const lockDir = path.join(lockCache, "test-server", "1.0.0");
    await mkdir(lockDir, { recursive: true });
    // Create a stale lock with a dead PID
    const lockPath = path.join(lockDir, ".lock");
    writeFileSync(lockPath, "99999999"); // PID that doesn't exist
    // Backdate the lock file mtime to make it stale
    const past = new Date(Date.now() - 4 * 60 * 1000); // 4 minutes ago
    const { utimes } = await import("node:fs/promises");
    await utimes(lockPath, past, past);

    const { code, stdout } = await run(
      { ...baseEnv(), MCP_BIN_CACHE_DIR: lockCache },
      ["test-server", "1.0.0", "after-lock"]
    );
    assert.equal(code, 0);
    assert.match(stdout.trim(), /after-lock/);
  });

  it("T11: corrupted cache triggers re-download", async () => {
    const corruptCache = path.join(tmpDir, "cache-corrupt");
    const binDir = path.join(corruptCache, "test-server", "1.0.0");
    await mkdir(binDir, { recursive: true });
    // Write a corrupted binary and mismatched sidecar
    await writeFile(path.join(binDir, "test-server"), "corrupted");
    await writeFile(path.join(binDir, "test-server.sha256"), "badhash");

    const { code, stdout } = await run(
      { ...baseEnv(), MCP_BIN_CACHE_DIR: corruptCache },
      ["test-server", "1.0.0", "re-downloaded"]
    );
    assert.equal(code, 0);
    assert.match(stdout.trim(), /re-downloaded/);
  });
});

// --- Self-signed cert generation without openssl CLI ---

function generateSelfSignedCert(keyPair: crypto.KeyPairKeyObjectResult): string {
  // Use a minimal approach: create cert via crypto.X509Certificate is not available for generation
  // Instead, use the legacy createSign approach to build a self-signed cert
  // For test purposes, we'll use a pre-built self-signed cert generation
  const { privateKey, publicKey } = keyPair;

  // Build a minimal self-signed X.509 cert in DER then PEM
  // This is a simplified ASN.1 construction for test purposes
  const pubDer = publicKey.export({ type: "spki", format: "der" });
  const privPem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;

  // Use node's built-in to create a self-signed cert
  // Actually, node doesn't have cert generation built-in without openssl
  // Use a raw ASN.1 approach for a minimal self-signed cert

  const cert = buildSelfSignedCert(pubDer, privateKey);
  return cert;
}

function buildSelfSignedCert(pubKeyDer: Buffer, privateKey: crypto.KeyObject): string {
  // Construct a minimal X.509 v3 self-signed certificate in DER format
  const now = new Date();
  const later = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);

  function encodeLength(len: number): Buffer {
    if (len < 128) return Buffer.from([len]);
    if (len < 256) return Buffer.from([0x81, len]);
    return Buffer.from([0x82, (len >> 8) & 0xff, len & 0xff]);
  }

  function seq(...parts: Buffer[]): Buffer {
    const body = Buffer.concat(parts);
    return Buffer.concat([Buffer.from([0x30]), encodeLength(body.length), body]);
  }

  function set(...parts: Buffer[]): Buffer {
    const body = Buffer.concat(parts);
    return Buffer.concat([Buffer.from([0x31]), encodeLength(body.length), body]);
  }

  function oid(bytes: number[]): Buffer {
    const body = Buffer.from(bytes);
    return Buffer.concat([Buffer.from([0x06]), encodeLength(body.length), body]);
  }

  function utf8str(s: string): Buffer {
    const body = Buffer.from(s, "utf8");
    return Buffer.concat([Buffer.from([0x0c]), encodeLength(body.length), body]);
  }

  function integer(n: number | Buffer): Buffer {
    if (typeof n === "number") {
      const buf = Buffer.alloc(1, n);
      return Buffer.concat([Buffer.from([0x02, 0x01]), buf]);
    }
    // Ensure leading zero if high bit set
    const padded = n[0] & 0x80 ? Buffer.concat([Buffer.from([0]), n]) : n;
    return Buffer.concat([Buffer.from([0x02]), encodeLength(padded.length), padded]);
  }

  function utcTime(d: Date): Buffer {
    const s = d.toISOString().replace(/[-:T]/g, "").slice(2, 14) + "Z";
    const body = Buffer.from(s, "ascii");
    return Buffer.concat([Buffer.from([0x17]), encodeLength(body.length), body]);
  }

  function bitString(data: Buffer): Buffer {
    const body = Buffer.concat([Buffer.from([0x00]), data]);
    return Buffer.concat([Buffer.from([0x03]), encodeLength(body.length), body]);
  }

  function explicit(tag: number, data: Buffer): Buffer {
    return Buffer.concat([Buffer.from([0xa0 | tag]), encodeLength(data.length), data]);
  }

  // SHA-256 with RSA OID
  const sha256WithRSA = seq(
    oid([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b]),
    Buffer.from([0x05, 0x00]) // NULL
  );

  // Issuer/Subject: CN=localhost
  const cn = seq(oid([0x55, 0x04, 0x03]), utf8str("localhost"));
  const name = seq(set(cn));

  // Validity
  const validity = seq(utcTime(now), utcTime(later));

  // Serial number
  const serial = integer(Buffer.from([0x01]));

  // Version v3
  const version = explicit(0, integer(2));

  // TBS Certificate
  const tbs = seq(
    version,
    serial,
    sha256WithRSA,
    name, // issuer
    validity,
    name, // subject
    pubKeyDer, // subjectPublicKeyInfo (already DER-encoded SPKI)
  );

  // Sign TBS
  const sig = crypto.sign("sha256", tbs, privateKey);

  // Full certificate
  const cert = seq(tbs, sha256WithRSA, bitString(sig));

  // PEM encode
  const b64 = cert.toString("base64");
  const lines = b64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----\n`;
}
