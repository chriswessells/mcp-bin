import { createReadStream, createWriteStream } from "node:fs";
import { chmod } from "node:fs/promises";
import path from "node:path";
import { createGunzip } from "node:zlib";
import { extract as tarExtract } from "tar-stream";
import { McpBinError, InvalidBinaryNameError, PathTraversalError } from "./errors.js";

export class ExtractionError extends McpBinError {
  constructor(binaryName: string) {
    super(`Binary '${binaryName}' not found in archive`, "EXTRACTION");
  }
}

function validateBinaryName(name: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new InvalidBinaryNameError(name);
  }
}

function validateEntryPath(entryName: string, destDir: string): void {
  if (entryName.split("/").includes("..")) {
    throw new PathTraversalError();
  }
  const resolved = path.resolve(destDir, entryName);
  const resolvedDest = path.resolve(destDir);
  if (!resolved.startsWith(resolvedDest + path.sep)) {
    throw new PathTraversalError();
  }
}

export async function extract(
  archivePath: string,
  binaryName: string,
  destDir: string
): Promise<string> {
  validateBinaryName(binaryName);

  const destPath = path.join(destDir, binaryName);
  let found = false;

  await new Promise<void>((resolve, reject) => {
    const extractor = tarExtract();

    extractor.on("entry", (header, stream, next) => {
      // Reject symlinks and hard links
      if (header.type === "symlink" || header.type === "link") {
        stream.resume();
        return reject(new PathTraversalError());
      }

      // Normalize: strip leading ./ or /
      const name = header.name.replace(/^\.\//, "").replace(/^\//, "");

      try {
        validateEntryPath(name, destDir);
      } catch (err) {
        stream.resume();
        return reject(err);
      }

      if (path.basename(name) === binaryName && header.type === "file") {
        found = true;
        const ws = createWriteStream(destPath);
        stream.pipe(ws);
        ws.on("finish", next);
        ws.on("error", reject);
      } else {
        stream.resume();
        next();
      }
    });

    extractor.on("finish", () => resolve());
    extractor.on("error", reject);

    const gunzip = createGunzip();
    gunzip.on("error", reject);

    createReadStream(archivePath).on("error", reject).pipe(gunzip).pipe(extractor);
  });

  if (!found) {
    throw new ExtractionError(binaryName);
  }

  await chmod(destPath, 0o755);
  return destPath;
}
