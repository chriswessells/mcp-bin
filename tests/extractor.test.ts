import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, stat, mkdir } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createGzip } from "node:zlib";
import { pack } from "tar-stream";
import { pipeline } from "node:stream/promises";
import { extract, ExtractionError } from "../src/extractor.ts";
import { InvalidBinaryNameError, PathTraversalError } from "../src/errors.ts";

function createTarGz(
  dest: string,
  entries: Array<{ name: string; type?: string; data?: string; linkname?: string }>
): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = pack();
    const gzip = createGzip();
    const ws = createWriteStream(dest);
    p.pipe(gzip).pipe(ws);
    ws.on("finish", resolve);
    ws.on("error", reject);

    for (const e of entries) {
      if (e.type === "symlink") {
        p.entry({ name: e.name, type: "symlink", linkname: e.linkname ?? "" });
      } else {
        p.entry({ name: e.name, type: "file" }, e.data ?? "");
      }
    }
    p.finalize();
  });
}

describe("extractor", () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "extractor-test-"));
  });

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("extracts matching binary and sets chmod 755", async () => {
    const archive = path.join(tmpDir, "valid.tar.gz");
    const destDir = path.join(tmpDir, "out1");
    await mkdir(destDir, { recursive: true });
    await createTarGz(archive, [
      { name: "other-file", data: "skip" },
      { name: "my-bin", data: "#!/bin/sh\necho hello" },
    ]);

    const result = await extract(archive, "my-bin", destDir);
    assert.equal(result, path.join(destDir, "my-bin"));
    const content = await readFile(result, "utf8");
    assert.equal(content, "#!/bin/sh\necho hello");
    const s = await stat(result);
    assert.equal(s.mode & 0o755, 0o755);
  });

  it("extracts binary nested in subdirectory", async () => {
    const archive = path.join(tmpDir, "nested.tar.gz");
    const destDir = path.join(tmpDir, "out-nested");
    await mkdir(destDir, { recursive: true });
    await createTarGz(archive, [
      { name: "subdir/my-bin", data: "binary-content" },
    ]);

    const result = await extract(archive, "my-bin", destDir);
    assert.equal(result, path.join(destDir, "my-bin"));
  });

  it("rejects invalid binary name with E11", async () => {
    await assert.rejects(
      () => extract("/dev/null", "../evil", "/tmp"),
      (err: any) => err instanceof InvalidBinaryNameError && err.code === "E11"
    );
  });

  it("rejects binary name with slash", async () => {
    await assert.rejects(
      () => extract("/dev/null", "foo/bar", "/tmp"),
      InvalidBinaryNameError
    );
  });

  it("throws ExtractionError when binary not in archive", async () => {
    const archive = path.join(tmpDir, "missing.tar.gz");
    const destDir = path.join(tmpDir, "out2");
    await mkdir(destDir, { recursive: true });
    await createTarGz(archive, [{ name: "other", data: "data" }]);

    await assert.rejects(
      () => extract(archive, "my-bin", destDir),
      (err: any) => err instanceof ExtractionError && err.code === "EXTRACTION"
    );
  });

  it("rejects archive with path traversal (..)", async () => {
    const archive = path.join(tmpDir, "traversal.tar.gz");
    const destDir = path.join(tmpDir, "out3");
    await mkdir(destDir, { recursive: true });
    await createTarGz(archive, [{ name: "../evil", data: "pwned" }]);

    await assert.rejects(
      () => extract(archive, "evil", destDir),
      PathTraversalError
    );
  });

  it("rejects archive with symlink entry", async () => {
    const archive = path.join(tmpDir, "symlink.tar.gz");
    const destDir = path.join(tmpDir, "out4");
    await mkdir(destDir, { recursive: true });
    await createTarGz(archive, [
      { name: "evil-link", type: "symlink", linkname: "/etc/passwd" },
    ]);

    await assert.rejects(
      () => extract(archive, "evil-link", destDir),
      PathTraversalError
    );
  });
});
