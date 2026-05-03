# Component Design — Downloader

## Purpose

Downloads binary archives over HTTPS with retry, timeout, and SHA256 checksum verification.

## Requirements Covered

R5–R6, R18–R19, S1–S2, S11, E4–E5, E8–E9

## API Contract

```typescript
interface DownloaderConfig {
  connectTimeout: number;   // 5_000 ms
  responseTimeout: number;  // 30_000 ms
  downloadTimeout: number;  // 300_000 ms (5 min)
  maxRetries: number;       // 3
  retryDelays: number[];    // [1000, 2000, 4000]
}

interface Downloader {
  /**
   * Download a file from url to destPath, then verify its SHA256.
   * Retries transient failures (5xx, TCP reset, TLS timeout) with exponential backoff.
   * Does not retry 4xx errors.
   * @param url - HTTPS URL of the archive
   * @param expectedSha256 - Hex-encoded SHA256 of the archive
   * @param destPath - Where to write the downloaded file
   * @throws DownloadError (E4) — download failed (non-retryable or all retries exhausted)
   * @throws DownloadTimeoutError (E8) — download timed out
   * @throws ChecksumMismatchError (E5) — SHA256 mismatch after successful download
   * @throws RetriesExhaustedError (E9) — all retry attempts failed
   */
  download(url: string, expectedSha256: string, destPath: string): Promise<void>;
}
```

## Internal Design

### Download Flow

```
1. Validate URL scheme is https:// only (S1). Reject file://, http://, and all other schemes.
2. For attempt = 1 to maxRetries:
   a. Create HTTPS request with:
      - Connect timeout: 5s (socket timeout before connection established)
      - Response timeout: 30s (time to first byte after connection)
      - Overall timeout: 5 min (AbortController)
   b. On response:
      - If 4xx → throw E4 immediately (no retry)
      - If 5xx → mark as transient, continue to retry logic
      - If 2xx → pipe response to file at destPath
   c. On network error (ECONNRESET, ETIMEDOUT, TLS error) → mark as transient
   d. If transient and attempts remain → wait retryDelays[attempt-1], retry
   e. If transient and no attempts remain → throw E9
3. After successful download:
   a. Compute SHA256 of destPath
   b. Compare to expectedSha256
   c. Mismatch → delete destPath, throw E5
```

### Timeout Implementation

```typescript
// Per-request abort controller for overall timeout
const controller = new AbortController();
const overallTimer = setTimeout(() => controller.abort(), downloadTimeout);

// node:https request options
const options = {
  timeout: connectTimeout,  // socket connect timeout
  signal: controller.signal,
  headers: { "User-Agent": "mcp-bin-runner/1.0" }
};

// Response timeout: if no data received within responseTimeout after headers
// Use socket.setTimeout(responseTimeout) after 'response' event
```

Three timeout layers:
1. **Connect timeout** (5s): `options.timeout` — time to establish TCP connection
2. **Response timeout** (30s): `socket.setTimeout()` after connection — time to first byte
3. **Overall timeout** (5min): `AbortController` — total wall-clock time for the download

### Retry Logic

Transient errors (retryable):
- HTTP 5xx responses
- `ECONNRESET`, `ECONNREFUSED`, `ETIMEDOUT`
- TLS handshake errors (`ERR_TLS_*`)

Non-retryable:
- HTTP 4xx responses
- Checksum mismatch (download succeeded but data is wrong)
- Overall download timeout (5min) — if the download can't complete in 5 minutes, retrying won't help

Backoff delays: 1s, 2s, 4s base with ±25% jitter (e.g., `delay * (0.75 + Math.random() * 0.5)`). Jitter prevents thundering herd when multiple runner instances retry simultaneously.

### SHA256 Verification

```typescript
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

async function computeSha256(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(filePath);
  for await (const chunk of stream) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}
```

Streaming hash — never loads the full archive into memory.

### ENOSPC Handling

If the write stream emits an `ENOSPC` error during download, throw `DiskFullError` immediately (no retry). This gives the user a clear message rather than a generic download failure.

### URL Sanitization

All URLs in error messages are sanitized (S11): query parameters stripped before inclusion in error text. The `sanitizeUrl()` utility from `errors.ts` handles this.

## Error Types

```typescript
class DownloadError extends McpBinError {
  constructor(url: string) {
    super(`Failed to download: ${sanitizeUrl(url)}`, "E4");
  }
}

class DownloadTimeoutError extends McpBinError {
  constructor(seconds: number, url: string) {
    super(`Download timed out after ${seconds}s: ${sanitizeUrl(url)}`, "E8");
  }
}

class ChecksumMismatchError extends McpBinError {
  constructor(serverName: string, version: string) {
    super(`Checksum verification failed for '${serverName}' v${version}`, "E5");
  }
}

class RetriesExhaustedError extends McpBinError {
  constructor(attempts: number, url: string) {
    super(`Failed after ${attempts} retries: ${sanitizeUrl(url)}`, "E9");
  }
}
```

## Testing Notes

- Successful download: file written, checksum matches
- 4xx response: immediate failure, no retry
- 5xx response: retries 3 times with backoff, then E9
- Connect timeout: triggers retry
- Response timeout: triggers retry
- Overall timeout: E8
- Checksum mismatch: file deleted, E5
- Non-HTTPS URL: rejected before any network call
