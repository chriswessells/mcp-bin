import https from "node:https";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { unlink, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { pipeline } from "node:stream/promises";
import type { IncomingMessage } from "node:http";
import {
  DownloadError,
  DownloadTimeoutError,
  ChecksumError,
  RetriesExhaustedError,
  DiskFullError,
  sanitizeUrl,
} from "./errors.js";

export interface DownloaderConfig {
  connectTimeout: number;
  responseTimeout: number;
  downloadTimeout: number;
  maxRetries: number;
  retryDelays: number[];
}

export const DEFAULT_CONFIG: DownloaderConfig = {
  connectTimeout: 5_000,
  responseTimeout: 30_000,
  downloadTimeout: 300_000,
  maxRetries: 3,
  retryDelays: [1000, 2000, 4000],
};

/** @internal — test injection point */
export type RequestFn = typeof https.get;

function isTransient(err: unknown): boolean {
  if (err instanceof DownloadError) return false;
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "ECONNRESET" || code === "ECONNREFUSED" || code === "ETIMEDOUT") return true;
  if (typeof code === "string" && code.startsWith("ERR_TLS")) return true;
  if (err instanceof Error && "statusCode" in err) {
    const sc = (err as any).statusCode;
    if (typeof sc === "number" && sc >= 500) return true;
  }
  return false;
}

function jitteredDelay(base: number): number {
  return Math.round(base * (0.75 + Math.random() * 0.5));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

class HttpError extends Error {
  statusCode: number;
  constructor(statusCode: number, url: string) {
    super(`HTTP ${statusCode}: ${sanitizeUrl(url)}`);
    this.statusCode = statusCode;
  }
}

function fetchToFile(
  url: string,
  destPath: string,
  config: DownloaderConfig,
  signal: AbortSignal,
  requestFn: RequestFn,
  redirectsLeft: number = 5,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = requestFn(url, { timeout: config.connectTimeout, signal } as any, (res: IncomingMessage) => {
      const status = res.statusCode ?? 0;

      // Follow redirects (301, 302, 307, 308) — HTTPS only
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) return reject(new DownloadError(url));
        const target = new URL(res.headers.location, url).toString();
        if (!target.startsWith("https://")) return reject(new DownloadError(url));
        return fetchToFile(target, destPath, config, signal, requestFn, redirectsLeft - 1).then(resolve, reject);
      }

      if (status >= 400 && status < 500) {
        res.resume();
        return reject(new DownloadError(url));
      }
      if (status >= 500) {
        res.resume();
        return reject(new HttpError(status, url));
      }
      if (status < 200 || status >= 300) {
        res.resume();
        return reject(new DownloadError(url));
      }

      if (res.socket) {
        res.socket.setTimeout(config.responseTimeout, () => {
          req.destroy(new Error("Response timeout"));
        });
      }

      const ws = createWriteStream(destPath);
      ws.on("error", (err: NodeJS.ErrnoException) => {
        req.destroy();
        if (err.code === "ENOSPC") return reject(new DiskFullError(dirname(destPath)));
        reject(err);
      });
      pipeline(res, ws).then(resolve, reject);
    });

    req.on("error", (err: Error) => {
      if (signal.aborted) return reject(new DownloadTimeoutError(config.downloadTimeout / 1000, url));
      reject(err);
    });

    req.on("timeout", () => {
      req.destroy(Object.assign(new Error("Connect timeout"), { code: "ETIMEDOUT" }));
    });
  });
}

async function computeSha256(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

export async function download(
  url: string,
  expectedSha256: string,
  destPath: string,
  config: DownloaderConfig = DEFAULT_CONFIG,
  /** @internal */ _requestFn: RequestFn = https.get,
  context?: { serverName: string; version: string },
): Promise<void> {
  const parsed = (() => { try { return new URL(url); } catch { return null; } })();
  if (!parsed || parsed.protocol !== "https:") {
    throw new DownloadError(url);
  }

  await mkdir(dirname(destPath), { recursive: true });

  const controller = new AbortController();
  const overallTimer = setTimeout(() => controller.abort(), config.downloadTimeout);

  let lastError: unknown;
  try {
    for (let attempt = 0; attempt < config.maxRetries; attempt++) {
      try {
        await fetchToFile(url, destPath, config, controller.signal, _requestFn);
        const actual = await computeSha256(destPath);
        if (actual !== expectedSha256) {
          await unlink(destPath).catch(() => {});
          throw new ChecksumError(context?.serverName ?? sanitizeUrl(url), context?.version ?? "");
        }
        return;
      } catch (err) {
        lastError = err;
        if (err instanceof DownloadError || err instanceof ChecksumError || err instanceof DiskFullError) throw err;
        if (err instanceof DownloadTimeoutError) throw err;
        if (controller.signal.aborted) throw new DownloadTimeoutError(config.downloadTimeout / 1000, url);
        if (!isTransient(err)) throw new DownloadError(url);
        // Clean up partial file before retry
        await unlink(destPath).catch(() => {});
        if (attempt < config.maxRetries - 1) {
          await sleep(jitteredDelay(config.retryDelays[attempt]));
        }
      }
    }
    await unlink(destPath).catch(() => {});
    throw new RetriesExhaustedError(config.maxRetries, url);
  } finally {
    clearTimeout(overallTimer);
  }
}
